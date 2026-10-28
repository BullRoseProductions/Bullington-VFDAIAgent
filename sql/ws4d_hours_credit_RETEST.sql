-- =====================================================================
-- RETEST for ws4d_hours_credit (WS-4d). READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Every fixture lives in a per-department sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in a
-- RAISE that IS the report. NOTHING CHANGES. The "ERROR" is the report. Fixtures are written as postgres; the gated
-- readers run with the department's Department Admin in request.jwt.claims (memory: station-presence-constraints).
--
-- Once:
--   O1 the six replaced functions carry the WS-4d change and match the dry run's md5s exactly
--   O2 their grants / SECURITY DEFINER / search_path are the live values captured before the change; attested_training
--      byte-identical (untouched — the 90-minute cap applies to meetings as to drills)
-- Per department (a REAL Department Admin where one exists; fixtures: a business MEETING yesterday 18:00 for 120 min with
-- F attended (attested) and G checked in for 60 min (observed — observed wins); a DRILL yesterday with H attended; V with a
-- normal 1-hour standby shift and a VOIDED one (out = in)):
--   T1 D-2 credited split (dept_iso_hours_for): F 1.5 h STANDBY (the attested cap), G 1.0 h STANDBY, H 1.5 h TRAINING —
--      each total = training + standby, so classifying a meeting moves only the split
--   T2 D-2 by station (dept_iso_hours_by_station): F / G training 0, H training 1.5 — the same rule
--   T3 D-2 the shift lists: dept_station_shifts reads kind 'standby' for F (attested) and G (observed), 'training' for H;
--      my_station_shifts reads 'standby' for G
--   T4 V-a: dept_station_shifts LISTS the voided shift; dept_iso_hours_by_month's shift count = the listed rows with
--      out > in (the voided one not counted)
--   T5 F-3: every counted member's scorecard station_hours == round(their dept_iso_hours_for 12-month total, 1)
--   T6 station_presence byte-identical outside the fixtures; verified unchanged outside the fixtures
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_ok boolean; v_err text;
  rec record; d uuid; dn text; tag text; real_da boolean; e_da text; m_da uuid;
  f uuid; g uuid; h uuid; v uuid; sm uuid; sd uuid; v_day date := (now() at time zone 'America/Chicago')::date - 1;
  w_from timestamptz := now() - interval '3 days'; w_to timestamptz := now();
  a numeric; b numeric; c numeric; n1 bigint; n2 bigint; n3 bigint; k1 text; k2 text; k3 text; k4 text;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint; fix uuid[];
  c_md5 constant jsonb := '{"verdict": "181776ca615f0e9c21b12806916c61e4", "isoFor": "705c9a9b5532d28824f5e50e74d6059f", "byStation": "998d10b2c6e2b8da399fca16a52aec28", "shifts": "dc8db411f6c43d7b8adcb76c247d0e48", "myShifts": "7832e4dc35632c397599301e1ff4a3c9", "byMonth": "61e720592773ed61a2b68ec481292db4"}';
  c_sig constant jsonb := '{"verdict": "public.readiness_verdict(uuid,uuid)", "isoFor": "public.dept_iso_hours_for(uuid,timestamp with time zone,timestamp with time zone)", "byStation": "public.dept_iso_hours_by_station(timestamp with time zone,timestamp with time zone)", "shifts": "public.dept_station_shifts(timestamp with time zone,timestamp with time zone)", "myShifts": "public.my_station_shifts(timestamp with time zone,timestamp with time zone)", "byMonth": "public.dept_iso_hours_by_month(timestamp with time zone[],timestamp with time zone[])"}';
  c_meta constant jsonb := '{"verdict":"{postgres=X/postgres,service_role=X/postgres}|true|{search_path=public}","isoFor":"{postgres=X/postgres,service_role=X/postgres}|true|{search_path=public}","byStation":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|true|{search_path=public}","shifts":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|true|{search_path=public}","myShifts":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|true|{search_path=public}","byMonth":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}|false|{search_path=public}"}';
  kk text;
BEGIN
  -- ---------------------------------------------------------------- once
  v_ok := true; v_err := '';
  FOR kk IN SELECT jsonb_object_keys(c_sig) LOOP
    IF position('WS-4d' in pg_get_functiondef((c_sig->>kk)::regprocedure)) = 0 OR md5(pg_get_functiondef((c_sig->>kk)::regprocedure)) <> c_md5->>kk THEN
      v_ok := false; v_err := v_err || ' ' || kk; END IF;
  END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 the six replaced functions carry WS-4d and match the dry run''s md5s' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  O1 replaced function(s) not as built:%s%s', v_err, chr(10)); END IF;

  v_ok := true; v_err := '';
  FOR kk IN SELECT jsonb_object_keys(c_sig) LOOP
    IF (SELECT coalesce(p.proacl::text, '') || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') FROM pg_proc p WHERE p.oid = (c_sig->>kk)::regprocedure) <> c_meta->>kk THEN
      v_ok := false; v_err := v_err || ' ' || kk; END IF;
  END LOOP;
  IF v_ok AND md5(pg_get_functiondef('public.attested_training(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) = 'aff25333771cd38c1f473bcde5e1e96e' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 grants / definer / search_path as before on all six; attested_training untouched' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  O2 privileges changed or attested_training touched:%s%s', v_err, chr(10)); END IF;

  -- ---------------------------------------------------------------- per department
  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; dn := rec.name; tag := 'ws4drt-' || left(replace(d::text, '-', ''), 8);
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      e_da := null; m_da := null;
      SELECT lower(m.email), m.id INTO e_da, m_da FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary')
         AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      real_da := e_da IS NOT NULL;
      IF NOT real_da THEN
        e_da := tag || '-da@retest.invalid';
        INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST DA', e_da, '{Department Admin}', 'Active') RETURNING id INTO m_da;
      END IF;
      rpt := rpt || format('   (leader = a %s Department Admin)%s', CASE WHEN real_da THEN 'REAL' ELSE 'fixture' END, chr(10));
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST F', tag || '-f@retest.invalid', '{Member}', 'Active') RETURNING id INTO f;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST G', tag || '-g@retest.invalid', '{Member}', 'Active') RETURNING id INTO g;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST H', tag || '-h@retest.invalid', '{Member}', 'Active') RETURNING id INTO h;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST V', tag || '-v@retest.invalid', '{Member}', 'Active') RETURNING id INTO v;
      fix := ARRAY[f, g, h, v];
      INSERT INTO public.training_sessions (department_id, title, date, start_time, duration_min, done, audience, counts_toward_attendance, is_meeting)
        VALUES (d, 'RETEST business meeting', v_day, '18:00', 120, true, 'everyone', true, true) RETURNING id INTO sm;
      INSERT INTO public.training_sessions (department_id, title, date, start_time, duration_min, done, audience, counts_toward_attendance, is_meeting)
        VALUES (d, 'RETEST drill', v_day, '18:00', 120, true, 'everyone', true, false) RETURNING id INTO sd;
      INSERT INTO public.session_attendance (department_id, session_id, member_id) VALUES (d, sm, f), (d, sm, g), (d, sd, h);
      INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, session_id, checked_in_at, checked_out_at, auto_closed)
        VALUES (d, g, true, 'geo', 'training', sm, (v_day + time '18:00') AT TIME ZONE 'America/Chicago', (v_day + time '19:00') AT TIME ZONE 'America/Chicago', false);
      INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, checked_in_at, checked_out_at, auto_closed)
        VALUES (d, v, true, 'geo', 'standby', (v_day + time '08:00') AT TIME ZONE 'America/Chicago', (v_day + time '09:00') AT TIME ZONE 'America/Chicago', false),
               (d, v, true, 'geo', 'standby', (v_day + time '10:00') AT TIME ZONE 'America/Chicago', (v_day + time '10:00') AT TIME ZONE 'America/Chicago', false);

      -- ---- T1 the credited split
      v_ok := true; v_err := '';
      FOR kk, a, b, c IN SELECT x.who, x.tr, x.sb, x.tot FROM (VALUES
          ('F', (SELECT training_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = f), (SELECT standby_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = f), (SELECT iso_total_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = f)),
          ('G', (SELECT training_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = g), (SELECT standby_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = g), (SELECT iso_total_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = g)),
          ('H', (SELECT training_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = h), (SELECT standby_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = h), (SELECT iso_total_hours FROM public.dept_iso_hours_for(d, w_from, w_to) WHERE member_id = h))) x(who, tr, sb, tot) LOOP
        IF NOT ((kk = 'F' AND a = 0 AND b = 1.5 AND c = 1.5) OR (kk = 'G' AND a = 0 AND b = 1 AND c = 1) OR (kk = 'H' AND a = 1.5 AND b = 0 AND c = 1.5)) THEN
          v_ok := false; v_err := v_err || format(' %s=%s/%s/%s', kk, a, b, c); END IF;
      END LOOP;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T1 credited: meeting F 1.5 h standby (attested cap) · G 1.0 h standby (observed) · drill H 1.5 h training; totals = training + standby' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 credited split (training/standby/total):%s%s', v_err, chr(10)); END IF;

      -- ---- T2 by station (gated: as the department's DA)
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      BEGIN
        SELECT coalesce(sum(training_hours) FILTER (WHERE member_id IN (f, g)), 0), coalesce(sum(training_hours) FILTER (WHERE member_id = h), 0),
               coalesce(sum(standby_hours) FILTER (WHERE member_id IN (f, g)), 0)
          INTO a, b, c FROM public.dept_iso_hours_by_station(w_from, w_to);
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND a = 0 AND b = 1.5 AND c = 2.5 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 by station: the meeting''s 2.5 h are standby, the drill''s 1.5 h training' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 by station: meeting training %s · drill training %s · meeting standby %s %s%s', a, b, c, v_err, chr(10)); END IF;

      -- ---- T3 the shift lists' kind
      v_ok := true; v_err := '';
      BEGIN
        SELECT string_agg(DISTINCT kind, ',') INTO k1 FROM public.dept_station_shifts(w_from, w_to) WHERE member_id = f;
        SELECT string_agg(DISTINCT kind, ',') INTO k2 FROM public.dept_station_shifts(w_from, w_to) WHERE member_id = g;
        SELECT string_agg(DISTINCT kind, ',') INTO k3 FROM public.dept_station_shifts(w_from, w_to) WHERE member_id = h;
        PERFORM set_config('request.jwt.claims', json_build_object('email', tag || '-g@retest.invalid')::text, true);
        SELECT string_agg(DISTINCT kind, ',') INTO k4 FROM public.my_station_shifts(w_from, w_to);
        PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND k1 = 'standby' AND k2 = 'standby' AND k3 = 'training' AND k4 = 'standby' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T3 lists: meeting rows read standby (attested F, observed G; G''s own list too), the drill reads training' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 kinds F=%s G=%s H=%s G-own=%s %s%s', k1, k2, k3, k4, v_err, chr(10)); END IF;

      -- ---- T4 voided: listed, not counted
      v_ok := true; v_err := '';
      BEGIN
        SELECT count(*) FILTER (WHERE member_id = v), count(*) FILTER (WHERE checked_out_at > checked_in_at) INTO n1, n2 FROM public.dept_station_shifts(w_from, w_to);
        SELECT shifts INTO n3 FROM public.dept_iso_hours_by_month(ARRAY[w_from], ARRAY[w_to]);
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND n1 = 2 AND n3 = n2 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T4 voided: listed (V has 2 rows) but the month counts %s shifts = the rows with out > in%s', n3, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 voided: V listed %s · month shifts %s vs out>in rows %s %s%s', n1, n3, n2, v_err, chr(10)); END IF;

      -- ---- T5 the scorecard reads the credited hours
      SELECT count(*), count(*) FILTER (WHERE (public.readiness_verdict(d, m.id)->'activity'->>'station_hours')::numeric
                                             IS DISTINCT FROM coalesce((SELECT round(x.iso_total_hours, 1) FROM public.dept_iso_hours_for(d, now() - interval '12 months', now()) x WHERE x.member_id = m.id), 0))
        INTO n1, n2
        FROM public.members m
       WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND NOT coalesce(m.access && array['Project Admin']::text[], false)
         AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id);
      IF n2 = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T5 scorecard == credited 12-month hours for all %s counted members (fixtures included)%s', n1, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 %s of %s scorecards disagree with the credited hours%s', n2, n1, chr(10)); END IF;

      -- ---- T6 station_presence untouched outside the fixtures
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d AND NOT (p.member_id = ANY (fix));
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified AND NOT (member_id = ANY (fix));
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T6 station_presence byte-identical outside the fixtures; verified %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T6 station_presence / verified changed outside the fixtures' || chr(10); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
