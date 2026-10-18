-- =====================================================================
-- RETEST for read_sign_records_2026-10-18.sql (dept_signed_records). Run AFTER the migration, separately. NOTHING CHANGES: each
-- department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on a FIXTURE document it
-- creates itself — no real SOP is configured, published or signed. The final RAISE is the report. The "ERROR" IS the report.
-- Per department (needs a DA and two plain members with unique emails; Officer / Board / another department's DA
-- are used when present, else that check SKIPs):
--   K0 anon can't execute dept_signed_records (permission denied)
--   K1 a member is refused — the signer themself AND another member
--   K2 the DA gets the record, and the signature returned == the stored signature byte for byte (md5 + length too),
--      with the stored wording, fingerprint, version, title, signed_name snapshot and roster name
--   K3 an Officer gets the same record             K4 a Board Member gets the same record
--   K5 scope: p_document_id (live row) and the REPLACED row of the same series both return exactly that series' rows;
--      NULL includes it while it requires a signature and drops it once it doesn't (p_document_id still returns it)
--   K6 another department's DA: NULL returns nothing of this department; p_document_id = this department's doc refused
--   K7 fail closed: an unknown document id is refused
-- (Unchanged and still covered by sql/read_sign_RETEST.sql: a member reads only their own row; append-only; config.)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_n int; v_m int; v_hash text; v_ok boolean; r record; k public.document_acknowledgments%rowtype;
  v_da text; v_off text; v_board text; v_a text; v_b text; v_other_da text; v_a_id uuid; v_b_id uuid;
  v_doc uuid; v_doc2 uuid; v_series uuid; v_sig text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- K0 (once): anon can't execute
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('role', 'anon', true);
    BEGIN PERFORM * FROM public.dept_signed_records(NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    PERFORM set_config('role', 'postgres', true);
  END;
  IF v_err ILIKE '%permission denied%' AND NOT has_function_privilege('anon', 'public.dept_signed_records(uuid)', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  K0 anon can''t execute dept_signed_records%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  K0 anon -> "%s"%s', v_err, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_board := NULL; v_a := NULL; v_b := NULL; v_other_da := NULL; v_a_id := NULL; v_b_id := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin','Board Member']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_board FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Board Member']::text[]
       AND NOT m.access && array['Department Admin','Project Admin','Officer']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_a, v_a_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IS DISTINCT FROM 'Inactive' AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_b, v_b_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.id IS DISTINCT FROM v_a_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IS DISTINCT FROM 'Inactive' AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_da FROM public.members m WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL OR v_b IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and two plain members with unique emails (DA %s, A %s, B %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), coalesce(v_b, 'none'), chr(10));
      CONTINUE;
    END IF;

    BEGIN
      -- fixture: a document + its replacement (same series), turned on by the DA, signed by A with a unique signature
      INSERT INTO public.documents (department_id, name, type, storage_path, content_text)
      VALUES (rec.dept_id, 'RETEST records SOP', 'SOP', rec.dept_id || '/retest-' || gen_random_uuid() || '.pdf', 'Fixture text for the signed-records retest.')
      RETURNING id, series_id INTO v_doc, v_series;
      INSERT INTO public.documents (department_id, name, type, storage_path, content_text)
      VALUES (rec.dept_id, 'RETEST records SOP', 'SOP', rec.dept_id || '/retest-' || gen_random_uuid() || '.pdf', 'Fixture text, corrected.')
      RETURNING id INTO v_doc2;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.replace_document(v_doc, v_doc2);
      PERFORM public.set_document_ack_config(v_doc2, true, NULL, false);
      PERFORM set_config('role', 'postgres', true);
      SELECT content_hash INTO v_hash FROM public.document_versions WHERE series_id = v_series AND version = 1;
      v_sig := 'data:image/png;base64,' || md5(random()::text) || md5(random()::text) || md5(clock_timestamp()::text);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.acknowledge_document(v_doc2, 1, v_hash, v_sig);

      -- K1 members refused: the signer and another member
      BEGIN PERFORM * FROM public.dept_signed_records(NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      BEGIN PERFORM * FROM public.dept_signed_records(v_doc2); v_hash := 'OK'; EXCEPTION WHEN OTHERS THEN v_hash := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only department leadership%' AND v_hash LIKE 'Only department leadership%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K1 members refused (the signer and another member)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K1 signer "%s" other "%s"%s', v_err, v_hash, chr(10)); END IF;

      -- K2 / K3 / K4 leadership gets A's record, byte-for-byte equal to the stored row (compared as the owner)
      SELECT * INTO k FROM public.document_acknowledgments WHERE member_id = v_a_id AND series_id = v_series AND version = 1;   -- stored, as the owner
      FOR r IN SELECT * FROM (VALUES ('K2', 'DA', v_da), ('K3', 'Officer', v_off), ('K4', 'Board Member', v_board)) t(k, who, em) LOOP
        IF r.em IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  %s — no %s with a unique email%s', r.k, r.who, chr(10)); CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', r.em, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN
          SELECT count(*) FILTER (WHERE g.member_id = v_a_id AND g.version = 1
                   AND g.signature_data = k.signature_data AND g.signature_data = v_sig AND md5(g.signature_data) = md5(v_sig)
                   AND length(g.signature_data) = length(v_sig)
                   AND g.ack_statement = k.ack_statement AND g.ack_statement = 'I have read and understand RETEST records SOP (v1) and agree to comply.'
                   AND g.content_hash = k.content_hash AND g.title = k.title AND g.signed_name = k.signed_name AND g.signed_at = k.signed_at
                   AND g.name = (SELECT x.name FROM public.members x WHERE x.id = v_a_id)),
                 count(*)
            INTO v_n, v_m FROM public.dept_signed_records(NULL) g WHERE g.series_id = v_series;
          v_err := 'OK';
        EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; v_m := NULL; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' AND v_n = 1 AND v_m = 1 AND k.signature_data = v_sig THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  %s %s gets the record; signature == stored (byte for byte), wording, fingerprint, name%s', r.k, r.who, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  %s %s -> "%s", matching rows %s, series rows %s%s', r.k, r.who, v_err, v_n, v_m, chr(10)); END IF;
      END LOOP;

      -- K5 scope
      SELECT count(*) INTO v_m FROM public.document_acknowledgments WHERE series_id = v_series;   -- the truth, as the owner
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*), bool_and(g.series_id = v_series) INTO v_n, v_ok FROM public.dept_signed_records(v_doc2) g;
      v_err := format('live %s/%s', v_n, v_ok);
      SELECT count(*), bool_and(g.series_id = v_series) INTO v_n, v_ok FROM public.dept_signed_records(v_doc) g;   -- the replaced row
      v_err := v_err || format(' replaced %s/%s', v_n, v_ok);
      v_ok := (v_err = format('live %s/%s replaced %s/%s', v_m, true, v_m, true));
      PERFORM set_config('role', 'postgres', true);
      UPDATE public.document_series SET requires_ack = false WHERE series_id = v_series;
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.dept_signed_records(NULL) g WHERE g.series_id = v_series;
      SELECT count(*) INTO v_hash FROM public.dept_signed_records(v_doc2) g;
      PERFORM set_config('role', 'postgres', true);
      UPDATE public.document_series SET requires_ack = true WHERE series_id = v_series;
      IF v_ok AND v_n = 0 AND v_hash::int = v_m THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K5 scope: by document (live or replaced row) = that series (%s); NULL = required only%s', v_m, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K5 %s (truth %s); not-required via NULL %s, via doc %s%s', v_err, v_m, v_n, v_hash, chr(10)); END IF;

      -- K6 another department's DA
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  K6 — no other-department DA%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN
          SELECT count(*) INTO v_n FROM public.dept_signed_records(NULL) g
           WHERE g.series_id = v_series OR g.member_id IN (SELECT id FROM public.members WHERE department_id = rec.dept_id);
          v_err := 'OK';
        EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
        BEGIN PERFORM * FROM public.dept_signed_records(v_doc2); v_hash := 'OK'; EXCEPTION WHEN OTHERS THEN v_hash := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' AND v_n = 0 AND v_hash LIKE 'That document isn''t in your department%' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  K6 another department''s DA gets nothing; this department''s doc refused%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K6 all -> "%s" rows of this dept %s; by doc -> "%s"%s', v_err, v_n, v_hash, chr(10)); END IF;
      END IF;

      -- K7 fail closed on an unknown document
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM * FROM public.dept_signed_records(gen_random_uuid()); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'That document isn''t in your department%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  K7 unknown document refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K7 -> "%s"%s', v_err, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
