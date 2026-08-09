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
--                      nonsense.
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
-- -- 6. A manual row is still untouchable by the daemon. Expect NULL and the manual
-- --    row still open.
-- --   BEGIN;
-- --     SELECT public.station_check_in();          -- or however the manual punch is made
-- --     SELECT public.geofence_depart(now());      -- expect NULL
-- --     SELECT source, checked_out_at FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND checked_out_at IS NULL;
-- --   ROLLBACK;
