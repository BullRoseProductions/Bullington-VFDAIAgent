-- =====================================================================
-- YOUR SIX - Slice 6a: membership resources (schema + RLS + verified national seed).
--
-- resources: per-department support/crisis resources. National rows (is_national=true)
-- are SEEDED + verified + shared, and are LOCKED from admins by RLS (no update/delete)
-- so the crisis lines (988, etc.) can never be removed. Admins manage LOCAL rows only
-- (is_national=false), including their own local crisis + wellness contacts.
--
-- New SECURITY DEFINER fns ship with REVOKE anon, public + GRANT authenticated.
-- Idempotent: guarded creates + ON CONFLICT DO NOTHING seed. Run VERIFY (bottom) after.
-- =====================================================================

-- ---- table -----------------------------------------------------------
create table if not exists public.resources (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  category      text not null,
  name          text not null,
  description   text,
  phone         text,
  text_number   text,
  website       text,
  email         text,
  is_national   boolean not null default false,   -- seeded/verified/shared (locked from admins)
  is_crisis     boolean not null default false,   -- crisis line; surfaces in the Reach-out flow
  is_wellness   boolean not null default false,   -- dept wellness contact; Reach-out step 2
  sort_order    integer not null default 0,
  created_by    uuid,                             -- null = system-seeded
  created_at    timestamptz not null default now()
);
create index if not exists resources_dept_idx on public.resources (department_id);
-- Idempotent seeding key: one national row per (dept, name).
create unique index if not exists resources_national_name_uq
  on public.resources (department_id, name) where (is_national);

-- ---- RLS -------------------------------------------------------------
alter table public.resources enable row level security;

drop policy if exists "members read resources"          on public.resources;
drop policy if exists "canmanage insert local resources" on public.resources;
drop policy if exists "canmanage update local resources" on public.resources;
drop policy if exists "canmanage delete local resources" on public.resources;

-- read: every member of the department
create policy "members read resources" on public.resources
  for select to authenticated
  using (department_id = public.my_department_id());

-- write: leadership, LOCAL rows only. is_national=false in the CHECK blocks forging a
-- national, and the update/delete USING clauses make seeded nationals read-only + undeletable.
create policy "canmanage insert local resources" on public.resources
  for insert to authenticated
  with check (public.is_canmanage() and department_id = public.my_department_id() and is_national = false);

create policy "canmanage update local resources" on public.resources
  for update to authenticated
  using      (public.is_canmanage() and department_id = public.my_department_id() and is_national = false)
  with check (public.is_canmanage() and department_id = public.my_department_id() and is_national = false);

create policy "canmanage delete local resources" on public.resources
  for delete to authenticated
  using (public.is_canmanage() and department_id = public.my_department_id() and is_national = false);

grant select, insert, update, delete on public.resources to authenticated;
grant all on public.resources to service_role;

-- ---- seed function: the 8 verified nationals for one department ------
create or replace function public.seed_national_resources(p_department_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.resources
    (department_id, category, name, description, phone, text_number, website, email, is_national, is_crisis, is_wellness, sort_order)
  select p_department_id, v.category, v.name, v.description, v.phone, v.text_number, v.website, v.email, true, v.is_crisis, false, v.sort_order
  from (values
    ('Crisis lines'::text, '988 Suicide & Crisis Lifeline'::text,
       'Free, confidential support 24/7 for anyone in distress. Call or text.'::text,
       '988'::text, '988'::text, null::text, null::text, true, 0),
    ('Crisis lines', 'FBHA Fire/EMS Crisis Line',
       'Firefighter Behavioral Health Alliance crisis line, answered by trained first responders.',
       '1-888-731-3473', null, null, null, true, 1),
    ('Crisis lines', 'Crisis Text Line',
       'Text HOME to 741741 to reach a trained crisis counselor, any time.',
       null, '741741', null, null, true, 2),
    ('Mental health & support', 'SAMHSA National Helpline',
       'Free, confidential treatment referral and information service, 24/7.',
       '1-800-662-4357', null, null, null, false, 3),
    ('Mental health & support', 'NVFC Share the Load',
       'National Volunteer Fire Council mental-health program and helpline for first responders.',
       null, null, 'https://www.nvfc.org/programs/share-the-load-program/', null, false, 4),
    ('Mental health & support', 'Firefighter Behavioral Health Alliance',
       'Training and support for firefighter mental health and suicide prevention.',
       null, null, 'https://www.ffbha.org/', null, false, 5),
    ('Line-of-duty & family', 'National Fallen Firefighters Foundation',
       'Support for families and departments after a line-of-duty death.',
       null, null, 'https://www.firehero.org/', null, false, 6),
    ('Physical health', 'Firefighter Cancer Support Network',
       'Guidance and support on firefighter cancer risk, screening, and diagnosis.',
       null, null, 'https://firefightercancersupport.org/', null, false, 7)
  ) as v(category, name, description, phone, text_number, website, email, is_crisis, sort_order)
  on conflict (department_id, name) where (is_national) do nothing;   -- idempotent: never double-seed
end;
$function$;

revoke execute on function public.seed_national_resources(uuid) from anon, public;
grant  execute on function public.seed_national_resources(uuid) to authenticated;

-- ---- auto-seed every NEW department (covers all creation paths) ------
create or replace function public.seed_resources_on_new_department()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.seed_national_resources(new.id);
  return new;
end;
$function$;
revoke execute on function public.seed_resources_on_new_department() from anon, public;

drop trigger if exists trg_seed_resources_on_new_department on public.departments;
create trigger trg_seed_resources_on_new_department
  after insert on public.departments
  for each row execute function public.seed_resources_on_new_department();

-- ---- BACKFILL every EXISTING department (idempotent) -----------------
select public.seed_national_resources(id) from public.departments;

-- =====================================================================
-- VERIFY (run separately)
-- =====================================================================
-- 1) RLS on + 4 policies:
-- select policyname, cmd from pg_policies where tablename='resources' order by policyname;
--    expect: members read (SELECT), canmanage insert/update/delete local (INSERT/UPDATE/DELETE)
-- 2) every department has the 8 nationals:
-- select department_id, count(*) as nationals from public.resources where is_national group by department_id;
--    expect: 8 per department
-- 3) crisis lines present per dept (the 988 guarantee):
-- select department_id, count(*) from public.resources where is_national and is_crisis group by department_id;
--    expect: 3 per department (988, FBHA, Crisis Text Line)
-- 4) anon cannot execute the seed fn:
-- select has_function_privilege('anon','public.seed_national_resources(uuid)','EXECUTE') as anon_exec;  -- expect false
