-- =====================================================================
-- AFTER-CALL CHECKLIST — SLICE 1: schema, RLS, RPC, grants. SQL ONLY.
--
-- APPLIED 2026-09-19, and VERIFIED: sql/aftercall_slice1_RETEST.sql returned
-- 29 passed, 0 failed of 29 against the live database immediately afterwards —
-- including the two that matter most, that retiring AND renaming a list item
-- left the run's snapshot untouched, and that a member cannot file a run in
-- another member's name.
--
-- THE STATUS LINE IS THE FIRST THING TO DISTRUST when reading this later. A
-- file, a commit and a conversation all say nothing about whether SQL is live;
-- only the rows do. To check: `select count(*) from public.aftercall_items;`
-- should answer rather than error, and `aftercall_log` should appear in
-- pg_proc. This repo has had a header say NOT APPLIED about SQL that had
-- already run.
--
-- WHAT THIS IS. A standalone feature: one shared task list per department (NOT
-- per-rig), any active member logs a run against a chosen apparatus ticking
-- each task, the log runs forever and nothing resets. Per-department toggle,
-- default OFF. Slice 2 adds the Settings toggle and nav gating; slice 3 adds
-- the page. This slice is the foundation and lights nothing up.
--
-- IT DOES NOT TOUCH THE TRUCK CHECK. apparatus_checks, apparatus_check_items,
-- apparatus_check_results, apparatus_photos and perform_apparatus_check are
-- read for their SHAPE and otherwise left completely alone. The only existing
-- object this migration writes to is `departments`, and only to add a column.
--
-- WHY A SEPARATE FEATURE AND NOT A TRUCK-CHECK MODE. The Truck Check is
-- per-apparatus readiness with pass/fail and a fail-requires-note constraint,
-- and it drives the apparatus status pointer. This is a shared after-the-call
-- chore list with done/not-done and no readiness meaning at all. Folding them
-- would have meant either teaching the Truck Check a second grammar or
-- teaching this one a status it should never set.
--
-- ---------------------------------------------------------------------
-- THREE THINGS TO DECIDE BEFORE RUNNING, all flagged again where they bite:
--
--   1. THE LIST IS MANAGED BY is_canmanage() — Board | Department Admin |
--      Officer — and deliberately NOT by is_canmanage_ops(), which is DA and
--      Officer only. The owner manages her own department as a Board Member
--      (access = Board + Project Admin), so the narrower gate would reject her
--      item writes with "new row violates row-level security policy". That is
--      not hypothetical: sql/apparatus_photos_rls_fix.sql exists because the
--      identical gate rejected the identical account on the sibling feature,
--      and had to be widened to is_canmanage(). Matching it here means the two
--      features behave the same way for the same person. The department scope
--      is unchanged and is what actually confines anyone to their own list.
--
--   2. "ACTIVE MEMBER" MEANS NOT-INACTIVE HERE, matching
--      perform_apparatus_check exactly ("Active + Probationary allowed"). A
--      strict status = 'Active' test would block probationary members from a
--      routine after-the-call chore, which is not what a volunteer department
--      wants and is not what its sibling feature does. One line in section 4,
--      clearly marked, if strict Active is wanted instead.
--
--   3. THE TOGGLE WRITE IS NOT COVERED BY ANYTHING IN THIS FILE, and may not
--      be covered at all — see section 1's note. Nothing here widens it.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- plpgsql resolves function calls at RUN time, so a policy or an RPC naming a
-- gate that does not exist still CREATEs cleanly, takes its grants, and fails
-- at the first member who taps the button — in production, with EXECUTE
-- already handed out. Refusing to install beats installing a broken boundary.
-- ---------------------------------------------------------------------
do $pre$
declare
  v_missing text;
  v_dept_pol int;
begin
  select string_agg(n, ', ') into v_missing from (
    select n from unnest(array[
      -- EXACTLY the gates this file calls, no more: asserting is_canmanage_ops
      -- or is_dept_admin here would fail a good migration over functions it no
      -- longer references, while leaving the gate it DOES use unchecked.
      'my_member_id', 'my_department_id', 'is_canmanage'
    ]) as n
    where not exists (select 1 from pg_proc
                       where pronamespace = 'public'::regnamespace and proname = n)
  ) s;
  if v_missing is not null then
    raise exception 'Precondition failed: missing gate function(s): %. These ARE the authorization boundary for everything below — find the real names before going further.', v_missing;
  end if;

  if not exists (select 1 from pg_class where relname = 'apparatus' and relnamespace = 'public'::regnamespace) then
    raise exception 'Precondition failed: public.apparatus does not exist. aftercall_runs references it.';
  end if;

  /* THE TOGGLE WRITE — REPORTED, NOT FIXED. A NOTICE rather than an exception:
     this migration only ADDS the column, and whether a Department Admin can
     write it is a property of the departments table's existing RLS, which is
     not this file's to change. If the count below is 0 and RLS is enabled on
     departments, NO ONE can write the toggle through the client and slice 2
     will need its own decision — a policy, or an RPC. Widening departments
     here would be changing a table this feature does not own. */
  select count(*) into v_dept_pol
    from pg_policies
   where schemaname = 'public' and tablename = 'departments'
     and cmd in ('UPDATE', 'ALL');
  raise notice 'AFTER-CALL SLICE 1: departments has % UPDATE/ALL polic(ies). If 0 and RLS is on, the aftercall_enabled toggle is NOT writable by a DA yet — that is a slice 2 decision, deliberately not made here.', v_dept_pol;
end
$pre$;


-- ---------------------------------------------------------------------
-- 1. THE TOGGLE. Column only — the Settings UI and nav gating are slice 2.
--
-- DEFAULT FALSE AND NOT NULL, so every existing department is OFF the moment
-- this runs and stays off until somebody opts in. A nullable flag would make
-- "never decided" and "decided no" indistinguishable, and the nav gate in
-- slice 2 would have to guess which a NULL meant.
-- ---------------------------------------------------------------------
alter table public.departments
  add column if not exists aftercall_enabled boolean not null default false;

comment on column public.departments.aftercall_enabled is
  'Per-department toggle for the After-Call Checklist feature. Default false: '
  'a department sees nothing until it opts in. Controls navigation and page '
  'visibility only — it does NOT gate the RPC or the tables, so turning it off '
  'hides the feature without destroying or orphaning any logged run.';


-- ---------------------------------------------------------------------
-- 2. TABLES.
--
-- THE LABEL IS SNAPSHOT ON THE RUN, and that is the single most important line
-- in this file. aftercall_run_items.item_label is the text as it read AT THE
-- TIME, copied, with no foreign key back to aftercall_items. Retiring or
-- renaming a task must never rewrite what a member ticked three months ago —
-- a log that changes when the list changes is not a log. Same reasoning as
-- apparatus_check_results.item_label, and the RETEST proves it directly.
-- ---------------------------------------------------------------------

-- The one shared list per department. Not per-apparatus, by design.
create table if not exists public.aftercall_items (
  id             uuid primary key default gen_random_uuid(),
  department_id  uuid not null references public.departments(id) on delete cascade,
  label          text not null,
  sort_order     int  not null default 0,
  active         boolean not null default true,   -- retire without breaking history
  created_at     timestamptz not null default now()
);

-- One row per run: who, which rig, when.
create table if not exists public.aftercall_runs (
  id                uuid primary key default gen_random_uuid(),
  department_id     uuid not null references public.departments(id) on delete cascade,
  apparatus_id      uuid not null references public.apparatus(id),
  -- ON DELETE SET NULL, not CASCADE: the run is history and must outlive the
  -- member record. performed_by_name is the snapshot that keeps it readable.
  performed_by      uuid references public.members(id) on delete set null,
  performed_by_name text not null,
  performed_at      timestamptz not null default now(),
  note              text
);

-- Per-item result. NO department_id, by the brief's column list — so its RLS
-- scopes through the parent run (section 3). The apparatus feature denormalizes
-- department_id onto its results instead; both work, and this one cannot drift
-- out of step with its parent because there is nothing to keep in step.
create table if not exists public.aftercall_run_items (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.aftercall_runs(id) on delete cascade,
  item_label  text not null,                      -- SNAPSHOT — see above
  done        boolean not null,
  note        text
);

create index if not exists aftercall_items_dept_idx
  on public.aftercall_items (department_id, active, sort_order);
create index if not exists aftercall_runs_dept_idx
  on public.aftercall_runs (department_id, performed_at desc);
create index if not exists aftercall_runs_apparatus_idx
  on public.aftercall_runs (apparatus_id);
create index if not exists aftercall_run_items_run_idx
  on public.aftercall_run_items (run_id);


-- ---------------------------------------------------------------------
-- 3. RLS. Enabled on all three; every rule is department-scoped.
-- ---------------------------------------------------------------------
alter table public.aftercall_items     enable row level security;
alter table public.aftercall_runs      enable row level security;
alter table public.aftercall_run_items enable row level security;

-- --- the shared list: everyone in the department reads; leadership manages ---
drop policy if exists "members read aftercall items" on public.aftercall_items;
create policy "members read aftercall items" on public.aftercall_items
  for select to authenticated
  using (department_id = public.my_department_id());

/* is_canmanage() — Board | Department Admin | Officer — NOT is_canmanage_ops().

   THIS IS THE SAME WIDENING apparatus_photos_rls_fix.sql already had to make,
   for the same account and the same reason. is_canmanage_ops() is DA|Officer
   only, and the owner manages her own department as a Board Member (access =
   Board + Project Admin). Under the narrower gate her item writes would be
   rejected with "new row violates row-level security policy" — a message that
   points at the data rather than at the gate, which is what made the photos
   case take a migration to diagnose. Matching the sibling feature means the
   two behave the same way for the same person.

   THE DEPARTMENT SCOPE IS DOING THE HEAVY LIFTING either way: this widens WHO
   may edit a list, never WHOSE list they may edit. A Project Admin still
   reaches only their own my_department_id().

   INSERT and UPDATE only — no DELETE. Retiring is `active = false`, which is
   what keeps a past run's snapshot meaningful alongside a list that has moved
   on. A hard delete would remove the only evidence the task ever existed. */
drop policy if exists "ops add aftercall items" on public.aftercall_items;
drop policy if exists "leadership add aftercall items" on public.aftercall_items;
create policy "leadership add aftercall items" on public.aftercall_items
  for insert to authenticated
  with check (public.is_canmanage() and department_id = public.my_department_id());

drop policy if exists "ops edit aftercall items" on public.aftercall_items;
drop policy if exists "leadership edit aftercall items" on public.aftercall_items;
create policy "leadership edit aftercall items" on public.aftercall_items
  for update to authenticated
  using      (public.is_canmanage() and department_id = public.my_department_id())
  with check (public.is_canmanage() and department_id = public.my_department_id());

-- --- runs: everyone in the department reads; an active member may insert ---
-- No UPDATE and no DELETE policy anywhere below: runs are immutable, and with
-- RLS on, the absence of a policy IS the denial.
drop policy if exists "members read aftercall runs" on public.aftercall_runs;
create policy "members read aftercall runs" on public.aftercall_runs
  for select to authenticated
  using (department_id = public.my_department_id());

/* The RPC is SECURITY DEFINER and bypasses this, so the policy is not what
   makes logging work — it is what makes the table honest if anyone ever writes
   to it directly. It permits exactly what the RPC does: your own department,
   stamped with your own member id, and not while Inactive. */
drop policy if exists "active members log aftercall runs" on public.aftercall_runs;
create policy "active members log aftercall runs" on public.aftercall_runs
  for insert to authenticated
  with check (
    department_id = public.my_department_id()
    and performed_by = public.my_member_id()
    and exists (select 1 from public.members m
                 where m.id = public.my_member_id()
                   and m.status is distinct from 'Inactive')
  );

-- --- run items: scoped THROUGH the parent run, which carries the dept ---
drop policy if exists "members read aftercall run items" on public.aftercall_run_items;
create policy "members read aftercall run items" on public.aftercall_run_items
  for select to authenticated
  using (exists (select 1 from public.aftercall_runs r
                  where r.id = run_id and r.department_id = public.my_department_id()));

drop policy if exists "active members log aftercall run items" on public.aftercall_run_items;
create policy "active members log aftercall run items" on public.aftercall_run_items
  for insert to authenticated
  with check (exists (select 1 from public.aftercall_runs r
                       where r.id = run_id and r.department_id = public.my_department_id()));


-- ---------------------------------------------------------------------
-- 4. RPC: aftercall_log(p_apparatus_id, p_items, p_note)
--
-- Shaped on perform_apparatus_check: identity from my_member_id(), status
-- gate, apparatus-belongs-to-your-department gate, header then line items, all
-- in one statement so a half-written run cannot exist.
--
-- SERVER-STAMPED, NOT CLIENT-SUPPLIED. performed_by, performed_by_name and
-- performed_at are taken from the resolved member and now(); the client cannot
-- log a run as somebody else or backdate one, because it is never asked.
--
-- p_items: jsonb array of { "label": text, "done": bool, "note": text|null }
-- ---------------------------------------------------------------------
create or replace function public.aftercall_log(
  p_apparatus_id uuid,
  p_items        jsonb,
  p_note         text default null
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_member public.members;
  v_app    public.apparatus;
  v_run_id uuid;
  r        jsonb;
begin
  -- 1. identity
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  -- NOT-INACTIVE, matching perform_apparatus_check (Active + Probationary).
  -- For strict Active only, this becomes: if v_member.status <> 'Active' then
  if v_member.status = 'Inactive' then
    raise exception 'Inactive members cannot log an after-call checklist';
  end if;

  -- 2. the apparatus must exist and be this department's
  select * into v_app from public.apparatus where id = p_apparatus_id;
  if v_app.id is null then
    raise exception 'Apparatus not found';
  end if;
  if v_app.department_id <> v_member.department_id then
    raise exception 'Not authorized: that apparatus belongs to another department';
  end if;

  -- 3. a run has to be a run
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'An after-call checklist must include at least one item';
  end if;

  /* 4. VALIDATE BEFORE WRITING ANYTHING. A missing label or a non-boolean
     `done` would otherwise insert a row reading NULL, and a checklist item
     that is neither done nor not-done is worse than a rejected run: nobody
     would know to look at it. Checked in its own pass so the header is never
     written for a run whose items cannot land. */
  for r in select * from jsonb_array_elements(p_items) loop
    if nullif(btrim(coalesce(r->>'label', '')), '') is null then
      raise exception 'Every checklist item needs a label';
    end if;
    -- COALESCED, because jsonb_typeof(NULL) is NULL and `NULL <> 'boolean'` is
    -- NULL, not true — so an item with no `done` key at all would slip past an
    -- uncoalesced test and fail later on the NOT NULL column, with a constraint
    -- error instead of a sentence naming the item.
    if coalesce(jsonb_typeof(r->'done'), 'missing') <> 'boolean' then
      raise exception 'Item "%" must record done as true or false', r->>'label';
    end if;
  end loop;

  -- 5. header
  insert into public.aftercall_runs
    (department_id, apparatus_id, performed_by, performed_by_name, performed_at, note)
  values
    (v_member.department_id, v_app.id, v_member.id, v_member.name, now(),
     nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_run_id;

  -- 6. line items — the label is COPIED, never referenced
  insert into public.aftercall_run_items (run_id, item_label, done, note)
  select v_run_id,
         btrim(e->>'label'),
         (e->>'done')::boolean,
         nullif(btrim(coalesce(e->>'note', '')), '')
  from jsonb_array_elements(p_items) as e;

  return v_run_id;
end;
$function$;

/* GRANTS. anon is named EXPLICITLY alongside public: Supabase re-grants anon on
   CREATE, revoking FROM anon alone would leave it inheriting through PUBLIC,
   and the ACL capture/replay some tooling does around DDL does NOT restore
   revokes. These two lines are what make the function authenticated-only —
   SECURITY DEFINER does nothing to restrict who may call it. */
revoke all    on function public.aftercall_log(uuid, jsonb, text) from anon, public;
grant execute on function public.aftercall_log(uuid, jsonb, text) to authenticated, service_role;

/* TABLE GRANTS — the layer RLS cannot reach.

   Supabase's project setup grants new public tables broadly to anon and
   authenticated via ALTER DEFAULT PRIVILEGES. RLS filters ROWS; it does not
   filter TRUNCATE, which takes no rows and would let any signed-in member
   empty a department's entire log in one statement with every policy above
   still perfectly in force. TRIGGER and REFERENCES are the same class of
   table-level right that no policy examines.

   Stated explicitly rather than relied on: revoke everything, then grant back
   exactly the verbs each table needs. Idempotent, and correct whether or not
   the default privileges exist on this project. */
revoke all on table public.aftercall_items     from anon, public;
revoke all on table public.aftercall_runs      from anon, public;
revoke all on table public.aftercall_run_items from anon, public;

revoke all on table public.aftercall_items     from authenticated;
revoke all on table public.aftercall_runs      from authenticated;
revoke all on table public.aftercall_run_items from authenticated;

-- The list is added to and edited (retired) — never deleted.
grant select, insert, update on table public.aftercall_items     to authenticated;
-- Runs are written once and read forever. No UPDATE, no DELETE, no TRUNCATE.
grant select, insert         on table public.aftercall_runs      to authenticated;
grant select, insert         on table public.aftercall_run_items to authenticated;

-- service_role bypasses RLS and is what the digest/pulse functions run as.
grant select, insert, update on table public.aftercall_items     to service_role;
grant select, insert         on table public.aftercall_runs      to service_role;
grant select, insert         on table public.aftercall_run_items to service_role;


-- ---------------------------------------------------------------------
-- 5. POST-CONDITIONS — in the same transaction, so a migration that installs
--    a hole rolls itself back instead of shipping.
-- ---------------------------------------------------------------------
do $post$
declare
  v_bad text;
begin
  -- The check this codebase has been bitten by before.
  if has_function_privilege('anon', 'public.aftercall_log(uuid, jsonb, text)', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE aftercall_log. Rolling back.';
  end if;
  if not has_function_privilege('authenticated', 'public.aftercall_log(uuid, jsonb, text)', 'EXECUTE') then
    raise exception 'Post-condition failed: authenticated CANNOT execute aftercall_log — nobody could log a run.';
  end if;

  -- RLS actually on. A table with policies but RLS disabled is wide open, and
  -- reads as secure to anyone skimming pg_policies.
  select string_agg(relname, ', ') into v_bad
    from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('aftercall_items', 'aftercall_runs', 'aftercall_run_items')
     and not relrowsecurity;
  if v_bad is not null then
    raise exception 'Post-condition failed: RLS is NOT enabled on %. Rolling back.', v_bad;
  end if;

  -- The table-level rights no policy can defend against.
  select string_agg(format('%s:%s', t, p), ', ') into v_bad from (
    select t, p from unnest(array['aftercall_items','aftercall_runs','aftercall_run_items']) t
    cross join unnest(array['TRUNCATE','TRIGGER','REFERENCES']) p
    where has_table_privilege('authenticated', 'public.' || t, p)
       or has_table_privilege('anon', 'public.' || t, p)
  ) s;
  if v_bad is not null then
    raise exception 'Post-condition failed: TRUNCATE/TRIGGER/REFERENCES still held on %. RLS does not stop TRUNCATE. Rolling back.', v_bad;
  end if;

  -- Runs are immutable: no grant and no policy may permit changing one.
  if has_table_privilege('authenticated', 'public.aftercall_runs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.aftercall_runs', 'DELETE')
     or has_table_privilege('authenticated', 'public.aftercall_run_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.aftercall_run_items', 'DELETE') then
    raise exception 'Post-condition failed: a logged run is editable. Rolling back.';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('aftercall_runs', 'aftercall_run_items')
                and cmd in ('UPDATE', 'DELETE', 'ALL')) then
    raise exception 'Post-condition failed: an UPDATE/DELETE policy exists on a run table. Rolling back.';
  end if;

  -- The Truck Check is not in this feature's blast radius.
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename like 'apparatus_check%'
                and policyname like '%aftercall%') then
    raise exception 'Post-condition failed: this migration touched an apparatus_check table. Rolling back.';
  end if;
end
$post$;

commit;

-- After commit, on the live database:
--   notify pgrst, 'reload schema';
-- Without it the first aftercall_log() call 404s against a schema cache that
-- predates the function, and the new tables are invisible to PostgREST.

-- =====================================================================
-- THE TOGGLE-WRITE QUESTION, to answer before slice 2 (read-only):
--
--   select relrowsecurity from pg_class
--    where relname = 'departments' and relnamespace = 'public'::regnamespace;
--   select policyname, cmd, roles, qual, with_check
--     from pg_policies where schemaname = 'public' and tablename = 'departments';
--
-- If RLS is ON and there is no UPDATE/ALL policy, a Department Admin cannot
-- write aftercall_enabled from the client at all, and slice 2 needs either a
-- policy on departments or a small SECURITY DEFINER setter. If RLS is OFF,
-- the table grant decides and ANY authenticated member could write it, which
-- is its own problem and a wider one than this feature.
-- =====================================================================
