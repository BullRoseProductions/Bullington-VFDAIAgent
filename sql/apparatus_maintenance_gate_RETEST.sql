-- =====================================================================
-- RETEST for apparatus_maintenance_gate_2026-10-18.sql (the apparatus_maintenance UPDATE policy -> DA / Officer only). Run AFTER the
-- RAN on live 2026-10-18: 14 passed, 0 failed, 4 skipped — IH / Lipan / NH: M1 M2 M3 M5 pass; M4 passes in NH, skipped in
-- IH + Lipan (no Board Member with a unique email); Demo + Granbury skip all (no plain member).
-- migration, separately. NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL'
-- (rolled back), on a FIXTURE rig + maintenance task it creates itself. The final RAISE is the report.
-- The "ERROR" IS the report.
--   G0 (once) exactly one apparatus_maintenance UPDATE policy, department AND is_canmanage_ops(); the old one gone;
--      the 2026-10-18 apparatus fix still in place
-- Per department (needs a DA and a plain member with unique emails; Officer / Board Member / another department's DA
-- used when present, else that check SKIPs):
--   M1 a MEMBER's direct UPDATE of a maintenance task changes nothing (task, cadence, last_done_at: 0 rows)
--   M2 the DA's Mark done works end to end (the log INSERT + the last_done_at UPDATE — the app's exact two writes) and
--      the task edit works (1 row each)
--   M3 an Officer's edit works (1 row)        M4 a Board Member's edit changes nothing (0 rows)
--   M5 another department's DA can't edit this department's task (0 rows)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_n int; v_k int; v_rig uuid; v_task uuid; v_now timestamptz := now();
  v_da text; v_off text; v_board text; v_a text; v_other_da text; v_da_id uuid;
  v_before record; v_after record;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- G0
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND cmd IN ('UPDATE', 'ALL')) = 1
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND policyname = 'ops update apparatus_maintenance'
                   AND position('my_department_id()' in qual) > 0 AND position('is_canmanage_ops()' in qual) > 0
                   AND position('my_department_id()' in with_check) > 0 AND position('is_canmanage_ops()' in with_check) > 0)
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND policyname = 'members update apparatus_maintenance')
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'ops update apparatus') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  G0 one maintenance UPDATE policy: department AND is_canmanage_ops(); member-wide one gone; apparatus fix kept%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  G0 apparatus_maintenance UPDATE policies are not as expected%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_board := NULL; v_a := NULL; v_other_da := NULL; v_da_id := NULL;
    SELECT lower(m.email), m.id INTO v_da, v_da_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_board FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Board Member']::text[]
       AND NOT m.access && array['Department Admin','Project Admin','Officer']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_a FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_da FROM public.members m WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and a plain member with unique emails (DA %s, member %s)%s', coalesce(v_da, 'none'), coalesce(v_a, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- fixture (owner inserts): a rig + a maintenance task
      INSERT INTO public.apparatus (department_id, name, type, status, in_service, note)
      VALUES (rec.dept_id, 'RETEST rig', 'Pumper', 'Pass', true, 'RETEST fixture') RETURNING id INTO v_rig;
      INSERT INTO public.apparatus_maintenance (department_id, rig_id, task, cadence, last_done_at)
      VALUES (rec.dept_id, v_rig, 'RETEST oil change', 'Quarterly', NULL) RETURNING id INTO v_task;

      -- M1 a member changes nothing
      SELECT task, cadence, last_done_at INTO v_before FROM public.apparatus_maintenance WHERE id = v_task;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_k := 0;
      BEGIN UPDATE public.apparatus_maintenance SET task = 'hijacked' WHERE id = v_task; GET DIAGNOSTICS v_n = ROW_COUNT; v_k := v_k + v_n; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN UPDATE public.apparatus_maintenance SET cadence = 'Annual' WHERE id = v_task; GET DIAGNOSTICS v_n = ROW_COUNT; v_k := v_k + v_n; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN UPDATE public.apparatus_maintenance SET last_done_at = now() WHERE id = v_task; GET DIAGNOSTICS v_n = ROW_COUNT; v_k := v_k + v_n; EXCEPTION WHEN OTHERS THEN NULL; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT task, cadence, last_done_at INTO v_after FROM public.apparatus_maintenance WHERE id = v_task;
      IF v_k = 0 AND v_after.task = v_before.task AND v_after.cadence = v_before.cadence AND v_after.last_done_at IS NOT DISTINCT FROM v_before.last_done_at THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  M1 a member''s direct UPDATE changes nothing (task / cadence / last_done_at: 0 rows)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M1 member updated %s row(s); task %s cadence %s last_done %s%s', v_k, v_after.task, v_after.cadence, v_after.last_done_at, chr(10)); END IF;

      -- M2 the DA's Mark done (the app's two writes) + edit
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN
        INSERT INTO public.apparatus_maintenance_log (department_id, maintenance_id, apparatus_id, task, done_at, done_by, done_by_name, notes, cost)
        VALUES (rec.dept_id, v_task, v_rig, 'RETEST oil change', v_now, v_da_id, 'RETEST', NULL, NULL);
        UPDATE public.apparatus_maintenance SET last_done_at = v_now WHERE id = v_task; GET DIAGNOSTICS v_n = ROW_COUNT;
        UPDATE public.apparatus_maintenance SET task = 'RETEST oil + filter', cadence = 'Annual' WHERE id = v_task; GET DIAGNOSTICS v_k = ROW_COUNT;
        v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; v_k := NULL; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err = 'OK' AND v_n = 1 AND v_k = 1 AND (SELECT last_done_at FROM public.apparatus_maintenance WHERE id = v_task) = v_now
         AND (SELECT task FROM public.apparatus_maintenance WHERE id = v_task) = 'RETEST oil + filter' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  M2 the DA''s Mark done (log + reset) and edit both work%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M2 DA -> "%s" reset rows %s edit rows %s%s', v_err, v_n, v_k, chr(10)); END IF;

      -- M3 Officer
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  M3 — no Officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN UPDATE public.apparatus_maintenance SET cadence = 'Quarterly' WHERE id = v_task; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' AND v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  M3 an Officer''s edit works (1 row)%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M3 Officer -> "%s" rows %s%s', v_err, v_n, chr(10)); END IF;
      END IF;

      -- M4 Board Member
      IF v_board IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  M4 — no Board Member with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_board, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN UPDATE public.apparatus_maintenance SET task = 'board try' WHERE id = v_task; GET DIAGNOSTICS v_n = ROW_COUNT; EXCEPTION WHEN OTHERS THEN v_n := 0; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  M4 a Board Member''s edit changes nothing (0 rows)%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M4 Board updated %s row(s)%s', v_n, chr(10)); END IF;
      END IF;

      -- M5 another department's DA
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  M5 — no other-department DA%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN UPDATE public.apparatus_maintenance SET task = 'cross-dept' WHERE id = v_task; GET DIAGNOSTICS v_n = ROW_COUNT; EXCEPTION WHEN OTHERS THEN v_n := 0; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_n = 0 AND (SELECT task FROM public.apparatus_maintenance WHERE id = v_task) = 'RETEST oil + filter' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  M5 another department''s DA can''t edit this task (0 rows)%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M5 cross-dept updated %s row(s)%s', v_n, chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
