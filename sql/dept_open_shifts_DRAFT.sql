-- =====================================================================
-- dept_open_shifts() — the shift ids behind "On station right now", for the DA "Check out" button.
-- Record: Claude gate review PASS 2026-10-16 (recorded BEFORE apply). Was: DRAFT — for the reviewing Claude, then Ashlea applies. Test script: sql/dept_open_shifts_RETEST.sql (run AFTER).
--
-- WHY A NEW READ (the build order said "no new RPC" — flagged; Ashlea chose this 2026-10-16). The Check out button
-- calls the existing close_open_shift(p_shift_id, p_checked_out_at), which needs the SHIFT id. Nothing the client can
-- read today returns it for an on-station row:
--   • dept_on_station_now_all() returns member/kind/check-in/station — no shift id;
--   • a direct station_presence read returns 0 rows to a Department Admin under RLS (checked live 2026-10-16 while
--     dept_on_station_now_all listed Chase Thomas and Spencer Sampler);
--   • dept_open_long_shifts() has the id but only for geofenced shifts open longer than the threshold (28 h).
--
-- WHAT IT IS. dept_open_long_shifts() minus its two filters (source = 'gps_geofence', open > threshold): every OPEN
-- standby / off-site shift in the caller's department, with its id. SAME GATE AS THE CLOSER AND THE LONG-OPEN READ —
-- is_dept_admin() + department_id = my_department_id() — so the button can only be offered to someone close_open_shift
-- would accept. Training rows are excluded for the same reason dept_open_long_shifts excludes them: a drill's clock is
-- closed by finalizing the session.
--
-- WHAT CHANGES — ADDITIVE ONLY. One new STABLE SECURITY DEFINER read. EXECUTE revoked from anon + public, granted to
-- authenticated. No table, column, policy or existing function is touched; the post-condition proves every policy is
-- identical before/after and anon can't execute it. close_open_shift is unchanged (it never writes `verified`).
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor. Safe to re-run (idempotent).
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'$q$;
BEGIN
  IF to_regprocedure('public.is_dept_admin()') IS NULL OR to_regprocedure('public.my_department_id()') IS NULL
     OR to_regprocedure('public.close_open_shift(uuid,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() / my_department_id() / close_open_shift() missing.';
  END IF;
  IF to_regprocedure('public.dept_open_shifts()') IS NOT NULL THEN   -- nested: SQL AND doesn't short-circuit
    IF position('B4C:dept_open_shifts' in pg_get_functiondef(to_regprocedure('public.dept_open_shifts()'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different dept_open_shifts() exists — not overwriting it.';
    END IF;
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_open_shifts()
 RETURNS TABLE(
   shift_id      uuid,
   member_id     uuid,
   member_name   text,
   kind          text,
   source        text,
   checked_in_at timestamptz,
   verified      boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:dept_open_shifts — every OPEN standby/off-site shift in the caller's department, with its id, for the DA
-- "Check out" control. Same gate as close_open_shift / dept_open_long_shifts. Read-only.
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized';
  end if;
  return query
    select sp.id, m.id, m.name, sp.kind, sp.source, sp.checked_in_at, sp.verified
      from public.station_presence sp
      join public.members m on m.id = sp.member_id
     where sp.department_id = v_dept
       and sp.checked_out_at is null
       and sp.kind in ('standby', 'offsite')
     order by sp.checked_in_at asc;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.dept_open_shifts() FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.dept_open_shifts() TO authenticated;

  IF has_function_privilege('anon', 'public.dept_open_shifts()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE dept_open_shifts. Rolling back.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.dept_open_shifts()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: authenticated can''t EXECUTE dept_open_shifts. Rolling back.';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN
    RAISE EXCEPTION 'Post-condition failed: a policy changed. Rolling back.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: exists true · anon_execute false · auth_execute true · total_policies unchanged (157)
SELECT to_regprocedure('public.dept_open_shifts()') IS NOT NULL AS exists,
       has_function_privilege('anon', 'public.dept_open_shifts()', 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', 'public.dept_open_shifts()', 'EXECUTE') AS auth_execute,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately): DROP FUNCTION IF EXISTS public.dept_open_shifts(); NOTIFY pgrst, 'reload schema';
-- The client fails closed without it (no Check out buttons appear).
