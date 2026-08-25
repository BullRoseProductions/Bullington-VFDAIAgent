-- =====================================================================
-- MULTI-STATION — PHASE B3: station attribution for station hours.
--
-- Shifts are physically per-station: you clock in at a HOUSE. This gives every
-- shift a station, and scopes the one operational view where answering across
-- houses is actively misleading.
--
-- WHAT DISCOVERY CHANGED. The B3 brief assumed shifts lived in station_log and
-- were therefore already stamped by Phase A. They do not: shifts live in
-- station_presence, which Phase A never touched. station_log holds only the
-- ad-hoc work log, and has exactly one reader — so there was also no
-- "two-reader inconsistency" to resolve. Every shift in the system currently has
-- NO station attribution at all, which is what this file fixes.
--
-- THE LINE, STATED ONCE. B3 changes what a shift is LABELLED with, and which
-- shifts one operational screen SHOWS. It does not change whether a shift is
-- credited, what it is worth, or what any report totals. If a change would move
-- a number on a compliance report, it is not B3.
--
-- SO, DELIBERATELY UNTOUCHED:
--   station_check_in / geofence_arrive — the trigger does the work instead
--   is_at_station                      — verification stays department-based
--                                        until Phase D moves the geofence too
--   dept_iso_hours / dept_station_shifts — compliance figures, Phase E
--   the auto-close sweeper and shift-length guard — Phase D
--   my_department_id / my_member_id / is_* / is_leadership — never
--
-- WHY THE CHECK-IN RPCs NEED NO CHANGE. set_default_station_id() was upgraded in
-- B1 to prefer my_active_station_id() with a department guard. Attaching that
-- same trigger to station_presence makes station_check_in AND geofence_arrive
-- station-aware without either function being edited — the identical trick that
-- made duties work in B1 without touching create_duty().
--
-- KNOWN LIMIT, named now rather than discovered later: a geofence arrival fires
-- from a background daemon. If its session context does not resolve
-- auth.email(), my_active_station_id() returns null, arm 1 misses, and the
-- arrival is attributed to the department's DEFAULT station. Correct and safe —
-- and it means a geofenced multi-station department attributes automatic
-- arrivals to the default house until Phase D makes geofencing per-station.
--
-- DEPLOY GATE: apply BEFORE the client deploys.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume. Same posture as Phase A.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='station_presence'
                    AND column_name='department_id') THEN
    RAISE EXCEPTION 'Phase B3 precondition failed: station_presence has no department_id. Both the backfill and the trigger depend on it.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace
                    AND proname='set_default_station_id') THEN
    RAISE EXCEPTION 'Phase B3 precondition failed: set_default_station_id() is missing. Phase A/B1 must be applied first.';
  END IF;

  -- The trigger must be the B1 version, which prefers the ACTIVE station. If the
  -- Phase A body is still live, shifts would be stamped with the default house
  -- regardless of which one the member is standing in — the exact bug this phase
  -- exists to avoid, and silent if unchecked.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace
                    AND proname='set_default_station_id'
                    AND prosrc ILIKE '%my_active_station_id()%') THEN
    RAISE EXCEPTION 'Phase B3 precondition failed: set_default_station_id() is still the Phase A version (no my_active_station_id). Apply Phase B1 first.';
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. station_id on station_presence.
--
-- NULLABLE, like Phase A's four. No ON DELETE action, so NO ACTION: a station
-- cannot be deleted while shifts point at it. That is the right default —
-- hours are a record, and a delete that would orphan them should fail loudly
-- rather than quietly NULL the link.
-- ---------------------------------------------------------------------
ALTER TABLE public.station_presence
  ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES public.stations(id);

COMMENT ON COLUMN public.station_presence.station_id IS
  'The station this shift was worked at. Backfilled to the department default in B3; new rows stamped by set_default_station_id(). Attribution only — it does not affect whether the shift is credited.';


-- ---------------------------------------------------------------------
-- 2. Backfill every existing shift to its department's default station.
--
-- Every historical shift predates stations entirely, so the default house is the
-- only honest answer — it is where the department was when the shift happened.
-- ---------------------------------------------------------------------
UPDATE public.station_presence sp SET station_id =
  (SELECT s.id FROM public.stations s
    WHERE s.department_id = sp.department_id AND s.is_default)
 WHERE sp.station_id IS NULL;


-- ---------------------------------------------------------------------
-- 3. The SAME trigger Phase A/B1 put on the other four tables.
--
-- No new function. This is the reuse that keeps station_check_in and
-- geofence_arrive untouched.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_station_id_station_presence ON public.station_presence;
CREATE TRIGGER trg_station_id_station_presence BEFORE INSERT ON public.station_presence
  FOR EACH ROW EXECUTE FUNCTION public.set_default_station_id();


-- ---------------------------------------------------------------------
-- 4. dept_on_station_now — scoped to the active station.
--
-- THE ONE READ THAT MUST SCOPE. "Who is on now" is a question about a building.
-- Answered across three houses it is not merely untidy, it is wrong in a way
-- that gets acted on: an officer would staff a call on a number that includes
-- people twelve miles away.
--
-- FAILS OPEN, DELIBERATELY. The guard is
--     (my_active_station_id() is null or sp.station_id = my_active_station_id())
-- rather than a bare equality. A bare `= null` matches nothing, so any hiccup
-- resolving the active station would render "nobody is on station" — the worst
-- possible wrong answer on a staffing view. Unfiltered is honest; empty is a
-- false statement. Same rule the client filters use.
--
-- Built from the LIVE body (pg_get_functiondef). The ONLY change is the added
-- WHERE clause: same RETURNS TABLE, same distinct-on, same ordering, same
-- is_leadership() gate — which is left exactly as found. Because the return
-- shape is unchanged, CREATE OR REPLACE is valid and no DROP is needed.
--
-- No station column is added to the result: after scoping, every row is from the
-- one station the caller is viewing, so naming it per-row would be noise.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_on_station_now()
 RETURNS TABLE(member_id uuid, member_name text, checked_in_at timestamp with time zone, kind text, verified boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  return query
    select x.member_id, x.member_name, x.checked_in_at, x.kind, x.verified
    from (
      select distinct on (m.id)
             m.id as member_id, m.name as member_name,
             sp.checked_in_at, sp.kind, sp.verified
      from public.station_presence sp
      join public.members m on m.id = sp.member_id
      where sp.department_id = v_dept
        and sp.checked_out_at is null
        and sp.kind in ('standby','training')
        -- B3: the active station only. Fails OPEN — see the note above.
        and (public.my_active_station_id() is null
             or sp.station_id = public.my_active_station_id())
      order by m.id, (sp.kind = 'training') desc, sp.checked_in_at
    ) x
    order by x.checked_in_at;
end;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only except the trigger test, which rolls back.
-- =====================================================================
--
-- -- 1. Column exists, nullable, and NOTHING is unattributed. Expect
-- --    still_null = 0.
-- SELECT count(*) AS shifts, count(station_id) AS attributed,
--        count(*) - count(station_id) AS still_null
--   FROM public.station_presence;
--
-- -- 2. Every shift's station belongs to that shift's own department — the
-- --    backfill cannot have crossed a boundary. Expect 0.
-- SELECT count(*) AS cross_department_rows
--   FROM public.station_presence sp
--   JOIN public.stations s ON s.id = sp.station_id
--  WHERE s.department_id <> sp.department_id;
--
-- -- 3. The trigger is attached, and is the FIFTH one on that function.
-- --    Expect 5 rows: apparatus, duties, equipment, station_log, station_presence.
-- SELECT c.relname AS table_name, t.tgname
--   FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--  WHERE NOT t.tgisinternal
--    AND t.tgfoid = 'public.set_default_station_id()'::regprocedure
--  ORDER BY c.relname;
--
-- -- 4. dept_on_station_now has the guard and still has its gate.
-- --    Expect scoped=t, fails_open=t, gate=t.
-- SELECT proname,
--        (prosrc ILIKE '%my_active_station_id()%')                       AS scoped,
--        (prosrc ILIKE '%my_active_station_id() is null%')               AS fails_open,
--        (prosrc ILIKE '%is_leadership()%')                              AS gate
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='dept_on_station_now';
--
-- -- 5. UNTOUCHED PROOF — none of these appear in this file outside comments.
-- --    Diff each against its pre-apply capture.
-- SELECT pg_get_functiondef('public.station_check_in'::regproc);
-- SELECT pg_get_functiondef('public.geofence_arrive'::regproc);
-- SELECT pg_get_functiondef('public.is_at_station'::regproc);
-- SELECT pg_get_functiondef('public.dept_iso_hours'::regproc);
-- SELECT pg_get_functiondef('public.dept_station_shifts'::regproc);
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
--
-- -- 6. TRIGGER TEST, rolled back. With no session my_active_station_id() is
-- --    null, so arm 2 applies and the row should still come back stamped with
-- --    the department's DEFAULT station.
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, kind, verified, source)
-- --     SELECT m.department_id, m.id, 'standby', false, 'geo'
-- --       FROM public.members m WHERE m.email IS NOT NULL ORDER BY m.id LIMIT 1
-- --     RETURNING department_id, member_id, station_id;
-- --   ROLLBACK;
--
-- -- 7. THE INVARIANT, and it is the one that matters most: no credited number
-- --    moved. Compare these to the same query run BEFORE applying — they must be
-- --    identical. B3 touches neither function, so any difference is a bug.
-- --    (Run signed in as leadership; both read auth context.)
-- --   SELECT * FROM public.dept_iso_hours(date_trunc('year', now()), now());
-- --   SELECT count(*), sum(hours) FROM public.dept_station_shifts(date_trunc('year', now()), now());
--
-- ---------- SIGNED IN ----------
-- -- 8.  Single-station department: Station Hours renders exactly as before, and
-- --     "on station now" shows the same people. Their one station is the default,
-- --     every shift carries it, so the filter is a no-op.
-- -- 9.  Two-station department: clock in while viewing Station B -> the shift is
-- --     attributed to B (check station_id, not just the screen).
-- -- 10. "On station now" while viewing B shows only B's people; switch to A and
-- --     it shows A's.
-- -- 11. Reports unchanged: dept_iso_hours and dept_station_shifts still report
-- --     the whole department, because Phase E has not happened yet.
