-- Self-sign block for set_onboarding_item.
-- A leader (is_canmanage) records onboarding progress for members in their department,
-- but NOT for themselves — a member doesn't self-attest their own onboarding; a mentor or
-- officer signs it off. Identical to sql/onboarding_signoff.sql's definition except for the
-- one added guard (marked below). Server-side: protects every client the moment it's applied,
-- including builds already on phones.
-- Run in the Supabase SQL editor. Plain DDL, no BEGIN/COMMIT, so each statement auto-commits
-- (an uncommitted editor transaction rolls back silently if the tab dies).

create or replace function public.set_onboarding_item(p_member_id uuid, p_item_id uuid, p_done boolean)
 returns public.onboarding_progress
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_done boolean := coalesce(p_done, false);   -- null means "not done", never "leave as is"
  v_row  public.onboarding_progress;
begin
  if not public.is_canmanage() then
    raise exception 'Not authorized';
  end if;
  if v_dept is null or v_me is null then
    raise exception 'We could not match your login to a department.';
  end if;
  -- >>> SELF-SIGN BLOCK (the only change): a leader can't sign off their OWN onboarding.
  if p_member_id = v_me then
    raise exception 'You can''t sign off your own onboarding — a mentor or officer does.';
  end if;
  -- <<<
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if not exists (select 1 from public.onboarding_items where id = p_item_id and department_id = v_dept) then
    raise exception 'That checklist item is not in your department.';
  end if;
  -- The mentor item's "done" IS members.mentor_id; a progress row for it would be a second, divergent truth.
  if exists (select 1 from public.onboarding_items where id = p_item_id and is_mentor) then
    raise exception 'The mentor item completes when a mentor is assigned.';
  end if;

  insert into public.onboarding_progress (department_id, member_id, item_id, done, checked_by, checked_at)
  values (v_dept, p_member_id, p_item_id, v_done,
          case when v_done then v_me end,
          case when v_done then now() end)
  on conflict (member_id, item_id) do update
     set done       = excluded.done,
         checked_by = excluded.checked_by,
         checked_at = excluded.checked_at
  returning * into v_row;

  return v_row;
end;
$function$;

revoke all    on function public.set_onboarding_item(uuid, uuid, boolean) from anon, public;
grant execute on function public.set_onboarding_item(uuid, uuid, boolean) to authenticated, service_role;

notify pgrst, 'reload schema';
