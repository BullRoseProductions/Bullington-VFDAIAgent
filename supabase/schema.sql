-- =====================================================================
-- B4C · POA Member Hub — schema.sql
-- Founded on the VFD patterns: multi-tenant by department, roles as a
-- text[] access array, and a meetings/minutes/action-items lifecycle
-- that is RPC-only, server-stamped, and 0-row-guarded ("proof, not promises").
-- Run this in the Supabase SQL Editor (once), then run seed.sql.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- ORGANIZATIONS (a POA / local / lodge) ----------
create table if not exists departments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  org_type   text not null default 'poa' check (org_type in ('fire','ems','poa')),
  created_at timestamptz not null default now()
);

-- ---------- MEMBERS (identity bridges by email, like VFD) ----------
-- access is a text[] role array. Checks use && (overlap), never scalar IN.
-- Roles: ProjectAdmin, DeptAdmin, Board, Officer, Member
create table if not exists members (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  email         text not null,
  full_name     text not null,
  badge         text,
  district      text,
  access        text[] not null default array['Member'],
  standing      text not null default 'Good',
  status        text not null default 'active',
  created_at    timestamptz not null default now()
);
create unique index if not exists members_dept_email
  on members (department_id, lower(email));

-- ---------- MEETINGS + AGENDA + ACTION ITEMS ----------
create table if not exists meetings (
  id              uuid primary key default gen_random_uuid(),
  department_id   uuid not null references departments(id) on delete cascade,
  title           text not null,
  kind            text not null default 'general' check (kind in ('general','officer','board','special')),
  scheduled_at    timestamptz,
  location        text,
  status          text not null default 'open' check (status in ('open','completed','cancelled','archived')),
  minutes_body    text,
  minutes_version int  not null default 0,
  minutes_filed_at timestamptz,
  created_by      uuid references members(id),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  archive_after   timestamptz          -- set to completed_at + 14 days (grace before permanent archive)
);

create table if not exists agenda_items (
  id         uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  position   int  not null default 0,
  title      text not null,
  notes      text,
  created_at timestamptz not null default now()
);

create table if not exists action_items (
  id              uuid primary key default gen_random_uuid(),
  meeting_id      uuid references meetings(id) on delete set null,
  department_id   uuid not null references departments(id) on delete cascade,
  title           text not null,
  owner_member_id uuid references members(id),
  due_date        date,
  status          text not null default 'open' check (status in ('open','done')),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

-- =====================================================================
-- IDENTITY / ROLE HELPERS (security definer, like VFD's chokepoints)
-- =====================================================================
create or replace function my_member_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from members where lower(email) = lower(auth.email()) limit 1
$$;

create or replace function my_department_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select department_id from members where lower(email) = lower(auth.email()) limit 1
$$;

create or replace function is_canmanage() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((
    select access && array['Board','DeptAdmin','Officer','ProjectAdmin']::text[]
    from members where lower(email) = lower(auth.email()) limit 1
  ), false)
$$;

create or replace function current_member() returns members
  language sql stable security definer set search_path = public as $$
  select * from members where lower(email) = lower(auth.email()) limit 1
$$;

-- =====================================================================
-- ROW LEVEL SECURITY — read your own org; direct writes only for managers
-- =====================================================================
alter table departments  enable row level security;
alter table members      enable row level security;
alter table meetings     enable row level security;
alter table agenda_items enable row level security;
alter table action_items enable row level security;

drop policy if exists dep_read  on departments;
create policy dep_read  on departments  for select using (id = my_department_id());

drop policy if exists mem_read  on members;
create policy mem_read  on members      for select using (department_id = my_department_id());

drop policy if exists meet_read on meetings;
create policy meet_read on meetings     for select using (department_id = my_department_id());
drop policy if exists meet_write on meetings;
create policy meet_write on meetings    for all
  using (department_id = my_department_id() and is_canmanage())
  with check (department_id = my_department_id() and is_canmanage());

drop policy if exists agen_read on agenda_items;
create policy agen_read on agenda_items for select
  using (meeting_id in (select id from meetings where department_id = my_department_id()));
drop policy if exists agen_write on agenda_items;
create policy agen_write on agenda_items for all
  using (meeting_id in (select id from meetings where department_id = my_department_id()) and is_canmanage())
  with check (meeting_id in (select id from meetings where department_id = my_department_id()) and is_canmanage());

drop policy if exists act_read on action_items;
create policy act_read on action_items  for select using (department_id = my_department_id());
drop policy if exists act_write on action_items;
create policy act_write on action_items for all
  using (department_id = my_department_id() and is_canmanage())
  with check (department_id = my_department_id() and is_canmanage());

-- =====================================================================
-- LIFECYCLE RPCs — the only way status/minutes change. Server-stamped,
-- role-checked, 0-row-guarded. This is the VFD "proof, not promises" spine.
-- =====================================================================
create or replace function complete_meeting(p_meeting uuid) returns meetings
  language plpgsql security definer set search_path = public as $$
declare r meetings;
begin
  if not is_canmanage() then raise exception 'not authorized'; end if;
  update meetings
     set status = 'completed', completed_at = now(), archive_after = now() + interval '14 days'
   where id = p_meeting and department_id = my_department_id() and status = 'open'
   returning * into r;
  if r.id is null then raise exception 'meeting not open or not found'; end if;  -- 0-row guard
  return r;
end $$;

create or replace function cancel_meeting(p_meeting uuid) returns meetings
  language plpgsql security definer set search_path = public as $$
declare r meetings;
begin
  if not is_canmanage() then raise exception 'not authorized'; end if;
  update meetings set status = 'cancelled', cancelled_at = now()
   where id = p_meeting and department_id = my_department_id() and status = 'open'
   returning * into r;
  if r.id is null then raise exception 'meeting not open or not found'; end if;
  return r;
end $$;

-- version-on-write: every filing bumps minutes_version and re-stamps the time
create or replace function file_minutes(p_meeting uuid, p_body text) returns meetings
  language plpgsql security definer set search_path = public as $$
declare r meetings;
begin
  if not is_canmanage() then raise exception 'not authorized'; end if;
  update meetings
     set minutes_body = p_body,
         minutes_version = minutes_version + 1,
         minutes_filed_at = now()
   where id = p_meeting and department_id = my_department_id()
   returning * into r;
  if r.id is null then raise exception 'meeting not found'; end if;
  return r;
end $$;

-- an action item's status can be set by its owner OR a manager; server-stamped
create or replace function set_action_status(p_action uuid, p_status text) returns action_items
  language plpgsql security definer set search_path = public as $$
declare r action_items; a action_items;
begin
  if p_status not in ('open','done') then raise exception 'invalid status'; end if;
  select * into a from action_items where id = p_action and department_id = my_department_id();
  if a.id is null then raise exception 'action item not found'; end if;
  if not (is_canmanage() or a.owner_member_id = my_member_id())
    then raise exception 'not authorized'; end if;
  update action_items
     set status = p_status,
         completed_at = case when p_status = 'done' then now() else null end
   where id = p_action and department_id = my_department_id()
   returning * into r;
  if r.id is null then raise exception 'update failed'; end if;
  return r;
end $$;

grant execute on function
  my_member_id(), my_department_id(), is_canmanage(), current_member(),
  complete_meeting(uuid), cancel_meeting(uuid), file_minutes(uuid, text), set_action_status(uuid, text)
  to authenticated;
