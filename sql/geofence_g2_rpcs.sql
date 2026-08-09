-- =====================================================================
-- GEOFENCE G2 — the arrive/depart RPCs. INERT.
--
-- Nothing calls these until G5 wires the native daemon, and geofence_arrive
-- refuses outright for a department that has not set geofence_enabled (0 of 2
-- today). Applying this changes no screen and no number.
--
-- THE TRUST MODEL. The phone says "I crossed the fence". That is a claim, not
-- evidence: the OS can replay a stale event, a rooted device can fake a
-- location, and the daemon runs where we cannot see it. So the server
-- re-verifies the coordinates against the department's own pin with the same
-- is_at_point() the PWA check-in uses. A geofence session is verified because
-- the SERVER agreed, never because the device asserted it.
--
-- DEDUPE. The PWA and the daemon are two independent writers. geofence_arrive
-- returns an existing open standby/offsite row unchanged rather than opening a
-- second one — and G1's unique index is the backstop if both fire at the same
-- instant, which a read-then-insert guard alone cannot cover.
--
-- ASYMMETRY, ON PURPOSE. arrive defers to a manual check-in; depart does NOT
-- close one. The daemon unwinds only what the daemon created
-- (source='gps_geofence'). A member who clocks in by hand and drives away falls
-- to auto_close_stale_shifts, not to a phone deciding their shift is over.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. geofence_arrive — open a standby session on ENTER.
--
-- p_at is the EVENT's timestamp, not now(). The plugin persists events while
-- offline and replays them later, so a queued ENTER from two hours ago must
-- open the session when it happened or every offline arrival silently loses its
-- first hours. NULL means "live event, no queue delay" and falls back to now().
--
-- SANITY BOUNDS on p_at, because it arrives from a device we do not control:
--   • more than 5 minutes in the future  -> reject. Not clock skew, a bad clock.
--   • slightly in the future             -> clamp to now(). Phone clocks drift.
--   • older than the department's max_shift_hours -> reject. The sweeper would
--     auto-close it on the next tick anyway, so recording it produces a
--     needs-review row worth zero hours and nothing else. Refusing is quieter
--     and truthful; the member can clock in by hand if they really are on shift.
--
-- The idempotency check covers standby/offsite ONLY. An open TRAINING row must
-- not block an arrival — that overlap is the whole point of the ledger, and
-- G1b exists because a broader rule broke it.
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
  v_cap     integer;
  v_lat     double precision;
  v_lng     double precision;
  v_radius  integer;
  v_at      timestamptz := coalesce(p_at, now());
  v_row     public.station_presence;
begin
  if v_member is null or v_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;

  select geofence_enabled, max_shift_hours, station_lat, station_lng, station_radius_m
    into v_enabled, v_cap, v_lat, v_lng, v_radius
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
  if v_at < now() - make_interval(hours => coalesce(v_cap, 10)) then
    raise exception 'That arrival is older than a full shift and was not recorded — clock in manually if you are on station.';
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
-- 2. geofence_depart — close what the daemon opened, and only that.
--
-- source='gps_geofence' is the whole safety property. A manual check-in is a
-- human statement about their own shift; a background process must not overrule
-- it because the phone drifted out of a circle.
--
-- DELIBERATELY SILENT when there is nothing to close. station_check_out raises
-- "You are not currently checked in." because a person tapped a button and
-- deserves an answer. An EXIT firing after the member already clocked out by
-- hand is NORMAL, not an error, and a daemon that throws on normal produces
-- noise nobody reads. Returns NULL instead.
--
-- p_at BEYOND THE BRIEF, and flagged as such: the offline queue replays EXIT
-- events too, so a departure delivered an hour late would otherwise stamp now()
-- and overstate the shift by an hour. It is DEFAULTED, so geofence_depart()
-- with no arguments still works exactly as specified. Bounded the same way as
-- arrive, and never before the row opened.
--
-- No geofence_enabled check here, on purpose: if a department switches the
-- feature off mid-shift, an already-open geofence row must still be closable,
-- or it strands until the sweeper caps it.
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
     and checked_out_at is null
     and source = 'gps_geofence'                    -- ONLY what the daemon opened
     and kind in ('standby','offsite')
   order by checked_in_at desc limit 1;

  if not found then
    return null;                                    -- nothing of ours is open; not an error
  end if;

  -- a replayed EXIT must never close a shift before it started
  if v_at <= v_row.checked_in_at then
    v_at := now();
  end if;

  update public.station_presence
     set checked_out_at = v_at
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
-- -- 1. Signatures and grants. Expect definer=t, anon=f, auth=t on both, and
-- --    exactly one of each (no overloads).
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS check,
--        format('returns=%s definer=%s cfg=%s anon=%s auth=%s',
--               pg_get_function_result(oid), prosecdef,
--               coalesce(array_to_string(proconfig,','),'-'),
--               has_function_privilege('anon', oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE')) AS value
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname IN ('geofence_arrive','geofence_depart')
--  ORDER BY proname;
--
-- -- 2. INERT PROOF — no department has it switched on, so arrive refuses for
-- --    everyone today. Expect 0 of 2.
-- SELECT count(*) FILTER (WHERE geofence_enabled) AS enabled, count(*) AS total
--   FROM public.departments;
--
-- -- 3. THE PROBE. Run as postgres in this editor, my_member_id() is null, so
-- --    BOTH should raise 'We could not match your login to a member record.'
-- --    That error is the PASS: it proves the function is reachable and its first
-- --    gate fires. Nothing is written; the ROLLBACK and the aborted transaction
-- --    both discard it. Run each block separately.
-- --
-- --   BEGIN;
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now());
-- --   ROLLBACK;
-- --
-- --   BEGIN;
-- --     SELECT public.geofence_depart();
-- --   ROLLBACK;
--
-- -- 4. Nothing was created. Expect 0 — only these RPCs write gps_geofence, and
-- --    they cannot succeed until a department opts in AND a real member calls.
-- SELECT count(*) AS gps_geofence_rows FROM public.station_presence
--  WHERE source = 'gps_geofence';
--
-- -- 5. The source CHECK from G1 accepts what these write. Expect the constraint
-- --    to list gps_geofence.
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.station_presence'::regclass AND conname='station_presence_source_check';
