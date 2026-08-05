-- =====================================================================
-- SLICE 7C-3 — branch on the flag, and fail closed. INERT.
--
-- Three body-only changes. All three bodies below were read from pg_proc and
-- are reproduced byte-for-byte around the marked changes — they matched slice 7
-- exactly, but that was established by reading the catalog, not by trusting the
-- files.
--
-- INERT IN PRACTICE: is_offsite is false on all 10 sessions (C1 verified), so
-- every scan still takes the station branch, which is byte-identical to today.
-- The new logic only becomes reachable in C4, when the planning toggle can set
-- the flag. Guards before the state they guard — the B-series discipline.
--
-- THE PROBLEM C3 SOLVES. Slice 7A branched on "are coordinates set". That was
-- right when setting them was the only way to become off-site. It becomes
-- DANGEROUS the moment a session can be marked off-site at planning: a drill
-- flagged off-site whose location has not been captured yet would fall through
-- to `else` and verify everyone against the station they are nowhere near.
-- Members standing at the parade would be marked unverified; a member who
-- happened to be at the station would be marked VERIFIED for a drill they were
-- not at. The second one is the real hazard.
--
-- GRANTS ARE NOT RESTATED anywhere below. CREATE OR REPLACE preserves the ACL;
-- re-granting from a guess could change privileges I have not read.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. member_check_in — branch on is_offsite, and fail closed.
--
-- ONLY the marked block changes. Three outcomes now:
--
--   not off-site                  -> verify against the station. Byte-identical
--                                    to today, and what all 10 sessions do.
--   off-site + coordinates set    -> verify against the point. v_pinned := true,
--                                    because the session's location IS the pin.
--   off-site + NO coordinates yet -> FAIL CLOSED. v_verified := false with
--                                    v_pinned := true, so the existing gate
--                                    `IF v_verified OR NOT v_pinned` is false
--                                    and NO presence row is written.
--
-- The fail-closed case deliberately does NOT raise. Attendance is still
-- recorded — the member turned up, and refusing to mark them present punishes
-- them for an officer's missing step. They simply earn no clock, which is the
-- same rule an unverified scan has always followed.
--
-- It reuses the existing gate rather than adding a new one, so there is exactly
-- one place in this function that decides whether a presence row is written.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_check_in(
  p_session_id uuid, p_token text,
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_accuracy double precision DEFAULT NULL::double precision
) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_session  public.training_sessions%ROWTYPE;
  v_member   uuid := public.my_member_id();
  v_dept     uuid := public.my_department_id();
  v_recorded boolean := false;
  v_verified boolean := false;
  v_pinned   boolean := true;   -- fail closed if the department row does not resolve
BEGIN
  IF v_member IS NULL OR v_dept IS NULL THEN
    RAISE EXCEPTION 'We could not match your login to a member record.';
  END IF;

  SELECT * INTO v_session FROM public.training_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That training session was not found.';
  END IF;

  IF v_session.department_id IS DISTINCT FROM v_dept THEN
    RAISE EXCEPTION 'That session is not in your department.';
  END IF;

  IF v_session.done THEN
    RAISE EXCEPTION 'This session is complete — attendance is locked.';
  END IF;

  IF v_session.signin_token IS NULL OR v_session.signin_token <> p_token THEN
    RAISE EXCEPTION 'Invalid or expired sign-in code — scan the current QR.';
  END IF;

  INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at)
  VALUES (v_dept, p_session_id, v_member, now())
  ON CONFLICT (session_id, member_id) DO NOTHING;
  v_recorded := FOUND;

  -- ---- CHANGED IN C3: branch on the FLAG, not on whether coordinates exist ----
  IF v_session.is_offsite THEN
    IF v_session.location_lat IS NOT NULL AND v_session.location_lng IS NOT NULL THEN
      v_verified := public.is_at_point(
        v_session.location_lat, v_session.location_lng,
        coalesce(v_session.location_radius_m,
                 (SELECT station_radius_m FROM public.departments WHERE id = v_dept),
                 400),
        p_lat, p_lng, p_accuracy);
    ELSE
      -- Off-site, but nobody has captured where. NEVER fall back to the station:
      -- they are not there. No clock; attendance above still stands.
      v_verified := false;
    END IF;
    v_pinned := true;   -- an off-site session is always "pinned" for gate purposes
  ELSE
    v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);
    SELECT (station_lat IS NOT NULL AND station_lng IS NOT NULL)
      INTO v_pinned
      FROM public.departments
     WHERE id = v_dept;
  END IF;
  -- ---- END CHANGED BLOCK ----

  IF v_verified OR NOT v_pinned THEN
    INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, session_id)
    VALUES (v_dept, v_member, v_verified, 'geo', 'training', p_session_id)
    ON CONFLICT (member_id, session_id) WHERE kind = 'training' AND session_id IS NOT NULL DO NOTHING;
  END IF;

  IF v_recorded THEN RETURN 'recorded'; ELSE RETURN 'already'; END IF;
END;
$function$;


-- ---------------------------------------------------------------------
-- 2. open_signin — refuse to open an off-site drill with no location.
--
-- ONE new guard, inserted after the `done` check. Everything else verbatim.
--
-- This is the guard that matters. The fail-closed branch above is a backstop
-- that should never fire, because the QR cannot go live until the location
-- exists. Doing it server-side rather than only in the client means a crafted
-- call cannot skip the capture step.
--
-- The message names the fix, because the person reading it is standing at the
-- parade with a phone.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_signin(p_session_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session public.training_sessions%rowtype;
  v_token   text;
begin
  if not exists (
    select 1 from public.members
    where lower(email) = lower(auth.email())
      and access && array['Department Admin','Officer','Project Admin']::text[]
  ) then
    raise exception 'You are not allowed to open a sign-in for this session.';
  end if;

  select * into v_session from public.training_sessions where id = p_session_id;
  if not found or v_session.department_id is distinct from public.my_department_id() then
    raise exception 'That training session was not found in your department.';
  end if;
  if v_session.done then
    raise exception 'This session is complete — you cannot open a sign-in.';
  end if;

  -- ---- NEW IN C3 ----
  if v_session.is_offsite
     and (v_session.location_lat is null or v_session.location_lng is null) then
    raise exception 'Set this drill''s location first — you have to be on site, then tap "Use my location".';
  end if;
  -- ---- END NEW ----

  v_token := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  update public.training_sessions
    set signin_token = v_token, signin_open = true
  where id = p_session_id;
  return v_token;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. set_session_location — a location only means something off-site.
--
-- ONE new guard, and its PLACEMENT is the point: it sits AFTER the clear path
-- returns. Clearing must always be allowed regardless of the flag, because
-- clearing is the safe direction and C4 needs it when the toggle goes off.
-- Only SETTING requires the flag.
--
-- Without this, setting coordinates on a non-off-site session would be caught
-- by C1's training_sessions_coords_require_offsite CHECK — correct, but as a
-- raw constraint violation. This turns it into a sentence.
--
-- NOTE FOR C4: turning the toggle OFF while coordinates are set must clear both
-- together, or the C1 CHECK rejects the write. Either call this function to
-- clear first, then flip the flag, or do both columns in one UPDATE. One
-- statement is simpler and atomic.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_session_location(
  p_session_id uuid,
  p_lat        double precision DEFAULT NULL::double precision,
  p_lng        double precision DEFAULT NULL::double precision,
  p_radius_m   integer          DEFAULT NULL::integer,
  p_label      text             DEFAULT NULL::text
) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept    uuid := public.my_department_id();
  v_session public.training_sessions%rowtype;
  v_radius  integer;
begin
  if not exists (
    select 1 from public.members
    where lower(email) = lower(auth.email())
      and access && array['Department Admin','Officer','Project Admin']::text[]
  ) then
    raise exception 'You are not allowed to set the location for this session.';
  end if;

  select * into v_session from public.training_sessions where id = p_session_id;
  if not found or v_session.department_id is distinct from v_dept then
    raise exception 'That training session was not found in your department.';
  end if;
  if v_session.done then
    raise exception 'This session is complete — its location can no longer be changed.';
  end if;

  -- clear: back to verifying against the station. Allowed whatever the flag says.
  if p_lat is null and p_lng is null then
    update public.training_sessions
       set location_lat = null, location_lng = null,
           location_radius_m = null, location_label = null
     where id = p_session_id;
    return;
  end if;

  if p_lat is null or p_lng is null then
    raise exception 'We could not read your location — try again, or leave the drill at the station.';
  end if;

  -- ---- NEW IN C3: only an off-site drill may carry a location ----
  if not v_session.is_offsite then
    raise exception 'Mark this drill as off-site before setting its location.';
  end if;
  -- ---- END NEW ----

  -- store the radius explicitly so the record is self-describing later
  v_radius := coalesce(p_radius_m,
                       (select station_radius_m from public.departments where id = v_dept),
                       400);

  update public.training_sessions
     set location_lat      = p_lat,
         location_lng      = p_lng,
         location_radius_m = v_radius,
         location_label    = nullif(btrim(coalesce(p_label, '')), '')
   where id = p_session_id;
end;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — from the catalog
-- =====================================================================
--
-- -- 1. All three now know the flag, and member_check_in no longer branches on
-- --    coordinates alone. Expect knows_flag=t on all three.
-- SELECT proname, prosrc ILIKE '%is_offsite%' AS knows_flag
--   FROM pg_proc WHERE pronamespace='public'::regnamespace
--    AND proname IN ('member_check_in','open_signin','set_session_location')
--  ORDER BY proname;
--
-- -- 2. The fail-closed path is actually there (not just the flag mentioned):
-- SELECT prosrc ILIKE '%NEVER fall back to the station%' AS has_fail_closed
--   FROM pg_proc WHERE proname='member_check_in' AND pronamespace='public'::regnamespace;
--
-- -- 3. Signatures / volatility / security / grants unchanged. Expect
-- --    member_check_in      : 5 args, text,  definer=t, anon=f auth=t
-- --    open_signin          : 1 arg,  text,  definer=t, anon=f auth=t
-- --    set_session_location : 5 args, void,  definer=t, anon=f auth=t
-- SELECT format('%s', proname) AS check,
--        format('args=%s returns=%s definer=%s cfg=%s anon=%s auth=%s',
--               pronargs, pg_get_function_result(oid), prosecdef,
--               coalesce(array_to_string(proconfig,','),'-'),
--               has_function_privilege('anon', oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE')) AS value
--   FROM pg_proc WHERE pronamespace='public'::regnamespace
--    AND proname IN ('member_check_in','open_signin','set_session_location')
--  ORDER BY proname;
--
-- -- 4. INERT PROOF — which branch each session takes today. Every row should
-- --    say 'station (unchanged)'. If any says 'off-site', C4 has already run.
-- SELECT title, date,
--        case when not is_offsite then 'station (unchanged)'
--             when location_lat is not null then 'off-site: verify at point'
--             else 'off-site: FAIL CLOSED (no location yet)' end AS branch
--   FROM public.training_sessions ORDER BY date DESC;
--
-- -- 5. Rejection paths must RAISE. Both run as postgres, so both should first
-- --    hit the role gate — which is itself a pass. To exercise the new guards
-- --    properly, use the app as a signed-in officer once C4 lands.
-- --   BEGIN;
-- --     SELECT public.set_session_location('<a NON-offsite session id>', 34.0, -84.0);
-- --   ROLLBACK;   -- expect: not allowed / mark as off-site first
