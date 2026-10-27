-- READ-ONLY (Training Library slice 1): what the catalog migration pins against. No writes.
WITH fn AS (SELECT p.oid, p.proname, p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f')
SELECT jsonb_pretty(jsonb_build_object(
  'defs', (SELECT jsonb_object_agg(sig, jsonb_build_object('md5', md5(def), 'def', def)) FROM fn
            WHERE proname IN ('my_department_id', 'my_member_id', 'is_training_manager', 'is_training_officer', 'dept_drill_plans', 'set_drill_plan',
                              'approve_drill_plan', 'unapprove_drill_plan', 'delete_drill_plan', 'attach_drill_plan_to_session')),
  'drill_plans_cols', (SELECT jsonb_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                         || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum)
                         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                        WHERE a.attrelid = 'public.drill_plans'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
  'drill_plans_constraints', (SELECT jsonb_agg(conname || ' | ' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass),
  'drill_plans_policies', (SELECT jsonb_agg(policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',') || ' | ' || coalesce(qual, '') || ' | ' || coalesce(with_check, '')) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drill_plans'),
  'drill_plans_triggers', (SELECT coalesce(jsonb_agg(tgname), '[]'::jsonb) FROM pg_trigger WHERE tgrelid = 'public.drill_plans'::regclass AND NOT tgisinternal),
  'drill_plans_rows', (SELECT count(*) FROM public.drill_plans),
  'session_plans_drill_fk', (SELECT jsonb_agg(conname || ' | ' || pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid = 'public.session_plans'::regclass AND contype = 'f'),
  'name_clash', (SELECT coalesce(jsonb_agg(proname), '[]'::jsonb) FROM fn WHERE proname IN ('pull_library_drill', 'library_drill_usage', 'library_catalog')),
  'table_clash', to_regclass('public.library_drills') IS NOT NULL,
  'standard_cert_types_pattern', (SELECT jsonb_build_object('policies', (SELECT jsonb_agg(policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',') || ' | ' || coalesce(qual, '')) FROM pg_policies WHERE tablename = 'standard_cert_types'),
                                   'relacl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.standard_cert_types'::regclass))),
  'total_public_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count', (SELECT count(*) FROM fn),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
)) AS r;
