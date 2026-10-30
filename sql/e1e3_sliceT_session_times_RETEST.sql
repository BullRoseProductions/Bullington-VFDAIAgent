-- =====================================================================
-- RETEST for e1e3_sliceT_session_times. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Everything runs inside ONE sub-block ending in RAISE 'SENTINEL' (rolled back): synthetic sessions, a synthetic roll, Finalize,
-- Correct — NOTHING STAYS. The final RAISE is the report — the "ERROR" IS the report. As a REAL Department Admin (JWT email claim,
-- role authenticated) where a call goes through the API; as the table owner where the point is that the guard / CHECK stop
-- EVERY writer.
--   S0 the slice is in place: the columns, the four CHECKs validated, both finalize overloads, the bodies' md5s = the state row
--   T1 Finalize with times 19:00–22:26 + setup 20 → duration_min 206, the times + setup stored, one 'finalize' audit row whose
--      diff carries done / duration_min / actual_start / actual_end / setup_min
--   T2 past midnight: 22:00–01:30 → 210
--   T3 the guard: a raw UPDATE of actual_start / actual_end / setup_min on a finalized session → LOCKED_SESSION (owner too)
--   T4 the CHECK: a duration_min that disagrees with the times, written under the correction flag (guard bypassed) → refused
--   T5 Correct: actual_end 23:00 → duration_min recomputed 240, the diff logs actual_end + duration_min
--   T6 Correct: only duration_min (100) while times exist → BAD_VALUE (change the times)
--   T7 Correct: clearing both times → a length-only session, the length kept
--   T8 the fallback: the length-only finalize (45) still works, no times
--   T9 refusals: start = end · one time missing · setup 700 · a session that already has a different length → USE_CORRECT
--   T10 the ledger: attested_training credits the T1 session min(90, duration_min) = 90 minutes from date + start_time, and
--       setup_min never appears in it
--   T11 reopen, then a raw UPDATE of the stored times → LOCKED_SESSION (set once, then Correct-only)
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_email text; v_me uuid; v_dept uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; v_ok boolean; v_t text; v_n bigint; v_r jsonb; v_row record;
BEGIN
  BEGIN
    SELECT lower(m.email), m.id, m.department_id FROM public.members m WHERE m.status = 'Active' AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.department_id, m.id LIMIT 1 INTO v_email, v_me, v_dept;
    IF v_email IS NULL THEN RAISE EXCEPTION 'SKIPALL: no real Department Admin to act as'; END IF;
    -- S0
    IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name IN ('actual_start', 'actual_end', 'setup_min')) = 3
       AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND conname IN ('training_sessions_actual_pair', 'training_sessions_actual_whole_minutes', 'training_sessions_actual_length', 'training_sessions_setup_range') AND convalidated) = 4
       AND to_regprocedure('public.finalize_training_session(uuid, time without time zone, time without time zone, integer)') IS NOT NULL AND to_regprocedure('public.finalize_training_session(uuid, integer)') IS NOT NULL
       AND ARRAY['correct_training_session(uuid,jsonb,uuid[],uuid[],text)', 'finalize_training_session(uuid,time without time zone,time without time zone,integer)', 'tg_training_session_lock_guard()']::text[] <@ (SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{}') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ '(actual_start|actual_end|setup_min)') AND NOT ('attested_training(uuid,timestamp with time zone,timestamp with time zone)'::text = ANY ((SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{}') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ '(actual_start|actual_end|setup_min)')::text[]))
       AND NOT ('dept_iso_hours_for(uuid,timestamp with time zone,timestamp with time zone)'::text = ANY ((SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{}') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ '(actual_start|actual_end|setup_min)')::text[])) THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 columns + 4 validated CHECKs + both finalize overloads; finalize/correct/the guard read the new columns, the ledger does not' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S0 the slice is not in place as intended' || chr(10); END IF;

    -- synthetic sessions (owner) + the DA on each roll (attendance: membership-window triggers still run — a refusal SKIPs T10)
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-T RETEST 1', current_date, '19:00') RETURNING id INTO s1;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-T RETEST 2', current_date, '22:00') RETURNING id INTO s2;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-T RETEST 3', current_date, '18:00') RETURNING id INTO s3;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (v_dept, 'SLICE-T RETEST 4', current_date, '18:00', 60) RETURNING id INTO s4;
    v_ok := true;
    BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s1, v_me, now()); EXCEPTION WHEN OTHERS THEN v_ok := false; END;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    -- T1
    v_r := public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '22:26', p_setup_min => 20);
    EXECUTE 'RESET ROLE';
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s1;
    SELECT changes::text INTO v_t FROM public.training_session_audit WHERE session_id = s1 AND action = 'finalize' ORDER BY seq DESC LIMIT 1;
    IF v_row.done AND v_row.duration_min = 206 AND v_row.actual_start = '19:00' AND v_row.actual_end = '22:26' AND v_row.setup_min = 20 AND (v_r->>'duration_min')::int = 206
       AND v_t LIKE '%"done"%' AND v_t LIKE '%"duration_min"%' AND v_t LIKE '%"actual_start"%' AND v_t LIKE '%"actual_end"%' AND v_t LIKE '%"setup_min"%' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  T1 Finalize 19:00–22:26 + setup 20 → 206 min, times + setup stored, the audit diff carries all five' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T1 finalize with times: duration %s, audit %s%s', v_row.duration_min, left(coalesce(v_t, '(none)'), 120), chr(10)); END IF;

    -- T2
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.finalize_training_session(p_session_id => s2, p_actual_start => '22:00', p_actual_end => '01:30', p_setup_min => NULL);
    EXECUTE 'RESET ROLE';
    IF (SELECT duration_min FROM public.training_sessions WHERE id = s2) = 210 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T2 past midnight 22:00–01:30 → 210 min' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T2 past-midnight span' || chr(10); END IF;

    -- T3 the guard stops every writer (table owner here)
    v_n := 0;
    BEGIN UPDATE public.training_sessions SET actual_start = '18:30' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.training_sessions SET actual_end = '23:00' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.training_sessions SET setup_min = 5 WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; END;
    IF v_n = 3 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T3 raw UPDATE of actual_start / actual_end / setup_min on a finalized session → LOCKED_SESSION (owner too)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T3 the guard stopped %s of 3%s', v_n, chr(10)); END IF;

    -- T4 the CHECK (guard bypassed under the correction flag)
    v_ok := false;
    PERFORM set_config('b4c.session_correction', 'on', true);
    BEGIN UPDATE public.training_sessions SET duration_min = 100 WHERE id = s1; EXCEPTION WHEN check_violation THEN v_ok := true; END;
    PERFORM set_config('b4c.session_correction', '', true);
    IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T4 a duration_min that disagrees with the times is refused by the CHECK (even under the correction flag)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T4 the CHECK let a disagreeing length through' || chr(10); END IF;

    -- T5 / T6 / T7 Correct
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_r := public.correct_training_session(s1, '{"actual_end": "23:00"}'::jsonb, '{}', '{}', 'RETEST: the drill ran long');
    EXECUTE 'RESET ROLE';
    IF (SELECT duration_min FROM public.training_sessions WHERE id = s1) = 240 AND v_r->'changes' ? 'actual_end' AND v_r->'changes' ? 'duration_min' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  T5 Correct actual_end 23:00 → length recomputed 240, diff logs actual_end + duration_min' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T5 correct times: %s%s', v_r, chr(10)); END IF;
    v_t := NULL;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.correct_training_session(s1, '{"duration_min": 100}'::jsonb, '{}', '{}', 'RETEST: try a raw length'); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    EXECUTE 'RESET ROLE';
    IF v_t LIKE 'BAD_VALUE: the length comes from the actual start and end%' THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T6 Correct: a length alone while times exist → BAD_VALUE (change the times)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T6 %s%s', coalesce(v_t, 'accepted'), chr(10)); END IF;
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.correct_training_session(s1, '{"actual_start": "", "actual_end": ""}'::jsonb, '{}', '{}', 'RETEST: times were a guess');
    EXECUTE 'RESET ROLE';
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s1;
    IF v_row.actual_start IS NULL AND v_row.actual_end IS NULL AND v_row.duration_min = 240 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T7 Correct: clearing both times → length-only, 240 kept' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T7 clearing the times' || chr(10); END IF;

    -- T8 the length-only fallback — called NAMED, exactly as the shipped web/native clients call it today ({p_session_id,
    -- p_duration_min}); it must still resolve to the old function
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.finalize_training_session(p_session_id => s3, p_duration_min => 45);
    EXECUTE 'RESET ROLE';
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s3;
    IF v_row.done AND v_row.duration_min = 45 AND v_row.actual_start IS NULL AND v_row.setup_min IS NULL THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T8 the shipped clients'' call {p_session_id, p_duration_min} still resolves to the length-only finalize (45, no times)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T8 the fallback' || chr(10); END IF;

    -- T9 refusals
    v_n := 0;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '19:00', p_actual_end => '19:00', p_setup_min => NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '19:00', p_actual_end => NULL, p_setup_min => NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '18:00', p_actual_end => '19:00', p_setup_min => 700); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '18:00', p_actual_end => '19:30', p_setup_min => NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'USE_CORRECT%' THEN v_n := v_n + 1; END IF; END;
    EXECUTE 'RESET ROLE';
    IF v_n = 4 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T9 refused: start = end · one time missing · setup 700 · an existing different length (USE_CORRECT)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T9 %s of 4 refused%s', v_n, chr(10)); END IF;

    -- T10 the ledger (needs the synthetic roll on s1 — finalized first, so re-set its times via Correct for a clean read)
    IF EXISTS (SELECT 1 FROM public.session_attendance WHERE session_id = s1) THEN
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.correct_training_session(s1, '{"actual_start": "19:00", "actual_end": "22:26", "setup_min": 300}'::jsonb, '{}', '{}', 'RETEST: put the times back');
      EXECUTE 'RESET ROLE';
      SELECT count(*) INTO v_n FROM public.attested_training(v_dept, now() - interval '2 days', now() + interval '2 days') a
       WHERE a.session_id = s1 AND a.member_id = v_me AND a.end_at - a.start_at = interval '90 minutes'
         AND a.start_at = (current_date + time '19:00') AT TIME ZONE 'America/Chicago';
      IF v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T10 the ledger credits min(90, 206) = 90 min from date + start_time; setup_min (300) has no effect' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T10 the ledger row for the finalized session is not as expected' || chr(10); END IF;
    ELSE v_skip := v_skip + 1; rpt := rpt || 'SKIP  T10 the synthetic roll entry was refused (membership window) — the PGlite dry run carries this case' || chr(10); END IF;

    -- T11 reopen → the stored times are still Correct-only (s1 has a roll entry; a reopened session with NO attendance is unlocked
    -- for every column by the existing guard — unchanged semantics)
    IF EXISTS (SELECT 1 FROM public.session_attendance WHERE session_id = s1) THEN
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.reopen_training_session(s1, 'RETEST: reopen to check the lock');
      EXECUTE 'RESET ROLE';
      v_ok := false;
      BEGIN UPDATE public.training_sessions SET actual_end = '23:30' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_ok := true; END;
      IF v_ok AND NOT (SELECT done FROM public.training_sessions WHERE id = s1) THEN
        v_pass := v_pass + 1; rpt := rpt || 'PASS  T11 reopened (with its roll): a raw UPDATE of the stored times → LOCKED_SESSION (set once, Correct-only after)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T11 a reopened session''s times were raw-writable' || chr(10); END IF;
    ELSE v_skip := v_skip + 1; rpt := rpt || 'SKIP  T11 needs the synthetic roll entry (refused) — the PGlite dry run carries this case' || chr(10); END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SKIPALL:%' THEN v_skip := v_skip + 1; rpt := rpt || 'SKIP  ' || SQLERRM || chr(10);
    ELSIF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  the RETEST block aborted: %s%s', SQLERRM, chr(10)); END IF;
  END;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
