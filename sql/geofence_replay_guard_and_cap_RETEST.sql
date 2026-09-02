-- =====================================================================
-- RETEST for sql/geofence_replay_guard_and_cap.sql. Run AFTER applying it.
--
-- ONE STATEMENT. Paste and run once.
--
-- IT ENDS BY RAISING AN EXCEPTION ON PURPOSE. The report comes back as the error
-- message, and the exception is what rolls the fixtures back. "ERROR: RETEST
-- RESULTS" IS the successful outcome; the verdicts are in the message body.
--
-- WHY NOT BEGIN … ROLLBACK WITH A TEMP TABLE: that was the first shape, and the
-- editor answered `relation "retest" does not exist` — statements here can be
-- routed through a pooled connection, so a temp table created in one may not
-- exist in the next, and an explicit ROLLBACK is not guaranteed to be honoured
-- either. This test INSERTS INTO PRODUCTION station_presence. The rollback is
-- therefore caused by the statement itself: a DO block that raises is undone by
-- Postgres, whatever the client does around it.
--
-- WHY IT IMPERSONATES: geofence_arrive and geofence_depart resolve the actor
-- through my_member_id() -> lower(auth.email()). The editor carries no JWT.
--
-- ONE OPEN STANDBY PER MEMBER: station_presence_one_open_session_per_member is
-- UNIQUE (member_id) WHERE checked_out_at IS NULL AND kind IN ('standby','offsite'),
-- so each case closes what it opened before the next begins.
-- =====================================================================

DO $retest$
DECLARE
  v_dept    uuid;
  v_station uuid;
  v_slat    double precision;
  v_slng    double precision;
  v_member  uuid;
  v_email   text;
  v_cap     integer;
  v_back    integer;
  v_fcap    integer;          -- the fenced cap this department should now use
  v_before  int;
  v_after   int;
  v_row     public.station_presence;
  v_ret     public.station_presence;
  v_in      timestamptz;
  v_id      uuid;
  n         int := 0;
  v_pass    int := 0;
  v_fail    int := 0;
  rpt       text := chr(10);
BEGIN
  -- ---------------- fixtures: a geofence-enabled department with a pinned house
  SELECT s.department_id, s.id, s.lat, s.lng
    INTO v_dept, v_station, v_slat, v_slng
    FROM public.stations s
    JOIN public.departments d ON d.id = s.department_id
   WHERE d.geofence_enabled AND s.is_active AND s.lat IS NOT NULL AND s.lng IS NOT NULL
   ORDER BY s.is_default DESC
   LIMIT 1;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: no geofence-enabled department has a pinned active station.';
  END IF;

  SELECT id, lower(email) INTO v_member, v_email
    FROM public.members
   WHERE department_id = v_dept AND email IS NOT NULL AND status = 'Active'
   ORDER BY id LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: no active member with an email in that department.';
  END IF;

  SELECT max_shift_hours, geofence_backstop_hours INTO v_cap, v_back
    FROM public.departments WHERE id = v_dept;
  v_fcap := greatest(coalesce(v_back, 36), v_cap);

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
  UPDATE public.station_presence SET checked_out_at = now()
   WHERE member_id = v_member AND checked_out_at IS NULL;

  -- ============ 1. BACKDATED REPLAY INSIDE AN EXISTING SPAN -> REJECTED =====
  -- The Jeff Harper case: an arrival written late, timestamped inside a shift
  -- that has already been opened, closed and credited.
  v_in := now() - interval '3 hours';
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind,
                                       checked_in_at, checked_out_at, verified)
  VALUES (v_dept, v_member, v_station, 'gps_geofence', 'standby',
          v_in, now() - interval '1 hour', true) RETURNING id INTO v_id;
  SELECT count(*) INTO v_before FROM public.station_presence WHERE member_id = v_member;
  v_ret := public.geofence_arrive(v_slat, v_slng, 10, now() - interval '2 hours', v_station);
  SELECT count(*) INTO v_after FROM public.station_presence WHERE member_id = v_member;
  n := n + 1;
  IF v_after = v_before AND v_ret.id = v_id THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  backdated arrival inside a recorded span: rejected, existing row returned', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  backdated replay — rows %s->%s, returned %s (expected %s)', n, v_before, v_after, v_ret.id, v_id);
  END IF; rpt := rpt || chr(10);

  -- ============ 2. LEGITIMATE RE-ENTRY AFTER THE SHIFT CLOSED -> ALLOWED ====
  -- THE CASE THAT MATTERS MOST. The prior shift closed an hour ago; the member
  -- comes back. This must create a NEW row, not swallow the return.
  SELECT count(*) INTO v_before FROM public.station_presence WHERE member_id = v_member;
  v_ret := public.geofence_arrive(v_slat, v_slng, 10, now() - interval '30 minutes', v_station);
  SELECT count(*) INTO v_after FROM public.station_presence WHERE member_id = v_member;
  n := n + 1;
  IF v_after = v_before + 1 AND v_ret.id <> v_id AND v_ret.checked_out_at IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  genuine re-entry after the prior shift closed: NEW row created', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  RE-ENTRY SWALLOWED — rows %s->%s, returned %s', n, v_before, v_after, v_ret.id);
  END IF; rpt := rpt || chr(10);

  -- ============ 3. NEAR-SIMULTANEOUS DUPLICATE -> +/- 2 MIN GUARD ==========
  -- One minute BEFORE the open row's start: outside its range, so containment
  -- cannot see it. The older guard must still catch it.
  SELECT count(*) INTO v_before FROM public.station_presence WHERE member_id = v_member;
  v_ret := public.geofence_arrive(v_slat, v_slng, 10, now() - interval '31 minutes', v_station);
  SELECT count(*) INTO v_after FROM public.station_presence WHERE member_id = v_member;
  n := n + 1;
  IF v_after = v_before THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  near-simultaneous duplicate still caught by the 2-minute guard', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  2-minute guard let a duplicate through — rows %s->%s', n, v_before, v_after);
  END IF; rpt := rpt || chr(10);

  -- ============ 4. NORMAL ARRIVAL + NORMAL EXIT -> UNCHANGED ===============
  UPDATE public.station_presence SET checked_out_at = now() - interval '20 minutes'
   WHERE member_id = v_member AND checked_out_at IS NULL;
  SELECT count(*) INTO v_before FROM public.station_presence WHERE member_id = v_member;
  v_ret := public.geofence_arrive(v_slat, v_slng, 10, now() - interval '10 minutes', v_station);
  v_id := v_ret.id;
  SELECT count(*) INTO v_after FROM public.station_presence WHERE member_id = v_member;
  v_ret := public.geofence_depart(now() - interval '1 minute', v_station);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_after = v_before + 1
     AND v_row.checked_out_at = date_trunc('microsecond', now() - interval '1 minute')
       IS NOT FALSE                                        -- tolerate microsecond rounding
     AND v_row.checked_out_at > v_row.checked_in_at
     AND v_row.auto_closed IS NOT TRUE THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  ordinary arrival then exit: one row, closed at the exit, not flagged', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  ordinary cycle — rows %s->%s closed_at=%s auto=%s', n, v_before, v_after, v_row.checked_out_at, v_row.auto_closed);
  END IF; rpt := rpt || chr(10);

  -- ============ 5. FENCED RUNAWAY USES THE FENCED BACKSTOP =================
  -- Longer than max_shift_hours but SHORTER than the fenced cap. Before this
  -- migration it was trimmed to max_shift_hours and flagged; now it must close
  -- at the real exit, unflagged. This is Matt Hohon's 1.2 lost hours.
  UPDATE public.station_presence SET checked_out_at = now()
   WHERE member_id = v_member AND checked_out_at IS NULL;
  v_in := now() - make_interval(hours => v_cap + 2);      -- past max_shift_hours, inside the backstop
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind,
                                       checked_in_at, verified)
  VALUES (v_dept, v_member, v_station, 'gps_geofence', 'standby', v_in, true) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(now(), v_station);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.auto_closed IS NOT TRUE
     AND v_row.checked_out_at > v_in + make_interval(hours => v_cap) THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  fenced shift past max_shift_hours (%sh) NOT trimmed — fenced cap %sh applies', n, v_cap, v_fcap);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  fenced shift trimmed at max_shift_hours — closed_at=%s auto=%s', n, v_row.checked_out_at, v_row.auto_closed);
  END IF; rpt := rpt || chr(10);

  -- ============ 6. BEYOND THE FENCED CAP STILL CAPS AND FLAGS ==============
  UPDATE public.station_presence SET checked_out_at = now()
   WHERE member_id = v_member AND checked_out_at IS NULL;
  v_in := now() - make_interval(hours => v_fcap + 5);
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind,
                                       checked_in_at, verified)
  VALUES (v_dept, v_member, v_station, 'gps_geofence', 'standby', v_in, true) RETURNING id INTO v_id;
  v_ret := public.geofence_depart(now(), v_station);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.auto_closed IS TRUE
     AND v_row.checked_out_at = v_in + make_interval(hours => v_fcap)
     AND v_row.fence_exit_at IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  beyond the fenced cap: trimmed to %sh, flagged, phone reading kept', n, v_fcap);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  fenced cap — closed_at=%s expected=%s auto=%s', n, v_row.checked_out_at, v_in + make_interval(hours => v_fcap), v_row.auto_closed);
  END IF; rpt := rpt || chr(10);

  -- ============ 7. THE ARRIVAL VERDICT IS NEVER REWRITTEN ==================
  UPDATE public.station_presence SET checked_out_at = now()
   WHERE member_id = v_member AND checked_out_at IS NULL;
  INSERT INTO public.station_presence (department_id, member_id, station_id, source, kind,
                                       checked_in_at, verified)
  VALUES (v_dept, v_member, v_station, 'gps_geofence', 'standby', now() - interval '20 minutes', false)
  RETURNING id INTO v_id;
  v_ret := public.geofence_depart(now(), v_station);
  SELECT * INTO v_row FROM public.station_presence WHERE id = v_id;
  n := n + 1;
  IF v_row.verified IS FALSE THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  departure left the arrival verdict alone (false stayed false)', n);
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  DEPARTURE REWROTE THE ARRIVAL VERDICT: now %s', n, v_row.verified);
  END IF; rpt := rpt || chr(10);

  RAISE EXCEPTION E'RETEST RESULTS  (this error IS the pass — it rolls the fixtures back)\n%\n  passed=%  failed=%  of %\n  dept=%  station=%  max_shift_hours=%  fenced_cap=%',
    rpt, v_pass, v_fail, n, v_dept, v_station, v_cap, v_fcap;
END
$retest$;
