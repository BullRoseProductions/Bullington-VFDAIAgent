-- =====================================================================
-- ONBOARDING ITEM CONFIG — Step 0b (follow-up to Step 0). READ-ONLY, one result set.
-- RAN on live 2026-10-19. Findings:
--   probation_item_states(uuid,uuid): DEFINER, md5 0e91cf1d69f03a7b1dcb9234b7284357 (= Step 0), RETURNS TABLE(item_id,
--     label, category, phase, kind, clears_to_run, sort_order, satisfied, state, signed_by_name, signed_at, have, target);
--     manual item state = signed (done + checked_by) / done_unrecorded / open; mentor = mentor_assigned / open.
--     Only caller: probation_status(uuid,uuid) (DEFINER, md5 cc0b7a8282832355ee79722d76b48858, members exec false).
--   notifications: NO type CHECK (free text; in use: task_assigned, task_due_today, cert_expiring, event_1h/24h, maint_*,
--     duty_summary, gear_retire, shift_self_review); de-dupe = UNIQUE (member_id, type, subject_ref) NULLS NOT DISTINCT;
--     severity CHECK in (info, warning, critical); department_id + member_id NOT NULL.
--   is_muted(uuid,text): DEFINER, members exec false; families live = certs, gear, maint, events, tasks, shifts
--     (sql/notification_prefs.sql is stale — no 'shifts'). 'tasks' is valid.
--   onboarding_items CHECKs: kind in (manual, ack, hours, cert); phase in (onboarding, probation); mentor => manual;
--     hours / source / cert_name bounds. onboarding_progress: UNIQUE (member_id, item_id) (the upsert key); FKs
--     checked_by -> members ON DELETE SET NULL, item_id / member_id / department_id CASCADE.
--   Column grants on onboarding_progress: authenticated INSERT / UPDATE on EVERY column (inherited from the table
--     grant); anon SELECT / REFERENCES. Nothing column-restricted today.
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
