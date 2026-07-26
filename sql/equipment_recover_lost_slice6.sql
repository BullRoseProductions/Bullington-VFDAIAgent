-- =====================================================================
-- EQUIPMENT RECOVER / LOST - Slice 6 (manager reconciliation actions)
--
-- Two manager/DA actions on a currently-HELD item, both mirroring
-- confirm_equipment_return's safety shape (SECURITY DEFINER, is_equipment_manager
-- OR is_dept_admin gate, same-department guard, FOR UPDATE lock on the open period):
--
--   recover_equipment    -> a manager reclaims a held item WITHOUT the holder's
--                           return (found in station / holder unreachable). Closes
--                           the open period stamped close_action='manager_recovery',
--                           resets the unit to in_inventory, condition defaults
--                           'Needs attention' (recovered gear is UNVERIFIED), optional
--                           condition photo. The distinct action is the point: the
--                           ledger shows a reconciliation, not a clean handback.
--   mark_equipment_lost  -> records gear as gone. Closes the open period stamped
--                           close_action='marked_lost', clears the holder, sets the
--                           unit status to 'lost'. The closed row preserves who held
--                           it when it was lost (holder_member_id/name snapshots).
--
-- The close_action CHECK (from slice 2) ALREADY allows 'manager_recovery' and
-- 'marked_lost' — so there is NO schema change. Just two functions + grants + a
-- PostgREST schema reload (so supabase.rpc can see the new functions).
-- Builds on equipment_custody_slice2.sql + equipment_return_slice4.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- recover_equipment — manager/DA reclaims a held item (reconciliation).
-- confirm_equipment_return's twin, but stamped close_action='manager_recovery'.
-- ---------------------------------------------------------------------
create or replace function public.recover_equipment(
  p_equipment_id uuid,
  p_condition    text default 'Needs attention',
  p_photo_path   text default null
)
returns public.equipment_custody
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_member  public.members;
  v_custody public.equipment_custody;
  v_cond    text := coalesce(nullif(btrim(p_condition), ''), 'Needs attention');
  v_photo   text := nullif(btrim(coalesce(p_photo_path, '')), '');
begin
  -- identity + manager/DA gate
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if not (public.is_equipment_manager() or public.is_dept_admin()) then
    raise exception 'Only an equipment manager or department admin can recover an item';
  end if;

  -- recovered gear is condition-UNVERIFIED until inspected (mirrors confirm_return)
  if v_cond not in ('Serviceable', 'Needs attention', 'Out of service') then
    raise exception 'Invalid condition: %', v_cond;
  end if;

  -- lock the open custody period
  select * into v_custody
    from public.equipment_custody
   where equipment_id = p_equipment_id and closed_at is null
   for update;
  if v_custody.id is null then
    raise exception 'That item has no open custody period to recover';
  end if;

  -- same-department guard
  if v_custody.department_id <> v_member.department_id then
    raise exception 'Not authorized: this item belongs to another department';
  end if;

  -- close the period as a manager recovery (distinct from a clean 'returned')
  update public.equipment_custody
     set closed_at          = now(),
         close_action       = 'manager_recovery',
         condition_at_close = v_cond,
         closed_by          = v_member.id,
         closed_by_name     = v_member.name
   where id = v_custody.id
   returning * into v_custody;

  -- reset the item: back in inventory, holder cleared, condition = the recorded value
  update public.equipment
     set status              = 'in_inventory',
         condition           = v_cond,
         current_holder_id   = null,
         current_holder_name = null
   where id = p_equipment_id;

  -- optional condition-at-close photo, linked to THIS custody period
  if v_photo is not null then
    insert into public.equipment_photos
      (department_id, equipment_id, custody_id, kind, storage_path, caption, sort_order, uploaded_by)
    values
      (v_member.department_id, p_equipment_id, v_custody.id, 'condition', v_photo, '', 2, v_member.id);
  end if;

  return v_custody;
end;
$function$;

revoke execute on function public.recover_equipment(uuid, text, text) from anon, public;
grant  execute on function public.recover_equipment(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- mark_equipment_lost — manager/DA records a held item as lost.
-- ---------------------------------------------------------------------
create or replace function public.mark_equipment_lost(
  p_equipment_id uuid
)
returns public.equipment_custody
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_member  public.members;
  v_custody public.equipment_custody;
begin
  -- identity + manager/DA gate
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if not (public.is_equipment_manager() or public.is_dept_admin()) then
    raise exception 'Only an equipment manager or department admin can mark an item lost';
  end if;

  -- lock the open custody period
  select * into v_custody
    from public.equipment_custody
   where equipment_id = p_equipment_id and closed_at is null
   for update;
  if v_custody.id is null then
    raise exception 'That item has no open custody period to mark lost';
  end if;

  -- same-department guard
  if v_custody.department_id <> v_member.department_id then
    raise exception 'Not authorized: this item belongs to another department';
  end if;

  -- close the period as lost; the closed row preserves who held it (holder_* snapshots)
  update public.equipment_custody
     set closed_at      = now(),
         close_action   = 'marked_lost',
         closed_by      = v_member.id,
         closed_by_name = v_member.name
   where id = v_custody.id
   returning * into v_custody;

  -- the unit is gone: status 'lost', holder cleared (condition left as-is)
  update public.equipment
     set status              = 'lost',
         current_holder_id   = null,
         current_holder_name = null
   where id = p_equipment_id;

  return v_custody;
end;
$function$;

revoke execute on function public.mark_equipment_lost(uuid) from anon, public;
grant  execute on function public.mark_equipment_lost(uuid) to authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
-- VERIFICATION (run separately; the runner below does this automatically)
-- =====================================================================
-- (a) both functions exist, SECURITY DEFINER:
-- select proname, prosecdef from pg_proc
-- where proname in ('recover_equipment','mark_equipment_lost') order by proname;   -- expect 2 rows | prosecdef = t
--
-- (b) anon FALSE, authenticated TRUE:
-- select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
-- from pg_proc p cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
-- where p.proname in ('recover_equipment','mark_equipment_lost')
-- order by p.proname, r.rolname;   -- expect anon = f ; authenticated = t ; service_role = t
