-- =====================================================================
-- RETEST for station_fundraiser_DRAFT.sql. READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Builds its OWN fixtures inside the run (a test fundraiser + four tagged planning steps per department) so it never
-- depends on real data, then signs in exactly as the app does (JWT email claim + role authenticated) and checks:
--   A. a leader shares the fundraiser and ticks a step                     -> both writes succeed
--   B. a member reads the station card                                     -> counts mirror the leader view
--        (done 1 of 3: open+ticked, done+ticked, open+UNticked counted; cancelled not counted) and Up next =
--        ONLY the ticked OPEN step — the done step and the un-ticked step's text never appear
--   C. a NOT-shared fundraiser                                              -> not returned
--   D. another department's member                                          -> sees none of it
--   E. another department's leader                                         -> can't share or tick it ('Not in…')
--   F. a non-leader member                                                  -> can't share ('Only leaders…') or tick
--   G. lifecycle: marked done / archived / date passed / no date            -> drops off
--   H. a step that isn't tagged to a fundraiser                             -> can't be ticked
--   I. members still can't read fundraisers directly (RLS unchanged)       -> 0 rows
-- Once: anon can't run any of the three functions; the read's result type has no money/donor/owner column.
-- INFO: how many emails have member rows in MORE THAN ONE department — the people the role-anywhere
--   fundraisers_leadership policy (flagged in the migration) could mis-scope.
-- Every write is inside a sub-block ending in RAISE 'SENTINEL' (rolled back — fixtures included); the whole block
-- ends in a RAISE that is the report + final rollback. NOTHING CHANGES. The "ERROR" IS the report.
-- DRY RUN 2026-10-15 — NOT the live DB (PGlite mock: 2 departments; fundraisers with the real role-anywhere
-- fundraisers_leadership policy; action_items with its real three policies and NO update policy; Supabase-style
-- default grants): migration OK + idempotent; this RETEST 32 passed / 0 failed / 0 skipped. Mutation checks: the read
-- leaking goal_amount -> post-condition rolls back; Up next ignoring the tick -> B FAILS; read not dept-scoped -> D
-- FAILS; another policy changed -> post-condition rolls back; lifecycle ignoring status -> G FAILS.
-- =====================================================================
DO $retest$
DECLARE
  rec record; r record;
  v_err text; v_n int; v_txt text; v_done int; v_total int; v_steps jsonb;
  v_member text; v_leader text; v_other text; v_other_leader text;
  v_f uuid; v_f2 uuid; v_s1 uuid; v_s4 uuid; v_loose uuid;
  LEAD constant text[] := array['Board Member', 'Department Admin', 'Officer'];
  v_today date := (now() at time zone 'America/Chicago')::date;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- once
  IF NOT has_function_privilege('anon', 'public.get_station_fundraisers()', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_fundraiser_shared(uuid, boolean)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.set_fundraiser_step_visible(uuid, boolean)', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  anon cannot run any of the three functions%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  anon can run a station-fundraiser function%s', chr(10)); END IF;
  v_txt := pg_get_function_result('public.get_station_fundraisers()'::regprocedure);
  IF v_txt !~* '(goal|proceeds|amount|donor|donation|sponsor|campaign|owner|assign)' THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  read returns only: %s%s', v_txt, chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  read returns %s%s', v_txt, chr(10)); END IF;
  rpt := rpt || format('INFO  emails with member rows in more than one department: %s%s',
    (SELECT count(*) FROM (SELECT lower(email) FROM public.members WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(DISTINCT department_id) > 1) x), chr(10));

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    v_member := NULL; v_leader := NULL; v_other := NULL; v_other_leader := NULL;
    SELECT lower(m.email) INTO v_member FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.email IS NOT NULL AND NOT (coalesce(m.access, '{}') && (LEAD || array['Project Admin']::text[]))
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_leader FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.email IS NOT NULL AND m.access && LEAD
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other FROM public.members m
     WHERE m.department_id <> rec.dept_id AND m.email IS NOT NULL AND NOT (coalesce(m.access, '{}') && LEAD)
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_leader FROM public.members m
     WHERE m.department_id <> rec.dept_id AND m.email IS NOT NULL AND m.access && LEAD
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    IF v_member IS NULL OR v_leader IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a non-leader member and a leader%s', chr(10)); CONTINUE;
    END IF;

    BEGIN
      -- FIXTURES (as the owner): an upcoming fundraiser with 4 steps, a second NOT-shared one, and a loose action item
      INSERT INTO public.fundraisers (department_id, name, target_date, status) VALUES (rec.dept_id, 'RETEST Pancake Breakfast', v_today + 10, 'planning') RETURNING id INTO v_f;
      INSERT INTO public.fundraisers (department_id, name, target_date, status) VALUES (rec.dept_id, 'RETEST Private Gala', v_today + 12, 'planning') RETURNING id INTO v_f2;
      INSERT INTO public.action_items (department_id, text, status, due_date, fundraiser_id) VALUES (rec.dept_id, 'RETEST book the griddles', 'open', v_today + 3, v_f) RETURNING id INTO v_s1;
      INSERT INTO public.action_items (department_id, text, status, due_date, fundraiser_id, station_visible) VALUES (rec.dept_id, 'RETEST DONE-STEP', 'done', v_today + 1, v_f, true);
      INSERT INTO public.action_items (department_id, text, status, fundraiser_id) VALUES (rec.dept_id, 'RETEST CANCELLED-STEP', 'cancelled', v_f);
      INSERT INTO public.action_items (department_id, text, status, due_date, fundraiser_id) VALUES (rec.dept_id, 'RETEST SECRET-UNTICKED', 'open', v_today + 2, v_f) RETURNING id INTO v_s4;
      INSERT INTO public.action_items (department_id, text, status) VALUES (rec.dept_id, 'RETEST loose item', 'open') RETURNING id INTO v_loose;

      -- A. the leader shares + ticks
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_leader, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.set_fundraiser_shared(v_f, true);
        PERFORM public.set_fundraiser_step_visible(v_s1, true);
        v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err = 'OK' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  A leader shared it and ticked a step%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A leader write -> "%s"%s', v_err, chr(10)); END IF;

      -- B + C. what a member sees
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_member, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT tasks_done, tasks_total, next_steps INTO v_done, v_total, v_steps FROM public.get_station_fundraisers() WHERE id = v_f;
      IF v_done = 1 AND v_total = 3 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  B counts 1 of 3 (cancelled excluded)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B counts %s of %s, expected 1 of 3%s', v_done, v_total, chr(10)); END IF;
      IF jsonb_array_length(coalesce(v_steps, '[]')) = 1 AND v_steps->0->>'text' = 'RETEST book the griddles'
         AND v_steps::text NOT LIKE '%SECRET-UNTICKED%' AND v_steps::text NOT LIKE '%DONE-STEP%' AND v_steps::text NOT LIKE '%CANCELLED%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  B Up next = only the ticked open step (text + due date)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B Up next = %s%s', v_steps, chr(10)); END IF;
      SELECT count(*) INTO v_n FROM public.get_station_fundraisers() WHERE id = v_f2;
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  C a not-shared fundraiser is not returned%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C not-shared fundraiser returned%s', chr(10)); END IF;
      -- I. members still can't read the table directly
      SELECT count(*) INTO v_n FROM public.fundraisers WHERE id IN (v_f, v_f2);
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  I member reads 0 fundraisers rows directly%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  I member reads %s fundraisers row(s) directly%s', v_n, chr(10)); END IF;

      -- F. a non-leader can't share or tick
      BEGIN PERFORM public.set_fundraiser_shared(v_f2, true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err = 'Only leaders can share a fundraiser with the station' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F member can''t share%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F member share -> "%s"%s', v_err, chr(10)); END IF;
      BEGIN PERFORM public.set_fundraiser_step_visible(v_s4, true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err = 'Only leaders can choose what the station sees' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F member can''t tick%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F member tick -> "%s"%s', v_err, chr(10)); END IF;

      -- D. another department's member sees none of it
      IF v_other IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  D — no other-department member%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other, 'role', 'authenticated')::text, true);
        SELECT count(*) INTO v_n FROM public.get_station_fundraisers() WHERE id = v_f;
        IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D other department sees nothing%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D other department sees it%s', chr(10)); END IF;
      END IF;
      -- E. another department's leader can't write it
      IF v_other_leader IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  E — no other-department leader%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_leader, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.set_fundraiser_shared(v_f, false); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        IF v_err = 'Not in your department' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E other-dept leader can''t share%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E other-dept leader share -> "%s"%s', v_err, chr(10)); END IF;
        BEGIN PERFORM public.set_fundraiser_step_visible(v_s4, true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        IF v_err LIKE 'Not a planning step%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E other-dept leader can''t tick%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E other-dept leader tick -> "%s"%s', v_err, chr(10)); END IF;
      END IF;

      -- H. a loose (untagged) item can't be ticked, even by this department's leader
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_leader, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.set_fundraiser_step_visible(v_loose, true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'Not a planning step%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  H an untagged item can''t be ticked%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  H untagged tick -> "%s"%s', v_err, chr(10)); END IF;

      -- G. lifecycle — as the owner change the fixture, then read as the member
      FOR r IN SELECT * FROM (VALUES ('done', v_today + 10, 'marked done'), ('archived', v_today + 10, 'archived'),
                                     ('planning', v_today - 1, 'date passed'), ('planning', NULL::date, 'no date')) t(st, dt, label) LOOP
        PERFORM set_config('role', 'postgres', true);
        UPDATE public.fundraisers SET status = r.st, target_date = r.dt WHERE id = v_f;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_member, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        SELECT count(*) INTO v_n FROM public.get_station_fundraisers() WHERE id = v_f;
        IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  G %s -> drops off%s', r.label, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G %s -> still shown%s', r.label, chr(10)); END IF;
      END LOOP;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
