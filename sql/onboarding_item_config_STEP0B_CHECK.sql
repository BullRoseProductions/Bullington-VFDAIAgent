-- =====================================================================
-- ONBOARDING ITEM CONFIG — Step 0b (follow-up to Step 0). READ-ONLY, one result set.
--   1 probation_item_states — the "path read" the order says to reuse: full live definition + md5 (the draft
--     changes it, so its precondition pins this md5), and every function that calls it
--   2 notifications — columns, CHECK / unique constraints and indexes (the approver ping writes here, like the
--     action_items trigger; a type CHECK or the de-dupe key would decide the new type name)
--   3 is_muted — signature, security, and its family list (the ping honours 'tasks', like the trigger)
--   4 onboarding_progress / onboarding_items constraints + indexes (the (member_id, item_id) upsert key; any CHECK
--     on kind / phase the new config must sit beside)
--   5 column-level grants on onboarding_progress (does anything already restrict columns?)
-- =====================================================================
SELECT 1 AS ord, 'probation_item_states' AS what, p.oid::regprocedure::text AS name,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · md5 ' || md5(pg_get_functiondef(p.oid)) || E'\n' || pg_get_functiondef(p.oid) AS detail
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'probation_item_states'
UNION ALL
SELECT 1, 'calls probation_item_states', p.oid::regprocedure::text,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · md5 ' || md5(pg_get_functiondef(p.oid))
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname <> 'probation_item_states'
   AND p.prosrc ILIKE '%probation_item_states%'
UNION ALL
SELECT 2, 'notifications col', column_name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '')
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notifications'
UNION ALL
SELECT 2, 'notifications constraint', c.conname, pg_get_constraintdef(c.oid)
  FROM pg_constraint c WHERE c.conrelid = 'public.notifications'::regclass
UNION ALL
SELECT 2, 'notifications index', i.indexname, i.indexdef FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'notifications'
UNION ALL
SELECT 2, 'notification types in use', coalesce(n.type, '(null)'), count(*)::text FROM public.notifications n GROUP BY n.type
UNION ALL
SELECT 3, 'is_muted', p.oid::regprocedure::text,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · families: '
       || coalesce(substring(pg_get_functiondef(p.oid) from 'NOT IN \(([^)]*)\)'), '(not found)')
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_muted'
UNION ALL
SELECT 4, 'constraint · ' || c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid)
  FROM pg_constraint c WHERE c.conrelid IN ('public.onboarding_items'::regclass, 'public.onboarding_progress'::regclass)
UNION ALL
SELECT 4, 'index · ' || i.tablename, i.indexname, i.indexdef
  FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename IN ('onboarding_items', 'onboarding_progress')
UNION ALL
SELECT 5, 'column grant', g.table_name || '.' || g.column_name || ' -> ' || g.grantee, string_agg(g.privilege_type, ' ' ORDER BY g.privilege_type)
  FROM information_schema.column_privileges g
 WHERE g.table_schema = 'public' AND g.table_name = 'onboarding_progress' AND g.grantee IN ('authenticated', 'anon')
 GROUP BY g.table_name, g.column_name, g.grantee
ORDER BY 1, 2, 3;
