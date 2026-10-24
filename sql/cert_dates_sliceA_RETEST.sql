-- =====================================================================
-- RETEST for cert_dates_sliceA (DRAFT, not applied) — run AFTER sql/cert_dates_sliceA_DRAFT.sql, separately.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). The final
-- RAISE is the report — the "ERROR" IS the report.
--   S0 (once) the columns + the two CHECKs exist exactly; cert_never_expires() follows the rule; update_cert is the 5-arg
--      signature only, definer, authenticated (no anon); the 8 reviewed md5s
--   S1 (once) the CHECKs bite: a no_expiry cert WITH an exp is refused; an achieved_on of '0000-00' is refused
--   L1 (once) existing rows: every live cert is no_expiry false / achieved_on NULL (nothing set before Slice B), and
--      expiration_rows reads no_expiry for exactly the effective-never-expires certs (0 today)
-- Per department (needs a Department Admin with a unique email and an auth user; synthetic rows on the DA's own member row):
--   N1 the readers, with four synthetic certs — F: no_expiry (no date) · T: a never-expires TYPE with an old date '2020-01' ·
--      B: BOTH (flag + the type) · X: a real expired '2020-01' (no type, no flag) — plus 'TBD' and '' rows for the qual-order
--      guard:
--        dept_cert_readiness  no_expiry +3, expired +1 (X only), no_date +2 (the TBD / '' rows) — B counted ONCE
--        my_department_rollup dept expired +1 / expiring 0; mine current +3 / expiring 0 / expired +1 — and no error
--        pa_department_radar  (as a Project Admin) expired +1 / expiring 0 — and no error
--        expiration_rows      F / T / B 'no_expiry'; X 'expired'
--   N2 probation_item_states: a cert item for 'RETEST NX' — satisfied ('current') by a no_expiry cert of that name alone
--      (SKIPPED with the reason if a synthetic onboarding item can't be cloned; the dry run is then the proof)
--   U1 update_cert as the DA:
--        3-arg legacy: '2027-06' stored, no_expiry false; '' clears the date and leaves no_expiry / achieved_on as they are
--        5-arg: no_expiry true + '2027-06' -> exp cleared, no_expiry true; achieved_on '2024-03' stored; '' clears it; NULL
--          leaves it; a 3-arg date on a no_expiry cert -> no_expiry false ("a date means expires")
--        refused: achieved_on in the future · after the expiry · '0000-00'; exp '2026-13'
--   A1 approve_cert_submission as the DA: a pending submission "doesn't expire" + '2027-06' + earned '2024-03' -> cert
--      no_expiry true, exp NULL, achieved '2024-03'; earned in the future / after the expiry / '0000-00' -> cleared; a valid
--      exp + earned before it -> both kept
--   P1 a plain member PROPOSES their own cert (through RLS, as themselves) with no_expiry + achieved_on -> the submission
--      persists both (SKIPPED if the department has no plain member with a unique email + auth user)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_ok boolean; v_n int; v_t text; e text; v_line text;
  v_da text; v_da_mid uuid; v_da_uid uuid; v_pa text; v_pa_uid uuid; v_mem text; v_mem_mid uuid; v_mem_uid uuid;
  v_type uuid; v_f uuid; v_tc uuid; v_b uuid; v_x uuid; v_c uuid; v_item uuid; v_sub uuid; v_new uuid;
  r0 record; r1 record; o0 record; o1 record; a0 record; a1 record;
  v_now text := to_char(now() at time zone 'America/Chicago', 'YYYY-MM');
  v_future text := to_char((now() at time zone 'America/Chicago') + interval '2 months', 'YYYY-MM');
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0 shape
  v_ok := (SELECT count(*) = 4 FROM pg_attribute WHERE attrelid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass)
             AND attname IN ('achieved_on', 'no_expiry') AND NOT attisdropped)
    AND (SELECT format_type(atttypid, atttypmod) = 'boolean' AND attnotnull FROM pg_attribute WHERE attrelid = 'public.certs'::regclass AND attname = 'no_expiry')
    AND (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.certs'::regclass AND conname IN ('certs_achieved_on_valid', 'certs_no_expiry_clears_exp'))
    AND public.cert_never_expires(true, NULL, NULL) AND NOT public.cert_never_expires(false, NULL, NULL) AND NOT public.cert_never_expires(NULL, NULL, NULL)
    AND to_regprocedure('public.update_cert(uuid,text,text)') IS NULL
    AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure)
    AND has_function_privilege('authenticated', 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.cert_never_expires(boolean,uuid,uuid)'::regprocedure, 'EXECUTE')
    AND (SELECT bool_and(md5(pg_get_functiondef(f::regprocedure)) = m) FROM (VALUES
          ('public.cert_never_expires(boolean,uuid,uuid)', '7c4083b586e650313b0009ed73d93764'), ('public.update_cert(uuid,text,text,boolean,text)', '88ae91805aff031e3debdb51a8b89eb9'),
          ('public.dept_cert_readiness()', 'a719cc34405ff25661c34a243fa35891'), ('public.expiration_rows(uuid,uuid)', '326ed08e0eea1d9c01703d965d4876a1'),
          ('public.probation_item_states(uuid,uuid)', 'ab5eebbcdc06fd7d0610c7ccf42d7a64'), ('public.pa_department_radar()', 'eb835b33d5dc8dae514b1d74af3de3c4'),
          ('public.my_department_rollup()', 'cd368f0fca832bbb0e804c939a7a9d10'), ('public.approve_cert_submission(uuid)', '768ae48c585469956f8048cdb6959a42')) t(f, m));
  -- the helper honours the type's department: a never-expires type of department X counts in X, not elsewhere
  INSERT INTO public.cert_types (department_id, name, never_expires) SELECT d.id, 'RETEST S0 type', true FROM public.departments d ORDER BY d.id LIMIT 1 RETURNING id INTO v_type;
  v_ok := v_ok AND public.cert_never_expires(false, v_type, (SELECT department_id FROM public.cert_types WHERE id = v_type))
               AND NOT public.cert_never_expires(false, v_type, (SELECT d.id FROM public.departments d ORDER BY d.id OFFSET 1 LIMIT 1));
  DELETE FROM public.cert_types WHERE id = v_type;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 columns + CHECKs; cert_never_expires() rule (flag OR same-department type — another department''s type doesn''t count); update_cert 5-arg only, definer, authenticated (no anon); the 8 reviewed md5s%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 shape / grants / md5s%s', chr(10)); END IF;

  -- S1 the CHECKs bite (one sub-block each; nothing is kept)
  v_n := 0;
  BEGIN
    INSERT INTO public.certs (department_id, member_id, name, exp, no_expiry) SELECT m.department_id, m.id, 'RETEST', '2027-06', true FROM public.members m LIMIT 1;
  EXCEPTION WHEN check_violation THEN IF SQLERRM LIKE '%certs_no_expiry_clears_exp%' THEN v_n := v_n + 1; END IF; END;
  BEGIN
    INSERT INTO public.certs (department_id, member_id, name, achieved_on) SELECT m.department_id, m.id, 'RETEST', '0000-00' FROM public.members m LIMIT 1;
  EXCEPTION WHEN check_violation THEN IF SQLERRM LIKE '%certs_achieved_on_valid%' THEN v_n := v_n + 1; END IF; END;
  IF v_n = 2 THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S1 the CHECKs refuse a no_expiry cert with an exp, and an achieved_on of ''0000-00''%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S1 %s of 2 CHECK refusals%s', v_n, chr(10)); END IF;

  -- L1 existing rows
  BEGIN
    SELECT count(*) FILTER (WHERE (x.bucket = 'no_expiry') IS DISTINCT FROM public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)), count(*) INTO v_n, e
      FROM public.departments d CROSS JOIN LATERAL public.expiration_rows(d.id, NULL) x JOIN public.certs c ON c.id = x.item_id WHERE x.source = 'cert';
    IF NOT EXISTS (SELECT 1 FROM public.certs WHERE no_expiry OR achieved_on IS NOT NULL) AND v_n = 0 THEN
      v_pass := v_pass + 1; rpt := rpt || format('PASS  L1 live: every cert no_expiry false / achieved_on NULL; expiration_rows no_expiry exactly for effective never-expires (all %s rostered certs agree)%s', e, chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  L1 live: %s disagree, or a cert already carries no_expiry / achieved_on%s', v_n, chr(10)); END IF;
  EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  L1 raised: %s%s', SQLERRM, chr(10)); END;

  SELECT lower(m.email), u.id INTO v_pa, v_pa_uid FROM public.members m JOIN auth.users u ON lower(u.email) = lower(m.email)
   WHERE m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary') ORDER BY m.id LIMIT 1;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_da_mid := NULL; v_da_uid := NULL; v_mem := NULL; v_mem_mid := NULL; v_mem_uid := NULL;
    SELECT lower(m.email), m.id, u.id INTO v_da, v_da_mid, v_da_uid FROM public.members m JOIN auth.users u ON lower(u.email) = lower(m.email)
     WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id, u.id INTO v_mem, v_mem_mid, v_mem_uid FROM public.members m JOIN auth.users u ON lower(u.email) = lower(m.email)
     WHERE m.department_id = rec.dept_id AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a Department Admin with a unique email and an auth user here%s', chr(10)); CONTINUE;
    END IF;
    BEGIN
      -- baselines
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'sub', v_da_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT * INTO r0 FROM public.dept_cert_readiness();
      SELECT * INTO o0 FROM public.my_department_rollup() x WHERE x.department_id = rec.dept_id;
      PERFORM set_config('role', 'postgres', true);
      a0 := NULL; e := NULL;
      IF v_pa IS NOT NULL THEN
        BEGIN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'sub', v_pa_uid, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          SELECT * INTO a0 FROM public.pa_department_radar() x WHERE x.department_id = rec.dept_id;
          PERFORM set_config('role', 'postgres', true);
        EXCEPTION WHEN OTHERS THEN a0 := NULL; e := SQLERRM; END;
      END IF;

      -- the synthetic certs: a never-expires type; F flag · T type + old date · B both · X real expired · 'TBD' · ''
      INSERT INTO public.cert_types (department_id, name, never_expires) VALUES (rec.dept_id, 'RETEST never-expires type', true) RETURNING id INTO v_type;
      INSERT INTO public.certs (department_id, member_id, name, exp, no_expiry) VALUES (rec.dept_id, v_da_mid, 'RETEST F', NULL, true) RETURNING id INTO v_f;
      INSERT INTO public.certs (department_id, member_id, name, exp, cert_type_id) VALUES (rec.dept_id, v_da_mid, 'RETEST T', '2020-01', v_type) RETURNING id INTO v_tc;
      INSERT INTO public.certs (department_id, member_id, name, exp, no_expiry, cert_type_id) VALUES (rec.dept_id, v_da_mid, 'RETEST B', NULL, true, v_type) RETURNING id INTO v_b;
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_da_mid, 'RETEST X', '2020-01') RETURNING id INTO v_x;
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_da_mid, 'RETEST tbd', 'TBD'), (rec.dept_id, v_da_mid, 'RETEST blank', '');

      -- N1 the readers
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'sub', v_da_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN
        SELECT * INTO r1 FROM public.dept_cert_readiness();
        SELECT * INTO o1 FROM public.my_department_rollup() x WHERE x.department_id = rec.dept_id;
        PERFORM set_config('role', 'postgres', true);
        IF r1.no_expiry - r0.no_expiry = 3 AND r1.expired - r0.expired = 1 AND r1.no_date - r0.no_date = 2 AND r1.expiring = r0.expiring AND r1."current" = r0."current"
           AND o1.expired_certs_count - o0.expired_certs_count = 1 AND o1.expiring_certs_count = o0.expiring_certs_count
           AND o1.my_certs_current - o0.my_certs_current = 3 AND o1.my_certs_expiring = o0.my_certs_expiring AND o1.my_certs_expired - o0.my_certs_expired = 1 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  N1 readiness no_expiry +3 (flag · type · both, once) / expired +1 (the real one) / no_date +2; rollup dept expired +1, mine current +3 / expired +1 — no error%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 readiness Δ no_expiry %s expired %s no_date %s expiring %s current %s · rollup Δ dept expired %s expiring %s · mine current %s expiring %s expired %s%s',
          r1.no_expiry - r0.no_expiry, r1.expired - r0.expired, r1.no_date - r0.no_date, r1.expiring - r0.expiring, r1."current" - r0."current",
          o1.expired_certs_count - o0.expired_certs_count, o1.expiring_certs_count - o0.expiring_certs_count,
          o1.my_certs_current - o0.my_certs_current, o1.my_certs_expiring - o0.my_certs_expiring, o1.my_certs_expired - o0.my_certs_expired, chr(10)); END IF;
      EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 readiness / rollup raised: %s%s', SQLERRM, chr(10)); END;
      PERFORM set_config('role', 'postgres', true);
      IF v_pa IS NULL OR a0 IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  N1 radar — no Project Admin with an auth user, or the baseline call failed (%s)%s', coalesce(e, 'no PA'), chr(10));
      ELSE
        BEGIN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'sub', v_pa_uid, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          SELECT * INTO a1 FROM public.pa_department_radar() x WHERE x.department_id = rec.dept_id;
          PERFORM set_config('role', 'postgres', true);
          IF a1.expired_certs_count - a0.expired_certs_count = 1 AND a1.expiring_certs_count = a0.expiring_certs_count THEN
            v_pass := v_pass + 1; rpt := rpt || format('   PASS  N1 radar: expired +1 (the real one only; the type''s old date no longer counts), expiring 0 — no error%s', chr(10));
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 radar Δ expired %s expiring %s%s', a1.expired_certs_count - a0.expired_certs_count, a1.expiring_certs_count - a0.expiring_certs_count, chr(10)); END IF;
        EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 radar raised: %s%s', SQLERRM, chr(10)); END;
        PERFORM set_config('role', 'postgres', true);
      END IF;
      BEGIN
        SELECT string_agg(x.label || '=' || x.bucket, ' ' ORDER BY x.label) INTO v_t FROM public.expiration_rows(rec.dept_id, v_da_mid) x WHERE x.item_id IN (v_f, v_tc, v_b, v_x);
        IF v_t = 'RETEST B=no_expiry RETEST F=no_expiry RETEST T=no_expiry RETEST X=expired' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  N1 expiration_rows: flag / type / both no_expiry, the real expired one expired%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 expiration_rows: %s%s', coalesce(v_t, 'nothing'), chr(10)); END IF;
      EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 expiration_rows raised: %s%s', SQLERRM, chr(10)); END;

      -- N2 probation: clone an existing onboarding item as a 'cert' item for 'RETEST NX'
      v_item := NULL; e := 'no onboarding item exists to clone';
      BEGIN
        INSERT INTO public.onboarding_items
        SELECT (jsonb_populate_record(NULL::public.onboarding_items, to_jsonb(o) || jsonb_build_object('id', gen_random_uuid(), 'department_id', rec.dept_id,
                 'kind', 'cert', 'cert_name', 'RETEST NX', 'label', 'RETEST cert item', 'is_mentor', false, 'hours_target', NULL, 'hours_source', NULL,
                 'ack_series_id', NULL, 'approver_kind', NULL, 'approver_member_id', NULL, 'approver_role', NULL))).*
          FROM public.onboarding_items o ORDER BY o.id LIMIT 1
        RETURNING id INTO v_item;
      EXCEPTION WHEN OTHERS THEN e := SQLERRM; v_item := NULL; END;
      IF v_item IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  N2 probation — a synthetic cert item could not be cloned (%s); the dry run is the proof%s', e, chr(10));
      ELSE
        BEGIN
          SELECT x.state INTO v_t FROM public.probation_item_states(v_da_mid, rec.dept_id) x WHERE x.item_id = v_item;
          INSERT INTO public.certs (department_id, member_id, name, no_expiry) VALUES (rec.dept_id, v_da_mid, 'RETEST NX', true);
          SELECT v_t || '/' || x.state INTO v_t FROM public.probation_item_states(v_da_mid, rec.dept_id) x WHERE x.item_id = v_item;
          IF v_t = 'missing/current' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  N2 probation: missing, then current from a no_expiry cert alone%s', chr(10));
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N2 probation states: %s (want missing/current)%s', coalesce(v_t, 'null'), chr(10)); END IF;
        EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N2 probation raised: %s%s', SQLERRM, chr(10)); END;
      END IF;

      -- U1 update_cert as the DA, on a fresh plain cert
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_da_mid, 'RETEST U', '2025-01') RETURNING id INTO v_c;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'sub', v_da_uid, 'role', 'authenticated')::text, true);
      v_n := 0; v_t := '';
      BEGIN
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.update_cert(v_c, 'RETEST U', '2027-06');                                              -- legacy 3-arg
        PERFORM set_config('role', 'postgres', true);
        SELECT exp = '2027-06' AND NOT no_expiry AND achieved_on IS NULL INTO v_ok FROM public.certs WHERE id = v_c; IF v_ok THEN v_n := v_n + 1; ELSE v_t := v_t || ' [3-arg date]'; END IF;
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.update_cert(v_c, 'RETEST U', '2027-06', true, '2024-03');                             -- doesn't expire + earned
        PERFORM set_config('role', 'postgres', true);
        SELECT exp IS NULL AND no_expiry AND achieved_on = '2024-03' INTO v_ok FROM public.certs WHERE id = v_c; IF v_ok THEN v_n := v_n + 1; ELSE v_t := v_t || ' [no_expiry clears exp + earned]'; END IF;
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.update_cert(v_c, 'RETEST U', '');                                                     -- legacy blank: keeps the flag + earned
        PERFORM set_config('role', 'postgres', true);
        SELECT exp IS NULL AND no_expiry AND achieved_on = '2024-03' INTO v_ok FROM public.certs WHERE id = v_c; IF v_ok THEN v_n := v_n + 1; ELSE v_t := v_t || ' [3-arg blank keeps]'; END IF;
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.update_cert(v_c, 'RETEST U', '2028-02');                                              -- legacy date on a no_expiry cert
        PERFORM set_config('role', 'postgres', true);
        SELECT exp = '2028-02' AND NOT no_expiry AND achieved_on = '2024-03' INTO v_ok FROM public.certs WHERE id = v_c; IF v_ok THEN v_n := v_n + 1; ELSE v_t := v_t || ' [a date means expires]'; END IF;
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.update_cert(v_c, 'RETEST U', '2028-02', NULL, '');                                    -- '' clears earned
        PERFORM set_config('role', 'postgres', true);
        SELECT exp = '2028-02' AND achieved_on IS NULL INTO v_ok FROM public.certs WHERE id = v_c; IF v_ok THEN v_n := v_n + 1; ELSE v_t := v_t || ' [blank clears earned]'; END IF;
      EXCEPTION WHEN OTHERS THEN v_t := v_t || ' [raised: ' || SQLERRM || ']'; END;
      PERFORM set_config('role', 'authenticated', true);
      FOREACH e IN ARRAY array[v_future || '|2028-02|Achievement date can''t be in the future.', '2021-05|2020-01|Achievement date can''t be after the expiration.',
                               '0000-00|2028-02|Achievement date must be a real month as YYYY-MM (e.g. 2024-03).', '2024-03|2026-13|Expiration must be a real month as YYYY-MM (e.g. 2027-06).'] LOOP
        BEGIN PERFORM public.update_cert(v_c, 'RETEST U', split_part(e, '|', 2), false, split_part(e, '|', 1)); v_t := v_t || format(' [%s accepted]', e);
        EXCEPTION WHEN OTHERS THEN IF SQLERRM = split_part(e, '|', 3) THEN v_n := v_n + 1; ELSE v_t := v_t || format(' [%s: %s]', e, SQLERRM); END IF; END;
      END LOOP;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 9 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  U1 update_cert: 3-arg legacy unchanged; no_expiry clears the date; a date means expires; earned set / kept / cleared; future / after-expiry / ''0000-00'' / bad exp refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  U1 update_cert %s of 9:%s%s', v_n, v_t, chr(10)); END IF;

      -- A1 approve_cert_submission as the DA
      BEGIN
        v_t := ''; v_n := 0;
        FOREACH e IN ARRAY array['t|2027-06|2024-03|NULL|2024-03', 'f|2027-06|' || v_future || '|2027-06|NULL', 'f|2020-01|2021-05|2020-01|NULL',
                                 'f|2027-06|0000-00|2027-06|NULL', 'f|2027-06|2024-03|2027-06|2024-03'] LOOP
          INSERT INTO public.cert_submissions (department_id, member_id, name, exp, no_expiry, achieved_on, status, source, proposed_by, proof_path)
          VALUES (rec.dept_id, v_da_mid, 'RETEST sub', split_part(e, '|', 2), split_part(e, '|', 1) = 't', split_part(e, '|', 3), 'pending', 'manual', v_da_uid, 'retest/none')
          RETURNING id INTO v_sub;
          PERFORM set_config('role', 'authenticated', true);
          SELECT public.approve_cert_submission(v_sub) INTO v_new;
          PERFORM set_config('role', 'postgres', true);
          SELECT coalesce(c.exp, 'NULL') || '|' || coalesce(c.achieved_on, 'NULL') || '|' || c.no_expiry INTO v_line FROM public.certs c WHERE c.id = v_new;
          IF v_line = split_part(e, '|', 4) || '|' || split_part(e, '|', 5) || '|' || (split_part(e, '|', 1) = 't') THEN v_n := v_n + 1; ELSE v_t := v_t || format(' [%s -> %s]', e, v_line); END IF;
        END LOOP;
        IF v_n = 5 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  A1 approve: "doesn''t expire" lands with no date; earned future / after-expiry / ''0000-00'' cleared; valid kept%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 approve %s of 5:%s%s', v_n, v_t, chr(10)); END IF;
      EXCEPTION WHEN OTHERS THEN PERFORM set_config('role', 'postgres', true); v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 approve raised: %s%s', SQLERRM, chr(10)); END;

      -- P1 a plain member proposes their own cert, through RLS
      IF v_mem IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  P1 propose — no plain member with a unique email and an auth user here%s', chr(10));
      ELSE
        BEGIN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'sub', v_mem_uid, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          INSERT INTO public.cert_submissions (department_id, member_id, name, exp, no_expiry, achieved_on, status, source, proposed_by, proof_path)
          VALUES (rec.dept_id, v_mem_mid, 'RETEST proposal', NULL, true, '2023-11', 'pending', 'self', v_mem_uid, 'retest/proof') RETURNING id INTO v_sub;
          PERFORM set_config('role', 'postgres', true);
          SELECT no_expiry AND achieved_on = '2023-11' INTO v_ok FROM public.cert_submissions WHERE id = v_sub;
          IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  P1 a plain member''s own proposal persists no_expiry + achieved_on through the existing INSERT policy%s', chr(10));
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P1 the proposal did not persist both fields%s', chr(10)); END IF;
        EXCEPTION WHEN OTHERS THEN PERFORM set_config('role', 'postgres', true); v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P1 propose raised: %s%s', SQLERRM, chr(10)); END;
      END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  the department block raised: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION '%', format('%s passed, %s failed, %s skipped%s', v_pass, v_fail, v_skip, rpt);
END
$retest$;
