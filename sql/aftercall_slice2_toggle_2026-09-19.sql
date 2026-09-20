-- =====================================================================
-- AFTER-CALL CHECKLIST — SLICE 2: set_aftercall_enabled(). SQL ONLY.
--
-- APPLIED 2026-09-19, and VERIFIED the same day against the live database while
-- impersonating a real Department Admin: set true returned t and the column read
-- t, set false returned f, and the check rolled itself back so no department was
-- left switched on.
--
-- THE VERIFY MUST IMPERSONATE, and the first attempt at it did not. Called
-- plainly from the Supabase SQL editor, set_aftercall_enabled raises
-- 'Not authorized' — the editor is a superuser connection carrying NO JWT
-- claims, so my_member_id() is null and is_dept_admin() is correctly false.
-- That is the gate working, and it is easy to misread as a broken function.
-- Use the impersonating block at the foot of this file, not a bare call.
--
-- THE STATUS LINE IS THE FIRST THING TO DISTRUST when reading this later — a
-- file, a commit and a conversation all say nothing about whether SQL is live.
-- Only pg_proc does:
--   select proname from pg_proc where proname = 'set_aftercall_enabled';
--
-- WHY THIS FILE EXISTS. Slice 2's client calls
-- supabase.rpc("set_aftercall_enabled", { p_enabled }) to flip the department
-- toggle — and slice 1 deliberately did NOT create that function. Its header
-- said so in as many words: "THE TOGGLE WRITE IS NOT COVERED BY ANYTHING IN
-- THIS FILE." Without this migration the Settings toggle fails with
-- "Could not find the function public.set_aftercall_enabled(p_enabled) in the
-- schema cache" the first time anyone taps it. The client half is committed
-- alongside this and is inert until it runs.
--
-- THE HONEST ALTERNATIVE, for the record: a direct
-- `.update({ aftercall_enabled }).eq("id", deptId)` would also work today. The
-- week-start-day setter in App.jsx does exactly that against this same table
-- and is commented "Saving is Department Admin only (RLS)", which is evidence
-- that departments already carries an UPDATE policy admitting a DA — the
-- question slice 1's precondition NOTICE was asking. An RPC is still the
-- better answer here: it states its own gate in one readable line instead of
-- depending on a policy that is nowhere in this repo's migration history, and
-- it cannot be widened by accident when somebody edits that policy for an
-- unrelated reason.
--
-- IT TAKES NO DEPARTMENT ID, and that is the security design rather than a
-- convenience. A SECURITY DEFINER function with a p_department_id parameter is
-- a cross-department write for anyone who can call it — the same reasoning that
-- made dept_iso_hours_for service_role-only. This one derives the department
-- from the caller, so the worst an authorized caller can do is change their own.
-- (pa_set_geofence_enabled DOES take an id, correctly: it is gated on
-- is_project_admin() precisely so support can act on another department.)
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------
do $pre$
declare
  v_missing text;
begin
  select string_agg(n, ', ') into v_missing from (
    select n from unnest(array['my_department_id', 'is_dept_admin']) as n
    where not exists (select 1 from pg_proc
                       where pronamespace = 'public'::regnamespace and proname = n)
  ) s;
  if v_missing is not null then
    raise exception 'Precondition failed: missing function(s): %. These ARE the authorization boundary for the setter below.', v_missing;
  end if;

  -- Slice 1 must be live, or this toggles a column that does not exist.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'departments'
                    and column_name = 'aftercall_enabled') then
    raise exception 'Precondition failed: departments.aftercall_enabled does not exist. Run sql/aftercall_slice1_2026-09-19.sql first.';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------
-- 1. THE SETTER. Caller's own department, Department Admin (or PA) only.
--
-- RETURNS THE VALUE IT SET rather than void, so the client can trust the
-- server's answer over its own optimism. A toggle that assumes success is how
-- a screen ends up showing "on" for a department where it is off.
-- ---------------------------------------------------------------------
create or replace function public.set_aftercall_enabled(p_enabled boolean)
 returns boolean
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare
  v_dept uuid := public.my_department_id();
  v_val  boolean;
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized';
  end if;
  if v_dept is null then
    raise exception 'We could not match your login to a department.';
  end if;
  -- coalesce: a null from the client means "off", never "leave it as it was" —
  -- a toggle that silently no-ops is worse than one that refuses.
  update public.departments
     set aftercall_enabled = coalesce(p_enabled, false)
   where id = v_dept
  returning aftercall_enabled into v_val;

  if not found then
    raise exception 'Department not found';
  end if;
  return v_val;
end;
$function$;

-- anon named explicitly beside public: Supabase re-grants anon on CREATE, and
-- revoking FROM anon alone leaves it inheriting through PUBLIC.
revoke all    on function public.set_aftercall_enabled(boolean) from anon, public;
grant execute on function public.set_aftercall_enabled(boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. POST-CONDITIONS — in-transaction, so a hole rolls itself back.
-- ---------------------------------------------------------------------
do $post$
begin
  if has_function_privilege('anon', 'public.set_aftercall_enabled(boolean)', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE set_aftercall_enabled. Rolling back.';
  end if;
  if not has_function_privilege('authenticated', 'public.set_aftercall_enabled(boolean)', 'EXECUTE') then
    raise exception 'Post-condition failed: authenticated cannot execute it — the toggle would never work.';
  end if;
  -- No overload took a department id: that would be a cross-department write.
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname = 'set_aftercall_enabled'
                and pg_get_function_identity_arguments(p.oid) <> 'p_enabled boolean') then
    raise exception 'Post-condition failed: a set_aftercall_enabled overload exists with different arguments. Rolling back.';
  end if;
end
$post$;

commit;

-- After commit:
--   notify pgrst, 'reload schema';
-- Without it the client's first call 404s against a stale schema cache — which
-- is indistinguishable, from the UI, from the function not existing at all.

-- =====================================================================
-- VERIFY — paste and run as-is. Ends in RAISE, which prints the report AND
-- rolls back, so the toggle is left exactly as it was found.
--
-- A BARE `select public.set_aftercall_enabled(true);` WILL RAISE 'Not
-- authorized' in the SQL editor and that is correct, not a fault: the editor
-- has no JWT claims, so there is no member and therefore no admin. Impersonate.
--
-- DO $v$
-- DECLARE v_email text; v_dept uuid; v_before boolean; v_on boolean; v_off boolean; v_read boolean;
-- BEGIN
--   SELECT lower(m.email), m.department_id INTO v_email, v_dept
--     FROM public.members m
--    WHERE m.email IS NOT NULL AND m.status IS DISTINCT FROM 'Inactive'
--      AND m.access && array['Department Admin','Project Admin']
--    ORDER BY m.id LIMIT 1;
--   IF v_email IS NULL THEN RAISE EXCEPTION 'No admin with an email to impersonate.'; END IF;
--   PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
--   IF NOT public.is_dept_admin() THEN RAISE EXCEPTION 'Impersonation did not take for %.', v_email; END IF;
--   SELECT aftercall_enabled INTO v_before FROM public.departments WHERE id = v_dept;
--   v_on := public.set_aftercall_enabled(true);
--   SELECT aftercall_enabled INTO v_read FROM public.departments WHERE id = v_dept;
--   v_off := public.set_aftercall_enabled(false);
--   RAISE EXCEPTION E'\nas % / dept %\nwas % · set true -> % (column %) · set false -> %\n%',
--     v_email, v_dept, v_before, v_on, v_read, v_off,
--     CASE WHEN v_on AND v_read AND NOT v_off THEN 'PASS' ELSE 'FAIL' END;
-- END $v$;
--
-- Ran 2026-09-19: PASS — was f, set true returned t with the column reading t,
-- set false returned f, rolled back to f.
--
-- WHAT THIS DOES NOT PROVE: that the toggle works FROM THE APP. That path sends
-- a real JWT and depends on the PostgREST schema cache having been reloaded.
-- It is tested by tapping the control in Settings, not here.
-- =====================================================================
