-- =====================================================================
-- dept_iso_hours_by_month — credited station hours + shift counts for MANY
-- windows in ONE round-trip. NOT YET APPLIED.
--
-- Only pg_proc says whether this is live, never git:
--   select proname from pg_proc where proname = 'dept_iso_hours_by_month';
--
-- WHY. StationHoursBars draws one bar per month and today makes two RPCs per
-- month (dept_station_shifts + dept_iso_hours) — 12 calls on a dashboard, up to
-- 24 on the stats page. One call over the whole range cannot be split by month
-- afterwards: dept_iso_hours returns one de-overlapped total PER MEMBER for the
-- window, with no timestamps, and regrouping raw shift rows in JS would
-- re-introduce the standby/training double count shared/station-hours.js exists
-- to prevent (and would bucket month-straddling shifts by their start).
--
-- HOW — A WRAPPER, NOT A SECOND IMPLEMENTATION. For each window it calls the
-- existing dept_iso_hours(start, end) and dept_station_shifts(start, end), and
-- returns the same two numbers the client already derives from them:
--   credited = sum(iso_total_hours)   (= mergeStationHours totals.credited)
--   shifts   = count(*) of shift rows (= rollupStationHours totals.shifts)
-- So the de-overlap, the clipping, the training-wins rule, the auto-closed rule
-- and the department scoping all stay in exactly one place. If either function
-- changes, this follows automatically. Identical numbers by construction.
--
-- THE CLIENT PASSES THE WINDOWS (two parallel arrays of starts and ends) instead
-- of letting SQL compute month boundaries, because the client's months are
-- LOCAL-time months (midnight in the user's zone), and date_trunc here would use
-- the server's zone (UTC). Same boundaries as today's per-month calls → same
-- numbers. Capped at 24 windows.
--
-- SECURITY INVOKER, deliberately. It runs as the caller, so the inner
-- functions' own is_leadership() gate and my_department_id() scoping apply
-- unchanged — this adds no privilege and can't widen anything. EXECUTE is
-- still revoked from anon/public per the sweep pattern.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — both inner functions must exist with the expected args.
-- ---------------------------------------------------------------------
do $pre$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'dept_iso_hours'
                  and pg_get_function_identity_arguments(oid) = 'p_from timestamp with time zone, p_to timestamp with time zone') then
    raise exception 'Precondition failed: dept_iso_hours(p_from timestamptz, p_to timestamptz) not found.';
  end if;
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'dept_station_shifts'
                  and pg_get_function_identity_arguments(oid) = 'p_from timestamp with time zone, p_to timestamp with time zone') then
    raise exception 'Precondition failed: dept_station_shifts(p_from timestamptz, p_to timestamptz) not found.';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------
-- 1. THE WRAPPER.
-- ---------------------------------------------------------------------
create or replace function public.dept_iso_hours_by_month(p_starts timestamptz[], p_ends timestamptz[])
 returns table(idx integer, credited numeric, shifts integer)
 language plpgsql
 stable
 security invoker
 set search_path to 'public'
as $function$
declare
  n integer := coalesce(array_length(p_starts, 1), 0);
begin
  if n <> coalesce(array_length(p_ends, 1), 0) then
    raise exception 'Starts and ends must be the same length.';
  end if;
  if n > 24 then
    raise exception 'At most 24 windows per call.';
  end if;
  -- idx is 1-based, matching the input arrays. Every window gets a row, even an
  -- empty one (credited 0, shifts 0), so the client never mistakes a missing row
  -- for a failed read.
  return query
  select i,
         coalesce((select sum(h.iso_total_hours) from public.dept_iso_hours(p_starts[i], p_ends[i]) h), 0)::numeric,
         (select count(*) from public.dept_station_shifts(p_starts[i], p_ends[i]))::integer
    from generate_series(1, n) as i
   order by i;
end;
$function$;

revoke all    on function public.dept_iso_hours_by_month(timestamptz[], timestamptz[]) from anon, public;
grant execute on function public.dept_iso_hours_by_month(timestamptz[], timestamptz[]) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. POST-CONDITIONS — in-transaction, so a hole rolls itself back.
-- ---------------------------------------------------------------------
do $post$
begin
  if has_function_privilege('anon', 'public.dept_iso_hours_by_month(timestamptz[], timestamptz[])', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE dept_iso_hours_by_month. Rolling back.';
  end if;
  if not has_function_privilege('authenticated', 'public.dept_iso_hours_by_month(timestamptz[], timestamptz[])', 'EXECUTE') then
    raise exception 'Post-condition failed: authenticated cannot execute dept_iso_hours_by_month.';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
              and proname = 'dept_iso_hours_by_month' and prosecdef) then
    raise exception 'Post-condition failed: dept_iso_hours_by_month must be SECURITY INVOKER.';
  end if;
end
$post$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- VERIFY (run separately; see sql/dept_iso_hours_by_month_verify.sql).
-- A bare call from the SQL editor raises 'Not authorized' — the editor has no
-- JWT, so the inner is_leadership() is false. That is the gate working.
-- =====================================================================
