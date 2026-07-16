-- =====================================================================
-- YOUR SIX 6c - member's "reach out" person.
-- A deliberate, tightly-scoped write hole in an otherwise leader-only members table.
-- =====================================================================

-- Nullable ref to another roster member; if that member is deleted the pointer clears itself.
alter table public.members
  add column if not exists reach_out_member_id uuid
    references public.members(id) on delete set null;

create or replace function public.set_reach_out_person(p_target uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me   uuid := public.my_member_id();   -- the caller, resolved server-side from auth (never passed in)
  v_dept uuid;
begin
  if v_me is null then
    raise exception 'No member record for the signed-in user';
  end if;

  if p_target is not null then           -- NULL is allowed = clear your choice
    if p_target = v_me then
      raise exception 'You cannot set yourself as your reach-out person';
    end if;
    -- GUARANTEE 3: same-department target validation. The target must be a real member
    -- of the CALLER's own department, or the call is rejected.
    select department_id into v_dept from public.members where id = v_me;
    if not exists (
      select 1 from public.members m
      where m.id = p_target and m.department_id = v_dept
    ) then
      raise exception 'That person is not in your department';
    end if;
  end if;

  -- GUARANTEE 1 (own row only): WHERE id = my_member_id() -- can only ever touch the caller's row.
  -- GUARANTEE 2 (one column only): SET reach_out_member_id -- no other column is writable here.
  update public.members
     set reach_out_member_id = p_target
   where id = v_me;
end;
$function$;

-- GUARANTEE 4: anon can never call it; only authenticated users can.
revoke execute on function public.set_reach_out_person(uuid) from anon, public;
grant  execute on function public.set_reach_out_person(uuid) to authenticated;

-- =====================================================================
-- VERIFY (run separately)
-- =====================================================================
-- 1) column exists + FK is ON DELETE SET NULL:
-- select con.conname, confdeltype from pg_constraint con
-- join pg_class rel on rel.oid=con.conrelid
-- where rel.relname='members' and con.contype='f'
--   and con.conname ilike '%reach_out%';   -- expect confdeltype='n' (SET NULL)
-- 2) function is SECURITY DEFINER + anon locked out:
-- select prosecdef,
--        has_function_privilege('anon','public.set_reach_out_person(uuid)','EXECUTE')          as anon_exec,
--        has_function_privilege('authenticated','public.set_reach_out_person(uuid)','EXECUTE') as auth_exec
-- from pg_proc where proname='set_reach_out_person';   -- expect: t, false, true
