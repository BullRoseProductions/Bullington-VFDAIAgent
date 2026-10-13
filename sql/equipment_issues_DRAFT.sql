-- =====================================================================
-- B3. Report issue — equipment_issues + RLS + two RPCs. DRAFT. NOT APPLIED.
-- (Brief B4C_Equipment_ReportIssue_Brief not found in the repo — built from the spec text.)
--
-- Who: a member reports on gear they HOLD (open custody period, closed_at null).
--      Equipment managers / DA (is_equipment_manager() or is_dept_admin(), own dept) read
--      all and resolve — the same gate as "managers read all custody".
-- Shape mirrors the custody ledger: RLS is READ-ONLY; every write goes through a
-- SECURITY DEFINER RPC with the actor from my_member_id() and names snapshotted.
-- Condition stays manager-set on inspection: nothing here writes equipment.condition or
-- equipment.status. The "Needs attention" flag is DERIVED in the UI — an item shows it while
-- it has an issue row with resolved_at IS NULL (read via the policies below).
-- Resolve gate = is_equipment_manager() OR is_dept_admin(), own dept (managers do the gear work).
-- =====================================================================
begin;

create table if not exists public.equipment_issues (
  id                uuid primary key default gen_random_uuid(),
  department_id     uuid not null references public.departments(id) on delete cascade,
  equipment_id      uuid not null references public.equipment(id) on delete cascade,
  custody_id        uuid references public.equipment_custody(id) on delete set null,
  equipment_name    text not null,
  kind              text not null check (kind in ('damaged','not_working','missing_part','other')),
  note              text not null check (length(btrim(note)) between 1 and 1000),
  reported_by       uuid references public.members(id) on delete set null,
  reported_by_name  text not null,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  resolved_by       uuid references public.members(id) on delete set null,
  resolved_by_name  text,
  resolution_note   text check (resolution_note is null or length(resolution_note) <= 1000),
  constraint equipment_issues_resolved_shape check ((resolved_at is null) = (resolved_by_name is null))
);
create index if not exists equipment_issues_dept_open on public.equipment_issues (department_id) where resolved_at is null;
create index if not exists equipment_issues_equipment on public.equipment_issues (equipment_id, created_at desc);

alter table public.equipment_issues enable row level security;
drop policy if exists "managers read issues" on public.equipment_issues;
create policy "managers read issues" on public.equipment_issues for select to authenticated
  using ((is_equipment_manager() or is_dept_admin()) and department_id = my_department_id());
drop policy if exists "members read own issues" on public.equipment_issues;
create policy "members read own issues" on public.equipment_issues for select to authenticated
  using (reported_by = my_member_id());
-- no INSERT / UPDATE / DELETE policies: writes only via the RPCs below
revoke insert, update, delete on public.equipment_issues from anon, authenticated;

create or replace function public.report_equipment_issue(p_equipment_id uuid, p_kind text, p_note text)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_member  public.members;
  v_custody public.equipment_custody;
  v_id      uuid;
begin
  select * into v_member from public.members where id = my_member_id();
  if v_member.id is null then raise exception 'No member record for the signed-in user'; end if;
  select * into v_custody from public.equipment_custody
   where equipment_id = p_equipment_id and closed_at is null
     and holder_member_id = v_member.id and department_id = v_member.department_id;
  if v_custody.id is null then raise exception 'You can only report gear you are signed for.'; end if;
  if p_note is null or length(btrim(p_note)) = 0 then raise exception 'Describe the issue.'; end if;
  insert into public.equipment_issues (department_id, equipment_id, custody_id, equipment_name, kind, note, reported_by, reported_by_name)
  values (v_member.department_id, p_equipment_id, v_custody.id, v_custody.equipment_name, p_kind, btrim(p_note), v_member.id, v_member.name)
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.resolve_equipment_issue(p_issue_id uuid, p_note text default null)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_member public.members;
  v_id     uuid;
begin
  if not (is_equipment_manager() or is_dept_admin()) then raise exception 'Not authorized'; end if;
  select * into v_member from public.members where id = my_member_id();
  update public.equipment_issues
     set resolved_at = now(), resolved_by = v_member.id, resolved_by_name = v_member.name,
         resolution_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_issue_id and department_id = my_department_id() and resolved_at is null
  returning id into v_id;
  if v_id is null then raise exception 'Issue not found or already resolved.'; end if;
  return v_id;
end;
$function$;

revoke all    on function public.report_equipment_issue(uuid, text, text)  from anon, public;
revoke all    on function public.resolve_equipment_issue(uuid, text)       from anon, public;
grant execute on function public.report_equipment_issue(uuid, text, text)  to authenticated;
grant execute on function public.resolve_equipment_issue(uuid, text)       to authenticated;

do $post$
begin
  if has_function_privilege('anon', 'public.report_equipment_issue(uuid, text, text)', 'EXECUTE')
  or has_function_privilege('anon', 'public.resolve_equipment_issue(uuid, text)', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE an issue RPC. Rolling back.';
  end if;
  if has_table_privilege('authenticated', 'public.equipment_issues', 'INSERT') then
    raise exception 'Post-condition failed: authenticated can INSERT equipment_issues directly. Rolling back.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.equipment_issues'::regclass) then
    raise exception 'Post-condition failed: RLS off on equipment_issues. Rolling back.';
  end if;
end
$post$;

notify pgrst, 'reload schema';
commit;
