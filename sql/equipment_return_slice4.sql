-- =====================================================================
-- EQUIPMENT RETURN - Slice 4 (return flow: member marks, manager confirms)
--
-- Two-step return, mirroring apparatus reset-on-return-to-service:
--   1. member (current holder) flags an item returned  -> mark_equipment_returned
--      (stamps return_requested_* on the OPEN period; does NOT close it or change
--       equipment.status — liability stays with the holder until physical handoff)
--   2. member can undo before confirm                   -> cancel_equipment_return
--   3. manager/DA confirms receipt in person            -> confirm_equipment_return
--      (closes the period, resets the item to in_inventory, records condition +
--       optional condition photo; condition defaults to 'Needs attention' — returned
--       gear is UNVERIFIED until inspected, never silently Serviceable)
--
-- "Returned but not yet confirmed" = open custody row (closed_at IS NULL) with
-- return_requested_at IS NOT NULL. The one-open invariant stays intact throughout.
-- All three: SECURITY DEFINER, actor from my_member_id(), FOR UPDATE row lock.
-- Builds on equipment_custody_slice2.sql. Run VERIFICATION separately.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Migration — the pending-return stamp (the only schema change this slice)
-- ---------------------------------------------------------------------
alter table public.equipment_custody
  add column if not exists return_requested_at      timestamptz,
  add column if not exists return_requested_by      uuid references public.members(id) on delete set null,
  add column if not exists return_requested_by_name text;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- mark_equipment_returned — holder flags an item returned (pending stamp only)
-- ---------------------------------------------------------------------
create or replace function public.mark_equipment_returned(
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
  -- identity
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;

  -- lock the open custody period for this item (serializes mark/confirm)
  select * into v_custody
    from public.equipment_custody
   where equipment_id = p_equipment_id and closed_at is null
   for update;
  if v_custody.id is null then
    raise exception 'That item has no open custody period to return';
  end if;

  -- holder-only: you can only return what you currently hold
  if v_custody.holder_member_id <> v_member.id then
    raise exception 'Only the current holder can mark this item returned';
  end if;

  -- stamp the pending-return request. Deliberately does NOT close the period
  -- or touch equipment.status: liability stays with the holder until a manager
  -- physically confirms receipt.
  update public.equipment_custody
     set return_requested_at      = now(),
         return_requested_by      = v_member.id,
         return_requested_by_name = v_member.name
   where id = v_custody.id
   returning * into v_custody;

  return v_custody;
end;
$function$;

revoke execute on function public.mark_equipment_returned(uuid) from anon, public;
grant  execute on function public.mark_equipment_returned(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- cancel_equipment_return — holder undoes a mis-tap before a manager confirms
-- ---------------------------------------------------------------------
create or replace function public.cancel_equipment_return(
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
  -- identity
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;

  -- lock the open custody period for this item (serializes mark/cancel/confirm)
  select * into v_custody
    from public.equipment_custody
   where equipment_id = p_equipment_id and closed_at is null
   for update;
  if v_custody.id is null then
    raise exception 'That item has no open custody period';
  end if;

  -- holder-only: you can only undo your own return request
  if v_custody.holder_member_id <> v_member.id then
    raise exception 'Only the current holder can cancel a return request';
  end if;

  -- clear the pending-return stamp (no-op if it was never requested)
  update public.equipment_custody
     set return_requested_at      = null,
         return_requested_by      = null,
         return_requested_by_name = null
   where id = v_custody.id
   returning * into v_custody;

  return v_custody;
end;
$function$;

revoke execute on function public.cancel_equipment_return(uuid) from anon, public;
grant  execute on function public.cancel_equipment_return(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- confirm_equipment_return — manager/DA confirms receipt: closes the period,
-- resets the item, records condition + optional condition photo.
-- ---------------------------------------------------------------------
create or replace function public.confirm_equipment_return(
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
    raise exception 'Only an equipment manager or department admin can confirm a return';
  end if;

  -- returned gear is condition-UNVERIFIED until inspected: default Needs attention,
  -- never silently Serviceable (mirrors apparatus reset on return-to-service).
  if v_cond not in ('Serviceable', 'Needs attention', 'Out of service') then
    raise exception 'Invalid condition: %', v_cond;
  end if;

  -- lock the open custody period
  select * into v_custody
    from public.equipment_custody
   where equipment_id = p_equipment_id and closed_at is null
   for update;
  if v_custody.id is null then
    raise exception 'That item has no open custody period to confirm';
  end if;

  -- same-department guard
  if v_custody.department_id <> v_member.department_id then
    raise exception 'Not authorized: this item belongs to another department';
  end if;

  -- close the period (works whether or not the member pre-flagged it returned:
  -- a manager can take an item back directly)
  update public.equipment_custody
     set closed_at          = now(),
         close_action       = 'returned',
         condition_at_close = v_cond,
         closed_by          = v_member.id,
         closed_by_name     = v_member.name
   where id = v_custody.id
   returning * into v_custody;

  -- reset the item: back in inventory, holder cleared, condition = verified value
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

revoke execute on function public.confirm_equipment_return(uuid, text, text) from anon, public;
grant  execute on function public.confirm_equipment_return(uuid, text, text) to authenticated;

-- =====================================================================
-- VERIFICATION (run separately; the editor shows the LAST grid)
-- =====================================================================

-- (a) all three functions exist, SECURITY DEFINER:
-- select proname, prosecdef from pg_proc
-- where proname in ('mark_equipment_returned','cancel_equipment_return','confirm_equipment_return')
-- order by proname;   -- expect 3 rows | prosecdef = t

-- (b) anon must be FALSE for all three, authenticated TRUE:
-- select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
-- from pg_proc p
-- cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
-- where p.proname in ('mark_equipment_returned','cancel_equipment_return','confirm_equipment_return')
-- order by p.proname, r.rolname;   -- expect: anon = f for all ; authenticated = t ; service_role = t

-- (c) the 3 new columns landed:
-- select column_name from information_schema.columns
-- where table_schema='public' and table_name='equipment_custody'
--   and column_name in ('return_requested_at','return_requested_by','return_requested_by_name')
-- order by column_name;   -- expect 3 rows
