-- =====================================================================
-- RETEST for ai_outputs_session_id_DRAFT.sql. READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- One DO block. For each department that has a leader, a live minutes record and a leadership/board
-- meeting, it signs in as that leader exactly as the app does (JWT email claim + role authenticated) and:
--   A. assigns its own minutes to its own leadership/board meeting      -> works, session_id set,
--      and edited_by / edited_at / current_text / ai_text are NOT touched
--   B. un-assigns (NULL)                                                 -> works, session_id NULL
--   C. assigns to its own EVERYONE (training) session                    -> 'Only a leadership or board meeting can hold minutes'
--   D. assigns to ANOTHER department's meeting                           -> 'That meeting is not in this department'
--   E. assigns ANOTHER department's minutes                              -> 'Not in your department'
--   F. assigns one of its own AGENDA records                             -> 'Only minutes can be assigned to a meeting'
--   G. bypasses the RPC with a direct UPDATE to an EVERYONE session      -> refused by the guard trigger
--   H. a NON-leader member of the same department calls the RPC          -> 'Only leaders can assign minutes to a meeting'
--   I. READ SCOPE: a non-leader member sees the same number of minutes as the table owner does for
--      that department (unchanged rule: today every member's row read is department-wide; this proves
--      the migration did not narrow or widen it — compare with the BEFORE number you note, see below).
-- Once: anon cannot EXECUTE the RPC.
-- DRY RUN 2026-10-15 — NOT the live DB. Run against PGlite (Postgres 16 in WASM) with a mock of the relevant
-- pieces copied from schema.sql: departments, members, training_sessions(audience), ai_outputs + its three
-- policies, the deleted_at guard trigger, my_department_id / my_member_id / is_canmanage / is_canmanage_ops /
-- is_dept_admin, roles anon + authenticated, auth.email() from request.jwt.claims. Two departments seeded.
--   * migration: OK, and OK again (idempotent); state check = uuid nullable, CHECK, trigger, anon false, 3 policies
--   * RETEST: 16 passed, 0 failed, 1 skipped (one mock dept had no agenda)
--   * mutation checks: without the guard trigger the RETEST FAILS C, D, G; a widened read policy inside
--     the migration and an open anon grant each trip a post-condition and roll back; the minutes-only
--     CHECK refuses an agenda row; deleting a meeting un-assigns its minutes (ON DELETE SET NULL).
-- The live run is still the real test — the live policies / helper bodies may differ from the snapshot.
-- Every write is inside a sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in a
-- RAISE that is the report + final rollback. NOTHING CHANGES. The "ERROR" IS the report.
-- A test whose fixture does not exist in that department prints SKIP, not PASS.
-- =====================================================================
DO $retest$
DECLARE
  rec record;
  v_err text; v_sid uuid; v_eb uuid; v_ea timestamptz; v_ct text; v_at text;
  v_eb0 uuid; v_ea0 timestamptz; v_ct0 text; v_at0 text;
  v_minutes uuid; v_mtg uuid; v_everyone uuid; v_other_mtg uuid; v_other_min uuid; v_agenda uuid;
  v_plain_email text; v_seen int; v_owner_cnt int;
  rpt text := chr(10); n int := 0; v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- I (once): anon
  n := n + 1;
  IF NOT has_function_privilege('anon', 'public.assign_minutes_to_session(uuid, uuid)', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  anon cannot EXECUTE assign_minutes_to_session%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  anon CAN EXECUTE assign_minutes_to_session%s', chr(10)); END IF;

  FOR rec IN
    SELECT DISTINCT ON (m.department_id) m.department_id, d.name AS dept, m.id AS mid, lower(m.email) AS email, m.name
      FROM public.members m JOIN public.departments d ON d.id = m.department_id
     WHERE m.email IS NOT NULL
       AND m.access && array['Board Member', 'Department Admin', 'Officer']::text[]
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1   -- one member row, so my_department_id() is unambiguous
     ORDER BY m.department_id, m.id
  LOOP
    -- fixtures, read as the table owner
    SELECT id INTO v_minutes  FROM public.ai_outputs WHERE department_id = rec.department_id AND feature = 'minutes' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
    SELECT id INTO v_mtg      FROM public.training_sessions WHERE department_id = rec.department_id AND audience IN ('leadership', 'board') ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_everyone FROM public.training_sessions WHERE department_id = rec.department_id AND (audience IS NULL OR audience NOT IN ('leadership', 'board')) ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_other_mtg FROM public.training_sessions WHERE department_id <> rec.department_id AND audience IN ('leadership', 'board') ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_other_min FROM public.ai_outputs WHERE department_id <> rec.department_id AND feature = 'minutes' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
    SELECT id INTO v_agenda   FROM public.ai_outputs WHERE department_id = rec.department_id AND feature = 'agenda' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
    SELECT lower(m.email) INTO v_plain_email FROM public.members m
     WHERE m.department_id = rec.department_id AND m.email IS NOT NULL
       AND NOT (m.access && array['Board Member', 'Department Admin', 'Officer', 'Project Admin']::text[])
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
     ORDER BY m.id LIMIT 1;

    rpt := rpt || format('— %s (leader %s)%s', rec.dept, rec.name, chr(10));
    IF v_minutes IS NULL OR v_mtg IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — no live minutes or no leadership/board meeting in this department%s', chr(10));
      CONTINUE;
    END IF;
    SELECT edited_by, edited_at, current_text, ai_text INTO v_eb0, v_ea0, v_ct0, v_at0 FROM public.ai_outputs WHERE id = v_minutes;

    -- A + B. assign, read back, un-assign, read back
    v_sid := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      IF public.my_member_id() IS DISTINCT FROM rec.mid THEN RAISE EXCEPTION 'IMPERSONATION FAILED'; END IF;
      PERFORM public.assign_minutes_to_session(v_minutes, v_mtg);
      SELECT session_id, edited_by, edited_at, current_text, ai_text INTO v_sid, v_eb, v_ea, v_ct, v_at FROM public.ai_outputs WHERE id = v_minutes;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err = 'SENTINEL' AND v_sid = v_mtg AND v_eb IS NOT DISTINCT FROM v_eb0 AND v_ea IS NOT DISTINCT FROM v_ea0
       AND v_ct IS NOT DISTINCT FROM v_ct0 AND v_at IS NOT DISTINCT FROM v_at0 THEN
      v_pass := v_pass + 1; rpt := rpt || format('   PASS  A assign own minutes -> own meeting; text + edited stamp untouched%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A assign -> err "%s", session %s%s', v_err, v_sid, chr(10)); END IF;

    v_sid := v_mtg;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.assign_minutes_to_session(v_minutes, v_mtg);
      PERFORM public.assign_minutes_to_session(v_minutes, NULL);
      SELECT session_id INTO v_sid FROM public.ai_outputs WHERE id = v_minutes;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err = 'SENTINEL' AND v_sid IS NULL THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  B un-assign%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B un-assign -> err "%s", session %s%s', v_err, v_sid, chr(10)); END IF;

    -- C. own everyone/training session
    IF v_everyone IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  C — no everyone session%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.assign_minutes_to_session(v_minutes, v_everyone);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'Only a leadership or board meeting can hold minutes' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  C training session refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C training session -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- D. another department's meeting
    IF v_other_mtg IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  D — no other-department meeting%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.assign_minutes_to_session(v_minutes, v_other_mtg);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'That meeting is not in this department' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D other-dept meeting refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D other-dept meeting -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- E. another department's minutes
    IF v_other_min IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  E — no other-department minutes%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.assign_minutes_to_session(v_other_min, v_mtg);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'Not in your department' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E other-dept minutes refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E other-dept minutes -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- F. an agenda record
    IF v_agenda IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  F — no agenda record%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.assign_minutes_to_session(v_agenda, v_mtg);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'Only minutes can be assigned to a meeting' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F agenda refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F agenda -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- G. direct UPDATE around the RPC (satisfying the UPDATE policy's edited_by check) -> the trigger refuses
    IF v_everyone IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  G — no everyone session%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        UPDATE public.ai_outputs SET session_id = v_everyone, edited_by = public.my_member_id() WHERE id = v_minutes;
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'Only a leadership or board meeting can hold minutes' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  G direct UPDATE refused by the trigger%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G direct UPDATE -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- H + I. a non-leader member: cannot assign; and how many minutes rows they can read (read scope)
    IF v_plain_email IS NULL THEN v_skip := v_skip + 2; rpt := rpt || format('   SKIP  H/I — no single-row non-leader member%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_plain_email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.assign_minutes_to_session(v_minutes, v_mtg);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'Only leaders can assign minutes to a meeting' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  H non-leader refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  H non-leader -> "%s"%s', v_err, chr(10)); END IF;

      v_seen := NULL;
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_plain_email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        SELECT count(*) INTO v_seen FROM public.ai_outputs WHERE feature = 'minutes';
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      SELECT count(*) INTO v_owner_cnt FROM public.ai_outputs WHERE feature = 'minutes' AND department_id = rec.department_id;
      -- Not PASS/FAIL: the rule is unchanged by design, so this prints the number to compare with the
      -- BEFORE query below. Equal before and after = read scope unchanged.
      rpt := rpt || format('   INFO  I a non-leader member reads %s minutes rows via RLS (department holds %s)%s', v_seen, v_owner_cnt, chr(10));
    END IF;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;

-- =====================================================================
-- BEFORE (optional, read-only) — run this BEFORE applying the migration and note the numbers. After
-- the migration, test I's INFO lines should show the same "reads N" for each department.
-- =====================================================================
-- DO $before$
-- DECLARE rec record; v_seen int; rpt text := chr(10); v_err text;
-- BEGIN
--   FOR rec IN SELECT DISTINCT ON (m.department_id) m.department_id, d.name AS dept, lower(m.email) AS email
--                FROM public.members m JOIN public.departments d ON d.id = m.department_id
--               WHERE m.email IS NOT NULL AND NOT (m.access && array['Board Member','Department Admin','Officer','Project Admin']::text[])
--                 AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
--               ORDER BY m.department_id, m.id LOOP
--     BEGIN
--       PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
--       PERFORM set_config('role', 'authenticated', true);
--       SELECT count(*) INTO v_seen FROM public.ai_outputs WHERE feature = 'minutes';
--       RAISE EXCEPTION 'SENTINEL';
--     EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
--     END;
--     rpt := rpt || format('   %s: a non-leader member reads %s minutes rows%s', rec.dept, v_seen, chr(10));
--   END LOOP;
--   RAISE EXCEPTION '%', rpt;
-- END
-- $before$;
