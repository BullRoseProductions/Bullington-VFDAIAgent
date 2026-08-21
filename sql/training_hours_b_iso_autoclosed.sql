-- #####################################################################
-- ##                                                                 ##
-- ##   DO NOT APPLY — SUPERSEDED. RUNNING THIS WOULD REGRESS PROD.   ##
-- ##                                                                 ##
-- #####################################################################
--
-- KEPT AS A RECORD ONLY. Do not run it against any environment.
--
-- WHAT WAS WRONG WITH IT. This file was written by patching
-- sql/slice3_dept_iso_hours.sql — the ORIGINAL definition of dept_iso_hours —
-- and the live function has moved on since. Production already:
--
--   • excludes auto_closed shifts (the fix this file exists to make: the live
--     function beat it to it), and
--   • filters `kind`, added later by slice5, which this file's body does NOT
--     contain because slice3 predates it.
--
-- So applying this would not add the auto_closed rule — it is already there —
-- it would REPLACE the live function with an older shape and STRIP THE KIND
-- FILTER, silently pulling non-training/standby rows back into the ISO figure.
-- A migration whose whole purpose was to make ISO stricter would have made it
-- looser, on the number reported for ISO/LOSAP.
--
-- HOW THIS HAPPENED, so the next one is caught earlier. Migrations here are
-- applied by hand, so a file in sql/ records what was written, never what is
-- live. The database is the source of truth. This file's own header told the
-- reader to diff pg_get_functiondef first, and doing exactly that is what
-- caught it before it ran. Do that every time a CREATE OR REPLACE rebuilds a
-- function body from a file:
--
--   SELECT pg_get_functiondef('public.dept_iso_hours(timestamptz,timestamptz)'::regprocedure);
--
-- THE SAME HAZARD APPLIES TO PART A. training_hours_a_attendance_union.sql
-- DROPs and recreates dept_station_shifts from the slice5 body plus the UNION.
-- If that function has drifted the way this one did, Part A drops the drift
-- with it. Diff it against pg_get_functiondef before running Part A.
--
-- Nothing below this banner should be executed. It is retained so the reasoning
-- and the intended change survive, not because the change is still wanted.
-- #####################################################################


-- =====================================================================
-- TRAINING HOURS, PART B — ISO must not count auto-closed shifts.
--
-- NOT YET APPLIED. Deliberately SEPARATE from Part A: this fixes a pre-existing
-- bug unrelated to attendance hours, and it should be reviewable — and
-- revertible — on its own.
--
-- THE BUG. dept_iso_hours filtered `and sp.verified` but said nothing about
-- auto_closed. Everywhere else, an auto-closed shift is excluded from credit even
-- when the check-in was properly geo-verified, because the STOP time was estimated
-- by the sweeper rather than observed — the duration is not evidence until an
-- officer confirms it. The Station Hours screen, both PDFs and the shared rollup
-- all apply that rule. This function did not, so a verified auto-closed shift
-- counted toward ISO while being excluded from Credited: two numbers on one
-- screen, describing the same hours, applying different rules.
--
-- EXPECT ISO TO MOVE DOWN slightly wherever auto-closed shifts exist. That is the
-- correction. Those hours were never creditable.
--
-- ONE LINE CHANGES. The body below is otherwise the live definition verbatim —
-- the clipping, the range_agg de-overlap and the training-wins cascade are
-- untouched.
--
-- BEFORE YOU RUN IT: migrations here are applied by hand, so the file may lag the
-- database. Diff the live definition first and make sure the only difference is
-- the added line:
--   SELECT pg_get_functiondef('public.dept_iso_hours(timestamptz,timestamptz)'::regprocedure);
-- =====================================================================

BEGIN;

-- A GUARD, not a formality. The banner above asks; this refuses.
-- Someone in a hurry select-alls a file in sql/ and runs it — that is exactly how this
-- would have shipped, and the damage (a silently looser ISO/LOSAP figure) is the kind
-- nobody notices for months. Raising inside the transaction aborts before the
-- CREATE OR REPLACE below can touch anything, so an accidental run changes nothing.
-- Delete this block only if you have diffed pg_get_functiondef and decided the body
-- below is genuinely what production should have.
DO $guard$
BEGIN
  RAISE EXCEPTION
    'SUPERSEDED MIGRATION — not applied. The live dept_iso_hours already excludes auto_closed AND filters kind (slice5); this file was patched from the older slice3 body, so applying it would STRIP the kind filter and loosen the ISO figure. Nothing was changed.';
END
$guard$;

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
  -- Same gate and same message as dept_on_station_now / dept_station_shifts.
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;

  -- Explicit, rather than silently returning zero rows: with a null bound the
  -- overlap test below evaluates to null for every row, and "no hours" is the
  -- one answer this function must never give by accident.
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
      and not sp.auto_closed                   -- PART B: a GUESSED stop time is not evidence.
                                               --   Every other surface already excludes auto-closed
                                               --   shifts from credit; without this line ISO counted
                                               --   hours that Credited refuses, and the two numbers
                                               --   on the same screen disagreed for no visible reason.
      and sp.checked_out_at is not null        -- closed rows only
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
  order by f.tot_hours desc, f.mname;   -- ranked by credited time, ties by name
end;
$function$;

REVOKE ALL ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- VERIFY (run after) — the size of the correction, in one query.
-- Expect iso_after <= iso_before, and the gap to equal the verified
-- auto-closed hours that should never have counted.
-- =====================================================================
-- SELECT
--   count(*) FILTER (WHERE verified AND auto_closed)                       AS verified_autoclosed_rows,
--   round(sum(extract(epoch FROM (checked_out_at - checked_in_at))/3600.0)
--         FILTER (WHERE verified AND auto_closed)::numeric, 2)             AS hours_removed_from_iso
-- FROM public.station_presence
-- WHERE department_id = public.my_department_id()
--   AND checked_out_at IS NOT NULL
--   AND kind IN ('training','standby');
