-- =====================================================================
-- RLS ADMIN-GATE FIX (punch-list P1 #3a) — Review PASS 2026-10-20 (d486d24).
-- APPLIED on live 2026-10-20 — state check clean: fixed 4 · role_anywhere_left 0 · total_policies 169 · locked_token_fns 17.
-- Record: claude/B4C_RLS_AdminGate_Fix_ReviewRecord.md.
-- Order: claude/B4C_RLS_AdminGate_Fix_BuildOrder.md. Off the live Step 0 / 0c (ff374b7) and Steps A/B (live 2026-10-20,
-- docs/review/rls_admin_gate_STEP_AB_OUTPUT.md): is_dept_admin() department-scoped (md5 c692e44f…); the four policy
-- expressions exactly as pinned below; PA cross-department writes all go through pa_* RPCs (pa_create_department,
-- pa_set_disabled_modules, pa_set_geofence_enabled); both Project Admins hold PA access on their only department row
-- -> the PLAIN swap on departments; blast radius today 0 (no one is an admin in one department and a plain member of
-- another) — the gap is latent, closed before anyone can use it.
--
-- THE GAP: four write policies scope the ROW to the caller's current department but take the ADMIN ROLE from
-- is_department_admin(), which is true for a DA / PA of ANY department. A DA of dept A who is a plain member of dept B
-- can, with B active, write B's announcements (UPDATE / DELETE), B's departments row (UPDATE) and B's duty_log (UPDATE).
--
-- THE FIX: in each of the four, the is_department_admin() token becomes is_dept_admin() — department-scoped on live
-- (its body filters members.department_id = my_department_id(), roles exactly {Project Admin, Department Admin};
-- re-pinned below, so this refuses if that ever drifts). Everything else in each policy — the department predicate,
-- the announcements author branch, the policy name, command and roles — is unchanged (ALTER POLICY keeps the roles).
--
-- departments: the PLAIN SWAP (no PA branch) — it changes no Project Admin's behaviour ONLY IF every PA holds PA
-- access on each of their department rows (Step B2). That rule is a hard precondition here: if any PA has a row
-- without PA access, this refuses and the PA branch ((id = my_department_id() AND is_dept_admin()) OR
-- is_project_admin()) is the one to apply instead. PA cross-department settings already go through pa_* RPCs.
--
-- Single all-or-nothing DO block; refuses a second apply (the old expressions must be present exactly). Every other
-- policy byte-identical; total_policies 169 and the locked-token function count 17 unchanged; RLS + client grants on
-- the three tables unchanged. The locked verification column is never touched. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  -- the live is_dept_admin() body (Step 0 2026-10-19; Step A 2026-10-20, md5 c692e44f…), whitespace-normalised — the
  -- md5 pin below catches ANY drift; this text pin says which part matters (members.department_id = my_department_id())
  DA_BODY constant text := 'select exists ( select 1 from public.members where lower(members.email) = lower(auth.email()) and members.status in (''Active'',''Probationary'') and members.department_id = public.my_department_id() and members.access && array[''Project Admin'',''Department Admin'']::text[] );';
  -- the four policies: table, name, cmd, USING before, CHECK before (NULL = none), USING after, CHECK after
  T text[][] := array[
    array['announcements', 'author or dept admin update announcements', 'w',
          '((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()))',
          '((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()))',
          '((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_dept_admin()))',
          '((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_dept_admin()))'],
    array['announcements', 'author or dept admin delete announcements', 'd',
          '((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()))', NULL,
          '((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_dept_admin()))', NULL],
    array['departments', 'DA can update own department', 'w',
          '((id = my_department_id()) AND is_department_admin())',
          '((id = my_department_id()) AND is_department_admin())',
          '((id = my_department_id()) AND is_dept_admin())',
          '((id = my_department_id()) AND is_dept_admin())'],
    array['duty_log', 'dept admins edit duty_log', 'w',
          '(is_department_admin() AND (department_id = my_department_id()))',
          '(is_department_admin() AND (department_id = my_department_id()))',
          '(is_dept_admin() AND (department_id = my_department_id()))',
          '(is_dept_admin() AND (department_id = my_department_id()))']];
  i int; v_q text; v_c text; v_pol_before text; v_pol_after text; v_total_before int; v_tok_before int;
  v_grants_before text; v_grants_after text;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF btrim(regexp_replace(substring(pg_get_functiondef('public.is_dept_admin()'::regprocedure) from 'AS \$[a-z]*\$(.*)\$[a-z]*\$'), '\s+', ' ', 'g')) <> DA_BODY THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is not the department-scoped body this fix relies on. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) <> 'c692e44f62923d2bf4c1a39a21a87bf7' THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is not the Step A version (md5 c692e44f…). Nothing changed.';
  END IF;
  IF to_regprocedure('public.is_department_admin()') IS NULL OR to_regprocedure('public.my_department_id()') IS NULL OR to_regprocedure('public.my_member_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: a helper is missing. Nothing changed.';
  END IF;
  FOR i IN 1 .. array_length(T, 1) LOOP
    SELECT pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid) INTO v_q, v_c
      FROM pg_policy p WHERE p.polrelid = ('public.' || T[i][1])::regclass AND p.polname = T[i][2] AND p.polcmd = T[i][3]::"char";
    IF NOT FOUND THEN RAISE EXCEPTION 'Precondition failed: policy "%" on % is missing. Nothing changed.', T[i][2], T[i][1]; END IF;
    IF v_q IS NOT DISTINCT FROM T[i][6] AND v_c IS NOT DISTINCT FROM T[i][7] THEN
      RAISE EXCEPTION 'Precondition failed: "%" on % is already fixed — already applied. Nothing changed.', T[i][2], T[i][1];
    END IF;
    IF v_q IS DISTINCT FROM T[i][4] OR v_c IS DISTINCT FROM T[i][5] THEN
      RAISE EXCEPTION 'Precondition failed: "%" on % is not the Step 0c expression (found USING % | CHECK %). Nothing changed.', T[i][2], T[i][1], v_q, v_c;
    END IF;
  END LOOP;
  -- departments takes the plain swap only if no Project Admin is a plain member anywhere (Step B2's rule)
  IF EXISTS (SELECT 1 FROM public.members m
              WHERE lower(m.email) IN (SELECT lower(x.email) FROM public.members x WHERE x.email IS NOT NULL AND x.access && array['Project Admin']::text[])
                AND NOT coalesce(m.access && array['Project Admin']::text[], false)) THEN
    RAISE EXCEPTION 'Precondition failed: a Project Admin has a department row without PA access — the plain swap on departments would cut their reach there. Apply the PA-branch variant instead. Nothing changed.';
  END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies
   WHERE schemaname = 'public' AND NOT (tablename, policyname) IN (SELECT T[k][1], T[k][2] FROM generate_subscripts(T, 1) k);
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;
  SELECT string_agg(tb || ':' || has_table_privilege('authenticated', 'public.' || tb, 'INSERT')::text || has_table_privilege('authenticated', 'public.' || tb, 'UPDATE')::text
                    || has_table_privilege('authenticated', 'public.' || tb, 'DELETE')::text || (SELECT relrowsecurity::text FROM pg_class WHERE oid = ('public.' || tb)::regclass), ',' ORDER BY tb)
    INTO v_grants_before FROM unnest(array['announcements', 'departments', 'duty_log']) tb;

  -- ---------------------------------------------------------------- the change (role half only)
  ALTER POLICY "author or dept admin update announcements" ON public.announcements
    USING ((department_id = public.my_department_id()) AND ((author_id = public.my_member_id()) OR public.is_dept_admin()))
    WITH CHECK ((department_id = public.my_department_id()) AND ((author_id = public.my_member_id()) OR public.is_dept_admin()));
  ALTER POLICY "author or dept admin delete announcements" ON public.announcements
    USING ((department_id = public.my_department_id()) AND ((author_id = public.my_member_id()) OR public.is_dept_admin()));
  ALTER POLICY "DA can update own department" ON public.departments
    USING ((id = public.my_department_id()) AND public.is_dept_admin())
    WITH CHECK ((id = public.my_department_id()) AND public.is_dept_admin());
  ALTER POLICY "dept admins edit duty_log" ON public.duty_log
    USING (public.is_dept_admin() AND (department_id = public.my_department_id()))
    WITH CHECK (public.is_dept_admin() AND (department_id = public.my_department_id()));

  -- ---------------------------------------------------------------- post-conditions
  FOR i IN 1 .. array_length(T, 1) LOOP
    SELECT pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid) INTO v_q, v_c
      FROM pg_policy p WHERE p.polrelid = ('public.' || T[i][1])::regclass AND p.polname = T[i][2] AND p.polcmd = T[i][3]::"char";
    IF v_q IS DISTINCT FROM T[i][6] OR v_c IS DISTINCT FROM T[i][7] THEN
      RAISE EXCEPTION 'Post-condition failed: "%" on % reads USING % | CHECK % (expected the department-scoped gate).', T[i][2], T[i][1], v_q, v_c;
    END IF;
    IF position('is_department_admin' in coalesce(v_q, '') || coalesce(v_c, '')) > 0 THEN
      RAISE EXCEPTION 'Post-condition failed: "%" still uses the role-anywhere gate.', T[i][2];
    END IF;
  END LOOP;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies
   WHERE schemaname = 'public' AND NOT (tablename, policyname) IN (SELECT T[k][1], T[k][2] FROM generate_subscripts(T, 1) k);
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: another policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: the policy count changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
  SELECT string_agg(tb || ':' || has_table_privilege('authenticated', 'public.' || tb, 'INSERT')::text || has_table_privilege('authenticated', 'public.' || tb, 'UPDATE')::text
                    || has_table_privilege('authenticated', 'public.' || tb, 'DELETE')::text || (SELECT relrowsecurity::text FROM pg_class WHERE oid = ('public.' || tb)::regclass), ',' ORDER BY tb)
    INTO v_grants_after FROM unnest(array['announcements', 'departments', 'duty_log']) tb;
  IF v_grants_after IS DISTINCT FROM v_grants_before THEN RAISE EXCEPTION 'Post-condition failed: RLS or a client grant changed on the three tables.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: fixed 4 · role_anywhere_left 0 · total_policies 169 · locked-token fns 17)
SELECT
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid IN ('public.announcements'::regclass, 'public.departments'::regclass, 'public.duty_log'::regclass)
     AND p.polcmd IN ('w', 'd') AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'is_dept_admin\(\)') AS fixed,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid IN ('public.announcements'::regclass, 'public.departments'::regclass, 'public.duty_log'::regclass)
     AND p.polcmd IN ('w', 'd') AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ 'is_department_admin') AS role_anywhere_left,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
