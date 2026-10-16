-- =====================================================================
-- RETEST for membership_window_DRAFT.sql. READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- RAN 2026-10-16 on live: 50 passed, 0 failed, 8 skipped. V5 (Project Admin refused) skipped in EVERY department — no
-- non-DA Project Admin exists live, so the PA exclusion is proven only by the PGlite mutation run, not on live.
-- Once: anon can't execute the RPCs; nobody but the owner can call the window helper; no view exposes terminated_on;
-- authenticated can't read member_separation directly.
-- For each department, with fixtures on one real drill S and one non-admin member T who has no attendance at S:
--   W1  join date = S+1          -> attendance refused (MEMBERSHIP_WINDOW), even inserted as the table OWNER
--   W2  join date = S            -> allowed (the window includes the join day)
--   W3  DA sets termination S-1  -> attendance refused; DA's set reports the existing row it leaves (attendance_after)
--       and does NOT delete it
--   W4  termination = S          -> allowed (the end day is included)
--   W5  moving drill S one day later (past T's termination) -> refused
--   W6  an OFFICER inserting via RLS with termination S-1 -> refused by the window (not by RLS)
--   W7  an OFFICER inserting via RLS inside the window -> still allowed (no grant needed on the trigger function)
--   V1  the DA reads the termination date
--   V2  an officer can neither read nor set it          V3  the member themself can't read it
--   V4  a Department Admin of ANOTHER department can't   V5  a Project Admin of this department can't (brief: DA only)
--   V6  authenticated can't SELECT member_separation or EXECUTE membership_window_allows
-- Every write is inside a sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in a RAISE that is
-- the report + final rollback. NOTHING CHANGES. The "ERROR" IS the report.
-- DRY RUN 2026-10-16 — NOT the live DB (PGlite mock, 2 departments, Supabase-style default grants on new tables AND
-- functions): migration OK + idempotent; this RETEST 26 passed / 0 failed / 3 skipped (mock dept B has no officer/PA);
-- year fallback (joined '2026', no joined_date) refuses a 2025 drill. Mutations: helper left executable / table
-- readable / another policy changed / a view exposing terminated_on -> migration rolls back; end day excluded ->
-- W4+W5+W7 FAIL; gate admits Project Admin -> V5 FAIL; drill-move trigger disabled -> W5 FAIL.
-- =====================================================================
DO $retest$
DECLARE
  rec record;
  v_err text; v_res jsonb; v_d date; v_n int;
  v_s uuid; v_sd date; v_t uuid; v_t_email text;
  v_da text; v_off text; v_pa text; v_other_da text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- ---------- once ----------
  IF NOT has_function_privilege('anon', 'public.get_member_termination(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_member_termination(uuid,date)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.membership_window_allows(uuid,date)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.member_separation', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.member_separation', 'SELECT') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  privileges: anon no RPCs; nobody reads the table or calls the helper%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  privileges too open%s', chr(10)); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns c JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
                  WHERE c.table_schema = 'public' AND c.column_name = 'terminated_on') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  no view (celebrations, members_view, …) exposes terminated_on%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  a view exposes terminated_on%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    v_s := NULL; v_sd := NULL; v_t := NULL; v_t_email := NULL; v_da := NULL; v_off := NULL; v_pa := NULL; v_other_da := NULL;
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    -- people (unique emails only, so the JWT resolves to exactly them)
    SELECT lower(m.email) INTO v_da FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[] AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_pa FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.access && array['Project Admin']::text[] AND NOT m.access && array['Department Admin']::text[]
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_da FROM public.members m
     WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    -- one drill S, and a non-admin member T with no attendance at S
    SELECT ts.id, ts."date" INTO v_s, v_sd FROM public.training_sessions ts
     WHERE ts.department_id = rec.dept_id AND ts."date" IS NOT NULL ORDER BY ts."date" DESC, ts.id LIMIT 1;
    IF v_s IS NOT NULL THEN
      SELECT m.id, lower(m.email) INTO v_t, v_t_email FROM public.members m
       WHERE m.department_id = rec.dept_id AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer']::text[], false)
         AND NOT EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = v_s AND sa.member_id = m.id)
       ORDER BY (m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1) DESC, m.id LIMIT 1;
    END IF;
    IF v_da IS NULL OR v_s IS NULL OR v_t IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — DA %s, drill %s, test member %s%s',
        coalesce(v_da, 'none'), coalesce(v_s::text, 'none'), coalesce(v_t::text, 'none'), chr(10));
      CONTINUE;
    END IF;

    BEGIN
      -- fixtures, as the owner: a clean slate for T
      DELETE FROM public.member_separation WHERE member_id = v_t;
      INSERT INTO public.member_private (member_id, department_id, joined_date) VALUES (v_t, rec.dept_id, v_sd + 1)
        ON CONFLICT (member_id) DO UPDATE SET joined_date = excluded.joined_date;
      -- W1 pre-join refused, even for the owner
      BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_t, now()); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'MEMBERSHIP_WINDOW:%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W1 drill before the join date refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W1 -> "%s"%s', v_err, chr(10)); END IF;
      -- W2 join day allowed
      UPDATE public.member_private SET joined_date = v_sd WHERE member_id = v_t;
      BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_t, now()); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err = 'OK' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W2 drill on the join date allowed%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W2 -> "%s"%s', v_err, chr(10)); END IF;
      -- W3 the DA sets termination S-1: reports the row it leaves, doesn't delete it; a new insert is refused
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN v_res := public.set_member_termination(v_t, v_sd - 1); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM public.session_attendance WHERE session_id = v_s AND member_id = v_t;
      IF v_err = 'OK' AND (v_res->>'attendance_after')::int >= 1 AND v_n = 1 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W3a DA set it; reports %s row(s) after, deleted none%s', v_res->>'attendance_after', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W3a -> "%s" %s, row still there: %s%s', v_err, v_res, v_n, chr(10)); END IF;
      DELETE FROM public.session_attendance WHERE session_id = v_s AND member_id = v_t;
      BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_t, now()); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'MEMBERSHIP_WINDOW:%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W3b drill after the termination date refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W3b -> "%s"%s', v_err, chr(10)); END IF;
      -- W6 the same refusal on the officer's own path (RLS insert)
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  W6 — no officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_t, now()); v_err := 'OK';
        EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err LIKE 'MEMBERSHIP_WINDOW:%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W6 officer roster insert after termination refused%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W6 -> "%s"%s', v_err, chr(10)); END IF;
      END IF;
      -- V1 the DA reads it
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN v_d := public.get_member_termination(v_t); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err = 'OK' AND v_d = v_sd - 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  V1 DA reads the termination date%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V1 -> "%s" %s%s', v_err, v_d, chr(10)); END IF;
      -- W4 termination = S -> allowed (end day included)
      BEGIN v_res := public.set_member_termination(v_t, v_sd); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_t, now()); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err = 'OK' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W4 drill on the termination date allowed%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W4 -> "%s"%s', v_err, chr(10)); END IF;
      -- W7 inside the window the OFFICER's own roster insert still works (the trigger function needs no grant)
      IF v_off IS NOT NULL THEN
        DELETE FROM public.session_attendance WHERE session_id = v_s AND member_id = v_t;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_t, now()); v_err := 'OK';
        EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W7 officer roster insert inside the window still works%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W7 -> "%s"%s', v_err, chr(10)); END IF;
        IF NOT EXISTS (SELECT 1 FROM public.session_attendance WHERE session_id = v_s AND member_id = v_t) THEN
          INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_t, now());
        END IF;
      END IF;
      -- W5 moving the drill a day later is refused (T is recorded there and was gone by then)
      BEGIN UPDATE public.training_sessions SET "date" = v_sd + 1 WHERE id = v_s; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'MEMBERSHIP_WINDOW:%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W5 moving the drill past an attendee''s termination refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W5 -> "%s"%s', v_err, chr(10)); END IF;
      -- V2 officer: can't read, can't set
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  V2 — no officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN v_d := public.get_member_termination(v_t); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        BEGIN PERFORM public.set_member_termination(v_t, NULL); v_res := '{"set":"OK"}'; EXCEPTION WHEN OTHERS THEN v_res := jsonb_build_object('set', SQLERRM); END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'Only a Department Admin can see this.' AND v_res->>'set' = 'Only a Department Admin can change this.' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  V2 officer can''t read or set it%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V2 read "%s", set %s%s', v_err, v_res, chr(10)); END IF;
      END IF;
      -- V3 the member themself
      IF v_t_email IS NULL OR (SELECT count(*) FROM public.members x WHERE lower(x.email) = v_t_email) <> 1 THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  V3 — test member has no unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_t_email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN v_d := public.get_member_termination(v_t); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'Only a Department Admin can see this.' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  V3 the member can''t read their own%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V3 -> "%s" %s%s', v_err, v_d, chr(10)); END IF;
      END IF;
      -- V4 another department's DA
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  V4 — no other-department DA%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN v_d := public.get_member_termination(v_t); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'Only a Department Admin can see this.' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  V4 another department''s DA refused%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V4 -> "%s" %s%s', v_err, v_d, chr(10)); END IF;
      END IF;
      -- V5 a Project Admin of this department
      IF v_pa IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  V5 — no Project Admin (without DA) here%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN v_d := public.get_member_termination(v_t); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'Only a Department Admin can see this.' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  V5 Project Admin refused (DA only)%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V5 -> "%s" %s%s', v_err, v_d, chr(10)); END IF;
      END IF;
      -- V6 no direct door, as the DA
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN SELECT count(*) INTO v_n FROM public.member_separation; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN PERFORM public.membership_window_allows(v_t, v_sd); v_res := '{"x":"OK"}'; EXCEPTION WHEN OTHERS THEN v_res := jsonb_build_object('x', SQLERRM); END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err ILIKE '%permission denied%' AND v_res->>'x' ILIKE '%permission denied%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  V6 even the DA can''t read the table or call the helper directly%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V6 table "%s", helper %s%s', v_err, v_res, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
