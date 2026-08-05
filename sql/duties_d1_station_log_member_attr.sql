-- =====================================================================
-- STATION DUTIES D1 — member attribution on "other work". SCHEMA ONLY, INERT.
--
-- One nullable column and one FK. Nothing writes it until D3, nothing reads it
-- until D3/D4/D5. Applying this changes no screen and no number.
--
-- WHY. station_log.done_by is FREE TEXT — a typed name, not a member id. It is
-- the only attribution "other work" has, which makes per-member rollups
-- unreliable: two spellings of the same person are two people, and nothing can
-- be joined to members. done_by_member_id adds the reliable key WITHOUT
-- removing the text, because the text is genuinely needed — a visitor, a
-- spouse, a mutual-aid crew, anyone who has no member record.
--
-- The rule everywhere downstream: use the uuid when present, else the text.
--
-- CONFIRMED: THE COMPUTED RESET NEEDS NO NEW COLUMN.
-- duties.done_at timestamptz already exists (catalog-verified 2026-08-05), and
-- the period is derived from done_at + recurrence + departments.week_start_day,
-- all of which are present. D2 adds no schema at all.
--
-- ON DELETE SET NULL, matching station_presence.approved_by: removing a member
-- must not block, and must not delete the log entry. Attribution degrades to
-- the free-text name, which is exactly what that column is for.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The column.
--
-- Nullable with no default on purpose. NULL means "no member was picked",
-- which is a real and permanent state for the 28 existing rows and for any
-- future entry naming someone who is not a member.
-- ---------------------------------------------------------------------
ALTER TABLE public.station_log
  ADD COLUMN IF NOT EXISTS done_by_member_id uuid;

-- FK added separately so a re-run cannot error on an already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'station_log_done_by_member_id_fkey'
       AND conrelid = 'public.station_log'::regclass
  ) THEN
    ALTER TABLE public.station_log
      ADD CONSTRAINT station_log_done_by_member_id_fkey
      FOREIGN KEY (done_by_member_id) REFERENCES public.members(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Deliberately NO index. 28 rows; a per-member rollup scans them faster than it
-- would descend an index. Revisit if station_log grows past a few thousand.
--
-- Deliberately NO "at least one of done_by / done_by_member_id" CHECK. done_by
-- is already nullable and I have not verified that every existing row has one,
-- so such a constraint could fail on live data for no benefit today.


-- ---------------------------------------------------------------------
-- 2. Diagnostic for D2 — NOT a precondition, does not abort.
--
-- D2's predicate is:
--   done AND (recurrence = 'One-off' OR (done_at IS NOT NULL AND in period))
--
-- It gates on `done` first so a legacy row with done=true and done_at=null
-- behaves safely in both directions: a One-off stays done, a recurring duty
-- reads as due. This reports how many such rows exist so D2 is written against
-- the real data rather than an assumption.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_skew  int;
  v_total int;
  v_recur text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE done AND done_at IS NULL)
    INTO v_total, v_skew FROM public.duties;
  SELECT coalesce(string_agg(DISTINCT coalesce(recurrence,'(null)'), ', '), '(none)')
    INTO v_recur FROM public.duties;

  RAISE NOTICE 'duties: % rows, % with done=true but done_at IS NULL, recurrences in use: %',
    v_total, v_skew, v_recur;

  IF v_skew > 0 THEN
    RAISE NOTICE 'NOTE for D2: those % row(s) will read as DUE if recurring, and stay DONE if One-off. That is the intended safe direction.', v_skew;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 3. Post-condition — prove nothing was rewritten.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_rows int;
  v_set  int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE done_by_member_id IS NOT NULL)
    INTO v_rows, v_set FROM public.station_log;

  RAISE NOTICE 'station_log: % rows, % with done_by_member_id set (expect 0)', v_rows, v_set;

  IF v_set > 0 THEN
    RAISE EXCEPTION 'Unexpected: % station_log row(s) already carry done_by_member_id. Nothing should write it until D3 — stop and inspect.', v_set;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — from the catalog
-- =====================================================================
--
-- -- 1. The column: uuid, nullable, no default.
-- SELECT column_name, data_type, is_nullable, coalesce(column_default,'-') AS default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='station_log' AND column_name='done_by_member_id';
-- -- expect: uuid | YES | -
--
-- -- 2. The FK points at members(id) and is ON DELETE SET NULL.
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid='public.station_log'::regclass
--    AND conname='station_log_done_by_member_id_fkey';
--
-- -- 3. Nothing populated it, and the row count is unchanged. Expect 28 / 0.
-- SELECT count(*) AS rows,
--        count(*) FILTER (WHERE done_by_member_id IS NOT NULL) AS attributed
--   FROM public.station_log;
--
-- -- 4. CONFIRM D2 NEEDS NO SCHEMA: everything the computed reset reads already
-- --    exists. Expect three rows on duties, and one on departments.
-- SELECT table_name, column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema='public'
--    AND ((table_name='duties'      AND column_name IN ('done','done_at','recurrence'))
--      OR (table_name='departments' AND column_name='week_start_day'))
--  ORDER BY table_name, column_name;
--
-- -- 5. The D2 diagnostic, as a query. Expect 0 skew today; whatever it says,
-- --    D2 is written to handle it.
-- SELECT count(*) AS duties_total,
--        count(*) FILTER (WHERE done AND done_at IS NULL) AS done_without_timestamp,
--        string_agg(DISTINCT coalesce(recurrence,'(null)'), ', ') AS recurrences_in_use
--   FROM public.duties;
--
-- -- 6. INERT PROOF — nothing reads the new column yet. Expect no rows.
-- SELECT proname FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND prosrc ILIKE '%done_by_member_id%';
--
-- -- 7. For D2's audit: does ANYTHING server-side read duties.done? If a
-- --    function or trigger does, the computed model would have a second source
-- --    of truth and D2's plan changes. Expect only complete_duty/uncomplete_duty
-- --    (which WRITE it), and nothing that branches on it.
-- SELECT proname, prosrc ILIKE '%duties%' AS touches_duties
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND prosrc ILIKE '%duties%'
--  ORDER BY proname;
