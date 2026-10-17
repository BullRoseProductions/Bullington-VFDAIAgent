-- =====================================================================
-- READ & SIGN — Step 0 investigation. READ-ONLY (one result set). Confirms the live shapes the build order depends on;
-- schema.sql is a stale snapshot, so these are read from the catalog, not the file.
-- =====================================================================
SELECT 1 AS ord, 'documents column' AS what, column_name AS name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END AS detail
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents'
UNION ALL
SELECT 2, 'documents policy', policyname || ' [' || cmd || '] roles=' || roles::text, coalesce(qual, '') || CASE WHEN with_check IS NOT NULL THEN ' | CHECK ' || with_check ELSE '' END
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'documents'
UNION ALL
SELECT 3, 'documents trigger', tgname, pg_get_triggerdef(oid)
  FROM pg_trigger WHERE tgrelid = 'public.documents'::regclass AND NOT tgisinternal
UNION ALL
SELECT 4, 'gate fn', p.proname, regexp_replace(pg_get_functiondef(p.oid), '\s+', ' ', 'g')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('is_dept_admin', 'is_department_admin', 'is_canmanage', 'is_canmanage_ops', 'is_leadership', 'my_member_id', 'my_department_id')
UNION ALL
SELECT 5, 'documents RPC', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', CASE WHEN position('is_dept_admin' in pg_get_functiondef(p.oid)) > 0 THEN 'gate: is_dept_admin' WHEN position('is_department_admin' in pg_get_functiondef(p.oid)) > 0 THEN 'gate: is_department_admin' WHEN position('is_canmanage_ops' in pg_get_functiondef(p.oid)) > 0 THEN 'gate: is_canmanage_ops' ELSE 'gate: ?' END
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('replace_document', 'soft_delete_document', 'restore_document', 'guard_documents_deleted_at', 'guard_documents_archived_at')
UNION ALL
SELECT 6, 'documents per dept', d.name, count(x.id)::text || ' live, ' || count(x.id) FILTER (WHERE x.content_text IS NULL)::text || ' without text (scans), ' || count(x.id) FILTER (WHERE x.supersedes IS NOT NULL)::text || ' replacements'
  FROM public.departments d LEFT JOIN public.documents x ON x.department_id = d.id AND x.deleted_at IS NULL AND x.archived_at IS NULL GROUP BY d.name
UNION ALL
SELECT 7, 'onboarding item', d.name, string_agg(o.label, ' · ')
  FROM public.onboarding_items o JOIN public.departments d ON d.id = o.department_id
 WHERE o.label ILIKE '%SOG%' OR o.label ILIKE '%acknowledg%' GROUP BY d.name
UNION ALL
SELECT 8, 'member status values', coalesce(status, '(null)'), count(*)::text FROM public.members GROUP BY status
UNION ALL
SELECT 9, 'cert_submissions col', column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'cert_submissions' AND column_name IN ('reviewed_by', 'reviewed_at', 'member_id')
UNION ALL
SELECT 10, 'test login', m.name, d.name || ' · access ' || m.access::text || ' · status ' || coalesce(m.status, '') || CASE WHEN m.email IS NULL THEN ' · NO EMAIL' ELSE '' END
  FROM public.members m JOIN public.departments d ON d.id = m.department_id
 WHERE lower(m.name) IN ('maria reyes', 'cody pearson')
UNION ALL
SELECT 11, 'name clash check', t, (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t)::text
  FROM unnest(array['document_versions', 'document_acknowledgments']) t
ORDER BY 1, 3;
