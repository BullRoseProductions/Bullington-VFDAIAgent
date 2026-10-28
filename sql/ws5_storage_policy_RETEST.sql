-- =====================================================================
-- RETEST for ws5_storage_policy (WS-5 part 2, S-1). READ-ONLY — catalog checks inside a block ending in RAISE (nothing
-- changes; no row is written to storage.objects — its triggers are the platform's). GENERATED with the migration.
--   S1 "equipment photos upload da or manager" is INSERT TO {authenticated}, its WITH CHECK md5 = the pin (086ac480…)
--   S2 no storage policy is TO {public} or {anon}
--   S3 storage still has 7 policies
-- The behavioral proof is the smoke pass: a real DA uploads an equipment photo in a separate browser.
-- =====================================================================
DO $retest$
DECLARE rpt text := ''; v_pass int := 0; v_fail int := 0; v_t text;
BEGIN
  SELECT p.cmd || '|' || p.roles::text || '|' || md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_t
    FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = 'equipment photos upload da or manager';
  IF v_t = 'INSERT|{authenticated}|086ac4803c214af159fa7168a69fc6dd' THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S1 the policy is TO authenticated, WITH CHECK identical to the pin' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S1 the policy is %s%s', coalesce(v_t, 'missing'), chr(10)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND roles && '{public,anon}'::name[]) THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S2 no {public}/{anon} storage policy' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S2 a {public}/{anon} storage policy is left' || chr(10); END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') = 7 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S3 storage policy count 7' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S3 the storage policy count changed' || chr(10); END IF;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, 0 skipped', v_pass, v_fail);
END
$retest$;
