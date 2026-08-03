-- =====================================================================
-- SLICE 3 — dept_iso_hours(p_from, p_to): the reconciliation function.
--
-- Per member, over [p_from, p_to): training hours, de-overlapped standby hours,
-- and the ISO total. Every minute counted ONCE, training winning any overlap.
--
-- READ-ONLY. Creates one new function. Nothing existing is altered — no changes
-- to dept_station_shifts, station_check_in/out, member_check_in, or any trigger.
--
-- WHY THE UNION RATHER THAN A SUBTRACTION PER ROW: a member can hold several
-- standby rows and several training rows in one window, in any arrangement.
-- Pairwise subtraction gets the arithmetic wrong the moment two standby rows
-- both touch the same training. range_agg builds the true union of intervals
-- once, so overlaps collapse regardless of how many rows are involved and in
-- what order they arrive.
--
-- THE IDENTITY THIS GUARANTEES:
--     iso_total_hours = training_hours + standby_hours,   exactly, always.
-- standby_hours is DERIVED as (union - training), never summed directly, which
-- is what makes double-counting structurally impossible rather than merely
-- unlikely.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Version guard — range_agg and multiranges are Postgres 14+.
--
-- Ashlea asked to be told if the server is older so we could fall back to a
-- sweep-line implementation. I cannot reach the live database from this
-- environment, so the check is done HERE instead: on an older server this
-- migration refuses to install rather than silently creating a broken function.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION
      'dept_iso_hours needs PostgreSQL 14+ for range_agg/multiranges; this server is %. Stop and ask for the sweep-line fallback.',
      current_setting('server_version');
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 1. dept_iso_hours(p_from, p_to)
--
-- ROWS CONSIDERED — verified, closed, in-window:
--   verified = true            unverified time is recorded but NEVER credited;
--                              this mirrors the Station Hours report's rule
--                              exactly (src/App.jsx:6507).
--   checked_out_at IS NOT NULL an open row has no duration yet. It is not zero
--                              hours, it is UNKNOWN hours — counting it as zero
--                              would quietly understate a member still on shift.
--   overlap, not containment   checked_in_at < p_to AND checked_out_at > p_from.
--                              A shift that straddles a month boundary belongs
--                              PARTLY to each month; the clip below splits it.
--
-- CLIPPING: tstzrange(greatest(checked_in_at, p_from), least(checked_out_at, p_to), '[)').
-- Half-open '[)' is deliberate — two shifts that touch (…18:00 / 18:00…) union
-- into one continuous block with no double-counted boundary instant.
-- isempty() drops anything that clips to nothing (a shift ending exactly at
-- p_from), which also keeps range_agg from choking on degenerate input.
--
-- TRAINING WINS: training_mr is the union of training only; all_mr is the union
-- of everything. standby = all_mr - training_mr by construction, so a minute
-- that is both standby and training is credited to training and removed from
-- standby. It can never be credited twice, and never dropped entirely.
--
-- KIND HANDLING: training is kind='training'; STANDBY IS "EVERYTHING ELSE".
-- That is not sloppiness — it is deliberate parity with the report, which does
-- `else m.standby` (src/App.jsx:6509). If an 'incident' row ever gets written,
-- both surfaces will fold it into standby and keep agreeing with each other. If
-- incident should become its own credited category, change it in BOTH places in
-- the same migration.
--
-- UNIT: decimal hours, numeric, 2dp — the same unit dept_station_shifts returns
-- in its `hours` field, which the report renders with h1() at 1dp
-- (src/App.jsx:6526). 2dp here so a report rounding to 1dp is never rounding
-- something already rounded.
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

-- House rule: Postgres default-grants EXECUTE to PUBLIC on every new function.
REVOKE ALL ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
-- -- 1. Exactly one dept_iso_hours, two timestamptz args:
-- SELECT proname, pg_get_function_identity_arguments(oid), prosecdef, provolatile, proconfig
--   FROM pg_proc WHERE proname = 'dept_iso_hours' AND pronamespace = 'public'::regnamespace;
--
-- -- 2. anon locked out, authenticated allowed:
-- SELECT has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p WHERE p.proname = 'dept_iso_hours' AND p.pronamespace = 'public'::regnamespace;
--
-- -- 3. The math, on synthetic data, with no writes:
-- --    run sql/slice3_dept_iso_hours_selftest.sql
--
-- -- 4. Against live data (year to date). Expect the identity to hold on EVERY
-- --    row: training_hours + standby_hours = iso_total_hours.
-- SELECT *, (training_hours + standby_hours = iso_total_hours) AS identity_holds
--   FROM public.dept_iso_hours('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
--
-- -- 5. Reconcile against the Station Hours report for the same window. iso_total
-- --    should be <= the report's Credited column, and BELOW it by exactly the
-- --    overlap that the report double-counts today.
-- SELECT s.member_name,
--        sum(s.hours) FILTER (WHERE s.kind =  'training') AS report_training,
--        sum(s.hours) FILTER (WHERE s.kind <> 'training') AS report_standby,
--        sum(s.hours)                                     AS report_credited
--   FROM public.dept_station_shifts('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z') s
--  WHERE s.verified
--  GROUP BY s.member_name
--  ORDER BY report_credited DESC;
