-- =====================================================================
-- RETEST for sql/geofence_depart_manual_close.sql. Run AFTER applying it.
--
-- ONE STATEMENT. Paste the whole thing and run it once.
--
-- IT ENDS BY RAISING AN EXCEPTION ON PURPOSE. The report comes back as the
-- error message, and the exception is what rolls the fixtures back. Read
-- "ERROR: RETEST RESULTS" as the SUCCESSFUL outcome — the pass/fail verdicts
-- are in the message body.
--
-- WHY NOT BEGIN … ROLLBACK WITH A TEMP TABLE: the first version did that, and
-- the editor answered `relation "retest" does not exist`. Statements here can be
-- routed through a pooled connection, so a temp table created in one statement
-- is not guaranteed to exist in the next — and, far worse, an explicit ROLLBACK
-- is not guaranteed to be honoured either. This test INSERTS INTO PRODUCTION
-- station_presence. Rollback cannot be left to the client's transaction
-- handling, so the rollback is caused by the statement itself: a DO block that
-- raises is undone by Postgres, whatever the editor does around it.
--
-- WHY IT IMPERSONATES: geofence_depart resolves the actor through
-- my_member_id() → lower(auth.email()). The editor carries no JWT, so without
-- the claim the function raises "could not match your login".
--
-- WHY TWO MEMBERS: station_presence_one_open_session_per_member is
-- UNIQUE (member_id) WHERE checked_out_at IS NULL AND kind IN ('standby','offsite').
-- One member cannot hold two open standby rows. An open TRAINING row CAN coexist
-- with an open standby row, which is why case 5 is meaningful rather than
-- vacuous — the kind guard is the only thing keeping training out.
-- =====================================================================

DO $retest$
DECLARE
  v_dept       uuid;
  v_st_a       uuid;
  v_st_b       uuid;
  v_m1         uuid;
  v_m2         uuid;
  v_email1     text;
  v_email2     text;
  v_in         timestamptz := now() - interval '2 hours';
  v_exit       timestamptz := now() - interval '5 minutes';
  v_id         uuid;
  v_ret        public.station_presence;
  v_row        public.station_presence;
  v_cap_hours  integer;
  v_capped_in  timestamptz;
  v_expect_out timestamptz;
  v_zero       integer;
  n            int := 0;
  v_pass       int := 0;
  v_fail       int := 0;
  rpt          text := chr(10);
BEGIN
  -- ---------------- fixtures ----------------
  SELECT s.department_id INTO v_dept
    FROM public.stations s GROUP BY s.department_id HAVING count(*) >= 2 LIMIT 1;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: no department has two stations, so the cross-station case cannot run.';
  END IF;
  SELECT id INTO v_st_a FROM public.stations WHERE department_id = v_dept ORDER BY is_default DESC, name LIMIT 1;
  SELECT id INTO v_st_b FROM public.stations WHERE department_id = v_dept AND id <> v_st_a ORDER BY name LIMIT 1;

  SELECT id, lower(email) INTO v_m1, v_email1
    FROM public.members WHERE department_id = v_dept AND email IS NOT NULL ORDER BY id LIMIT 1;
  SELECT id, lower(email) INTO v_m2, v_email2
    FROM public.members WHERE department_id = v_dept AND email IS NOT NULL AND id <> v_m1 ORDER BY id LIMIT 1;
  IF v_m1 IS NULL OR v_m2 IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: need two members with emails in the two-station department.';
  END IF;

  SELECT coalesce(max_shift_hours, 10) INTO v_cap_hours FROM public.departments WHERE id = v_dept;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email1)::text, true);
  UPDATE public.station_presence SET checked_out_at = now()
   WHERE member_id IN (v_m1, v_m2) AND checked_out_at IS NULL;

  -- ============ 1. old 1-arg client closes a modern gps_geofence row ========
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_m1, v_st_a, 'gps_geofence', 'standby', v_in, true) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(v_exit);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at = v_exit AND v_row.auto_closed IS NOT TRUE THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  old 1-arg client closes modern gps_geofence row', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  old 1-arg client — got closed_at=%s auto=%s', n, v_row.checked_out_at, v_row.auto_closed);
  END IF; rpt := rpt || chr(10);

  -- ============ 2. backwards exit no-ops, LEGACY path =======================
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_m1, v_st_a, 'gps_geofence', 'standby', now() - interval '10 minutes', true) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(now() - interval '30 minutes');
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at IS NULL AND v_ret IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  backwards exit no-ops, legacy path', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  backwards exit legacy — closed_at=%s', n, v_row.checked_out_at);
  END IF; rpt := rpt || chr(10);
  UPDATE public.station_presence SET checked_out_at = now() WHERE id = v_id;

  -- ============ 3. backwards exit no-ops, STATION path ======================
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_m1, v_st_a, 'geo', 'standby', now() - interval '10 minutes', false) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(now() - interval '30 minutes', v_st_a);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at IS NULL AND v_ret IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  backwards exit no-ops, station path', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  backwards exit station — closed_at=%s', n, v_row.checked_out_at);
  END IF; rpt := rpt || chr(10);

  -- ============ 4. MANUAL standby closes at true exit, flagged ==============
  v_ret := public.geofence_depart(v_exit, v_st_a);       -- same row, real exit
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at = v_exit AND v_row.auto_closed IS TRUE AND v_row.verified IS NOT TRUE THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  manual standby closed at true exit, flagged, verdict untouched', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  manual standby — closed_at=%s auto=%s verified=%s', n, v_row.checked_out_at, v_row.auto_closed, v_row.verified);
  END IF; rpt := rpt || chr(10);

  -- ============ 5. open TRAINING row untouched ==============================
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_m1, v_st_a, 'geo', 'training', v_in, true) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(v_exit, v_st_a);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  open training row untouched', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  TRAINING ROW WAS CLOSED at %s', n, v_row.checked_out_at);
  END IF; rpt := rpt || chr(10);
  UPDATE public.station_presence SET checked_out_at = now() WHERE id = v_id;

  -- ============ 6. manual standby at ANOTHER station untouched ==============
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_m1, v_st_a, 'geo', 'standby', v_in, false) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(v_exit, v_st_b);       -- the OTHER house
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  manual standby at another station untouched', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  CROSS-STATION LEAK — closed at %s', n, v_row.checked_out_at);
  END IF; rpt := rpt || chr(10);

  -- ============ 7. REPLAYED exit closes nothing extra =======================
  v_ret := public.geofence_depart(v_exit, v_st_a);       -- real close
  v_ret := public.geofence_depart(v_exit, v_st_a);       -- REPLAY
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  SELECT count(*) INTO v_zero FROM public.station_presence
   WHERE member_id = v_m1 AND checked_out_at = checked_in_at;
  n := n + 1;
  IF v_row.checked_out_at = v_exit AND v_zero = 0 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  replayed EXIT closed nothing extra, 0 zero-length rows', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  replay — closed_at=%s zero_length=%s', n, v_row.checked_out_at, v_zero);
  END IF; rpt := rpt || chr(10);

  -- ============ 8. manual OFFSITE row untouched (member 2) ==================
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind,
                                       checked_in_at, verified, offsite_label, location_confirmed)
  VALUES (v_dept, v_m2, v_st_a, 'geo', 'offsite', v_in, false, 'retest offsite', false) RETURNING id INTO v_id;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email2)::text, true);
  v_ret := public.geofence_depart(v_exit, v_st_a);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  manual offsite row not closed by the manual arm', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  offsite closed at %s', n, v_row.checked_out_at);
  END IF; rpt := rpt || chr(10);
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email1)::text, true);

  -- ============ 9. ANNOTATE branch still fires ==============================
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind,
                                       checked_in_at, checked_out_at, auto_closed, verified, fence_exit_at)
  VALUES (v_dept, v_m1, v_st_a, 'gps_geofence', 'standby',
          now() - interval '20 hours', now() - interval '10 hours', true, true, NULL)
  RETURNING id INTO v_id;
  v_ret := public.geofence_depart(now() - interval '9 hours');
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.fence_exit_at IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  annotate branch stamped fence_exit_at', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  annotate branch did not fire', n);
  END IF; rpt := rpt || chr(10);

  -- ============ 10. gps_geofence via the 2-ARG station branch ===============
  UPDATE public.station_presence SET checked_out_at = now()
   WHERE member_id = v_m1 AND checked_out_at IS NULL;
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_m1, v_st_a, 'gps_geofence', 'standby', v_in, true) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(v_exit, v_st_a);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at = v_exit AND v_row.auto_closed IS NOT TRUE THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  gps_geofence via 2-arg station branch (matches case 1)', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  2-arg daemon close — closed_at=%s auto=%s', n, v_row.checked_out_at, v_row.auto_closed);
  END IF; rpt := rpt || chr(10);

  -- ============ 11. the max_shift_hours CAP still applies ===================
  v_capped_in  := now() - make_interval(hours => v_cap_hours + 5);
  v_expect_out := v_capped_in + make_interval(hours => v_cap_hours);
  UPDATE public.station_presence SET checked_out_at = now()
   WHERE member_id = v_m1 AND checked_out_at IS NULL;
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_m1, v_st_a, 'gps_geofence', 'standby', v_capped_in, true) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(v_exit, v_st_a);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.checked_out_at = v_expect_out AND v_row.auto_closed IS TRUE AND v_row.fence_exit_at = v_exit THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  over-cap shift capped at %sh, flagged, phone reading kept', n, v_cap_hours);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  cap — closed_at=%s expected=%s auto=%s fence_exit=%s', n, v_row.checked_out_at, v_expect_out, v_row.auto_closed, v_row.fence_exit_at);
  END IF; rpt := rpt || chr(10);

  -- ---------------- report, and roll everything back -----------------------
  RAISE EXCEPTION E'RETEST RESULTS  (this error IS the pass — it rolls the fixtures back)\n%\n  passed=%  failed=%  of %\n  dept=%  stationA=%  stationB=%',
    rpt, v_pass, v_fail, n, v_dept, v_st_a, v_st_b;
END
$retest$;
