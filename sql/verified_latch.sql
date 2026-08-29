-- =====================================================================
-- VERIFIED BECOMES A LATCH — a shift can be confirmed on-station more than once.
--
-- THE BUG, from real-GPS testing at Station 1: two back-to-back arrivals, one
-- verified and one not. `verified` is decided from a SINGLE GPS fix and never
-- revisited, so whether a member's hours count comes down to the quality of one
-- sample. Stand in the same bay twice and get two different answers.
--
-- WHY THAT FIX IS THE WORST ONE AVAILABLE. Arrival fires on DWELL, not ENTER
-- (notifyOnEntry:false, notifyOnDwell:true, loiteringDelay 2 min) — but the SDK
-- attaches the TRIGGERING location to that event, which is the fix taken at the
-- boundary crossing two minutes earlier. Worst geometry, often worst accuracy,
-- and waiting longer does not improve it because the payload is already stale
-- when it arrives.
--
-- THE LATCH. verified goes false -> true and NEVER the other way. Any fix taken
-- while the shift is open that puts the member inside the station radius upgrades
-- it. Nothing anywhere writes verified = false.
--
-- WHY ONE-WAY IS THE WHOLE DESIGN, not a convenience: being off-station later is
-- not evidence you were never there. A member who genuinely stood in the bay for
-- four hours must not be un-credited because a later sample caught them at the
-- door. Departure is the extreme case of that, which is why geofence_depart takes
-- no coordinates at all and is NOT TOUCHED BY THIS FILE.
--
-- TWO CALLERS, ONE RULE:
--   geofence_confirm_presence()  the app foregrounds with a shift open -> one fix
--   station_check_in()           a member taps clock-in with a shift already open;
--                                today that early-returns and THROWS AWAY the fix
--                                it was just handed
--
-- COMPLIANCE. dept_iso_hours credits rows that are `verified` AND closed. This
-- only ever upgrades an OPEN shift, so by the time a row is countable its verdict
-- is already settled — no already-counted row changes. The direction is
-- uncredited -> credited only, so no existing credited hour can shrink. The ISO
-- total can RISE, and that is the point: those are hours somebody actually stood.
--
-- DEPLOY GATE: apply BEFORE the client deploys — the client calls
-- geofence_confirm_presence by name.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  -- THE CHECK THE BRIEF ASKED FOR, made structural rather than manual: if
  -- geofence_depart mentions `verified` at all, the premise of this file is wrong
  -- and it must not apply. Departure must never influence the verdict.
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace='public'::regnamespace AND proname='geofence_depart'
                AND prosrc ILIKE '%verified%') THEN
    RAISE EXCEPTION 'Precondition failed: geofence_depart() references `verified`. This file assumes departure never touches the verdict — stop and read its body before going further.';
  END IF;

  -- station_check_in must be the D2a body: per-house verify with the department
  -- fallback. Section 3 reproduces it and would otherwise drop that behaviour.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='station_check_in'
                    AND prosrc ILIKE '%is_at_point(v_slat%'
                    AND prosrc ILIKE '%is_at_station(v_dept%') THEN
    RAISE EXCEPTION 'Precondition failed: station_check_in() is not the D2a body (per-house verify + department fallback). Re-capture pg_get_functiondef before replacing it.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='is_at_point') THEN
    RAISE EXCEPTION 'Precondition failed: is_at_point() is missing. It is the only definition of "on station" this file uses.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='station_presence' AND column_name='station_id') THEN
    RAISE EXCEPTION 'Precondition failed: station_presence.station_id is missing. Apply sql/stations_phaseB3.sql first.';
  END IF;

  RAISE NOTICE 'Pre-flight OK — geofence_depart does not touch verified; station_check_in is the D2a body.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. confirm_on_station() — THE LATCH. One definition of "on station", shared.
--
-- INTERNAL ONLY. Revoked from anon, public AND authenticated: it takes a shift id
-- and would otherwise let any caller aim it at a row that is not theirs. The two
-- SECURITY DEFINER callers below are what establish whose shift it is; this
-- function deliberately does not re-decide that, because two places deciding
-- ownership is how they come to disagree.
--
-- IT CAN ONLY EVER WRITE TRUE. There is no code path here that sets verified
-- false — not on a failed fix, not on a closed shift, not on a missing pin. A
-- fix that does not confirm presence simply changes nothing and returns false to
-- say so.
--
-- OFF-SITE IS EXCLUDED, and this one matters. An off-site row is
-- `verified = false, ALWAYS` by design (slice7b3) because it was never measured
-- against a station — it verifies against the DRILL's location instead. Upgrading
-- one against station coordinates would assert something false about where the
-- member was. Excluded by kind, not left to the coordinates to sort out.
--
-- ALREADY-CLOSED SHIFTS ARE EXCLUDED. Once checked_out_at is set the row is
-- countable, and quietly re-deciding a countable row's credit is exactly the kind
-- of retroactive move the auto-close rule exists to prevent.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_on_station(
  p_shift_id uuid,
  p_lat      double precision,
  p_lng      double precision,
  p_accuracy double precision
) RETURNS boolean
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row   public.station_presence;
  v_slat  double precision;
  v_slng  double precision;
  v_srad  integer;
  v_ok    boolean;
begin
  if p_lat is null or p_lng is null then
    return false;                      -- no fix, nothing to confirm
  end if;

  select * into v_row from public.station_presence where id = p_shift_id;
  if not found then return false; end if;

  -- Only an OPEN, non-off-site shift is a candidate. See the header for both.
  if v_row.checked_out_at is not null then return false; end if;
  if v_row.kind = 'offsite'            then return false; end if;

  -- Already true: the latch has nothing left to do. Reported as success, because
  -- from the caller's point of view the shift IS confirmed.
  if coalesce(v_row.verified, false) then return true; end if;

  -- The house this shift was attributed to, falling back to the department pin
  -- exactly as station_check_in does — same two-step, so "on station" means the
  -- same thing on every path.
  if v_row.station_id is not null then
    select s.lat, s.lng, s.radius_m into v_slat, v_slng, v_srad
      from stations s where s.id = v_row.station_id;
  end if;
  if v_slat is null or v_slng is null then
    select d.station_lat, d.station_lng, d.station_radius_m
      into v_slat, v_slng, v_srad
      from departments d where d.id = v_row.department_id;
  end if;
  if v_slat is null or v_slng is null then
    return false;                      -- nothing pinned to measure against
  end if;

  v_ok := public.is_at_point(v_slat, v_slng, v_srad, p_lat, p_lng, p_accuracy);
  if not v_ok then
    return false;                      -- NOT inside. Changes nothing. Never writes false.
  end if;

  update public.station_presence
     set verified = true
   where id = p_shift_id
     and verified is distinct from true;   -- belt: the write itself is one-way

  return true;
end;
$function$;

-- Internal. No caller outside this schema's SECURITY DEFINER functions.
REVOKE ALL ON FUNCTION public.confirm_on_station(uuid, double precision, double precision, double precision)
  FROM anon, public, authenticated;


-- ---------------------------------------------------------------------
-- 2. geofence_confirm_presence() — the automatic path.
--
-- The client calls this when the app comes to the foreground and the member has
-- an open shift: one fix, one chance to upgrade. It is what rescues a member who
-- really is standing in the bay but whose DWELL fix landed on the fence edge.
--
-- OWN ROW ONLY, and that is the whole authorization story. The caller does not
-- pass a shift id — it is resolved from my_member_id(), so there is no argument
-- to point at somebody else's shift. Combined with the latch, the worst a hostile
-- caller can do is confirm their OWN presence while genuinely inside the radius,
-- which is the thing the function is for.
--
-- NO LEADERSHIP GATE, deliberately: every member needs this, and it grants
-- nothing a member could not already achieve by tapping clock-in from the same
-- spot.
--
-- Returns the row so the client can reflect the change without a second read;
-- null when there is no open shift, which is the ordinary case and not an error.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geofence_confirm_presence(
  p_lat      double precision,
  p_lng      double precision,
  p_accuracy double precision DEFAULT NULL
) RETURNS station_presence
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member uuid := public.my_member_id();
  v_row    public.station_presence;
begin
  if v_member is null then
    raise exception 'We could not match your login to a member record.';
  end if;

  -- The caller's OWN open shift. Off-site is excluded here as well as in the
  -- helper: not because one check is insufficient, but because a reader of this
  -- function should not have to open another one to learn that off-site is out.
  select * into v_row from public.station_presence
   where member_id = v_member
     and checked_out_at is null
     and kind <> 'offsite'
   order by checked_in_at desc
   limit 1;

  if not found then
    return null;                       -- nothing open; not an error
  end if;

  perform public.confirm_on_station(v_row.id, p_lat, p_lng, p_accuracy);

  -- Re-read so the caller sees the latched value rather than the pre-update copy.
  select * into v_row from public.station_presence where id = v_row.id;
  return v_row;
end;
$function$;

REVOKE ALL    ON FUNCTION public.geofence_confirm_presence(double precision, double precision, double precision) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.geofence_confirm_presence(double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.geofence_confirm_presence(double precision, double precision, double precision) TO service_role;


-- ---------------------------------------------------------------------
-- 3. station_check_in() — stop throwing away the fix it was handed.
--
-- REPRODUCED FROM THE D2a BODY. Same 5-argument signature, so CREATE OR REPLACE
-- is valid, the ACL survives and there are no grant lines here. Every gate, the
-- kind validation, the per-house verify with the department fallback and the
-- insert are carried over unchanged.
--
-- ONE CHANGE, at the already-open early return. It used to be:
--
--     if found then return v_row; end if;
--
-- A member tapping clock-in while a shift is open arrives with p_lat/p_lng in
-- hand — a deliberate, foreground, usually-good fix — and that line discarded it
-- and handed back the row with its original verdict. If the arrival fix had been
-- poor, tapping clock-in from inside the bay did nothing at all.
--
-- Now the same fix goes through the latch first. The early return stays an early
-- return: no second row, no change to what is returned, no new failure mode. The
-- only difference is that a member standing on station can now fix their own
-- verdict by doing the obvious thing.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.station_check_in(
  p_lat        double precision DEFAULT NULL::double precision,
  p_lng        double precision DEFAULT NULL::double precision,
  p_accuracy   double precision DEFAULT NULL::double precision,
  p_kind       text             DEFAULT 'standby'::text,
  p_session_id uuid             DEFAULT NULL::uuid
)
 RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member   uuid := public.my_member_id();
  v_dept     uuid := public.my_department_id();
  v_station  uuid;
  v_slat     double precision;
  v_slng     double precision;
  v_srad     integer;
  v_verified boolean := false;
  v_row      public.station_presence;
begin
  if v_member is null or v_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  if p_kind not in ('training','standby','incident') then
    raise exception 'Invalid session type.';
  end if;
  select * into v_row from public.station_presence
    where member_id = v_member and checked_out_at is null
    order by checked_in_at desc limit 1;
  if found then
    -- THE CHANGE: latch on the fix we were just given, then hand back the row as
    -- before. The helper does nothing unless it confirms presence.
    perform public.confirm_on_station(v_row.id, p_lat, p_lng, p_accuracy);
    select * into v_row from public.station_presence where id = v_row.id;
    return v_row;
  end if;

  -- D2a: measure against the house being viewed, when it has a pin.
  v_station := public.my_active_station_id();
  if v_station is not null then
    select s.lat, s.lng, s.radius_m into v_slat, v_slng, v_srad
      from stations s where s.id = v_station;
  end if;

  if v_slat is not null and v_slng is not null then
    v_verified := public.is_at_point(v_slat, v_slng, v_srad, p_lat, p_lng, p_accuracy);
  else
    v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);   -- unchanged fallback
  end if;

  insert into public.station_presence (department_id, member_id, verified, source, kind, session_id)
  values (v_dept, v_member, v_verified, 'geo', p_kind, p_session_id)
  returning * into v_row;
  return v_row;
end;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after). Checks 5-8 write and every one of them ROLLS BACK.
-- =====================================================================
--
-- -- 1. Shapes and grants. EXPECT confirm_on_station anon=f auth=f svc=f (INTERNAL);
-- --    geofence_confirm_presence anon=f auth=t svc=t; all definer=t, copies=1.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        count(*) OVER (PARTITION BY proname) AS copies, prosecdef AS definer,
--        has_function_privilege('anon',          oid,'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid,'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  oid,'EXECUTE') AS svc_exec
--   FROM pg_proc WHERE pronamespace='public'::regnamespace
--    AND proname IN ('confirm_on_station','geofence_confirm_presence','station_check_in')
--  ORDER BY proname;
--
-- -- 2. THE LATCH IS ONE-WAY. No function in this schema writes verified = false.
-- --    EXPECT zero rows. This is the check that matters most.
-- SELECT proname FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND prosrc ~* 'verified\s*(=|:=)\s*false'
--    AND proname NOT IN ('member_check_in','slice7b3_placeholder');   -- see note
--  -- NOTE: member_check_in and the off-site check-in legitimately INSERT a row with
--  -- verified=false. That is creating a verdict, not revoking one. What must not
--  -- exist anywhere is an UPDATE that sets an existing true back to false:
-- SELECT proname FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND prosrc ~* 'set[^;]*verified\s*=\s*false';                    -- EXPECT zero rows
--
-- -- 3. geofence_depart STILL does not touch verified. EXPECT false.
-- SELECT (prosrc ILIKE '%verified%') AS touches_verified
--   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='geofence_depart';
--
-- -- 4. UNTOUCHED PROOF — diff each against its pre-apply capture.
-- SELECT pg_get_functiondef('public.geofence_depart'::regproc);
-- SELECT pg_get_functiondef('public.geofence_arrive'::regproc);
-- SELECT pg_get_functiondef('public.is_at_point'::regproc);
-- SELECT pg_get_functiondef('public.is_at_station'::regproc);
--
-- ---------- SIGNED IN AS A MEMBER ----------
-- -- 5. THE RESCUE. Open an UNVERIFIED shift, then confirm from the station's own
-- --    coordinates. EXPECT verified flips false -> true.
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, checked_in_at)
-- --     VALUES (public.my_department_id(), public.my_member_id(), false, 'gps_geofence', 'standby', now());
-- --     SELECT verified FROM public.geofence_confirm_presence(
-- --       (SELECT lat FROM public.stations WHERE department_id = public.my_department_id() AND is_default),
-- --       (SELECT lng FROM public.stations WHERE department_id = public.my_department_id() AND is_default),
-- --       10);
-- --   ROLLBACK;
-- --
-- -- 6. A FIX FROM MILES AWAY CHANGES NOTHING — and does NOT write false.
-- --    EXPECT verified stays false, no error.
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, checked_in_at)
-- --     VALUES (public.my_department_id(), public.my_member_id(), false, 'gps_geofence', 'standby', now());
-- --     SELECT verified FROM public.geofence_confirm_presence(0.0, 0.0, 10);
-- --   ROLLBACK;
-- --
-- -- 7. AN ALREADY-VERIFIED SHIFT IS NEVER DOWNGRADED by a bad fix. EXPECT true.
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, checked_in_at)
-- --     VALUES (public.my_department_id(), public.my_member_id(), true, 'gps_geofence', 'standby', now());
-- --     SELECT verified FROM public.geofence_confirm_presence(0.0, 0.0, 10);
-- --   ROLLBACK;
-- --
-- -- 8. station_check_in NO LONGER DISCARDS THE FIX. With an unverified shift open,
-- --    clocking in from the station upgrades it instead of returning it unchanged.
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, checked_in_at)
-- --     VALUES (public.my_department_id(), public.my_member_id(), false, 'gps_geofence', 'standby', now());
-- --     SELECT verified FROM public.station_check_in(
-- --       (SELECT lat FROM public.stations WHERE department_id = public.my_department_id() AND is_default),
-- --       (SELECT lng FROM public.stations WHERE department_id = public.my_department_id() AND is_default),
-- --       10, 'standby', NULL);
-- --   ROLLBACK;
-- --
-- -- 9. AN OFF-SITE ROW IS NEVER UPGRADED against station coordinates. EXPECT the
-- --    row comes back NULL (excluded by kind), verified untouched.
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, checked_in_at)
-- --     VALUES (public.my_department_id(), public.my_member_id(), false, 'geo', 'offsite', now());
-- --     SELECT public.geofence_confirm_presence(
-- --       (SELECT lat FROM public.stations WHERE department_id = public.my_department_id() AND is_default),
-- --       (SELECT lng FROM public.stations WHERE department_id = public.my_department_id() AND is_default),
-- --       10) IS NULL AS correctly_skipped;
-- --   ROLLBACK;
--
-- -- 10. COMPLIANCE FLOOR. Re-run before/after; a CLOSED row's verdict cannot move,
-- --     so these must be identical.
-- SELECT count(*) FILTER (WHERE verified)     AS verified_closed,
--        count(*)                             AS closed_total
--   FROM public.station_presence WHERE checked_out_at IS NOT NULL;
