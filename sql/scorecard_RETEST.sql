-- =====================================================================
-- RETEST for scorecard_2026-10-19.sql (Phase 3.1 #5 DB, rev 2). Run AFTER the migration, separately. NOTHING CHANGES: each department's checks
-- RAN on live 2026-10-19: 20 passed, 0 failed, 2 skipped — S0 + W0 pass; IH (37 counted) / Lipan (28) / North Hood (27) all
-- 6/6 incl. V1 "Ready, renewals due" + P1 honest counts; Demo + Granbury skip all (no plain members).
-- run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on FIXTURE requirements / a fixture qualification
-- type / a fixture document / fixture credentials it creates itself. The final RAISE is the report. The "ERROR" IS the report.
--   S0 (once) anon can't execute; members can't execute the internal helpers; a 'cert' kind is refused by the table
--   W0 (once) the window: readiness_window matches shared/expiry.js + certStatus() for every month -2..+8
-- Per department (needs a DA and two plain members with unique emails; an Officer and another department's DA are used
-- when present, else that check SKIPs):
--   N1 no requirements -> 'not_set' (never ready / not ready), on the scorecard AND in the packet
--   C1 config: a member / an Officer refused (DA / PA only); the DA adds a qualification, a license and a document (by its
--      document id -> mapped to the series); a 'cert' kind, a ref on a credential kind, and another department's
--      qualification type are all refused
--   V1 verdict: nothing met -> not_ready naming all three; qualified + current license + signed -> ready; the license
--      expiring (within the badge window) -> STILL ready, listed in renewals_due ("Ready, renewals due"); undated /
--      expired -> not_ready with that status; required = false drops it
--   V2 certs are listed (with their window status) but never move the verdict
--   G1 gates: another member can't read A's scorecard; A reads their own; an Officer reads A's; another department's DA
--      can't; a member is refused the packet
--   P1 packet (as the DA): counted = an independent honest count; A is in it; the readiness counts add up; the fixture
--      qualification and document appear in the rollups; the expirations rollup has its four counts
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_e2 text; v_e3 text; v_n int; v_m int; v_k int; v_js jsonb; v_ok boolean; v_t text;
  v_da text; v_off text; v_a text; v_b text; v_other_da text; v_a_id uuid; v_b_id uuid; v_da_id uuid; v_other_dept uuid;
  v_qt uuid; v_other_qt uuid; v_doc uuid; v_series uuid; v_hash text; v_cred uuid; v_req_lic uuid;
  v_today date := (now() at time zone 'America/Chicago')::date; v_off_m int; v_exp date; v_want text; v_got text;
  SIG constant text := 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  v_ok := true;
  FOREACH v_t IN ARRAY array['public.set_readiness_requirement(text,uuid,boolean)', 'public.dept_readiness_requirements()', 'public.member_scorecard(uuid)', 'public.dept_readiness_packet()'] LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN v_ok := false; END IF;
  END LOOP;
  FOREACH v_t IN ARRAY array['public.readiness_window(text,date)', 'public.readiness_items(uuid,uuid)', 'public.readiness_verdict(uuid,uuid)'] LOOP
    IF has_function_privilege('authenticated', v_t, 'EXECUTE') THEN v_ok := false; END IF;
  END LOOP;
  -- a ref_id is supplied so ONLY the kind check can refuse it (a cert row without one would trip the ref check instead)
  BEGIN INSERT INTO public.readiness_requirements (department_id, kind, ref_id) SELECT id, 'cert', gen_random_uuid() FROM public.departments LIMIT 1; v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_ok AND v_err ILIKE '%readiness_requirements_kind_check%' THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 grants right; internal helpers not callable; a cert kind is refused by the table%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 grants %s; cert kind -> "%s"%s', v_ok, v_err, chr(10)); END IF;

  -- W0 the window, month by month, against the shared/expiry.js + certStatus() rule (diff < 0 expired, <= 3 soon, else current)
  v_n := 0; v_t := '';
  FOR v_off_m IN -2..8 LOOP
    v_exp := (date_trunc('month', v_today + make_interval(months => v_off_m)) + interval '1 month - 1 day')::date;
    v_got := public.readiness_window(CASE WHEN v_exp < v_today THEN 'expired' ELSE 'current' END, v_exp);
    v_want := CASE WHEN v_off_m < 0 THEN 'expired' WHEN v_off_m <= 3 THEN 'soon' ELSE 'current' END;
    IF v_got <> v_want THEN v_n := v_n + 1; v_t := v_t || format(' %s:%s/%s', v_off_m, v_got, v_want); END IF;
  END LOOP;
  IF v_n = 0 AND public.readiness_window('no_date', NULL) = 'no_date' THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  W0 the window matches shared/expiry.js for every month -2..+8 (and no_date stands)%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  W0 mismatches:%s%s', v_t, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_a := NULL; v_b := NULL; v_other_da := NULL; v_a_id := NULL; v_b_id := NULL; v_da_id := NULL; v_other_dept := NULL;
    SELECT lower(m.email), m.id INTO v_da, v_da_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_a, v_a_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_b, v_b_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.id IS DISTINCT FROM v_a_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_other_da, v_other_dept FROM public.members m WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL OR v_b IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and two plain members with unique emails (DA %s, A %s, B %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), coalesce(v_b, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- fixtures (owner): no requirements; a qualification type; a published required document; one in another department
      DELETE FROM public.readiness_requirements WHERE department_id = rec.dept_id;
      INSERT INTO public.qualification_types (department_id, name, kind) VALUES (rec.dept_id, 'RETEST readiness qual', 'position') RETURNING id INTO v_qt;
      IF v_other_dept IS NOT NULL THEN
        INSERT INTO public.qualification_types (department_id, name, kind) VALUES (v_other_dept, 'RETEST other-dept qual', 'position') RETURNING id INTO v_other_qt;
      END IF;
      INSERT INTO public.documents (department_id, name, type, storage_path, content_text)
      VALUES (rec.dept_id, 'RETEST readiness SOP', 'SOP', rec.dept_id || '/retest-' || gen_random_uuid() || '.pdf', 'Fixture.') RETURNING id, series_id INTO v_doc, v_series;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.set_document_ack_config(v_doc, true, NULL, false);

      -- N1 no requirements -> not_set
      v_js := public.member_scorecard(v_a_id);
      v_e2 := (public.dept_readiness_packet())->'readiness'->>'not_set';
      v_e3 := (public.dept_readiness_packet())->'readiness'->>'counted';
      PERFORM set_config('role', 'postgres', true);
      IF v_js->>'state' = 'not_set' AND v_e2 = v_e3 AND v_e3::int > 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  N1 no requirements -> not_set on the scorecard and for all %s in the packet%s', v_e3, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 state %s; packet not_set %s of %s%s', v_js->>'state', v_e2, v_e3, chr(10)); END IF;

      -- C1 config
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_readiness_requirement('credential_license', NULL, true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_e2 := 'n/a';
      IF v_off IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.set_readiness_requirement('credential_license', NULL, true); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM public.set_readiness_requirement('qualification_type', v_qt, true);
      v_req_lic := (public.set_readiness_requirement('credential_license', NULL, true)).id;
      PERFORM public.set_readiness_requirement('document', v_doc, true);   -- a DOCUMENT id: mapped to its series
      v_n := 0;
      BEGIN PERFORM public.set_readiness_requirement('cert', NULL, true); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Unknown requirement type%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.set_readiness_requirement('credential_med_card', v_qt, true); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'A credential requirement is the credential type itself%' THEN v_n := v_n + 1; END IF; END;
      IF v_other_qt IS NOT NULL THEN
        BEGIN PERFORM public.set_readiness_requirement('qualification_type', v_other_qt, true); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'That qualification is not set up%' THEN v_n := v_n + 1; END IF; END;
      ELSE v_n := v_n + 1; END IF;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only a Department Admin%' AND (v_e2 = 'n/a' OR v_e2 LIKE 'Only a Department Admin%') AND v_n = 3
         AND (SELECT count(*) FROM public.readiness_requirements WHERE department_id = rec.dept_id AND required) = 3
         AND EXISTS (SELECT 1 FROM public.readiness_requirements WHERE department_id = rec.dept_id AND kind = 'document' AND ref_id = v_series) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  C1 member%s refused; DA sets 3 requirements (document id -> series); cert kind / ref on a credential / other dept''s qual refused%s', CASE WHEN v_e2 = 'n/a' THEN '' ELSE ' + Officer' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C1 member "%s" officer "%s" bad-refused %s of 3%s', v_err, v_e2, v_n, chr(10)); END IF;

      -- V1 the verdict
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.member_scorecard(v_a_id);
      PERFORM set_config('role', 'postgres', true);
      v_t := v_js->>'state' || '/' || jsonb_array_length(v_js->'outstanding');
      -- meet everything: qualified (owner fixture row), a license 7 months out, the document signed (as A)
      INSERT INTO public.member_qualifications (member_id, department_id, qualification_type_id, signed_off_by) VALUES (v_a_id, rec.dept_id, v_qt, v_da_id);
      INSERT INTO public.member_credentials (department_id, member_id, kind, label, cls, expires_on) VALUES (rec.dept_id, v_a_id, 'license', 'RETEST license', 'Class C', (v_today + interval '7 months')::date) RETURNING id INTO v_cred;
      PERFORM set_config('role', 'authenticated', true);
      SELECT q.content_hash INTO v_hash FROM public.my_read_sign_queue() q WHERE q.series_id = v_series;
      PERFORM public.acknowledge_document(v_doc, 1, v_hash, SIG);
      v_e2 := (public.member_scorecard(v_a_id))->>'state';
      PERFORM set_config('role', 'postgres', true);
      -- the license expiring (within the window) / undated / expired
      UPDATE public.member_credentials SET expires_on = v_today + 20 WHERE id = v_cred;
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.member_scorecard(v_a_id);
      v_e3 := v_js->>'state' || '/' || (SELECT x->>'status' FROM jsonb_array_elements(v_js->'items') x WHERE x->>'kind' = 'credential_license')
              || '/renewals:' || jsonb_array_length(v_js->'renewals_due');
      PERFORM set_config('role', 'postgres', true);
      UPDATE public.member_credentials SET expires_on = NULL WHERE id = v_cred;
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.member_scorecard(v_a_id);
      v_e3 := v_e3 || ',' || (v_js->>'state') || '/' || (SELECT x->>'status' FROM jsonb_array_elements(v_js->'items') x WHERE x->>'kind' = 'credential_license');
      PERFORM set_config('role', 'postgres', true);
      UPDATE public.member_credentials SET expires_on = v_today - 5 WHERE id = v_cred;
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.member_scorecard(v_a_id);
      v_e3 := v_e3 || ',' || (v_js->>'state') || '/' || (SELECT x->>'status' FROM jsonb_array_elements(v_js->'items') x WHERE x->>'kind' = 'credential_license');
      -- required = false drops it from the count
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM public.set_readiness_requirement('credential_license', NULL, false);
      v_js := public.member_scorecard(v_a_id);
      PERFORM set_config('role', 'postgres', true);
      IF v_t = 'not_ready/3' AND v_e2 = 'ready' AND v_e3 = 'ready/expiring/renewals:1,not_ready/no_date,not_ready/expired'
         AND v_js->>'state' = 'ready' AND (v_js->>'required')::int = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  V1 not_ready naming 3 -> ready; license expiring -> ready + renewals due; no_date / expired -> not_ready; required=false drops it%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V1 start %s met %s license %s after-drop %s/%s%s', v_t, v_e2, v_e3, v_js->>'state', v_js->>'required', chr(10)); END IF;

      -- V2 certs listed, never the verdict
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_a_id, 'RETEST expired cert', to_char(v_today - interval '3 months', 'YYYY-MM'));
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.member_scorecard(v_a_id);
      PERFORM set_config('role', 'postgres', true);
      IF v_js->>'state' = 'ready' AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_js->'certs') x WHERE x->>'label' = 'RETEST expired cert' AND x->>'status' = 'expired') THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  V2 an expired cert is listed (status expired) but the verdict stays ready%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V2 state %s certs %s%s', v_js->>'state', v_js->'certs', chr(10)); END IF;

      -- G1 gates
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.member_scorecard(v_a_id); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.dept_readiness_packet(); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      v_e3 := 'n/a'; v_t := 'n/a';
      IF v_off IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        BEGIN v_e3 := (public.member_scorecard(v_a_id))->>'state'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      END IF;
      IF v_other_da IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.member_scorecard(v_a_id); v_t := 'OK'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
      END IF;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only department leadership can see another member%' AND v_e2 = 'Only department leadership can open the readiness packet.' AND (v_e3 = 'n/a' OR v_e3 = 'ready')
         AND (v_t = 'n/a' OR v_t LIKE 'That member is not in your department%') THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  G1 another member refused; member refused the packet%s%s%s', CASE WHEN v_e3 = 'n/a' THEN '' ELSE '; Officer reads A' END, CASE WHEN v_t = 'n/a' THEN '' ELSE '; other dept''s DA refused' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G1 B "%s" packet "%s" officer "%s" other-DA "%s"%s', v_err, v_e2, v_e3, v_t, chr(10)); END IF;

      -- P1 the packet
      SELECT count(*) INTO v_m FROM public.members m WHERE m.department_id = rec.dept_id AND m.status IN ('Active', 'Probationary')
         AND NOT coalesce(m.access && array['Project Admin']::text[], false) AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.dept_readiness_packet();
      PERFORM set_config('role', 'postgres', true);
      v_ok := (v_js->'readiness'->>'counted')::int = v_m
          AND (v_js->'readiness'->>'ready')::int + (v_js->'readiness'->>'not_ready')::int + (v_js->'readiness'->>'not_set')::int = v_m
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_js->'members') x WHERE (x->>'member_id')::uuid = v_a_id AND x->>'state' = 'ready')
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_js->'qualifications') x WHERE x->>'name' = 'RETEST readiness qual' AND (x->>'qualified')::int >= 1)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_js->'acknowledgments') x WHERE x->>'title' = 'RETEST readiness SOP')
          AND v_js->'expirations' ?& array['expired', 'no_date', 'expiring', 'current']
          AND (v_js->>'standard_set')::boolean;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  P1 packet: %s counted = honest count; A ready; rollups carry the fixture qual + document; expirations has its 4 counts%s', v_m, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P1 counted %s vs %s; readiness %s%s', v_js->'readiness'->>'counted', v_m, v_js->'readiness', chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
