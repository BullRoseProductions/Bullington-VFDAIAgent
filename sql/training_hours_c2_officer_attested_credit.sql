-- =====================================================================
-- OFFICER-ATTESTED CREDIT, C2 — the two rewrites.
--
-- NOT YET APPLIED. Requires C1 (attested_training) to be applied first.
--
-- Both bodies below are the LIVE definitions from pg_get_functiondef, edited in
-- place. They are NOT reconstructions from sql/ — the repo files lag the
-- database, and rebuilding dept_iso_hours from slice3 is exactly what produced
-- the superseded Part B, which would have stripped the kind filter off a live
-- function and made the ISO figure looser while claiming to tighten it.
--
-- WHAT CHANGES
--   dept_station_shifts  branch A gains officer_attested = false.
--                        branch B stops deriving inline and selects from
--                        attested_training instead: hours become the CAPPED
--                        interval (flat 90 min, or the drill's length if
--                        shorter) rather than the drill's full length, with
--                        source 'officer_manual' and officer_attested = true.
--                        RETURNS TABLE gains a column -> DROP + CREATE.
--   dept_iso_hours       one UNION ALL appended to the clipped CTE. Everything
--                        downstream — live, agg, range_agg, secs, final, the
--                        ordering — is byte-for-byte unchanged.
--
-- MEASURED 2026-08-21: THE CAP COSTS NOTHING TODAY. The impact query below was run
-- against live data and returned NO ROWS — no drill in either department exceeds 90
-- minutes, so the cap never binds and credited hours do not move. The warning that
-- follows is retained because it becomes true the day someone logs a longer drill,
-- but it is NOT a reason to hesitate over applying this now.
--
-- The real change this makes is to ISO: attested drills begin counting toward
-- dept_iso_hours, which previously read only verified station_presence rows.
--
-- READ THIS BEFORE APPLYING — C2 LOWERS SOME NUMBERS THAT ARE ALREADY PUBLISHED.
--
-- Part A is live, and it credits attendance-derived rows their FULL drill length.
-- C2 replaces that with the capped interval. For any drill LONGER than 90 minutes,
-- credited hours go DOWN the moment this is applied:
--
--     drill length     today (Part A)     after C2      change
--     90 min                  1.50 h        1.50 h       none
--     2 hours                 2.00 h        1.50 h      -0.50 h per attendee
--     3 hours                 3.00 h        1.50 h      -1.50 h per attendee
--     4 hours                 4.00 h        1.50 h      -2.50 h per attendee
--
-- This follows directly from the brief — "a flat 90 minutes" is a cap, and 18
-- attendees x 1.5 h = 27.0 h was the worked example. It is called out here because
-- the effect lands on figures a chief may already have read off a report or sent to
-- the county, and a number that quietly shrinks between two reports is the kind of
-- thing that costs trust even when the new number is the more defensible one.
--
-- Query 3 in the VERIFY block sizes the impact on real data BEFORE you commit to it.
-- If long drills turn out to be common, the cap is worth a second conversation: the
-- alternative is capping only where no observed row exists (which is already true)
-- and letting a recorded 3-hour drill credit 3 hours. That is a policy question, not
-- a technical one, so it is yours and not mine.
--
-- WHAT DOES NOT CHANGE, and must not:
--   • verified stays FALSE on derived rows. These are attested, not
--     location-proven. Crediting them equally is a policy decision; recording
--     them identically would be a lie, and the audit story depends on the
--     distinction surviving in the ledger.
--   • auto_closed rows stay excluded from ISO. An attestation about ATTENDANCE
--     is not an attestation about when someone LEFT.
--   • observed always wins: attested_training omits any member who has a real
--     training presence row for that session, so a member with both is credited
--     their actual clocked duration and never the flat allowance.
--   • optional sessions credit hours but are NOT ISO-qualifying, so the ISO
--     branch filters them out. This is intended and is why credited can exceed
--     ISO by more than de-overlapping explains.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRE-FLIGHT — refuse rather than break something.
--
-- (a) C1 must be applied first, or branch B below references a function that
--     does not exist and the whole migration fails halfway.
-- (b) DROP FUNCTION destroys anything that depends on the old signature. A view
--     or another function built on dept_station_shifts would be silently taken
--     with it under CASCADE, so this refuses if anything depends on it and says
--     what.
-- ---------------------------------------------------------------------
DO $do$
DECLARE
  v_missing int;
  v_deps    text;
BEGIN
  SELECT count(*) INTO v_missing FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'attested_training';
  IF v_missing = 0 THEN
    RAISE EXCEPTION 'attested_training() is not present — apply training_hours_c1_attested_training.sql first. Nothing was changed.';
  END IF;

  SELECT string_agg(DISTINCT format('%s %s', d.classid::regclass, d.objid::text), ', ')
    INTO v_deps
    FROM pg_depend d
   WHERE d.refobjid = 'public.dept_station_shifts(timestamptz,timestamptz)'::regprocedure
     AND d.deptype <> 'i';                      -- ignore the function's own internal deps
  IF v_deps IS NOT NULL THEN
    RAISE EXCEPTION 'Something depends on dept_station_shifts and would be dropped with it: %. Nothing was changed.', v_deps;
  END IF;

  RAISE NOTICE 'Pre-flight OK — attested_training present, nothing depends on dept_station_shifts.';
END
$do$;

-- ---------------------------------------------------------------------
-- 1. CAPTURE THE GRANTS BEFORE THE DROP.
--
-- DROP FUNCTION discards proacl. Re-granting from memory is how a function comes
-- back subtly more open — or more closed — than it was, and neither is
-- noticeable until something breaks in production. This reads the ACL that is
-- actually live and replays it verbatim after the CREATE, so whatever had
-- EXECUTE still has it and nothing else gains it.
--
-- A NULL proacl means "PostgreSQL defaults", which for a function is EXECUTE to
-- PUBLIC. The recreated function defaults the same way, so there is nothing to
-- replay — but it is worth a NOTICE, because on this project a NULL ACL would
-- itself be a surprise: every RPC here is explicitly revoked from anon.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _dss_acl ON COMMIT DROP AS
SELECT a.grantee::regrole::text AS grantee, a.privilege_type AS priv
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) a
 WHERE p.oid = 'public.dept_station_shifts(timestamptz,timestamptz)'::regprocedure;

DO $do$
DECLARE v_n int; v_list text;
BEGIN
  SELECT count(*), string_agg(DISTINCT grantee || ':' || priv, ', ') INTO v_n, v_list FROM _dss_acl;
  IF v_n = 0 THEN
    RAISE NOTICE 'dept_station_shifts had a NULL ACL (PostgreSQL default: EXECUTE to PUBLIC). Nothing to replay — but check this is intended.';
  ELSE
    RAISE NOTICE 'Captured % grant(s) to replay after the drop: %', v_n, v_list;
  END IF;
END
$do$;

-- ---------------------------------------------------------------------
-- 2. dept_station_shifts — live body, two edits.
-- ---------------------------------------------------------------------
DROP FUNCTION public.dept_station_shifts(timestamptz, timestamptz);

CREATE FUNCTION public.dept_station_shifts(
  p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()),
  p_to   timestamp with time zone DEFAULT now()
)
 RETURNS TABLE(member_id uuid, member_name text, checked_in_at timestamp with time zone,
               checked_out_at timestamp with time zone, hours numeric, kind text,
               verified boolean, auto_closed boolean, source text, optional boolean,
               officer_attested boolean)
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
    -- A. OBSERVED — unchanged except for the new column. A real punch is never
    -- "attested": it was measured, and the distinction is the whole point.
    select m.id, m.name, sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours,
           sp.kind, sp.verified, sp.auto_closed,
           coalesce(sp.source, 'geo')::text as source,
           false as optional,
           false as officer_attested
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    where sp.department_id = v_dept
      and sp.checked_out_at is not null
      and sp.kind in ('standby','training')
      and sp.checked_in_at >= p_from
      and sp.checked_in_at <  p_to
    union all
    -- B. OFFICER-ATTESTED — now sourced from attested_training rather than derived
    -- inline, so this and dept_iso_hours cannot disagree about what an attested
    -- interval is. The cap, the timezone, the four gates and the observed-wins
    -- dedup all live in that one function.
    --
    -- hours is the CAPPED interval, not the drill's length: end_at is already
    -- start_at + least(90 min, duration). Deriving it from the interval rather
    -- than recomputing keeps the row's window and its credited hours identical,
    -- which is what lets dept_iso_hours de-overlap the same span honestly.
    --
    -- The window test is start-in-period here, matching branch A's treatment of
    -- checked_in_at, while the ISO caller uses an overlap test. attested_training's
    -- own prefilter is deliberately looser than both so neither is starved.
    select m.id, m.name,
           att.start_at                                  as checked_in_at,
           att.end_at                                    as checked_out_at,
           round((extract(epoch from (att.end_at - att.start_at)) / 3600.0)::numeric, 2) as hours,
           'training'::text                             as kind,
           false                                        as verified,   -- attested, NOT location-verified
           false                                        as auto_closed,
           'officer_manual'::text                       as source,
           att.optional                                  as optional,
           true                                         as officer_attested
    from public.attested_training(v_dept, p_from, p_to) att
    join public.members m on m.id = att.member_id
    where att.start_at >= p_from
      and att.start_at <  p_to
    order by 3 desc;
end;
$function$;

-- ---------------------------------------------------------------------
-- 3. REPLAY THE CAPTURED GRANTS.
-- ---------------------------------------------------------------------
DO $do$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN SELECT DISTINCT grantee, priv FROM _dss_acl LOOP
    -- PUBLIC comes back from regrole as '-'; it is granted by name, not quoted as an identifier.
    IF r.grantee = '-' THEN
      EXECUTE format('GRANT %s ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) TO PUBLIC', r.priv);
    ELSE
      EXECUTE format('GRANT %s ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) TO %I', r.priv, r.grantee);
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'Replayed % grant(s) onto the recreated dept_station_shifts.', v_n;
END
$do$;

-- ---------------------------------------------------------------------
-- 4. dept_iso_hours — live body, ONE union branch added to `clipped`.
--
-- Everything from `live` downwards is untouched: the same range_agg de-overlap,
-- the same training-wins cascade, the same rounding, the same ordering. The
-- attested intervals simply become more input to the union that was already
-- there, which is why this cannot change how existing hours are counted.
--
-- CREATE OR REPLACE, not DROP: the return type is unchanged, so the grants
-- survive and there is nothing to replay.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_iso_hours(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(member_id uuid, member_name text, training_hours numeric, standby_hours numeric, iso_total_hours numeric)
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
      and sp.verified
      and sp.checked_out_at is not null
      and not sp.auto_closed
      and sp.kind in ('standby','training')
      and sp.checked_in_at  <  p_to
      and sp.checked_out_at >  p_from

    union all

    -- OFFICER-ATTESTED. These intervals do not exist in station_presence — they are
    -- derived from session_attendance — so no widening of the WHERE above could ever
    -- have reached them. They enter as clipped tstzranges and are de-overlapped by the
    -- same range_agg as everything else, which is what stops an attested drill and an
    -- overlapping standby shift being counted twice.
    --
    -- is_training is true unconditionally: attested_training only ever returns drills.
    --
    -- `not optional` — an off-hours or one-off session credits hours but is not
    -- ISO-qualifying training, so it raises the credited total without raising ISO.
    -- Intended, and explained in the report's provenance so the gap is not a mystery.
    --
    -- The overlap test mirrors the observed branch: a drill straddling the period edge
    -- is CLIPPED by the greatest/least below, never dropped.
    select
      att.member_id as mid,
      true         as is_training,
      tstzrange(greatest(att.start_at, p_from),
                least(att.end_at, p_to), '[)') as span
    from public.attested_training(v_dept, p_from, p_to) att
    where not att.optional
      and att.start_at < p_to
      and att.end_at   > p_from
  ),
  live as (
    select * from clipped where not isempty(span)
  ),
  agg as (
    select
      c.mid,
      range_agg(c.span) filter (where c.is_training) as training_mr,
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
      s.mid                                                          as mid,
      m.name                                                         as mname,
      round((s.training_secs / 3600.0)::numeric, 2)                  as t_hours,
      round(((s.total_secs - s.training_secs) / 3600.0)::numeric, 2) as s_hours,
      round((s.total_secs / 3600.0)::numeric, 2)                     as tot_hours
    from secs s
    join public.members m on m.id = s.mid
  )
  select f.mid, f.mname, f.t_hours, f.s_hours, f.tot_hours
  from final f
  order by f.tot_hours desc, f.mname;
end;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- WHICH OF THESE ACTUALLY RUN IN THE SUPABASE SQL EDITOR:
--   1, 2, 3   yes — they read catalogs and base tables.
--   4, 5, 6   NO. They call dept_station_shifts / dept_iso_hours, which gate on
--             is_leadership(). That reads the JWT, and the editor has none, so all
--             three raise "Not authorized" — the gate working, not a failure.
--
-- To check 4-6 without the gate, use the DRY RUN, which replicates the same logic
-- reading base tables directly and shows before/after/delta side by side. It also
-- answers 4-6 BEFORE applying rather than after, which is the better order:
--     scratchpad/dryrun.sql   (standby_delta must be 0.00 on every row)
--
-- Or check them from the app as a leadership user: open the Station Hours report,
-- where the ledger shows the location-verified vs officer check-in split directly.
--
-- -- 1. Shape. Expect officer_attested present as the 11th column, definer=t,
-- --    search_path pinned, and exactly one of each function (no overloads).
-- SELECT proname,
--        pg_get_function_result(oid)                        AS returns,
--        prosecdef                                          AS definer,
--        coalesce(array_to_string(proconfig,','),'-')       AS cfg
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('dept_station_shifts','dept_iso_hours','attested_training')
--  ORDER BY proname;
--
-- -- 2. THE GRANTS SURVIVED THE DROP. dept_station_shifts should read exactly as it
-- --    did before (anon=f, auth=t), and attested_training should be callable by
-- --    NOBODY but the owner (both f) per C1.
-- SELECT proname,
--        has_function_privilege('anon', oid, 'EXECUTE')          AS anon,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth,
--        pg_get_userbyid(proowner)                               AS owner
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('dept_station_shifts','dept_iso_hours','attested_training')
--  ORDER BY proname;
--    -- owner must MATCH across all three, or the DEFINER functions cannot call
--    -- attested_training and both RPCs will error at runtime.
--
-- -- 3. SIZE THE HOURS REDUCTION BEFORE YOU TRUST IT. Reads training_sessions
-- --    directly, so it works whether or not C2 has been applied. Any row with
-- --    hours_lost > 0 is a drill whose credited total drops.
-- SELECT ts.date, ts.title, ts.duration_min,
--        count(sa.member_id)                                        AS attendees,
--        round((ts.duration_min/60.0)::numeric, 2)                  AS hours_today,
--        round((least(90, ts.duration_min)/60.0)::numeric, 2)       AS hours_after,
--        round((count(sa.member_id) *
--               ((ts.duration_min - least(90, ts.duration_min))/60.0))::numeric, 2) AS hours_lost
--   FROM public.training_sessions ts
--   JOIN public.session_attendance sa ON sa.session_id = ts.id
--  WHERE ts.done AND ts.duration_min IS NOT NULL
--    AND coalesce(ts.audience,'everyone') <> 'board'
--    AND coalesce(ts.is_offsite,false) = false
--    AND ts.duration_min > 90
--  GROUP BY ts.id, ts.date, ts.title, ts.duration_min
--  ORDER BY hours_lost DESC;
--
-- -- 4. THE HONESTY INVARIANT. No derived row may ever claim verification.
-- --    Expect ZERO rows. If this returns anything, stop and roll back.
-- SELECT * FROM public.dept_station_shifts(date_trunc('month', now()), now())
--  WHERE officer_attested AND verified;
--
-- -- 5. Observed still wins. A member with a real training punch for a session must
-- --    appear ONCE, with officer_attested = false. Expect no duplicates.
-- SELECT member_name, checked_in_at, count(*)
--   FROM public.dept_station_shifts(date_trunc('month', now()), now())
--  WHERE kind = 'training'
--  GROUP BY 1,2 HAVING count(*) > 1;
--
-- -- 6. ISO moved for the right reason. Run BOTH before and after applying and
-- --    compare: training_hours should rise for drill attendees and standby_hours
-- --    must not move at all. A changed standby figure means the union branch is
-- --    leaking into the wrong side of the cascade.
-- SELECT member_name, training_hours, standby_hours, iso_total_hours
--   FROM public.dept_iso_hours(date_trunc('month', now()), now())
--  ORDER BY member_name;
--
-- -- 7. Optional sessions credit but do not qualify. A member whose only training is
-- --    an optional session should show hours in dept_station_shifts and ZERO
-- --    training_hours in dept_iso_hours. This is the intended gap, not a bug.
