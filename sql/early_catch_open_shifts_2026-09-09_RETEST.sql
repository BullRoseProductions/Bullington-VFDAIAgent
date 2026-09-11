-- =====================================================================
-- RETEST for early_catch_open_shifts_2026-09-09.sql. READ-ONLY IN EFFECT.
--
-- RUN THIS AFTER THE MIGRATION, on the same database. It writes fixture rows and
-- then throws them away: the whole harness is ONE DO block that ends in RAISE
-- EXCEPTION, which prints the report AND forces the rollback. Nothing it inserts
-- or updates survives, including the impersonation.
--
-- WHY ONE BLOCK AND NOT BEGIN…temp table…ROLLBACK. Supabase pools connections,
-- so a temp table created in one statement is not reliably visible to the next
-- and the harness fails with 'relation does not exist' before testing anything.
-- A single block sidesteps the pool entirely. Learned the hard way in this repo.
--
-- IMPERSONATION IS BY EMAIL, not by auth uid: my_member_id() and the gates
-- resolve the caller from request.jwt.claims->>'email'. Matching the two
-- existing RETEST files.
--
-- ONE OPEN SHIFT AT A TIME, PER MEMBER. station_presence carries a unique
-- constraint (one_open_session_per_member), so the list-filter sections cannot
-- hold an over-threshold row, an under-threshold row and an excluded row open
-- simultaneously — the second insert raises and the harness dies mid-report.
-- Each open-row fixture therefore clears that member's open rows first. This is
-- equivalent to holding them all at once because every assertion looks up its
-- OWN shift_id rather than counting the list, so what matters is whether that
-- one row is present or absent, not what else was beside it.
--
-- THE SANITY CHECK IN SECTION 0 IS NOT OPTIONAL. If impersonation silently
-- fails, is_dept_admin() returns false for everyone and every "rejects a
-- non-admin" case passes FOR THE WRONG REASON while the positive cases fail —
-- a report that looks half-broken but is really all-broken. Section 0 proves
-- the admin identity took before any assertion runs, and aborts if it did not.
-- =====================================================================

DO $retest$
DECLARE
  v_dept      uuid;
  v_admin     uuid;  v_admin_email  text;
  v_officer   uuid;  v_officer_email text;
  v_other     uuid;                       -- a shift in ANOTHER department
  v_id        uuid;
  v_in        timestamptz;
  v_ret       record;
  v_verified  boolean;
  v_bool      boolean;
  v_thresh    integer;
  n           int := 0;
  v_pass      int := 0;
  v_fail      int := 0;
  rpt         text := chr(10);
  v_err       text;
  v_fn        text;
BEGIN
  -- =================== 0. FIXTURES + THE SANITY CHECK ====================
  /* PICK THE DEPARTMENT FIRST, not the admin. An earlier draft took the first
     Department Admin in the table and then looked for an Officer beside them —
     which aborted on production, because that admin's department has no plain
     Officer. The harness needs BOTH identities from the SAME department, so the
     department is what has to satisfy both conditions; choosing either person
     first is choosing before the constraint is known. */
  SELECT d.id INTO v_dept
    FROM public.departments d
   WHERE EXISTS (SELECT 1 FROM public.members m
                  WHERE m.department_id = d.id AND m.email IS NOT NULL AND m.status = 'Active'
                    AND m.access && array['Department Admin'])
     AND EXISTS (SELECT 1 FROM public.members m
                  WHERE m.department_id = d.id AND m.email IS NOT NULL AND m.status = 'Active'
                    AND m.access && array['Officer']
                    AND NOT (m.access && array['Department Admin','Project Admin']))
   ORDER BY d.id LIMIT 1;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: no department has BOTH an active Department Admin and an active plain Officer, each with an email address. The gate tightening cannot be tested without both sides.';
  END IF;

  SELECT m.id, lower(m.email) INTO v_admin, v_admin_email
    FROM public.members m
   WHERE m.department_id = v_dept AND m.email IS NOT NULL AND m.status = 'Active'
     AND m.access && array['Department Admin']
   ORDER BY m.id LIMIT 1;

  -- An Officer who is NOT also an admin — the whole point of the tightening.
  SELECT m.id, lower(m.email) INTO v_officer, v_officer_email
    FROM public.members m
   WHERE m.department_id = v_dept AND m.email IS NOT NULL AND m.status = 'Active'
     AND m.access && array['Officer']
     AND NOT (m.access && array['Department Admin','Project Admin'])
   ORDER BY m.id LIMIT 1;

  SELECT expected_shift_hours INTO v_thresh FROM public.departments WHERE id = v_dept;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_admin_email)::text, true);

  IF public.my_department_id() IS DISTINCT FROM v_dept THEN
    RAISE EXCEPTION 'RETEST ABORTED: impersonation did not take — my_department_id() returned %, expected %. Every gate assertion below would be meaningless.', public.my_department_id(), v_dept;
  END IF;
  IF NOT public.is_dept_admin() THEN
    RAISE EXCEPTION 'RETEST ABORTED: is_dept_admin() is false while impersonating a Department Admin. Fix the harness before reading any result.';
  END IF;

  -- Clear the department's threshold so the 28h default is what is under test.
  UPDATE public.departments SET expected_shift_hours = NULL WHERE id = v_dept;

  -- ============ 1. close_open_shift: the happy path, verified UNTOUCHED ======
  -- verified is flipped to a KNOWN value first, so "unchanged" is a real
  -- observation rather than a coincidence of whatever the row happened to hold.
  DELETE FROM public.station_presence
   WHERE department_id = v_dept AND member_id = v_admin AND checked_out_at IS NULL;
  v_in := now() - interval '30 hours';
  INSERT INTO public.station_presence (department_id, member_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_admin, 'gps_geofence', 'standby', v_in, true) RETURNING id INTO v_id;
  UPDATE public.station_presence SET verified = true WHERE id = v_id;

  SELECT * INTO v_ret FROM public.close_open_shift(v_id, v_in + interval '2 hours');
  SELECT verified INTO v_verified FROM public.station_presence WHERE id = v_id;

  n := n + 1;
  IF v_ret.checked_out_at = v_in + interval '2 hours' AND v_ret.auto_closed = false THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  close_open_shift sets checked_out_at and auto_closed=false%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  close_open_shift wrote out=%s auto_closed=%s%s', n, v_ret.checked_out_at, v_ret.auto_closed, chr(10));
  END IF;

  n := n + 1;
  IF v_verified IS TRUE THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  the arrival verdict is UNTOUCHED by the close (still true)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  the close changed the arrival verdict to %s — STOP, this is the one thing it must never do%s', n, v_verified, chr(10));
  END IF;

  n := n + 1;
  IF v_ret.hours = 2.00 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  returns hours computed from the two timestamps (2.00)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  returned hours=%s, expected 2.00%s', n, v_ret.hours, chr(10));
  END IF;

  -- ============ 2. REJECTS an already-closed row ============================
  BEGIN
    PERFORM public.close_open_shift(v_id, now() - interval '1 hour');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  already-closed rejected: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  already-closed shift was silently overwritten%s', n, chr(10));
  END IF;

  -- ============ 3. REJECTS a future out-time and a pre-check-in one =========
  DELETE FROM public.station_presence
   WHERE department_id = v_dept AND member_id = v_admin AND checked_out_at IS NULL;
  v_in := now() - interval '30 hours';
  INSERT INTO public.station_presence (department_id, member_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_admin, 'gps_geofence', 'standby', v_in, false) RETURNING id INTO v_id;

  BEGIN
    PERFORM public.close_open_shift(v_id, now() + interval '1 hour');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  future out-time rejected: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  accepted an out-time in the future%s', n, chr(10));
  END IF;

  BEGIN
    PERFORM public.close_open_shift(v_id, v_in - interval '1 minute');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  out-time before check-in rejected: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  accepted an out-time before the check-in%s', n, chr(10));
  END IF;

  -- ============ 4. CROSS-DEPARTMENT id is NOT FOUND =========================
  SELECT sp.id INTO v_other FROM public.station_presence sp
   WHERE sp.department_id <> v_dept ORDER BY sp.checked_in_at DESC LIMIT 1;
  IF v_other IS NULL THEN
    rpt := rpt || format('   SKIP  cross-department test: no shift exists in another department%s', chr(10));
  ELSE
    BEGIN
      PERFORM public.close_open_shift(v_other, now());
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err IS NOT NULL THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  another department''s shift not found: "%s"%s', n, v_err, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  closed a shift belonging to ANOTHER DEPARTMENT%s', n, chr(10));
    END IF;
  END IF;

  -- ============ 5. dept_open_long_shifts: over, under, and the exclusions ===
  -- Fresh fixtures, all still OPEN.
  DELETE FROM public.station_presence
   WHERE department_id = v_dept AND member_id = v_admin AND checked_out_at IS NULL;

  INSERT INTO public.station_presence (department_id, member_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_admin, 'gps_geofence', 'standby', now() - interval '30 hours', true) RETURNING id INTO v_id;

  n := n + 1;
  IF EXISTS (SELECT 1 FROM public.dept_open_long_shifts() WHERE shift_id = v_id) THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a fenced shift open 30h is listed (default threshold 28)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  a fenced shift open 30h did NOT appear%s', n, chr(10));
  END IF;

  n := n + 1;
  IF (SELECT hours_open FROM public.dept_open_long_shifts() WHERE shift_id = v_id) BETWEEN 29.9 AND 30.1 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  hours_open reads ~30%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  hours_open was %s%s', n, (SELECT hours_open FROM public.dept_open_long_shifts() WHERE shift_id = v_id), chr(10));
  END IF;

  -- under threshold
  DELETE FROM public.station_presence
   WHERE department_id = v_dept AND member_id = v_admin AND checked_out_at IS NULL;
  INSERT INTO public.station_presence (department_id, member_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_admin, 'gps_geofence', 'standby', now() - interval '3 hours', true) RETURNING id INTO v_id;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM public.dept_open_long_shifts() WHERE shift_id = v_id) THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a fenced shift open only 3h is excluded%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  a 3h shift was flagged%s', n, chr(10));
  END IF;

  -- manual (geo) source, well over threshold -> excluded
  DELETE FROM public.station_presence
   WHERE department_id = v_dept AND member_id = v_admin AND checked_out_at IS NULL;
  INSERT INTO public.station_presence (department_id, member_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_admin, 'geo', 'standby', now() - interval '40 hours', true) RETURNING id INTO v_id;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM public.dept_open_long_shifts() WHERE shift_id = v_id) THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a MANUAL (geo) open shift is excluded even at 40h%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  a manual check-in was flagged as a missed fence exit%s', n, chr(10));
  END IF;

  -- training, well over threshold -> excluded
  DELETE FROM public.station_presence
   WHERE department_id = v_dept AND member_id = v_admin AND checked_out_at IS NULL;
  INSERT INTO public.station_presence (department_id, member_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_admin, 'gps_geofence', 'training', now() - interval '40 hours', true) RETURNING id INTO v_id;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM public.dept_open_long_shifts() WHERE shift_id = v_id) THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a TRAINING row is excluded even at 40h%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  a training row was flagged%s', n, chr(10));
  END IF;

  -- ============ 6. THE PER-DEPARTMENT OVERRIDE actually overrides ===========
  -- The 30h shift from section 5 is still open. Raise the threshold above it and
  -- it must disappear; that is the difference between reading the column and
  -- hardcoding 28.
  DELETE FROM public.station_presence
   WHERE department_id = v_dept AND member_id = v_admin AND checked_out_at IS NULL;
  INSERT INTO public.station_presence (department_id, member_id, source, kind, checked_in_at, verified)
  VALUES (v_dept, v_admin, 'gps_geofence', 'standby', now() - interval '30 hours', true) RETURNING id INTO v_id;

  UPDATE public.departments SET expected_shift_hours = 40 WHERE id = v_dept;
  n := n + 1;
  IF NOT EXISTS (SELECT 1 FROM public.dept_open_long_shifts() WHERE shift_id = v_id) THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  expected_shift_hours=40 suppresses a 30h shift (override beats the default)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  a 30h shift still flagged with the threshold at 40 — the column is being ignored%s', n, chr(10));
  END IF;

  UPDATE public.departments SET expected_shift_hours = 4 WHERE id = v_dept;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM public.dept_open_long_shifts() WHERE shift_id = v_id) THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  expected_shift_hours=4 flags the same shift%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  threshold 4 did not flag a 30h shift%s', n, chr(10));
  END IF;
  UPDATE public.departments SET expected_shift_hours = v_thresh WHERE id = v_dept;

  -- ============ 7. THE GATE. An Officer is refused by all four =============
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_officer_email)::text, true);

  IF public.is_dept_admin() THEN
    RAISE EXCEPTION 'RETEST ABORTED: the chosen Officer passes is_dept_admin(). Pick a different fixture — the gate tests below would pass vacuously.';
  END IF;

  BEGIN PERFORM * FROM public.dept_open_long_shifts(); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  Officer refused by dept_open_long_shifts: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  an Officer could READ the open-shift list%s', n, chr(10));
  END IF;

  BEGIN PERFORM public.close_open_shift(v_id, now()); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  Officer refused by close_open_shift: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  an Officer CLOSED a shift%s', n, chr(10));
  END IF;

  BEGIN PERFORM public.resolve_auto_closed_shift(v_id, now()); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  n := n + 1;
  IF v_err = 'Not authorized' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  Officer refused by resolve_auto_closed_shift (tightened)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  resolve_auto_closed_shift gave an Officer: "%s" — expected "Not authorized"%s', n, coalesce(v_err, '(no error)'), chr(10));
  END IF;

  BEGIN PERFORM public.void_auto_closed_shift(v_id); v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  n := n + 1;
  IF v_err = 'Not authorized' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  Officer refused by void_auto_closed_shift (tightened)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  void_auto_closed_shift gave an Officer: "%s" — expected "Not authorized"%s', n, coalesce(v_err, '(no error)'), chr(10));
  END IF;

  -- ============ 8. anon HOLDS NO EXECUTE on either new function ============
  -- The migration checks this too, in its own transaction. Repeated here because
  -- a later DROP+CREATE re-opens it and the capture/replay pattern does not put
  -- the revoke back — so this is the check worth being able to re-run alone.
  FOREACH v_fn IN ARRAY array[
    'public.dept_open_long_shifts()',
    'public.close_open_shift(uuid, timestamptz)',
    'public.resolve_auto_closed_shift(uuid, timestamptz)',
    'public.void_auto_closed_shift(uuid)'
  ] LOOP
    v_bool := has_function_privilege('anon', v_fn, 'execute');
    n := n + 1;
    IF v_bool = false THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  anon cannot execute %s%s', n, v_fn, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  anon CAN execute %s%s', n, v_fn, chr(10));
    END IF;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed of % ----\n(this exception is the rollback; nothing above persists)',
        rpt, v_pass, v_fail, n;
END
$retest$;
