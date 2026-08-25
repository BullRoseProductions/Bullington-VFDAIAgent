-- =====================================================================
-- MULTI-STATION — PHASE B1: active-station context.
--
-- Phase A built the stations layer and stamped every row. B1 makes the app read
-- and write BY STATION for the first time: an active-station anchor, a picker
-- list, a setter, and an upgraded auto-stamp so new rows land on the station
-- you are actually looking at.
--
-- STATION SCOPING IS A UI FILTER, NOT AN RLS BOUNDARY. Every member of a
-- department may work at every station, so filtering by station is about showing
-- the right house's things — never about restricting access. Nothing here
-- changes the RLS on apparatus, equipment, duties or station_log: they stay
-- department-scoped exactly as they are. A member can still read all of their
-- department's rows, which they were always allowed to do.
--
-- That is what keeps B1 low-risk. It touches no existing policy and none of the
-- protected functions (my_department_id, my_member_id, the is_* family). It adds
-- one table, three functions, and upgrades ONE Phase A function — the auto-stamp
-- trigger — for the reason set out at step 5.
--
-- THE SINGLE-STATION INVARIANT, and why it holds mechanically:
--   my_stations() returns 1 row  -> the picker is hidden
--   my_active_station_id()       -> that department's default station
--   Phase A stamped every row    -> with that same default station
--   so .eq(station_id, active)   -> matches every row the screen showed before
-- A one-station department therefore sees exactly what it saw yesterday. The
-- filter is a no-op for them by construction, not by luck.
--
-- DEPLOY GATE: apply BEFORE the client deploys. The client calls all three new
-- functions on load and PostgREST answers 404 for ones it has not seen.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. member_active_station — which station within the department a login is
--    currently looking at. Mirrors member_active_department exactly.
--
-- KEYED BY EMAIL for the same reason that table is: one human, several member
-- rows, and auth.email() is the thing that is singular about them.
--
-- ON DELETE CASCADE: a pointer at a deleted station is meaningless. Losing the
-- row drops the person back to their department's default station, which is what
-- my_active_station_id() falls through to anyway.
--
-- NOTE this is keyed by email ALONE, not (email, department). A multi-department
-- login therefore carries one active station at a time, and switching department
-- leaves it pointing at the old department's station — which
-- my_active_station_id() rejects and replaces with the new department's default.
-- That is the correct outcome and is enforced there rather than modelled here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.member_active_station (
  email       text PRIMARY KEY,
  station_id  uuid NOT NULL REFERENCES public.stations(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.member_active_station IS
  'Which station a login is currently viewing. Keyed by lower(email). Read by my_active_station_id(); written only through set_active_station(). A stale row pointing outside the active department is ignored, not an error.';

ALTER TABLE public.member_active_station ENABLE ROW LEVEL SECURITY;

/* OWN ROW ONLY — the same three policies member_active_department has.
   set_active_station() is SECURITY DEFINER and bypasses these; its department
   check is the real boundary for writes. These stop a signed-in user reading or
   forging somebody else's row through PostgREST. No DELETE policy: clearing a
   selection is done by pointing it elsewhere, and a station deletion cascades. */
DROP POLICY IF EXISTS member_active_station_select_own ON public.member_active_station;
CREATE POLICY member_active_station_select_own ON public.member_active_station
  FOR SELECT TO authenticated
  USING (email = lower(auth.email()));

DROP POLICY IF EXISTS member_active_station_insert_own ON public.member_active_station;
CREATE POLICY member_active_station_insert_own ON public.member_active_station
  FOR INSERT TO authenticated
  WITH CHECK (email = lower(auth.email()));

DROP POLICY IF EXISTS member_active_station_update_own ON public.member_active_station;
CREATE POLICY member_active_station_update_own ON public.member_active_station
  FOR UPDATE TO authenticated
  USING (email = lower(auth.email()))
  WITH CHECK (email = lower(auth.email()));

REVOKE ALL ON TABLE public.member_active_station FROM anon, public;
GRANT SELECT, INSERT, UPDATE ON TABLE public.member_active_station TO authenticated;


-- ---------------------------------------------------------------------
-- 2. my_stations() — the picker list.
--
-- SECURITY DEFINER and takes NO PARAMETER, the same property that makes
-- my_departments() safe: there is nothing to pass to make it answer for another
-- department. It can only ever return the stations of my_department_id().
--
-- Default first, then by name, so the picker opens on the house a department
-- thinks of as "the" station rather than whatever sorts first alphabetically.
--
-- Returns is_active rather than filtering on it: the picker needs to know which
-- stations are retired in order to present them differently, and hiding a
-- retired station from a person still standing in it would be unhelpful.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_stations()
 RETURNS TABLE (station_id uuid, name text, label text, is_default boolean, is_active boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.id, s.name, s.label, s.is_default, s.is_active
    from stations s
   where s.department_id = public.my_department_id()
   order by s.is_default desc, s.name;
$function$;


-- ---------------------------------------------------------------------
-- 3. set_active_station() — choose the station to view.
--
-- THE DEPARTMENT CHECK IS THE SECURITY BOUNDARY, exactly as the membership check
-- is in set_active_department(). This function is SECURITY DEFINER, so it writes
-- past the RLS policies above. Without the EXISTS a signed-in user could point
-- their active station at ANY station row in the system, including another
-- department's — and while station scoping is only a filter today, a stored
-- pointer into a foreign department is the kind of thing a later phase would
-- reasonably trust. Refuse it at the door.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_active_station(p_station_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := lower(auth.email());
begin
  if v_email is null or btrim(v_email) = '' then
    raise exception 'Not signed in';
  end if;

  -- THE boundary. The station must belong to the caller's current department.
  if not exists (
    select 1 from stations s
     where s.id = p_station_id
       and s.department_id = public.my_department_id()
  ) then
    raise exception 'That station is not in your department';
  end if;

  insert into member_active_station (email, station_id)
  values (v_email, p_station_id)
  on conflict (email) do update
    set station_id = excluded.station_id,
        updated_at = now();
end;
$function$;


-- ---------------------------------------------------------------------
-- 4. my_active_station_id() — the station anchor.
--
-- Mirrors my_department_id()'s coalesce shape: the saved choice if it is still
-- valid, otherwise a deterministic default. Validity here means "belongs to the
-- department I am currently in", which is what makes a stale pointer harmless
-- when someone switches department — arm 1 simply does not match and arm 2
-- answers with the new department's default.
--
-- NEVER RETURNS A STATION OUTSIDE THE CALLER'S DEPARTMENT. Both arms are
-- constrained by my_department_id(), so there is no path — stale row, deleted
-- station, switched department — that yields a foreign station id.
--
-- STABLE, and cheap: two indexed lookups. It is called on every scoped screen.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_active_station_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    -- 1) the saved station, ONLY if it is in the department I am currently in
    ( select mas.station_id
        from member_active_station mas
        join stations s on s.id = mas.station_id
       where mas.email = lower(auth.email())
         and s.department_id = public.my_department_id() ),
    -- 2) else this department's default station
    ( select s.id
        from stations s
       where s.department_id = public.my_department_id()
         and s.is_default
       limit 1 )
  );
$function$;


-- ---------------------------------------------------------------------
-- 5. UPGRADE the Phase A auto-stamp trigger: stamp the ACTIVE station.
--
-- WHY THIS IS NECESSARY AND NOT MERELY TIDIER. Phase A stamped the department's
-- DEFAULT station on any insert that omitted station_id. That was right when
-- nothing could choose a station. It is wrong now: a duty added while viewing
-- Station B would land on Station A and vanish from B's filtered list.
--
-- AND THE CLIENT CANNOT FIX IT FOR DUTIES. Apparatus and equipment are inserted
-- directly and can set station_id themselves, but duties are created through
-- create_duty(), a SECURITY DEFINER RPC the client cannot pass a station to.
-- Changing that RPC would mean dropping and recreating an existing function;
-- upgrading this trigger fixes every insert path at once — direct, RPC, and any
-- future one — which is why it was chosen at review.
--
-- THE DEPARTMENT GUARD IS LOAD-BEARING. my_active_station_id() answers for the
-- CALLER's department. A row being inserted for a different department — a
-- support action, a cross-department admin path — must not be stamped with the
-- caller's station. Arm 1 therefore requires the active station to belong to
-- NEW.department_id, and anything else falls through to that department's own
-- default, which is exactly Phase A's behaviour.
--
-- Still only fills when NULL, so an explicit station_id is never overwritten.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_default_station_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.station_id is null and new.department_id is not null then
    -- 1) the caller's ACTIVE station, but only if it is in this row's department
    select s.id into new.station_id
      from stations s
     where s.id = public.my_active_station_id()
       and s.department_id = new.department_id;

    -- 2) else this row's department's default station (Phase A behaviour)
    if new.station_id is null then
      select s.id into new.station_id
        from stations s
       where s.department_id = new.department_id
         and s.is_default
       limit 1;
    end if;
  end if;
  return new;
end;
$function$;

-- The four triggers created in Phase A already point at this function by name,
-- so CREATE OR REPLACE re-points all of them at once. They are not re-created
-- here — nothing about the triggers themselves changes, only the body they call.

REVOKE EXECUTE ON FUNCTION public.my_stations()               FROM anon, public;  GRANT EXECUTE ON FUNCTION public.my_stations()               TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_active_station(uuid)    FROM anon, public;  GRANT EXECUTE ON FUNCTION public.set_active_station(uuid)    TO authenticated;
REVOKE EXECUTE ON FUNCTION public.my_active_station_id()      FROM anon, public;  GRANT EXECUTE ON FUNCTION public.my_active_station_id()      TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_default_station_id()    FROM anon, public;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only except the trigger test, which rolls back.
-- As before, functions reading auth.email() return NULL/zero rows in the SQL
-- editor. That is correct, not a failure.
-- =====================================================================
--
-- -- 1. The three new functions exist, are SECURITY DEFINER, anon locked out.
-- --    Expect definer=t, anon=f, auth=t on all three.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        CASE provolatile WHEN 's' THEN 'STABLE' WHEN 'v' THEN 'VOLATILE' END AS volatility,
--        prosecdef AS definer,
--        has_function_privilege('anon', oid, 'EXECUTE')          AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('my_stations','set_active_station','my_active_station_id')
--  ORDER BY proname;
--
-- -- 2. THE BOUNDARY IS IN set_active_station's BODY. Expect gated=t.
-- SELECT proname, (prosrc ILIKE '%not in your department%') AS gated
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='set_active_station';
--
-- -- 3. THE TRIGGER NOW PREFERS THE ACTIVE STATION. Expect active_first=t.
-- SELECT proname, (prosrc ILIKE '%my_active_station_id()%') AS active_first
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='set_default_station_id';
--
-- -- 4. The four Phase A triggers still exist and point at that function.
-- --    Expect 4 rows.
-- SELECT c.relname AS table_name, t.tgname
--   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--  WHERE NOT t.tgisinternal
--    AND t.tgfoid = 'public.set_default_station_id()'::regprocedure
--  ORDER BY c.relname;
--
-- -- 5. UNTOUCHED PROOF — none of these appear in this file outside comments.
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
-- SELECT pg_get_functiondef('public.is_canmanage()'::regprocedure);
-- SELECT pg_get_functiondef('public.is_dept_admin()'::regprocedure);
--
-- -- 6. RLS on the new table: expect rls_enabled=t and three own-row policies.
-- SELECT c.relrowsecurity AS rls_enabled, p.polname, p.polcmd
--   FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
--  WHERE c.oid = 'public.member_active_station'::regclass
--  ORDER BY p.polname;
--
-- -- 7. THE RESOURCE TABLES' POLICIES ARE UNCHANGED — B1 adds a filter, not a
-- --    boundary. Compare against the Phase A capture; expect no difference.
-- SELECT c.relname, p.polname,
--        CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
--                      WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END AS cmd,
--        pg_get_expr(p.polqual, p.polrelid) AS using_expr
--   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--  WHERE c.relnamespace='public'::regnamespace
--    AND c.relname IN ('apparatus','equipment','duties','station_log')
--  ORDER BY c.relname, p.polname;
--
-- -- 8. TRIGGER TEST, rolled back. With no session auth.email() is NULL, so
-- --    my_active_station_id() returns NULL and arm 2 applies — the row should
-- --    still come back stamped with that department's DEFAULT station, proving
-- --    the fallback survived the upgrade.
-- --   BEGIN;
-- --     INSERT INTO public.apparatus (department_id, name, type, status)
-- --     SELECT id, 'ZZ B1 Trigger Test', 'Pumper', 'Pass'
-- --       FROM public.departments ORDER BY name LIMIT 1
-- --     RETURNING department_id, name, station_id;
-- --   ROLLBACK;
-- --   -- then confirm nothing survived:
-- --   SELECT count(*) FROM public.apparatus WHERE name = 'ZZ B1 Trigger Test';   -- expect 0
--
-- ---------- SIGNED IN, on the deployed app ----------
-- -- 9.  Single-station department: no picker; Apparatus / Equipment / Duties
-- --     render exactly as before. THE INVARIANT.
-- -- 10. Add a second station as a Department Admin -> the picker appears.
-- -- 11. Switch to it -> the three screens show its rows (empty at first);
-- --     switch back -> the original rows return.
-- -- 12. Add a rig AND a duty while viewing station B -> both appear under B.
-- --     The duty is the one that proves the trigger upgrade worked, since the
-- --     client cannot set its station_id.
-- -- 13. A plain member (not an admin) can switch stations and see each one's
-- --     rows — station scoping is a view, not a permission.
