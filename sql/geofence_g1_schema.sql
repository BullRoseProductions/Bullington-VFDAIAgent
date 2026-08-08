-- =====================================================================
-- GEOFENCE G1 — schema + the de-dup guarantee. INERT.
--
-- One column, one unique index, and (conditionally) one CHECK. Nothing reads
-- geofence_enabled until G5, and no geofence RPC exists until G2. Applying this
-- changes no screen and no number.
--
-- WHY THE INDEX IS THE POINT OF THIS SLICE.
-- Today "one open session per member" is APPLICATION LOGIC, not a constraint:
-- station_check_in does `select ... where checked_out_at is null; if found then
-- return v_row;` and that is the only thing standing between a member and two
-- open standby rows. That holds while ONE code path writes presence. Phase 2
-- adds a second, independent writer — a background daemon on the phone that
-- fires ENTER events the app never sees — and a read-then-insert guard cannot
-- survive two writers racing. This turns the rule into something the database
-- refuses, so the daemon and the PWA cannot both open a session.
--
-- Partial and scoped to standby/offsite deliberately: training rows legitimately
-- coexist with a standby row (a member on shift who also scans into a drill),
-- and they are closed by the finalize trigger, not by a member action.
--
-- PRECONDITION: an existing member with two open rows makes the index
-- impossible to create. I could not check from here — the Supabase session is
-- expired and I will not sign in — so the check is built in below and RAISES
-- with the offending rows rather than failing on a bare violation. Standalone
-- pre-flight, if you would rather look first:
--
--   SELECT member_id, count(*) AS open_rows,
--          string_agg(kind || ' since ' || checked_in_at::text, ', ') AS rows
--     FROM public.station_presence
--    WHERE checked_out_at IS NULL AND kind IN ('standby','offsite')
--    GROUP BY member_id HAVING count(*) > 1;
--
--   -- expect 0 rows. Any result must be closed or voided BEFORE this runs.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Precondition — refuse rather than force.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_bad  int;
  v_list text;
BEGIN
  SELECT count(*) INTO v_bad FROM (
    SELECT member_id FROM public.station_presence
     WHERE checked_out_at IS NULL AND kind IN ('standby','offsite')
     GROUP BY member_id HAVING count(*) > 1
  ) x;

  IF v_bad > 0 THEN
    SELECT string_agg(format('%s: %s open (%s)', m.name, g.n, g.detail), E'\n  ')
      INTO v_list
      FROM (
        SELECT member_id, count(*) AS n,
               string_agg(kind || ' since ' || to_char(checked_in_at, 'Mon DD HH24:MI'), ', ') AS detail
          FROM public.station_presence
         WHERE checked_out_at IS NULL AND kind IN ('standby','offsite')
         GROUP BY member_id HAVING count(*) > 1
      ) g
      JOIN public.members m ON m.id = g.member_id;

    RAISE EXCEPTION
      E'% member(s) already hold more than one open standby/offsite row, so the unique index cannot be created:\n  %\n\nNothing was changed. Close or void the extras first (station_check_out closes one at a time; the needs-review queue can void), then re-run.',
      v_bad, v_list;
  END IF;

  RAISE NOTICE 'Precondition OK — no member holds more than one open standby/offsite row.';
END $$;


-- ---------------------------------------------------------------------
-- 1. The per-department toggle.
--
-- Default FALSE: every existing department keeps today's PWA-only flows until
-- somebody deliberately opts in. Geofencing needs Always-location consent and a
-- store review; it must never switch itself on for a department that has not
-- agreed to be tracked.
-- ---------------------------------------------------------------------
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS geofence_enabled boolean NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------
-- 2. One open session per member — enforced, not assumed.
--
-- The guarantee G2's geofence_arrive relies on: it can attempt an insert and
-- trust the database to reject a duplicate, instead of racing a read.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS station_presence_one_open_session_per_member
  ON public.station_presence (member_id)
  WHERE checked_out_at IS NULL AND kind IN ('standby','offsite');


-- ---------------------------------------------------------------------
-- 3. source CHECK — added ONLY if what is already there is clean.
--
-- `source` is plain text with DEFAULT 'geo' and no constraint, so
-- 'gps_geofence' needs no migration to be writable. A CHECK is still worth
-- having for the same reason `kind` has one — it stops a typo becoming a data
-- class nobody notices.
--
-- But it is not worth FORCING. This inspects the values actually present and
-- only constrains when they are tidy: at most four distinct values, every one a
-- plain lowercase identifier. Anything else and it reports what it found and
-- skips, leaving the column unconstrained rather than encoding existing mess
-- into a constraint we would then have to work around.
--
-- NULLs are not a problem either way: a CHECK whose expression evaluates to
-- NULL passes, so existing NULL sources cannot break this.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_vals  text[];
  v_n     int;
  v_messy int;
  v_list  text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'station_presence_source_check'
                AND conrelid = 'public.station_presence'::regclass) THEN
    RAISE NOTICE 'source CHECK already present — leaving it alone.';
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT source), count(DISTINCT source)
    INTO v_vals, v_n
    FROM public.station_presence WHERE source IS NOT NULL;

  v_vals  := coalesce(v_vals, ARRAY[]::text[]);
  v_list  := coalesce(array_to_string(v_vals, ', '), '(none)');
  SELECT count(*) INTO v_messy FROM unnest(v_vals) v WHERE v !~ '^[a-z][a-z0-9_]*$';

  RAISE NOTICE 'source values in use: % (% distinct)', v_list, coalesce(v_n, 0);

  IF coalesce(v_n, 0) > 4 OR v_messy > 0 THEN
    RAISE NOTICE 'SKIPPING the source CHECK — % distinct value(s), % not a plain identifier. Left unconstrained on purpose; decide deliberately rather than encoding this.', coalesce(v_n, 0), v_messy;
  ELSE
    -- the values already present, plus the one Phase 2 will write
    EXECUTE format(
      'ALTER TABLE public.station_presence ADD CONSTRAINT station_presence_source_check CHECK (source = ANY (%L))',
      (SELECT array_agg(DISTINCT v ORDER BY v) FROM unnest(v_vals || ARRAY['gps_geofence']) v));
    RAISE NOTICE 'source CHECK added, covering: %', array_to_string(
      (SELECT array_agg(DISTINCT v ORDER BY v) FROM unnest(v_vals || ARRAY['gps_geofence']) v), ', ');
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 4. Post-conditions — prove nothing was rewritten and nothing is enabled.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_rows int; v_on int; v_depts int;
BEGIN
  SELECT count(*) INTO v_rows  FROM public.station_presence;
  SELECT count(*), count(*) FILTER (WHERE geofence_enabled) INTO v_depts, v_on FROM public.departments;
  RAISE NOTICE 'station_presence: % rows. departments: % total, % geofence-enabled (expect 0).', v_rows, v_depts, v_on;

  IF v_on > 0 THEN
    RAISE EXCEPTION 'Unexpected: % department(s) came out geofence-enabled. The column must default false everywhere.', v_on;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — from the catalog
-- =====================================================================
--
-- -- 1. The toggle: boolean, NOT NULL, default false, nothing enabled.
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='departments' AND column_name='geofence_enabled';
-- SELECT name, geofence_enabled FROM public.departments ORDER BY name;
--
-- -- 2. The index, and that it is UNIQUE + partial with the right predicate.
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE tablename='station_presence'
--    AND indexname='station_presence_one_open_session_per_member';
--
-- -- 3. The precondition, re-run as a query. Expect 0 rows — and it must stay 0,
-- --    since the index now makes it impossible.
-- SELECT member_id, count(*) FROM public.station_presence
--  WHERE checked_out_at IS NULL AND kind IN ('standby','offsite')
--  GROUP BY member_id HAVING count(*) > 1;
--
-- -- 4. Did the source CHECK land, and over what?
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.station_presence'::regclass AND contype='c' ORDER BY conname;
-- SELECT source, count(*) FROM public.station_presence GROUP BY source ORDER BY source;
--
-- -- 5. PROVE THE INDEX BITES. Both statements must FAIL; the ROLLBACK is the
-- --    point, nothing is left behind. Substitute a member who currently has ONE
-- --    open standby row.
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind)
-- --     SELECT department_id, member_id, true, 'gps_geofence', 'standby'
-- --       FROM public.station_presence
-- --      WHERE checked_out_at IS NULL AND kind = 'standby' LIMIT 1;   -- expect: duplicate key
-- --   ROLLBACK;
--
-- -- 6. INERT PROOF — nothing reads the toggle yet (G2/G5 do). Expect no rows.
-- SELECT proname FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND prosrc ILIKE '%geofence_enabled%';
