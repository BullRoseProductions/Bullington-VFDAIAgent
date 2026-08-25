-- =====================================================================
-- MULTI-STATION — PHASE A: the stations layer. INVISIBLE BY DESIGN.
--
-- Adds a stations table under department, backfills one station per existing
-- department, stamps the four top-level per-station tables with station_id, and
-- keeps that column complete going forward with a trigger. NOTHING READS THE NEW
-- LAYER. No client change ships with this; there is nothing to deploy.
--
-- THE INVARIANT THAT DEFINES SUCCESS: every existing single-station department
-- behaves byte-for-byte as before. Apparatus, equipment, duties, station hours,
-- geofence and every screen render exactly as they did. If anything visible
-- changes, Phase A is wrong.
--
-- WHY THAT HOLDS. This file adds a table, four NULLABLE columns, one trigger
-- function with four triggers, and policies on the new table only. It changes no
-- existing column, no existing policy, and no existing function. Nothing selects
-- station_id, so nothing can behave differently because of it.
--
-- THE GEOFENCE IS COPIED, NOT MOVED. The station rows get lat/lng/radius/enabled
-- as DATA. The live geofence keeps reading departments until Phase D. Copying is
-- not cutting over — if this file changed where the geofence reads from, it
-- would be changing behaviour, which Phase A forbids.
--
-- WRITE POLICY IS DELIBERATELY STRICTER than the tables it sits above. Adding or
-- retiring a station is an org-structure change, a level above managing a rig or
-- a duty, so it is is_dept_admin() (Project Admin / Department Admin) even where
-- apparatus or duties admit Officers. That is a ruling, not an oversight.
--
-- READ POLICY is the ordinary per-department pattern: department members can see
-- their own stations. Note this resolves through my_department_id(), so a
-- multi-membership login sees the ACTIVE department's stations — correct for the
-- new model, and only relevant to leftover test accounts.
--
-- ROLLBACK is complete and mechanical, because nothing existing was altered:
--   DROP TRIGGER trg_station_id_apparatus  ON public.apparatus;   (x4)
--   ALTER TABLE public.apparatus DROP COLUMN station_id;          (x4)
--   DROP FUNCTION public.set_default_station_id();
--   DROP TABLE public.stations;
-- That restores the exact pre-Phase-A state.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- The introspection that would have confirmed these (the departments column
-- names, and that all four target tables carry department_id) was not available
-- when this was written. Rather than guess and hope, the migration checks its
-- own assumptions and refuses inside the transaction if any is wrong. A failure
-- here rolls everything back and names the exact problem; the alternative — a
-- backfill silently copying from a column that does not exist, or a trigger on a
-- table with no department_id — would fail later and less clearly.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text;
BEGIN
  -- the departments columns the backfill copies FROM
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(array['station','station_lat','station_lng','station_radius_m','geofence_enabled']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='departments' AND column_name=c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase A precondition failed: departments is missing column(s): %. The backfill copies from these — check the real names before re-running.', v_missing;
  END IF;

  -- every target table must exist and carry department_id (the backfill and the
  -- trigger both key off it)
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(array['apparatus','equipment','duties','station_log']) AS t
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name=t AND column_name='department_id');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase A precondition failed: table(s) % lack a department_id column (or do not exist). Both the backfill and the auto-fill trigger depend on it.', v_missing;
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. stations
--
-- geofence_enabled lives here as well as on departments for now. That is
-- deliberate duplication for one phase: the column has to exist and be
-- populated before Phase D can cut the geofence over to it, and the alternative
-- (add it in D) would mean a second backfill under time pressure.
--
-- radius_m / lat / lng are nullable because a department that never pinned its
-- station has nothing to copy, and inventing coordinates would be worse than
-- leaving them absent.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id     uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  name              text NOT NULL,
  label             text,
  address           text,
  lat               double precision,
  lng               double precision,
  radius_m          integer,
  geofence_enabled  boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  is_default        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stations IS
  'Physical stations under a department. Phase A: created and backfilled, read by nothing. The default station is what every pre-existing per-station row is stamped with.';

-- AT MOST ONE DEFAULT PER DEPARTMENT, enforced by the database rather than by
-- convention. Every backfill and every trigger lookup below assumes "the
-- department's default station" resolves to exactly one row; a partial unique
-- index is what makes that assumption true instead of hopeful.
CREATE UNIQUE INDEX IF NOT EXISTS stations_one_default_per_department
  ON public.stations (department_id) WHERE is_default;

-- Lookup path for the trigger and the backfills.
CREATE INDEX IF NOT EXISTS stations_department_id_idx
  ON public.stations (department_id);

ALTER TABLE public.stations ENABLE ROW LEVEL SECURITY;

/* READ: the ordinary per-department pattern used throughout this schema —
   department members see their own department's stations. */
DROP POLICY IF EXISTS stations_select_own_department ON public.stations;
CREATE POLICY stations_select_own_department ON public.stations
  FOR SELECT TO authenticated
  USING (department_id = public.my_department_id());

/* WRITE: is_dept_admin() — Project Admin / Department Admin only, and
   deliberately stricter than the resource tables underneath. Creating or
   retiring a station changes the shape of the organisation; managing a rig
   inside one does not. USING and WITH CHECK both carry the department test so
   neither a row already in another department can be edited, nor a new row
   written into one. */
DROP POLICY IF EXISTS stations_write_dept_admin ON public.stations;
CREATE POLICY stations_write_dept_admin ON public.stations
  FOR ALL TO authenticated
  USING      (public.is_dept_admin() AND department_id = public.my_department_id())
  WITH CHECK (public.is_dept_admin() AND department_id = public.my_department_id());

REVOKE ALL ON TABLE public.stations FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stations TO authenticated;


-- ---------------------------------------------------------------------
-- 2. Backfill: exactly one default station per department.
--
-- IDEMPOTENT via the NOT EXISTS guard, so a re-run is a no-op rather than a
-- second station. The partial unique index above would catch a duplicate anyway,
-- but failing loudly on a re-run is worse than doing nothing on one.
--
-- The name comes from the department's own `station` text when it has one, so a
-- department that already called itself "Station 20" keeps that word. Blank
-- falls back to 'Main Station' rather than to an empty name the UI would have to
-- special-case forever.
-- ---------------------------------------------------------------------
INSERT INTO public.stations
  (department_id, name, lat, lng, radius_m, geofence_enabled, is_default, is_active)
SELECT d.id,
       CASE WHEN d.station IS NOT NULL AND btrim(d.station) <> ''
            THEN btrim(d.station) ELSE 'Main Station' END,
       d.station_lat,
       d.station_lng,
       d.station_radius_m,
       coalesce(d.geofence_enabled, false),
       true,
       true
  FROM public.departments d
 WHERE NOT EXISTS (SELECT 1 FROM public.stations s WHERE s.department_id = d.id);


-- ---------------------------------------------------------------------
-- 3. station_id on the four TOP-LEVEL per-station tables.
--
-- NULLABLE in Phase A. Phase B tightens it to NOT NULL once every write path
-- sets it; doing that now would break every insert the current app makes, which
-- is precisely the behaviour change Phase A forbids.
--
-- The child tables (apparatus_checks/_results/_maintenance/_photos/
-- _service_periods, equipment_custody/_photos, duty_log) are deliberately NOT
-- touched — they reach a station through their parent, and stamping them now
-- would double the surface for no gain before anything reads it.
-- ---------------------------------------------------------------------
ALTER TABLE public.apparatus   ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES public.stations(id);
ALTER TABLE public.equipment   ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES public.stations(id);
ALTER TABLE public.duties      ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES public.stations(id);
ALTER TABLE public.station_log ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES public.stations(id);

-- No ON DELETE action is specified, so this is NO ACTION: a station cannot be
-- deleted while rows still point at it. That is the right default here — Phase B
-- gains a "move these rows first" flow, and until then a delete that would
-- orphan apparatus should fail loudly rather than silently NULL the link.


-- ---------------------------------------------------------------------
-- 4. Backfill station_id = the department's default station.
-- ---------------------------------------------------------------------
UPDATE public.apparatus a SET station_id =
  (SELECT s.id FROM public.stations s WHERE s.department_id = a.department_id AND s.is_default)
 WHERE a.station_id IS NULL;

UPDATE public.equipment e SET station_id =
  (SELECT s.id FROM public.stations s WHERE s.department_id = e.department_id AND s.is_default)
 WHERE e.station_id IS NULL;

UPDATE public.duties du SET station_id =
  (SELECT s.id FROM public.stations s WHERE s.department_id = du.department_id AND s.is_default)
 WHERE du.station_id IS NULL;

UPDATE public.station_log sl SET station_id =
  (SELECT s.id FROM public.stations s WHERE s.department_id = sl.department_id AND s.is_default)
 WHERE sl.station_id IS NULL;


-- ---------------------------------------------------------------------
-- 5. Auto-fill trigger — keeps the column complete with no client change.
--
-- The current app inserts these rows without station_id, because it knows
-- nothing about stations. Without this, every row created between Phase A and
-- Phase B would arrive NULL and Phase B would open with a second backfill and a
-- column it cannot trust. The trigger closes that gap invisibly: nothing sends
-- station_id, nothing reads it, and it is nonetheless always right.
--
-- SECURITY DEFINER because the lookup reads public.stations, which is now
-- RLS-protected. Under invoker rights an insert made through a SECURITY DEFINER
-- RPC (equipment and duties both have those) could run in a context where the
-- stations SELECT policy does not match, and the trigger would silently leave
-- station_id NULL — the exact hole it exists to close. It leaks nothing: it
-- returns an id that is already fully determined by the department_id on the row
-- being inserted.
--
-- Only fills when NULL, so an explicit station_id from Phase B onward is never
-- overwritten.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_default_station_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.station_id is null and new.department_id is not null then
    select s.id into new.station_id
      from stations s
     where s.department_id = new.department_id
       and s.is_default
     limit 1;
  end if;
  return new;
end;
$function$;

DROP TRIGGER IF EXISTS trg_station_id_apparatus   ON public.apparatus;
CREATE TRIGGER trg_station_id_apparatus   BEFORE INSERT ON public.apparatus
  FOR EACH ROW EXECUTE FUNCTION public.set_default_station_id();

DROP TRIGGER IF EXISTS trg_station_id_equipment   ON public.equipment;
CREATE TRIGGER trg_station_id_equipment   BEFORE INSERT ON public.equipment
  FOR EACH ROW EXECUTE FUNCTION public.set_default_station_id();

DROP TRIGGER IF EXISTS trg_station_id_duties      ON public.duties;
CREATE TRIGGER trg_station_id_duties      BEFORE INSERT ON public.duties
  FOR EACH ROW EXECUTE FUNCTION public.set_default_station_id();

DROP TRIGGER IF EXISTS trg_station_id_station_log ON public.station_log;
CREATE TRIGGER trg_station_id_station_log BEFORE INSERT ON public.station_log
  FOR EACH ROW EXECUTE FUNCTION public.set_default_station_id();

-- The trigger function is invoked by the trigger regardless of EXECUTE rights;
-- revoking anon/public is hygiene, since a direct call is meaningless anyway.
REVOKE EXECUTE ON FUNCTION public.set_default_station_id() FROM anon, public;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only.
-- =====================================================================
--
-- -- 1. ONE DEFAULT STATION PER DEPARTMENT. All four numbers must be equal and
-- --    without_station must be 0.
-- SELECT (SELECT count(*) FROM public.departments)                              AS departments,
--        (SELECT count(*) FROM public.stations)                                 AS stations,
--        (SELECT count(*) FROM public.stations WHERE is_default)                AS default_stations,
--        (SELECT count(DISTINCT department_id) FROM public.stations)            AS depts_with_a_station,
--        (SELECT count(*) FROM public.departments d
--           WHERE NOT EXISTS (SELECT 1 FROM public.stations s WHERE s.department_id = d.id)) AS without_station;
--
-- -- 2. NO UNSTAMPED ROWS. Every count must be 0.
-- SELECT (SELECT count(*) FROM public.apparatus   WHERE station_id IS NULL) AS apparatus_null,
--        (SELECT count(*) FROM public.equipment   WHERE station_id IS NULL) AS equipment_null,
--        (SELECT count(*) FROM public.duties      WHERE station_id IS NULL) AS duties_null,
--        (SELECT count(*) FROM public.station_log WHERE station_id IS NULL) AS station_log_null;
--
-- -- 3. THE BACKFILL COPIED THE GEOFENCE DATA, and the department still holds its
-- --    own copy — Phase A copies, it does not move. Expect matching pairs.
-- SELECT d.name, d.station_lat, s.lat, d.station_lng, s.lng,
--        d.station_radius_m, s.radius_m, d.geofence_enabled, s.geofence_enabled
--   FROM public.departments d JOIN public.stations s ON s.department_id = d.id AND s.is_default
--  ORDER BY d.name;
--
-- -- 4. THE TRIGGER FIRES for an insert that omits station_id, exactly as the app
-- --    does today. Rolled back, so nothing is left behind. Expect station_id to
-- --    come back as that department's default station id.
-- --   BEGIN;
-- --     INSERT INTO public.apparatus (department_id, name, type, status)
-- --     SELECT id, 'ZZ Trigger Test', 'Pumper', 'Pass' FROM public.departments ORDER BY name LIMIT 1
-- --     RETURNING department_id, name, station_id;
-- --   ROLLBACK;
--
-- -- 5. UNTOUCHED PROOF. Diff each against the STEP 0 capture — they must be
-- --    character-for-character identical. This file contains no CREATE for any
-- --    of them.
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
-- SELECT pg_get_functiondef('public.is_canmanage()'::regprocedure);
-- SELECT pg_get_functiondef('public.is_dept_admin()'::regprocedure);
--
-- -- 6. POLICIES ON stations, and confirmation that the four resource tables'
-- --    policies were NOT touched. Compare the latter against the STEP 0 capture.
-- SELECT c.relname, p.polname,
--        CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
--                      WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END AS cmd,
--        pg_get_expr(p.polqual, p.polrelid)      AS using_expr,
--        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
--   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--  WHERE c.relnamespace='public'::regnamespace
--    AND c.relname IN ('stations','apparatus','equipment','duties','station_log')
--  ORDER BY c.relname, p.polname;
--
-- -- 7. anon is locked out of the new table and the new function.
-- SELECT has_table_privilege('anon','public.stations','SELECT')          AS anon_can_select_stations,
--        has_function_privilege('anon','public.set_default_station_id()','EXECUTE') AS anon_can_exec_trigger_fn;
--
-- -- 8. THE BYTE-IDENTICAL PROOF, and it is not a query. On the deployed web app,
-- --    as a member of an existing single-station department: open Apparatus,
-- --    Equipment, Station Duties and Station Hours and confirm each renders
-- --    exactly as before. Nothing reads station_id yet, so anything that looks
-- --    different means Phase A did something it should not have.
