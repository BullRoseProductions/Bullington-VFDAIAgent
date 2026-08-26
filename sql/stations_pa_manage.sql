-- =====================================================================
-- STATIONS — PA-side read + edit: pa_department_stations, pa_update_station.
--
-- WHY THESE EXIST. The PA department screen has been add-only since B2, and the
-- comment there explains it honestly: my_stations() answers for the CALLER's
-- department, so a Project Admin looking at someone else's department would be
-- shown their OWN houses under that department's heading -- worse than showing
-- nothing. The fix is not to loosen my_stations(); it is a PA-scoped read that
-- takes the department explicitly, exactly as pa_add_station() does for writes.
--
-- is_project_admin() IS THE WHOLE SECURITY BOUNDARY on both functions, the same
-- as every other pa_* function. Both are SECURITY DEFINER and both reach across
-- departments by design -- that is the point, since the caller is deliberately
-- not a member of the target department. Without the gate, any authenticated
-- user could read or rename stations in any department in the system. It is not
-- validation; it is the authorization.
--
-- Shape mirrored from sql/stations_phaseB2_pa_add.sql (pa_add_station): plpgsql,
-- SECURITY DEFINER, search_path=public, gate FIRST, then the narrow read/write,
-- then REVOKE anon/public + GRANT authenticated.
--
-- NEITHER FUNCTION TOUCHES is_default OR department_id. A station cannot be
-- moved between departments here, and "the" default house is never re-pointed
-- by an edit -- same rule pa_add_station follows by always inserting
-- is_default=false. Every row keeps the station it was stamped with, so nothing
-- in the B3 attribution chain moves.
--
-- READ-ONLY ON THE DA PATH: the department's own Settings form keeps using the
-- stations table directly under its existing RLS. No policy is added or changed
-- by this file, and my_stations() is untouched -- the picker still uses it.
--
-- DEPLOY GATE: apply BEFORE the client deploys. The PA screen calls both by
-- name and PostgREST answers 404 for a function it has not seen.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace
                    AND proname='is_project_admin') THEN
    RAISE EXCEPTION 'Precondition failed: is_project_admin() is missing. It is the security boundary for both functions in this file.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='stations'
                    AND column_name='address') THEN
    RAISE EXCEPTION 'Precondition failed: stations.address is missing. Apply sql/stations_phaseA.sql first.';
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. pa_department_stations() — the list, for a department the caller is not in.
--
-- STABLE, not VOLATILE: it only reads. (pa_add_station is VOLATILE because it
-- writes.) Ordering matches the DA-side list so the same department reads the
-- same way from both screens: the default house first, then by name.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_department_stations(p_department_id uuid)
 RETURNS TABLE(station_id uuid, name text, label text, address text, is_default boolean, is_active boolean)
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
    select s.id, s.name, s.label, s.address, s.is_default, s.is_active
    from stations s
    where s.department_id = p_department_id
    order by s.is_default desc, s.name;
end;
$function$;


-- ---------------------------------------------------------------------
-- 2. pa_update_station() — rename / re-label / re-address one station.
--
-- WHAT IT DELIBERATELY CANNOT DO: is_default and department_id are absent from
-- the SET list, so an edit can neither re-point the department's default house
-- nor move a station to another department. Both would silently invalidate
-- station attribution on rows already stamped by the B3 trigger.
--
-- A BLANK NAME RAISES HERE, where pa_add_station falls back to 'Station'. The
-- asymmetry is intentional: on ADD, a blank name loses the whole form and a
-- placeholder is recoverable by renaming. On UPDATE, the same fallback would
-- silently rename an existing, correctly-named house to 'Station' -- it would
-- destroy information rather than supply a default. Refuse instead.
--
-- Returns the station id, mirroring pa_add_station, so the caller has a
-- positive confirmation rather than inferring success from no error.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_update_station(
  p_station_id uuid,
  p_name       text,
  p_label      text DEFAULT NULL,
  p_address    text DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  if v_name = '' then
    raise exception 'Give the station a name.';
  end if;

  -- Named explicitly so a bad id reads as 'Station not found' rather than
  -- succeeding with zero rows updated, which the client would show as saved.
  if not exists (select 1 from stations s where s.id = p_station_id) then
    raise exception 'Station not found';
  end if;

  -- is_default and department_id are intentionally absent from the SET list.
  update stations s
     set name    = v_name,
         label   = nullif(btrim(coalesce(p_label,   '')), ''),
         address = nullif(btrim(coalesce(p_address, '')), '')
   where s.id = p_station_id
  returning s.id into v_id;

  return v_id;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. Grants. Postgres default-grants EXECUTE to PUBLIC and anon inherits
-- through it, so revoke both and grant authenticated back -- same pattern as
-- sql/revoke_anon_execute_sweep.sql. The is_project_admin() check inside each
-- function is what actually gates it; the grant just keeps an unauthenticated
-- caller from reaching the body at all.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.pa_department_stations(uuid)             FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_department_stations(uuid)             TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_update_station(uuid, text, text, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_update_station(uuid, text, text, text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only except the probes, which roll back.
-- =====================================================================
--
-- -- 1. Both exist, SECURITY DEFINER, anon locked out.
-- --    Expect 2 rows; definer=t, anon_exec=f, auth_exec=t on both.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        prosecdef AS definer,
--        provolatile AS vol,   -- 's' for the read, 'v' for the write
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('pa_department_stations','pa_update_station')
--  ORDER BY proname;
--
-- -- 2. THE GATE IS REALLY IN EACH BODY, and the update's SET list touches
-- --    neither is_default nor department_id. Expect gated=t on both, and
-- --    sets_name=t, touches_default=f, touches_dept=f on pa_update_station.
-- --    The [^;] bound keeps each pattern INSIDE the update statement, so the
-- --    surrounding comments (which name both columns) cannot false-positive.
-- SELECT proname,
--        (prosrc ILIKE '%is_project_admin()%')          AS gated,
--        (prosrc ~* 'set[^;]*\mname\M[^;]*=')           AS sets_name,
--        (prosrc ~* 'set[^;]*\mis_default\M[^;]*=')     AS touches_default,
--        (prosrc ~* 'set[^;]*\mdepartment_id\M[^;]*=')  AS touches_dept
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('pa_department_stations','pa_update_station')
--  ORDER BY proname;
--
-- -- 3. UNTOUCHED PROOF — this file creates none of these. Expect the same
-- --    definitions as before; my_stations especially (the picker reads it).
-- SELECT pg_get_functiondef('public.my_stations'::regproc);
-- SELECT pg_get_functiondef('public.pa_add_station'::regproc);
--
-- -- 4. No policy was added or changed on stations. Expect exactly the two from
-- --    Phase A: stations_select_own_department, stations_write_dept_admin.
-- SELECT polname, polcmd FROM pg_policy
--  WHERE polrelid = 'public.stations'::regclass ORDER BY polname;
--
-- -- 5. THE PROBES. Run as postgres in this editor, where is_project_admin() is
-- --    false, so BOTH must RAISE 'Not authorized'. That error is the PASS.
-- --   SELECT * FROM public.pa_department_stations(
-- --     (SELECT id FROM public.departments ORDER BY name LIMIT 1));
-- --   BEGIN;
-- --     SELECT public.pa_update_station(
-- --       (SELECT id FROM public.stations ORDER BY name LIMIT 1), 'ZZ Probe');
-- --   ROLLBACK;
--
-- -- 6. Still exactly one default per department — no edit re-pointed anything.
-- --    Expect every defaults = 1.
-- SELECT d.name, count(*) FILTER (WHERE s.is_default) AS defaults, count(*) AS stations
--   FROM public.departments d LEFT JOIN public.stations s ON s.department_id = d.id
--  GROUP BY d.name ORDER BY d.name;
--
-- -- 7. Attribution intact after any edits — no shift lost its house and none
-- --    crossed a department. Expect 0 / 0. (Same pair as B3a VERIFY 1-2.)
-- SELECT count(*) - count(sp.station_id) AS unattributed,
--        count(*) FILTER (WHERE s.id IS NOT NULL AND s.department_id <> sp.department_id) AS cross_department
--   FROM public.station_presence sp
--   LEFT JOIN public.stations s ON s.id = sp.station_id;
--
-- ---------- SIGNED IN ----------
-- -- 8.  DA: Department Settings shows each station's ADDRESS under its name;
-- --     edit name/label/address and it persists after a reload.
-- -- 9.  DA who is NOT an admin: the edit save fails with a permission message,
-- --     never a false "Saved" (the .select() 0-row guard).
-- -- 10. PA: open a department you are NOT a member of — you see ITS stations
-- --     with addresses, not your own. Add one, edit another's address; both
-- --     persist and appear in that department's own Settings.
-- -- 11. PA edit does not change which house is DEFAULT, and the picker in that
-- --     department still lists the same stations (my_stations untouched).
