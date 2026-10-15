-- =====================================================================
-- RETEST for session_registrations_2026-10-15.sql.
-- RAN 2026-10-15 on live: 33 passed, 0 failed, 6 skipped (Indian Harbor, Lipan, North Hood A-K; Demo + Granbury skipped —
-- no non-leader/leader/open-session trio; E/F skipped where no open board/leadership session). READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Once: anon can't run the RPC or read the table; authenticated can't write it directly.
-- For each department that has a non-leader member, a leader, and an open (not finalized) everyone session,
-- sign in exactly as the app does (JWT email claim + role authenticated) and check:
--   A. the member sets "coming", then changes to "maybe"   -> ONE row, their own, status maybe
--   B. the member reads the session's plans                 -> sees ONLY their own row (not the leader's)
--   C. the leader reads the session's plans                 -> sees every row (theirs + the member's)
--   D. a member of ANOTHER department                       -> can't set ('Not in your department') and reads 0 rows
--   E. a non-board member on a BOARD session                -> 'Not eligible for this session'
--   F. a non-leader on a LEADERSHIP session                 -> 'Not eligible for this session'
--   G. a bad status ('yes')                                  -> 'Choose Coming, Maybe, or Not coming'
--   H. a FINALIZED session                                   -> 'This session is closed'
--   I. a direct INSERT / UPDATE by the member                -> refused (no write privilege / policy)
--   K. a LEADER of another department reads this session's plans -> 0 rows (the leader read is department-scoped)
--   J. ATTENDANCE UNTOUCHED: session_attendance row count for the department is identical before and after
--      every write above
-- Every write is inside a sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in a RAISE
-- that is the report + final rollback. NOTHING CHANGES. The "ERROR" IS the report. A test whose fixture does not
-- exist in that department prints SKIP, not PASS.
-- DRY RUN 2026-10-15 — NOT the live DB (PGlite mock: 2 departments; Supabase-style default grants to anon/authenticated
-- on new tables, which the migration must revoke):
--   * migration OK, and OK again (idempotent); state: RLS on, the two SELECT policies, anon locked out,
--     authenticated INSERT false, other tables' policy count unchanged
--   * this RETEST: 22 passed, 0 failed, 3 skipped (the small mock dept has no board/leadership/finalized session)
--   * mutation checks: audience check removed -> E and F FAIL; leader policy without the department scope -> K FAILS;
--     another table's policy changed inside the migration -> post-condition rolls back; INSERT left granted ->
--     post-condition rolls back. A real bug was caught here: the precondition's AND did not short-circuit.
-- =====================================================================
DO $retest$
DECLARE
  rec record;
  v_err text; v_n int; v_status text; v_att_before bigint; v_att_after bigint;
  v_member_email text; v_member_id uuid; v_member_access text[];
  v_leader_email text; v_leader_id uuid;
  v_other_email text; v_other_leader text;
  v_open uuid; v_board uuid; v_lead uuid; v_done uuid;
  LEAD constant text[] := array['Project Admin', 'Department Admin', 'Board Member', 'Officer'];
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- once: privileges
  IF NOT has_function_privilege('anon', 'public.set_my_session_registration(uuid, text)', 'EXECUTE')
     AND NOT has_table_privilege('anon', 'public.session_registrations', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.session_registrations', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.session_registrations', 'UPDATE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  anon locked out; authenticated cannot write the table directly%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  privileges on session_registrations / the RPC are too open%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    v_member_email := NULL; v_leader_email := NULL; v_other_email := NULL; v_other_leader := NULL;
    v_open := NULL; v_board := NULL; v_lead := NULL; v_done := NULL;
    -- fixtures (as the owner); single-row emails only so my_department_id() is unambiguous
    SELECT lower(m.email), m.id, m.access INTO v_member_email, v_member_id, v_member_access FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.email IS NOT NULL AND NOT (coalesce(m.access, '{}') && LEAD)
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_leader_email, v_leader_id FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.email IS NOT NULL AND m.access && array['Department Admin', 'Officer']::text[]
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_email FROM public.members m
     WHERE m.department_id <> rec.dept_id AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_leader FROM public.members m
     WHERE m.department_id <> rec.dept_id AND m.email IS NOT NULL AND m.access && LEAD
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT id INTO v_open  FROM public.training_sessions WHERE department_id = rec.dept_id AND NOT coalesce(done, false) AND coalesce(audience, 'everyone') NOT IN ('leadership', 'board') ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_board FROM public.training_sessions WHERE department_id = rec.dept_id AND NOT coalesce(done, false) AND audience = 'board' ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_lead  FROM public.training_sessions WHERE department_id = rec.dept_id AND NOT coalesce(done, false) AND audience = 'leadership' ORDER BY date DESC LIMIT 1;
    SELECT id INTO v_done  FROM public.training_sessions WHERE department_id = rec.dept_id AND coalesce(done, false) ORDER BY date DESC LIMIT 1;

    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    IF v_member_email IS NULL OR v_leader_email IS NULL OR v_open IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a non-leader member, a leader, and an open everyone session%s', chr(10));
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_att_before FROM public.session_attendance WHERE department_id = rec.dept_id;

    -- A + B + C + J in one rolled-back pass
    v_n := NULL; v_status := NULL; v_err := NULL;
    BEGIN
      -- the leader plans first (as themselves), then the member twice
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_leader_email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.set_my_session_registration(v_open, 'not_coming');
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_member_email, 'role', 'authenticated')::text, true);
      IF public.my_member_id() IS DISTINCT FROM v_member_id THEN RAISE EXCEPTION 'IMPERSONATION FAILED'; END IF;
      PERFORM public.set_my_session_registration(v_open, 'coming');
      PERFORM public.set_my_session_registration(v_open, 'maybe');
      -- B: what the member can see
      SELECT count(*), max(status) INTO v_n, v_status FROM public.session_registrations WHERE session_id = v_open;
      IF v_n = 1 AND v_status = 'maybe' THEN v_pass := v_pass + 2; rpt := rpt || format('   PASS  A one row, changed coming -> maybe%s   PASS  B member sees only their own row%s', chr(10), chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A/B member sees %s row(s), status %s%s', v_n, v_status, chr(10)); END IF;
      -- C: what the leader can see
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_leader_email, 'role', 'authenticated')::text, true);
      SELECT count(*) INTO v_n FROM public.session_registrations WHERE session_id = v_open;
      IF v_n = 2 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  C leader sees the department breakdown (2 rows)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C leader sees %s row(s), expected 2%s', v_n, chr(10)); END IF;
      -- D (read half): another department sees nothing
      IF v_other_email IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_email, 'role', 'authenticated')::text, true);
        SELECT count(*) INTO v_n FROM public.session_registrations WHERE session_id = v_open;
        IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D other department reads 0 rows%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D other department reads %s row(s)%s', v_n, chr(10)); END IF;
      END IF;
      -- K: a leader of ANOTHER department sees nothing here
      IF v_other_leader IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  K — no other-department leader%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_leader, 'role', 'authenticated')::text, true);
        SELECT count(*) INTO v_n FROM public.session_registrations WHERE session_id = v_open;
        IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  K other-department leader reads 0 rows%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K other-department leader reads %s row(s)%s', v_n, chr(10)); END IF;
      END IF;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_att_after FROM public.session_attendance WHERE department_id = rec.dept_id;
      IF v_att_after = v_att_before THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  J attendance untouched (%s rows before and after)%s', v_att_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  J attendance changed %s -> %s%s', v_att_before, v_att_after, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A-J pass aborted: %s%s', v_err, chr(10)); END IF;

    -- D (write half): another department can't set
    IF v_other_email IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  D — no other-department member%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.set_my_session_registration(v_open, 'coming');
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err = 'Not in your department' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D other department refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D other department -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- E: board session, non-board member
    IF v_board IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  E — no open board session%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_member_email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.set_my_session_registration(v_board, 'coming');
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err = 'Not eligible for this session' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E non-board member refused on a board session%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E board session -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- F: leadership session, non-leader member
    IF v_lead IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  F — no open leadership session%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_member_email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.set_my_session_registration(v_lead, 'coming');
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err = 'Not eligible for this session' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F non-leader refused on a leadership session%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F leadership session -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- G: bad status
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_member_email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.set_my_session_registration(v_open, 'yes');
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err = 'Choose Coming, Maybe, or Not coming' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  G bad status refused%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G bad status -> "%s"%s', v_err, chr(10)); END IF;

    -- H: finalized session
    IF v_done IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  H — no finalized session%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_member_email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.set_my_session_registration(v_done, 'coming');
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      IF v_err IN ('This session is closed', 'Not eligible for this session') THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  H finalized session refused (%s)%s', v_err, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  H finalized session -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- I: direct writes
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_member_email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      INSERT INTO public.session_registrations (session_id, member_id, department_id, status) VALUES (v_open, v_leader_id, rec.dept_id, 'coming');
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err ILIKE '%permission denied%' OR v_err ILIKE '%row-level security%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  I direct INSERT (for someone else) refused%s', chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  I direct INSERT -> "%s"%s', v_err, chr(10)); END IF;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
