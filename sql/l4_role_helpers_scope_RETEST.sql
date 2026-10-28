-- =====================================================================
-- RETEST for l4_role_helpers_scope. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Per department, the checks run inside a sub-block ending in RAISE 'SENTINEL' (rolled back). NOTHING CHANGES.
-- The final RAISE is the report — the "ERROR" IS the report.
-- Once:
--   S0 the three bodies are the generated text; STABLE / DEFINER / search_path / ACL as captured; is_equipment_manager and
--      is_project_admin unchanged
-- Per department (a REAL Department Admin; a REAL Officer / Board Member if there is one; a REAL plain member):
--   H1 at home: each person's three answers = what their own access list says against each helper's role set (a DA:
--      all true · an Officer: leadership + announcer · a Board Member: leadership only · a member: none) — the same
--      answers the migration proved unchanged for everyone.
--   X1 THE FIX: the DA given a plain member row in ANOTHER department (synthesized inside the rollback) and switched
--      there (member_active_department): all three false; the leadership-gated RPC dept_on_station_now() refuses
--      ("Not authorized"); training_session_audit reads 0 — then switched back home: all three true again.
--      (If the synthetic row can't be inserted — a members constraint / trigger — X1 is SKIPPED with the reason; the
--      PGlite dry run is then the proof.)
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_t text; v_n bigint; v_ok boolean;
  d uuid; dn text; v_da text; v_off text; v_mem text; v_other uuid; v_mid uuid; v_refused boolean; v_acc text[];
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  v_ok := true;
  v_ok := v_ok AND (SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_leadership' AND p.prokind = 'f') = '
  -- L-4: the department-scoped leadership gate. Same roles + status as before, now only in the caller''s own department
  -- (my_department_id()); that is exactly is_leader(), so it delegates — one definition, no drift. Callers unchanged.
  select public.is_leader();
' AND (SELECT p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_leadership' AND p.prokind = 'f') = 'true|s|{search_path=public}|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  v_ok := v_ok AND (SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_department_admin' AND p.prokind = 'f') = '
  -- L-4: the department-scoped admin gate (Department Admin or Project Admin, in the caller''s own department). That is
  -- exactly is_dept_admin(), so it delegates — one definition, no drift. Callers unchanged.
  select public.is_dept_admin();
' AND (SELECT p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_department_admin' AND p.prokind = 'f') = 'true|s|{search_path=public}|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  v_ok := v_ok AND (SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_announcer' AND p.prokind = 'f') = '
  select exists (
    select 1 from public.members
    where lower(email) = lower(auth.email())
      and status in (''Active'',''Probationary'')
      and department_id = public.my_department_id()   -- L-4: the role counts only in the caller''s own department
      and access && array[''Department Admin'',''Project Admin'',''Officer'']::text[]
  );
' AND (SELECT p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_announcer' AND p.prokind = 'f') = 'true|s|{search_path=public}|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  v_ok := v_ok AND (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_equipment_manager' AND p.prokind = 'f') = 'a979933dac145e88d58331a04d6c918a' AND (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_project_admin' AND p.prokind = 'f') = 'c9ccab22952488726207085155d7fdef';
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 the three helpers are the generated department-scoped bodies; attributes + ACL as captured; is_equipment_manager / is_project_admin unchanged' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S0 a helper body / attribute / ACL is not as intended' || chr(10); END IF;

  FOR d, dn IN SELECT id, name FROM public.departments ORDER BY name LOOP
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_da;
      SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status = 'Active' AND NOT (coalesce(m.access, '{}') && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[])
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_mem;
      SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary')
         AND m.access && array['Officer', 'Board Member']::text[] AND NOT (m.access && array['Department Admin', 'Project Admin']::text[])
         AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      -- H1
      FOR v_t, v_n IN SELECT * FROM (VALUES ('DA', 1), ('officer', 2), ('member', 3)) z LOOP
        CONTINUE WHEN (v_n = 1 AND v_da IS NULL) OR (v_n = 2 AND v_off IS NULL) OR (v_n = 3 AND v_mem IS NULL);
        SELECT coalesce(m.access, '{}') INTO v_acc FROM public.members m WHERE lower(m.email) = CASE v_n WHEN 1 THEN v_da WHEN 2 THEN v_off ELSE v_mem END AND m.department_id = d;
        PERFORM set_config('request.jwt.claims', json_build_object('email', CASE v_n WHEN 1 THEN v_da WHEN 2 THEN v_off ELSE v_mem END)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        v_ok := (public.is_leadership(), public.is_department_admin(), public.is_announcer())
              = (v_acc && array['Project Admin','Department Admin','Board Member','Officer']::text[], v_acc && array['Project Admin','Department Admin']::text[], v_acc && array['Department Admin','Project Admin','Officer']::text[]);
        EXECUTE 'RESET ROLE';
        IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  H1 %s at home: leadership / admin / announcer as their role says%s', v_t, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  H1 %s at home: wrong helper answer%s', v_t, chr(10)); END IF;
      END LOOP;
      IF v_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || '   SKIP  X1 no real Department Admin here' || chr(10);
      ELSE
        SELECT id INTO v_other FROM public.departments WHERE id <> d ORDER BY id LIMIT 1;
        BEGIN
          INSERT INTO public.members (department_id, email, name, access, status) VALUES (v_other, v_da, 'L-4 RETEST second department', '{Member}', 'Active') RETURNING id INTO v_mid;
          INSERT INTO public.member_active_department (email, department_id) VALUES (v_da, v_other) ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_da)::text, true);
          EXECUTE 'SET LOCAL ROLE authenticated';
          v_ok := public.my_department_id() = v_other AND NOT public.is_leadership() AND NOT public.is_department_admin() AND NOT public.is_announcer();
          v_refused := false;
          BEGIN PERFORM * FROM public.dept_on_station_now(); EXCEPTION WHEN OTHERS THEN v_refused := SQLERRM ILIKE '%not authorized%'; END;
          SELECT count(*) INTO v_n FROM public.training_session_audit;
          EXECUTE 'RESET ROLE';
          IF v_ok AND v_refused AND v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  X1 the DA acting in another department (plain member there): all three helpers false, dept_on_station_now refused, training_session_audit 0' || chr(10);
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 acting elsewhere: helpers-false %s, refused %s, audit rows %s%s', v_ok, v_refused, v_n, chr(10)); END IF;
          UPDATE public.member_active_department SET department_id = d WHERE email = v_da;
          EXECUTE 'SET LOCAL ROLE authenticated';
          v_ok := public.my_department_id() = d AND public.is_leadership() AND public.is_department_admin() AND public.is_announcer();
          EXECUTE 'RESET ROLE';
          IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  X1 back home: all three true again' || chr(10);
          ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  X1 back home: a helper is still false' || chr(10); END IF;
        EXCEPTION WHEN OTHERS THEN
          EXECUTE 'RESET ROLE';
          v_skip := v_skip + 1; rpt := rpt || format('   SKIP  X1 could not synthesize the second membership: %s%s', SQLERRM, chr(10));
        END;
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
