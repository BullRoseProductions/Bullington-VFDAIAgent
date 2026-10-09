-- ROLLBACK for sql/dept_iso_hours_by_month.sql. The wrapper owns no data and
-- nothing else depends on it in SQL; dropping it only matters once the client
-- calls it (StationHoursBars) — roll the client back first, or it will fall
-- back to per-month calls if built with that fallback.
begin;
drop function if exists public.dept_iso_hours_by_month(timestamptz[], timestamptz[]);
notify pgrst, 'reload schema';
commit;
