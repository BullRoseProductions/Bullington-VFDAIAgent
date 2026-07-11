-- =====================================================================
-- APPARATUS TRUCK CHECK - Slice 4d
-- resolve_apparatus_failure RPC: wire the (until-now inert) 4a resolved_*
-- columns. Leadership records that a FAILED item on a FINALIZED check has
-- been dealt with (fixed / accounted for), with a note + who + when. The
-- original fail stays immutable; the resolution rides alongside.
--
-- Enforces ALL of:
--   - leadership only: is_canmanage() = Board Member / Department Admin /
--     Officer (this is the oversight action, per the original design)
--   - dept ownership of the result row
--   - the result is a FAIL (can't resolve a pass)
--   - its check is state='finalized' (can't resolve a draft mark)
--   - not already resolved
--   - a resolution note is required (parallel to fail-requires-note)
--   - row lock (FOR UPDATE) to prevent a double-resolve race
--
-- Sets resolved_at=now(), resolved_by, resolved_by_name (snapshot),
-- resolution_note. NEVER touches result / note / marked_* -- the recorded
-- failure is immutable.
--
-- REVOKE anon/public upfront (Supabase default-grant quirk). Idempotent:
-- CREATE OR REPLACE. Run VERIFICATION separately after.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.resolve_apparatus_failure(
  p_result_id       uuid,
  p_resolution_note text
)
RETURNS public.apparatus_check_results
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_member public.members;
  v_result public.apparatus_check_results;
  v_check  public.apparatus_checks;
  v_note   text := nullif(btrim(coalesce(p_resolution_note, '')), '');
begin
  -- 1. identity + leadership gate
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if not public.is_canmanage() then
    raise exception 'Only leadership (Board, Department Admin, or Officer) can resolve apparatus failures';
  end if;

  -- 2. lock the result row (prevents a double-resolve race)
  select * into v_result from public.apparatus_check_results where id = p_result_id for update;
  if v_result.id is null then
    raise exception 'Failure not found';
  end if;

  -- 3. dept ownership
  if v_result.department_id <> v_member.department_id then
    raise exception 'Not authorized: this record belongs to another department';
  end if;

  -- 4. must be a FAIL
  if v_result.result <> 'fail' then
    raise exception 'Only a failed item can be resolved';
  end if;

  -- 5. its check must be FINALIZED (not a draft mark)
  select * into v_check from public.apparatus_checks where id = v_result.check_id;
  if v_check.id is null then
    raise exception 'Parent check not found';
  end if;
  if v_check.state <> 'finalized' then
    raise exception 'This check is still in progress - finalize it before resolving failures';
  end if;

  -- 6. not already resolved
  if v_result.resolved_at is not null then
    raise exception 'This failure was already resolved by %', coalesce(v_result.resolved_by_name, 'someone');
  end if;

  -- 7. resolution note required
  if v_note is null then
    raise exception 'A resolution note is required - describe how it was fixed or accounted for';
  end if;

  -- 8. stamp the resolution. NEVER touch result / note / marked_* (fail is immutable).
  update public.apparatus_check_results
     set resolved_at      = now(),
         resolved_by      = v_member.id,
         resolved_by_name = v_member.name,
         resolution_note  = v_note
   where id = p_result_id
   returning * into v_result;

  -- ---------------------------------------------------------------
  -- 9. OPTION A (flag-clearing) -- ENABLED (Ashlea's call).
  --    Clear the apparatus flag back to 'Pass' (READY) ONLY when NO open
  --    (unresolved) failures remain on the rig across ALL its finalized
  --    checks. The NOT EXISTS runs AFTER step 8 stamped this failure resolved,
  --    so it counts every OTHER still-open failure too: if the rig has 3 open
  --    failures and you resolve 1, this finds the other 2 and the flag stays
  --    up; the flag only clears when the last one is resolved. Deliberately
  --    does NOT touch last_check_at / checked_by (resolving is not a check).
  -- ---------------------------------------------------------------
  if v_check.apparatus_id is not null and not exists (
    select 1
    from public.apparatus_check_results r2
    join public.apparatus_checks c2 on c2.id = r2.check_id
    where c2.apparatus_id = v_check.apparatus_id
      and c2.state = 'finalized'
      and r2.result = 'fail'
      and r2.resolved_at is null
  ) then
    update public.apparatus set status = 'Pass' where id = v_check.apparatus_id;
  end if;

  return v_result;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.resolve_apparatus_failure(uuid, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.resolve_apparatus_failure(uuid, text) TO authenticated;

-- proves creation in THIS run - expect one row:
select proname, prosecdef, pg_get_function_result(oid) as returns
from pg_proc where proname = 'resolve_apparatus_failure';

-- =====================================================================
-- VERIFICATION (run separately after the migration)
-- =====================================================================
-- -- 1. Function present, SECURITY DEFINER, returns the result row:
-- select proname, prosecdef, pg_get_function_result(oid) as returns
-- from pg_proc where proname = 'resolve_apparatus_failure';
-- --   expect: resolve_apparatus_failure | t | apparatus_check_results
--
-- -- 2. Authenticated-only (no anon, no PUBLIC):
-- select r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
-- from pg_proc p
-- cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
-- where p.proname = 'resolve_apparatus_failure';
-- --   expect: anon=f, authenticated=t, service_role=t
--
-- -- 3. Open failures the escalation will surface (fail + finalized + unresolved):
-- select r.id, c.apparatus_name, r.item_label, r.note, r.marked_by_name, r.marked_at
-- from public.apparatus_check_results r
-- join public.apparatus_checks c on c.id = r.check_id
-- where r.result = 'fail' and r.resolved_at is null and c.state = 'finalized'
-- order by r.marked_at desc;
--
-- -- 4. After calling resolve on one id, confirm the trail is stamped and the
-- --    factual columns are untouched:
-- -- select id, result, note, marked_by_name,
-- --        resolved_at, resolved_by_name, resolution_note
-- -- from public.apparatus_check_results where id = '<the-result-id>';
