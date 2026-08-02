-- =====================================================================
-- departments.week_start_day — which weekday a department's week begins on.
--
-- WHY: the Station Duties week boundary (recurring-duty rollover, the current-week
-- "other work" list, and the weekly history buckets) was per-TAB React state
-- defaulting to Monday. It reset on every reload and two people could bucket the
-- same completion into different weeks. Persisting it per department makes every
-- device and user agree.
--
-- Shape deliberately mirrors station_radius_m: department-level, NOT NULL with a
-- sensible default, so nothing needs backfilling and existing rows stay valid.
-- 0 = Sunday … 6 = Saturday (matches JS Date.getDay(), which the client uses).
-- Default 1 = Monday, the value the UI has always assumed.
--
-- Additive and idempotent: safe to re-run, no data loss, no downtime. The client
-- reads this column defensively (falls back to 1 on any error), so the app works
-- both before and after this migration is applied.
-- =====================================================================

ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS week_start_day smallint NOT NULL DEFAULT 1;

-- Separate statement so re-running doesn't error if the constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'departments_week_start_day_range'
      AND conrelid = 'public.departments'::regclass
  ) THEN
    ALTER TABLE public.departments
      ADD CONSTRAINT departments_week_start_day_range
      CHECK (week_start_day BETWEEN 0 AND 6);
  END IF;
END $$;

-- No RLS change: departments already has its policies, and this column rides on
-- the existing row-level SELECT/UPDATE rules (update stays Department Admin only).

NOTIFY pgrst, 'reload schema';

-- ---- VERIFY ----
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='departments' AND column_name='week_start_day';
-- SELECT id, name, week_start_day FROM public.departments;
