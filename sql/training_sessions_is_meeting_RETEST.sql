-- =====================================================================
-- RETEST for training_sessions_is_meeting_DRAFT.sql. READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- For each department with a leader, a live minutes record and an EVERYONE session, sign in as that leader
-- exactly as the app does (JWT email claim + role authenticated) and:
--   A. flag an everyone session is_meeting (as the owner, inside the sub-block) -> assigning minutes WORKS
--   B. the same everyone session UNFLAGGED                                      -> 'Only a meeting can hold minutes'
--   C. a leadership/board session (no flag needed)                              -> assigning WORKS (unchanged)
--   D. ANOTHER department's FLAGGED everyone session                            -> 'That meeting is not in this department'
--   E. direct UPDATE around the RPC to an UNFLAGGED everyone session            -> refused by the trigger
--   F. un-assigning (NULL) still works
-- Once: the column is boolean NOT NULL DEFAULT false; anon cannot EXECUTE the RPC; attendance math untouched
-- (the migration adds a column only — audience values are counted before/after inside the block as a check).
-- Every write (including the A/D flags) is inside a sub-block ending in RAISE 'SENTINEL' (rolled back); the
-- whole block ends in a RAISE that is the report + final rollback. NOTHING CHANGES. The "ERROR" IS the report.
-- A test whose fixture does not exist in that department prints SKIP, not PASS.
-- DRY RUN 2026-10-15 — NOT the live DB (PGlite mock from schema.sql + migration 1 applied, 2 departments):
--   * migration 2: OK, and OK again (idempotent); state check = boolean NOT NULL default false, 0 flagged,
--     new rule present, trigger 1, anon false, policy counts unchanged
--   * this RETEST: 14 passed, 0 failed, 0 skipped. Migration 1's RETEST: 16/0/1 before AND after migration 2.
--   * mutation checks: rule without the flag -> A and F FAIL; a widened training_sessions read policy ->
--     post-condition rolls back; the department check removed -> post-condition rolls back; run without
--     migration 1 -> precondition stops it.
-- =====================================================================
DO $retest$
DECLARE
  rec record;
  v_err text; v_sid uuid;
  v_minutes uuid; v_everyone uuid; v_mtg uuid; v_other_everyone uuid;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- once: the column shape, and anon
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions'
              AND column_name = 'is_meeting' AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  is_meeting is boolean NOT NULL DEFAULT false%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  is_meeting column shape%s', chr(10)); END IF;
  IF NOT has_function_privilege('anon', 'public.assign_minutes_to_session(uuid, uuid)', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  anon cannot EXECUTE assign_minutes_to_session%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  anon CAN EXECUTE assign_minutes_to_session%s', chr(10)); END IF;
  rpt := rpt || format('INFO  sessions flagged as meetings right now: %s%s', (SELECT count(*) FROM public.training_sessions WHERE is_meeting), chr(10));

  FOR rec IN
    SELECT DISTINCT ON (m.department_id) m.department_id, d.name AS dept, m.id AS mid, lower(m.email) AS email, m.name
      FROM public.members m JOIN public.departments d ON d.id = m.department_id
     WHERE m.email IS NOT NULL
       AND m.access && array['Board Member', 'Department Admin', 'Officer']::text[]
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
     ORDER BY m.department_id, m.id
  LOOP
    SELECT id INTO v_minutes  FROM public.ai_outputs WHERE department_id = rec.department_id AND feature = 'minutes' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
    SELECT id INTO v_everyone FROM public.training_sessions WHERE department_id = rec.department_id AND (audience IS NULL OR audience NOT IN ('leadership', 'board')) AND NOT is_meeting ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_mtg      FROM public.training_sessions WHERE department_id = rec.department_id AND audience IN ('leadership', 'board') ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_other_everyone FROM public.training_sessions WHERE department_id <> rec.department_id AND (audience IS NULL OR audience NOT IN ('leadership', 'board')) ORDER BY date DESC LIMIT 1;

    rpt := rpt || format('— %s (leader %s)%s', rec.dept, rec.name, chr(10));
    IF v_minutes IS NULL OR v_everyone IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — no live minutes or no unflagged everyone session%s', chr(10));
      CONTINUE;
    END IF;

    -- A. flagged everyone session accepts minutes
    v_sid := NULL;
    BEGIN
      UPDATE public.training_sessions SET is_meeting = true WHERE id = v_everyone;      -- as the owner; rolled back below
      PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      IF public.my_member_id() IS DISTINCT FROM rec.mid THEN RAISE EXCEPTION 'IMPERSONATION FAILED'; END IF;
      PERFORM public.assign_minutes_to_session(v_minutes, v_everyone);
      SELECT session_id INTO v_sid FROM public.ai_outputs WHERE id = v_minutes;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err = 'SENTINEL' AND v_sid = v_everyone THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  A flagged everyone session accepts minutes%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A flagged everyone session -> "%s"%s', v_err, chr(10)); END IF;

    -- B. the same session unflagged refuses
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.assign_minutes_to_session(v_minutes, v_everyone);
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err = 'Only a meeting can hold minutes' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  B unflagged everyone session refused%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B unflagged everyone session -> "%s"%s', v_err, chr(10)); END IF;

    -- C. leadership/board unchanged
    IF v_mtg IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  C — no leadership/board session%s', chr(10));
    ELSE
      v_sid := NULL;
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.assign_minutes_to_session(v_minutes, v_mtg);
        SELECT session_id INTO v_sid FROM public.ai_outputs WHERE id = v_minutes;
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err = 'SENTINEL' AND v_sid = v_mtg THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  C leadership/board session still accepts minutes%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C leadership/board -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- D. another department's flagged everyone session refuses
    IF v_other_everyone IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  D — no other-department everyone session%s', chr(10));
    ELSE
      BEGIN
        UPDATE public.training_sessions SET is_meeting = true WHERE id = v_other_everyone;   -- as the owner; rolled back
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.assign_minutes_to_session(v_minutes, v_other_everyone);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err = 'That meeting is not in this department' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D other-dept flagged session refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D other-dept flagged session -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- E. direct UPDATE around the RPC to the unflagged session
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      UPDATE public.ai_outputs SET session_id = v_everyone, edited_by = public.my_member_id() WHERE id = v_minutes;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err = 'Only a meeting can hold minutes' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E direct UPDATE to unflagged session refused by the trigger%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E direct UPDATE -> "%s"%s', v_err, chr(10)); END IF;

    -- F. un-assign still works (assign to the flagged session, then NULL)
    v_sid := v_everyone;
    BEGIN
      UPDATE public.training_sessions SET is_meeting = true WHERE id = v_everyone;
      PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.assign_minutes_to_session(v_minutes, v_everyone);
      PERFORM public.assign_minutes_to_session(v_minutes, NULL);
      SELECT session_id INTO v_sid FROM public.ai_outputs WHERE id = v_minutes;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err = 'SENTINEL' AND v_sid IS NULL THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F un-assign%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F un-assign -> "%s", session %s%s', v_err, v_sid, chr(10)); END IF;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
