-- =====================================================================
-- Record: applied by hand 2026-10-14. DO NOT RE-APPLY.
-- Applied to prod by Ashlea in the Supabase SQL editor. RETEST: 4/5 PASS; the one "fail" was a
-- placeholder-email account (no JWT email match) failing closed, which is correct, not a defect.
-- Archived from sql/my_station_shifts_source_DRAFT.sql so it stops surfacing as a pending decision.
-- Body below is kept unchanged as the record of what ran.
-- =====================================================================
-- =====================================================================
-- my_station_shifts — ADD `source` TO THE OUTPUT. DRAFT — NOT APPLIED. For review.
--
-- WHY. The member Station Hours page (b4c_mystationhours_noir.html) tags each recent shift
-- GEOFENCE / ON LOCATION / MANUAL. Today the RPC returns no `source`, so the page can only tell
-- "on location" from "manual"; it cannot tell an automatic geofence shift from a button clock-in.
-- The client already reads s.source and falls back cleanly while it is absent, so this can be
-- applied (or not) independently of the deploy.
--
-- WHAT CHANGES — ONE COLUMN, NOTHING ELSE:
--   * RETURNS TABLE gains `source text` (last, so positional readers are unaffected).
--   * The select list gains sp.source.
--   * EVERYTHING ELSE IS COPIED CHARACTER-FOR-CHARACTER from the live definition captured in
--     sql/stations_phaseB3b.sql: same params + defaults, same member scope (my_member_id(), same
--     null-check + message), same filter (closed only, kind in standby/training, same range), same
--     hours math, same LEFT join, same order, STABLE SECURITY DEFINER, search_path public.
--     No row is added or dropped; no hours value moves; the verified column is returned unchanged
--     (it is only passed through, as today — not computed, filtered or altered here).
--
-- SCOPE / PERMISSIONS (the gate):
--   * Member-scoped by the function itself: WHERE sp.member_id = my_member_id(). It never returns
--     another member's row and has no department-wide branch. SECURITY DEFINER, so table RLS is not
--     the boundary here — the WHERE is. Unchanged by this draft.
--   * Reads: 1 table (station_presence) + 1 LEFT join (stations, name only). No new table.
--   * Permission checks: 1 (my_member_id() IS NULL -> raise). Unchanged.
--   * Grants: DROP discards them, so they are re-established exactly: REVOKE anon/public,
--     GRANT authenticated. A post-condition proves anon cannot EXECUTE.
--
-- WHY DROP + CREATE: adding a RETURNS TABLE column is a return-type change; CREATE OR REPLACE
-- cannot do it ("cannot change return type of existing function").
--
-- BEFORE RUNNING: compare the live body to section 1 —
--   SELECT pg_get_functiondef('public.my_station_shifts'::regproc);
-- If it differs from sql/stations_phaseB3b.sql, stop and re-copy from the live one.
-- =====================================================================
BEGIN;

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='station_presence' AND column_name='source') THEN
    RAISE EXCEPTION 'Precondition failed: station_presence.source does not exist.';
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.my_station_shifts(timestamp with time zone, timestamp with time zone);

-- 1. the live definition + `source`
CREATE OR REPLACE FUNCTION public.my_station_shifts(p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()), p_to timestamp with time zone DEFAULT now())
 RETURNS TABLE(checked_in_at timestamp with time zone, checked_out_at timestamp with time zone, hours numeric, kind text, verified boolean, station_id uuid, station_name text, source text)
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
           sp.station_id, s.name as station_name,
           sp.source   -- labelling only (Geofence vs button clock-in). Not a filter.
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

-- 2. grants (DROP discarded them)
REVOKE EXECUTE ON FUNCTION public.my_station_shifts(timestamp with time zone, timestamp with time zone) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.my_station_shifts(timestamp with time zone, timestamp with time zone) TO authenticated;

-- 3. post-conditions — any failure rolls everything back
DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.my_station_shifts(timestamp with time zone, timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE my_station_shifts. Rolling back.';
  END IF;
  IF position('sp.member_id = v_me' in pg_get_functiondef('public.my_station_shifts(timestamp with time zone, timestamp with time zone)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: member scope missing. Rolling back.';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- state check (read-only)
SELECT pg_get_function_result('public.my_station_shifts(timestamp with time zone, timestamp with time zone)'::regprocedure) AS returns;

-- =====================================================================
-- RETEST (run AFTER, separately) — one DO block, rolled back by its final RAISE. For up to 5 members
-- with shifts: sign in as them (JWT email claim + role authenticated, as the app does) and check the
-- RPC returns exactly their own closed standby/training shifts for the year — never another member's.
-- =====================================================================
-- DO $retest$
-- DECLARE rec record; v_rpc int; v_own int; v_foreign int; rpt text := chr(10); v_pass int := 0; v_fail int := 0;
-- BEGIN
--   FOR rec IN SELECT DISTINCT ON (m.id) m.id, lower(m.email) AS email, m.name
--                FROM public.members m JOIN public.station_presence sp ON sp.member_id = m.id
--               WHERE m.email IS NOT NULL AND sp.checked_out_at IS NOT NULL LIMIT 5 LOOP
--     SELECT count(*) INTO v_own FROM public.station_presence
--      WHERE member_id = rec.id AND checked_out_at IS NOT NULL AND kind IN ('standby','training')
--        AND checked_in_at >= date_trunc('year', now()) AND checked_in_at < now();
--     BEGIN
--       PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
--       PERFORM set_config('role', 'authenticated', true);
--       SELECT count(*) INTO v_rpc FROM public.my_station_shifts(date_trunc('year', now()), now());
--       RAISE EXCEPTION 'SENTINEL';
--     EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'SENTINEL' THEN v_rpc := -1; END IF;
--     END;
--     IF v_rpc = v_own THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  %s: %s own shifts%s', rec.name, v_rpc, chr(10));
--     ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  %s: rpc %s vs own %s%s', rec.name, v_rpc, v_own, chr(10)); END IF;
--   END LOOP;
--   RAISE EXCEPTION E'%\n---- % passed, % failed ----\n(this exception IS the rollback)', rpt, v_pass, v_fail;
-- END
-- $retest$;
