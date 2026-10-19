-- =====================================================================
-- PHASE 3.1 #4 (Expirations) — Step 0. READ-ONLY, one result set. Answers, before anything is built:
--   1 certs columns (the dashboard UNIONs it) + how exp is stored        2 cert_submissions columns (the approval flow)
--   3 certs exp values: how many are YYYY-MM / blank / other, per department (month precision + undated = UNION rules)
--   4 certs + cert_submissions policies                                  5 functions that write certs (the approval path)
--   6 the gate / identity functions — signatures + bodies (is_canmanage_ops, my_member_id, my_department_id)
--   7 how Inactive / separated members are excluded (member_separation + members.status values)
--   8 apparatus PK + department_id + soft-delete + in_service             9 the new names are free
--  10 the push entry point the later "send reminders" button would reuse (notification functions / tables)
--  11 total policies
-- =====================================================================
SELECT 1 AS ord, 'certs col' AS what, column_name AS name,
       data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '') AS detail
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'certs'
UNION ALL
SELECT 2, 'cert_submissions col', column_name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '')
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cert_submissions'
UNION ALL
SELECT 3, 'certs exp shape', d.name,
       count(c.*) || ' certs · ' || count(c.*) FILTER (WHERE c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$') || ' YYYY-MM · '
       || count(c.*) FILTER (WHERE nullif(btrim(coalesce(c.exp, '')), '') IS NULL) || ' blank · '
       || count(c.*) FILTER (WHERE nullif(btrim(coalesce(c.exp, '')), '') IS NOT NULL AND c.exp !~ '^\d{4}-(0[1-9]|1[0-2])$') || ' other'
       || coalesce(' (e.g. ' || (SELECT string_agg(DISTINCT x.exp, ', ') FROM (SELECT c2.exp FROM public.certs c2 WHERE c2.department_id = d.id
            AND nullif(btrim(coalesce(c2.exp, '')), '') IS NOT NULL AND c2.exp !~ '^\d{4}-(0[1-9]|1[0-2])$' LIMIT 5) x) || ')', '')
  FROM public.departments d LEFT JOIN public.certs c ON c.department_id = d.id GROUP BY d.id, d.name
UNION ALL
SELECT 4, 'policy', tablename || ': ' || policyname || ' [' || cmd || '] ' || roles::text, coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('certs', 'cert_submissions')
UNION ALL
SELECT 5, 'writes certs', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND pg_get_functiondef(p.oid) ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?certs\s'
UNION ALL
SELECT 6, 'identity / gate fn', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || format_type(p.prorettype, NULL),
       CASE WHEN p.prosecdef THEN 'DEFINER · ' ELSE 'INVOKER · ' END
       || regexp_replace(substring(pg_get_functiondef(p.oid) from 'AS \$[a-z]*\$(.*)\$[a-z]*\$'), '\s+', ' ', 'g')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_canmanage_ops', 'is_canmanage', 'my_member_id', 'my_department_id')
UNION ALL
SELECT 7, 'members.status', coalesce(status, '(null)'), count(*)::text || ' members' FROM public.members GROUP BY status
UNION ALL
SELECT 7, 'member_separation col', column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_separation'
UNION ALL
SELECT 7, 'member_separation rows', 'total', count(*)::text FROM public.member_separation
UNION ALL
SELECT 8, 'apparatus col', column_name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'apparatus'
   AND column_name IN ('id', 'department_id', 'deleted_at', 'in_service', 'name', 'type')
UNION ALL
SELECT 8, 'apparatus pk', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.apparatus'::regclass AND contype = 'p'
UNION ALL
SELECT 9, 'name free?', t, CASE WHEN to_regclass('public.' || t) IS NULL AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = t AND pronamespace = 'public'::regnamespace) THEN 'free' ELSE 'TAKEN' END
  FROM unnest(array['member_credentials', 'gear_items', 'apparatus_tests', 'dept_expirations', 'my_expirations']) t
UNION ALL
SELECT 10, 'push path fn', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname ILIKE '%notif%' OR p.proname ILIKE '%push%' OR p.proname ILIKE '%remind%')
UNION ALL
SELECT 10, 'push path table', c.relname, 'table' FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND (c.relname ILIKE '%notif%' OR c.relname ILIKE '%push%' OR c.relname ILIKE '%device%')
UNION ALL
SELECT 11, 'policies', 'total', count(*)::text FROM pg_policies WHERE schemaname = 'public'
ORDER BY 1, 3;
