-- =====================================================================
-- ONBOARDING SIGN-OFF — schema + RLS + RPC. NOT YET APPLIED.
-- Preflight run 2026-10-09: item_id uuid present, UNIQUE (member_id, item_id)
-- present (onboarding_progress_member_itemid_uk), no item_key column. Writes today
-- are the DA/PA "dept admins insert/update onboarding_progress" policies; the
-- revoke in step 3 makes those inert.
--
-- Only pg_proc / pg_policies say whether this is live, never git:
--   select proname from pg_proc where proname = 'set_onboarding_item';
--
-- WHAT IT DOES
--  1. onboarding_progress gains checked_by (members.id) + checked_at — who
--     signed the item and when. Stamped on done=true, cleared on done=false.
--  2. set_onboarding_item(p_member_id, p_item_id, p_done): the ONLY write path.
--     SECURITY DEFINER, gated is_canmanage() (Board/DA/Officer — NOT PA, same
--     as approve_cert_submission: support may fix access, never sign records).
--     Stamps are server-side (my_member_id(), now()), so a client can't sign
--     as someone else or backdate. Caller's department only — it takes no
--     department id; the member AND the item must both be in my_department_id().
--  3. Direct INSERT/UPDATE on onboarding_progress revoked from authenticated,
--     so nothing can write `done` without the stamp. (Revoking the grant is
--     name-independent; the existing write policies become inert, not dropped.)
--     Item-delete still cascades — RI actions run as the table owner.
--  4. RLS: a member can SELECT their OWN progress rows. (Members can already
--     SELECT their department's onboarding_items — existing policy, unchanged.)
--     Item writes (add/rename/reorder/delete) are untouched — DA/PA only.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS.
-- ---------------------------------------------------------------------
do $pre$
declare
  v_missing text;
begin
  select string_agg(n, ', ') into v_missing from (
    select n from unnest(array['is_canmanage', 'my_member_id', 'my_department_id']) as n
     where not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = n)
  ) s;
  if v_missing is not null then
    raise exception 'Precondition failed: missing function(s): %', v_missing;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'onboarding_progress' and column_name = 'item_id') then
    raise exception 'Precondition failed: onboarding_progress.item_id does not exist (schema differs from the app). Stop and check the preflight.';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.onboarding_progress'::regclass and contype in ('u', 'p')
                    and pg_get_constraintdef(oid) ~ '\(member_id, item_id\)') then
    raise exception 'Precondition failed: no unique (member_id, item_id) on onboarding_progress — the upsert below needs it.';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------
-- 1. SCHEMA. Nullable: every existing done row predates sign-off and stays
--    unsigned ("done" with no name), which is the honest state.
-- ---------------------------------------------------------------------
alter table public.onboarding_progress
  add column if not exists checked_by uuid references public.members(id) on delete set null,
  add column if not exists checked_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. THE WRITE PATH.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. CLOSE THE DIRECT WRITE. SELECT and DELETE grants are left alone.
-- ---------------------------------------------------------------------
revoke insert, update on public.onboarding_progress from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. READS. Policies OR together, so this only ADDS access; the existing
--    leader read on progress is untouched.
-- ---------------------------------------------------------------------
drop policy if exists "member reads own onboarding_progress" on public.onboarding_progress;
create policy "member reads own onboarding_progress" on public.onboarding_progress
  for select to authenticated
  using (member_id = public.my_member_id());

-- onboarding_items needs nothing: the live policy "members read dept onboarding_items"
-- (SELECT, authenticated, department_id = my_department_id()) already lets every member
-- render their checklist. Confirmed by preflight 2026-10-09.

-- ---------------------------------------------------------------------
-- 5. POST-CONDITIONS — in-transaction, so a hole rolls itself back.
-- ---------------------------------------------------------------------
do $post$
begin
  if has_function_privilege('anon', 'public.set_onboarding_item(uuid, uuid, boolean)', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE set_onboarding_item. Rolling back.';
  end if;
  if not has_function_privilege('authenticated', 'public.set_onboarding_item(uuid, uuid, boolean)', 'EXECUTE') then
    raise exception 'Post-condition failed: authenticated cannot execute set_onboarding_item.';
  end if;
  if has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT')
     or has_table_privilege('authenticated', 'public.onboarding_progress', 'UPDATE') then
    raise exception 'Post-condition failed: authenticated can still write onboarding_progress directly.';
  end if;
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = 'set_onboarding_item'
                and pg_get_function_identity_arguments(p.oid) <> 'p_member_id uuid, p_item_id uuid, p_done boolean') then
    raise exception 'Post-condition failed: a set_onboarding_item overload exists with other arguments.';
  end if;
end
$post$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- VERIFY (run separately). The SQL editor carries no JWT, so a bare call
-- raises 'Not authorized' — that's the gate working. Impersonate an
-- Officer/DA by their auth user id, inside a rolled-back transaction:
--
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub', '<officer auth uid>', 'email', '<officer email>', 'role', 'authenticated')::text, true);
--   select done, checked_by, checked_at
--     from public.set_onboarding_item('<probationary member id>', '<item id>', true);   -- expect stamp
--   select done, checked_by, checked_at
--     from public.set_onboarding_item('<probationary member id>', '<item id>', false);  -- expect nulls
-- rollback;
--
-- Same block as a plain Member: expect 'Not authorized'; and
--   select count(*) from public.onboarding_progress;   -- expect only their own rows
-- =====================================================================
