-- =====================================================================
-- RETEST for expirations_2026-10-18.sql (Phase 3.1 #4 DB). Run AFTER the migration, separately. NOTHING CHANGES: each department's
-- RAN on live 2026-10-18: 25 passed, 0 failed, 2 skipped — IH / Lipan / North Hood all 8/8 (IH M1 = 28 rows: the test member's
-- real certs + the fixtures); Demo + Granbury skip all (no plain members).
-- checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on FIXTURE rows it creates itself. The
-- final RAISE is the report. The "ERROR" IS the report.
--   E0 (once) anon can't execute; members can't execute the internal expiration_rows; member_credentials columns are
--      exactly the approved set (no number / scan / notes)
-- Per department (needs a DA and two plain members with unique emails and a live rig; an Officer and another
-- department's DA are used when present, else that check SKIPs):
--   W1 a plain member is refused EVERY write (all 7 RPCs)
--   W2 the DA records a license (class only), a med card, a fit test, two pieces of gear (one 10+ years in service), logs
--      an inspection (next = +1 year), and a pump test with a past next-due
--   W3 refused: an unknown kind / test type / result; a number typed as class; a test on a DELETED rig; another
--      department's DA writing or deleting this department's credential
--   O1 an Officer can write (DA / Officer — is_canmanage_ops())
--   D1 the dashboard (as the DA): every fixture in the right bucket (expired / no_date / soon / current); ranked
--      expired -> no_date -> soon -> current; a 'YYYY-MM' cert expires on the LAST day of that month; a blank-exp cert is
--      no_date; a cert_submissions row never appears; a deleted rig's test never appears
--   D2 honest denominator: an Inactive member's rows drop out of the dashboard
--   M1 my_expirations: only the caller's own rows (no other member's, no apparatus); a member is refused the dashboard
--   V1 RLS: B can't read A's credentials; A reads their own; a direct INSERT on each table is refused
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_e2 text; v_n int; v_m int; v_k int; v_ok boolean; v_t text; v_js jsonb;
  v_da text; v_off text; v_a text; v_b text; v_other_da text; v_a_id uuid; v_b_id uuid;
  v_rig uuid; v_dead uuid; v_lic uuid; v_med uuid; v_fit uuid; v_g_old uuid; v_g_new uuid; v_test uuid; v_cert_m uuid; v_cert_x uuid;
  v_today date := (now() at time zone 'America/Chicago')::date; v_ym text; v_month_end date;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- E0
  v_ok := true;
  FOREACH v_t IN ARRAY array['public.set_member_credential(uuid,uuid,text,text,text,date,date)', 'public.delete_member_credential(uuid)',
      'public.set_gear_item(uuid,uuid,text,date,date,date)', 'public.retire_gear_item(uuid)', 'public.log_gear_inspection(uuid,date)',
      'public.set_apparatus_test(uuid,uuid,text,date,date,text)', 'public.delete_apparatus_test(uuid)', 'public.dept_expirations()', 'public.my_expirations()'] LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN v_ok := false; END IF;
  END LOOP;
  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    BEGIN PERFORM * FROM public.expiration_rows(gen_random_uuid(), NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    PERFORM set_config('role', 'postgres', true);
  END;
  IF v_ok AND v_err ILIKE '%permission denied%'
     AND (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_credentials')
         = array['cls', 'created_at', 'created_by', 'department_id', 'expires_on', 'id', 'issued_on', 'kind', 'label', 'member_id', 'updated_at', 'updated_by'] THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  E0 grants right; internal read not callable; member_credentials = dates + class only%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  E0 grants %s internal "%s"%s', v_ok, v_err, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_a := NULL; v_b := NULL; v_other_da := NULL; v_a_id := NULL; v_b_id := NULL; v_rig := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
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
    SELECT lower(m.email) INTO v_other_da FROM public.members m WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL OR v_b IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and two plain members with unique emails (DA %s, A %s, B %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), coalesce(v_b, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- fixtures (owner): a live rig, a deleted rig, a 'YYYY-MM' cert (2 months out) + a blank-exp cert + a PENDING submission for A
      INSERT INTO public.apparatus (department_id, name, type, status, in_service, note) VALUES (rec.dept_id, 'RETEST rig', 'Pumper', 'Pass', true, 'RETEST') RETURNING id INTO v_rig;
      INSERT INTO public.apparatus (department_id, name, type, status, in_service, note) VALUES (rec.dept_id, 'RETEST retired rig', 'Tanker', 'Pass', true, 'RETEST') RETURNING id INTO v_dead;
      v_ym := to_char(v_today + interval '2 months', 'YYYY-MM');
      v_month_end := (date_trunc('month', v_today + interval '2 months') + interval '1 month - 1 day')::date;
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_a_id, 'RETEST cert month', v_ym) RETURNING id INTO v_cert_m;
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_a_id, 'RETEST cert undated', '') RETURNING id INTO v_cert_x;
      INSERT INTO public.cert_submissions (department_id, member_id, name, exp, status) VALUES (rec.dept_id, v_a_id, 'RETEST pending submission', to_char(v_today - interval '3 months', 'YYYY-MM'), 'pending');

      -- W1 a member is refused every write
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_n := 0;
      BEGIN PERFORM public.set_member_credential(NULL, v_a_id, 'license', 'Driver license', 'Class C', NULL, v_today + 100); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a Department Admin or Officer%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.delete_member_credential(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a Department Admin or Officer%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.set_gear_item(NULL, v_a_id, 'Coat', v_today - 100); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a Department Admin or Officer%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.retire_gear_item(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a Department Admin or Officer%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.log_gear_inspection(gen_random_uuid(), v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a Department Admin or Officer%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.set_apparatus_test(NULL, v_rig, 'pump', v_today, v_today + 365, 'pass'); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a Department Admin or Officer%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.delete_apparatus_test(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a Department Admin or Officer%' THEN v_n := v_n + 1; END IF; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 7 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  W1 a plain member is refused all 7 writes%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W1 refused %s of 7%s', v_n, chr(10)); END IF;

      -- W2 the DA records the fixtures
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN
        v_lic := (public.set_member_credential(NULL, v_a_id, 'license', 'RETEST driver license', 'Class C', v_today - 1000, v_today + 20)).id;   -- soon
        v_med := (public.set_member_credential(NULL, v_a_id, 'med_card', 'RETEST DOT med card', 'DOT', NULL, v_today - 5)).id;              -- expired
        v_fit := (public.set_member_credential(NULL, v_b_id, 'fit_test', 'RETEST SCBA fit test', NULL, v_today - 30, NULL)).id;              -- no_date
        v_g_old := (public.set_gear_item(NULL, v_a_id, 'RETEST coat (old)', (v_today - interval '10 years' - interval '10 days')::date, NULL, v_today + 200)).id;   -- expired (10-yr)
        v_g_new := (public.set_gear_item(NULL, NULL, 'RETEST pool helmet', v_today - 700, NULL, v_today + 100)).id;
        PERFORM public.log_gear_inspection(v_g_new, v_today);                                                                                -- next = +1 yr -> current
        v_test := (public.set_apparatus_test(NULL, v_rig, 'pump', v_today - 400, v_today - 35, 'pass')).id;                                  -- expired
        v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err = 'OK' AND (SELECT next_inspection_on FROM public.gear_items WHERE id = v_g_new) = (v_today + interval '1 year')::date
         AND (SELECT last_inspected_on FROM public.gear_items WHERE id = v_g_new) = v_today THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W2 DA records a license (class only), med card, fit test, two gear (inspection rolls +1 yr), a pump test%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W2 -> "%s"%s', v_err, chr(10)); END IF;

      -- W3 refusals
      UPDATE public.apparatus SET deleted_at = now() WHERE id = v_dead;
      PERFORM set_config('role', 'authenticated', true);
      v_n := 0;
      BEGIN PERFORM public.set_member_credential(NULL, v_a_id, 'passport', 'x', NULL); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      BEGIN PERFORM public.set_apparatus_test(NULL, v_rig, 'paint', v_today, NULL, 'pass'); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      BEGIN PERFORM public.set_apparatus_test(NULL, v_rig, 'ladder', v_today, NULL, 'great'); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      BEGIN PERFORM public.set_member_credential(NULL, v_a_id, 'license', 'Driver license', 'D1234567', NULL, v_today + 99); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Record the class and dates only%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.set_apparatus_test(NULL, v_dead, 'pump', v_today, NULL, 'pass'); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'That apparatus is not in your department%' THEN v_n := v_n + 1; END IF; END;
      v_e2 := 'n/a';
      IF v_other_da IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        v_k := 0;
        BEGIN PERFORM public.set_member_credential(NULL, v_a_id, 'license', 'x', NULL, NULL, v_today + 5); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'That member is not in your department%' THEN v_k := v_k + 1; END IF; END;
        BEGIN PERFORM public.set_member_credential(v_lic, v_a_id, 'license', 'hijack', NULL, NULL, v_today + 5); EXCEPTION WHEN OTHERS THEN v_k := v_k + 1; END;
        BEGIN PERFORM public.delete_member_credential(v_lic); EXCEPTION WHEN OTHERS THEN v_k := v_k + 1; END;
        v_e2 := v_k::text;
      END IF;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 5 AND (v_e2 = 'n/a' OR v_e2 = '3') AND (SELECT label FROM public.member_credentials WHERE id = v_lic) = 'RETEST driver license' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W3 bad kind / test type / result, a number as class, a deleted rig refused%s%s', CASE WHEN v_e2 = 'n/a' THEN '' ELSE '; another department''s DA refused write / edit / delete' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W3 refused %s of 5; cross-dept %s of 3%s', v_n, v_e2, chr(10)); END IF;

      -- O1 an Officer can write
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  O1 — no Officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.set_member_credential(NULL, v_b_id, 'other', 'RETEST officer-recorded', NULL, NULL, v_today + 400); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  O1 an Officer can record a credential%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  O1 -> "%s"%s', v_err, chr(10)); END IF;
      END IF;

      -- D1 the dashboard
      INSERT INTO public.apparatus_tests (department_id, apparatus_id, test_type, tested_on, next_due_on, result) VALUES (rec.dept_id, v_dead, 'ladder', v_today - 10, v_today + 5, 'pass');   -- on a deleted rig (owner)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      -- the rows, in the order the read returns them (WITH ORDINALITY), captured as the DA and checked as the owner
      SELECT coalesce(jsonb_agg(to_jsonb(e) || jsonb_build_object('ord', e.ord) ORDER BY e.ord), '[]'::jsonb) INTO v_js
        FROM public.dept_expirations() WITH ORDINALITY AS e(scope, source, item_id, member_id, apparatus_id, subject, kind, label, cls, expires_on, days_until, bucket, ord);
      PERFORM set_config('role', 'postgres', true);
      v_t := (SELECT string_agg((x->>'label') || '=' || (x->>'bucket'), ', ') FROM jsonb_array_elements(v_js) x
               WHERE (x->>'item_id')::uuid IN (v_lic, v_med, v_fit, v_g_old, v_g_new, v_test, v_cert_m, v_cert_x));
      v_ok := (SELECT x->>'bucket' FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_lic) = 'soon'
          AND (SELECT x->>'bucket' FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_med) = 'expired'
          AND (SELECT x->>'bucket' FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_fit) = 'no_date'
          AND (SELECT x->>'bucket' FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_g_old) = 'expired'
          AND (SELECT x->>'bucket' FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_g_new) = 'current'
          AND (SELECT x->>'bucket' FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_test) = 'expired'
          AND (SELECT x->>'bucket' FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_cert_x) = 'no_date'
          AND (SELECT (x->>'expires_on')::date FROM jsonb_array_elements(v_js) x WHERE (x->>'item_id')::uuid = v_cert_m) = v_month_end
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_js) x WHERE x->>'label' = 'RETEST pending submission')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_js) x WHERE (x->>'apparatus_id')::uuid = v_dead);
      -- ranking: no row may follow a row of a LATER-ranked bucket
      SELECT count(*) INTO v_n FROM (
        SELECT r, lag(r) OVER (ORDER BY ord) AS prev FROM (
          SELECT (x->>'ord')::int AS ord, CASE x->>'bucket' WHEN 'expired' THEN 0 WHEN 'no_date' THEN 1 WHEN 'soon' THEN 2 ELSE 3 END AS r
            FROM jsonb_array_elements(v_js) x) q) z WHERE z.prev > z.r;
      IF v_ok AND v_n = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  D1 buckets right; ranked expired > no_date > soon > current; YYYY-MM -> %s (month end); blank -> no_date; no submission; no deleted rig%s', v_month_end, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D1 buckets ok %s, out-of-order rows %s, fixtures: %s%s', v_ok, v_n, v_t, chr(10)); END IF;

      -- D2 honest denominator
      UPDATE public.members SET status = 'Inactive' WHERE id = v_b_id;
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.dept_expirations() e WHERE e.member_id = v_b_id;
      PERFORM set_config('role', 'postgres', true);
      UPDATE public.members SET status = 'Active' WHERE id = v_b_id;
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D2 an Inactive member''s rows drop out of the dashboard%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D2 Inactive member still has %s row(s)%s', v_n, chr(10)); END IF;

      -- M1 my_expirations
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*), count(*) FILTER (WHERE e.member_id IS DISTINCT FROM v_a_id), count(*) FILTER (WHERE e.item_id IN (v_lic, v_med, v_g_old, v_cert_m, v_cert_x))
        INTO v_n, v_m, v_k FROM public.my_expirations() e;
      BEGIN PERFORM * FROM public.dept_expirations(); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_m = 0 AND v_k = 5 AND v_err LIKE 'Only department leadership%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  M1 my_expirations = only A''s own (%s rows, incl. their certs + gear); a member is refused the dashboard%s', v_n, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M1 rows %s others %s own-fixtures %s of 5 dashboard "%s"%s', v_n, v_m, v_k, v_err, chr(10)); END IF;

      -- V1 RLS
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.member_credentials WHERE member_id = v_a_id;
      v_k := 0;
      BEGIN INSERT INTO public.member_credentials (department_id, member_id, kind, label) VALUES (rec.dept_id, v_b_id, 'other', 'x'); EXCEPTION WHEN OTHERS THEN IF SQLERRM ILIKE '%permission denied%' THEN v_k := v_k + 1; END IF; END;
      BEGIN INSERT INTO public.gear_items (department_id, label) VALUES (rec.dept_id, 'x'); EXCEPTION WHEN OTHERS THEN IF SQLERRM ILIKE '%permission denied%' THEN v_k := v_k + 1; END IF; END;
      BEGIN INSERT INTO public.apparatus_tests (department_id, apparatus_id, test_type, tested_on, result) VALUES (rec.dept_id, v_rig, 'hose', v_today, 'pass'); EXCEPTION WHEN OTHERS THEN IF SQLERRM ILIKE '%permission denied%' THEN v_k := v_k + 1; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      SELECT count(*) INTO v_m FROM public.member_credentials WHERE member_id = v_a_id;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 0 AND v_m = 2 AND v_k = 3 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  V1 B can''t read A''s credentials; A reads their own 2; direct INSERT refused on all three tables%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V1 B-sees-A %s A-own %s inserts-refused %s of 3%s', v_n, v_m, v_k, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
