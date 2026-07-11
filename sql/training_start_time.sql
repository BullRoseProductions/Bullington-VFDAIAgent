-- =====================================================================
-- Training session OPTIONAL start time.
-- Nullable, wall-clock local time-of-day (NOT timestamptz — no timezone work).
-- Display-only: all existing date logic (sessDate, sort-by-day, dedup,
-- range filters) is unchanged; `date` stays a plain date.
-- =====================================================================

ALTER TABLE public.training_sessions
  ADD COLUMN IF NOT EXISTS start_time time;   -- e.g. '19:00'; NULL = no time set

-- =====================================================================
-- VERIFICATION (run separately)
-- =====================================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_name = 'training_sessions' and column_name = 'start_time';
--   -- expect: start_time | time without time zone | YES
