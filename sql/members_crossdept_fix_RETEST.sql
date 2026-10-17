-- =====================================================================
-- RETEST for members_crossdept_fix_DRAFT.sql. Run AFTER the fix, separately. NOTHING CHANGES — every write is inside a
-- sub-block ending in RAISE 'SENTINEL' (rolled back); the final RAISE is the report. The "ERROR" IS the report.
-- Once: both members write policies carry my_department_id().
-- For each department A with a leader (is_leader() true, not a Project Admin) with a unique email, signed in as them:
--   F1 INSERT a member into another department B   -> refused (row-level security)
--   F2 INSERT a member into A (own)                 -> still allowed (Roster "Add member" keeps working)
--   F3 DELETE a member of B                          -> 0 rows
--   F4 DELETE the member they just inserted into A  -> 1 row (own-department delete keeps working)
-- DRY RUN 2026-10-17 — PGlite mock with the live policy names/expressions: BEFORE the fix 6 passed / 3 failed (F1 cross-
-- department insert allowed in both departments + the scope check); AFTER 9 passed / 0 failed. Fix mutations caught:
-- INSERT left open -> post-condition rolls back · another policy changed -> rolls back · a second INSERT policy present ->
-- refused before any change · re-run after success -> refused by the guard.
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_n int; v_err text; v_leader text; v_victim uuid; v_bdept uuid; v_new uuid;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  IF (SELECT bool_and(position('my_department_id()' in coalesce(qual, with_check)) > 0) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'members' AND cmd IN ('INSERT', 'DELETE')) THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  members INSERT + DELETE policies are department-scoped%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  a members write policy lacks my_department_id()%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    v_leader := NULL; v_victim := NULL; v_bdept := NULL;
    SELECT lower(m.email) INTO v_leader FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.email IS NOT NULL AND NOT coalesce(m.access && array['Project Admin']::text[], false)
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
       AND m.access && array['Department Admin','Board Member','Officer','Training Officer']::text[]
     ORDER BY m.id LIMIT 1;
    SELECT m.id, m.department_id INTO v_victim, v_bdept FROM public.members m WHERE m.department_id <> rec.dept_id ORDER BY m.id LIMIT 1;
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    IF v_leader IS NULL OR v_victim IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  no leader with a unique email / no other department%s', chr(10)); CONTINUE; END IF;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_leader, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      IF NOT public.is_leader() THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  %s is not a leader by the live is_leader()%s', v_leader, chr(10));
        RAISE EXCEPTION 'SENTINEL';
      END IF;
      BEGIN INSERT INTO public.members (department_id, name, email, access, status)
            VALUES (v_bdept, 'RETEST cross-dept', 'retest-' || gen_random_uuid() || '@probe.invalid', array['Member'], 'Active'); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err ILIKE '%row-level security%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F1 insert into another department refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F1 -> "%s"%s', v_err, chr(10)); END IF;
      BEGIN INSERT INTO public.members (department_id, name, email, access, status)
            VALUES (rec.dept_id, 'RETEST own-dept', 'retest-' || gen_random_uuid() || '@probe.invalid', array['Member'], 'Active') RETURNING id INTO v_new; v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err = 'OK' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F2 insert into own department still allowed%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F2 -> "%s"%s', v_err, chr(10)); END IF;
      BEGIN DELETE FROM public.members WHERE id = v_victim; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F3 delete in another department: 0 rows%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F3 -> %s rows "%s"%s', v_n, v_err, chr(10)); END IF;
      IF v_new IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  F4 — nothing inserted to delete%s', chr(10));
      ELSE
        BEGIN DELETE FROM public.members WHERE id = v_new; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
        IF v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  F4 delete in own department still works%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  F4 -> %s rows "%s"%s', v_n, v_err, chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
