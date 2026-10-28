-- =====================================================================
-- WS-5 (part 2 of 2) — S-1: the one {public} STORAGE policy → TO authenticated. DRAFT — NOT APPLIED. GENERATED.
-- storage.objects is owned by supabase_storage_admin. Memory (storage-policies-via-sql-editor): the SQL editor's postgres CAN
-- alter storage.objects policies here (WS-3 did, 2026-10-27). If it is refused ("must be owner"), change NOTHING and
-- apply the same single change in the Supabase dashboard (Storage → Policies → "equipment photos upload da or manager" → roles: authenticated).
-- ALTER POLICY … TO changes only the roles; the WITH CHECK is not re-entered. Nothing else in storage changes — the other
-- storage policies are proven byte-identical in the same transaction.
-- =====================================================================
DO $migrate$
DECLARE v_t text; v_others_before text; v_others_after text; v_n bigint;
BEGIN
  SELECT md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_t FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'equipment photos upload da or manager';
  IF v_t IS NULL THEN RAISE EXCEPTION 'PREFLIGHT: storage policy "equipment photos upload da or manager" not found. Refusing.'; END IF;
  IF (SELECT roles::text FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'equipment photos upload da or manager') = '{authenticated}' THEN
    RAISE EXCEPTION 'PREFLIGHT: already TO authenticated — S-1 looks applied. Refusing.';
  END IF;
  IF v_t IS DISTINCT FROM 'fd2ac571628b3755bb0517ff5db09851' THEN RAISE EXCEPTION 'PREFLIGHT: storage policy "equipment photos upload da or manager" drifted. Refusing.'; END IF;
  SELECT md5(string_agg(md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')), ',' ORDER BY p.policyname)) INTO v_others_before FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> 'equipment photos upload da or manager';
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'storage';

  ALTER POLICY "equipment photos upload da or manager" ON storage.objects TO authenticated;

  IF (SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) || '|' || p.roles::text FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname = 'equipment photos upload da or manager')
     IS DISTINCT FROM md5(coalesce(NULL::text, '') || '|' || coalesce('((bucket_id = ''station-documents''::text) AND ((storage.foldername(name))[1] = (my_department_id())::text) AND ((storage.foldername(name))[2] = ''equipment''::text) AND (is_dept_admin() OR is_equipment_manager()))', '')) || '|{authenticated}' THEN
    RAISE EXCEPTION 'Post-condition failed: the storage policy is not the same predicate TO authenticated. Rolling back.';
  END IF;
  SELECT md5(string_agg(md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')), ',' ORDER BY p.policyname)) INTO v_others_after FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> 'equipment photos upload da or manager';
  IF v_others_after IS DISTINCT FROM v_others_before OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') <> v_n THEN
    RAISE EXCEPTION 'Post-condition failed: another storage policy changed. Rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND roles && '{public,anon}'::name[]) THEN
    RAISE EXCEPTION 'Post-condition failed: a {public}/{anon} storage policy is left. Rolling back.';
  END IF;
END
$migrate$;

SELECT jsonb_build_object(
  'policy', (SELECT p.policyname || ' ' || p.cmd || ' ' || p.roles::text FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname = 'equipment photos upload da or manager'),
  'storage_public_or_anon_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND roles && '{public,anon}'::name[]),
  'storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage')
) AS state;
