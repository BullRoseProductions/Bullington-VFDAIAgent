-- =====================================================================
-- RETEST for training_officers (DRAFT, not applied) — run AFTER the migration, separately.
-- RAN on live 2026-10-24: 22 passed, 0 failed, 5 skipped — S0; Indian Harbor + Lipan + North Hood T1–T5 O1 X1 (QR still opens for a
-- removed Officer in all three); P1 skipped in all three — both live Project Admins are also Department Admins, so no PA-only member
-- exists (the PA-only path is proven in the PGlite dry run); Demo + Granbury skip (no plain member). Rollback confirmed after:
-- training_officer = the 8 seed rows only, no RETEST sessions / categories / plans.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). Fixtures
-- (a session, a meeting, a category, a drill plan, a roster mark, assignments) are written by the people under test and
-- vanish with the rollback. The final RAISE is the report — the "ERROR" IS the report.
--   S0 (once) structure: the registry (RLS, one SELECT policy), the four gate functions authenticated-only, the 13
--      repointed objects carry is_training_manager() and none still carries is_canmanage_ops(), is_canmanage_ops() is
--      byte-identical (92fa1803…), and every active Officer who is not a DA is an active training officer (the seed)
-- Per department (needs a DA, a plain member whose membership window covers today, and a DA of ANOTHER department; unique
-- emails). Optional: a seeded Officer (not DA) and a Project Admin (not DA / Officer).
--   T1 the DA manages training: schedules a session AND a board meeting, adds a category, writes a drill plan
--   T2 a plain member is refused every surface: schedule / edit (0 rows) / roster / category / the registry table itself by RLS;
--      the drill plan and assigning themselves by the RPCs
--   T3 the DA assigns the member: a row stamped by the DA; assigning again returns the same row (one active)
--   T4 the member, now a training officer, gains every surface: schedules a meeting, edits the session, marks + clears the
--      roster, adds a category, writes a drill plan
--   T5 removal revokes it: stamped removed_by; scheduling refused again; a second remove returns NULL; re-assigning adds a
--      NEW row (history: two rows, one active)
--   O1 a seeded Officer manages training until the DA removes them; then refused schedule + drill plan — but can still
--      open a QR sign-in (open_signin's gate is unchanged, decision 3)
--   P1 a Project Admin can't manage training (decision 1) but can appoint a training officer (decision 6)
--   X1 another department's DA can't assign / remove this department's member, and can't see this department's officers
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_ok boolean; v_n int; v_n2 int; v_b boolean; v_b2 boolean;
  v_da text; v_da_mid uuid; v_mem text; v_mem_mid uuid; v_off text; v_off_mid uuid; v_pa text; v_xda text; v_xhome uuid;
  v_s uuid; v_m uuid; v_r1 uuid; v_r2 uuid; e1 text; e2 text; e3 text; e4 text; e5 text; e6 text;
  C constant jsonb := '{"summary":"RETEST","objectives":["x"],"run_of_show":[],"materials":[],"safety":[]}';
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.training_officer'::regclass)
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_officer') = 1
     AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
            AND proname IN ('is_training_officer', 'is_training_manager', 'assign_training_officer', 'remove_training_officer')
            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) = 4
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_training_manager()%') = 8
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('training_sessions', 'training_plans', 'session_attendance', 'session_plans')
            AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_canmanage_ops()%') = 0
     AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%drill_plan%' AND position('is_canmanage_ops()' in prosrc) > 0) = 0
     AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position('coalesce(public.is_training_manager(), false)' in prosrc) > 0) = 5
     AND md5(pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)) = '92fa180343748968dff96fa044b0420d'
     AND NOT EXISTS (SELECT 1 FROM public.members m WHERE m.status IN ('Active', 'Probationary') AND m.access && array['Officer']::text[]
                       AND NOT m.access && array['Department Admin']::text[]
                       AND NOT EXISTS (SELECT 1 FROM public.training_officer t WHERE t.member_id = m.id AND t.department_id = m.department_id AND t.removed_at IS NULL))
    INTO v_ok;
  SELECT count(*) INTO v_n FROM public.training_officer WHERE removed_at IS NULL;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 registry RLS + one policy; 4 gate fns authenticated-only; 13 repointed, none left on is_canmanage_ops(); is_canmanage_ops() 92fa1803 unchanged; seed covers every active non-DA Officer (%s active)%s', v_n, chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 structure / seed (%s active)%s', v_n, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_da_mid := NULL; v_mem := NULL; v_mem_mid := NULL; v_off := NULL; v_off_mid := NULL; v_pa := NULL; v_xda := NULL; v_xhome := NULL;
    SELECT lower(m.email), m.id INTO v_da, v_da_mid FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_mem, v_mem_mid FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND public.membership_window_allows(m.id, current_date)
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_off, v_off_mid FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_pa FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Project Admin']::text[]
       AND NOT m.access && array['Department Admin','Officer']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_xda, v_xhome FROM public.members m WHERE m.department_id <> rec.dept_id
       AND m.access && array['Department Admin']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_mem IS NULL OR v_xda IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA here, a plain member here (window covering today) and a DA of another department, unique emails (DA %s, member %s, other-dept DA %s)%s',
        coalesce(v_da, 'none'), coalesce(v_mem, 'none'), coalesce(v_xda, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_xda, v_xhome) ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;

      -- T1 the DA manages training (a session, a board meeting, a category, a drill plan)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok'; v_s := NULL; v_m := NULL;
      SELECT public.is_training_manager(), public.is_training_officer() INTO v_b, v_b2;
      BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience) VALUES (rec.dept_id, 'RETEST session', current_date, false, 'everyone') RETURNING id INTO v_s; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience, is_meeting) VALUES (rec.dept_id, 'RETEST board meeting', current_date + 7, false, 'board', true) RETURNING id INTO v_m; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN INSERT INTO public.training_plans (department_id, name, cadence, color) VALUES (rec.dept_id, 'RETEST category', 'Monthly', '#C8323A'); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST plan', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_b AND NOT v_b2 AND e1 = 'ok' AND e2 = 'ok' AND e3 = 'ok' AND e4 = 'ok' AND v_s IS NOT NULL AND v_m IS NOT NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 the DA (not a training officer) manages training: session + board meeting + category + drill plan%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 manager %s officer %s · session: %s · meeting: %s · category: %s · plan: %s%s', v_b, v_b2, e1, e2, e3, e4, chr(10)); END IF;

      -- T2 a plain member is refused
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok';
      SELECT public.is_training_manager() INTO v_b;
      BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience) VALUES (rec.dept_id, 'RETEST member session', current_date, false, 'everyone'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      UPDATE public.training_sessions SET title = 'RETEST hijack' WHERE id = v_s; GET DIAGNOSTICS v_n = ROW_COUNT;
      BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_mem_mid, now()); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN INSERT INTO public.training_plans (department_id, name, cadence, color) VALUES (rec.dept_id, 'RETEST member category', 'Monthly', '#C8323A'); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST member plan', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      e5 := 'ok'; BEGIN INSERT INTO public.training_officer (department_id, member_id) VALUES (rec.dept_id, v_mem_mid); EXCEPTION WHEN OTHERS THEN e5 := SQLERRM; END;
      e6 := 'ok'; BEGIN PERFORM public.assign_training_officer(v_mem_mid); EXCEPTION WHEN OTHERS THEN e6 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF NOT v_b AND e1 ILIKE '%row-level security%' AND v_n = 0 AND e2 ILIKE '%row-level security%' AND e3 ILIKE '%row-level security%'
         AND e4 = 'Only a Department Admin or training officer can manage drill plans.' AND e5 ILIKE '%row-level security%'
         AND e6 = 'Only a Department Admin can assign training officers.' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T2 plain member refused: schedule / roster / category / the registry itself by RLS, edit touches 0 rows, drill plan + self-assign by the RPCs%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 manager %s · session: %s · edit rows %s · roster: %s · category: %s · plan: %s · registry insert: %s · self-assign: %s%s', v_b, e1, v_n, e2, e3, e4, e5, e6, chr(10)); END IF;

      -- T3 the DA assigns the member (and again: the same row)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; v_r1 := NULL; v_r2 := NULL;
      BEGIN SELECT (public.assign_training_officer(v_mem_mid)).id INTO v_r1; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN SELECT (public.assign_training_officer(v_mem_mid)).id INTO v_r2; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'ok' AND e2 = 'ok' AND v_r1 IS NOT NULL AND v_r1 = v_r2
         AND (SELECT assigned_by = v_da_mid AND department_id = rec.dept_id AND removed_at IS NULL FROM public.training_officer WHERE id = v_r1)
         AND (SELECT count(*) FROM public.training_officer WHERE member_id = v_mem_mid AND removed_at IS NULL) = 1 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 DA assigns the member (stamped by the DA); assigning again returns the same row, one active%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 assign: %s / again: %s · rows %s / %s%s', e1, e2, v_r1, v_r2, chr(10)); END IF;

      -- T4 the member, now a training officer, gains every surface
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok'; e5 := 'ok';
      SELECT public.is_training_officer(), public.is_training_manager() INTO v_b, v_b2;
      BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience, is_meeting) VALUES (rec.dept_id, 'RETEST TO meeting', current_date + 3, false, 'leadership', true); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      UPDATE public.training_sessions SET title = 'RETEST session (edited by TO)' WHERE id = v_s; GET DIAGNOSTICS v_n = ROW_COUNT;
      BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (rec.dept_id, v_s, v_mem_mid, now()); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      DELETE FROM public.session_attendance WHERE session_id = v_s AND member_id = v_mem_mid; GET DIAGNOSTICS v_n2 = ROW_COUNT;
      BEGIN INSERT INTO public.training_plans (department_id, name, cadence, color) VALUES (rec.dept_id, 'RETEST TO category', 'Monthly', '#C8323A'); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST TO plan', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_b AND v_b2 AND e1 = 'ok' AND v_n = 1 AND e2 = 'ok' AND v_n2 = 1 AND e3 = 'ok' AND e4 = 'ok' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T4 the member as training officer: schedules a leadership meeting, edits the session, marks + clears the roster, adds a category, writes a drill plan%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 officer %s manager %s · meeting: %s · edit rows %s · roster: %s / cleared %s · category: %s · plan: %s%s', v_b, v_b2, e1, v_n, e2, v_n2, e3, e4, chr(10)); END IF;

      -- T5 removal revokes; repeat remove is a no-op; re-assign is a new row
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; v_r2 := NULL;
      BEGIN PERFORM public.remove_training_officer(v_mem_mid); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN SELECT (public.remove_training_officer(v_mem_mid)).id INTO v_r2; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      SELECT public.is_training_manager() INTO v_b;
      BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience) VALUES (rec.dept_id, 'RETEST after removal', current_date, false, 'everyone'); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      e4 := 'ok'; BEGIN PERFORM public.assign_training_officer(v_mem_mid); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'ok' AND e2 = 'ok' AND v_r2 IS NULL AND NOT v_b AND e3 ILIKE '%row-level security%' AND e4 = 'ok'
         AND (SELECT removed_by = v_da_mid AND removed_at IS NOT NULL FROM public.training_officer WHERE id = v_r1)
         AND (SELECT count(*) FROM public.training_officer WHERE member_id = v_mem_mid) = 2
         AND (SELECT count(*) FROM public.training_officer WHERE member_id = v_mem_mid AND removed_at IS NULL) = 1 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T5 remove revokes (stamped by the DA; scheduling refused again); a second remove returns NULL; re-assign adds a new row (2 rows, 1 active)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 remove: %s / again: %s (%s) · manager after %s · schedule: %s · re-assign: %s%s', e1, e2, v_r2, v_b, e3, e4, chr(10)); END IF;

      -- O1 a seeded Officer: manages until removed; then refused — but still opens a QR sign-in
      IF v_off IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  O1 — no Officer (non-DA) here%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok';
        SELECT public.is_training_officer() INTO v_b;
        BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience) VALUES (rec.dept_id, 'RETEST officer session', current_date, false, 'everyone'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
        PERFORM public.remove_training_officer(v_off_mid);
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience) VALUES (rec.dept_id, 'RETEST officer after', current_date, false, 'everyone'); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
        BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST officer plan', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
        BEGIN PERFORM public.open_signin(v_s); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_b AND e1 = 'ok' AND e2 ILIKE '%row-level security%' AND e3 = 'Only a Department Admin or training officer can manage drill plans.'
           AND e4 IS DISTINCT FROM 'You are not allowed to open a sign-in for this session.' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  O1 seeded Officer schedules; once removed: schedule refused (RLS), drill plan refused — QR sign-in still opens (%s)%s', CASE WHEN e4 = 'ok' THEN 'opened' ELSE 'not refused on authority: ' || left(e4, 60) END, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  O1 seeded %s · schedule: %s · after removal: %s · plan: %s · open_signin: %s%s', v_b, e1, e2, e3, e4, chr(10)); END IF;
      END IF;

      -- P1 a Project Admin: can't manage training; can appoint
      IF v_pa IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  P1 — no Project Admin (non-DA, non-Officer) here%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        e1 := 'ok'; e2 := 'ok'; e3 := 'ok';
        SELECT public.is_training_manager() INTO v_b;
        BEGIN INSERT INTO public.training_sessions (department_id, title, date, done, audience) VALUES (rec.dept_id, 'RETEST PA session', current_date, false, 'everyone'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
        BEGIN PERFORM public.remove_training_officer(v_mem_mid); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
        BEGIN PERFORM public.assign_training_officer(v_mem_mid); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF NOT v_b AND e1 ILIKE '%row-level security%' AND e2 = 'ok' AND e3 = 'ok'
           AND (SELECT count(*) FROM public.training_officer WHERE member_id = v_mem_mid AND removed_at IS NULL) = 1 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  P1 Project Admin: not a training manager (schedule refused) — but removes and appoints a training officer%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P1 manager %s · schedule: %s · remove: %s · assign: %s%s', v_b, e1, e2, e3, chr(10)); END IF;
      END IF;

      -- X1 another department's DA
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_xda, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; v_r2 := NULL;
      BEGIN PERFORM public.assign_training_officer(v_da_mid); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN SELECT (public.remove_training_officer(v_mem_mid)).id INTO v_r2; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      SELECT count(*) INTO v_n FROM public.training_officer WHERE department_id = rec.dept_id;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'That member is not an active member of your department.' AND e2 = 'ok' AND v_r2 IS NULL AND v_n = 0
         AND (SELECT count(*) FROM public.training_officer WHERE member_id = v_mem_mid AND removed_at IS NULL) = 1
         AND NOT EXISTS (SELECT 1 FROM public.training_officer WHERE member_id = v_da_mid) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X1 another department''s DA: assigning this department''s member refused; removing is a no-op (this department''s officer untouched); sees 0 of its officers%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 assign: %s · remove: %s (%s) · sees %s%s', e1, e2, v_r2, v_n, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
