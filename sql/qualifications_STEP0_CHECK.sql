-- =====================================================================
-- PHASE 3.1 #3 (Qualification matrix + driver/operator check-offs + drive log) — Step 0. READ-ONLY, one result set.
-- Confirms what #3 reuses (supervised_sessions + its RPCs), the apparatus shape + RLS, that the new names are free,
-- and how many supervised drives already exist (so reusing counts_toward can't collide with live data).
-- =====================================================================
SELECT 1 AS ord, 'supervised_sessions col' AS what, column_name AS name,
       data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '') AS detail
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'supervised_sessions'
UNION ALL
SELECT 2, 'supervised_sessions check', conname, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE conrelid = 'public.supervised_sessions'::regclass AND contype = 'c'
UNION ALL
SELECT 3, 'rpc', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       concat_ws(' · ',
         CASE WHEN position('is_canmanage_ops()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_canmanage_ops()' END,
         CASE WHEN position('is_canmanage()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_canmanage()' END,
         CASE WHEN position('is_leader()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_leader() (!)' END,
         CASE WHEN position('counts_toward' in pg_get_functiondef(p.oid)) > 0 THEN 'mentions counts_toward' END,
         CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'ANON CAN EXECUTE (!)' ELSE 'anon revoked' END)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('log_supervised_session', 'void_supervised_session', 'dept_probation_board', 'probation_item_states', 'probation_status')
UNION ALL
SELECT 4, 'supervised_sessions data', 'rows by kind / counts_toward',
       coalesce(string_agg(x, ' · '), 'no rows')
  FROM (SELECT kind || ' / ' || coalesce(counts_toward, 'null') || ' = ' || count(*) || CASE WHEN count(*) FILTER (WHERE voided_at IS NOT NULL) > 0 THEN ' (' || count(*) FILTER (WHERE voided_at IS NOT NULL) || ' voided)' ELSE '' END AS x
          FROM public.supervised_sessions GROUP BY kind, counts_toward ORDER BY 1) s
UNION ALL
SELECT 5, 'apparatus col', column_name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'apparatus'
UNION ALL
SELECT 6, 'apparatus policy', policyname || ' [' || cmd || '] ' || roles::text, coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus'
UNION ALL
SELECT 7, 'apparatus rows', d.name, count(a.id)::text || ' apparatus'
  FROM public.departments d LEFT JOIN public.apparatus a ON a.department_id = d.id GROUP BY d.name
UNION ALL
SELECT 8, 'name free?', t, CASE WHEN to_regclass('public.' || t) IS NULL AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = t AND pronamespace = 'public'::regnamespace) THEN 'free' ELSE 'TAKEN' END
  FROM unnest(array['qualification_types', 'member_qualifications', 'set_qualification_type', 'sign_qualification', 'revoke_qualification',
                    'log_qualification_drive', 'my_qualifications', 'dept_qualification_matrix']) t
UNION ALL
SELECT 9, 'gate fn', p.proname, CASE WHEN position('my_department_id()' in pg_get_functiondef(p.oid)) > 0 THEN 'department-scoped' ELSE 'NOT department-scoped (!)' END
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_canmanage', 'is_canmanage_ops', 'is_dept_admin', 'is_department_admin', 'is_leader')
UNION ALL
SELECT 10, 'onboarding_items edit gate', policyname || ' [' || cmd || ']', coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'onboarding_items' AND cmd <> 'SELECT'
UNION ALL
SELECT 11, 'policies', 'total', count(*)::text FROM pg_policies WHERE schemaname = 'public'
ORDER BY 1, 3;
