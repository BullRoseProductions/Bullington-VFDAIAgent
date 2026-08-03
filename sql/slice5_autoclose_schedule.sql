-- =====================================================================
-- SLICE 5 (scheduler) — arms the auto-close safety net.
--
-- *** ALREADY APPLIED TO PRODUCTION. ARMED AND RUNNING. ***
--
-- This file is the REPO RECORD of what is already live, not a pending change.
-- pg_cron was enabled and the job scheduled by hand in Supabase; this file was
-- written afterwards so the repo matches the database. Do not treat it as work
-- to be done. Re-running it is harmless (both statements are idempotent — see
-- the note on cron.schedule below) but unnecessary.
--
-- Requires sql/slice5_autoclose_guardrail.sql, which creates the function this
-- job calls. That is also applied.
--
-- CONFIRMED LIVE FROM cron.job (2026-08-03), which is the source of truth here —
-- not this file, and not git:
--   pg_cron  1.6.4
--   jobid    1
--   jobname  auto-close-stale-shifts
--   schedule */20 * * * *
--   command  SELECT public.auto_close_stale_shifts();
--   active   true
--   username postgres
--
-- WHY pg_cron RATHER THAN A VERCEL CRON: the work never leaves the database, so
-- an HTTP endpoint would add a public surface and a shared secret for nothing.
-- pg_cron runs the job as its owner (postgres), which is also why
-- auto_close_stale_shifts() can stay REVOKEd from anon AND authenticated —
-- no client role can reach it, and none needs to.
--
-- EVERY 20 MINUTES is a deliberate over-sample. The job is idempotent and
-- stamps checked_out_at = checked_in_at + cap rather than now(), so the result
-- does not depend on when it runs; a tight interval only shortens how long a
-- runaway shift sits visibly wrong on the report. It costs one indexed scan of
-- open rows (station_presence_open_by_checked_in), which holds a handful of
-- rows at any moment.
-- =====================================================================

-- 1. The extension. Enabled on this project; IF NOT EXISTS makes the record
--    re-runnable. On Supabase this is normally done from Database → Extensions,
--    which is what happened here.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. The job. cron.schedule() UPSERTS on jobname — scheduling the same name
--    again REPLACES the existing job rather than creating a duplicate, so this
--    is safe to re-run and is also how you would change the interval.
SELECT cron.schedule(
  'auto-close-stale-shifts',
  '*/20 * * * *',
  $$SELECT public.auto_close_stale_shifts();$$
);


-- =====================================================================
-- OPERATING IT
-- =====================================================================
-- -- Is it armed? (the check that matters — never infer this from the repo)
-- SELECT jobid, jobname, schedule, command, active, username, database
--   FROM cron.job WHERE jobname = 'auto-close-stale-shifts';
--
-- -- Did it actually run, and did it succeed? return_message carries any error.
-- SELECT status, return_message, start_time, end_time
--   FROM cron.job_run_details
--  WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='auto-close-stale-shifts')
--  ORDER BY start_time DESC LIMIT 20;
--
-- -- What has it closed? These are the shifts awaiting human review; they are
-- -- credited ZERO until someone confirms the real out-time.
-- SELECT m.name, sp.kind, sp.checked_in_at, sp.checked_out_at, d.max_shift_hours
--   FROM public.station_presence sp
--   JOIN public.members m     ON m.id = sp.member_id
--   JOIN public.departments d ON d.id = sp.department_id
--  WHERE sp.auto_closed
--  ORDER BY sp.checked_in_at DESC;
--
-- -- Pause without deleting (e.g. while investigating a bad cap):
-- UPDATE cron.job SET active = false WHERE jobname = 'auto-close-stale-shifts';
-- UPDATE cron.job SET active = true  WHERE jobname = 'auto-close-stale-shifts';
--
-- -- Change the interval — same call, jobname upserts:
-- SELECT cron.schedule('auto-close-stale-shifts', '*/30 * * * *',
--                      $$SELECT public.auto_close_stale_shifts();$$);
--
-- -- Remove entirely:
-- SELECT cron.unschedule('auto-close-stale-shifts');
--
-- -- Adjust a department's cap (the job reads it per-department on every run,
-- -- so a change takes effect at the next tick — no redeploy, no reschedule):
-- UPDATE public.departments SET max_shift_hours = 12 WHERE id = '<dept-uuid>';
