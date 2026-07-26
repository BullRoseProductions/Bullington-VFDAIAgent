-- =====================================================================
-- EQUIPMENT QR HANDOFF - Slice 5 (peer-to-peer transfer of custody)
--
-- A holder ("giver") starts a handoff of items they hold -> a short-lived,
-- single-use, HASHED code is generated and rendered as a QR (a deep-link URL).
-- Another member ("receiver") scans it -> accept atomically moves custody.
--
-- Code lifecycle (built FRESH to the brief — NOT reused from the multi-use,
-- session-long fire-school sign-in code):
--   * hashed at rest      : store sha256(code); the raw code is returned once
--                           (for the QR) and never persisted.
--   * short-lived         : expires_at = now() + 60s (single named constant).
--   * single-use          : handoff row locked FOR UPDATE + resolution flip;
--                           a resolved code can never be accepted again.
--
-- The transfer preserves equipment_custody_one_open (<=1 open period per item):
-- per item we CLOSE the giver's open period BEFORE we OPEN the receiver's, so
-- the partial unique index never sees two live rows for the same equipment_id.
--
-- Tables (equipment_handoff / equipment_handoff_items) + RLS already exist from
-- equipment_custody_slice2.sql. This file adds only the three RPCs + grants.
-- All three: SECURITY DEFINER, actor from my_member_id(), FOR UPDATE locks.
-- =====================================================================

-- pgcrypto provides digest()/gen_random_bytes(). Safe no-op if already enabled;
-- installs into the extensions schema otherwise. The RPCs set search_path to
-- 'public','extensions' so the calls resolve wherever pgcrypto lives.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- create_equipment_handoff — giver starts the transfer. Returns the raw code
-- ONCE (for the QR) + the handoff id + expires_at. Moves no custody yet.
-- ---------------------------------------------------------------------
create or replace function public.create_equipment_handoff(
  p_equipment_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  c_ttl   constant interval := interval '60 seconds';   -- handoff code lifetime (single named constant)
  v_actor public.members;
  v_id    uuid;
  v_code  text;
  v_exp   timestamptz;
  v_ids   uuid[];
  v_eid   uuid;
  v_open  public.equipment_custody;
  v_n     int := 0;
begin
  -- identity
  select * into v_actor from public.members where id = public.my_member_id();
  if v_actor.id is null then raise exception 'No member record for the signed-in user'; end if;
  if v_actor.status = 'Inactive' then raise exception 'Inactive members cannot start a handoff'; end if;

  if p_equipment_ids is null or array_length(p_equipment_ids, 1) is null then
    raise exception 'Select at least one item to hand off';
  end if;

  -- fresh random code; store ONLY its sha256 hash. Raw code returned once (for the QR), never persisted.
  v_code := encode(gen_random_bytes(16), 'hex');   -- 128-bit, URL-safe
  v_exp  := now() + c_ttl;

  insert into public.equipment_handoff
    (department_id, from_member_id, from_member_name, code_hash, expires_at, initiated_at)
  values
    (v_actor.department_id, v_actor.id, v_actor.name, encode(digest(v_code, 'sha256'), 'hex'), v_exp, now())
  returning id into v_id;

  -- one item row per DISTINCT id the actor CURRENTLY holds (create moves nothing — accept does)
  v_ids := (select array(select distinct unnest(p_equipment_ids)));
  foreach v_eid in array v_ids loop
    select * into v_open from public.equipment_custody
      where equipment_id = v_eid and closed_at is null;
    if v_open.id is null or v_open.holder_member_id <> v_actor.id then
      raise exception 'You can only hand off items you currently hold';
    end if;
    insert into public.equipment_handoff_items (handoff_id, equipment_id, equipment_name)
    values (v_id, v_eid, v_open.equipment_name);
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('handoff_id', v_id, 'code', v_code, 'expires_at', v_exp, 'items', v_n);
end;
$function$;

-- ---------------------------------------------------------------------
-- accept_equipment_handoff — receiver scans. Validates (pending / not expired /
-- code match / receiver <> giver / same dept), then per item CLOSE-then-OPEN so
-- the one_open invariant holds continuously, and resolves the handoff.
-- ---------------------------------------------------------------------
create or replace function public.accept_equipment_handoff(
  p_handoff_id uuid,
  p_code       text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_actor public.members;
  v_h     public.equipment_handoff;
  v_item  record;
  v_open  public.equipment_custody;
  v_cond  text;
  v_count int := 0;
begin
  -- 0. identity
  select * into v_actor from public.members where id = public.my_member_id();
  if v_actor.id is null then raise exception 'No member record for the signed-in user'; end if;
  if v_actor.status = 'Inactive' then raise exception 'Inactive members cannot accept a handoff'; end if;

  -- 1. lock the handoff row → serializes concurrent scans of the SAME code (single-use gate)
  select * into v_h from public.equipment_handoff where id = p_handoff_id for update;
  if v_h.id is null then raise exception 'Handoff not found'; end if;

  -- 2. single-use: a resolved handoff can never be accepted again
  if v_h.resolution is not null then raise exception 'This handoff code has already been used or cancelled'; end if;

  -- 3. short-lived: past its 60s window → mark expired and reject
  if now() >= v_h.expires_at then
    update public.equipment_handoff set resolution = 'expired', resolved_at = now() where id = v_h.id;
    raise exception 'This handoff code has expired — ask for a fresh one';
  end if;

  -- 4. hashed code match (hash the presented code; never store/compare the raw code)
  if encode(digest(p_code, 'sha256'), 'hex') <> v_h.code_hash then
    raise exception 'Invalid handoff code';
  end if;

  -- 5. receiver must be a DIFFERENT member, same department
  if v_actor.id = v_h.from_member_id then raise exception 'You cannot accept your own handoff'; end if;
  if v_actor.department_id <> v_h.department_id then raise exception 'Not authorized: this handoff belongs to another department'; end if;

  -- 6. move each item: CLOSE the giver's open period, THEN OPEN the receiver's
  for v_item in select equipment_id, equipment_name from public.equipment_handoff_items where handoff_id = v_h.id loop
    -- 6a. lock the item's CURRENT open custody period (the giver's) — the contended row
    select * into v_open from public.equipment_custody
      where equipment_id = v_item.equipment_id and closed_at is null
      for update;
    -- 6b. re-validate: the giver must STILL hold it (they may have returned/transferred it after creating the handoff)
    if v_open.id is null or v_open.holder_member_id <> v_h.from_member_id then
      raise exception 'Item "%" is no longer held by the sender — nothing was transferred', v_item.equipment_name;
    end if;
    select condition into v_cond from public.equipment where id = v_item.equipment_id;   -- current condition snapshot

    -- 6c. CLOSE FIRST → this period stops counting against equipment_custody_one_open
    update public.equipment_custody
       set closed_at = now(), close_action = 'transferred_out',
           closed_by = v_actor.id, closed_by_name = v_actor.name, condition_at_close = v_cond
     where id = v_open.id;

    -- 6d. OPEN SECOND → zero open rows now exist for this item, so the insert can't collide
    insert into public.equipment_custody
      (department_id, equipment_id, equipment_name, holder_member_id, holder_name,
       opened_at, opened_by, opened_by_name, open_action, condition_at_open)
    values
      (v_h.department_id, v_item.equipment_id, v_item.equipment_name, v_actor.id, v_actor.name,
       now(), v_actor.id, v_actor.name, 'transfer_accepted', v_cond);

    -- 6e. move the live holder pointer (status stays 'held' — it never left custody)
    update public.equipment
       set current_holder_id = v_actor.id, current_holder_name = v_actor.name
     where id = v_item.equipment_id;

    v_count := v_count + 1;
  end loop;

  if v_count = 0 then raise exception 'This handoff has no items'; end if;

  -- 7. resolve the handoff (single-use terminal state + receiver snapshot)
  update public.equipment_handoff
     set resolution = 'accepted', to_member_id = v_actor.id, to_member_name = v_actor.name, resolved_at = now()
   where id = v_h.id;

  return jsonb_build_object('handoff_id', v_h.id, 'items', v_count);
end;
$function$;

-- ---------------------------------------------------------------------
-- cancel_equipment_handoff — giver aborts a still-pending handoff. Terminal
-- state flip only; create moved no custody, so there is nothing to unwind.
-- ---------------------------------------------------------------------
create or replace function public.cancel_equipment_handoff(
  p_handoff_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_actor public.members;
  v_h     public.equipment_handoff;
begin
  select * into v_actor from public.members where id = public.my_member_id();
  if v_actor.id is null then raise exception 'No member record for the signed-in user'; end if;

  select * into v_h from public.equipment_handoff where id = p_handoff_id for update;
  if v_h.id is null then raise exception 'Handoff not found'; end if;

  if v_h.from_member_id <> v_actor.id then raise exception 'Only the sender can cancel this handoff'; end if;
  if v_h.resolution is not null then raise exception 'This handoff is already %; nothing to cancel', v_h.resolution; end if;

  update public.equipment_handoff
     set resolution = 'cancelled', resolved_at = now()
   where id = v_h.id;

  return jsonb_build_object('handoff_id', v_h.id, 'resolution', 'cancelled');
end;
$function$;

-- ---------------------------------------------------------------------
-- Grants (anon must NOT execute; authenticated only) + PostgREST reload
-- ---------------------------------------------------------------------
revoke execute on function public.create_equipment_handoff(uuid[])     from anon, public;
grant  execute on function public.create_equipment_handoff(uuid[])     to authenticated;
revoke execute on function public.accept_equipment_handoff(uuid, text) from anon, public;
grant  execute on function public.accept_equipment_handoff(uuid, text) to authenticated;
revoke execute on function public.cancel_equipment_handoff(uuid)       from anon, public;
grant  execute on function public.cancel_equipment_handoff(uuid)       to authenticated;

notify pgrst, 'reload schema';

-- =====================================================================
-- VERIFICATION (run separately; the editor shows the LAST grid)
-- =====================================================================

-- (a) pgcrypto present + its schema:
-- select e.extname, n.nspname as schema from pg_extension e
-- join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';

-- (b) all three functions exist, SECURITY DEFINER:
-- select proname, prosecdef from pg_proc
-- where proname in ('create_equipment_handoff','accept_equipment_handoff','cancel_equipment_handoff')
-- order by proname;   -- expect 3 rows | prosecdef = t

-- (c) anon must be FALSE for all three, authenticated TRUE:
-- select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
-- from pg_proc p
-- cross join (values ('anon'),('authenticated'),('service_role')) as r(rolname)
-- where p.proname in ('create_equipment_handoff','accept_equipment_handoff','cancel_equipment_handoff')
-- order by p.proname, r.rolname;   -- expect: anon = f for all ; authenticated = t ; service_role = t
