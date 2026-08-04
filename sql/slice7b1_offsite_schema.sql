-- =====================================================================
-- SLICE 7B-1 — off-site check-in: SCHEMA ONLY.
--
-- INERT BY CONSTRUCTION. Four nullable columns and one widened CHECK. Nothing
-- writes kind='offsite' yet, no RPC changes, no trigger changes, no client
-- changes. Applying this changes no number on any screen.
--
-- It lands the shape BEFORE anything can create a row that needs it — the same
-- discipline as slice 0, so there is never a window where an off-site row
-- exists without somewhere to record approval.
--
-- DESIGN (locked with the owner):
--   • ONE LEDGER. Off-site presence lives in station_presence. No separate
--     offsite_activities table.
--   • kind='offsite' exists to mark which rows NEED OFFICER APPROVAL. For hours
--     math and member-facing labels these rows roll into the TRAINING tier —
--     they are not a fourth category in the report.
--   • An off-site row does NOT count toward ISO hours until approved_at is set.
--   • Location denial does NOT block check-in. location_confirmed records
--     whether a fix was obtained, so the officer can judge rather than the
--     system silently refusing.
--
-- SOURCE OF TRUTH: the constraint name below is looked up from pg_constraint at
-- run time, NOT hard-coded and NOT taken from a migration file. If the live
-- name ever differs from what any repo file claims, this still does the right
-- thing — or refuses loudly.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The four new columns. All nullable, no defaults, no backfill.
--
--   offsite_label       what the work was ("Memorial Day parade"). NULL on
--                       every non-offsite row.
--   location_confirmed  TRUE  = a GPS fix was captured at check-in
--                       FALSE = the member allowed the check-in without one
--                       NULL  = not an off-site row / question does not apply.
--                       Three states on purpose: "denied" and "not applicable"
--                       are different facts, and an officer approving a claim
--                       needs to tell them apart.
--   approved_at         NULL = pending. The single gate on credit.
--   approved_by         who approved it. Audit, not decoration.
-- ---------------------------------------------------------------------
ALTER TABLE public.station_presence
  ADD COLUMN IF NOT EXISTS offsite_label      text,
  ADD COLUMN IF NOT EXISTS location_confirmed boolean,
  ADD COLUMN IF NOT EXISTS approved_at        timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by        uuid;

-- FK added separately so a re-run cannot error on an already-present constraint.
-- ON DELETE SET NULL: removing a member must not block, and must not delete the
-- approval itself — the hours stay approved, only the approver's identity is
-- lost. Same trade-off session_id already makes, and worth knowing about.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'station_presence_approved_by_fkey'
       AND conrelid = 'public.station_presence'::regclass
  ) THEN
    ALTER TABLE public.station_presence
      ADD CONSTRAINT station_presence_approved_by_fkey
      FOREIGN KEY (approved_by) REFERENCES public.members(id) ON DELETE SET NULL;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2. Widen the kind CHECK to allow 'offsite'.
--
-- The constraint NAME is discovered from pg_constraint, not assumed. It is
-- located precisely: contype='c' AND conkey is exactly the `kind` column's
-- attnum — so a differently-named or multi-column CHECK cannot be hit by
-- accident. The replacement re-uses the SAME name, so nothing drifts.
--
-- 'offsite' is APPENDED. The existing three keep their order and spelling.
--
-- Three refusals rather than guesses:
--   • no such constraint      -> raise, do not silently leave kind unconstrained
--   • more than one candidate -> raise, do not pick one at random
--   • already allows offsite  -> no-op, so the file is safe to re-run
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_attnum smallint;
  v_count  int;
  v_name   text;
  v_def    text;
BEGIN
  SELECT attnum INTO v_attnum
    FROM pg_attribute
   WHERE attrelid = 'public.station_presence'::regclass
     AND attname  = 'kind' AND NOT attisdropped;
  IF v_attnum IS NULL THEN
    RAISE EXCEPTION 'station_presence has no `kind` column — stop and inspect.';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_constraint
   WHERE conrelid = 'public.station_presence'::regclass
     AND contype  = 'c'
     AND conkey   = ARRAY[v_attnum];

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No single-column CHECK constraint on station_presence.kind found — stop and inspect before proceeding.';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'Found % CHECK constraints on station_presence.kind — ambiguous, refusing to guess. Inspect pg_constraint.', v_count;
  END IF;

  SELECT conname, pg_get_constraintdef(oid) INTO v_name, v_def
    FROM pg_constraint
   WHERE conrelid = 'public.station_presence'::regclass
     AND contype  = 'c'
     AND conkey   = ARRAY[v_attnum];

  IF v_def ILIKE '%offsite%' THEN
    RAISE NOTICE 'kind CHECK "%" already allows offsite — leaving unchanged. (%)', v_name, v_def;
  ELSE
    RAISE NOTICE 'Replacing kind CHECK "%": %', v_name, v_def;
    EXECUTE format('ALTER TABLE public.station_presence DROP CONSTRAINT %I', v_name);
    EXECUTE format(
      'ALTER TABLE public.station_presence ADD CONSTRAINT %I CHECK (kind = ANY (ARRAY[%L::text, %L::text, %L::text, %L::text]))',
      v_name, 'training', 'standby', 'incident', 'offsite');
    RAISE NOTICE 'kind CHECK "%" now allows training, standby, incident, offsite.', v_name;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 3. Belt-and-braces: assert nothing was rewritten.
--
-- A column add and a CHECK swap cannot touch rows. This proves it rather than
-- asserting it — if the totals moved, the whole transaction rolls back.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_total int;
  v_kinds text;
BEGIN
  SELECT count(*) INTO v_total FROM public.station_presence;
  SELECT coalesce(string_agg(k || '=' || c::text, ', ' ORDER BY k), '(no rows)')
    INTO v_kinds
    FROM (SELECT kind AS k, count(*) AS c FROM public.station_presence GROUP BY kind) s;
  RAISE NOTICE 'station_presence after migration: % rows — %', v_total, v_kinds;

  IF EXISTS (SELECT 1 FROM public.station_presence WHERE kind = 'offsite') THEN
    RAISE EXCEPTION 'Unexpected: an offsite row already exists. Nothing should write offsite yet — stop and inspect.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.station_presence
              WHERE offsite_label IS NOT NULL OR location_confirmed IS NOT NULL
                 OR approved_at IS NOT NULL   OR approved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'Unexpected: a new column is already populated on an existing row — stop and inspect.';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after — and run check 3 BEFORE as well, to compare)
-- =====================================================================
--
-- -- 1. The four new columns exist, all nullable, no defaults:
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'station_presence'
--    AND column_name IN ('offsite_label','location_confirmed','approved_at','approved_by')
--  ORDER BY column_name;
-- -- expect 4 rows, is_nullable = YES, column_default = NULL on all four.
--
-- -- 1b. The approved_by FK points at members(id):
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.station_presence'::regclass
--    AND conname  = 'station_presence_approved_by_fkey';
--
-- -- 2. The CHECK now accepts 'offsite' — read the real definition, do not
-- --    infer it from this file:
-- SELECT conname, pg_get_constraintdef(oid) AS definition
--   FROM pg_constraint
--  WHERE conrelid = 'public.station_presence'::regclass AND contype = 'c'
--  ORDER BY conname;
-- -- expect the kind CHECK to list training, standby, incident, offsite.
--
-- -- 2b. Prove it accepts 'offsite' AND still rejects nonsense, WITHOUT
-- --     leaving anything behind (the ROLLBACK is the point):
-- --   BEGIN;
-- --     UPDATE public.station_presence SET kind = 'offsite'
-- --      WHERE id = (SELECT id FROM public.station_presence LIMIT 1);   -- must succeed
-- --     UPDATE public.station_presence SET kind = 'nonsense'
-- --      WHERE id = (SELECT id FROM public.station_presence LIMIT 1);   -- must FAIL
-- --   ROLLBACK;
--
-- -- 3. Row counts by kind are UNCHANGED. Run this BEFORE applying, keep the
-- --    output, run it again after, and compare line for line.
-- SELECT kind, count(*) AS rows,
--        count(*) FILTER (WHERE checked_out_at IS NULL) AS still_open
--   FROM public.station_presence
--  GROUP BY kind
--  ORDER BY kind;
-- SELECT count(*) AS total_rows FROM public.station_presence;
--
-- -- 4. Nothing populated the new columns (expect 0 on every count):
-- SELECT count(*) FILTER (WHERE offsite_label      IS NOT NULL) AS labelled,
--        count(*) FILTER (WHERE location_confirmed IS NOT NULL) AS loc_flagged,
--        count(*) FILTER (WHERE approved_at        IS NOT NULL) AS approved,
--        count(*) FILTER (WHERE kind = 'offsite')               AS offsite_rows
--   FROM public.station_presence;
