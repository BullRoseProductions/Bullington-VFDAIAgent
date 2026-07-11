-- =====================================================================
-- APPARATUS TRUCK CHECK - Slice 4b
-- mark_check_item RPC: the ONE write path for a per-item Pass/Fail mark on
-- an in-progress draft. Collaborative (many members mark the same draft),
-- so it is concurrency-safe and enforces the no-rubber-stamping rule.
--
-- Enforces ALL of:
--   - active member (not Inactive) + dept ownership of the check
--   - check.state = 'in_progress'  (finalized checks are immutable)
--   - result in ('pass','fail')
--   - FAIL requires a non-empty (trimmed) note
--   - item exists AND belongs to the check's apparatus
--   - DIFFERENT-OUTCOME-ONLY: a same-result re-mark is rejected (no
--     rubber-stamping); a different result or a first mark is written
--   - per-item stamping: marked_by / marked_by_name (snapshot) / marked_at
--     set on EVERY write
--   - concurrency: SELECT ... FOR UPDATE on the existing result row so two
--     members marking the same item at once serialize; upsert conflict
--     target is the 4a unique index (check_id, item_id)
--
-- Idempotent: CREATE OR REPLACE. Run the VERIFICATION block separately after.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.mark_check_item(
  p_check_id uuid,
  p_item_id  uuid,
  p_result   text,
  p_note     text DEFAULT NULL
)
RETURNS public.apparatus_check_results
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_member   public.members;
  v_check    public.apparatus_checks;
  v_item     public.apparatus_check_items;
  v_existing public.apparatus_check_results;
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_row      public.apparatus_check_results;
begin
  -- 1. identity: an ACTIVE member for the signed-in user
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if v_member.status = 'Inactive' then
    raise exception 'Inactive members cannot mark checklist items';
  end if;

  -- 2. result domain
  if p_result not in ('pass', 'fail') then
    raise exception 'Invalid result "%": must be pass or fail', p_result;
  end if;

  -- 3. FAIL requires a non-empty note (documents WHY it failed)
  if p_result = 'fail' and v_note is null then
    raise exception 'A note is required when marking an item Fail';
  end if;

  -- 4. check must exist, belong to the caller's dept, and be in progress
  select * into v_check from public.apparatus_checks where id = p_check_id;
  if v_check.id is null then
    raise exception 'Check not found';
  end if;
  if v_check.department_id <> v_member.department_id then
    raise exception 'Not authorized: this check belongs to another department';
  end if;
  if v_check.state <> 'in_progress' then
    raise exception 'This check is finalized and can no longer be marked';
  end if;

  -- 5. item must exist AND belong to the SAME apparatus as the check
  select * into v_item from public.apparatus_check_items where id = p_item_id;
  if v_item.id is null then
    raise exception 'Checklist item not found';
  end if;
  if v_item.apparatus_id <> v_check.apparatus_id then
    raise exception 'This item does not belong to the truck being checked';
  end if;

  -- 6. lock any existing mark for this (check,item). FOR UPDATE serializes
  --    concurrent markers: a second marker on an EXISTING row blocks here,
  --    then sees the just-committed result below (so a same-result re-mark
  --    is correctly rejected). The only unlocked case is a true first-insert
  --    race (no row yet to lock) -> ON CONFLICT keeps it from erroring and
  --    the residual outcome is a harmless last-writer-wins.
  select * into v_existing
  from public.apparatus_check_results
  where check_id = p_check_id and item_id = p_item_id
  for update;

  -- 7. different-outcome-only: reject a same-result re-mark (no rubber-stamping)
  if v_existing.id is not null and v_existing.result = p_result then
    raise exception 'Already marked % by %. Only a different outcome can be recorded.',
      p_result, coalesce(v_existing.marked_by_name, 'someone');
  end if;

  -- 8. upsert with per-item stamping (marked_* set on every write)
  insert into public.apparatus_check_results
    (department_id, check_id, item_id, item_label, result, note, marked_by, marked_by_name, marked_at)
  values
    (v_check.department_id, p_check_id, p_item_id, v_item.label, p_result, v_note, v_member.id, v_member.name, now())
  on conflict (check_id, item_id) do update
    set result         = excluded.result,
        note           = excluded.note,
        marked_by      = excluded.marked_by,
        marked_by_name = excluded.marked_by_name,
        marked_at      = excluded.marked_at
  returning * into v_row;

  return v_row;
end;
$function$;

REVOKE ALL ON FUNCTION public.mark_check_item(uuid, uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.mark_check_item(uuid, uuid, text, text) TO authenticated;

-- =====================================================================
-- VERIFICATION (run separately after the migration; not part of it)
-- =====================================================================
-- -- 1. Function present, SECURITY DEFINER, returns the result row:
-- select proname, prosecdef, pg_get_function_result(oid) as returns
-- from pg_proc where proname = 'mark_check_item';
-- --   expect: mark_check_item | t | apparatus_check_results
--
-- -- 2. Only authenticated can execute (public revoked):
-- select grantee, privilege_type
-- from information_schema.routine_privileges
-- where routine_name = 'mark_check_item';
-- --   expect: authenticated | EXECUTE  (no PUBLIC row)
--
-- -- 3. Behavior smoke test in a ROLLBACK tx (uses a real truck with >=1
-- --    active item; run each raise-check and read the message). Replace the
-- --    apparatus lookup if you want a specific rig.
-- -- begin;
-- --   -- start/resume a draft on the first truck that has an active item
-- --   select public.start_or_resume_check(
-- --     (select apparatus_id from public.apparatus_check_items where active limit 1)
-- --   ) as check_id \gset
-- --   -- an active item on that same truck
-- --   -- (grab one item_id for the truck the draft belongs to)
-- --   with c as (select apparatus_id from public.apparatus_checks where id = :'check_id')
-- --   select id as item_id from public.apparatus_check_items
-- --   where apparatus_id = (select apparatus_id from c) and active limit 1 \gset
-- --
-- --   -- a) first mark pass  -> writes, stamped
-- --   select result, marked_by_name, marked_at is not null as stamped
-- --   from public.mark_check_item(:'check_id', :'item_id', 'pass', null);
-- --
-- --   -- b) same result again -> ERROR "Already marked pass by ..."
-- --   -- select public.mark_check_item(:'check_id', :'item_id', 'pass', null);
-- --
-- --   -- c) fail with no note -> ERROR "A note is required ..."
-- --   -- select public.mark_check_item(:'check_id', :'item_id', 'fail', '   ');
-- --
-- --   -- d) fail WITH note -> writes (different outcome), stamped, note kept
-- --   select result, note, marked_by_name
-- --   from public.mark_check_item(:'check_id', :'item_id', 'fail', 'Low on foam');
-- --
-- --   -- e) bad result -> ERROR "Invalid result ..."
-- --   -- select public.mark_check_item(:'check_id', :'item_id', 'maybe', null);
-- --
-- --   -- one row per (check,item): the unique index held through the upserts
-- --   select count(*) from public.apparatus_check_results
-- --   where check_id = :'check_id' and item_id = :'item_id';   -- expect 1
-- -- rollback;
