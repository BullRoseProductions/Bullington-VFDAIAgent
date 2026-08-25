-- =====================================================================
-- PHASE B2 · PART 3: pa_add_station() — a Project Admin adds a station to
-- ANY department.
--
-- WHY A SECOND ENTRY POINT. B1's add-station form lives inside a department's
-- own Settings and is gated by the stations write policy — is_dept_admin() AND
-- department_id = my_department_id(). That is right for a department running
-- itself, and useless for a Project Admin standing up a customer's houses:
-- a PA is not a Department Admin there, and my_department_id() is not that
-- department. Rather than weaken the policy, this adds a PA-scoped path that
-- takes the department explicitly.
--
-- THE is_project_admin() GATE IS THE WHOLE SECURITY BOUNDARY, exactly as it is
-- in pa_set_member_email() and the rest of the pa_* family. This function is
-- SECURITY DEFINER, so it writes past the stations RLS by design — that is the
-- point, since the caller is deliberately not a member of the target
-- department. Without the gate, any authenticated user could create a station
-- inside any department in the system. It is not validation; it is the
-- authorization.
--
-- Shape mirrored from sql/pa_support_actions.sql (pa_set_member_email):
-- plpgsql, VOLATILE SECURITY DEFINER, search_path=public, gate first, then the
-- narrow write, then GRANT to authenticated with the internal check doing the
-- real work.
--
-- DOES NOT TOUCH ANY EXISTING DEFAULT. is_default is always false here. The
-- partial unique index from Phase A would reject a second default anyway, but
-- the intent matters: adding a house never silently re-points a department's
-- notion of "the" station, and every existing row keeps the station it was
-- stamped with.
--
-- WRITES NOTHING ELSE. No membership, no active-station pointer, no department
-- change. A PA adding a station does not become a member of that department and
-- does not start acting in it.
--
-- DEPLOY GATE: apply BEFORE the client deploys — the PA control calls this by
-- name and PostgREST answers 404 for a function it has not seen.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.pa_add_station(
  p_department_id uuid,
  p_name          text,
  p_label         text DEFAULT NULL,
  p_address       text DEFAULT NULL
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

  -- The department has to exist. Without this the FK would still catch it, but
  -- with a constraint-violation message no operator can act on.
  if not exists (select 1 from departments d where d.id = p_department_id) then
    raise exception 'Department not found';
  end if;

  -- Blank falls back rather than refusing: the PA is mid-onboarding and a
  -- nameless station is recoverable by renaming, whereas an error here loses the
  -- rest of the form. A name is still expected — the client requires one.
  if v_name = '' then
    v_name := 'Station';
  end if;

  insert into stations (department_id, name, label, address, is_default, is_active)
  values (p_department_id,
          v_name,
          nullif(btrim(coalesce(p_label,   '')), ''),
          nullif(btrim(coalesce(p_address, '')), ''),
          false,          -- never re-points an existing default
          true)
  returning id into v_id;

  return v_id;
end;
$function$;

-- Postgres default-grants EXECUTE to PUBLIC and anon inherits through it, so
-- revoke both and grant authenticated back — same pattern as
-- sql/revoke_anon_execute_sweep.sql. The is_project_admin() check inside is what
-- actually gates this; the grant just keeps an unauthenticated caller from
-- reaching it at all.
REVOKE EXECUTE ON FUNCTION public.pa_add_station(uuid, text, text, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_add_station(uuid, text, text, text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only except the probe, which rolls back.
-- =====================================================================
--
-- -- 1. Exists, SECURITY DEFINER, anon locked out. Expect definer=t, anon=f, auth=t.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        prosecdef AS definer,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='pa_add_station';
--
-- -- 2. THE GATE IS REALLY IN THE BODY. Expect gated=t. A SECURITY DEFINER
-- --    function that writes into any department without this is a hole.
-- SELECT proname, (prosrc ILIKE '%is_project_admin()%') AS gated,
--        (prosrc ILIKE '%is_default%false%' OR prosrc ILIKE '%false,%') AS never_default
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='pa_add_station';
--
-- -- 3. THE PROBE. Run as postgres in this editor, where is_project_admin() is
-- --    false, so this must RAISE 'Not authorized'. That error is the PASS.
-- --    Rolled back either way.
-- --   BEGIN;
-- --     SELECT public.pa_add_station(
-- --       (SELECT id FROM public.departments ORDER BY name LIMIT 1), 'ZZ Probe');
-- --   ROLLBACK;
--
-- -- 4. Still exactly one default per department — nothing was re-pointed.
-- --    Expect every count = 1.
-- SELECT d.name, count(*) FILTER (WHERE s.is_default) AS defaults, count(*) AS stations
--   FROM public.departments d LEFT JOIN public.stations s ON s.department_id = d.id
--  GROUP BY d.name ORDER BY d.name;
--
-- ---------- SIGNED IN ----------
-- -- 5. As a PROJECT ADMIN, on a department you are not a member of: add a
-- --    station from the PA side. It appears in that department's Stations list,
-- --    and once that department has 2+ its members see the picker.
-- -- 6. As a NON-PA: the control is not rendered, and calling the RPC directly
-- --    raises 'Not authorized'.
