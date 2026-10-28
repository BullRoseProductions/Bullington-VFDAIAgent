-- =====================================================================
-- RETEST for ws5_public_rls (WS-5 part 1). READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Per department, the whole check lives in a sub-block ending in RAISE 'SENTINEL' (rolled back). NOTHING CHANGES.
-- Once:
--   O1 anon holds no ACL entry on any public relation / sequence; no {public} or {anon} policy is left in public
--   O2 the 19 policies are TO authenticated with their USING / WITH CHECK md5 identical to the pins
--   O3 authenticated's and service_role's privilege matrices = the pins; the default ACLs grant anon nothing; postgres's
--      global function default has no PUBLIC entry
-- Per department (a REAL Department Admin and a REAL member, as authenticated):
--   T1 every one of the 56 relations returns the SAME row count (errors included) as with the 19 policies temporarily
--      put back TO public inside the rolled-back block — the roles change moves nothing for a real member or DA
--   T2 anon is refused (42501) on all 56
--   T3 station_presence byte-identical; verified unchanged
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_ok boolean; v_t text; r record;
  c_rels constant text[] := ARRAY['action_items', 'ai_feedback', 'ai_outputs', 'announcements', 'apparatus', 'apparatus_check_items', 'apparatus_check_results', 'apparatus_checks', 'apparatus_maintenance', 'apparatus_photos', 'apparatus_service_periods', 'cert_submissions', 'cert_types', 'certs', 'content_calendar', 'departments', 'documents', 'drill_plans', 'duties', 'duty_log', 'equipment', 'equipment_custody', 'equipment_handoff', 'equipment_handoff_items', 'equipment_issue_batch', 'equipment_issues', 'equipment_manager', 'equipment_photos', 'equipment_type', 'events', 'funding_events', 'fundraiser_log', 'maintenance', 'meetings', 'member_devices', 'member_notes', 'member_private', 'members', 'members_view', 'notification_prefs', 'notifications', 'onboarding_items', 'onboarding_progress', 'post_categories', 'profiles', 'push_subscriptions', 'recruitment_events', 'resources', 'session_attendance', 'session_plans', 'standard_cert_types', 'station_log', 'station_presence', 'training_officer', 'training_plans', 'training_sessions'];
  d uuid; dn text; v_who text; v_email text; v_rel text; v_val text; v_n bigint; v_now jsonb; v_then jsonb;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
                  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee IN ('anon'::regrole::oid, 0::oid))
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND roles && '{public,anon}'::name[]) THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 anon holds nothing on any public relation or sequence; no {public}/{anon} policy left' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 anon still holds a grant, or a {public}/{anon} policy is left' || chr(10); END IF;

  v_ok := true;
  FOR r IN SELECT * FROM (VALUES
      ('action_items', 'leaders can read action_items', 'fb0895d133d5c4f27e407a628e517f7b', '6bc7e77ed4ffcc0986bf2545eb3180c1'),
      ('ai_feedback', 'leaders can read ai_feedback', '2226e4850f341e4cca8e54f6a40b7c48', '6bc7e77ed4ffcc0986bf2545eb3180c1'),
      ('ai_outputs', 'dept reads ai_outputs', '7e881c6dcccbf5819f46285ed35d4519', 'faa12de96e5e67a68845806bddedfb23'),
      ('certs', 'Leaders read all certs', 'c8d594221ad7249b27e5530836f1a46f', '6bc7e77ed4ffcc0986bf2545eb3180c1'),
      ('content_calendar', 'authenticated can read content_calendar', '76adc646fd3e42ce6b2848082121bc1b', 'faa12de96e5e67a68845806bddedfb23'),
      ('documents', 'authenticated can read documents', '65cd0ced16ade6788d756e39d076108b', 'faa12de96e5e67a68845806bddedfb23'),
      ('duties', 'authenticated can read duties', '6e6ed65eaaee0b9bc2bb11be5b4feeac', 'faa12de96e5e67a68845806bddedfb23'),
      ('equipment', 'da or manager manage equipment', '222b2a75b0c5716a6436a5de0fe2150e', 'bccc49398c78eab7a46089dfe756d6b0'),
      ('equipment', 'members read equipment', 'e6b10bbc3375823e5045c90110048891', 'faa12de96e5e67a68845806bddedfb23'),
      ('equipment_photos', 'da or manager manage equipment photos', '191d8255342dc0489aa957db734154e6', 'bccc49398c78eab7a46089dfe756d6b0'),
      ('equipment_photos', 'members read equipment photos', 'fcf3f1a55fa6d2b1d4a3b9d78782cca2', 'faa12de96e5e67a68845806bddedfb23'),
      ('equipment_type', 'da or manager manage equipment types', '966a116b301f3f64fadf1487f1190f53', 'bccc49398c78eab7a46089dfe756d6b0'),
      ('equipment_type', 'members read equipment types', '3870668e5cecb05d129fb2f2b85c1663', 'faa12de96e5e67a68845806bddedfb23'),
      ('events', 'authenticated can read events', 'a5ca268f581a0c7fafab99517b71948d', 'faa12de96e5e67a68845806bddedfb23'),
      ('maintenance', 'authenticated can read maintenance', '6aedc8f31a35bdf0271c9f5851f7859b', 'faa12de96e5e67a68845806bddedfb23'),
      ('meetings', 'leaders can read meetings', '03cbac40664a7b34d26d2da57c7f061c', '6bc7e77ed4ffcc0986bf2545eb3180c1'),
      ('members', 'leaders read members base table', '98393de0953d2ae84ae90c75576a6af5', '6bc7e77ed4ffcc0986bf2545eb3180c1'),
      ('onboarding_progress', 'leaders can read onboarding_progress', 'a8c4de2c41df0e3ada826362bfb33507', '6bc7e77ed4ffcc0986bf2545eb3180c1'),
      ('training_sessions', 'authenticated can read training_sessions', '8421473009c6a890befb4f8e5011c7a6', 'faa12de96e5e67a68845806bddedfb23')) v(tbl, name, md5, pred) LOOP
    SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) || '|' || p.roles::text INTO v_t
      FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = r.name;
    IF v_t IS DISTINCT FROM r.pred || '|{authenticated}' THEN v_ok := false; END IF;
  END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 the 19 policies: TO authenticated, predicates byte-identical to the pins' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 a flipped policy''s role or predicate is not as pinned' || chr(10); END IF;

  IF (SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type))
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 'authenticated'::regrole) = '34269436e943f9e0146f940c44a222ff' AND (SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type))
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 'service_role'::regrole) = '62597aaef6ee03b94682a71f101db36c'
     AND NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND a.grantee = 'anon'::regrole)
     AND EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f')
     AND NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f' AND a.grantee = 0) THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 authenticated / service_role privileges = the pins; defaults grant anon nothing; no PUBLIC function default' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 a privilege matrix or a default ACL is not as intended' || chr(10); END IF;

  FOR d, dn IN SELECT id, name FROM public.departments ORDER BY name LOOP
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      -- T1: counts now, then with the 19 policies put back TO public (rolled back with the block)
      v_now := '{}'::jsonb; v_then := '{}'::jsonb;
      FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
        IF v_who = 'DA' THEN SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_email; ELSE SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status = 'Active' AND NOT (coalesce(m.access, '{}') && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[])
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_email; END IF;
        IF v_email IS NULL THEN rpt := rpt || format('   (no real %s in this department — skipped)%s', v_who, chr(10)); CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        FOREACH v_rel IN ARRAY c_rels LOOP
          BEGIN EXECUTE format('SELECT count(*)::text FROM public.%I', v_rel) INTO v_val; EXCEPTION WHEN OTHERS THEN v_val := 'E:' || SQLSTATE; END;
          v_now := v_now || jsonb_build_object(v_who || '|' || v_rel, v_val);
        END LOOP;
        EXECUTE 'RESET ROLE';
      END LOOP;
      ALTER POLICY "leaders can read action_items" ON public."action_items" TO public;
      ALTER POLICY "leaders can read ai_feedback" ON public."ai_feedback" TO public;
      ALTER POLICY "dept reads ai_outputs" ON public."ai_outputs" TO public;
      ALTER POLICY "Leaders read all certs" ON public."certs" TO public;
      ALTER POLICY "authenticated can read content_calendar" ON public."content_calendar" TO public;
      ALTER POLICY "authenticated can read documents" ON public."documents" TO public;
      ALTER POLICY "authenticated can read duties" ON public."duties" TO public;
      ALTER POLICY "da or manager manage equipment" ON public."equipment" TO public;
      ALTER POLICY "members read equipment" ON public."equipment" TO public;
      ALTER POLICY "da or manager manage equipment photos" ON public."equipment_photos" TO public;
      ALTER POLICY "members read equipment photos" ON public."equipment_photos" TO public;
      ALTER POLICY "da or manager manage equipment types" ON public."equipment_type" TO public;
      ALTER POLICY "members read equipment types" ON public."equipment_type" TO public;
      ALTER POLICY "authenticated can read events" ON public."events" TO public;
      ALTER POLICY "authenticated can read maintenance" ON public."maintenance" TO public;
      ALTER POLICY "leaders can read meetings" ON public."meetings" TO public;
      ALTER POLICY "leaders read members base table" ON public."members" TO public;
      ALTER POLICY "leaders can read onboarding_progress" ON public."onboarding_progress" TO public;
      ALTER POLICY "authenticated can read training_sessions" ON public."training_sessions" TO public;
      FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
        IF v_who = 'DA' THEN SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_email; ELSE SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status = 'Active' AND NOT (coalesce(m.access, '{}') && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[])
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1 INTO v_email; END IF;
        IF v_email IS NULL THEN CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        FOREACH v_rel IN ARRAY c_rels LOOP
          BEGIN EXECUTE format('SELECT count(*)::text FROM public.%I', v_rel) INTO v_val; EXCEPTION WHEN OTHERS THEN v_val := 'E:' || SQLSTATE; END;
          v_then := v_then || jsonb_build_object(v_who || '|' || v_rel, v_val);
        END LOOP;
        EXECUTE 'RESET ROLE';
      END LOOP;
      SELECT count(*) INTO v_n FROM jsonb_object_keys(v_now) k WHERE (v_now->>k) <> '0' AND (v_now->>k) NOT LIKE 'E:%';
      IF v_now = v_then AND v_now <> '{}'::jsonb THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 %s relation reads as a real DA + member: identical with the policies TO authenticated or TO public (%s non-empty)%s', (SELECT count(*) FROM jsonb_object_keys(v_now)), v_n, chr(10));
      ELSIF v_now = '{}'::jsonb THEN v_skip := v_skip + 1; rpt := rpt || '   SKIP  T1 no real DA or member to read as' || chr(10);
      ELSE v_fail := v_fail + 1;
        SELECT string_agg(k || ' ' || (v_then->>k) || '->' || (v_now->>k), '; ') INTO v_t FROM (SELECT k FROM jsonb_object_keys(v_now) k WHERE (v_now->>k) IS DISTINCT FROM (v_then->>k) LIMIT 4) z;
        rpt := rpt || format('   FAIL  T1 reads differ: %s%s', v_t, chr(10)); END IF;
      -- T2: anon refused on all 56
      PERFORM set_config('request.jwt.claims', '', true);
      EXECUTE 'SET LOCAL ROLE anon';
      v_n := 0;
      FOREACH v_rel IN ARRAY c_rels LOOP
        BEGIN EXECUTE format('SELECT count(*) FROM public.%I', v_rel); v_n := v_n + 1; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      END LOOP;
      EXECUTE 'RESET ROLE';
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 anon refused on all 56 relations' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 anon could read %s relations%s', v_n, chr(10)); END IF;
      -- T3
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 station_presence byte-identical; verified %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T3 station_presence / verified changed' || chr(10); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
