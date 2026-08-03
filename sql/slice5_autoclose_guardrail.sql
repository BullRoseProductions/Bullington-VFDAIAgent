-- =====================================================================
-- SLICE 5 — auto-close safety net for forgotten check-outs ("the 40-hour shift").
--
-- There is no max-shift cap today: an open standby row runs until someone
-- remembers to clock out, so a forgotten punch quietly becomes 40 credited
-- hours. This adds a per-department cap, a job that closes anything past it,
-- and — crucially — makes an auto-closed shift worth ZERO until a human
-- confirms the real out-time. A guardrail that silently invented hours would be
-- worse than the bug.
--
-- THIS FILE DOES NOT SCHEDULE ANYTHING. Applying it alone is safe and inert:
-- the function exists but nothing calls it. The scheduler lives in
-- sql/slice5_autoclose_schedule.sql.
--
-- STATUS (2026-08-03): BOTH FILES ARE APPLIED. pg_cron 1.6.4 was enabled and
-- job 'auto-close-stale-shifts' scheduled '*/20 * * * *', active. The sweep is
-- armed and running — confirmed from cron.job, which is the source of truth.
--
-- VERIFIED LIVE BEFORE WRITING (2026-08-03):
--   • pg_cron NOT installed at the time this file was authored; available
--     1.6.4. Superseded — see STATUS above; it was enabled shortly after.
--   • departments.station_radius_m = integer NOT NULL DEFAULT 150
--     departments.week_start_day  = smallint NOT NULL DEFAULT 1   <- pattern copied
--   • departments has ZERO check constraints today (contype='c' returns nothing),
--     so departments_week_start_day_range from sql/week_start_day.sql is NOT live.
--     Flagged separately; this file does not touch it.
--   • station_presence has 1 open row, oldest 1.0h. kinds in use: standby x11 only.
--   • dept_station_shifts / dept_iso_hours / dept_on_station_now grants are all
--     anon=false, authenticated=true, public=false.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. departments.max_shift_hours — the per-department cap.
--
-- Shape copied from week_start_day: smallint, NOT NULL, sensible DEFAULT, so
-- nothing needs backfilling and every existing row stays valid. Default 10 —
-- long enough that a real duty night never trips it, short enough that a
-- forgotten punch is caught the same night.
--
-- Bounds 1..48 rather than 1..24: some departments genuinely run 24h duty, and a
-- SAFETY NET should be generous. It exists to catch "clearly forgotten", not to
-- enforce policy.
-- ---------------------------------------------------------------------
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS max_shift_hours smallint NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'departments_max_shift_hours_range'
       AND conrelid = 'public.departments'::regclass
  ) THEN
    ALTER TABLE public.departments
      ADD CONSTRAINT departments_max_shift_hours_range
      CHECK (max_shift_hours BETWEEN 1 AND 48);
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2. station_presence.auto_closed — "this stop time was guessed by a machine".
--
-- NOT NULL DEFAULT false, so every existing row is correctly marked as
-- human-closed and nothing needs backfilling.
-- ---------------------------------------------------------------------
ALTER TABLE public.station_presence
  ADD COLUMN IF NOT EXISTS auto_closed boolean NOT NULL DEFAULT false;

-- Serves the job's scan. Partial on open rows only, so it holds a handful of
-- rows at any moment no matter how large the table grows.
CREATE INDEX IF NOT EXISTS station_presence_open_by_checked_in
  ON public.station_presence (checked_in_at)
  WHERE checked_out_at IS NULL;


-- ---------------------------------------------------------------------
-- 3. auto_close_stale_shifts() — the job body.
--
-- Sets checked_out_at = checked_in_at + the department's cap. NOT now(): the
-- credited window must never depend on when the sweeper happened to run, or the
-- same forgotten shift would be worth different amounts depending on cron
-- timing. Deterministic and idempotent.
--
-- COVERS BOTH KINDS, not just standby. An officer who forgets to finalize
-- leaves an open TRAINING row with exactly the same runaway behaviour. See the
-- interaction note below — this is a real trade-off, not an oversight.
--
-- INTERACTION WITH THE FINALIZE TRIGGER (slice 2): trg_close_training_presence_
-- on_done only stamps rows where checked_out_at IS NULL. So if the sweeper gets
-- there first, a later officer finalize will NOT overwrite the guessed stop —
-- the row stays auto_closed and uncredited until reviewed. That is the safe
-- direction (never silently credit), but it does mean auto-close can pre-empt a
-- legitimately late finalize. Fast-follow option: teach that trigger to
-- re-stamp rows where auto_closed, since an officer finalizing IS the human
-- confirmation. Deliberately NOT done here — it changes applied, working code.
--
-- SECURITY DEFINER for the usual reason: station_presence has RLS and no
-- caller has UPDATE across other members' rows. Returns the row count so the
-- scheduler can log it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_close_stale_shifts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer;
begin
  update public.station_presence sp
     set checked_out_at = sp.checked_in_at + make_interval(hours => d.max_shift_hours),
         auto_closed    = true
    from public.departments d
   where d.id = sp.department_id
     and sp.checked_out_at is null
     and now() - sp.checked_in_at > make_interval(hours => d.max_shift_hours);
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$function$;

-- Not a user-facing RPC. pg_cron runs jobs as their owner and needs no grant;
-- the Vercel fallback would need exactly one GRANT (see the schedule file).
REVOKE ALL ON FUNCTION public.auto_close_stale_shifts() FROM public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. dept_station_shifts — expose auto_closed so the report can bucket it.
--
-- DROP + CREATE, not CREATE OR REPLACE: the RETURNS TABLE signature changes, and
-- Postgres will not replace a function whose return type differs. Safe here —
-- there is exactly ONE dept_station_shifts, both statements are in this
-- transaction, and the argument types are unchanged, so no overload can appear.
--
-- The two DEFAULTs are reproduced EXACTLY from the live definition
-- (date_trunc('month', now()) and now()); dropping them would silently change
-- what a no-argument call returns.
--
-- auto_closed is APPENDED as the last column so nothing positional shifts. The
-- client reads by name, but appending costs nothing and removes the question.
--
-- Auto-closed rows are deliberately still RETURNED, not filtered out: a leader
-- has to be able to SEE the bad shift in order to fix it. The exclusion from
-- credited totals happens in the client rollup, exactly where the existing
-- unverified/credited split already lives.
--
-- Everything else is byte-identical to the live body, including the
-- "NEVER incident" comment and the checked_out_at / kind / window filters.
-- ---------------------------------------------------------------------
DROP FUNCTION public.dept_station_shifts(timestamptz, timestamptz);

CREATE FUNCTION public.dept_station_shifts(
  p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()),
  p_to   timestamp with time zone DEFAULT now()
)
 RETURNS TABLE(member_id uuid, member_name text, checked_in_at timestamp with time zone, checked_out_at timestamp with time zone, hours numeric, kind text, verified boolean, auto_closed boolean)
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
    select m.id, m.name, sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours,
           sp.kind, sp.verified, sp.auto_closed
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    where sp.department_id = v_dept
      and sp.checked_out_at is not null
      and sp.kind in ('standby','training')          -- NEVER incident (Before the Call)
      and sp.checked_in_at >= p_from
      and sp.checked_in_at <  p_to
    order by sp.checked_in_at desc;
end;
$function$;

-- DROP discards the ACL, so these must be restated. Values match what was live
-- before this migration: anon=false, authenticated=true, public=false.
REVOKE ALL ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) TO authenticated;


-- ---------------------------------------------------------------------
-- 5. dept_iso_hours — never credit an auto-closed shift.
--
-- CREATE OR REPLACE, same signature, body-only change. TWO changes, both listed
-- so neither slips through unnoticed:
--
--   (a) `and not sp.auto_closed`  — the point of this slice. A machine-guessed
--       stop time must not reach an ISO number a chief reports to an outside
--       body. Zero until a human confirms it.
--
--   (b) `and sp.kind in ('standby','training')`  — a CORRECTION, found during
--       this recon. dept_station_shifts has always excluded 'incident'
--       explicitly; dept_iso_hours folded every non-training kind into standby,
--       so an incident row would have been counted by ISO and dropped by
--       Credited, and the two surfaces would have disagreed for a reason the
--       explainer does not cover. No incident rows exist today (kinds in use:
--       standby x11), so this changes no current number — it closes the gap
--       before it can open. If you want incident credited, it has to change in
--       BOTH functions in one migration.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_iso_hours(
  p_from timestamptz,
  p_to   timestamptz
)
 RETURNS TABLE(
   member_id       uuid,
   member_name     text,
   training_hours  numeric,
   standby_hours   numeric,
   iso_total_hours numeric
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;

  if p_from is null or p_to is null then
    raise exception 'A start and end date are both required.';
  end if;
  if p_from >= p_to then
    raise exception 'The start of the period must come before the end.';
  end if;

  return query
  with clipped as (
    select
      sp.member_id as mid,
      (sp.kind = 'training') as is_training,
      tstzrange(greatest(sp.checked_in_at, p_from),
                least(sp.checked_out_at, p_to), '[)') as span
    from public.station_presence sp
    where sp.department_id   = v_dept
      and sp.verified                          -- verified-only credit
      and sp.checked_out_at is not null        -- closed rows only
      and not sp.auto_closed                   -- (a) machine-guessed stop: never credited
      and sp.kind in ('standby','training')    -- (b) parity with dept_station_shifts
      and sp.checked_in_at  <  p_to            -- overlap test, so a straddling
      and sp.checked_out_at >  p_from          --   shift is clipped, not dropped
  ),
  live as (
    select * from clipped where not isempty(span)
  ),
  agg as (
    select
      c.mid,
      range_agg(c.span) filter (where c.is_training) as training_mr,   -- null if none
      range_agg(c.span)                              as all_mr
    from live c
    group by c.mid
  ),
  secs as (
    select
      a.mid,
      coalesce((select sum(extract(epoch from (upper(r) - lower(r))))
                  from unnest(a.training_mr) r), 0) as training_secs,
      coalesce((select sum(extract(epoch from (upper(r) - lower(r))))
                  from unnest(a.all_mr) r), 0)      as total_secs
    from agg a
  ),
  final as (
    select
      s.mid                                                        as mid,
      m.name                                                       as mname,
      round((s.training_secs / 3600.0)::numeric, 2)                as t_hours,
      round(((s.total_secs - s.training_secs) / 3600.0)::numeric, 2) as s_hours,
      round((s.total_secs / 3600.0)::numeric, 2)                   as tot_hours
    from secs s
    join public.members m on m.id = s.mid
  )
  select f.mid, f.mname, f.t_hours, f.s_hours, f.tot_hours
  from final f
  order by f.tot_hours desc, f.mname;
end;
$function$;

REVOKE ALL ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
-- -- 1. Columns and the new constraint:
-- SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema='public'
--    AND ((table_name='departments' AND column_name='max_shift_hours')
--      OR (table_name='station_presence' AND column_name='auto_closed'));
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.departments'::regclass AND contype='c';
--
-- -- 2. dept_station_shifts: ONE function, 8 output columns, defaults intact,
-- --    anon=false / auth=true.
-- SELECT pg_get_function_identity_arguments(oid) AS args,
--        pg_get_function_result(oid)             AS returns,
--        has_function_privilege('anon', oid, 'EXECUTE')          AS anon_can,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_can
--   FROM pg_proc WHERE proname='dept_station_shifts' AND pronamespace='public'::regnamespace;
--
-- -- 3. DRY RUN — what WOULD be closed, before scheduling anything. Expect 0 rows
-- --    today (1 open shift, ~1h old, cap 10).
-- SELECT sp.id, m.name, sp.kind, sp.checked_in_at,
--        round(extract(epoch FROM (now()-sp.checked_in_at))/3600.0, 1) AS open_hours,
--        d.max_shift_hours,
--        sp.checked_in_at + make_interval(hours => d.max_shift_hours) AS would_close_at
--   FROM public.station_presence sp
--   JOIN public.departments d ON d.id = sp.department_id
--   JOIN public.members m     ON m.id = sp.member_id
--  WHERE sp.checked_out_at IS NULL
--    AND now() - sp.checked_in_at > make_interval(hours => d.max_shift_hours);
--
-- -- 4. Run it once by hand (safe: idempotent, returns the count):
-- SELECT public.auto_close_stale_shifts();
--
-- -- 5. Anything auto-closed and awaiting review:
-- SELECT m.name, sp.kind, sp.checked_in_at, sp.checked_out_at
--   FROM public.station_presence sp JOIN public.members m ON m.id = sp.member_id
--  WHERE sp.auto_closed ORDER BY sp.checked_in_at DESC;
