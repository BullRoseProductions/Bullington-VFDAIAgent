-- =====================================================================
-- RETEST for ws3_certproof_privacy (WS-3). READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Fixture MEMBERS are inserted inside a per-department sub-block ending in RAISE 'SENTINEL' (rolled back); storage.objects
-- is only READ (the REAL objects), never written. The whole block ends in a RAISE that IS the report. NOTHING CHANGES.
--
-- Once:
--   O1 exactly 7 storage policies; 2 SELECT on storage.objects (the carve-out + the owner-or-leader read), both TO authenticated
--   O2 the 5 other storage policies (3 INSERT, UPDATE, DELETE) unchanged in name/cmd/roles
-- Per department that HAS cert-proof files (the others are SKIPPED, with a reason):
--   T1 a plain Member (fixture) sees 0 of the department's cert-proofs — and ALL of its other documents (plans, minutes, …)
--   T2 the REAL owner of a proof (impersonated by email, read-only) sees exactly their own cert-proofs, no one else's
--   T3 a Department Admin, an Officer, a Board Member and a Project Admin (fixtures) each see ALL the department's cert-proofs
--   T4 a leader of ANOTHER department (fixture DA) sees none of this department's objects at all
--   T5 anon sees no objects
--   T6 verified count unchanged
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_t text; v_n int; v_n2 int; v_total_cp int; v_total_other int; v_ok boolean; v_err text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
  d uuid; od uuid; tag text; e_mem text; e_da text; e_off text; e_board text; e_pa text; e_xda text;
  v_owner uuid; v_owner_email text; v_owner_cp int; v_ver_before bigint; v_ver_after bigint;
BEGIN
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') = 7
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT' AND roles = '{authenticated}'::name[]) = 2
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'cert_proofs_read_owner_or_leader') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 7 storage policies; 2 SELECT (carve-out + owner-or-leader), both TO authenticated' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 storage policy set not as intended' || chr(10); END IF;
  IF (SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'storage'
        AND policyname NOT IN ('station_docs_read_own_dept', 'cert_proofs_read_owner_or_leader'))
     = 'equipment photos upload da or manager:INSERT,members upload own cert proofs:INSERT,station_docs_delete_leadership:DELETE,station_docs_insert_leadership:INSERT,station_docs_update_leadership:UPDATE' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 the 5 write policies are untouched' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 a write policy changed' || chr(10); END IF;

  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; tag := 'ws3rt-' || left(replace(d::text, '-', ''), 8);
    SELECT dep.id INTO od FROM public.departments dep WHERE dep.id <> d ORDER BY dep.name LIMIT 1;
    rpt := rpt || '— ' || rec.name || chr(10);
    SELECT count(*) FILTER (WHERE (storage.foldername(name))[2] = 'cert-proofs'), count(*) FILTER (WHERE (storage.foldername(name))[2] IS DISTINCT FROM 'cert-proofs')
      INTO v_total_cp, v_total_other FROM storage.objects WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[1] = d::text;
    IF v_total_cp = 0 THEN v_skip := v_skip + 1; rpt := rpt || '   SKIP  no cert-proof files in this department' || chr(10); CONTINUE; END IF;
    -- the real owner of one proof: an active member, single-department email (impersonation reads only)
    SELECT m.id, lower(m.email) INTO v_owner, v_owner_email FROM public.members m
     WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
       AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'station-documents' AND (storage.foldername(o.name))[1] = d::text
                     AND (storage.foldername(o.name))[2] = 'cert-proofs' AND (storage.foldername(o.name))[3] = m.id::text)
       AND NOT m.access && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[]
     ORDER BY m.id LIMIT 1;
    BEGIN
      e_mem := tag || '-mem@retest.invalid'; e_da := tag || '-da@retest.invalid'; e_off := tag || '-off@retest.invalid';
      e_board := tag || '-board@retest.invalid'; e_pa := tag || '-pa@retest.invalid'; e_xda := tag || '-xda@retest.invalid';
      INSERT INTO public.members (department_id, name, email, access, status) VALUES
        (d, 'RETEST Member', e_mem, '{Member}', 'Active'), (d, 'RETEST DA', e_da, '{Department Admin}', 'Active'),
        (d, 'RETEST Officer', e_off, '{Officer}', 'Active'), (d, 'RETEST Board', e_board, '{Board Member}', 'Active'),
        (d, 'RETEST PA', e_pa, '{Project Admin}', 'Active'), (od, 'RETEST other-dept DA', e_xda, '{Department Admin}', 'Active');

      -- T1 plain member
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) FILTER (WHERE (storage.foldername(name))[2] = 'cert-proofs'), count(*) FILTER (WHERE (storage.foldername(name))[2] IS DISTINCT FROM 'cert-proofs')
        INTO v_n, v_n2 FROM storage.objects WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[1] = d::text;
      EXECUTE 'RESET ROLE';
      IF v_n = 0 AND v_n2 = v_total_other THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 a plain member sees 0 of %s cert-proofs and all %s other documents%s', v_total_cp, v_total_other, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 plain member sees %s cert-proofs (want 0), %s/%s other docs%s', v_n, v_n2, v_total_other, chr(10)); END IF;

      -- T2 the real owner
      IF v_owner IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || '   SKIP  T2 no single-department, non-leader member owns a proof here' || chr(10);
      ELSE
        SELECT count(*) INTO v_owner_cp FROM storage.objects WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[1] = d::text
           AND (storage.foldername(name))[2] = 'cert-proofs' AND (storage.foldername(name))[3] = v_owner::text;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_owner_email, 'role', 'authenticated')::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*), count(*) FILTER (WHERE (storage.foldername(name))[3] <> v_owner::text) INTO v_n, v_n2 FROM storage.objects
         WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[1] = d::text AND (storage.foldername(name))[2] = 'cert-proofs';
        EXECUTE 'RESET ROLE';
        IF v_n = v_owner_cp AND v_n2 = 0 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  T2 the real owner sees exactly their own %s proof file(s), nobody else''s%s', v_owner_cp, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 owner sees %s (own %s), others'' %s%s', v_n, v_owner_cp, v_n2, chr(10)); END IF;
      END IF;

      -- T3 leaders
      v_ok := true; v_err := '';
      FOREACH v_t IN ARRAY array[e_da, e_off, e_board, e_pa] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_t, 'role', 'authenticated')::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*) INTO v_n FROM storage.objects WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[1] = d::text
           AND (storage.foldername(name))[2] = 'cert-proofs';
        EXECUTE 'RESET ROLE';
        IF v_n <> v_total_cp THEN v_ok := false; v_err := v_err || format(' %s:%s', split_part(split_part(v_t, '-', 3), '@', 1), v_n); END IF;
      END LOOP;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 DA, Officer, Board and PA each see all %s cert-proofs%s', v_total_cp, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 leaders short of %s:%s%s', v_total_cp, v_err, chr(10)); END IF;

      -- T4 another department's leader
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_xda, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM storage.objects WHERE bucket_id = 'station-documents' AND (storage.foldername(name))[1] = d::text;
      EXECUTE 'RESET ROLE';
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T4 another department''s Department Admin sees none of this department''s files' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 other-department DA sees %s%s', v_n, chr(10)); END IF;

      -- T5 anon
      PERFORM set_config('request.jwt.claims', '', true);
      EXECUTE 'SET LOCAL ROLE anon';
      SELECT count(*) INTO v_n FROM storage.objects WHERE bucket_id = 'station-documents';
      EXECUTE 'RESET ROLE';
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T5 anon sees no objects' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 anon sees %s%s', v_n, chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after = v_ver_before THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  T6 verified count %s unchanged%s', v_ver_before, chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T6 verified count moved' || chr(10); END IF;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
