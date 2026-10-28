-- =====================================================================
-- RETEST for l2_departments_scope. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Per department, the checks run inside a sub-block ending in RAISE 'SENTINEL' (rolled back). NOTHING CHANGES.
-- The final RAISE is the report — the "ERROR" IS the report.
-- Once:
--   O1 the SELECT policy is exactly SELECT / PERMISSIVE / {authenticated} / (id = my_department_id()); the UPDATE policy = its pin
--   O2 a signed-in stranger (no member row) reads 0 departments; anon is refused or reads 0
-- Per department (a REAL Department Admin and a REAL member, as authenticated):
--   T1 each reads exactly 1 departments row, and it is their own
--   T2 the brand / settings read the app makes (select … where id = my_department_id()) still returns their row
--   T3 the DA's no-op UPDATE of their own row touches 1 row; the member's touches 0 (the UPDATE policy, unchanged)
--   T4 the same person, the policy put back to USING (true) inside the rolled-back block, reads all departments again —
--      the policy (and only the policy) is what scopes the read
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_t text; v_n bigint; v_all bigint;
  d uuid; dn text; v_who text; v_email text; v_own uuid; v_ok boolean;
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  SELECT count(*) INTO v_all FROM public.departments;
  SELECT p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '') INTO v_t
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = 'signed in can read departments';
  IF v_t = 'SELECT|PERMISSIVE|{authenticated}|(id = my_department_id())|'
     AND (SELECT md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = 'DA can update own department') = '2f6bfaa802936dbce6fa83f7871a4a1a' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 SELECT policy = (id = my_department_id()) TO authenticated; UPDATE policy = its pin' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 departments policies not as intended: ' || coalesce(v_t, '(missing)') || chr(10); END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', 'l2-l4-stranger@invalid.test')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.departments;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := v_n = 0;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    SELECT count(*) INTO v_n FROM public.departments;
    EXECUTE 'RESET ROLE';
    v_ok := v_ok AND v_n = 0;
  EXCEPTION WHEN insufficient_privilege THEN EXECUTE 'RESET ROLE';
  END;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  O2 a signed-in stranger reads 0 of %s departments; anon refused / 0%s', v_all, chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 a stranger or anon can still read departments' || chr(10); END IF;

  FOR d, dn IN SELECT id, name FROM public.departments ORDER BY name LOOP
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
        IF v_who = 'DA' THEN SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_email; ELSE SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status = 'Active' AND NOT (coalesce(m.access, '{}') && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[])
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_email; END IF;
        IF v_email IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  no real %s in this department%s', v_who, chr(10)); CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*), max(id::text)::uuid INTO v_n, v_own FROM public.departments;
        EXECUTE 'RESET ROLE';
        IF v_n = 1 AND v_own = d THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 %s reads exactly 1 department: their own%s', v_who, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 %s reads %s departments (own: %s)%s', v_who, v_n, v_own = d, chr(10)); END IF;
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*) INTO v_n FROM public.departments WHERE id = public.my_department_id();
        EXECUTE 'RESET ROLE';
        IF v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T2 %s: the app''s own-department read returns their row%s', v_who, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 %s: the own-department read returned %s rows%s', v_who, v_n, chr(10)); END IF;
        EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.departments SET name = name WHERE id = d;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        EXECUTE 'RESET ROLE';
        IF v_n = (CASE WHEN v_who = 'DA' THEN 1 ELSE 0 END) THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 %s: no-op UPDATE of own department touches %s row(s), as before%s', v_who, v_n, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 %s: no-op UPDATE touched %s rows%s', v_who, v_n, chr(10)); END IF;
      END LOOP;
      -- T4: the policy back to USING (true) inside the rollback → the same DA reads every department again
      SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_email;
      IF v_email IS NOT NULL THEN
        ALTER POLICY "signed in can read departments" ON public.departments USING (true);
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*) INTO v_n FROM public.departments;
        EXECUTE 'RESET ROLE';
        IF v_n = v_all THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T4 with USING (true) put back (rolled back) the DA reads all %s — the policy is what scopes it%s', v_all, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 with USING (true) put back the DA reads %s of %s%s', v_n, v_all, chr(10)); END IF;
      END IF;
      PERFORM set_config('request.jwt.claims', '', true);
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
