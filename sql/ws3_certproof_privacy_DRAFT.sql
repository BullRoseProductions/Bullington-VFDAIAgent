-- =====================================================================
-- WS-3 — CERT-PROOF FILE PRIVACY (M-4): owner + leaders only.               DRAFT — NOT APPLIED. NOT REVIEWED.
-- Directive: claude/B4C_ReviewFixes_Wave1_Directives.md (WS-3). Finding: M-4 in claude/B4C_CC_Security_Audit.md —
-- a plain member could open 178 other members' cert-proof scans (license / med-card numbers) in their department.
-- Pins read LIVE 2026-10-27 (docs/review/ws3_LIVEDEFS.sql -> _LIVEDEFS.json).
--
-- ONE ALL-OR-NOTHING DO BLOCK, then a read-only state row. RETEST separately (sql/ws3_certproof_privacy_RETEST.sql,
-- SENTINEL-rolled-back). Dry run: docs/review/ws3_dryrun_harness.mjs.
--
-- WHAT IT DOES (storage.objects SELECT only — nothing else in storage or public changes)
--   station_docs_read_own_dept      ALTERED in place (same name): still "authenticated, this bucket, my department's folder",
--                                   but now EXCLUDES the cert-proofs/ subfolder. Plans, minutes, apparatus, equipment and root
--                                   documents read exactly as before.
--   cert_proofs_read_owner_or_leader NEW SELECT: my department's cert-proofs/<member_id>/… readable only when <member_id> is
--                                   me (my_member_id()) OR I'm is_leader() (Project Admin / Department Admin / Board / Officer
--                                   in my department) — the SAME set the certs table already uses for "Leaders read all certs",
--                                   so the storage gate now matches who the app shows a proof link to.
--   Unchanged: the 3 INSERT policies (incl. members' own cert-proofs upload), UPDATE + DELETE (DA/Officer), the
--   celebrations birthday view (DOB stays department-visible — Ashlea's ruling), every public table/function/policy.
--
-- DECISIONS FOR THE GATE REVIEW (claude/B4C_WS3_CertProof_Privacy_Draft.md):
--   D1 "Leaders" = is_leader() (PA/DA/Board/Officer, dept-scoped) — mirrors certs RLS + every in-app proof viewer
--      (Roster certs, member file, pending queue). Narrower option: is_dept_admin() OR training manager.
--   D2 The 6 orphan proofs (owner no longer a member of that department) become leader-only — nobody else's folder.
--   D3 OWNERSHIP RISK: storage.objects is owned by supabase_storage_admin and postgres is not a member of it. Supabase's
--      SQL editor normally can manage storage policies; if this project refuses ("must be owner of table objects"), the DO
--      block raises and NOTHING changes — apply the same two statements from Dashboard → Storage → Policies instead.
-- =====================================================================

DO $mig$
DECLARE
  v_pins constant jsonb := jsonb_build_object(
    'public.is_leader()',        '3f462af26a46909309f856f769226baa',
    'public.my_department_id()', '87f546659c3804a943b48e419e017f18',
    'public.my_member_id()',     '3f66369c8af7bc07ec59831af6536fee',
    'storage.foldername(text)',  '93671af66e1fe108a56068ad4137d001');
  v_read_old constant text := '((bucket_id = ''station-documents''::text) AND ((storage.foldername(name))[1] = (my_department_id())::text))';
  v_others_before text; v_others_after text; v_ver_before bigint; v_ver_after bigint; k text; v text; v_n int;
BEGIN
  -- ---------------------------------------------------------------- 0. pre-flight
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF to_regprocedure(k) IS NULL OR md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN
      RAISE EXCEPTION 'PREFLIGHT: % is missing or has drifted (pinned %). Re-audit.', k, v;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'storage';
  IF v_n <> 6 THEN RAISE EXCEPTION 'PREFLIGHT: expected 6 storage policies, found %. Re-audit.', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'station_docs_read_own_dept'
                   AND cmd = 'SELECT' AND roles = '{authenticated}'::name[] AND qual = v_read_old AND with_check IS NULL) THEN
    RAISE EXCEPTION 'PREFLIGHT: station_docs_read_own_dept is not the audited text. Re-audit.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'cert_proofs_read_owner_or_leader') THEN
    RAISE EXCEPTION 'PREFLIGHT: cert_proofs_read_owner_or_leader already exists — WS-3 looks applied. Refusing.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT: expected exactly one SELECT policy on storage.objects. Re-audit.';
  END IF;
  SELECT md5(string_agg(policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY policyname))
    INTO v_others_before FROM pg_policies WHERE schemaname = 'storage' AND policyname <> 'station_docs_read_own_dept';
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;

  -- ---------------------------------------------------------------- 1. the carve-out
  EXECUTE $p$ ALTER POLICY station_docs_read_own_dept ON storage.objects
                USING (bucket_id = 'station-documents'
                       AND (storage.foldername(name))[1] = (public.my_department_id())::text
                       AND (storage.foldername(name))[2] IS DISTINCT FROM 'cert-proofs') $p$;
  EXECUTE $p$ CREATE POLICY cert_proofs_read_owner_or_leader ON storage.objects FOR SELECT TO authenticated
                USING (bucket_id = 'station-documents'
                       AND (storage.foldername(name))[1] = (public.my_department_id())::text
                       AND (storage.foldername(name))[2] = 'cert-proofs'
                       AND ((storage.foldername(name))[3] = (public.my_member_id())::text OR public.is_leader())) $p$;

  -- ---------------------------------------------------------------- 2. post-conditions
  SELECT md5(string_agg(policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY policyname))
    INTO v_others_after FROM pg_policies WHERE schemaname = 'storage' AND policyname NOT IN ('station_docs_read_own_dept', 'cert_proofs_read_owner_or_leader');
  IF v_others_after <> v_others_before THEN RAISE EXCEPTION 'POST: another storage policy changed — it must not.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') <> 7
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT') <> 2 THEN
    RAISE EXCEPTION 'POST: expected 7 storage policies, 2 of them SELECT.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'station_docs_read_own_dept' AND roles = '{authenticated}'::name[]
                   AND qual LIKE '%IS DISTINCT FROM ''cert-proofs''%' AND qual LIKE '%my_department_id()%')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'cert_proofs_read_owner_or_leader' AND roles = '{authenticated}'::name[]
                      AND permissive = 'PERMISSIVE' AND qual LIKE '%my_member_id()%' AND qual LIKE '%is_leader()%' AND qual LIKE '%my_department_id()%') THEN
    RAISE EXCEPTION 'POST: the two SELECT policies are not as intended.';
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN RAISE EXCEPTION 'POST: % changed — it must not.', k; END IF;
  END LOOP;
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'POST: the verified count moved.'; END IF;
END
$mig$;

-- =====================================================================
-- STATE ROW (read-only) — paste this back with the apply.
-- =====================================================================
SELECT jsonb_build_object(
  'storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage'),
  'select_policies',  (SELECT jsonb_agg(policyname ORDER BY policyname) FROM pg_policies WHERE schemaname = 'storage' AND cmd = 'SELECT'),
  'cert_proof_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[2] = 'cert-proofs'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
