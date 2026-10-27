-- READ-ONLY Step 0 (Training Library): drill_plans as it is LIVE (the repo has no SQL for it), session_plans' link to it,
-- the cross-department precedents, real "used" counts, and scheduled-job extensions. No writes.
WITH fn AS (SELECT p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def, p.prosecdef,
                   has_function_privilege('anon', p.oid, 'EXECUTE') anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x
              FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f')
SELECT jsonb_pretty(jsonb_build_object(
  'drill_plans_cols', (SELECT jsonb_agg(column_name || ' ' || udt_name || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' DEFAULT ' || column_default, '') ORDER BY ordinal_position)
                         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'drill_plans'),
  'drill_plans_constraints', (SELECT jsonb_agg(conname || ' | ' || pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass),
  'drill_plans_rls', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.drill_plans'::regclass),
  'drill_plans_policies', (SELECT coalesce(jsonb_agg(policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',') || ' | USING ' || coalesce(qual, '-') || ' | CHECK ' || coalesce(with_check, '-')), '[]'::jsonb)
                             FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drill_plans'),
  'drill_plans_grants', (SELECT jsonb_agg(DISTINCT grantee || ':' || privilege_type) FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'drill_plans' AND grantee IN ('anon', 'authenticated')),
  'drill_rpcs', (SELECT jsonb_object_agg(proname || '(' || args || ')', jsonb_build_object('definer', prosecdef, 'anon', anon_x, 'auth', auth_x, 'def', def)) FROM fn
                  WHERE proname IN ('set_drill_plan', 'approve_drill_plan', 'unapprove_drill_plan', 'delete_drill_plan', 'dept_drill_plans')),
  'session_plans_cols', (SELECT jsonb_agg(column_name || ' ' || udt_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'session_plans'),
  'session_plans_fks', (SELECT jsonb_agg(conname || ' | ' || pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid = 'public.session_plans'::regclass AND contype IN ('f', 'u', 'c')),
  'session_plans_policies', (SELECT jsonb_agg(policyname || ' | ' || cmd || ' | USING ' || coalesce(qual, '-') || ' | CHECK ' || coalesce(with_check, '-')) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'session_plans'),
  'training_plans_policies', (SELECT jsonb_agg(policyname || ' | ' || cmd || ' | USING ' || coalesce(qual, '-')) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_plans'),
  'standard_cert_types_policies', (SELECT jsonb_agg(policyname || ' | ' || cmd || ' | USING ' || coalesce(qual, '-')) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'standard_cert_types'),
  'tables_without_department_id', (SELECT jsonb_agg(t.table_name ORDER BY t.table_name) FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
                                     AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'department_id')),
  'drill_plans_counts', (SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT d.name || ' / ' || dp.source || ' / ' || dp.status k, count(*) n FROM public.drill_plans dp JOIN public.departments d ON d.id = dp.department_id GROUP BY 1) x),
  'session_plans_counts', (SELECT jsonb_build_object(
      'total', count(*),
      'from_library', count(*) FILTER (WHERE (to_jsonb(sp) ->> 'drill_plan_id') IS NOT NULL),
      'ai_text', count(*) FILTER (WHERE sp.ai_text IS NOT NULL), 'uploads', count(*) FILTER (WHERE sp.storage_path IS NOT NULL),
      'on_done_sessions', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.training_sessions ts WHERE ts.id = sp.session_id AND ts.done)),
      'on_done_attended', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.training_sessions ts WHERE ts.id = sp.session_id AND ts.done
                                                           AND EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id)))) FROM public.session_plans sp),
  'used_library_plans', (SELECT count(DISTINCT (to_jsonb(sp) ->> 'drill_plan_id')) FROM public.session_plans sp
                           WHERE (to_jsonb(sp) ->> 'drill_plan_id') IS NOT NULL AND EXISTS (SELECT 1 FROM public.training_sessions ts WHERE ts.id = sp.session_id AND ts.done
                                   AND EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id))),
  'ai_outputs_drill', (SELECT jsonb_object_agg(feature, n) FROM (SELECT feature, count(*) n FROM public.ai_outputs GROUP BY 1) y),
  'extensions', (SELECT jsonb_agg(extname || ' ' || extversion) FROM pg_extension),
  'cron_jobs', (SELECT coalesce(jsonb_agg(jobname || ' | ' || schedule || ' | ' || left(command, 80)), '[]'::jsonb) FROM cron.job),
  'departments', (SELECT count(*) FROM public.departments)
)) AS r;
