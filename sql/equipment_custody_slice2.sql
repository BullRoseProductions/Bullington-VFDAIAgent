-- =====================================================================
-- EQUIPMENT CUSTODY LEDGER - Slice 2 (custody tables + invariant + RLS + issue RPC)
--
-- "Liability is a row, not a field." An OPEN custody period (closed_at IS NULL)
-- means a named member holds an item; the DB guarantees AT MOST ONE open period
-- per item via a partial unique index. Modeled on apparatus_service_periods.
--
-- Snapshot columns (equipment_name, holder_name, opened_by_name, ...) are frozen
-- at write time so history survives a later member/item rename or delete.
--
-- Reconstructed from the live database (this file was not saved when slice 2 was
-- first run; it mirrors the exact statements in the DB). The pending-return
-- columns (return_requested_*) are added later in equipment_return_slice4.sql.
-- Gates: is_equipment_manager() (assigned managers, <=2/dept) OR is_dept_admin()
-- (DA|PA) — NOT any officer. Run VERIFICATION queries separately.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Issue batch — one row per issuing event (recipient signature + optional witness)
-- ---------------------------------------------------------------------
create table if not exists public.equipment_issue_batch (
  id                uuid primary key default gen_random_uuid(),
  department_id     uuid not null references public.departments(id) on delete cascade,
  member_id         uuid references public.members(id) on delete set null,   -- who received it
  signed_name       text not null,                    -- SNAPSHOT of who signed
  signed_at         timestamptz not null default now(),
  signature_data    text not null,                    -- captured signature (data-URL/SVG)
  witness_signature text,                             -- 2nd signature for self-issue (nullable)
  witness_name      text,                             -- SNAPSHOT of the witness (nullable)
  item_count        integer not null default 0,
  issued_by         uuid references public.members(id) on delete set null,
  issued_by_name    text,                             -- SNAPSHOT
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Custody periods — the liability ledger. closed_at IS NULL = currently held.
-- ---------------------------------------------------------------------
create table if not exists public.equipment_custody (
  id                 uuid primary key default gen_random_uuid(),
  department_id      uuid not null references public.departments(id) on delete cascade,
  equipment_id       uuid references public.equipment(id) on delete set null,
  equipment_name     text not null,                   -- SNAPSHOT (survives unit rename/delete)
  holder_member_id   uuid references public.members(id) on delete set null,
  holder_name        text not null,                   -- SNAPSHOT (NOT NULL)
  opened_at          timestamptz not null default now(),
  opened_by          uuid references public.members(id) on delete set null,
  opened_by_name     text,                            -- SNAPSHOT
  open_action        text not null check (open_action in ('issue','transfer_accepted')),
  closed_at          timestamptz,                     -- NULL = currently held / liable
  closed_by          uuid references public.members(id) on delete set null,
  closed_by_name     text,                            -- SNAPSHOT
  close_action       text check (close_action in ('returned','transferred_out','manager_recovery','marked_lost')),
  batch_id           uuid references public.equipment_issue_batch(id) on delete set null,
  condition_at_open  text,                            -- free-text snapshot (NOT the equipment.condition CHECK)
  condition_at_close text,
  note               text,
  created_at         timestamptz not null default now()
);
-- LAYER 3 backstop: at most one OPEN period per item, enforced by the DB regardless of app logic
create unique index if not exists equipment_custody_one_open
  on public.equipment_custody (equipment_id) where closed_at is null;
create index if not exists equipment_custody_holder_open_idx
  on public.equipment_custody (holder_member_id) where closed_at is null;   -- "My Equipment" lookups
create index if not exists equipment_custody_equipment_idx
  on public.equipment_custody (equipment_id, opened_at desc);              -- item history

-- ---------------------------------------------------------------------
-- Handoff (QR peer transfer) — code is HASHED, single-use, short-lived. Slice 5 wires the RPCs.
-- ---------------------------------------------------------------------
create table if not exists public.equipment_handoff (
  id               uuid primary key default gen_random_uuid(),
  department_id    uuid not null references public.departments(id) on delete cascade,
  from_member_id   uuid references public.members(id) on delete set null,
  from_member_name text not null,                     -- SNAPSHOT
  code_hash        text not null,                     -- HASH of the code, never the raw code
  expires_at       timestamptz not null,              -- 30-60s out
  initiated_at     timestamptz not null default now(),
  to_member_id     uuid references public.members(id) on delete set null,   -- NULL until scanned
  to_member_name   text,                              -- SNAPSHOT (NULL until scanned)
  resolved_at      timestamptz,
  resolution       text check (resolution in ('accepted','cancelled','expired'))   -- NULL = pending
);
create index if not exists equipment_handoff_from_idx on public.equipment_handoff (from_member_id, initiated_at desc);
create index if not exists equipment_handoff_pending_code_idx on public.equipment_handoff (code_hash) where resolution is null;

create table if not exists public.equipment_handoff_items (
  id             uuid primary key default gen_random_uuid(),
  handoff_id     uuid not null references public.equipment_handoff(id) on delete cascade,
  equipment_id   uuid references public.equipment(id) on delete set null,
  equipment_name text not null                        -- SNAPSHOT
);
create index if not exists equipment_handoff_items_handoff_idx on public.equipment_handoff_items (handoff_id);

-- ---------------------------------------------------------------------
-- Item pointers (live "who holds it now") + photo -> custody link
-- ---------------------------------------------------------------------
alter table public.equipment
  add column if not exists current_holder_id   uuid references public.members(id) on delete set null,
  add column if not exists current_holder_name text;

alter table public.equipment_photos
  add column if not exists custody_id uuid references public.equipment_custody(id) on delete set null;

-- ---------------------------------------------------------------------
-- RLS — reads only; every INSERT/UPDATE to custody happens through the RPCs.
-- ---------------------------------------------------------------------
-- equipment_custody: managers/DA see all; a member sees ONLY rows where they're the holder
alter table public.equipment_custody enable row level security;
drop policy if exists "managers read all custody" on public.equipment_custody;
create policy "managers read all custody" on public.equipment_custody for select to authenticated
  using ((is_equipment_manager() or is_dept_admin()) and department_id = my_department_id());
drop policy if exists "members read own custody" on public.equipment_custody;
create policy "members read own custody" on public.equipment_custody for select to authenticated
  using (holder_member_id = my_member_id());
drop policy if exists "leadership correct custody" on public.equipment_custody;
create policy "leadership correct custody" on public.equipment_custody for update to authenticated
  using      ((is_equipment_manager() or is_dept_admin()) and department_id = my_department_id())
  with check ((is_equipment_manager() or is_dept_admin()) and department_id = my_department_id());

-- equipment_issue_batch
alter table public.equipment_issue_batch enable row level security;
drop policy if exists "managers read batches" on public.equipment_issue_batch;
create policy "managers read batches" on public.equipment_issue_batch for select to authenticated
  using ((is_equipment_manager() or is_dept_admin()) and department_id = my_department_id());
drop policy if exists "members read own batches" on public.equipment_issue_batch;
create policy "members read own batches" on public.equipment_issue_batch for select to authenticated
  using (member_id = my_member_id());

-- equipment_handoff: the two parties or a manager/DA
alter table public.equipment_handoff enable row level security;
drop policy if exists "parties read handoffs" on public.equipment_handoff;
create policy "parties read handoffs" on public.equipment_handoff for select to authenticated
  using (from_member_id = my_member_id() or to_member_id = my_member_id()
         or ((is_equipment_manager() or is_dept_admin()) and department_id = my_department_id()));

-- equipment_handoff_items: visibility inherited from the parent handoff
alter table public.equipment_handoff_items enable row level security;
drop policy if exists "parties read handoff items" on public.equipment_handoff_items;
create policy "parties read handoff items" on public.equipment_handoff_items for select to authenticated
  using (exists (select 1 from public.equipment_handoff h
                 where h.id = handoff_id
                   and (h.from_member_id = my_member_id() or h.to_member_id = my_member_id()
                        or ((is_equipment_manager() or is_dept_admin()) and h.department_id = my_department_id()))));

-- ---------------------------------------------------------------------
-- issue_equipment_batch — the ONLY writer of open custody periods. Manager/DA
-- gate, per-item FOR UPDATE lock, atomic batch; signed_name is snapshotted.
-- Self-issue (recipient = actor) requires a witness (another manager/DA) + 2nd
-- signature, re-enforced here server-side.
-- ---------------------------------------------------------------------
create or replace function public.issue_equipment_batch(
  p_member_id         uuid,
  p_equipment_ids     uuid[],
  p_signature_data    text,
  p_signed_name       text,
  p_witness_member_id uuid default null,
  p_witness_signature text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor   public.members;
  v_target  public.members;
  v_witness public.members;
  v_batch   uuid;
  v_eid     uuid;
  v_e       public.equipment;
  v_ename   text;
  v_count   int := 0;
begin
  select * into v_actor from public.members where id = public.my_member_id();
  if v_actor.id is null then raise exception 'No member record for the signed-in user'; end if;
  if v_actor.status = 'Inactive' then raise exception 'Inactive members cannot issue equipment'; end if;

  if not (public.is_equipment_manager() or public.is_dept_admin()) then
    raise exception 'Only an assigned equipment manager or a Department Admin can issue equipment';
  end if;

  if coalesce(btrim(p_signature_data), '') = '' then raise exception 'A signature is required to issue equipment'; end if;
  if coalesce(btrim(p_signed_name), '')    = '' then raise exception 'The signer''s name is required'; end if;

  select * into v_target from public.members where id = p_member_id;
  if v_target.id is null then raise exception 'Recipient not found'; end if;
  if v_target.department_id <> v_actor.department_id then raise exception 'Not authorized: that member belongs to another department'; end if;
  if v_target.status = 'Inactive' then raise exception 'Cannot issue equipment to an inactive member'; end if;

  if p_member_id = v_actor.id then
    if coalesce(btrim(p_witness_signature), '') = '' then raise exception 'Issuing to yourself requires a second (witness) signature'; end if;
    select * into v_witness from public.members where id = p_witness_member_id;
    if v_witness.id is null then raise exception 'A witness must be identified for a self-issue'; end if;
    if v_witness.id = v_actor.id then raise exception 'The witness must be someone other than you'; end if;
    if v_witness.department_id <> v_actor.department_id then raise exception 'The witness must be in your department'; end if;
    if not (exists (select 1 from public.equipment_manager em where em.member_id = v_witness.id and em.removed_at is null)
            or (v_witness.access && array['Department Admin','Project Admin']::text[]))
    then raise exception 'The witness must be another equipment manager or a Department Admin'; end if;
  end if;

  if p_equipment_ids is null or array_length(p_equipment_ids, 1) is null then raise exception 'No items to issue'; end if;

  insert into public.equipment_issue_batch
    (department_id, member_id, signed_name, signed_at, signature_data, witness_signature, witness_name, item_count, issued_by, issued_by_name)
  values
    (v_actor.department_id, p_member_id, btrim(p_signed_name), now(), p_signature_data,
     nullif(btrim(coalesce(p_witness_signature,'')), ''), v_witness.name, 0, v_actor.id, v_actor.name)
  returning id into v_batch;

  foreach v_eid in array p_equipment_ids loop
    select * into v_e from public.equipment where id = v_eid for update;
    if v_e.id is null then raise exception 'Equipment item not found'; end if;
    if v_e.department_id <> v_actor.department_id then raise exception 'Not authorized: an item belongs to another department'; end if;
    if v_e.status <> 'in_inventory' then raise exception 'An item is not available to issue (currently %). Nothing was issued.', v_e.status; end if;

    select coalesce(et.name, 'Equipment')
           || case when coalesce(btrim(v_e.serial_number),'') <> '' then ' · SN ' || v_e.serial_number
                   when coalesce(btrim(v_e.asset_number),'')  <> '' then ' · Asset ' || v_e.asset_number
                   else '' end
      into v_ename
      from public.equipment_type et where et.id = v_e.equipment_type_id;

    insert into public.equipment_custody
      (department_id, equipment_id, equipment_name, holder_member_id, holder_name,
       opened_at, opened_by, opened_by_name, open_action, batch_id, condition_at_open)
    values
      (v_actor.department_id, v_e.id, coalesce(v_ename, 'Equipment'), p_member_id, v_target.name,
       now(), v_actor.id, v_actor.name, 'issue', v_batch, v_e.condition);

    update public.equipment
       set status = 'held', current_holder_id = p_member_id, current_holder_name = v_target.name
     where id = v_e.id;

    v_count := v_count + 1;
  end loop;

  update public.equipment_issue_batch set item_count = v_count where id = v_batch;
  return v_batch;
end;
$function$;
revoke execute on function public.issue_equipment_batch(uuid, uuid[], text, text, uuid, text) from anon, public;
grant  execute on function public.issue_equipment_batch(uuid, uuid[], text, text, uuid, text) to authenticated;

notify pgrst, 'reload schema';
