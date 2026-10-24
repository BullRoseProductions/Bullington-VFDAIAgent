-- =====================================================================
-- RETEST for cert_expiry_valid_ym (DRAFT, not applied) — run AFTER sql/cert_expiry_valid_ym_DRAFT.sql, separately. It reads
-- its own synthetic rows (L1 also reads the live ones — after the migration there are no malformed live rows left).
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). The final
-- RAISE is the report — the "ERROR" IS the report.
--   S0 (once) valid_exp_ym(): the validExpYM truth table (incl. NULL -> false, full-width digits -> false); IMMUTABLE, invoker,
--      no SET clause, and INLINED in a plan; authenticated-only (no anon)
--   S1 (once) the 8 reviewed md5s (helper + the 7) and no shape-only / year-less cert regex left in the 6 readers / update_cert
--   L1 (once) the LIVE data: every cert of every department — expiration_rows says no_date exactly when the exp is not a valid
--      month (never-expires types excepted), and computes a date for every valid one
-- Per department (needs a Department Admin with a unique email and an auth user; synthetic certs on the DA's own member row,
-- so the rollup's "mine" columns move too):
--   G1 dept_cert_readiness(): 9 garbage certs ('0000-00', '2026-13', '2026-00', '0000-01', '1899-12', '2026-09-15', 'TBD', '',
--      NULL) add exactly 9 to no_date and nothing to expired / expiring / current; a real past month +1 expired, next month
--      +1 expiring, a year out +1 current  (before the fix '0000-00' / '0000-01' / '1899-12' / '2026-00' counted EXPIRED)
--   G2 my_department_rollup() (as the DA): leadership expired +1 / expiring +1; mine current +1 / expiring +1 / expired +1 —
--      and no error from the '' / 'TBD' rows (the qual-order hazard the inlining guards)
--   G3 pa_department_radar() (as a Project Admin, this department's row): expired +1 / expiring +1, no error
--   G4 expiration_rows(dept, DA): each of the 9 garbage rows 'no_date'; past 'expired'; next month not expired / not no_date;
--      a year out 'current'
--   G5 probation_item_states(): a synthetic 'cert' onboarding item — '2026-13' / '0000-01' alone = missing, a valid month a
--      year out = current (SKIPPED with the reason if the item can't be inserted; the dry run is then the proof)
--   G6 a NEVER-EXPIRES type still wins: a synthetic never-expires cert type; certs of it dated '0000-00' and a real PAST month
--      read no_expiry (+2 no_expiry in readiness, nothing in expired / no_date) and 'no_expiry' in expiration_rows (SKIPPED
--      with the reason if the type can't be inserted; the dry run is then the proof)
--   U1 update_cert() as the DA refuses '0000-00', '2026-13', '2026-00', '1899-12', '2026-09-15', 'TBD', ' 2027-06' with the
--      client's message; stores '2027-06'; '' and NULL clear to NULL
--   A1 approve_cert_submission() as the DA: pending submissions '0000-00', '2026-09-15', '' -> approved with exp NULL;
--      '2027-06' -> approved with '2027-06' (SKIPPED with the reason if a submission can't be inserted)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_ok boolean; v_n int; v_t text; v_line text; v_plan text := ''; e text;
  v_da text; v_da_mid uuid; v_da_uid uuid; v_pa text; v_pa_uid uuid;
  ids uuid[]; v_id uuid; v_item uuid; v_sub uuid; v_new uuid; v_bad int;
  r0 record; r1 record; o0 record; o1 record; a0 record; a1 record;
  v_past text; v_next text; v_year text;
  GARBAGE constant text[] := array['0000-00', '2026-13', '2026-00', '0000-01', '1899-12', '2026-09-15', 'TBD', '', NULL];
  MSG constant text := 'Expiration must be a real month as YYYY-MM (e.g. 2027-06).';
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  v_past := to_char((now() at time zone 'America/Chicago') - interval '3 months', 'YYYY-MM');
  v_next := to_char((now() at time zone 'America/Chicago') + interval '1 month', 'YYYY-MM');
  v_year := to_char((now() at time zone 'America/Chicago') + interval '12 months', 'YYYY-MM');

  -- S0 the helper
  SELECT bool_and(public.valid_exp_ym(t.v) IS NOT DISTINCT FROM t.e) INTO v_ok FROM (VALUES
      ('2027-06', true), ('1900-01', true), ('2026-12', true), ('9999-12', true), ('2000-10', true),
      (NULL, false), ('', false), ('0000-00', false), ('0000-01', false), ('2026-00', false), ('2026-13', false), ('1899-12', false),
      ('2026-09-15', false), ('2026-1', false), ('26-06', false), ('TBD', false), (' 2027-06', false), ('2027-06 ', false),
      (E'２０２７-06', false)) t(v, e);
  FOR v_line IN EXECUTE 'EXPLAIN (VERBOSE, COSTS OFF) SELECT count(*) FROM public.certs c WHERE public.valid_exp_ym(c.exp)' LOOP v_plan := v_plan || v_line; END LOOP;
  v_ok := v_ok AND position('valid_exp_ym' in v_plan) = 0 AND position('~' in v_plan) > 0
    AND (SELECT p.provolatile = 'i' AND NOT p.prosecdef AND p.proconfig IS NULL FROM pg_proc p WHERE p.oid = 'public.valid_exp_ym(text)'::regprocedure)
    AND has_function_privilege('authenticated', 'public.valid_exp_ym(text)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.valid_exp_ym(text)'::regprocedure, 'EXECUTE');
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 valid_exp_ym(): the validExpYM truth table (19 cases, NULL -> false); IMMUTABLE, invoker, no SET, inlined in the plan; authenticated-only%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 valid_exp_ym() truth table / shape / inlining / grants (plan: %s)%s', v_plan, chr(10)); END IF;

  -- S1 the reviewed bodies
  SELECT bool_and(md5(pg_get_functiondef(f::regprocedure)) = m) INTO v_ok FROM (VALUES
      ('public.valid_exp_ym(text)', '51b8cde1acf4a8e5db26a81dc65bee68'), ('public.dept_cert_readiness()', '6a55033101e75f1a9c088aaa8bf3e861'),
      ('public.pa_department_radar()', '5093693f4b8941f22a4b4a47263ee1ec'), ('public.my_department_rollup()', 'f46794ccdcd94451ff71f1fa404acefe'),
      ('public.expiration_rows(uuid,uuid)', '4ccf41b4f5d87c1d45ada59a2b91686f'), ('public.probation_item_states(uuid,uuid)', '677b005d7543c35d5c926ca9798e67d6'),
      ('public.update_cert(uuid,text,text)', '232cd2f1b6aaf51ec2ec7bf9560f7870'), ('public.approve_cert_submission(uuid)', '01c1c75c16f24b3fd6209808955f5bd0')) t(f, m);
  SELECT count(*) INTO v_n FROM unnest(array['public.dept_cert_readiness()', 'public.pa_department_radar()', 'public.my_department_rollup()',
         'public.expiration_rows(uuid,uuid)', 'public.probation_item_states(uuid,uuid)', 'public.update_cert(uuid,text,text)']) f
   WHERE position($t$'^\d{4}-\d{2}$'$t$ in pg_get_functiondef(f::regprocedure)) > 0 OR position($t$'^\d{4}-(0[1-9]|1[0-2])$'$t$ in pg_get_functiondef(f::regprocedure)) > 0;
  IF v_ok AND v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S1 the 8 reviewed md5s; no shape-only / year-less cert regex left%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S1 md5s match %s · old regex left in %s function(s)%s', coalesce(v_ok::text, 'null'), v_n, chr(10)); END IF;

  -- L1 the live data, every department, through expiration_rows (as postgres — it's internal)
  BEGIN
    SELECT count(*) FILTER (WHERE (x.bucket = 'no_date') IS DISTINCT FROM NOT public.valid_exp_ym(c.exp)), count(*) INTO v_bad, v_n
      FROM public.departments d CROSS JOIN LATERAL public.expiration_rows(d.id, NULL) x JOIN public.certs c ON c.id = x.item_id
     WHERE x.source = 'cert' AND x.bucket <> 'no_expiry';
    IF v_bad = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  L1 live: all %s dated-type certs on the honest rosters read no_date exactly when the exp is not a valid month%s', v_n, chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  L1 live: %s of %s certs disagree with valid_exp_ym()%s', v_bad, v_n, chr(10)); END IF;
  EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  L1 raised: %s%s', SQLERRM, chr(10)); END;

  SELECT lower(m.email), u.id INTO v_pa, v_pa_uid FROM public.members m JOIN auth.users u ON lower(u.email) = lower(m.email)
   WHERE m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary') ORDER BY m.id LIMIT 1;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_da_mid := NULL; v_da_uid := NULL;
    SELECT lower(m.email), m.id, u.id INTO v_da, v_da_mid, v_da_uid FROM public.members m JOIN auth.users u ON lower(u.email) = lower(m.email)
     WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
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
      a0 := NULL;
      IF v_pa IS NOT NULL THEN
        BEGIN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'sub', v_pa_uid, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          SELECT * INTO a0 FROM public.pa_department_radar() x WHERE x.department_id = rec.dept_id;
          PERFORM set_config('role', 'postgres', true);
        EXCEPTION WHEN OTHERS THEN a0 := NULL; e := SQLERRM; END;
      END IF;

      -- the synthetic certs: 9 garbage, then past / next month / a year out (ids[10..12])
      ids := array[]::uuid[];
      FOR i IN 1 .. 12 LOOP
        INSERT INTO public.certs (id, department_id, member_id, name, exp)
        VALUES (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST cert ' || i,
                CASE WHEN i <= 9 THEN GARBAGE[i] WHEN i = 10 THEN v_past WHEN i = 11 THEN v_next ELSE v_year END)
        RETURNING id INTO v_id;
        ids := ids || v_id;
      END LOOP;

      -- G1 + G2 as the DA
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'sub', v_da_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN
        SELECT * INTO r1 FROM public.dept_cert_readiness();
        IF r1.no_date - r0.no_date = 9 AND r1.expired - r0.expired = 1 AND r1.expiring - r0.expiring = 1 AND r1."current" - r0."current" = 1
           AND r1.no_expiry = r0.no_expiry AND r1.total_dated - r0.total_dated = 3 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  G1 readiness: 9 garbage -> +9 no_date, 0 expired; past +1 expired, next month +1 expiring, a year out +1 current%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G1 readiness deltas: no_date %s · expired %s · expiring %s · current %s · no_expiry %s%s',
          r1.no_date - r0.no_date, r1.expired - r0.expired, r1.expiring - r0.expiring, r1."current" - r0."current", r1.no_expiry - r0.no_expiry, chr(10)); END IF;
      EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G1 readiness raised: %s%s', SQLERRM, chr(10)); END;
      BEGIN
        SELECT * INTO o1 FROM public.my_department_rollup() x WHERE x.department_id = rec.dept_id;
        IF o1.expired_certs_count - o0.expired_certs_count = 1 AND o1.expiring_certs_count - o0.expiring_certs_count = 1
           AND o1.my_certs_current - o0.my_certs_current = 1 AND o1.my_certs_expiring - o0.my_certs_expiring = 1 AND o1.my_certs_expired - o0.my_certs_expired = 1 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  G2 rollup: dept expired +1 / expiring +1, mine current +1 / expiring +1 / expired +1 — garbage counted nowhere, no error%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G2 rollup deltas: dept expired %s / expiring %s · mine current %s / expiring %s / expired %s%s',
          o1.expired_certs_count - o0.expired_certs_count, o1.expiring_certs_count - o0.expiring_certs_count, o1.my_certs_current - o0.my_certs_current,
          o1.my_certs_expiring - o0.my_certs_expiring, o1.my_certs_expired - o0.my_certs_expired, chr(10)); END IF;
      EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G2 rollup raised: %s%s', SQLERRM, chr(10)); END;
      PERFORM set_config('role', 'postgres', true);

      -- G3 the radar as a PA
      IF v_pa IS NULL OR a0 IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  G3 radar — no Project Admin with an auth user, or the baseline call failed (%s)%s', coalesce(e, 'no PA'), chr(10));
      ELSE
        BEGIN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'sub', v_pa_uid, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          SELECT * INTO a1 FROM public.pa_department_radar() x WHERE x.department_id = rec.dept_id;
          PERFORM set_config('role', 'postgres', true);
          IF a1.expired_certs_count - a0.expired_certs_count = 1 AND a1.expiring_certs_count - a0.expiring_certs_count = 1 THEN
            v_pass := v_pass + 1; rpt := rpt || format('   PASS  G3 radar: expired +1 / expiring +1 — garbage counted nowhere, no error%s', chr(10));
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G3 radar deltas: expired %s / expiring %s%s',
            a1.expired_certs_count - a0.expired_certs_count, a1.expiring_certs_count - a0.expiring_certs_count, chr(10)); END IF;
        EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G3 radar raised: %s%s', SQLERRM, chr(10)); END;
        PERFORM set_config('role', 'postgres', true);
      END IF;

      -- G4 expiration_rows, row by row
      BEGIN
        SELECT string_agg(i || '=' || coalesce(x.bucket, 'MISSING'), ' ' ORDER BY i) INTO v_t
          FROM generate_series(1, 12) i LEFT JOIN public.expiration_rows(rec.dept_id, v_da_mid) x ON x.item_id = ids[i];
        SELECT count(*) INTO v_n FROM generate_series(1, 12) i JOIN public.expiration_rows(rec.dept_id, v_da_mid) x ON x.item_id = ids[i]
         WHERE (i <= 9 AND x.bucket = 'no_date') OR (i = 10 AND x.bucket = 'expired') OR (i = 11 AND x.bucket IN ('soon', 'current')) OR (i = 12 AND x.bucket = 'current');
        IF v_n = 12 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  G4 expiration_rows: the 9 garbage rows no_date; past expired; next month dated, not expired; a year out current%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G4 expiration_rows buckets: %s%s', v_t, chr(10)); END IF;
      EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G4 expiration_rows raised: %s%s', SQLERRM, chr(10)); END;

      -- G5 probation_item_states, through a synthetic cert item
      v_item := NULL;
      BEGIN
        INSERT INTO public.onboarding_items (department_id, label, kind, cert_name) VALUES (rec.dept_id, 'RETEST cert item', 'cert', 'RETEST PROBATION CERT') RETURNING id INTO v_item;
      EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
      IF v_item IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  G5 probation — a synthetic onboarding item could not be inserted (%s); the dry run is the proof%s', e, chr(10));
      ELSE
        BEGIN
          INSERT INTO public.certs (id, department_id, member_id, name, exp) VALUES (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST PROBATION CERT', '2026-13'),
                                                                                    (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST PROBATION CERT', '0000-01');
          SELECT x.state INTO v_t FROM public.probation_item_states(v_da_mid, rec.dept_id) x WHERE x.item_id = v_item;
          INSERT INTO public.certs (id, department_id, member_id, name, exp) VALUES (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST PROBATION CERT', v_year);
          SELECT v_t || '/' || x.state INTO v_t FROM public.probation_item_states(v_da_mid, rec.dept_id) x WHERE x.item_id = v_item;
          IF v_t = 'missing/current' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  G5 probation: ''2026-13'' + ''0000-01'' alone = missing; + a valid month a year out = current%s', chr(10));
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G5 probation states: %s (want missing/current)%s', coalesce(v_t, 'null'), chr(10)); END IF;
        EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G5 probation raised: %s%s', SQLERRM, chr(10)); END;
      END IF;

      -- G6 a never-expires type wins over a garbage date and over a real past month
      v_item := NULL;
      BEGIN
        INSERT INTO public.cert_types (department_id, name, never_expires) VALUES (rec.dept_id, 'RETEST never-expires type', true) RETURNING id INTO v_item;
      EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
      IF v_item IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  G6 never-expires — a synthetic cert type could not be inserted (%s); the dry run is the proof%s', e, chr(10));
      ELSE
        BEGIN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'sub', v_da_uid, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          SELECT * INTO r0 FROM public.dept_cert_readiness();
          PERFORM set_config('role', 'postgres', true);
          INSERT INTO public.certs (id, department_id, member_id, name, exp, cert_type_id)
          VALUES (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST nx garbage', '0000-00', v_item), (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST nx past', v_past, v_item);
          PERFORM set_config('role', 'authenticated', true);
          SELECT * INTO r1 FROM public.dept_cert_readiness();
          PERFORM set_config('role', 'postgres', true);
          SELECT count(*) FILTER (WHERE x.bucket = 'no_expiry'), count(*) INTO v_n, v_bad FROM public.expiration_rows(rec.dept_id, v_da_mid) x
            JOIN public.certs c ON c.id = x.item_id WHERE c.cert_type_id = v_item;
          IF r1.no_expiry - r0.no_expiry = 2 AND r1.expired = r0.expired AND r1.no_date = r0.no_date AND v_n = 2 AND v_bad = 2 THEN
            v_pass := v_pass + 1; rpt := rpt || format('   PASS  G6 never-expires wins: ''0000-00'' and a real past month of that type read no_expiry (readiness +2 no_expiry, 0 expired / no_date; expiration_rows no_expiry)%s', chr(10));
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G6 never-expires: readiness no_expiry %s · expired %s · no_date %s · expiration_rows no_expiry %s of %s%s',
            r1.no_expiry - r0.no_expiry, r1.expired - r0.expired, r1.no_date - r0.no_date, v_n, v_bad, chr(10)); END IF;
        EXCEPTION WHEN OTHERS THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G6 never-expires raised: %s%s', SQLERRM, chr(10)); END;
        PERFORM set_config('role', 'postgres', true);
      END IF;

      -- U1 update_cert as the DA
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'sub', v_da_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_n := 0; v_t := '';
      FOREACH e IN ARRAY array['0000-00', '2026-13', '2026-00', '1899-12', '2026-09-15', 'TBD', ' 2027-06'] LOOP
        BEGIN PERFORM public.update_cert(ids[12], 'RETEST cert 12', e); v_t := v_t || format(' [%s accepted]', e);
        EXCEPTION WHEN OTHERS THEN IF SQLERRM = MSG THEN v_n := v_n + 1; ELSE v_t := v_t || format(' [%s: %s]', e, SQLERRM); END IF; END;
      END LOOP;
      BEGIN
        PERFORM public.update_cert(ids[12], 'RETEST cert 12', '2027-06'); PERFORM set_config('role', 'postgres', true);
        SELECT exp INTO e FROM public.certs WHERE id = ids[12]; v_ok := e = '2027-06';
        PERFORM set_config('role', 'authenticated', true); PERFORM public.update_cert(ids[12], 'RETEST cert 12', ''); PERFORM set_config('role', 'postgres', true);
        SELECT v_ok AND exp IS NULL INTO v_ok FROM public.certs WHERE id = ids[12];
        PERFORM set_config('role', 'authenticated', true); PERFORM public.update_cert(ids[11], 'RETEST cert 11', NULL); PERFORM set_config('role', 'postgres', true);
        SELECT v_ok AND exp IS NULL INTO v_ok FROM public.certs WHERE id = ids[11];
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_t := v_t || ' [valid path raised: ' || SQLERRM || ']'; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 7 AND v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  U1 update_cert: 7 malformed refused with the client''s message; ''2027-06'' stored; '''' and NULL clear to NULL%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  U1 update_cert: %s of 7 refused with the message; valid path %s;%s%s', v_n, coalesce(v_ok::text, 'null'), v_t, chr(10)); END IF;

      -- A1 approve_cert_submission as the DA
      v_sub := NULL;
      BEGIN
        INSERT INTO public.cert_submissions (id, department_id, member_id, name, exp, status, source, proposed_by, proof_path)
        VALUES (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST sub probe', '2027-06', 'pending', 'manual', v_da_uid, 'retest/none') RETURNING id INTO v_sub;
      EXCEPTION WHEN OTHERS THEN e := SQLERRM; END;
      IF v_sub IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  A1 approve — a synthetic submission could not be inserted (%s); the dry run is the proof%s', e, chr(10));
      ELSE
        BEGIN
          v_t := ''; v_n := 0;
          FOR i IN 1 .. 4 LOOP
            IF i > 1 THEN
              INSERT INTO public.cert_submissions (id, department_id, member_id, name, exp, status, source, proposed_by, proof_path)
              VALUES (gen_random_uuid(), rec.dept_id, v_da_mid, 'RETEST sub ' || i, (array['2027-06', '0000-00', '2026-09-15', ''])[i], 'pending', 'manual', v_da_uid, 'retest/none')
              RETURNING id INTO v_sub;
            END IF;
            PERFORM set_config('role', 'authenticated', true);
            SELECT public.approve_cert_submission(v_sub) INTO v_new;
            PERFORM set_config('role', 'postgres', true);
            SELECT coalesce(c.exp, 'NULL') INTO e FROM public.certs c WHERE c.id = v_new;
            v_t := v_t || format(' %s->%s', coalesce(nullif((array['2027-06', '0000-00', '2026-09-15', ''])[i], ''), ''''''), e);
            IF e = (array['2027-06', 'NULL', 'NULL', 'NULL'])[i] AND (SELECT status FROM public.cert_submissions WHERE id = v_sub) = 'approved' THEN v_n := v_n + 1; END IF;
          END LOOP;
          IF v_n = 4 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  A1 approve: approved;%s (malformed cleared, valid kept)%s', v_t, chr(10));
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 approve:%s%s', v_t, chr(10)); END IF;
        EXCEPTION WHEN OTHERS THEN PERFORM set_config('role', 'postgres', true); v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 approve raised: %s%s', SQLERRM, chr(10)); END;
      END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  the department block raised: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION '%', format('%s passed, %s failed, %s skipped%s', v_pass, v_fail, v_skip, rpt);
END
$retest$;
