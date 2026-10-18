-- =====================================================================
-- APPARATUS UPDATE GATE — Step 0. READ-ONLY, one result set. Confirms, BEFORE tightening the apparatus UPDATE policy,
-- that no member flow needs a direct apparatus UPDATE:
--   1 every apparatus policy (all cmds)            2 is_canmanage_ops() is department-scoped
--   3 EVERY function whose body updates apparatus — SECURITY DEFINER (runs as owner, unaffected by the policy) or
--     INVOKER (would break for members) — and whether members can execute it
--   4 triggers on ANY table whose function updates apparatus (a trigger runs as the CALLER — a member's direct write
--     to that table would hit the new policy)
--   5 which apparatus-related tables members can write directly (a direct write that fires a #4 trigger = a break)
--   6 triggers on apparatus itself (the check-interval guard)    7 total policies
-- STOP RULE: any INVOKER row in 3, or a 4-trigger on a table members write directly in 5 -> report, don't tighten.
-- =====================================================================
SELECT 1 AS ord, 'apparatus policy' AS what, policyname || ' [' || cmd || '] ' || roles::text AS name,
       coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '') AS detail
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus'
UNION ALL
SELECT 2, 'gate fn', p.proname,
       CASE WHEN position('my_department_id()' in pg_get_functiondef(p.oid)) > 0 THEN 'department-scoped' ELSE 'NOT department-scoped (!)' END
       || ' · ' || regexp_replace(substring(pg_get_functiondef(p.oid) from 'AS \$function\$(.*)\$function\$'), '\s+', ' ', 'g')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_canmanage_ops'
UNION ALL
SELECT 3, 'writes apparatus', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER (!)' END
       || ' · ' || CASE WHEN p.prorettype = 'trigger'::regtype THEN 'trigger fn' WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'members can execute' ELSE 'not executable by members' END
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?apparatus\s'
UNION ALL
SELECT 4, 'trigger -> apparatus write', t.tgname || ' ON ' || c.relname,
       p.proname || ' · ' || CASE WHEN p.prosecdef THEN 'fn SECURITY DEFINER' ELSE 'fn INVOKER (runs as the caller)' END || ' · ' || CASE WHEN t.tgenabled = 'O' THEN 'enabled' ELSE 'disabled' END
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?apparatus\s'
UNION ALL
SELECT 5, 'member direct write', c.relname,
       concat_ws(' ',
         CASE WHEN has_table_privilege('authenticated', c.oid, 'INSERT') THEN 'INSERT' END,
         CASE WHEN has_table_privilege('authenticated', c.oid, 'UPDATE') THEN 'UPDATE' END,
         CASE WHEN has_table_privilege('authenticated', c.oid, 'DELETE') THEN 'DELETE' END)
       || ' · write policies: ' || coalesce((SELECT string_agg(pp.policyname || ' [' || pp.cmd || '] ' || coalesce(pp.qual, pp.with_check, ''), ' ; ')
                                              FROM pg_policies pp WHERE pp.schemaname = 'public' AND pp.tablename = c.relname AND pp.cmd <> 'SELECT'), 'none')
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND (c.relname LIKE 'apparatus%' OR c.relname LIKE '%check%')
UNION ALL
SELECT 6, 'apparatus trigger', t.tgname, pg_get_triggerdef(t.oid)
  FROM pg_trigger t WHERE t.tgrelid = 'public.apparatus'::regclass AND NOT t.tgisinternal
UNION ALL
SELECT 7, 'policies', 'total', count(*)::text FROM pg_policies WHERE schemaname = 'public'
ORDER BY 1, 3;
