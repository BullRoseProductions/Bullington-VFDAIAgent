-- =====================================================================
-- APPARATUS TRUCK CHECK - Slice 4c
-- finalize_check RPC: turn an in-progress draft into an immutable finalized
-- record. Flips state -> 'finalized', stamps the finalizer (person of note),
-- computes outcome + counts, and updates the apparatus list-view pointer.
--
-- Enforces ALL of:
--   - active member (not Inactive) + dept ownership of the check
--   - check.state = 'in_progress'  (cannot re-finalize)
--   - mid-draft rule: EVERY currently-active checklist item on the apparatus
--     must have a result in THIS check, else reject ("N item(s) still
--     unmarked"). Retired items (active=false) keep their marks but are not
--     counted as active, so they never block; a NEW active item added
--     mid-draft that is unmarked DOES block.
--   - row lock (FOR UPDATE) to prevent a double-finalize race
--
-- On finalize:
--   - state='finalized', performed_by = my_member_id(), performed_by_name
--     (snapshot), performed_at = now()
--   - outcome = 'fail' if ANY mark in the check is a fail, else 'pass'
--     (counts/outcome are over ALL results for the check, i.e. every mark,
--     including marks on items retired mid-draft -- consistent with what
--     ApparatusHistory displays by check_id)
--   - pass_count / fail_count from the check's results
--   - apparatus pointer: last_check_at, status ('Needs attention' on fail,
--     else 'Pass'), checked_by = finalizer's member id (live column names,
--     confirmed against the app's own apparatus queries)
--
-- ANY active member may finalize (oversight is the 4d failure escalation,
-- not a finalize gate). Idempotent: CREATE OR REPLACE. Run VERIFICATION
-- separately after.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.finalize_check(p_check_id uuid)
RETURNS public.apparatus_checks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_member        public.members;
  v_check         public.apparatus_checks;
  v_active_count  int;
  v_marked_active int;
  v_unmarked      int;
  v_pass_count    int;
  v_fail_count    int;
  v_outcome       text;
begin
  -- 1. identity: an ACTIVE member for the signed-in user
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if v_member.status = 'Inactive' then
    raise exception 'Inactive members cannot finalize checks';
  end if;

  -- 2. lock the check row (prevents a double-finalize race)
  select * into v_check from public.apparatus_checks where id = p_check_id for update;
  if v_check.id is null then
    raise exception 'Check not found';
  end if;
  if v_check.department_id <> v_member.department_id then
    raise exception 'Not authorized: this check belongs to another department';
  end if;
  if v_check.state <> 'in_progress' then
    raise exception 'This check is already finalized';
  end if;

  -- 3. mid-draft rule: every currently-active item must have a result in THIS check
  select count(*) into v_active_count
  from public.apparatus_check_items i
  where i.apparatus_id = v_check.apparatus_id and i.active = true;

  select count(*) into v_marked_active
  from public.apparatus_check_items i
  join public.apparatus_check_results r
    on r.item_id = i.id and r.check_id = p_check_id
  where i.apparatus_id = v_check.apparatus_id and i.active = true;

  if v_active_count = 0 then
    raise exception 'This truck has no checklist items to finalize';
  end if;
  v_unmarked := v_active_count - v_marked_active;
  if v_unmarked > 0 then
    raise exception '% item(s) still unmarked - mark every active item before finalizing', v_unmarked;
  end if;

  -- 4. outcome + counts over ALL marks in this check (active or since-retired)
  select
    count(*) filter (where result = 'pass'),
    count(*) filter (where result = 'fail')
  into v_pass_count, v_fail_count
  from public.apparatus_check_results
  where check_id = p_check_id;

  v_outcome := case when v_fail_count > 0 then 'fail' else 'pass' end;

  -- 5. finalize: flip state, stamp the finalizer, set outcome + counts
  update public.apparatus_checks
     set state             = 'finalized',
         performed_by      = v_member.id,
         performed_by_name = v_member.name,
         performed_at      = now(),
         outcome           = v_outcome,
         pass_count        = v_pass_count,
         fail_count        = v_fail_count
   where id = p_check_id
   returning * into v_check;

  -- 6. apparatus list-view pointer (live column names: last_check_at, status, checked_by)
  update public.apparatus
     set last_check_at = now(),
         status        = case when v_outcome = 'fail' then 'Needs attention' else 'Pass' end,
         checked_by    = v_member.id
   where id = v_check.apparatus_id;

  return v_check;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.finalize_check(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.finalize_check(uuid) TO authenticated;

-- proves creation in THIS run - expect one row:
select proname, prosecdef, pg_get_function_result(oid) as returns
from pg_proc where proname = 'finalize_check';

-- =====================================================================
-- VERIFICATION (run separately after the migration)
-- =====================================================================
-- -- 1. Function present, SECURITY DEFINER, returns the check row:
-- select proname, prosecdef, pg_get_function_result(oid) as returns
-- from pg_proc where proname = 'finalize_check';
-- --   expect: finalize_check | t | apparatus_checks
--
-- -- 2. Authenticated-only (no anon, no PUBLIC):
-- select r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
-- from pg_proc p
-- cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
-- where p.proname = 'finalize_check';
-- --   expect: anon=f, authenticated=t, service_role=t
--
-- -- 3. Behavior in a ROLLBACK tx: start a draft, try to finalize with an
-- --    unmarked active item (expect "N item(s) still unmarked"), then mark all
-- --    and finalize (expect state='finalized', outcome set, pointer updated).
-- -- begin;
-- --   select public.start_or_resume_check(
-- --     (select apparatus_id from public.apparatus_check_items where active limit 1)
-- --   ) as check_id \gset
-- --   -- with items unmarked, this should RAISE:
-- --   -- select public.finalize_check(:'check_id');
-- --   -- (mark every active item via mark_check_item, then:)
-- --   -- select state, outcome, pass_count, fail_count, performed_by_name
-- --   -- from public.finalize_check(:'check_id');
-- -- rollback;
