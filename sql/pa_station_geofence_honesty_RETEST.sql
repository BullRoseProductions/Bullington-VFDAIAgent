-- =====================================================================
-- RETEST for pa_station_geofence_honesty.sql. Run AFTER the migration.
-- NOTHING CHANGES: every write happens on FIXTURE stations this block inserts
-- itself, inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). No
-- real station's switch is touched. The final RAISE is the report — the
-- "ERROR" IS the report.
--
--   G0 shape + rights: pa_department_stations returns the ten columns (the four
--      new ones typed as the stations columns); both functions SECURITY DEFINER,
--      search_path pinned, is_project_admin() in the body, anon can't execute,
--      authenticated can
--   N1 a non-PA (a Department Admin, then a plain member) is refused by BOTH
--      functions with 'Not authorized'; the fixture's switch is unchanged
--   R1 as a PA, pa_department_stations returns the fixture rows with
--      lat / lng / radius_m / geofence_enabled equal to the table's
--   E1 as a PA, switching ON a house with no pin is refused with exactly
--      'Give this house a location before switching its fence on.' and the
--      switch stays off
--   E2 as a PA, a pinned house round-trips: ON -> returns its id, reads true;
--      OFF -> returns its id, reads false
--   E3 as a PA, switching OFF an unpinned house is allowed (returns its id)
--   E4 as a PA, a bad id -> 'Station not found'
--   E5 only geofence_enabled moved: lat, lng, radius_m, is_default,
--      department_id, name, label, address, is_active identical before/after;
--      the department master switch (departments.geofence_enabled) unchanged
-- =====================================================================
DO $retest$
DECLARE
  v_dept uuid; v_dept_name text; v_master boolean;
  v_pa text; v_da text; v_mem text;
  v_pin uuid; v_nopin uuid; v_ret uuid; v_err text; v_n int; v_ok boolean;
  v_before record; v_after record; v_row record;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- G0
  IF pg_get_function_result('public.pa_department_stations(uuid)'::regprocedure)
       = 'TABLE(station_id uuid, name text, label text, address text, is_default boolean, is_active boolean, lat double precision, lng double precision, radius_m integer, geofence_enabled boolean)'
     AND (SELECT bool_and(p.prosecdef
                          AND position('is_project_admin()' in p.prosrc) > 0
                          AND 'search_path=public' = ANY (coalesce(p.proconfig, '{}'))
                          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                          AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
                 FROM pg_proc p
                WHERE p.oid IN ('public.pa_department_stations(uuid)'::regprocedure,
                                'public.pa_set_station_geofence(uuid, boolean)'::regprocedure))
     AND pg_get_function_result('public.pa_set_station_geofence(uuid, boolean)'::regprocedure) = 'uuid' THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  G0 ten-column read; both definer, gated, search_path pinned, anon locked out, authenticated in%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  G0 shape / rights not as expected%s', chr(10)); END IF;

  -- Actors. A PA is matched by email across all their rows (is_project_admin reads any row), so any PA email works.
  SELECT lower(m.email) INTO v_pa FROM public.members m
   WHERE m.access && array['Project Admin']::text[] AND m.email IS NOT NULL ORDER BY m.id LIMIT 1;
  -- Fixture department: the first department that has a DA and a plain member whose emails are unique AND
  -- carry no PA access on any row (else they would pass the PA gate).
  FOR v_row IN SELECT d.id, d.name, d.geofence_enabled FROM public.departments d ORDER BY d.name LOOP
    v_da := NULL; v_mem := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m
     WHERE m.department_id = v_row.id AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.members x WHERE lower(x.email) = lower(m.email) AND x.access && array['Project Admin']::text[])
     ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_mem FROM public.members m
     WHERE m.department_id = v_row.id AND m.email IS NOT NULL
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer']::text[], false)
       AND NOT EXISTS (SELECT 1 FROM public.members x WHERE lower(x.email) = lower(m.email) AND x.access && array['Project Admin']::text[])
     ORDER BY m.id LIMIT 1;
    IF v_da IS NOT NULL AND v_mem IS NOT NULL THEN v_dept := v_row.id; v_dept_name := v_row.name; v_master := v_row.geofence_enabled; EXIT; END IF;
  END LOOP;

  IF v_pa IS NULL OR v_dept IS NULL THEN
    v_skip := v_skip + 1; rpt := rpt || format('SKIP  all signed-in checks — PA %s, fixture department %s%s', coalesce(v_pa, 'none'), coalesce(v_dept_name, 'none'), chr(10));
  ELSE
    rpt := rpt || format('— fixtures in %s%s', v_dept_name, chr(10));
    BEGIN
      -- Fixtures (owner inserts, RLS not in play): one pinned house, one unpinned. is_default=false always.
      INSERT INTO public.stations (department_id, name, label, address, lat, lng, radius_m, geofence_enabled, is_active, is_default)
      VALUES (v_dept, 'ZZ RETEST pinned', 'fixture', '1 Test Rd', 32.5, -97.9, 275, false, true, false) RETURNING id INTO v_pin;
      INSERT INTO public.stations (department_id, name, label, address, lat, lng, radius_m, geofence_enabled, is_active, is_default)
      VALUES (v_dept, 'ZZ RETEST unpinned', NULL, NULL, NULL, NULL, NULL, false, true, false) RETURNING id INTO v_nopin;
      SELECT lat, lng, radius_m, is_default, department_id, name, label, address, is_active INTO v_before FROM public.stations WHERE id = v_pin;

      -- N1 non-PA refused by both functions (DA, then plain member)
      v_ok := true;
      FOREACH v_err IN ARRAY array[v_da, v_mem] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_err, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.pa_set_station_geofence(v_pin, true); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Not authorized' THEN v_ok := false; END IF; END;
        BEGIN PERFORM * FROM public.pa_department_stations(v_dept); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Not authorized' THEN v_ok := false; END IF; END;
        PERFORM set_config('role', 'postgres', true);
      END LOOP;
      IF v_ok AND (SELECT geofence_enabled FROM public.stations WHERE id = v_pin) = false THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  N1 a DA and a plain member are refused by both functions (''Not authorized''); switch unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 a non-PA reached a function body%s', chr(10)); END IF;

      -- Everything below calls AS the PA (role switched around each call) and verifies as the owner, since a
      -- PA outside the fixture department can't read its stations row through RLS.
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'role', 'authenticated')::text, true);

      -- R1 the read carries the new columns
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.pa_department_stations(v_dept) r
       WHERE (r.station_id = v_pin   AND r.lat = 32.5 AND r.lng = -97.9 AND r.radius_m = 275 AND r.geofence_enabled = false)
          OR (r.station_id = v_nopin AND r.lat IS NULL AND r.lng IS NULL AND r.radius_m IS NULL AND r.geofence_enabled = false);
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 2 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 pa_department_stations returns lat / lng / radius_m / geofence_enabled for both fixtures%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 %s of 2 fixture rows matched%s', v_n, chr(10)); END IF;

      -- E1 enable without a pin -> the exact sentence
      PERFORM set_config('role', 'authenticated', true); BEGIN v_ret := public.pa_set_station_geofence(v_nopin, true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END; PERFORM set_config('role', 'postgres', true);
      IF v_err = 'Give this house a location before switching its fence on.'
         AND (SELECT geofence_enabled FROM public.stations WHERE id = v_nopin) = false THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  E1 switching ON an unpinned house is refused with the DA editor''s sentence; it stays off%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E1 -> "%s"%s', v_err, chr(10)); END IF;

      -- E2 round-trip on the pinned house
      v_ok := true;
      PERFORM set_config('role', 'authenticated', true); BEGIN v_ret := public.pa_set_station_geofence(v_pin, true); EXCEPTION WHEN OTHERS THEN v_ret := NULL; v_err := SQLERRM; END; PERFORM set_config('role', 'postgres', true);
      IF v_ret IS DISTINCT FROM v_pin OR (SELECT geofence_enabled FROM public.stations WHERE id = v_pin) IS DISTINCT FROM true THEN v_ok := false; END IF;
      -- while ON: the PA read reports it ON (not a constant), and the department master did not move with it
      PERFORM set_config('role', 'authenticated', true);
      SELECT r.geofence_enabled INTO v_row FROM public.pa_department_stations(v_dept) r WHERE r.station_id = v_pin;
      PERFORM set_config('role', 'postgres', true);
      IF v_row.geofence_enabled IS DISTINCT FROM true THEN v_ok := false; v_err := 'the PA read did not report the house ON'; END IF;
      IF (SELECT geofence_enabled FROM public.departments WHERE id = v_dept) IS DISTINCT FROM v_master THEN v_ok := false; v_err := 'the department master moved with the house'; END IF;
      PERFORM set_config('role', 'authenticated', true); BEGIN v_ret := public.pa_set_station_geofence(v_pin, false); EXCEPTION WHEN OTHERS THEN v_ret := NULL; v_err := SQLERRM; END; PERFORM set_config('role', 'postgres', true);
      IF v_ret IS DISTINCT FROM v_pin OR (SELECT geofence_enabled FROM public.stations WHERE id = v_pin) IS DISTINCT FROM false THEN v_ok := false; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E2 pinned house: ON returns its id, reads true (table and PA read), master unmoved; OFF returns its id and reads false%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E2 round-trip broke (%s)%s', coalesce(v_err, 'wrong id or state'), chr(10)); END IF;

      -- E3 OFF on an unpinned house is allowed
      PERFORM set_config('role', 'authenticated', true); BEGIN v_ret := public.pa_set_station_geofence(v_nopin, false); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_ret := NULL; END; PERFORM set_config('role', 'postgres', true);
      IF v_err = 'OK' AND v_ret = v_nopin THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E3 switching OFF an unpinned house is allowed%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E3 -> "%s"%s', v_err, chr(10)); END IF;

      -- E4 bad id
      PERFORM set_config('role', 'authenticated', true); BEGIN v_ret := public.pa_set_station_geofence(gen_random_uuid(), false); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END; PERFORM set_config('role', 'postgres', true);
      IF v_err = 'Station not found' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E4 a bad id -> ''Station not found''%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E4 -> "%s"%s', v_err, chr(10)); END IF;

      -- E5 nothing else moved
      SELECT lat, lng, radius_m, is_default, department_id, name, label, address, is_active INTO v_after FROM public.stations WHERE id = v_pin;
      IF v_after IS NOT DISTINCT FROM v_before
         AND (SELECT geofence_enabled FROM public.departments WHERE id = v_dept) IS NOT DISTINCT FROM v_master THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  E5 only geofence_enabled moved; the department master switch is unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E5 another column or the master switch changed%s', chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END IF;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
