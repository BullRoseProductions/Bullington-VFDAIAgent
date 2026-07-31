-- =====================================================================
-- dept_station_shifts_for(p_department_id, p_from, p_to)
--
-- WHY: the weekly digest runs as a Vercel cron job with the service-role
-- key and NO logged-in user. Every existing station RPC
-- (dept_station_shifts, my_station_shifts, dept_on_station_now) scopes
-- itself with my_department_id(), which reads the caller's JWT — with no
-- JWT that returns null and the RPC yields nothing. This variant takes the
-- department as an ARGUMENT instead, so a server-side caller can roll up
-- one department at a time without impersonating a member.
--
-- SECURITY — read this before changing the grants:
--   This function returns one department's presence rows to whoever names
--   that department. It is the ONE station read with no my_department_id()
--   wall in front of it. Granting it to `authenticated` would hand every
--   logged-in member a cross-department read of who was at which station
--   and when. It is therefore granted to service_role ONLY — not anon, not
--   public, not authenticated. Postgres default-grants EXECUTE to PUBLIC,
--   so the REVOKE is mandatory, not decorative (see revoke_anon_execute_sweep.sql).
--
-- Shape matches what the app's rollup already consumes (App.jsx ~6300):
-- one row per closed shift, hours derived, `verified` passed through so the
-- caller applies verified-only credit itself.
--
-- Open shifts (checked_out_at IS NULL) are EXCLUDED: an unclosed shift has
-- no duration to credit. Live presence is dept_on_station_now's job.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.dept_station_shifts_for(
  p_department_id uuid,
  p_from          timestamptz,
  p_to            timestamptz
)
RETURNS TABLE (
  member_id      uuid,
  member_name    text,
  kind           text,
  verified       boolean,
  checked_in_at  timestamptz,
  checked_out_at timestamptz,
  hours          numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sp.member_id,
         m.name,
         sp.kind,
         sp.verified,
         sp.checked_in_at,
         sp.checked_out_at,
         round((extract(epoch FROM (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) AS hours
  FROM public.station_presence sp
  JOIN public.members m ON m.id = sp.member_id
  WHERE sp.department_id = p_department_id
    AND sp.checked_out_at IS NOT NULL
    AND sp.checked_in_at >= p_from
    AND sp.checked_in_at <  p_to;
$$;

-- service_role ONLY — see the security note above.
REVOKE EXECUTE ON FUNCTION public.dept_station_shifts_for(uuid, timestamptz, timestamptz) FROM anon, public, authenticated;
GRANT  EXECUTE ON FUNCTION public.dept_station_shifts_for(uuid, timestamptz, timestamptz) TO service_role;

-- Closes the PostgREST 404-on-new-function race.
NOTIFY pgrst, 'reload schema';

-- ---- VERIFY (run after; expect exactly one row, acl showing service_role only) ----
-- SELECT p.proname,
--        pg_get_function_identity_arguments(p.oid) AS args,
--        p.prosecdef AS security_definer,
--        p.proacl    AS acl
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'dept_station_shifts_for';
