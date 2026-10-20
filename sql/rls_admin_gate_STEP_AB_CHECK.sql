-- =====================================================================
-- RLS ADMIN-GATE FIX — Steps A + B (claude/B4C_RLS_AdminGate_Fix_BuildOrder.md). READ-ONLY, one result set.
--   A1 the live gate functions in full (is_dept_admin, is_department_admin, is_project_admin, my_department_id) + md5,
--      and a parsed verdict: department-scoped? exactly {Department Admin, Project Admin}?
--   A2 the three policies' exact live expressions (the draft pins these as preconditions)
--   B1 every function that writes departments (UPDATE / INSERT) — security, gate tokens, members exec — is the PA
--      cross-department path an RPC?
--   B2 Project Admin member rows: per PA (email shown as a short hash), each department row, its access and status —
--      would a PA still pass a department-scoped gate in each department they're a member of?
--   B3 the blast radius: people who are DA / PA in one department and a NON-admin member of another
-- =====================================================================
SELECT 1 AS ord, 'A1 gate fn' AS what, p.proname || '()' AS name,
       'md5 ' || md5(pg_get_functiondef(p.oid)) || ' · ' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
       || ' · dept-scoped: ' || (pg_get_functiondef(p.oid) ~* 'department_id\s*=\s*(public\.)?my_department_id\(\)')::text
       || ' · roles: ' || coalesce(substring(pg_get_functiondef(p.oid) from 'array\[([^\]]*)\]'), '(none)') AS verdict,
       pg_get_functiondef(p.oid) AS detail
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_dept_admin', 'is_department_admin', 'is_project_admin', 'my_department_id')
UNION ALL
SELECT 2, 'A2 policy to fix', c.relname || ' · ' || p.polname,
       CASE p.polcmd WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE p.polcmd::text END || ' [' || array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (p.polroles)), ',') || ']',
       'USING ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' | CHECK ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
 WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('announcements', 'departments', 'duty_log') AND p.polcmd IN ('w', 'd')
UNION ALL
SELECT 3, 'B1 writes departments', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · gate: ' || concat_ws('+',
         CASE WHEN p.prosrc ~* 'is_project_admin' THEN 'is_project_admin' END,
         CASE WHEN p.prosrc ~* 'is_department_admin' THEN 'is_department_admin' END,
         CASE WHEN p.prosrc ~* 'is_dept_admin' THEN 'is_dept_admin' END,
         CASE WHEN p.prosrc ~* '''Project Admin''' THEN 'inline Project Admin' END,
         CASE WHEN p.prosrc ~* 'is_canmanage' THEN 'is_canmanage*' END)
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text,
       left(regexp_replace(p.prosrc, '\s+', ' ', 'g'), 600)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND p.prosrc ~* '(update|insert\s+into)\s+(public\.)?departments\y'
UNION ALL
SELECT 4, 'B2 PA member row', 'pa ' || left(md5(lower(m.email)), 8),
       d.name || ' · ' || coalesce(m.status, '(null)'),
       'access ' || array_to_string(m.access, ', ') || ' · PA access on THIS row: ' || (m.access && array['Project Admin']::text[])::text
  FROM public.members m JOIN public.departments d ON d.id = m.department_id
 WHERE lower(m.email) IN (SELECT lower(x.email) FROM public.members x WHERE x.access && array['Project Admin']::text[] AND x.email IS NOT NULL)
UNION ALL
SELECT 5, 'B3 multi-dept admin (blast radius)', 'person ' || left(md5(lower(a.email)), 8),
       'admin in ' || da.name || ' (' || array_to_string(a.access, ', ') || ')',
       'plain member in ' || db.name || ' · status there ' || coalesce(b.status, '(null)')
  FROM public.members a JOIN public.departments da ON da.id = a.department_id
  JOIN public.members b ON lower(b.email) = lower(a.email) AND b.department_id <> a.department_id
  JOIN public.departments db ON db.id = b.department_id
 WHERE a.email IS NOT NULL AND a.access && array['Department Admin', 'Project Admin']::text[]
   AND NOT coalesce(b.access && array['Department Admin', 'Project Admin']::text[], false)
UNION ALL
SELECT 5, 'B3 multi-dept admin (blast radius)', 'total', count(*)::text, 'pairs (admin somewhere, plain member elsewhere)'
  FROM public.members a JOIN public.members b ON lower(b.email) = lower(a.email) AND b.department_id <> a.department_id
 WHERE a.email IS NOT NULL AND a.access && array['Department Admin', 'Project Admin']::text[]
   AND NOT coalesce(b.access && array['Department Admin', 'Project Admin']::text[], false)
ORDER BY 1, 2, 3;
