-- =====================================================================
-- Lock apparatus RPC EXECUTE to authenticated-only.
--
-- Supabase's default privileges grant EXECUTE to BOTH anon and authenticated
-- on every new function. The original migrations did "REVOKE ALL FROM public"
-- + "GRANT ... TO authenticated", but that leaves the SEPARATE explicit anon
-- grant in place, so anon (unauthenticated) could still call these RPCs.
--
-- Strip anon + public from both apparatus RPCs. authenticated keeps EXECUTE
-- from the original GRANTs; postgres/service_role are unaffected (and fine).
-- Idempotent: safe to re-run.
-- =====================================================================

REVOKE EXECUTE ON FUNCTION public.mark_check_item(uuid, uuid, text, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.start_or_resume_check(uuid)             FROM anon, public;

-- =====================================================================
-- VERIFICATION (run separately; definitive per-role yes/no)
-- =====================================================================
-- select p.proname, r.rolname,
--        has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
-- from pg_proc p
-- cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
-- where p.pronamespace = 'public'::regnamespace
--   and p.proname in ('mark_check_item','start_or_resume_check')
-- order by p.proname, r.rolname;
-- --   expect: anon = f (false) for BOTH; authenticated = t; service_role = t
