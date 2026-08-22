-- =====================================================================
-- GEOFENCE Layer 1 — cap the SHIFT, not the EVENT'S AGE.
--
-- NOT YET APPLIED. Review, then run by hand.
--
-- WHAT WAS WRONG. geofence_arrive refused any arrival older than the
-- department's max_shift_hours. That was defensible while every event arrived
-- live: a stale arrival would only have been swept up by auto_close_stale_shifts
-- on the next tick anyway, so refusing was quieter than recording something worth
-- zero hours.
--
-- The catch-up replay makes it wrong. Capacitor has no JS headless task, so a
-- transition that fires while the app is terminated is buffered on the device and
-- replayed on the next open — which may be hours or days later. Under the old
-- rule that replay played out like this:
--
--     08:00  member arrives            (buffered on device)
--     11:00  member leaves             (buffered on device)
--     21:00  member opens the app  ->  arrive replayed, 13h old, cap 10h
--                                       -> REJECTED
--                                  ->  depart replayed, finds no open row
--                                       -> returns NULL, by design
--
-- Three hours somebody actually stood, gone. No row, no error anyone sees, and
-- nothing in the needs-review queue to notice — the shift simply never existed.
-- The age of an event says nothing about whether it happened; only about how long
-- the phone waited to tell us.
--
-- WHAT THIS CHANGES.
--   geofence_arrive  — drops the max_shift_hours age test. Keeps a generous
--                      absurdity bound (30 days) and the existing clock-skew
--                      handling, because a device we do not control can still send
--                      nonsense. ALSO becomes idempotent against an arrival already
--                      recorded, open or closed — see below; without that, replay
--                      duplicates ordinary completed shifts.
--   geofence_depart  — takes over the cap, applied to the INTERVAL.
--
-- THE DUPLICATION BUG THIS ALSO FIXES. The SDK persists every transition, including
-- ones the live handler already processed, and the live handler does not delete the
-- record it handled. So the next app open replays arrivals belonging to shifts that
-- have since closed. arrive's idempotency only recognised a still-OPEN session, so a
-- completed shift was invisible to it: the replayed arrival inserted a second row and
-- the replayed EXIT closed it. Every ordinary shift double-recorded on the next open —
-- app backgrounded, shift completes live, member reopens later — which is the common
-- path, not the terminated-app edge case, and it inflates the very hours ISO and LOSAP
-- are counted from. arrive now matches on arrival TIME regardless of whether the row is
-- open or closed, so a replayed event lands on the row it already created.
--   geofence_depart  — takes over the cap, applied to the INTERVAL. A shift longer
--                      than max_shift_hours closes at checked_in_at + cap and is
--                      marked auto_closed, exactly as auto_close_stale_shifts
--                      already does. Capped and visible to a human, never silently
--                      discarded.
--
-- WHY auto_closed IS THE RIGHT FLAG. It already means "this stop time was guessed
-- by a machine": excluded from credit until reviewed, and surfaced by the
-- needs-review queue. An over-long geofence shift is the same claim, so it gets
-- the same treatment rather than a second concept doing the same job.
--
-- WHAT IS DELIBERATELY UNCHANGED.
--   • depart still closes ONLY source='gps_geofence' rows. A manual check-in is a
--     human statement about their own shift; a daemon must not overrule it.
--   • depart still returns NULL rather than raising when nothing of ours is open.
--     An EXIT after a manual clock-out is normal, not an error.
--   • depart still never touches a row that already has checked_out_at, so an
--     auto_closed row stays closed. Re-crediting an auto-closed shift is a human's
--     decision through the review screen and nothing else's.
--   • identity gate, geofence_enabled gate on arrive, is_at_point() re-verification,
--     and the arrive idempotency check all stand exactly as they were.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. geofence_arrive — record it, whenever the phone got round to telling us.
--
-- SANITY BOUNDS, and only sanity bounds:
--   • more than 5 minutes in the future -> reject. Not skew, a broken clock.
--   • slightly in the future            -> clamp to now(). Phone clocks drift.
--   • older than 30 days                -> reject. Nothing legitimate replays a
--     month later; that is a corrupt queue or a device whose clock is years off,
--     and inserting it would distort every report it lands in.
--
-- Note what is NOT here any more: any comparison against max_shift_hours. How long
-- ago a shift STARTED is not evidence about how long it RAN. That question is
-- answered on close, where the answer actually exists.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geofence_arrive(
  p_lat      double precision,
  p_lng      double precision,
  p_accuracy double precision DEFAULT NULL,
  p_at       timestamptz      DEFAULT NULL
) RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member  uuid := public.my_member_id();
  v_dept    uuid := public.my_department_id();
  v_enabled boolean;
  v_lat     double precision;
  v_lng     double precision;
  v_radius  integer;
  v_at      timestamptz := coalesce(p_at, now());
  v_row     public.station_presence;
begin
  if v_member is null or v_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;

  select geofence_enabled, station_lat, station_lng, station_radius_m
    into v_enabled, v_lat, v_lng, v_radius
    from public.departments where id = v_dept;

  if not coalesce(v_enabled, false) then
    raise exception 'Automatic arrival is not switched on for your department.';
  end if;

  -- the device's clock is not ours to trust
  if v_at > now() + interval '5 minutes' then
    raise exception 'That arrival is timestamped in the future — check the device clock.';
  end if;
  if v_at > now() then
    v_at := now();                                  -- ordinary drift; clamp rather than refuse
  end if;
  if v_at < now() - interval '30 days' then
    raise exception 'That arrival is more than 30 days old and was not recorded.';
  end if;

  -- already on the clock? hand back that row. Never open a second session.
  select * into v_row from public.station_presence
   where member_id = v_member
     and checked_out_at is null
     and kind in ('standby','offsite')
   order by checked_in_at desc limit 1;
  if found then return v_row; end if;

  /* ALREADY RECORDED — OPEN OR CLOSED. Without this, replay duplicates every shift.

     The check above only sees a session that is still open, which was sufficient while
     the only caller was a live event. It is not sufficient now. The SDK persists every
     transition, including ones the live handler already wrote, and the live handler does
     not delete the record it processed — so the next app open replays arrivals for shifts
     that have since COMPLETED. A completed shift is invisible to the open-row check, so
     the replay fell through to the insert below and created a second row, which the
     replayed EXIT then closed. Every ordinary shift double-recorded on the next open:
     app backgrounded, shift runs and closes live, member reopens later. That is the
     common path, not an edge case, and it inflates exactly the hours ISO and LOSAP are
     counted from.

     Matching on ARRIVAL TIME is what makes replay a no-op: a replayed event carries the
     same event timestamp it did when it fired, so it lands on the row it already created.
     Two minutes of tolerance because the same instant can be stored a beat apart, while
     two genuinely distinct arrivals are always separated by far more — a member must
     leave the fence, travel, and then dwell inside it again before another arrival can
     ever be raised.

     KNOWN RESIDUAL GAP, flagged rather than hidden: the clamp above rewrites a
     future-dated arrival to now(). If a device's clock runs 2–5 minutes fast, the live
     row is stored at now() while the later replay — no longer in the future — is stored
     at the raw event time, and the two can differ by more than this tolerance and
     duplicate anyway. Narrow, but real. Widening the tolerance closes it at the cost of
     merging two genuine visits that are close together; that trade is a decision, not a
     detail, so it is left as written. */
  select * into v_row from public.station_presence
   where member_id = v_member
     and source = 'gps_geofence'                     -- only rows this function created
     and kind in ('standby','offsite')
     and checked_in_at between v_at - interval '2 minutes' and v_at + interval '2 minutes'
   order by abs(extract(epoch from (checked_in_at - v_at)))   -- the closest match, not merely the newest
   limit 1;
  if found then return v_row; end if;

  insert into public.station_presence
    (department_id, member_id, verified, source, kind, checked_in_at)
  values
    (v_dept, v_member,
     public.is_at_point(v_lat, v_lng, v_radius, p_lat, p_lng, p_accuracy),   -- the SERVER decides
     'gps_geofence', 'standby', v_at)
  returning * into v_row;

  return v_row;
end;
$function$;

REVOKE ALL ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz)
  TO authenticated;


-- ---------------------------------------------------------------------
-- 2. geofence_depart — close what the daemon opened, and bound the length here.
--
-- THE CAP MOVED HERE because this is the first moment both ends of the shift are
-- known. Three outcomes:
--
--   within the cap        -> close at the real departure time. auto_closed stays
--                            false and the hours credit normally.
--   longer than the cap   -> close at checked_in_at + max_shift_hours and set
--                            auto_closed. The member is not accused of anything and
--                            the hours are not thrown away — a human sets the real
--                            out-time from the review screen.
--   ends before it began  -> an out-of-order or corrupt event. Close at
--                            checked_in_at (zero length) and flag it. Falling back
--                            to now() here would invent a shift out of a broken
--                            timestamp, and days later on replay that invention
--                            could be a full capped shift.
--
-- p_at is still the EVENT's timestamp, so a departure replayed a day late records
-- when the member actually left rather than when the app happened to open.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geofence_depart(
  p_at timestamptz DEFAULT NULL
) RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member uuid := public.my_member_id();
  v_at     timestamptz := coalesce(p_at, now());
  v_cap    integer;
  v_limit  timestamptz;
  v_auto   boolean := false;
  v_row    public.station_presence;
begin
  if v_member is null then
    raise exception 'We could not match your login to a member record.';
  end if;

  if v_at > now() then
    v_at := now();                                  -- device clock drift
  end if;

  select * into v_row from public.station_presence
   where member_id = v_member
     and checked_out_at is null                     -- never re-close an auto_closed row
     and source = 'gps_geofence'                    -- ONLY what the daemon opened
     and kind in ('standby','offsite')
   order by checked_in_at desc limit 1;

  if not found then
    return null;                                    -- nothing of ours is open; not an error
  end if;

  select max_shift_hours into v_cap
    from public.departments where id = v_row.department_id;
  v_limit := v_row.checked_in_at + make_interval(hours => coalesce(v_cap, 10));

  if v_at <= v_row.checked_in_at then
    -- a departure that predates its own arrival tells us nothing trustworthy
    v_at   := v_row.checked_in_at;
    v_auto := true;
  elsif v_at > v_limit then
    -- longer than the department allows: cap it and hand it to a human
    v_at   := v_limit;
    v_auto := true;
  end if;

  update public.station_presence
     set checked_out_at = v_at,
         auto_closed    = v_auto
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

REVOKE ALL ON FUNCTION public.geofence_depart(timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_depart(timestamptz) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. Signatures and grants unchanged. Expect definer=t, anon=f, auth=t on both,
-- --    and exactly one of each (no overloads).
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS check,
--        format('definer=%s anon=%s auth=%s', prosecdef,
--               has_function_privilege('anon', oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE')) AS value
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname IN ('geofence_arrive','geofence_depart')
--  ORDER BY proname;
--
-- -- 2. The age test is gone from arrive, and the cap now appears in depart.
-- --    Expect: arrive 0, depart 1.
-- SELECT proname,
--        (prosrc ILIKE '%older than a full shift%')::int AS old_age_test,
--        (prosrc ILIKE '%max_shift_hours%')::int         AS references_cap
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname IN ('geofence_arrive','geofence_depart')
--  ORDER BY proname;
--
-- -- 3. THE REGRESSION THIS EXISTS TO FIX — a 3-hour shift replayed 13 hours late
-- --    must survive intact. Run as a real member with geofence_enabled on;
-- --    ROLLBACK discards it. Expect ONE row, ~3.0 hours, auto_closed = false.
-- --
-- --   BEGIN;
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '13 hours');
-- --     SELECT public.geofence_depart(now() - interval '10 hours');
-- --     SELECT checked_in_at, checked_out_at, auto_closed,
-- --            round(extract(epoch from (checked_out_at - checked_in_at))/3600.0, 2) AS hours
-- --       FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source = 'gps_geofence'
-- --      ORDER BY checked_in_at DESC LIMIT 1;
-- --   ROLLBACK;
--
-- -- 4. THE CAP STILL BITES — a 30-hour shift must close at the cap and be flagged,
-- --    not credited in full. Expect hours = max_shift_hours (10 by default) and
-- --    auto_closed = true.
-- --
-- --   BEGIN;
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '30 hours');
-- --     SELECT public.geofence_depart(now());
-- --     SELECT auto_closed,
-- --            round(extract(epoch from (checked_out_at - checked_in_at))/3600.0, 2) AS hours
-- --       FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source = 'gps_geofence'
-- --      ORDER BY checked_in_at DESC LIMIT 1;
-- --   ROLLBACK;
--
-- -- 5. Absurdity bound still refuses. Expect an exception.
-- --   BEGIN;
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '60 days');
-- --   ROLLBACK;
--
-- -- 6. THE DUPLICATION FIX — replaying a COMPLETED shift must change nothing.
-- --    This is the regression that was about to double-count every ordinary shift.
-- --    Expect exactly ONE row after the replay, with its original times intact.
-- --
-- --   BEGIN;
-- --     -- the shift, recorded live
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '5 hours');
-- --     SELECT public.geofence_depart(now() - interval '2 hours');
-- --
-- --     -- the SAME events replayed from the device queue on the next app open
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '5 hours');
-- --     SELECT public.geofence_depart(now() - interval '2 hours');
-- --
-- --     SELECT count(*) AS rows_expect_1,
-- --            round(sum(extract(epoch from (checked_out_at - checked_in_at)))/3600.0, 2) AS hours_expect_3
-- --       FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source = 'gps_geofence'
-- --        AND checked_in_at > now() - interval '6 hours';
-- --   ROLLBACK;
--
-- -- 7. Two GENUINELY distinct arrivals must still be two rows — the tolerance must
-- --    not merge real visits. 4 hours apart, well outside the 2-minute window.
-- --    Expect 2 rows.
-- --
-- --   BEGIN;
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '9 hours');
-- --     SELECT public.geofence_depart(now() - interval '8 hours');
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '5 hours');
-- --     SELECT public.geofence_depart(now() - interval '4 hours');
-- --     SELECT count(*) AS rows_expect_2 FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source = 'gps_geofence'
-- --        AND checked_in_at > now() - interval '10 hours';
-- --   ROLLBACK;
--
-- -- 6. A manual row is still untouchable by the daemon. Expect NULL and the manual
-- --    row still open.
-- --   BEGIN;
-- --     SELECT public.station_check_in();          -- or however the manual punch is made
-- --     SELECT public.geofence_depart(now());      -- expect NULL
-- --     SELECT source, checked_out_at FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND checked_out_at IS NULL;
-- --   ROLLBACK;
