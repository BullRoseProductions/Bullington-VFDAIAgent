-- =====================================================================
-- PHASE 3.1 #2 — ONBOARDING -> CLEARED-TO-RUN + PROBATION LIFECYCLE (DB layer).
-- DRAFT — UNREVIEWED. Not applied. Test: sql/probation_RETEST.sql (run AFTER, separately).
-- Brief: claude/B4C_Phase3.1_Onboarding_Probation_BuildOrder.md (+ decisions 2026-10-17). Step 0: sql/probation_STEP0_CHECK.sql.
--
-- EXTENDS the shipped onboarding — onboarding_items / onboarding_progress / set_onboarding_item are NOT rebuilt:
--   set_onboarding_item's body, every existing policy and the onboarding_progress transition-state grant (authenticated
--   INSERT/UPDATE, the deferred REVOKE) are left exactly as they are — post-conditions prove it.
--
-- WHAT CHANGES:
--   1. onboarding_items + clears_to_run (default false) · phase ('onboarding' | 'probation', default 'onboarding') ·
--      kind ('manual' | 'ack' | 'hours' | 'cert', default 'manual') · ack_series_id · hours_target · hours_source ·
--      cert_name. All defaulted/nullable, so every existing item stays a manual onboarding item that is NOT in the gate.
--      Still DA-edited through the table's existing DA policies (no new write path).
--      Indian Harbor's "Probationary Period" items are pre-set to phase 'probation' (DAs can re-assign).
--   2. member_probation (member_id PK, started_on NULLABLE, note) — the start anchor. Backfilled ONLY for Probationary
--      members whose member_private.joined_date is set (Step 0: IH 2 of 7, North Hood 2 of 2); everyone else reads
--      "Probation start not set" — never a made-up day count. DA sets the rest (set_member_probation).
--   3. probation_milestones (30day / 60day / 90day / final; pending | on_track | needs_work | done; short officer note;
--      signed_by / signed_at). due_on is COMPUTED at read from started_on (+30 / +60 / +90 / +180 days), not stored, so
--      a corrected start date can never leave stale due dates behind (a deliberate divergence from the brief's column).
--   4. supervised_sessions — the ride-along / drive / shift log (built here, reused by #3). Leader-logged (D4).
--   All three new tables: RLS on, SELECT-only grant, ONE read policy each — own row, or Board/DA/Officer of the
--   department (is_canmanage()); zero write policies, zero write grants. Writes go through the RPCs only.
--
--   RPCs (SECURITY DEFINER, department-scoped, never touch the locked verification column):
--     set_member_probation(member, started_on, note)        — a DA of the department (is_dept_admin()); not self.
--     set_probation_milestone(member, kind, status, note)    — Board/DA/Officer (is_canmanage()); not self; the member
--                                                             must be Probationary in the caller's department.
--     log_supervised_session(member, kind, hours, occurred_on, apparatus?, supervisor?, note?)
--                                                           — Board/DA/Officer (is_canmanage()); not self; supervisor
--                                                             (defaults to the caller) is in the department and is
--                                                             never the member; apparatus (if any) in the department.
--     my_probation_status()                                 — the caller's own path (jsonb).
--     member_probation_status(member)                       — a leader viewing one member's path (to sign it); a
--                                                             member may call it for themself only. (ADDITION to the
--                                                             brief: the officer screen needs the per-member detail.)
--     dept_probation_board()                                — Board/DA/Officer: every probationary member, honest
--                                                             denominator (not Inactive, not former, not Project Admin),
--                                                             with cleared_to_run + ready_for_vote. Read-time only.
--   Internal (NOT callable by members): probation_item_states(member, dept), probation_status(member, dept).
--
-- RULES (computed at read, America/Chicago):
--   item satisfied — manual: an onboarding_progress row done (mentor item: members.mentor_id set). A done row with no
--     checked_by reads 'done_unrecorded' ("Done — sign-off not recorded"; legacy direct ticks — not backfilled).
--     ack: Level 1 only — the linked series (this department, requires a signature, published) is signed at its CURRENT
--     version (and within 12 months when annual) — the same rule as dept_read_sign_compliance. A member outside the
--     document's audience can't sign it, so for them the item reads 'not_required' and counts as satisfied. A missing /
--     unpublished link reads 'not_configured' and is NOT satisfied. No roster / crediting block (Level 2 is a follow-up).
--     hours: hours_source 'supervised' (all logged sessions) | 'ride_along' | 'drive' | 'shift' (that kind) |
--     'training_nights' (COUNT of training sessions attended on/after started_on, up to today) >= hours_target.
--     cert: a cert named cert_name (case/space-insensitive) with a dated, unexpired exp ('YYYY-MM', the app's
--     certStatus rule). Undated never counts.
--   gate — the department's clears_to_run items. None marked -> configured false -> "Gate not configured" (never
--     "cleared"). cleared_to_run = configured AND every gate item satisfied.
--   ready_for_vote — status Probationary AND cleared_to_run AND every phase='probation' item satisfied AND all four
--     milestones 'done'. Surface only (D5/D6): the Board votes; a DA flips the status in Edit member. No new status path.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_soi_before text; v_n int; v_ih uuid; v_t text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename NOT IN ('member_probation', 'probation_milestones', 'supervised_sessions')$q$;
  NEW_TABLES constant text[] := array['member_probation', 'probation_milestones', 'supervised_sessions'];
  PUBLIC_FNS constant text[] := array['public.set_member_probation(uuid,date,text)', 'public.set_probation_milestone(uuid,text,text,text)',
    'public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text)', 'public.my_probation_status()',
    'public.member_probation_status(uuid)', 'public.dept_probation_board()'];
  INTERNAL_FNS constant text[] := array['public.probation_item_states(uuid,uuid)', 'public.probation_status(uuid,uuid)'];
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.member_probation') IS NOT NULL OR to_regclass('public.probation_milestones') IS NOT NULL
     OR to_regclass('public.supervised_sessions') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'onboarding_items' AND column_name = 'clears_to_run') THEN
    RAISE EXCEPTION 'Precondition failed: probation is already applied (a new table or onboarding_items.clears_to_run exists). Nothing changed.';
  END IF;
  FOREACH v_t IN ARRAY array['is_canmanage()', 'is_canmanage_ops()', 'is_dept_admin()'] LOOP
    IF to_regprocedure('public.' || v_t) IS NULL OR position('my_department_id()' in pg_get_functiondef(('public.' || v_t)::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: % is missing or no longer department-scoped — do not build on it.', v_t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.my_member_id()') IS NULL OR to_regprocedure('public.my_department_id()') IS NULL
     OR to_regprocedure('public.rs_member_in_audience(uuid,text[])') IS NULL OR to_regclass('public.document_acknowledgments') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_member_id / my_department_id / Read & Sign (rs_member_in_audience, document_acknowledgments) missing.';
  END IF;
  IF to_regprocedure('public.set_onboarding_item(uuid,uuid,boolean)') IS NULL
     OR position('sign off your own onboarding' in pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: set_onboarding_item (with the self-sign block) is not live.';
  END IF;
  -- the columns this reads, checked rather than assumed (schema.sql is stale)
  FOR v_t IN SELECT x FROM unnest(array['member_private.joined_date:date', 'certs.exp:text', 'certs.name:text', 'certs.member_id:uuid',
      'members.mentor_id:uuid', 'members.status:text', 'members.access:ARRAY', 'apparatus.department_id:uuid', 'session_attendance.session_id:uuid',
      'session_attendance.member_id:uuid', 'training_sessions.date:date', 'training_sessions.department_id:uuid', 'member_separation.member_id:uuid',
      'onboarding_items.is_mentor:boolean', 'onboarding_progress.checked_by:uuid']) x LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = split_part(split_part(v_t, ':', 1), '.', 1) AND column_name = split_part(split_part(v_t, ':', 1), '.', 2)
                     AND data_type = CASE split_part(v_t, ':', 2) WHEN 'ARRAY' THEN 'ARRAY' WHEN 'date' THEN 'date' WHEN 'text' THEN 'text'
                                                                   WHEN 'uuid' THEN 'uuid' WHEN 'boolean' THEN 'boolean' END) THEN
      RAISE EXCEPTION 'Precondition failed: column % is missing or not the expected type.', v_t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM public.departments WHERE name ILIKE 'Indian Harbor%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Precondition failed: expected exactly one Indian Harbor department, found %.', v_n; END IF;
  SELECT id INTO v_ih FROM public.departments WHERE name ILIKE 'Indian Harbor%';
  IF NOT has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT') OR NOT has_table_privilege('authenticated', 'public.onboarding_progress', 'UPDATE') THEN
    RAISE EXCEPTION 'Precondition failed: the onboarding_progress transition-state grant is gone — the brief assumes it is still in place. Nothing changed.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;
  v_soi_before := pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure);

  -- ---------------------------------------------------------------- 1. onboarding_items — additive config columns
  ALTER TABLE public.onboarding_items
    ADD COLUMN clears_to_run boolean NOT NULL DEFAULT false,
    ADD COLUMN phase         text    NOT NULL DEFAULT 'onboarding',
    ADD COLUMN kind          text    NOT NULL DEFAULT 'manual',
    ADD COLUMN ack_series_id uuid,                -- no FK: a series removed later reads 'not_configured' rather than blocking the delete
    ADD COLUMN hours_target  numeric,
    ADD COLUMN hours_source  text,
    ADD COLUMN cert_name     text;
  ALTER TABLE public.onboarding_items
    ADD CONSTRAINT onboarding_items_phase_chk  CHECK (phase IN ('onboarding', 'probation')),
    ADD CONSTRAINT onboarding_items_kind_chk   CHECK (kind IN ('manual', 'ack', 'hours', 'cert')),
    ADD CONSTRAINT onboarding_items_mentor_manual_chk CHECK (NOT is_mentor OR kind = 'manual'),
    ADD CONSTRAINT onboarding_items_hours_chk  CHECK (hours_target IS NULL OR (hours_target > 0 AND hours_target <= 10000)),
    ADD CONSTRAINT onboarding_items_source_chk CHECK (hours_source IS NULL OR hours_source IN ('supervised', 'ride_along', 'drive', 'shift', 'training_nights')),
    ADD CONSTRAINT onboarding_items_cert_chk   CHECK (cert_name IS NULL OR length(cert_name) <= 120);
  COMMENT ON COLUMN public.onboarding_items.clears_to_run IS 'B4C:probation — part of the cleared-to-run gate. None marked = "Gate not configured".';
  COMMENT ON COLUMN public.onboarding_items.kind IS 'B4C:probation — manual (officer signs) | ack (Read & Sign current) | hours (>= hours_target from hours_source) | cert (current cert named cert_name).';
  UPDATE public.onboarding_items SET phase = 'probation' WHERE department_id = v_ih AND category = 'Probationary Period';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Precondition failed: Indian Harbor has no "Probationary Period" items to pre-set. Rolling back.'; END IF;

  -- ---------------------------------------------------------------- 2-4. the new tables
  CREATE TABLE public.member_probation (
    member_id     uuid PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    started_on    date,                                   -- NULL = "Probation start not set"
    note          text CHECK (note IS NULL OR length(note) <= 500),
    set_by        uuid,                                   -- members.id of the DA; NULL on the backfill
    set_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.probation_milestones (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    member_id     uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('30day', '60day', '90day', 'final')),
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'on_track', 'needs_work', 'done')),
    note          text CHECK (note IS NULL OR length(note) <= 500),   -- a short officer note — never personal records
    signed_by     uuid NOT NULL,
    signed_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (member_id, kind)
  );
  CREATE TABLE public.supervised_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    member_id     uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('ride_along', 'drive', 'shift', 'other')),
    apparatus_id  uuid,
    hours         numeric NOT NULL CHECK (hours > 0 AND hours <= 24),
    occurred_on   date NOT NULL,
    supervisor_id uuid NOT NULL,
    counts_toward text NOT NULL DEFAULT 'probation' CHECK (length(counts_toward) <= 60),
    note          text CHECK (note IS NULL OR length(note) <= 500),
    created_by    uuid NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX supervised_sessions_member_idx ON public.supervised_sessions (member_id, kind);
  CREATE INDEX probation_milestones_dept_idx ON public.probation_milestones (department_id);
  COMMENT ON TABLE public.member_probation IS 'B4C:probation — the probation start anchor. Writes: set_member_probation only.';
  COMMENT ON TABLE public.probation_milestones IS 'B4C:probation — officer-signed 30/60/90/final reviews. Writes: set_probation_milestone only.';
  COMMENT ON TABLE public.supervised_sessions IS 'B4C:probation — the supervised hours ledger (ride-along / drive / shift); reused by #3. Writes: log_supervised_session only.';

  FOREACH v_t IN ARRAY NEW_TABLES LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, public', v_t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
                       USING (department_id = public.my_department_id() AND (member_id = public.my_member_id() OR public.is_canmanage()))$p$,
                   v_t || '_read', v_t);
  END LOOP;

  -- backfill: Probationary members with a join date on file (the rest stay "not set")
  INSERT INTO public.member_probation (member_id, department_id, started_on, note)
  SELECT DISTINCT ON (m.id) m.id, m.department_id, mp.joined_date, 'Start taken from the join date on file (backfill 2026-10-18).'
    FROM public.members m JOIN public.member_private mp ON mp.member_id = m.id
   WHERE m.status = 'Probationary' AND mp.joined_date IS NOT NULL
   ORDER BY m.id, mp.joined_date;

  -- ---------------------------------------------------------------- internal: item states + the status document
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.probation_item_states(p_member uuid, p_dept uuid)
 RETURNS TABLE(item_id uuid, label text, category text, phase text, kind text, clears_to_run boolean, sort_order integer,
               satisfied boolean, state text, signed_by_name text, signed_at timestamptz, have numeric, target numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation (internal) — every onboarding item of the department, resolved for one member. Read-only.
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
                                               when pg.done then 'done_unrecorded' else 'open' end
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
    left join lateral (select p.done, p.checked_by, p.checked_at, cb.name as signer
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
                                  where a.member_id = p_member and t.date <= td.d and (pr.started_on is null or t.date >= pr.started_on))
                              else
                                (select coalesce(sum(ss.hours), 0) from public.supervised_sessions ss
                                  where ss.member_id = p_member and ss.department_id = p_dept
                                    and (i.hours_source = 'supervised' or ss.kind = i.hours_source))
                              end as have
                        where i.kind = 'hours') hr on true
    left join lateral (select exists (select 1 from public.certs c
                                        where c.member_id = p_member and lower(btrim(c.name)) = lower(btrim(i.cert_name))
                                          and c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                                          and split_part(c.exp, '-', 1)::int * 12 + split_part(c.exp, '-', 2)::int
                                              >= extract(year from td.d)::int * 12 + extract(month from td.d)::int) as current
                        where i.kind = 'cert') ct on true
   where i.department_id = p_dept;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.probation_status(p_member uuid, p_dept uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation (internal) — one member's path to active, computed at read (America/Chicago). Read-only.
  with m as (select x.id, x.name, x.status from public.members x where x.id = p_member and x.department_id = p_dept),
       td as (select (now() at time zone 'America/Chicago')::date as d),
       pr as (select (select mp.started_on from public.member_probation mp where mp.member_id = p_member) as started_on),
       it as (select * from public.probation_item_states(p_member, p_dept)),
       ms as (select t.kind, t.ord, pr.started_on + t.days as due_on, coalesce(pm.status, 'pending') as status, pm.note,
                     sb.name as signed_by_name, pm.signed_at
                from (values ('30day', 30, 1), ('60day', 60, 2), ('90day', 90, 3), ('final', 180, 4)) t(kind, days, ord)
                cross join pr
                left join public.probation_milestones pm on pm.member_id = p_member and pm.department_id = p_dept and pm.kind = t.kind
                left join public.members sb on sb.id = pm.signed_by),
       g as (select count(*) filter (where it.clears_to_run) as req, count(*) filter (where it.clears_to_run and it.satisfied) as ok,
                    count(*) filter (where it.phase = 'probation') as preq, count(*) filter (where it.phase = 'probation' and it.satisfied) as pok
               from it),
       h as (select coalesce(sum(ss.hours), 0) as hrs from public.supervised_sessions ss where ss.member_id = p_member and ss.department_id = p_dept)
  select jsonb_build_object(
           'member_id', m.id, 'name', m.name, 'status', m.status,
           'started_on', pr.started_on,
           'day_n', case when pr.started_on is null then null else greatest(0, td.d - pr.started_on + 1) end,
           'target_days', 180,
           'gate', jsonb_build_object('configured', g.req > 0, 'required', g.req, 'satisfied', g.ok, 'cleared', g.req > 0 and g.ok = g.req),
           'probation', jsonb_build_object('required', g.preq, 'satisfied', g.pok),
           'cleared_to_run', g.req > 0 and g.ok = g.req,
           'items', coalesce((select jsonb_agg(to_jsonb(it) order by it.phase, it.category, it.sort_order, it.label) from it), '[]'::jsonb),
           'milestones', (select jsonb_agg(jsonb_build_object('kind', ms.kind, 'due_on', ms.due_on, 'status', ms.status, 'note', ms.note,
                                                              'signed_by_name', ms.signed_by_name, 'signed_at', ms.signed_at) order by ms.ord) from ms),
           'milestones_done', (select count(*) from ms where ms.status = 'done'),
           'supervised_hours', h.hrs,
           'ready_for_vote', m.status = 'Probationary' and g.req > 0 and g.ok = g.req and g.pok = g.preq
                             and (select count(*) from ms where ms.status = 'done') = 4)
    from m cross join td cross join pr cross join g cross join h;
$function$
$ddl$;

  -- ---------------------------------------------------------------- write RPCs
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_member_probation(p_member_id uuid, p_started_on date, p_note text DEFAULT NULL)
 RETURNS public.member_probation
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — a Department Admin sets (or clears, with NULL) a member's probation start. Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.member_probation;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_dept_admin(), false) then
    raise exception 'Only a Department Admin can set a probation start.';
  end if;
  if p_member_id = v_me then raise exception 'You can''t set your own probation start — another Department Admin does.'; end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if p_started_on is not null and (p_started_on < date '2000-01-01' or p_started_on > (now() at time zone 'America/Chicago')::date) then
    raise exception 'The probation start must be a real date, and not in the future.';
  end if;
  if p_note is not null and length(p_note) > 500 then raise exception 'Keep the note under 500 characters.'; end if;
  insert into public.member_probation (member_id, department_id, started_on, note, set_by, set_at)
  values (p_member_id, v_dept, p_started_on, nullif(btrim(p_note), ''), v_me, now())
  on conflict (member_id) do update set started_on = excluded.started_on, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at
  returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_probation_milestone(p_member_id uuid, p_kind text, p_status text, p_note text DEFAULT NULL)
 RETURNS public.probation_milestones
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — Board / DA / Officer signs a 30/60/90/final review for a probationary member of their department.
-- Never their own (custody). Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.probation_milestones;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can sign a probation review.';
  end if;
  if p_member_id = v_me then raise exception 'You can''t sign your own probation review — an officer does.'; end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and status = 'Probationary') then
    raise exception 'Probation reviews are for probationary members.';
  end if;
  if p_kind is null or p_kind not in ('30day', '60day', '90day', 'final') then raise exception 'Unknown review — use 30day, 60day, 90day or final.'; end if;
  if p_status is null or p_status not in ('pending', 'on_track', 'needs_work', 'done') then raise exception 'Unknown status.'; end if;
  if p_note is not null and length(p_note) > 500 then raise exception 'Keep the note under 500 characters.'; end if;
  insert into public.probation_milestones (department_id, member_id, kind, status, note, signed_by, signed_at)
  values (v_dept, p_member_id, p_kind, p_status, nullif(btrim(p_note), ''), v_me, now())
  on conflict (member_id, kind) do update set status = excluded.status, note = excluded.note, signed_by = excluded.signed_by, signed_at = excluded.signed_at
  returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.log_supervised_session(p_member_id uuid, p_kind text, p_hours numeric, p_occurred_on date,
    p_apparatus_id uuid DEFAULT NULL, p_supervisor_id uuid DEFAULT NULL, p_note text DEFAULT NULL)
 RETURNS public.supervised_sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — Board / DA / Officer logs a supervised ride-along / drive / shift for a member of their department.
-- Never for themself; the supervisor (default: the caller) is in the department and is never the member. Never
-- touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
        v_sup uuid := coalesce(p_supervisor_id, public.my_member_id()); v_row public.supervised_sessions;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can log supervised time.';
  end if;
  if p_member_id = v_me then raise exception 'You can''t log your own supervised time — an officer does.'; end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if v_sup = p_member_id then raise exception 'A member can''t supervise themself.'; end if;
  if not exists (select 1 from public.members where id = v_sup and department_id = v_dept) then
    raise exception 'The supervisor must be a member of your department.';
  end if;
  if p_kind is null or p_kind not in ('ride_along', 'drive', 'shift', 'other') then raise exception 'Unknown session type.'; end if;
  if p_hours is null or p_hours <= 0 or p_hours > 24 then raise exception 'Hours must be more than 0 and at most 24.'; end if;
  if p_occurred_on is null or p_occurred_on < date '2000-01-01' or p_occurred_on > (now() at time zone 'America/Chicago')::date then
    raise exception 'The date must be a real date, and not in the future.';
  end if;
  if p_apparatus_id is not null and not exists (select 1 from public.apparatus where id = p_apparatus_id and department_id = v_dept) then
    raise exception 'That apparatus is not in your department.';
  end if;
  if p_note is not null and length(p_note) > 500 then raise exception 'Keep the note under 500 characters.'; end if;
  insert into public.supervised_sessions (department_id, member_id, kind, apparatus_id, hours, occurred_on, supervisor_id, note, created_by)
  values (v_dept, p_member_id, p_kind, p_apparatus_id, p_hours, p_occurred_on, v_sup, nullif(btrim(p_note), ''), v_me)
  returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- read RPCs
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.my_probation_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — the caller's own path to active. Read-only.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
begin
  if v_dept is null or v_me is null then raise exception 'We could not match your login to a department.'; end if;
  return public.probation_status(v_me, v_dept);
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.member_probation_status(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — one member's path: themself, or (Board / DA / Officer) a member of their department. Read-only.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
begin
  if v_dept is null or v_me is null then raise exception 'We could not match your login to a department.'; end if;
  if p_member_id is distinct from v_me and not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see another member''s probation.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  return public.probation_status(p_member_id, v_dept);
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_probation_board()
 RETURNS TABLE(member_id uuid, name text, started_on date, day_n integer, gate_configured boolean, cleared_to_run boolean,
               ready_for_vote boolean, detail jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — Board / DA / Officer: every probationary member of the department (honest denominator: not
-- Inactive, not former, not a Project Admin) with their gate + ready-for-vote state. Read-only; no push, no job.
#variable_conflict use_column
declare v_dept uuid := public.my_department_id();
begin
  if v_dept is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see the probation board.';
  end if;
  return query
  select x.id, x.name, (d->>'started_on')::date, (d->>'day_n')::int, (d->'gate'->>'configured')::boolean,
         (d->>'cleared_to_run')::boolean, (d->>'ready_for_vote')::boolean, d
    from (select m.id, m.name, public.probation_status(m.id, v_dept) as d
            from public.members m
           where m.department_id = v_dept and m.status = 'Probationary'
             and not coalesce(m.access && array['Project Admin']::text[], false)
             and not exists (select 1 from public.member_separation s where s.member_id = m.id)) x
   order by 7 desc, 2;
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

  -- ---------------------------------------------------------------- post-conditions (any failure undoes everything)
  FOREACH v_t IN ARRAY NEW_TABLES LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass) THEN RAISE EXCEPTION 'Post-condition failed: RLS off on %.', v_t; END IF;
    IF has_table_privilege('authenticated', 'public.' || v_t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || v_t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'DELETE') OR has_table_privilege('anon', 'public.' || v_t, 'SELECT') THEN
      RAISE EXCEPTION 'Post-condition failed: % has a write grant for authenticated, or anon can read it.', v_t;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) <> 1
       OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t AND cmd = 'SELECT'
             AND position('my_department_id()' in qual) > 0 AND position('is_canmanage()' in qual) > 0 AND position('my_member_id()' in qual) > 0) <> 1 THEN
      RAISE EXCEPTION 'Post-condition failed: % must have exactly one department-scoped SELECT policy and no write policy.', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-condition failed: % grants are wrong (anon must not, authenticated must).', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY INTERNAL_FNS LOOP
    IF has_function_privilege('authenticated', v_t, 'EXECUTE') OR has_function_privilege('anon', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-condition failed: the internal % is callable by members.', v_t;
    END IF;
  END LOOP;
  IF position('p_member_id = v_me' in pg_get_functiondef('public.set_probation_milestone(uuid,text,text,text)'::regprocedure)) = 0
     OR position('p_member_id = v_me' in pg_get_functiondef('public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text)'::regprocedure)) = 0
     OR position('p_member_id = v_me' in pg_get_functiondef('public.set_member_probation(uuid,date,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: a write RPC lost its not-self (custody) check.';
  END IF;
  IF position('is_leader()' in pg_get_functiondef('public.set_probation_milestone(uuid,text,text,text)'::regprocedure)
                             || pg_get_functiondef('public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text)'::regprocedure)
                             || pg_get_functiondef('public.dept_probation_board()'::regprocedure)
                             || pg_get_functiondef('public.member_probation_status(uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'Post-condition failed: a gate uses the role-anywhere is_leader().';
  END IF;
  -- the shipped onboarding is untouched: set_onboarding_item byte-identical, transition-state grant still there,
  -- and every pre-existing policy character for character
  IF pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure) IS DISTINCT FROM v_soi_before THEN
    RAISE EXCEPTION 'Post-condition failed: set_onboarding_item changed.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT') OR NOT has_table_privilege('authenticated', 'public.onboarding_progress', 'UPDATE') THEN
    RAISE EXCEPTION 'Post-condition failed: the onboarding_progress transition-state grant was removed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.onboarding_items WHERE clears_to_run OR kind <> 'manual') THEN
    RAISE EXCEPTION 'Post-condition failed: an existing item came out in the gate or as an auto kind (defaults must be manual / not in the gate).';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a pre-existing policy changed.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: tables 3 · rls true · new_policies 3 · item_cols 7 · ih_probation_items > 0 (the
-- "Probationary Period" count) · in_gate 0 · backfilled = Probationary members with a join date (Step 0: 4) ·
-- anon_rpc false · onboarding_progress_insert true (transition state kept) · total_policies 163 (160 + 3)
SELECT (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('public.member_probation'), to_regclass('public.probation_milestones'), to_regclass('public.supervised_sessions'))) AS tables,
       (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN (to_regclass('public.member_probation'), to_regclass('public.probation_milestones'), to_regclass('public.supervised_sessions'))) AS rls,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('member_probation', 'probation_milestones', 'supervised_sessions')) AS new_policies,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'onboarding_items'
          AND column_name IN ('clears_to_run', 'phase', 'kind', 'ack_series_id', 'hours_target', 'hours_source', 'cert_name')) AS item_cols,
       (SELECT count(*) FROM public.onboarding_items WHERE phase = 'probation') AS ih_probation_items,
       (SELECT count(*) FROM public.onboarding_items WHERE clears_to_run) AS in_gate,
       (SELECT count(*) FROM public.member_probation) AS backfilled,
       has_function_privilege('anon', 'public.my_probation_status()', 'EXECUTE') AS anon_rpc,
       has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT') AS onboarding_progress_insert,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- =====================================================================
-- ROLLBACK (only if needed, separately). Drops the probation data (start dates, reviews, logged sessions) — export first.
-- =====================================================================
-- DO $rb$
-- BEGIN
--   DROP FUNCTION IF EXISTS public.dept_probation_board(), public.member_probation_status(uuid), public.my_probation_status(),
--     public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text), public.set_probation_milestone(uuid,text,text,text),
--     public.set_member_probation(uuid,date,text), public.probation_status(uuid,uuid), public.probation_item_states(uuid,uuid);
--   DROP TABLE IF EXISTS public.supervised_sessions, public.probation_milestones, public.member_probation;
--   ALTER TABLE public.onboarding_items DROP CONSTRAINT IF EXISTS onboarding_items_phase_chk, DROP CONSTRAINT IF EXISTS onboarding_items_kind_chk,
--     DROP CONSTRAINT IF EXISTS onboarding_items_mentor_manual_chk, DROP CONSTRAINT IF EXISTS onboarding_items_hours_chk,
--     DROP CONSTRAINT IF EXISTS onboarding_items_source_chk, DROP CONSTRAINT IF EXISTS onboarding_items_cert_chk,
--     DROP COLUMN IF EXISTS clears_to_run, DROP COLUMN IF EXISTS phase, DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS ack_series_id,
--     DROP COLUMN IF EXISTS hours_target, DROP COLUMN IF EXISTS hours_source, DROP COLUMN IF EXISTS cert_name;
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
