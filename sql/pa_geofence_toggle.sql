-- =====================================================================
-- PER-STATION ADD-ONS: let a Project Admin turn geofencing on for the
-- stations that pay for it. Two narrow PA-gated functions. No schema change.
--
-- departments.geofence_enabled already exists (boolean DEFAULT false) and
-- already gates geofencing at runtime. Until now the only way to set it was a
-- manual database edit. This is the missing control, and nothing else: no new
-- column, no change to how the flag is read or what it does.
--
-- WHY RPCs AND NOT A DIRECT UPDATE. RLS scopes `departments` to the actor's OWN
-- department, and a Project Admin is configuring SOMEBODY ELSE'S. The existing
-- pa_get_disabled_modules / pa_set_disabled_modules pair solves exactly this
-- problem for module visibility; this mirrors it rather than inventing a second
-- shape for the same situation.
--
-- THE PA GATE IS IN THE FUNCTION, not just the screen. DepartmentAdmin already
-- refuses to render for a non-PA, but a client gate is a courtesy to the UI, not
-- a security control — anyone with a session can call an RPC directly. Both
-- functions therefore check is_project_admin() themselves and raise otherwise,
-- copied from pa_set_member_email. SECURITY DEFINER without that check would
-- hand every authenticated user the ability to switch background location
-- tracking on for any department in the system.
--
-- WHAT THIS FLAG ACTUALLY DOES, which is why the gate matters more here than it
-- does for disabled_modules: module visibility only hides navigation. This one
-- turns on BACKGROUND LOCATION for a department's members. It is still
-- double-gated — the build flag VITE_GEOFENCE_ENABLED must also be on, and each
-- member still sees the disclosure and grants the OS permission themselves — but
-- this is the switch that makes any of that reachable.
--
-- DEPLOY ORDER: apply BEFORE the rebuilt bundle deploys. The new UI calls both
-- functions by name, and PostgREST answers 404 for a function it has not seen.
-- Safe to apply against the CURRENT build, which never calls them.
-- =====================================================================

-- ------------------------------------------------------------
-- pa_get_geofence_enabled() — read one department's flag.
-- STABLE: reads, never writes.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_get_geofence_enabled(p_department_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_on boolean;
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  select geofence_enabled into v_on from departments where id = p_department_id;
  if not found then
    raise exception 'Department not found';
  end if;

  -- coalesce so a NULL row value reads as OFF rather than returning NULL to the
  -- client, where it would be indistinguishable from "still loading".
  return coalesce(v_on, false);
end;
$function$;

-- ------------------------------------------------------------
-- pa_set_geofence_enabled() — set one department's flag.
--
-- Deliberately does NOT check whether the station has a pin (station_lat /
-- station_lng). Turning the add-on on for a station that has not been pinned yet
-- is a normal order of operations — you sell the add-on, switch it on, and the
-- department pins the station during setup. Refusing here would block that, and
-- the feature is already inert without a pin.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_set_geofence_enabled(p_department_id uuid, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  update departments
     set geofence_enabled = coalesce(p_enabled, false)
   where id = p_department_id;

  if not found then
    raise exception 'Department not found';
  end if;
end;
$function$;

-- Same pattern as sql/revoke_anon_execute_sweep.sql: Postgres default-grants
-- EXECUTE to PUBLIC on a new function, and anon inherits through PUBLIC. Revoke
-- both, then grant authenticated back — the PA check inside does the real work.
REVOKE EXECUTE ON FUNCTION public.pa_get_geofence_enabled(uuid)          FROM anon, public;  GRANT EXECUTE ON FUNCTION public.pa_get_geofence_enabled(uuid)          TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_set_geofence_enabled(uuid, boolean) FROM anon, public;  GRANT EXECUTE ON FUNCTION public.pa_set_geofence_enabled(uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only.
-- =====================================================================
--
-- -- 1. THE ONE FROM THE BRIEF: current state of every department's flag.
-- --    Expect every station false unless one was switched on by hand already.
-- SELECT name, geofence_enabled FROM departments ORDER BY name;
--
-- -- 2. Both functions exist, are SECURITY DEFINER, and anon cannot execute.
-- --    Expect two rows, definer=t, anon=f, auth=t.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        format('definer=%s anon=%s auth=%s', prosecdef,
--               has_function_privilege('anon', oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE')) AS rights
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace
--    AND proname IN ('pa_get_geofence_enabled', 'pa_set_geofence_enabled')
--  ORDER BY proname;
--
-- -- 3. THE GATE IS REALLY THERE. Both bodies must contain the is_project_admin()
-- --    check — a SECURITY DEFINER setter without it is a hole, not a feature.
-- --    Expect gated=t on both rows.
-- SELECT proname, (prosrc ILIKE '%is_project_admin()%') AS gated
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace
--    AND proname IN ('pa_get_geofence_enabled', 'pa_set_geofence_enabled')
--  ORDER BY proname;
--
-- -- 4. THE PROBE. Run as postgres in this editor, where is_project_admin() is
-- --    false, so this should RAISE 'Not authorized'. That error is the PASS —
-- --    it proves the gate fires. Nothing is written; ROLLBACK discards it.
-- --
-- --   BEGIN;
-- --     SELECT public.pa_set_geofence_enabled(
-- --       (SELECT id FROM public.departments ORDER BY name LIMIT 1), true);
-- --   ROLLBACK;
--
-- -- 5. Which stations could actually USE it — geofencing needs a pinned
-- --    station, and switching the add-on on for an unpinned one does nothing
-- --    until setup pins it. Advisory, not a failure.
-- SELECT name, geofence_enabled,
--        (station_lat IS NOT NULL AND station_lng IS NOT NULL) AS station_pinned
--   FROM departments ORDER BY name;
