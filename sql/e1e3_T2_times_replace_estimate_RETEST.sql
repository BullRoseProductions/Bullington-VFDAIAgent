-- =====================================================================
-- RETEST for e1e3_T2_times_replace_estimate. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Everything runs inside ONE sub-block ending in RAISE 'SENTINEL' (rolled back): synthetic sessions + a synthetic roll (as the
-- owner), Finalize / Reopen as a REAL Department Admin (JWT email claim, role authenticated) — NOTHING STAYS. The final RAISE is
-- the report — the "ERROR" IS the report.
--   S0 T2 is in place: the times finalize is the T2 body (no "already has a length", the times / setup refusals kept), both
--      overloads exactly as before (0 defaults), the length-only finalize / guard / correct / ledger pair on their pins
--   U1 THE RULING: a plan-scheduled session (estimate 120) finalized 19:00–22:26 → duration_min 206 replaces 120; actual times
--      stored; the finalize audit row logs duration_min 120 → 206
--   U2 the ledger reads the replaced length: attested_training credits that session min(90, 206) = 90 min from date + start_time
--   U3 existing actual times still refuse: reopen it, re-finalize with 19:00–23:00 → USE_CORRECT (actual times); re-finalize with
--      the SAME times goes through
--   U4 an existing setup time still refuses: reopen a session finalized with setup 20, re-finalize with setup 30 → USE_CORRECT
--   U5 the length-only finalize behaves exactly as today: estimate 120 + {p_duration_min: 90} → USE_CORRECT (unchanged);
--      {p_duration_min: NULL} keeps 120; no length + 45 → 45
--   U6 the times finalize's other refusals are unchanged: end = start · a time missing · setup 700 → BAD_VALUE
--   U7 the correction flag the times finalize lifts (only to replace a different length) is CLEARED after its UPDATE: in the same
--      transaction, a raw change to that session → LOCKED_SESSION
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_email text; v_me uuid; v_dept uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; v_t text; v_n bigint; v_row record; v_ch jsonb;
BEGIN
  BEGIN
    SELECT lower(m.email), m.id, m.department_id INTO v_email, v_me, v_dept FROM public.members m
     WHERE m.status = 'Active' AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
       AND public.membership_window_allows(m.id, v_today)
     ORDER BY m.department_id, m.id LIMIT 1;
    IF v_email IS NULL THEN RAISE EXCEPTION 'SKIPALL: no real Department Admin to act as'; END IF;

    -- S0
    IF md5(pg_get_functiondef('public.finalize_training_session(uuid, time without time zone, time without time zone, integer)'::regprocedure)) = 'f3ef2eb69c220812a9863ff3f5c431e3' AND (SELECT string_agg(array_to_string(p.proargnames, ',') || '/' || p.pronargdefaults, ' | ' ORDER BY p.pronargs) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'finalize_training_session') = 'p_session_id,p_duration_min/0 | p_session_id,p_actual_start,p_actual_end,p_setup_min/0'
       AND md5(pg_get_functiondef('public.tg_training_session_lock_guard()'::regprocedure)) = 'c1af95df40d551b75998cde0a8f290f7'
       AND md5(pg_get_functiondef('public.correct_training_session(uuid, jsonb, uuid[], uuid[], text)'::regprocedure)) = '8c00066509e9dca338dc3662f55e1211'
       AND md5(pg_get_functiondef('public.finalize_training_session(uuid, integer)'::regprocedure)) = '3f31142bae70c8fd2001c4fb657f4efa'
       AND md5(pg_get_functiondef('public.attested_training(uuid, timestamp with time zone, timestamp with time zone)'::regprocedure)) = 'aff25333771cd38c1f473bcde5e1e96e'
       AND md5(pg_get_functiondef('public.dept_iso_hours_for(uuid, timestamp with time zone, timestamp with time zone)'::regprocedure)) = '705c9a9b5532d28824f5e50e74d6059f' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 the times finalize is the T2 body (md5 f3ef2eb6): no length refusal, the times + setup refusals kept; both overloads unchanged; the length-only finalize / guard / correct / ledger on their pins' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 T2 is not in place as intended%s', chr(10)); END IF;

    -- synthetic sessions (owner) + the DA on each roll; the membership-window trigger still runs (eligible DA only)
    INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (v_dept, 'T2 RETEST plan-scheduled', v_today, '19:00', 120) RETURNING id INTO s1;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'T2 RETEST setup', v_today, '19:00') RETURNING id INTO s2;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (v_dept, 'T2 RETEST length-only est', v_today, '19:00', 120) RETURNING id INTO s3;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (v_dept, 'T2 RETEST length-only est null', v_today, '19:00', 120) RETURNING id INTO s4;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'T2 RETEST no length', v_today, '19:00') RETURNING id INTO s5;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'T2 RETEST refusals', v_today, '19:00') RETURNING id INTO s6;
    BEGIN
      INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s1, v_me, now()); INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s2, v_me, now()); INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s3, v_me, now()); INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s4, v_me, now()); INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s5, v_me, now()); INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s6, v_me, now());
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SKIPALL: the synthetic roll was refused (%)', SQLERRM;
    END;

    -- U1 the ruling
    v_t := NULL; BEGIN PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '22:26', p_setup_min => NULL); EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s1;
    SELECT changes INTO v_ch FROM public.training_session_audit WHERE session_id = s1 AND action = 'finalize' ORDER BY seq DESC LIMIT 1;
    IF v_row.done AND v_row.duration_min = 206 AND v_row.actual_start = '19:00' AND v_row.actual_end = '22:26'
       AND (v_ch->'duration_min'->>'old')::int = 120 AND (v_ch->'duration_min'->>'new')::int = 206 THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  U1 plan-scheduled session (estimate 120) finalized 19:00–22:26 → duration_min 206 replaces 120; the finalize audit logs duration_min 120 → 206' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U1 %s — done %s, duration %s, audit %s%s', coalesce(v_t, 'no refusal'), v_row.done, v_row.duration_min, coalesce(v_ch::text, '(none)'), chr(10)); END IF;

    -- U2 the ledger reads the replaced length
    SELECT count(*) INTO v_n FROM public.attested_training(v_dept, now() - interval '2 days', now() + interval '2 days') a
     WHERE a.session_id = s1 AND a.member_id = v_me AND a.end_at - a.start_at = interval '90 minutes'
       AND a.start_at = (v_today + time '19:00') AT TIME ZONE 'America/Chicago';
    IF v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  U2 the ledger credits that session min(90, 206) = 90 min from date + start_time (the replaced length; the ledger itself unchanged)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U2 %s ledger rows as expected%s', v_n, chr(10)); END IF;

    -- U7 the correction flag U1 lifted is CLEARED: in the same transaction, a raw change to that (finalized) session → LOCKED_SESSION
    v_t := NULL;
    BEGIN UPDATE public.training_sessions SET title = title || ' x' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_t := SQLERRM; END;
    IF v_t LIKE 'LOCKED_SESSION%' AND coalesce(current_setting('b4c.session_correction', true), '') = '' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  U7 the correction flag U1 lifted is cleared — in the same transaction a raw change to that session → LOCKED_SESSION (owner too)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U7 the flag leaked: %s, flag = %s%s', coalesce(v_t, 'raw update accepted'), coalesce(current_setting('b4c.session_correction', true), '(unset)'), chr(10)); END IF;

    -- U3 existing actual times still refuse (reopen → re-finalize with different times); the same times go through
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.reopen_training_session(s1, 'RETEST: reopen to re-finalize'); EXECUTE 'RESET ROLE';
    v_t := NULL; BEGIN PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '23:00', p_setup_min => NULL); EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    IF v_t LIKE 'USE_CORRECT: this drill already has actual times%' THEN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '22:26', p_setup_min => NULL); EXECUTE 'RESET ROLE';
      IF (SELECT done AND duration_min = 206 FROM public.training_sessions WHERE id = s1) THEN
        v_pass := v_pass + 1; rpt := rpt || 'PASS  U3 reopened: re-finalize with different times → USE_CORRECT (existing actual times — still a Correct); the same times re-finalize' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U3 the same-times re-finalize did not land%s', chr(10)); END IF;
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U3 different times after a reopen: %s%s', coalesce(v_t, 'accepted'), chr(10)); END IF;

    -- U4 an existing setup time still refuses
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s2, p_actual_start => '19:00', p_actual_end => '20:00', p_setup_min => 20); EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.reopen_training_session(s2, 'RETEST: reopen to re-finalize'); EXECUTE 'RESET ROLE';
    v_t := NULL; BEGIN PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s2, p_actual_start => '19:00', p_actual_end => '20:00', p_setup_min => 30); EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    IF v_t LIKE 'USE_CORRECT: this drill already has a setup time%' THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  U4 reopened: re-finalize with setup 30 over 20 → USE_CORRECT (existing setup — still a Correct)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U4 %s%s', coalesce(v_t, 'accepted'), chr(10)); END IF;

    -- U5 the length-only finalize, exactly as today
    v_t := NULL; BEGIN PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s3, p_duration_min => 90); EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    IF v_t LIKE 'USE_CORRECT: this drill already has a length%' THEN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.finalize_training_session(p_session_id => s4, p_duration_min => NULL);
      PERFORM public.finalize_training_session(p_session_id => s5, p_duration_min => 45);
      EXECUTE 'RESET ROLE';
      IF (SELECT done AND duration_min = 120 AND actual_start IS NULL FROM public.training_sessions WHERE id = s4)
         AND (SELECT done AND duration_min = 45 AND actual_start IS NULL FROM public.training_sessions WHERE id = s5) THEN
        v_pass := v_pass + 1; rpt := rpt || 'PASS  U5 length-only finalize unchanged: estimate 120 + 90 → USE_CORRECT; NULL keeps 120; no length + 45 → 45 (no times)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U5 the length-only finalize did not behave as today%s', chr(10)); END IF;
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U5 estimate 120 + 90 via the length-only finalize: %s%s', coalesce(v_t, 'accepted'), chr(10)); END IF;

    -- U6 the times finalize's other refusals
    v_n := 0;
    v_t := NULL; BEGIN PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s6, p_actual_start => '19:00', p_actual_end => '19:00', p_setup_min => NULL); EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END; IF v_t LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF;
    v_t := NULL; BEGIN PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s6, p_actual_start => '19:00', p_actual_end => NULL, p_setup_min => NULL); EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END; IF v_t LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF;
    v_t := NULL; BEGIN PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.finalize_training_session(p_session_id => s6, p_actual_start => '19:00', p_actual_end => '20:00', p_setup_min => 700); EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END; IF v_t LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF;
    IF v_n = 3 AND NOT (SELECT done FROM public.training_sessions WHERE id = s6) THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  U6 the times finalize still refuses end = start · a time missing · setup 700 (BAD_VALUE)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  U6 %s of 3 refused%s', v_n, chr(10)); END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SKIPALL:%' THEN v_skip := v_skip + 1; rpt := rpt || 'SKIP  ' || SQLERRM || chr(10);
    ELSIF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  the RETEST block aborted: %s%s', SQLERRM, chr(10)); END IF;
  END;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
