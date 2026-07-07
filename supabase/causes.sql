-- =====================================================================
-- B4C · POA Member Hub — causes.sql   (additive — safe to run after schema.sql)
--
-- Causes are 100% DATA, editable in-app by the board, scoped per org.
-- Onboarding a new POA = they add their own causes. Nothing here, and
-- nothing in the app code, names a specific association's initiatives.
-- =====================================================================

create table if not exists causes (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  name          text not null,
  tagline       text,
  description   text,
  status        text not null default 'active' check (status in ('active','archived')),
  external_url  text,            -- "we track it, we don't process it" — link out to donate / sign up
  goal_amount   numeric,         -- optional fundraising goal
  sort          int  not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists causes_dept on causes(department_id);

-- the "things inside" a cause: updates, contributions, participation, outcomes
create table if not exists cause_entries (
  id            uuid primary key default gen_random_uuid(),
  cause_id      uuid not null references causes(id) on delete cascade,
  department_id uuid not null references departments(id) on delete cascade,
  kind          text not null default 'update'
                  check (kind in ('update','contribution','participation','outcome')),
  label         text not null,
  amount        numeric,         -- countable + honest (contributions); never a fabricated total
  occurred_on   date,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists cause_entries_cause on cause_entries(cause_id);

alter table causes        enable row level security;
alter table cause_entries enable row level security;

-- any member of the org can SEE the causes
drop policy if exists cause_read on causes;
create policy cause_read on causes for select using (department_id = my_department_id());
drop policy if exists centry_read on cause_entries;
create policy centry_read on cause_entries for select using (department_id = my_department_id());

-- the board (canmanage) can add / edit / archive / delete — this is what makes it editable
drop policy if exists cause_write on causes;
create policy cause_write on causes for all
  using (department_id = my_department_id() and is_canmanage())
  with check (department_id = my_department_id() and is_canmanage());
drop policy if exists centry_write on cause_entries;
create policy centry_write on cause_entries for all
  using (department_id = my_department_id() and is_canmanage())
  with check (department_id = my_department_id() and is_canmanage());

-- OPTIONAL example so Fort Worth's demo isn't empty. This is DATA — delete it
-- anytime from the app. Comment these two lines out for a truly blank start.
insert into causes (department_id, name, tagline, external_url, goal_amount, sort)
select '00000000-0000-0000-0000-0000000000d1', 'Cops 4 Kids',
       'Holiday gifts for families in our districts', 'https://example.org/donate', 10000, 1
where exists (select 1 from departments where id='00000000-0000-0000-0000-0000000000d1')
  and not exists (select 1 from causes where department_id='00000000-0000-0000-0000-0000000000d1');
