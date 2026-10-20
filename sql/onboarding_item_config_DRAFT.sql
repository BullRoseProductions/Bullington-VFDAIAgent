-- =====================================================================
-- ONBOARDING ITEM CONFIG (per-item document check · approver · assignment) — DB slice. Review PASS 2026-10-19 (fb9d9c9) —
-- cleared to apply; NOT yet applied. Record: claude/B4C_Onboarding_ItemConfig_DB_ReviewRecord.md.
-- Order: claude/B4C_Onboarding_ItemConfig_DB_BuildOrder.md. Step 0 + 0b ran on live 2026-10-19 (the md5s pinned below).
-- Additive on the LIVE onboarding / probation module: an unconfigured item behaves exactly as today.
--
-- WHAT IT ADDS
--   onboarding_items    requires_doc · approver_kind ('tier' | 'person') · approver_role (Officer / Department Admin /
--                       Board Member, or NULL = today's any Board/DA/Officer) · approver_member_id (a named member)
--   onboarding_progress ready_at / ready_by (the member marked it ready — does NOT complete it) ·
--                       doc_checked_at / doc_checked_by (the approver attested the document was checked in person)
--   set_onboarding_item_config  DA / PA (is_dept_admin()): the item's document check + approver; pings a person approver
--   mark_onboarding_ready       the member, on their OWN item only (no member argument at all) — the one self-action
--   sign_off_onboarding_item    the approver: the named person / anyone in the tier / (unset) any Board, DA, Officer;
--                               a DA can always sign; NEVER the member themself (the self-sign block, byte-identical);
--                               a document item needs p_doc_checked = true (who + when recorded)
--   onboarding_signoff_queue    items marked ready, awaiting sign-off, that the caller can see (leadership: all; a person
--                               or tier approver: theirs), active / probationary members only
--   probation_item_states       (the existing path read, same columns) manual items now also read approver_not_set /
--                               awaiting_check / awaiting_approval
--   set_onboarding_item         ONE added guard: it won't tick a configured item done (that's sign_off_onboarding_item)
--
-- DOCUMENTS ARE CHECKED, NEVER STORED: no file / path / upload / scan column, no bucket, nothing to upload to. The
-- post-conditions assert that absence; the only storage bucket stays station-documents.
--
-- RULINGS (reviewer, Oct 19 — all four yes, bounded):
--   R1 set_onboarding_item refuses to tick DONE a configured item (requires_doc / a person / a tier) and points to
--      sign-off; unconfigured items and unticking are unchanged; the self-sign block is byte-identical on every path.
--   R2 RPC-only writes: authenticated loses INSERT / UPDATE on onboarding_progress entirely (completion, ready_*,
--      doc_checked_*); on onboarding_items it keeps the existing columns only. Every policy byte-identical. Raised
--      before drafting: no policy lets a MEMBER write their own progress row (INSERT / UPDATE are DA-only, there is no
--      DELETE policy) — the only direct path was a DA's, and this closes it.
--   R3 a person approver (only) is pinged through notifications in the action_items trigger's exact shape (skip self, honour
--      a 'tasks' mute, de-duped on member + type + subject, never fails the write) — when assigned, and when the member
--      marks the item ready. Tier items ping nobody (no fan-out to every officer).
--   R4 a tier is met by holding that access value in the department; a Department Admin can always sign (checked_by
--      records who actually signed); mark-ready, config and sign-off take manual, non-mentor items only — the config
--      RPC refuses any other item; ack / hours / cert stay auto-derived, mentor items unchanged.
--   Also: sign-off does not REQUIRE a prior mark-ready (an officer can sign off what they saw in person); a member who is
--   a person approver can't be deleted until the item is re-pointed (the FK has no ON DELETE action — the shape CHECK
--   forbids a person approver with no member, so SET NULL would fail anyway).
--
-- The locked verification column is never referenced or written (the post-condition spells the token split).
-- Single all-or-nothing DO block; refuses a second apply. State check at the end. Then NOTIFY pgrst.
-- =====================================================================
DO $migrate$
DECLARE
  PUBLIC_FNS constant text[] := array['public.set_onboarding_item_config(uuid,boolean,text,text,uuid)', 'public.mark_onboarding_ready(uuid)',
                                      'public.sign_off_onboarding_item(uuid,uuid,boolean)', 'public.onboarding_signoff_queue()'];
  INTERNAL_FNS constant text[] := array['public.onboarding_ping(uuid,uuid,text,text,text,text)', 'public.onboarding_caller_can_sign(uuid)'];
  BLOCK_RE constant text := '(?s)(if p_member_id = v_me then.*?end if;)';
  BLOCK_MD5 constant text := '43179b88c2683b93d0d227044be7df9f';
  OLD_COLS_I constant text := 'id, department_id, category, label, is_mentor, sort_order, created_at, clears_to_run, phase, kind, ack_series_id, hours_target, hours_source, cert_name';
  v_t text; v_pol_before text; v_pol_after text; v_total_before int; v_buckets_before text; v_tok_before int;
  v_ps_before text; v_trg_before text;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'onboarding_items' AND column_name = 'approver_kind')
     OR to_regprocedure('public.sign_off_onboarding_item(uuid,uuid,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: onboarding item config already exists — already applied. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure)) <> '99e6c6944216fe3811c6bbc365958e75' THEN
    RAISE EXCEPTION 'Precondition failed: set_onboarding_item is not the Step 0 version (md5 99e6c694…). Nothing changed.';
  END IF;
  IF md5(substring(pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure) from BLOCK_RE)) <> BLOCK_MD5 THEN
    RAISE EXCEPTION 'Precondition failed: the self-sign block is not the Step 0 block. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.probation_item_states(uuid,uuid)'::regprocedure)) <> '0e91cf1d69f03a7b1dcb9234b7284357' THEN
    RAISE EXCEPTION 'Precondition failed: probation_item_states is not the Step 0b version (md5 0e91cf1d…). Nothing changed.';
  END IF;
  FOREACH v_t IN ARRAY array['public.is_dept_admin()', 'public.is_canmanage()', 'public.my_member_id()', 'public.my_department_id()',
                             'public.is_muted(uuid,text)', 'public.probation_status(uuid,uuid)'] LOOP
    IF to_regprocedure(v_t) IS NULL THEN RAISE EXCEPTION 'Precondition failed: % is missing.', v_t; END IF;
  END LOOP;
  IF to_regclass('public.notifications') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'notifications'
       AND indexdef ILIKE '%UNIQUE%(member_id, type, subject_ref)%') THEN
    RAISE EXCEPTION 'Precondition failed: notifications or its (member_id, type, subject_ref) de-dupe index is missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('onboarding_items', 'onboarding_progress')
       AND column_name IN ('requires_doc', 'approver_role', 'approver_member_id', 'ready_at', 'ready_by', 'doc_checked_at', 'doc_checked_by')) THEN
    RAISE EXCEPTION 'Precondition failed: a new column name is already taken. Nothing changed.';
  END IF;
  FOREACH v_t IN ARRAY array['set_onboarding_item_config', 'mark_onboarding_ready', 'onboarding_signoff_queue', 'onboarding_ping', 'onboarding_caller_can_sign'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = v_t AND pronamespace = 'public'::regnamespace) THEN RAISE EXCEPTION 'Precondition failed: % already exists.', v_t; END IF;
  END LOOP;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT coalesce(string_agg(id, ',' ORDER BY id), '') INTO v_buckets_before FROM storage.buckets;
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;
  v_ps_before := md5(pg_get_functiondef('public.probation_status(uuid,uuid)'::regprocedure));
  SELECT string_agg(md5(pg_get_functiondef(t.tgfoid)), ',' ORDER BY t.tgname) INTO v_trg_before
    FROM pg_trigger t WHERE t.tgrelid = 'public.action_items'::regclass AND NOT t.tgisinternal;

  -- ---------------------------------------------------------------- schema (additive)
  ALTER TABLE public.onboarding_items
    ADD COLUMN requires_doc boolean NOT NULL DEFAULT false,
    ADD COLUMN approver_kind text NOT NULL DEFAULT 'tier',
    ADD COLUMN approver_role text,
    ADD COLUMN approver_member_id uuid REFERENCES public.members(id);
  ALTER TABLE public.onboarding_items
    ADD CONSTRAINT onboarding_items_approver_kind_chk CHECK (approver_kind IN ('tier', 'person')),
    ADD CONSTRAINT onboarding_items_approver_role_chk CHECK (approver_role IS NULL OR approver_role IN ('Officer', 'Department Admin', 'Board Member')),
    ADD CONSTRAINT onboarding_items_approver_shape_chk CHECK (
      (approver_kind = 'person' AND approver_member_id IS NOT NULL AND approver_role IS NULL)
      OR (approver_kind = 'tier' AND approver_member_id IS NULL)),
    ADD CONSTRAINT onboarding_items_config_manual_chk CHECK (
      (kind = 'manual' AND NOT is_mentor) OR (NOT requires_doc AND approver_kind = 'tier' AND approver_role IS NULL));
  ALTER TABLE public.onboarding_progress
    ADD COLUMN ready_at timestamptz,
    ADD COLUMN ready_by uuid REFERENCES public.members(id) ON DELETE SET NULL,
    ADD COLUMN doc_checked_at timestamptz,
    ADD COLUMN doc_checked_by uuid REFERENCES public.members(id) ON DELETE SET NULL;
  ALTER TABLE public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_ready_pair_chk CHECK (ready_by IS NULL OR ready_at IS NOT NULL),
    ADD CONSTRAINT onboarding_progress_doc_pair_chk CHECK (doc_checked_by IS NULL OR doc_checked_at IS NOT NULL);

  -- R2 (ruled Oct 19): progress is RPC-only — completion (done / checked_*), ready_* and doc_checked_* alike, so no
  -- client (a cadet, or a DA through the DA-only policies) can write a row and skip the gate. This retires the probation
  -- slice's deliberate transition-state grant; the app writes onboarding_progress only through the RPCs. On
  -- onboarding_items the client grant is narrowed to the existing columns (the DA's add / rename / reorder / item-config
  -- edits keep working) and the four approver columns are RPC-only. Every policy stays byte-identical.
  REVOKE INSERT, UPDATE ON public.onboarding_progress FROM authenticated;
  REVOKE INSERT, UPDATE ON public.onboarding_items FROM authenticated;
  EXECUTE format('GRANT INSERT (%s), UPDATE (%s) ON public.onboarding_items TO authenticated', OLD_COLS_I, OLD_COLS_I);

  -- ---------------------------------------------------------------- functions
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.onboarding_ping(p_dept uuid, p_member uuid, p_type text, p_title text, p_body text, p_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:onboarding_item_config (internal) — notify_action_item_assigned()'s shape: skip the caller themself, honour a
-- 'tasks' mute, one row per (member, type, subject), and never fail the write it rides on.
begin
  if p_member is null or p_dept is null or p_member = public.my_member_id() then return; end if;
  if public.is_muted(p_member, 'tasks') then return; end if;
  insert into public.notifications (department_id, member_id, type, title, body, subject_ref, severity)
  values (p_dept, p_member, p_type, p_title, left(p_body, 240), p_ref, 'info')
  on conflict (member_id, type, subject_ref) do nothing;
exception when others then
  raise warning 'onboarding_ping failed for %: %', p_ref, sqlerrm;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.onboarding_caller_can_sign(p_item_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:onboarding_item_config (internal) — may the CALLER sign this item off? The named person; anyone holding the set
-- tier in the department; no approver set = today's rule (Board / DA / Officer); a Department Admin always.
  select coalesce((
    select case when i.approver_kind = 'person' then i.approver_member_id = public.my_member_id()
                when i.approver_role is not null then exists (select 1 from public.members m
                       where m.id = public.my_member_id() and m.access && array[i.approver_role])
                else coalesce(public.is_canmanage(), false) end
      from public.onboarding_items i
     where i.id = p_item_id and i.department_id = public.my_department_id()), false)
    or (coalesce(public.is_dept_admin(), false)
        and exists (select 1 from public.onboarding_items i where i.id = p_item_id and i.department_id = public.my_department_id()));
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_onboarding_item(p_member_id uuid, p_item_id uuid, p_done boolean)
 RETURNS onboarding_progress
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_done boolean := coalesce(p_done, false);
  v_row  public.onboarding_progress;
begin
  if not public.is_canmanage() then
    raise exception 'Not authorized';
  end if;
  if v_dept is null or v_me is null then
    raise exception 'We could not match your login to a department.';
  end if;
  -- SELF-SIGN BLOCK (the only change): a leader can't sign off their OWN onboarding.
  if p_member_id = v_me then
    raise exception 'You can''t sign off your own onboarding — a mentor or officer does.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if not exists (select 1 from public.onboarding_items where id = p_item_id and department_id = v_dept) then
    raise exception 'That checklist item is not in your department.';
  end if;
  if exists (select 1 from public.onboarding_items where id = p_item_id and is_mentor) then
    raise exception 'The mentor item completes when a mentor is assigned.';
  end if;
  -- ITEM CONFIG (onboarding_item_config): an item with a set approver or a document check is signed off through
  -- sign_off_onboarding_item, which enforces both. An unconfigured item is unchanged; unticking is unchanged.
  if v_done and exists (select 1 from public.onboarding_items where id = p_item_id
              and (requires_doc or approver_kind = 'person' or approver_role is not null)) then
    raise exception 'This item has a set approver — sign it off from the sign-off list.';
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
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.probation_item_states(p_member uuid, p_dept uuid)
 RETURNS TABLE(item_id uuid, label text, category text, phase text, kind text, clears_to_run boolean, sort_order integer, satisfied boolean, state text, signed_by_name text, signed_at timestamp with time zone, have numeric, target numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation (internal) — every onboarding item of the department, resolved for one member. Read-only.
-- onboarding_item_config: a manual item can also read approver_not_set / awaiting_check / awaiting_approval.
  with mem as (select m.id, m.mentor_id from public.members m where m.id = p_member and m.department_id = p_dept),
       pr as (select (select mp.started_on from public.member_probation mp where mp.member_id = p_member) as started_on),
       td as (select (now() at time zone 'America/Chicago')::date as d)
  select i.id, i.label, i.category, i.phase, i.kind, i.clears_to_run, i.sort_order,
         case when i.kind = 'manual' and i.is_mentor then mem.mentor_id is not null
              when i.kind = 'manual' then coalesce(pg.done, false)
              when i.kind = 'ack'    then ak.series_id is not null and ak.published and (not ak.in_audience or ak.signed_current)
              when i.kind = 'hours'  then i.hours_target is not null and i.hours_source is not null and hr.have >= i.hours_target
              when i.kind = 'cert'   then nullif(btrim(coalesce(i.cert_name, '')), '') is not null and ct.current
         end,
         case when i.kind = 'manual' and i.is_mentor then case when mem.mentor_id is not null then 'mentor_assigned' else 'open' end
              when i.kind = 'manual' then case when pg.done and pg.checked_by is not null then 'signed'
                                               when pg.done then 'done_unrecorded'
                                               when not coalesce(ap.resolvable, true) then 'approver_not_set'
                                               when pg.ready_at is not null and i.requires_doc then 'awaiting_check'
                                               when pg.ready_at is not null then 'awaiting_approval' else 'open' end
              when i.kind = 'ack' then case when ak.series_id is null or not ak.published then 'not_configured'
                                            when not ak.in_audience then 'not_required'
                                            when ak.signed_current then 'signed_current' else 'needs_signature' end
              when i.kind = 'hours' then case when i.hours_target is null or i.hours_source is null then 'not_configured'
                                              when hr.have >= i.hours_target then 'met' else 'in_progress' end
              when i.kind = 'cert' then case when nullif(btrim(coalesce(i.cert_name, '')), '') is null then 'not_configured'
                                             when ct.current then 'current' else 'missing' end
         end,
         case when i.kind = 'manual' and not i.is_mentor and pg.done then pg.signer end,
         case when i.kind = 'manual' and not i.is_mentor and pg.done then pg.checked_at end,
         case when i.kind = 'hours' then hr.have end,
         case when i.kind = 'hours' then i.hours_target end
    from public.onboarding_items i
    cross join mem cross join pr cross join td
    left join lateral (select p.done, p.checked_by, p.checked_at, p.ready_at, cb.name as signer
                         from public.onboarding_progress p left join public.members cb on cb.id = p.checked_by
                        where p.member_id = p_member and p.item_id = i.id
                        order by p.checked_at desc nulls last limit 1) pg on true
    left join lateral (select s.series_id, (s.requires_ack and s.current_version > 0) as published,
                              public.rs_member_in_audience(p_member, s.required_roles) as in_audience,
                              exists (select 1 from public.document_acknowledgments k
                                       where k.member_id = p_member and k.series_id = s.series_id and k.version = s.current_version
                                         and (not s.annual_resign or (k.signed_at at time zone 'America/Chicago')::date + interval '12 months' > td.d)) as signed_current
                         from public.document_series s
                        where i.kind = 'ack' and s.series_id = i.ack_series_id and s.department_id = p_dept) ak on true
    left join lateral (select case when i.hours_source = 'training_nights' then
                                (select count(distinct a.session_id)::numeric from public.session_attendance a
                                   join public.training_sessions t on t.id = a.session_id and t.department_id = p_dept
                                  where a.member_id = p_member and t.date <= td.d)
                              else
                                (select coalesce(sum(ss.hours), 0) from public.supervised_sessions ss
                                  where ss.member_id = p_member and ss.department_id = p_dept and ss.voided_at is null
                                    and (i.hours_source = 'supervised' or ss.kind = i.hours_source))
                              end as have
                        where i.kind = 'hours') hr on true
    left join lateral (select exists (select 1 from public.certs c
                                        where c.member_id = p_member and lower(btrim(c.name)) = lower(btrim(i.cert_name))
                                          and c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                                          and split_part(c.exp, '-', 1)::int * 12 + split_part(c.exp, '-', 2)::int
                                              >= extract(year from td.d)::int * 12 + extract(month from td.d)::int) as current
                        where i.kind = 'cert') ct on true
    left join lateral (select case when i.approver_kind = 'person' then exists (select 1 from public.members am
                                        where am.id = i.approver_member_id and am.department_id = p_dept and am.status in ('Active', 'Probationary'))
                                   when i.approver_role is not null then exists (select 1 from public.members am
                                        where am.department_id = p_dept and am.status in ('Active', 'Probationary') and am.access && array[i.approver_role])
                                   else true end as resolvable
                        where i.kind = 'manual' and not i.is_mentor) ap on true
   where i.department_id = p_dept;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_onboarding_item_config(p_item_id uuid, p_requires_doc boolean, p_approver_kind text, p_approver_role text DEFAULT NULL, p_approver_member_id uuid DEFAULT NULL)
 RETURNS public.onboarding_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:onboarding_item_config — a Department Admin (or PA) sets an item's document check and who signs it off: a named
-- member of the department, or a command tier (NULL tier = any Board / DA / Officer, today's rule). A newly named
-- person is pinged. Never touches the locked verification column.
declare
  v_dept uuid := public.my_department_id();
  v_kind text := coalesce(p_approver_kind, 'tier');
  v_doc  boolean := coalesce(p_requires_doc, false);
  v_item public.onboarding_items;
  v_new  public.onboarding_items;
begin
  if v_dept is null or not coalesce(public.is_dept_admin(), false) then
    raise exception 'Only a Department Admin can set who signs off an item.';
  end if;
  select * into v_item from public.onboarding_items where id = p_item_id and department_id = v_dept;
  if not found then
    raise exception 'That checklist item is not in your department.';
  end if;
  if v_item.kind <> 'manual' or v_item.is_mentor then
    raise exception 'Only a checklist item an officer checks off can have an approver or a document check.';
  end if;
  if v_kind not in ('tier', 'person') then
    raise exception 'Unknown approver type.';
  end if;
  if v_kind = 'person' then
    if p_approver_role is not null then
      raise exception 'Pick a person or a tier, not both.';
    end if;
    if p_approver_member_id is null or not exists (select 1 from public.members
         where id = p_approver_member_id and department_id = v_dept and status in ('Active', 'Probationary')) then
      raise exception 'That approver isn''t an active member of your department.';
    end if;
  else
    if p_approver_member_id is not null then
      raise exception 'Pick a person or a tier, not both.';
    end if;
    if p_approver_role is not null and p_approver_role not in ('Officer', 'Department Admin', 'Board Member') then
      raise exception 'Unknown command tier.';
    end if;
  end if;
  update public.onboarding_items
     set requires_doc = v_doc, approver_kind = v_kind,
         approver_role = case when v_kind = 'tier' then p_approver_role end,
         approver_member_id = case when v_kind = 'person' then p_approver_member_id end
   where id = p_item_id
  returning * into v_new;
  if v_kind = 'person' and v_item.approver_member_id is distinct from p_approver_member_id then
    perform public.onboarding_ping(v_dept, p_approver_member_id, 'onboarding_approver', 'You sign off an onboarding item',
      'You''re the approver for "' || v_item.label || '" on new members'' onboarding.'
      || case when v_doc then ' It needs their document checked in person — B4C doesn''t store it.' else '' end,
      'onb-approver:' || p_item_id::text);
  end if;
  return v_new;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.mark_onboarding_ready(p_item_id uuid)
 RETURNS public.onboarding_progress
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:onboarding_item_config — the member marks one of their OWN checklist items ready for sign-off. There is no
-- member argument: it can only ever act on the caller. It never completes the item (done / checked_* untouched).
-- Idempotent. A person approver is pinged.
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_item public.onboarding_items;
  v_row  public.onboarding_progress;
  v_name text;
begin
  if v_dept is null or v_me is null then
    raise exception 'We could not match your login to a department.';
  end if;
  select * into v_item from public.onboarding_items where id = p_item_id and department_id = v_dept;
  if not found then
    raise exception 'That checklist item is not in your department.';
  end if;
  if v_item.kind <> 'manual' or v_item.is_mentor then
    raise exception 'This item completes on its own — there''s nothing to mark ready.';
  end if;
  select * into v_row from public.onboarding_progress where member_id = v_me and item_id = p_item_id;
  if found and (v_row.done or v_row.ready_at is not null) then
    return v_row;
  end if;
  insert into public.onboarding_progress (department_id, member_id, item_id, done, ready_at, ready_by)
  values (v_dept, v_me, p_item_id, false, now(), v_me)
  on conflict (member_id, item_id) do update
     set ready_at = excluded.ready_at, ready_by = excluded.ready_by
  returning * into v_row;
  if v_item.approver_kind = 'person' then
    select name into v_name from public.members where id = v_me;
    perform public.onboarding_ping(v_dept, v_item.approver_member_id, 'onboarding_ready', 'Ready for your sign-off',
      coalesce(v_name, 'A member') || ' marked "' || v_item.label || '" ready for your sign-off.'
      || case when v_item.requires_doc then ' Check their document in person.' else '' end,
      'onb-ready:' || v_me::text || ':' || p_item_id::text);
  end if;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.sign_off_onboarding_item(p_member_id uuid, p_item_id uuid, p_doc_checked boolean DEFAULT false)
 RETURNS public.onboarding_progress
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:onboarding_item_config — the item's approver signs a member's checklist item off (onboarding_caller_can_sign:
-- the named person / the tier / no approver set = Board, DA, Officer / a DA always). Never the member themself. A
-- document item needs the in-person check attested (p_doc_checked) — recorded as who + when; B4C stores no document.
-- Never touches the locked verification column.
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_item public.onboarding_items;
  v_row  public.onboarding_progress;
begin
  if v_dept is null or v_me is null then
    raise exception 'We could not match your login to a department.';
  end if;
  if p_member_id = v_me then
    raise exception 'You can''t sign off your own onboarding — a mentor or officer does.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  select * into v_item from public.onboarding_items where id = p_item_id and department_id = v_dept;
  if not found then
    raise exception 'That checklist item is not in your department.';
  end if;
  if v_item.kind <> 'manual' or v_item.is_mentor then
    raise exception 'Only a checklist item an officer checks off can be signed off here.';
  end if;
  if not public.onboarding_caller_can_sign(p_item_id) then
    raise exception '%', case when v_item.approver_kind = 'person' then 'Only the approver set for this item (or a Department Admin) can sign it off.'
                              when v_item.approver_role is not null then format('Only someone with %s access (or a Department Admin) can sign this item off.', v_item.approver_role)
                              else 'Only department leadership can sign this item off.' end;
  end if;
  if v_item.requires_doc and not coalesce(p_doc_checked, false) then
    raise exception 'This item needs its document checked in person — confirm the check to sign it off.';
  end if;
  if exists (select 1 from public.onboarding_progress where member_id = p_member_id and item_id = p_item_id and done and checked_by is not null) then
    raise exception 'This item is already signed off.';
  end if;
  insert into public.onboarding_progress (department_id, member_id, item_id, done, checked_by, checked_at, doc_checked_at, doc_checked_by)
  values (v_dept, p_member_id, p_item_id, true, v_me, now(),
          case when v_item.requires_doc then now() end,
          case when v_item.requires_doc then v_me end)
  on conflict (member_id, item_id) do update
     set done           = true,
         checked_by     = excluded.checked_by,
         checked_at     = excluded.checked_at,
         doc_checked_at = excluded.doc_checked_at,
         doc_checked_by = excluded.doc_checked_by
  returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.onboarding_signoff_queue()
 RETURNS TABLE(member_id uuid, member_name text, item_id uuid, label text, category text, phase text, requires_doc boolean,
               approver_kind text, approver_role text, approver_member_id uuid, approver_name text, ready_at timestamp with time zone, can_sign boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:onboarding_item_config — items members marked ready that still await sign-off. Board / DA / Officer see the
-- department's; anyone else sees only the items they can sign (a person or tier approver). Active / probationary,
-- not separated; never the caller's own items. Read-only.
#variable_conflict use_column
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_lead boolean := coalesce(public.is_canmanage(), false);
begin
  if v_dept is null or v_me is null then
    raise exception 'We could not match your login to a department.';
  end if;
  return query
  select p.member_id, m.name, i.id, i.label, i.category, i.phase, i.requires_doc,
         i.approver_kind, i.approver_role, i.approver_member_id, ap.name, p.ready_at, public.onboarding_caller_can_sign(i.id)
    from public.onboarding_progress p
    join public.onboarding_items i on i.id = p.item_id and i.department_id = v_dept
    join public.members m on m.id = p.member_id and m.department_id = v_dept and m.status in ('Active', 'Probationary')
    left join public.members ap on ap.id = i.approver_member_id
   where p.department_id = v_dept and p.ready_at is not null and not p.done and p.member_id <> v_me
     and not exists (select 1 from public.member_separation s where s.member_id = m.id)
     and (v_lead or public.onboarding_caller_can_sign(i.id))
   order by p.ready_at, m.name;
end;
$function$
$ddl$;

  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_t);
  END LOOP;
  FOREACH v_t IN ARRAY INTERNAL_FNS LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, public', v_t);
  END LOOP;

  -- ---------------------------------------------------------------- post-conditions
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.onboarding_items'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.onboarding_progress'::regclass) THEN
    RAISE EXCEPTION 'Post-condition failed: RLS is off on an onboarding table.';
  END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  IF v_pol_after IS DISTINCT FROM v_pol_before OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN
    RAISE EXCEPTION 'Post-condition failed: a policy changed or was added (expected none).';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND ((table_name = 'onboarding_items' AND column_name IN ('requires_doc', 'approver_kind', 'approver_role', 'approver_member_id'))
          OR (table_name = 'onboarding_progress' AND column_name IN ('ready_at', 'ready_by', 'doc_checked_at', 'doc_checked_by')))) <> 8
     OR (SELECT count(*) FROM pg_constraint WHERE conname IN ('onboarding_items_approver_kind_chk', 'onboarding_items_approver_role_chk',
          'onboarding_items_approver_shape_chk', 'onboarding_items_config_manual_chk', 'onboarding_progress_ready_pair_chk', 'onboarding_progress_doc_pair_chk')) <> 6 THEN
    RAISE EXCEPTION 'Post-condition failed: a new column or check is missing.';
  END IF;
  -- documents are checked, never stored: no file-ish column on either table, no new bucket
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('onboarding_items', 'onboarding_progress')
       AND column_name ~* '(proof|path|file|upload|scan|storage|url|attach|document|image|photo)') THEN
    RAISE EXCEPTION 'Post-condition failed: an onboarding table has a stored-file column — documents are checked, never stored.';
  END IF;
  IF (SELECT coalesce(string_agg(id, ',' ORDER BY id), '') FROM storage.buckets) IS DISTINCT FROM v_buckets_before THEN
    RAISE EXCEPTION 'Post-condition failed: the storage buckets changed.';
  END IF;
  -- R2: no client can write any progress column; the new item columns are RPC-only; existing item columns still writable
  FOREACH v_t IN ARRAY array['id', 'department_id', 'member_id', 'item_id', 'done', 'checked_by', 'checked_at', 'created_at', 'ready_at', 'ready_by', 'doc_checked_at', 'doc_checked_by'] LOOP
    IF has_column_privilege('authenticated', 'public.onboarding_progress', v_t, 'INSERT') OR has_column_privilege('authenticated', 'public.onboarding_progress', v_t, 'UPDATE') THEN
      RAISE EXCEPTION 'Post-condition failed: a client can write onboarding_progress.%.', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY array['requires_doc', 'approver_kind', 'approver_role', 'approver_member_id'] LOOP
    IF has_column_privilege('authenticated', 'public.onboarding_items', v_t, 'INSERT') OR has_column_privilege('authenticated', 'public.onboarding_items', v_t, 'UPDATE') THEN
      RAISE EXCEPTION 'Post-condition failed: a client can write onboarding_items.%.', v_t;
    END IF;
  END LOOP;
  IF NOT has_column_privilege('authenticated', 'public.onboarding_items', 'label', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.onboarding_items', 'label', 'INSERT') THEN
    RAISE EXCEPTION 'Post-condition failed: an existing column lost its client grant (the current app writes it).';
  END IF;
  FOREACH v_t IN ARRAY PUBLIC_FNS || INTERNAL_FNS || array['public.set_onboarding_item(uuid,uuid,boolean)', 'public.probation_item_states(uuid,uuid)'] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_t::regprocedure)
       OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_t::regprocedure AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION 'Post-condition failed: % is not SECURITY DEFINER with a pinned search_path.', v_t;
    END IF;
    IF position('is_leader' in pg_get_functiondef(v_t::regprocedure)) > 0 THEN RAISE EXCEPTION 'Post-condition failed: % uses a role-anywhere leader gate.', v_t; END IF;
    IF position(('verifie' || 'd') in pg_get_functiondef(v_t::regprocedure)) > 0 THEN RAISE EXCEPTION 'Post-condition failed: % references the locked verification column.', v_t; END IF;
    IF has_function_privilege('anon', v_t, 'EXECUTE') THEN RAISE EXCEPTION 'Post-condition failed: anon can execute %.', v_t; END IF;
  END LOOP;
  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    IF NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN RAISE EXCEPTION 'Post-condition failed: members can''t execute %.', v_t; END IF;
  END LOOP;
  FOREACH v_t IN ARRAY INTERNAL_FNS || array['public.probation_item_states(uuid,uuid)'] LOOP
    IF has_function_privilege('authenticated', v_t, 'EXECUTE') THEN RAISE EXCEPTION 'Post-condition failed: the internal % is callable by members.', v_t; END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.set_onboarding_item(uuid,uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: set_onboarding_item lost its member grant.';
  END IF;
  -- the self-sign block, byte-identical to Step 0, in BOTH sign-off paths
  IF md5(substring(pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure) from BLOCK_RE)) <> BLOCK_MD5
     OR md5(substring(pg_get_functiondef('public.sign_off_onboarding_item(uuid,uuid,boolean)'::regprocedure) from BLOCK_RE)) <> BLOCK_MD5 THEN
    RAISE EXCEPTION 'Post-condition failed: the self-sign block is not byte-identical to Step 0 (md5 %).', BLOCK_MD5;
  END IF;
  IF position('requires_doc' in pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure)) = 0
     OR position('p_doc_checked' in pg_get_functiondef('public.sign_off_onboarding_item(uuid,uuid,boolean)'::regprocedure)) = 0
     OR position('onboarding_caller_can_sign' in pg_get_functiondef('public.sign_off_onboarding_item(uuid,uuid,boolean)'::regprocedure)) = 0
     OR position('is_dept_admin()' in pg_get_functiondef('public.set_onboarding_item_config(uuid,boolean,text,text,uuid)'::regprocedure)) = 0
     OR position('is_muted(p_member, ''tasks'')' in pg_get_functiondef('public.onboarding_ping(uuid,uuid,text,text,text,text)'::regprocedure)) = 0
     OR pg_get_function_identity_arguments('public.mark_onboarding_ready(uuid)'::regprocedure) <> 'p_item_id uuid' THEN
    RAISE EXCEPTION 'Post-condition failed: a gate, the document check, the mute or the own-item-only shape is missing.';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
  IF md5(pg_get_functiondef('public.probation_status(uuid,uuid)'::regprocedure)) <> v_ps_before
     OR (SELECT string_agg(md5(pg_get_functiondef(t.tgfoid)), ',' ORDER BY t.tgname) FROM pg_trigger t
          WHERE t.tgrelid = 'public.action_items'::regclass AND NOT t.tgisinternal) IS DISTINCT FROM v_trg_before THEN
    RAISE EXCEPTION 'Post-condition failed: probation_status or the action_items trigger changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.onboarding_items WHERE requires_doc OR approver_kind <> 'tier' OR approver_role IS NOT NULL OR approver_member_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.onboarding_progress WHERE ready_at IS NOT NULL OR doc_checked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Post-condition failed: an existing row came out configured — every item must start unconfigured.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: cols 8 · fns 6 all DEFINER · anon_exec false · internal_exec false · both self-sign blocks
-- 43179b88… · progress_client_write false · item_config_client_write false · item_label_client_write true ·
-- configured_items 0 · total_policies unchanged (169 on live) · buckets station-documents)
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
     AND ((table_name = 'onboarding_items' AND column_name IN ('requires_doc', 'approver_kind', 'approver_role', 'approver_member_id'))
       OR (table_name = 'onboarding_progress' AND column_name IN ('ready_at', 'ready_by', 'doc_checked_at', 'doc_checked_by')))) AS cols,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_onboarding_item_config', 'mark_onboarding_ready',
     'sign_off_onboarding_item', 'onboarding_signoff_queue', 'onboarding_ping', 'onboarding_caller_can_sign')) AS fns,
  (SELECT bool_and(prosecdef) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_onboarding_item_config', 'mark_onboarding_ready',
     'sign_off_onboarding_item', 'onboarding_signoff_queue', 'onboarding_ping', 'onboarding_caller_can_sign')) AS all_definer,
  has_function_privilege('anon', 'public.sign_off_onboarding_item(uuid,uuid,boolean)', 'EXECUTE') AS anon_exec,
  has_function_privilege('authenticated', 'public.onboarding_caller_can_sign(uuid)', 'EXECUTE') AS internal_exec,
  md5(substring(pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure) from '(?s)(if p_member_id = v_me then.*?end if;)')) AS soi_block_md5,
  md5(substring(pg_get_functiondef('public.sign_off_onboarding_item(uuid,uuid,boolean)'::regprocedure) from '(?s)(if p_member_id = v_me then.*?end if;)')) AS signoff_block_md5,
  (has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT') OR has_table_privilege('authenticated', 'public.onboarding_progress', 'UPDATE')
    OR has_column_privilege('authenticated', 'public.onboarding_progress', 'done', 'UPDATE')) AS progress_client_write,
  has_column_privilege('authenticated', 'public.onboarding_items', 'approver_member_id', 'UPDATE') AS item_config_client_write,
  has_column_privilege('authenticated', 'public.onboarding_items', 'label', 'UPDATE') AS item_label_client_write,
  (SELECT count(*) FROM public.onboarding_items WHERE requires_doc OR approver_kind <> 'tier' OR approver_role IS NOT NULL) AS configured_items,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT string_agg(id, ',' ORDER BY id) FROM storage.buckets) AS buckets;
