-- =====================================================================
-- PA GEOFENCE HONESTY — the PA department screen gets to SEE and SET the
-- switch phones actually obey. DRAFT: not reviewed, not applied.
--
-- THE BUG (field-confirmed, North Hood, 2026-11-02). The PA card titled
-- "Per-station add-ons" showed ONE checkbox, wired to pa_get/set_geofence_enabled,
-- i.e. departments.geofence_enabled: the department MASTER switch. The flag a
-- phone obeys when it builds its fences is stations.geofence_enabled
-- (src/geofence.js skips a house whose own switch is off, and with no usable
-- house left it removes its fences). pa_department_stations() did not even
-- return that column, and no PA function could set it. North Hood's master was
-- ON for months while Station 20's own switch sat OFF, so the PA saw "ON" while
-- no current-build phone held a fence.
--
-- THIS FILE, one transaction:
--   1. pa_department_stations(uuid) also returns lat, lng, radius_m,
--      geofence_enabled (types = the stations columns: double precision,
--      double precision, integer, boolean). A RETURNS TABLE change cannot be
--      done with CREATE OR REPLACE, so it is DROP + CREATE, and the EXECUTE
--      grants are re-applied after (a DROP + CREATE re-opens PUBLIC/anon; the
--      revoke does NOT survive it).
--   2. NEW pa_set_station_geofence(p_station_id uuid, p_enabled boolean)
--      RETURNS uuid. Same shape as pa_update_station: plpgsql, SECURITY DEFINER,
--      search_path=public, is_project_admin() gate FIRST ('Not authorized'),
--      'Station not found' on a bad id. Refuses to ENABLE a house with no pin
--      (lat or lng null), with the DA station editor's exact sentence — the
--      DA editor's client rule, now enforced on the server. Switching OFF is
--      always allowed (it can only make a phone do less). It sets
--      stations.geofence_enabled ONLY: lat, lng, radius_m, is_default,
--      department_id, name, label, address, is_active are never written.
--      Returns the station id, so the client has a positive confirmation; a
--      null back is treated as "not saved".
--
-- is_project_admin() IS THE WHOLE SECURITY BOUNDARY on both functions, the same
-- as every pa_* function: both are SECURITY DEFINER and reach across
-- departments by design. Without the gate any signed-in user could read every
-- department's station pins, or switch background-location arrival on for any
-- house in the system.
--
-- NOT CHANGED: departments.geofence_enabled and pa_get/set_geofence_enabled
-- (the master switch keeps its plumbing), geofence_arrive (it still reads the
-- department master + s.is_active, not the station switch — a separate,
-- known asymmetry, out of scope), my_stations(), pa_update_station(),
-- pa_add_station(), every policy on stations. No data is written by applying
-- this file: it creates functions only.
--
-- DEPLOY ORDER: apply BEFORE the bundle promotes. The new card calls
-- pa_set_station_geofence by name (PostgREST 404s an unseen function). The
-- CURRENT bundle reads only the six columns it knows from
-- pa_department_stations, so the extra four are harmless to it.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume. The live DB is the truth, not
--    the repo snapshot: if pa_department_stations is not the shape this file
--    was written against, stop rather than drop something different.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_res text;
  v_cols int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace AND proname = 'is_project_admin') THEN
    RAISE EXCEPTION 'Precondition failed: is_project_admin() is missing. It is the security boundary for both functions.';
  END IF;

  SELECT pg_get_function_result(p.oid) INTO v_res
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'pa_department_stations'
     AND pg_get_function_identity_arguments(p.oid) = 'p_department_id uuid';
  IF v_res IS DISTINCT FROM 'TABLE(station_id uuid, name text, label text, address text, is_default boolean, is_active boolean)' THEN
    RAISE EXCEPTION 'Precondition failed: pa_department_stations(uuid) is not the expected six-column shape (found: %). Stop and re-read the live definition.', coalesce(v_res, 'missing');
  END IF;

  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'pa_department_stations') <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: more than one pa_department_stations overload exists.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'pa_set_station_geofence') THEN
    RAISE EXCEPTION 'Precondition failed: pa_set_station_geofence already exists. This file creates it; re-read before re-applying.';
  END IF;

  -- The four columns, with the exact types the new RETURNS TABLE declares.
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'stations'
     AND ((column_name = 'lat'              AND data_type = 'double precision')
       OR (column_name = 'lng'              AND data_type = 'double precision')
       OR (column_name = 'radius_m'         AND data_type = 'integer')
       OR (column_name = 'geofence_enabled' AND data_type = 'boolean'));
  IF v_cols <> 4 THEN
    RAISE EXCEPTION 'Precondition failed: stations.lat/lng/radius_m/geofence_enabled are not double precision/double precision/integer/boolean (% of 4 matched).', v_cols;
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. pa_department_stations() — the same list, plus the fence columns.
--    Body identical to the live one apart from the four added columns:
--    same gate, same department filter, same order (default house first,
--    then by name), STABLE.
-- ---------------------------------------------------------------------
DROP FUNCTION public.pa_department_stations(uuid);

CREATE FUNCTION public.pa_department_stations(p_department_id uuid)
 RETURNS TABLE(station_id uuid, name text, label text, address text, is_default boolean, is_active boolean,
               lat double precision, lng double precision, radius_m integer, geofence_enabled boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  return query
    select s.id, s.name, s.label, s.address, s.is_default, s.is_active,
           s.lat, s.lng, s.radius_m, s.geofence_enabled
    from stations s
    where s.department_id = p_department_id
    order by s.is_default desc, s.name;
end;
$function$;


-- ---------------------------------------------------------------------
-- 2. pa_set_station_geofence() — one house's own automatic-arrival switch.
--
--    FOR UPDATE locks the row between the pin check and the write, so a
--    concurrent DA edit that clears the pin cannot slip between them and leave
--    a fence switched on with no location.
--
--    p_enabled NULL reads as OFF (coalesce), the same as
--    pa_set_geofence_enabled: a missing value never switches location on.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.pa_set_station_geofence(p_station_id uuid, p_enabled boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_on  boolean := coalesce(p_enabled, false);
  v_lat double precision;
  v_lng double precision;
  v_id  uuid;
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  select s.lat, s.lng into v_lat, v_lng
    from stations s
   where s.id = p_station_id
   for update;
  -- Named explicitly so a bad id reads as 'Station not found' rather than
  -- succeeding with zero rows updated, which the client would show as saved.
  if not found then
    raise exception 'Station not found';
  end if;

  -- The DA editor's rule, enforced here too: a fence with no pin cannot be
  -- registered, so switching one on would be a setting that silently does
  -- nothing. Switching OFF is never refused.
  if v_on and (v_lat is null or v_lng is null) then
    raise exception 'Give this house a location before switching its fence on.';
  end if;

  -- geofence_enabled ONLY. lat/lng/radius_m/is_default/department_id are
  -- intentionally absent from the SET list.
  update stations s
     set geofence_enabled = v_on
   where s.id = p_station_id
  returning s.id into v_id;

  return v_id;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. GRANTS. Postgres default-grants EXECUTE to PUBLIC on a new function and
--    anon inherits through it; the DROP above threw away the old revoke.
--    Revoke both, grant authenticated back (sql/revoke_anon_execute_sweep.sql).
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.pa_department_stations(uuid)           FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_department_stations(uuid)           TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_set_station_geofence(uuid, boolean) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_set_station_geofence(uuid, boolean) TO authenticated;


-- ---------------------------------------------------------------------
-- 4. POST-CONDITIONS — inside the transaction, so a wrong result rolls the
--    whole file back.
-- ---------------------------------------------------------------------
DO $post$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid, p.proname, p.prosecdef, p.prosrc, p.proconfig
             FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('pa_department_stations', 'pa_set_station_geofence') LOOP
    IF NOT r.prosecdef THEN RAISE EXCEPTION 'Post-condition: % is not SECURITY DEFINER', r.proname; END IF;
    IF position('is_project_admin()' in r.prosrc) = 0 THEN RAISE EXCEPTION 'Post-condition: % has no is_project_admin() gate', r.proname; END IF;
    IF NOT ('search_path=public' = ANY (coalesce(r.proconfig, '{}'))) THEN RAISE EXCEPTION 'Post-condition: % search_path not pinned', r.proname; END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post-condition: anon can execute %', r.proname; END IF;
    IF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post-condition: authenticated cannot execute %', r.proname; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('pa_department_stations', 'pa_set_station_geofence')) <> 2 THEN
    RAISE EXCEPTION 'Post-condition: expected exactly one of each function';
  END IF;
  IF pg_get_function_result('public.pa_department_stations(uuid)'::regprocedure)
     <> 'TABLE(station_id uuid, name text, label text, address text, is_default boolean, is_active boolean, lat double precision, lng double precision, radius_m integer, geofence_enabled boolean)' THEN
    RAISE EXCEPTION 'Post-condition: pa_department_stations result shape is wrong';
  END IF;
  -- The setter's UPDATE writes geofence_enabled and nothing else.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.pa_set_station_geofence(uuid, boolean)'::regprocedure)
       ~* 'set[^;]*\m(lat|lng|radius_m|is_default|department_id|name|label|address|is_active)\M\s*=' THEN
    RAISE EXCEPTION 'Post-condition: pa_set_station_geofence writes a column other than geofence_enabled';
  END IF;
END
$post$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- State check (read-only): both functions, rights, shape.
SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
       prosecdef AS definer, provolatile AS vol,
       has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
       pg_get_function_result(oid) AS returns
  FROM pg_proc
 WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('pa_department_stations', 'pa_set_station_geofence')
 ORDER BY proname;
