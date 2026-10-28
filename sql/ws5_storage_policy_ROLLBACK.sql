-- =====================================================================
-- ROLLBACK for ws5_storage_policy (WS-5 part 2, S-1). INSURANCE — run only on an explicit call. GENERATED.
-- Puts "equipment photos upload da or manager" back TO public (roles only). Refuses unless it is TO authenticated with the pinned WITH CHECK.
-- Post: its full definition md5 = the original pin (fd2ac571…); the other storage policies byte-identical.
-- Same apply path as part 2: SQL editor, or the dashboard (that policy → roles: public) if refused.
-- =====================================================================
DO $rollback$
DECLARE v_t text; v_others_before text; v_others_after text; v_n bigint;
BEGIN
  SELECT p.roles::text || '|' || md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_t
    FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'equipment photos upload da or manager';
  IF v_t IS DISTINCT FROM '{authenticated}|086ac4803c214af159fa7168a69fc6dd' THEN RAISE EXCEPTION 'PREFLIGHT: the storage policy is not the S-1 applied state (%). Refusing.', coalesce(v_t, 'missing'); END IF;
  SELECT md5(string_agg(md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')), ',' ORDER BY p.policyname)) INTO v_others_before FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> 'equipment photos upload da or manager';
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'storage';

  ALTER POLICY "equipment photos upload da or manager" ON storage.objects TO public;

  SELECT md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_t FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'equipment photos upload da or manager';
  IF v_t IS DISTINCT FROM 'fd2ac571628b3755bb0517ff5db09851' THEN RAISE EXCEPTION 'Post-condition failed: the storage policy is not back to its original definition. Rolling back.'; END IF;
  SELECT md5(string_agg(md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')), ',' ORDER BY p.policyname)) INTO v_others_after FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> 'equipment photos upload da or manager';
  IF v_others_after IS DISTINCT FROM v_others_before OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') <> v_n THEN
    RAISE EXCEPTION 'Post-condition failed: another storage policy changed. Rolling back.';
  END IF;
END
$rollback$;

SELECT jsonb_build_object(
  'policy', (SELECT p.policyname || ' ' || p.cmd || ' ' || p.roles::text FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname = 'equipment photos upload da or manager'),
  'storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage')
) AS state;
