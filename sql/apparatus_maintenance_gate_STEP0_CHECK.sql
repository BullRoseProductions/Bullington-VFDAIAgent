-- =====================================================================
-- APPARATUS_MAINTENANCE UPDATE GATE — Step 0. READ-ONLY, one result set. Same pattern as
-- sql/apparatus_update_gate_STEP0_CHECK.sql. Confirms, BEFORE tightening, that no member flow needs a direct
-- apparatus_maintenance UPDATE:
--   1 every apparatus_maintenance policy (all cmds)      2 apparatus_maintenance_log policies (Mark done inserts there first)
--   3 EVERY function whose body writes apparatus_maintenance — DEFINER (unaffected) or INVOKER (would break for members)
--   4 triggers on ANY table whose function writes apparatus_maintenance (a trigger runs as the CALLER)
--   5 triggers on apparatus_maintenance itself           6 RLS on the two tables      7 total policies
-- STOP RULE: any INVOKER row in 3, or a 4-trigger on a table members can write directly -> report, don't tighten.
-- Code side (src/App.jsx, 2026-10-18): the only client writes are the maintenance card's add / Mark done / edit / remove
-- (17642 / 17668 / 17677 / 17683), every control gated canManage = CANMANAGE_OPS_ROLES (DA / Officer); Mark done first
-- INSERTs apparatus_maintenance_log, whose policy is already is_canmanage_ops().
-- =====================================================================
SELECT 1 AS ord, 'maintenance policy' AS what, policyname || ' [' || cmd || '] ' || roles::text AS name,
       coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '') AS detail
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance'
UNION ALL
SELECT 2, 'maintenance_log policy', policyname || ' [' || cmd || '] ' || roles::text, coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance_log'
UNION ALL
SELECT 3, 'writes maintenance', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER (!)' END
       || ' · ' || CASE WHEN p.prorettype = 'trigger'::regtype THEN 'trigger fn' WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'members can execute' ELSE 'not executable by members' END
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND pg_get_functiondef(p.oid) ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?apparatus_maintenance\s'
UNION ALL
SELECT 4, 'trigger -> maintenance write', t.tgname || ' ON ' || c.relname,
       p.proname || ' · ' || CASE WHEN p.prosecdef THEN 'fn SECURITY DEFINER' ELSE 'fn INVOKER (runs as the caller)' END
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
   AND pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?apparatus_maintenance\s'
UNION ALL
SELECT 5, 'maintenance trigger', t.tgname, pg_get_triggerdef(t.oid)
  FROM pg_trigger t WHERE t.tgrelid = 'public.apparatus_maintenance'::regclass AND NOT t.tgisinternal
UNION ALL
SELECT 6, 'rls', c.relname, CASE WHEN c.relrowsecurity THEN 'rls on' ELSE 'RLS OFF (!)' END
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('apparatus_maintenance', 'apparatus_maintenance_log')
UNION ALL
SELECT 7, 'policies', 'total', count(*)::text FROM pg_policies WHERE schemaname = 'public'
ORDER BY 1, 3;
