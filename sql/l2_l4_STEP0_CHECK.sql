-- =====================================================================
-- SECURITY L-2 (scope departments reads) + L-4 (role-anywhere helpers) — STEP 0. READ-ONLY, one result set.
-- claude/B4C_L2_L4_Step0.md. Nothing here writes; no migration exists yet.
-- RAN on live 2026-10-28 (SQL editor, read-only) — 51 rows: docs/review/l2_l4_STEP0_OUTPUT.json; follow-up l2_l4_STEP0B_CHECK.sql → _STEP0B_OUTPUT.json.
-- Run in the Supabase SQL editor with "No limit", then paste or export the result back.
--   L2-1 every policy on public.departments (all commands), exact live expressions
--   L2-2 table grants on departments for anon / authenticated
--   L2-3 every FUNCTION that reads departments: DEFINER (unaffected by RLS) or INVOKER (would see only the caller's
--        own row once SELECT is scoped). Writes are flagged separately.
--   L2-4 every VIEW that reads departments, plus whether it's security_invoker
--   L2-5 every POLICY on another table whose expression reads departments (runs under the caller's RLS)
--   L2-6 the multi-department question: auth emails with member rows in >1 department (counts only, no emails),
--        and whether member_active_department holds any row (my_department_id() reads it)
--   L4-1 the gate helpers in full: is_department_admin, is_leadership, is_dept_admin, my_department_id,
--        my_member_id (md5, DEFINER/INVOKER, volatility, ACL, dept-scoped?)
--   L4-2 every POLICY that calls is_department_admin() / is_leadership(): expression + does it AND a department check
--   L4-3 every FUNCTION that calls either: DEFINER?, md5, does its body also compare a department, call excerpt
--   L4-4 every VIEW that calls either
-- =====================================================================
SELECT 1 AS ord, 'L2-1 departments policy' AS what, p.polname AS name,
       CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END
       || ' · ' || CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END
       || ' [' || array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (p.polroles)), ',') || ']'
       || CASE WHEN 0 = ANY (p.polroles) THEN ' [public]' ELSE '' END AS verdict,
       'USING ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '—') || ' | CHECK ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '—') AS detail
  FROM pg_policy p WHERE p.polrelid = 'public.departments'::regclass
UNION ALL
SELECT 2, 'L2-2 departments grant', r.rolname,
       concat_ws(',', CASE WHEN has_table_privilege(r.oid, 'public.departments', 'SELECT') THEN 'S' END,
                      CASE WHEN has_table_privilege(r.oid, 'public.departments', 'INSERT') THEN 'I' END,
                      CASE WHEN has_table_privilege(r.oid, 'public.departments', 'UPDATE') THEN 'U' END,
                      CASE WHEN has_table_privilege(r.oid, 'public.departments', 'DELETE') THEN 'D' END),
       'rows: ' || (SELECT count(*) FROM public.departments)::text || ' · RLS on: ' || (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.departments'::regclass)::text
  FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')
UNION ALL
SELECT 3, 'L2-3 fn reads departments', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
       || ' · writes: ' || (p.prosrc ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?departments\y')::text
       || ' · authenticated exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
       || ' · md5 ' || left(md5(pg_get_functiondef(p.oid)), 8),
       left(regexp_replace(substring(p.prosrc from '(?i).{0,160}\ydepartments\y.{0,200}'), '\s+', ' ', 'g'), 400)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
   AND p.prosrc ~* '\y(public\.)?departments\y'
UNION ALL
SELECT 4, 'L2-4 view reads departments', c.relname,
       'security_invoker: ' || coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'), 'false (owner rights)')
       || ' · authenticated select: ' || has_table_privilege('authenticated', c.oid, 'SELECT')::text,
       left(regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g'), 400)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
   AND pg_get_viewdef(c.oid) ~* '\y(public\.)?departments\y'
UNION ALL
SELECT 5, 'L2-5 policy reads departments', c.relname || ' · ' || p.polname,
       CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
       'USING ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '—') || ' | CHECK ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '—')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
 WHERE c.relnamespace = 'public'::regnamespace AND c.relname <> 'departments'
   AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~* '\y(public\.)?departments\y'
UNION ALL
SELECT 6, 'L2-6 multi-department', 'emails by department count',
       coalesce((SELECT string_agg(n || ' dept(s): ' || k || ' email(s)', ' · ' ORDER BY n)
                   FROM (SELECT n, count(*) AS k FROM (SELECT lower(email) e, count(DISTINCT department_id) n FROM public.members WHERE email IS NOT NULL GROUP BY 1) x GROUP BY n) y), '(none)'),
       'member_active_department rows: ' || coalesce((SELECT count(*)::text FROM public.member_active_department), '(table missing)')
UNION ALL
SELECT 7, 'L4-1 gate helper', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       'md5 ' || md5(pg_get_functiondef(p.oid)) || ' · ' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
       || ' · ' || CASE p.provolatile WHEN 's' THEN 'STABLE' WHEN 'i' THEN 'IMMUTABLE' ELSE 'VOLATILE' END
       || ' · dept-scoped: ' || (p.prosrc ~* 'department_id\s*=\s*(public\.)?my_department_id\(\)|my_member_id\(\)')::text
       || ' · acl ' || coalesce(p.proacl::text, '(default)'),
       pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('is_department_admin', 'is_leadership', 'is_dept_admin', 'my_department_id', 'my_member_id')
UNION ALL
SELECT 8, 'L4-2 policy uses helper', c.relname || ' · ' || p.polname,
       CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END
       || ' · calls: ' || concat_ws('+',
            CASE WHEN e ~* 'is_department_admin\(' THEN 'is_department_admin' END,
            CASE WHEN e ~* 'is_leadership\(' THEN 'is_leadership' END)
       || ' · ANDs dept: ' || (e ~* 'department_id\s*=\s*(public\.)?my_department_id\(\)|my_department_id\(\)\s*=')::text,
       e
  FROM (SELECT p.*, 'USING ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '—') || ' | CHECK ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '—') AS e
          FROM pg_policy p) p JOIN pg_class c ON c.oid = p.polrelid
 WHERE c.relnamespace = 'public'::regnamespace AND e ~* 'is_department_admin\(|is_leadership\('
UNION ALL
SELECT 9, 'L4-3 fn uses helper', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
       || ' · calls: ' || concat_ws('+',
            CASE WHEN p.prosrc ~* 'is_department_admin\(' THEN 'is_department_admin' END,
            CASE WHEN p.prosrc ~* 'is_leadership\(' THEN 'is_leadership' END)
       || ' · body compares dept: ' || (p.prosrc ~* 'department_id\s*(=|<>|!=|is distinct from)|my_department_id\(\)')::text
       || ' · md5 ' || left(md5(pg_get_functiondef(p.oid)), 8),
       left(regexp_replace(substring(p.prosrc from '(?i).{0,240}is_(?:department_admin|leadership)\(.{0,240}'), '\s+', ' ', 'g'), 600)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
   AND p.proname NOT IN ('is_department_admin', 'is_leadership')
   AND p.prosrc ~* 'is_department_admin\(|is_leadership\('
UNION ALL
SELECT 10, 'L4-4 view uses helper', c.relname, 'security_invoker: ' || coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'), 'false'),
       left(regexp_replace(pg_get_viewdef(c.oid), '\s+', ' ', 'g'), 400)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
   AND pg_get_viewdef(c.oid) ~* 'is_department_admin\(|is_leadership\('
ORDER BY 1, 3;
