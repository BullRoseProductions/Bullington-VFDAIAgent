-- =====================================================================
-- SECURITY L-2 + L-4 — LIVE CAPTURE for the generator (docs/review/l2_l4_build.mjs). READ-ONLY, one row, one jsonb.
-- Output → docs/review/l2_l4_LIVEDEFS.json. No member data beyond counts.
--   counts           · public function / policy counts, verified presence, departments rows, multi-department emails
--   departments      · RLS / FORCE / owner, and every policy on it (full definition + md5 pin)
--   fns              · the gate helpers in full: def, md5(def), ACL, DEFINER, volatility, config
--   role_helper_sweep· every public is_*() boolean helper that reads members.access: does it scope to a department?
--   matrices         · md5 of authenticated / service_role table privileges; EXECUTE matrices (anon / authenticated / service_role)
--   rels             · every public relation authenticated may SELECT (the row-count proof reads all of them)
-- =====================================================================
WITH g AS (SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
            AND p.proname IN ('my_department_id', 'my_member_id', 'is_dept_admin', 'is_department_admin', 'is_leadership',
                              'is_equipment_manager', 'is_leader', 'is_training_manager', 'is_project_admin', 'is_announcer'))
SELECT jsonb_pretty(jsonb_build_object(
  'read_at', now()::date::text,
  'source', 'live ifeptqnlucmvhlvadcpj, read-only',
  'server_version', current_setting('server_version'),
  'counts', jsonb_build_object(
    'fns',        (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
    'policies',   (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'verified',   (SELECT count(*) FROM public.station_presence WHERE verified),
    'departments',(SELECT count(*) FROM public.departments),
    'multi_dept_emails', (SELECT count(*) FROM (SELECT lower(email) FROM public.members WHERE email IS NOT NULL GROUP BY 1 HAVING count(DISTINCT department_id) > 1) x)),
  'departments', jsonb_build_object(
    'rls',   (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.departments'::regclass),
    'force', (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.departments'::regclass),
    'owner', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.departments'::regclass),
    'policies', (SELECT jsonb_agg(jsonb_build_object(
        'name', p.policyname, 'cmd', p.cmd, 'permissive', p.permissive, 'roles', p.roles::text, 'qual', p.qual, 'with_check', p.with_check,
        'md5', md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))
      ) ORDER BY p.policyname) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments')),
  'fns', (SELECT jsonb_object_agg(g.proname, jsonb_build_object(
      'def', pg_get_functiondef(g.oid), 'md5', md5(pg_get_functiondef(g.oid)), 'acl', p.proacl::text,
      'secdef', p.prosecdef, 'volatile', p.provolatile::text, 'config', p.proconfig::text, 'args', pg_get_function_identity_arguments(g.oid)))
    FROM g JOIN pg_proc p ON p.oid = g.oid),
  'role_helper_sweep', (SELECT jsonb_agg(jsonb_build_object(
      'name', p.proname, 'md5', left(md5(pg_get_functiondef(p.oid)), 8),
      'dept_scoped', (p.prosrc ~* 'department_id\s*=\s*(public\.)?my_department_id\(\)|my_member_id\(\)|is_dept_admin\(\)'),
      'src', regexp_replace(p.prosrc, '\s+', ' ', 'g')) ORDER BY p.proname)
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname LIKE 'is\_%'
      AND p.prorettype = 'boolean'::regtype AND p.prosrc ~* '\yaccess\y'),
  'matrices', jsonb_build_object(
    'auth_tables', (SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type))
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 'authenticated'::regrole),
    'service_tables', (SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type))
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 'service_role'::regrole),
    'exec', (SELECT jsonb_object_agg(r, (SELECT md5(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text))
                                           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND has_function_privilege(r, p.oid, 'EXECUTE')))
             FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r)),
  'rels', (SELECT jsonb_agg(c.relname ORDER BY c.relname) FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm') AND has_table_privilege('authenticated', c.oid, 'SELECT'))
)) AS capture;
