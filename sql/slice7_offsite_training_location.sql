-- =====================================================================
-- SLICE 7 (A) — off-site training location.
--
-- A drill away from the station verifies against THAT spot, not the station.
-- Nothing downstream changes: an off-site verified scan is still just a
-- verified kind='training' row in station_presence. It simply verified against
-- a different point. finalize, the auto-close sweeper, the review queue and
-- dept_iso_hours are all untouched.
--
-- FOUR PARTS, in dependency order:
--   1. is_at_point()          — pure maths, extracted from is_at_station
--   2. is_at_station()        — refactored to delegate. BEHAVIOUR-PRESERVING.
--   3. training_sessions      — four nullable location columns
--   4. member_check_in()      — branch: session location if set, else station
--   5. set_session_location() — the write path, DA/TO/PA gated
--
-- VERIFIED LIVE BEFORE WRITING (2026-08-04):
--   • training_sessions has NO location column of any kind today.
--   • is_at_station(p_dept, p_lat, p_lng, p_accuracy) — single signature.
--   • is_at_point does not exist yet.
--   • departments: station_lat/station_lng double precision, station_radius_m integer.
--   • open_signin(p_session_id uuid) gates inline on
--     access && array['Department Admin','Officer','Project Admin'] — mirrored below.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. is_at_point — the distance rule, and nothing else.
--
-- Lifted verbatim from is_at_station's body with the station's coordinates
-- turned into parameters. IMMUTABLE: it reads no table and calls nothing
-- non-deterministic, so the planner may fold it freely.
--
-- Semantics reproduced EXACTLY, including the quirks:
--   • returns FALSE (never null) when any of the four coordinates is null —
--     the old body left v_verified at its `false` initial value.
--   • coalesce(radius, 150) — the same default is_at_station applied when a
--     department had no station_radius_m.
--   • accuracy is a SEPARATE test against the same radius: a fix too coarse to
--     distinguish inside-from-outside is not proof of presence.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_at_point(
  p_lat        double precision,   -- the reference point
  p_lng        double precision,
  p_radius_m   integer,
  p_member_lat double precision,   -- where the member says they are
  p_member_lng double precision,
  p_accuracy   double precision
) RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_dist double precision;
  v_verified boolean := false;
begin
  if p_lat is not null and p_lng is not null and p_member_lat is not null and p_member_lng is not null then
    v_dist := 6371000 * 2 * asin(sqrt(
      power(sin(radians(p_member_lat - p_lat) / 2), 2)
      + cos(radians(p_lat)) * cos(radians(p_member_lat)) * power(sin(radians(p_member_lng - p_lng) / 2), 2)));
    v_verified := (v_dist <= coalesce(p_radius_m, 150))
                  and (p_accuracy is null or p_accuracy <= coalesce(p_radius_m, 150));
  end if;
  return v_verified;
end;
$function$;

REVOKE ALL ON FUNCTION public.is_at_point(double precision, double precision, integer, double precision, double precision, double precision)
  FROM public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. is_at_station — now a three-line wrapper.
--
-- Same signature, same volatility, same SECURITY DEFINER, same search_path.
-- station_check_in and member_check_in keep calling it unchanged. The only
-- change is that the arithmetic now lives in one place instead of being a
-- copy that has already been duplicated once (slice 1 lifted it verbatim).
--
-- The verify block at the bottom asserts the refactor is a no-op across a grid
-- of real and edge-case inputs — run it BEFORE trusting this.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_at_station(
  p_dept uuid, p_lat double precision, p_lng double precision, p_accuracy double precision
) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_lat double precision; v_lng double precision; v_radius integer;
begin
  select station_lat, station_lng, station_radius_m into v_lat, v_lng, v_radius
    from public.departments where id = p_dept;
  return public.is_at_point(v_lat, v_lng, v_radius, p_lat, p_lng, p_accuracy);
end;
$function$;

REVOKE ALL ON FUNCTION public.is_at_station(uuid, double precision, double precision, double precision)
  FROM public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. training_sessions location columns.
--
-- All nullable, additive, no backfill. NULL lat/lng means "at the station",
-- which is every existing row and stays the default forever — an at-station
-- drill is not required to carry a location.
--
-- location_radius_m is stored rather than always inherited so the record is
-- self-describing: a drill verified at 400m two years ago still says 400m even
-- if the department later retunes its station radius.
-- ---------------------------------------------------------------------
ALTER TABLE public.training_sessions
  ADD COLUMN IF NOT EXISTS location_lat      double precision,
  ADD COLUMN IF NOT EXISTS location_lng      double precision,
  ADD COLUMN IF NOT EXISTS location_radius_m integer,
  ADD COLUMN IF NOT EXISTS location_label    text;

-- Both coordinates or neither — a half-set location would silently verify
-- against nothing (is_at_point returns false on a null coord, so every scan
-- would land unverified with no obvious cause).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'training_sessions_location_pair'
       AND conrelid = 'public.training_sessions'::regclass
  ) THEN
    ALTER TABLE public.training_sessions
      ADD CONSTRAINT training_sessions_location_pair
      CHECK ((location_lat IS NULL) = (location_lng IS NULL));
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 4. member_check_in — branch on the session's location.
--
-- CREATE OR REPLACE, identical 5-arg signature, body-only change. Everything
-- outside the marked block is byte-identical to slice 2b.
--
-- THE BRANCH:
--   session HAS a location  -> verify against it; v_pinned := true, because the
--     session's own location IS the pin. The allow-but-flag fallback exists for
--     departments that never set a station; it must NOT apply here, or an
--     off-site drill would mint unverified clock rows for anyone who scanned
--     from anywhere.
--   session has NO location -> exactly today's behaviour, unchanged.
--
-- The radius falls back station_radius_m -> 400m. 400 rather than 150 because
-- an off-site drill is a parade route or a burn field, not a building.
--
-- Everything else is untouched: the IF v_verified OR NOT v_pinned gate, the
-- attendance insert, unverified-means-no-clock. An off-site drill follows the
-- same strict rule — an unverified scan signs you in and earns no clock.
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

  -- ---- CHANGED IN SLICE 7: verify against the session's location when it has one ----
  IF v_session.location_lat IS NOT NULL AND v_session.location_lng IS NOT NULL THEN
    v_verified := public.is_at_point(
      v_session.location_lat, v_session.location_lng,
      coalesce(v_session.location_radius_m,
               (SELECT station_radius_m FROM public.departments WHERE id = v_dept),
               400),
      p_lat, p_lng, p_accuracy);
    v_pinned := true;   -- the session's location is the pin
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

REVOKE ALL ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision)
  TO authenticated;


-- ---------------------------------------------------------------------
-- 5. set_session_location — the write path.
--
-- A COMPANION RPC RATHER THAN EXTENDING open_signin, for two reasons:
--
--   (a) open_signin ROTATES THE TOKEN on every call — the client aliases
--       `rotateSI = openSI`. If the location were a parameter of open_signin,
--       every "Rotate code" tap would have to re-send it or silently wipe the
--       off-site location mid-drill. Separating them makes that impossible.
--   (b) adding defaulted args to open_signin(uuid) would create a SECOND
--       overload; a 1-arg call would then match both and PostgREST could not
--       disambiguate (PGRST203) — the same trap slice 1 hit. Avoiding it would
--       mean DROP + CREATE on a working, security-gated function for no gain.
--
-- Passing NULL lat AND lng CLEARS the location, putting the session back to
-- verifying against the station. That is the only way back, and it is
-- deliberate — "off-site" must be reversible before anyone scans.
--
-- The role gate is copied from open_signin verbatim so the two cannot drift.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_session_location(
  p_session_id uuid,
  p_lat        double precision DEFAULT NULL,
  p_lng        double precision DEFAULT NULL,
  p_radius_m   integer          DEFAULT NULL,
  p_label      text             DEFAULT NULL
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

  -- clear: back to verifying against the station
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

REVOKE ALL ON FUNCTION public.set_session_location(uuid, double precision, double precision, integer, text)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_session_location(uuid, double precision, double precision, integer, text)
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
-- -- 1. THE REFACTOR IDENTITY. is_at_point must reproduce the OLD is_at_station
-- --    body exactly. This recomputes the pre-refactor arithmetic inline and
-- --    compares, across a grid including every null/edge case. Expect every
-- --    row `t`, and `all_match` = true.
-- WITH d AS (SELECT station_lat lat, station_lng lng, station_radius_m r FROM public.departments LIMIT 1),
-- g(mlat, mlng, acc) AS (VALUES
--   (NULL::float8, NULL::float8, NULL::float8),           -- no fix
--   (NULL,          -84.0,        10.0),                   -- half a fix
--   (34.0,          NULL,         10.0),
--   (34.0,          -84.0,        NULL),                   -- no accuracy reported
--   (34.0,          -84.0,        10.0),
--   (34.0,          -84.0,        99999.0),                -- accuracy far worse than radius
--   (0.0,           0.0,          5.0)                     -- null island: definitely outside
-- )
-- SELECT g.mlat, g.mlng, g.acc,
--        public.is_at_point(d.lat, d.lng, d.r, g.mlat, g.mlng, g.acc) AS new_result,
--        COALESCE(
--          CASE WHEN d.lat IS NOT NULL AND d.lng IS NOT NULL AND g.mlat IS NOT NULL AND g.mlng IS NOT NULL
--          THEN ((6371000 * 2 * asin(sqrt(power(sin(radians(g.mlat - d.lat)/2),2)
--                 + cos(radians(d.lat))*cos(radians(g.mlat))*power(sin(radians(g.mlng - d.lng)/2),2))))
--                <= coalesce(d.r,150))
--               AND (g.acc IS NULL OR g.acc <= coalesce(d.r,150))
--          END, false) AS old_result,
--        public.is_at_point(d.lat, d.lng, d.r, g.mlat, g.mlng, g.acc) IS NOT DISTINCT FROM
--        COALESCE(
--          CASE WHEN d.lat IS NOT NULL AND d.lng IS NOT NULL AND g.mlat IS NOT NULL AND g.mlng IS NOT NULL
--          THEN ((6371000 * 2 * asin(sqrt(power(sin(radians(g.mlat - d.lat)/2),2)
--                 + cos(radians(d.lat))*cos(radians(g.mlat))*power(sin(radians(g.mlng - d.lng)/2),2))))
--                <= coalesce(d.r,150))
--               AND (g.acc IS NULL OR g.acc <= coalesce(d.r,150))
--          END, false) AS matches
--   FROM g CROSS JOIN d;
--
-- -- 2. is_at_station still agrees with is_at_point on the station's own point:
-- SELECT public.is_at_station(d.id, d.station_lat, d.station_lng, 5) AS at_the_station_true,
--        public.is_at_station(d.id, 0, 0, 5)                          AS null_island_false
--   FROM public.departments d LIMIT 1;
--
-- -- 3. Signatures/volatility/grants — is_at_point IMMUTABLE and internal:
-- SELECT proname, provolatile, prosecdef,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_can
--   FROM pg_proc WHERE pronamespace='public'::regnamespace
--    AND proname IN ('is_at_point','is_at_station','member_check_in','set_session_location')
--  ORDER BY proname;
--
-- -- 4. Columns + the pair constraint:
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='training_sessions' AND column_name LIKE 'location%';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.training_sessions'::regclass AND conname='training_sessions_location_pair';
--
-- -- 5. No session has a location yet (every drill still verifies at the station):
-- SELECT count(*) FILTER (WHERE location_lat IS NOT NULL) AS with_location, count(*) AS total
--   FROM public.training_sessions;
