-- =====================================================================
-- RLS SWEEP — STEP 0c (follow-up to Step 0). READ-ONLY, one result set. 
-- RAN on live 2026-10-20. Findings (raw; the reviewer characterizes):
--   duties: UPDATE and DELETE are (department_id = my_department_id() AND is_canmanage_ops()) on USING and CHECK —
--     GATED. The stale dump's dept-only "members update duties" policy is not live. SELECT is dept-only, roles {public}.
--   member_active_department / _station: own-row INSERT / UPDATE by email, no target check — BUT both readers re-check:
--     my_department_id() only honours a saved department the caller is an active member of; my_active_station_id() only
--     a saved station in the current department. The RPCs (set_active_department / _station) hold the same boundary.
--   aftercall_run_items INSERT: any member, into any run of their department (dept via the run; not run-owner).
--   ROLE-ANYWHERE gate inside a row-scoped write (is_department_admin() is NOT department-scoped):
--     announcements UPDATE + DELETE · departments UPDATE ("DA can update own department") · duty_log UPDATE.
--     Reachable only by someone who is DA / PA in one department and a member of another, acting in the other.
--     ai_outputs DELETE uses an inline Project Admin check (PA is a cross-department role by design).
--   Gate bodies: is_leader() department-scoped; is_department_admin(), is_leadership(), is_project_admin() NOT.
-- Answers what Step 0 lists only by absence:
--   1 every policy on the leads (duties, announcements, aftercall_run_items, member_active_department,
--     member_active_station) — full USING / WITH CHECK. duties did NOT come back as a set-1 suspect, so its live UPDATE
--     policy carries a role or self token — this shows which, and 3b showed EVERY duties column client-updatable
--   2 every WRITE policy that leans on a role-ANYWHERE gate (is_department_admin / is_leadership / is_project_admin /
--     an inline members.access check without a department term) — Step 0 set 2 only looked for is_leader() with no
--     department predicate; a row-scoped policy can still take its ROLE from another department
--   3 the gate bodies (is_leader, is_leadership, is_department_admin, is_project_admin) — department-scoped or not
--   4 who reads member_active_station / member_active_department, and whether that function checks the saved station /
--     department belongs to the caller (the own-row INSERT / UPDATE policies don't)
-- =====================================================================
WITH pol AS (
  SELECT c.relname AS tbl, p.polname,
         CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END AS cmd,
         array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY (p.polroles)), ',') AS roles,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS using_expr,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS check_expr
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
)
SELECT 1 AS ord, 'lead policy' AS what, tbl, cmd || ' [' || roles || ']' AS name,
       'USING ' || using_expr || CASE WHEN check_expr <> '' THEN ' | CHECK ' || check_expr ELSE '' END AS detail
  FROM pol WHERE tbl IN ('duties', 'announcements', 'aftercall_run_items', 'member_active_department', 'member_active_station')
UNION ALL
SELECT 2, 'role-anywhere write gate', tbl, cmd || ' · ' || polname,
       'USING ' || using_expr || CASE WHEN check_expr <> '' THEN ' | CHECK ' || check_expr ELSE '' END
  FROM pol
 WHERE cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
   AND (using_expr || check_expr) ~* '(is_department_admin|is_leadership|is_project_admin|members\.access\s*&&|access\s*&&\s*ARRAY)'
UNION ALL
SELECT 3, 'gate body', p.proname || '()',
       CASE WHEN position('my_department_id()' in pg_get_functiondef(p.oid)) > 0 THEN 'department-scoped' ELSE 'NOT department-scoped' END,
       regexp_replace(substring(pg_get_functiondef(p.oid) from 'AS \$[a-z]*\$(.*)\$[a-z]*\$'), '\s+', ' ', 'g')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_leader', 'is_leadership', 'is_department_admin', 'is_project_admin')
UNION ALL
SELECT 4, 'reads the active-station / department pick', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
       || ' · checks station in caller''s dept: ' || (pg_get_functiondef(p.oid) ~* 'stations[^;]*department_id')::text
       || ' · checks member row: ' || (pg_get_functiondef(p.oid) ~* 'from public\.members|from members')::text,
       left(regexp_replace(substring(pg_get_functiondef(p.oid) from 'AS \$[a-z]*\$(.*)\$[a-z]*\$'), '\s+', ' ', 'g'), 900)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND (p.prosrc ILIKE '%member_active_station%' OR p.prosrc ILIKE '%member_active_department%')
ORDER BY 1, 3, 4;
