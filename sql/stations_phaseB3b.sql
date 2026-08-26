-- =====================================================================
-- MULTI-STATION — PHASE B3b: my_station_shifts learns which house.
--
-- WHAT THIS IS. B3a gave every shift a station_id. This is the read side: the
-- member's own hours list now carries the station, so the Station Hours screen
-- can label each shift and break the total down by house.
--
-- WHAT THIS IS NOT — and this is the whole point. It adds NO station filter.
-- my_station_shifts keeps returning the member's shifts across EVERY house,
-- because the department-wide total is the headline figure and it feeds
-- LOSAP/service credit. Scoping this to the active station would silently
-- under-report a member's year and read as lost hours. The station is added for
-- LABELLING and the BREAKDOWN. It is not a filter, and it must never become one
-- without a Phase E design that says what the credited number is.
--
-- SO, EVERYTHING ELSE IS IDENTICAL, deliberately and checkably:
--   same params + defaults    (p_from, p_to, both timestamptz)
--   same member scope         (my_member_id(), same null-check and message)
--   same filter               (closed only, kind in standby/training, same range)
--   same hours calculation    (copied character-for-character, NOT re-derived)
--   same ordering             (checked_in_at desc)
--   same volatility/security  (STABLE SECURITY DEFINER, search_path public)
-- The SET of shifts and every HOURS value are unchanged. This is labelling, not
-- crediting, so no compliance number moves.
--
-- THE LEFT JOIN IS LOAD-BEARING. It must be LEFT, never INNER. An inner join
-- would silently DROP any shift whose station_id is null — turning a labelling
-- change into a change in credited hours, which is the one thing B3 forbids.
-- B3a's backfill plus the trigger should mean nothing is unattributed, but the
-- join must be safe even if something is: an unattributed shift is still the
-- member's shift and still counts. It comes back with a null station_name, and
-- the screen labels it rather than hiding it. VERIFY 3 proves the row count is
-- unchanged by the join.
--
-- WHY DROP + CREATE. Adding columns to RETURNS TABLE is a return-type change,
-- and CREATE OR REPLACE cannot do that ("cannot change return type of existing
-- function" — the exact error Phase 2b hit). DROP discards grants, so they are
-- re-established below. Same lesson, written down again.
--
-- ORDER OF OPERATIONS — B3a MUST BE APPLIED FIRST. This function reads
-- station_presence.station_id, which does not exist until sql/stations_phaseB3.sql
-- has run. The precondition below refuses rather than creating a broken
-- function. Then: B3a -> B3b -> client deploy.
--
-- ROLLBACK: the pre-change definition is captured verbatim at the bottom of this
-- file. Restoring it is a paste, plus the same two grant lines.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='station_presence'
                    AND column_name='station_id') THEN
    RAISE EXCEPTION 'Phase B3b precondition failed: station_presence has no station_id. Apply sql/stations_phaseB3.sql (B3a) first.';
  END IF;

  -- Guard against applying this against an un-backfilled column. Not fatal to
  -- the function -- the LEFT JOIN handles nulls -- but it means B3a's backfill
  -- did not run, and members would see shifts with no house on a screen whose
  -- whole point is naming the house.
  IF EXISTS (SELECT 1 FROM public.station_presence WHERE station_id IS NULL) THEN
    RAISE WARNING 'Phase B3b: % shift(s) have no station_id. They will show as unattributed. Re-check B3a step 2 (the backfill).',
      (SELECT count(*) FROM public.station_presence WHERE station_id IS NULL);
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. DROP the old signature -- exactly, with no overload left behind.
--
-- Plain DROP, NOT CASCADE: if some object depends on this function, the drop
-- must fail loudly here inside the transaction rather than quietly demolish the
-- dependent. (Repo grep found exactly one caller, the StationHours client, which
-- is not a database dependency.)
-- ---------------------------------------------------------------------
DROP FUNCTION public.my_station_shifts(timestamp with time zone, timestamp with time zone);


-- ---------------------------------------------------------------------
-- 2. Recreate it, widened by two columns and unchanged in every other respect.
--
-- Column order: the five original columns keep their positions and names, and
-- the two new ones are APPENDED. Nothing that reads the old fields can break.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_station_shifts(p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()), p_to timestamp with time zone DEFAULT now())
 RETURNS TABLE(checked_in_at timestamp with time zone, checked_out_at timestamp with time zone, hours numeric, kind text, verified boolean, station_id uuid, station_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me uuid := public.my_member_id();
begin
  if v_me is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  return query
    select sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours,
           sp.kind, sp.verified,
           -- B3b: labelling only. No filter on station -- see the header.
           sp.station_id, s.name as station_name
    from public.station_presence sp
    -- LEFT, never INNER: an unattributed shift is still the member's shift.
    left join public.stations s on s.id = sp.station_id
    where sp.member_id = v_me
      and sp.checked_out_at is not null
      and sp.kind in ('standby','training')
      and sp.checked_in_at >= p_from
      and sp.checked_in_at <  p_to
    order by sp.checked_in_at desc;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. Re-establish grants. DROP discarded them.
--
-- Postgres default-grants EXECUTE to PUBLIC and anon inherits through it, so
-- revoke both and grant authenticated back. Without this the function is
-- reachable by anon -- it would still raise on my_member_id() being null, but
-- an unauthenticated caller should not reach the body at all.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.my_station_shifts(timestamp with time zone, timestamp with time zone) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.my_station_shifts(timestamp with time zone, timestamp with time zone) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) -- all read-only.
-- =====================================================================
--
-- -- 1. Exactly ONE my_station_shifts, with the widened shape and the right
-- --    signature. Expect a single row; no overload survived the drop.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        pg_get_function_result(oid) AS returns,
--        prosecdef AS definer,
--        provolatile AS volatility   -- expect 's' (STABLE), same as before
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='my_station_shifts';
--
-- -- 2. Grants re-established after the DROP. Expect anon=f, auth=t.
-- SELECT has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='my_station_shifts';
--
-- -- 3. THE ONE THAT MATTERS: the LEFT JOIN drops nothing. Both counts and both
-- --    sums must be IDENTICAL. If with_join is lower, the join is eating rows
-- --    and hours have gone missing -- stop and roll back.
-- SELECT (SELECT count(*) FROM public.station_presence sp
--          WHERE sp.checked_out_at IS NOT NULL AND sp.kind IN ('standby','training')) AS rows_without_join,
--        (SELECT count(*) FROM public.station_presence sp
--           LEFT JOIN public.stations s ON s.id = sp.station_id
--          WHERE sp.checked_out_at IS NOT NULL AND sp.kind IN ('standby','training')) AS rows_with_join,
--        (SELECT round(sum(round((extract(epoch FROM (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2)), 2)
--           FROM public.station_presence sp
--          WHERE sp.checked_out_at IS NOT NULL AND sp.kind IN ('standby','training')) AS hours_without_join,
--        (SELECT round(sum(round((extract(epoch FROM (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2)), 2)
--           FROM public.station_presence sp
--           LEFT JOIN public.stations s ON s.id = sp.station_id
--          WHERE sp.checked_out_at IS NOT NULL AND sp.kind IN ('standby','training')) AS hours_with_join;
--
-- -- 4. Nothing unattributed, and no shift labelled with another department's
-- --    station. Expect both 0.
-- SELECT count(*) FILTER (WHERE sp.station_id IS NULL) AS unattributed,
--        count(*) FILTER (WHERE s.id IS NOT NULL AND s.department_id <> sp.department_id) AS cross_department
--   FROM public.station_presence sp
--   LEFT JOIN public.stations s ON s.id = sp.station_id;
--
-- -- 5. NO FILTER SNUCK IN. The body must NOT mention my_active_station_id --
-- --    that would scope a LOSAP figure to one house. Expect has_filter = f,
-- --    and left_join = t.
-- SELECT proname,
--        (prosrc ILIKE '%my_active_station_id%') AS has_filter,
--        (prosrc ILIKE '%left join%')            AS left_join
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='my_station_shifts';
--
-- -- 6. UNTOUCHED PROOF -- B3b creates none of these. Diff against the B3a captures.
-- SELECT pg_get_functiondef('public.dept_iso_hours'::regproc);
-- SELECT pg_get_functiondef('public.dept_station_shifts'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
--
-- ---------- SIGNED IN ----------
-- -- 7.  SINGLE-station department: Station Hours renders EXACTLY as before --
-- --     no "By station" block, no station on any shift row, same headline. The
-- --     screen hides both when the shifts resolve to one house.
-- -- 8.  MULTI-station: the headline is the same number it was before B3b, the
-- --     "By station" lines SUM to that headline, and each shift row names its
-- --     house.
-- -- 9.  Switch the active station and reload: My Hours does NOT change. It is
-- --     department-wide by design. (If it changes, a filter got in -- see 5.)
-- -- 10. Cross-check the headline against the leadership report for the same
-- --     member and range. They must still agree.
--
--
-- =====================================================================
-- ROLLBACK ARTIFACT -- the definition as it was BEFORE this file, verbatim.
-- Restore by running this, then the two grant lines from section 3.
-- =====================================================================
--
-- CREATE OR REPLACE FUNCTION public.my_station_shifts(p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()), p_to timestamp with time zone DEFAULT now())
--  RETURNS TABLE(checked_in_at timestamp with time zone, checked_out_at timestamp with time zone, hours numeric, kind text, verified boolean)
--  LANGUAGE plpgsql
--  STABLE SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   v_me uuid := public.my_member_id();
-- begin
--   if v_me is null then
--     raise exception 'We could not match your login to a member record.';
--   end if;
--   return query
--     select sp.checked_in_at, sp.checked_out_at,
--            round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours,
--            sp.kind, sp.verified
--     from public.station_presence sp
--     where sp.member_id = v_me
--       and sp.checked_out_at is not null
--       and sp.kind in ('standby','training')
--       and sp.checked_in_at >= p_from
--       and sp.checked_in_at <  p_to
--     order by sp.checked_in_at desc;
-- end;
-- $function$;
--
-- (A rollback of this function requires reverting the client too: the screen
--  reads station_name, and would show every shift as unattributed against the
--  old shape. It degrades rather than breaks -- but revert both.)
