-- =====================================================================
-- FUNDING / EVENTS FE-B-DB — event needs + sign-ups, jobs on community events, community subtypes.
--                                                                          DRAFT — NOT APPLIED. NOT REVIEWED.
-- Rulings: claude/B4C_FundingEvents_Redesign_Step0_ReviewRecord.md (FE2 subtypes REAL, FE4, FE5 + FE5.1–5.4, FE6).
-- Pins read LIVE 2026-10-27 (docs/review/fe_b_db_LIVEDEFS.sql -> _LIVEDEFS.json; Postgres 17.6).
--
-- ONE ALL-OR-NOTHING DO BLOCK, then NOTIFY pgrst, then a read-only state row. RETEST separately
-- (sql/fe_b_event_needs_RETEST.sql — SENTINEL-rolled-back). Dry run: docs/review/fe_b_db_dryrun_harness.mjs.
--
-- WHAT IT DOES (additive only — no existing function, policy, grant or row changes)
--   recruitment_events.event_type      nullable text, CHECK open_house | booth | school_visit | parade | community_safety |
--                                      other. The 6 existing rows stay NULL (= plain "Community event"). No default.
--   UNIQUE (id, department_id)          on recruitment_events AND funding_events — the target of the composite FKs below,
--                                      so a need / job can only hang off an event of ITS OWN department.
--   action_items.recruitment_event_id   FK (recruitment_event_id, department_id) -> recruitment_events(id, department_id)
--                                      ON DELETE SET NULL (recruitment_event_id) — mirrors fundraiser_id (the job survives
--                                      the event) but same-department at the DB (D2). The existing lifecycle RPCs and the
--                                      INSERT policy (is_canmanage()) are untouched (FE6).
--   event_needs                         role_label, slots_needed 1–50, optional shift start/end, notes, sort; exactly one
--                                      parent (recruitment_event_id XOR funding_event_id — FE5.1), each a composite FK,
--                                      ON DELETE CASCADE. RLS: SELECT dept; INSERT/UPDATE/DELETE dept AND is_canmanage_ops()
--                                      — the event tables' own write gate, nothing wider. Guard trigger (D3).
--   event_need_claims                   the sign-ups: one row per (need, member). RLS: SELECT dept — every member sees who
--                                      signed up (FE5.2). NO write grant: rows change only through the 4 RPCs.
--   RPCs (SECURITY DEFINER)             claim_event_need(need)            self, FOR UPDATE capacity check (FE5)
--                                      unclaim_event_need(need)          self
--                                      assign_event_need(need, member)   is_canmanage_ops(); assignee in dept (FE5.3)
--                                      remove_event_need_claim(claim)    is_canmanage_ops()
--                                      REVOKE PUBLIC/anon, GRANT authenticated. All refuse after the event day (FE5.4, D1).
--   Neither new table copies the pre-existing anon table grants (REVOKE ALL FROM PUBLIC, anon first).
--
-- DECISIONS THE RECORD DID NOT SPELL OUT (flagged for the gate review — claude/B4C_FundingEvents_FE_B_DB_Draft.md):
--   D1 "Closes on the event date" = open THROUGH the event's day in America/Chicago (the get_station_fundraisers clock);
--      refused from the next day. Applies to all four RPCs — leaders included (not attendance; nothing to record after).
--   D2 action_items.recruitment_event_id is a COMPOSITE FK, so a job can't point at another department's event — stricter
--      than fundraiser_id (plain FK). ON DELETE SET NULL (recruitment_event_id) nulls only the link (PG15+ column list).
--   D3 tg_event_needs_guard (BEFORE UPDATE): a need's department / parent event / created_by never change (move = delete +
--      re-add), and slots_needed can't drop below the people already signed up (SLOTS_BELOW_CLAIMS — remove someone first).
--   D4 Sign-up needs an Active/Probationary member of the department (my_member_id() already requires it); an assignee
--      must be one too (NOT_IN_DEPT otherwise).
--   D5 event_needs.created_by defaults to my_member_id() and the INSERT policy requires it to be the caller (stricter, not
--      wider, than the parent gate). No FK (a removed member never erases who added it).
--   D6 event_need_claims.claimed_by = who made the claim (the member themself, or the leader who assigned them). No FK.
--      member_id IS an FK (ON DELETE CASCADE): deleting a member removes their sign-ups.
--   D7 Errors are 'CODE: sentence' — NO_MEMBER, NOT_FOUND, NOT_ALLOWED, CLOSED, ALREADY, FULL, NOT_SIGNED_UP, NOT_IN_DEPT,
--      PARENT_LOCKED, SLOTS_BELOW_CLAIMS. The claim/assign/unclaim/remove calls return jsonb {need_id, taken, slots_needed,…}.
--   D8 Deleting an event cascades its needs and their sign-ups (only a DA can delete an event — the UI slice names the
--      sign-ups in the confirm). Pre-existing and NOT changed: the two event tables have no FK to departments.
-- =====================================================================

DO $mig$
DECLARE
  v_pins constant jsonb := jsonb_build_object(
    'public.cancel_action_item(uuid,text)',             '2c5cac1238c59f68b25c4e4013c0489f',
    'public.complete_action_item(uuid)',                'af1dc282df773b252b9ef4e2ffb67bf2',
    'public.get_station_fundraisers()',                 '1d8634cfd5bdfcca54fe7379b36da916',
    'public.is_canmanage()',                            '44083b6d721a50ace3ad21280e2260d3',
    'public.is_canmanage_ops()',                        '92fa180343748968dff96fa044b0420d',
    'public.is_dept_admin()',                           'c692e44f62923d2bf4c1a39a21a87bf7',
    'public.is_leader()',                               '3f462af26a46909309f856f769226baa',
    'public.is_muted(uuid,text)',                       '4e5107d4104e2ac4a8bd2d2347b5db49',
    'public.my_department_id()',                        '87f546659c3804a943b48e419e017f18',
    'public.my_department_rollup()',                    '7f9723c917b30cbe030db328fe6b8255',
    'public.my_member_id()',                            '3f66369c8af7bc07ec59831af6536fee',
    'public.notify_action_item_assigned()',             '55b3058c7977d0e1ce643c77cb4ac5eb',
    'public.reopen_action_item(uuid)',                  '76513cd2c2468faad981e52f61db6408',
    'public.set_fundraiser_shared(uuid,boolean)',       '6dc0f4c97d2b4426c259025f4a8e588e',
    'public.set_fundraiser_step_visible(uuid,boolean)', '3b3c1da70032b0b83c20113d39db3d68');
  -- policy text pinned exactly: name|cmd|roles -> qual|with_check
  v_pol constant jsonb := jsonb_build_object(
    'recruitment_events|leaders delete recruitment_events|DELETE|authenticated', '((department_id = my_department_id()) AND is_canmanage_ops())|',
    'recruitment_events|leaders update recruitment_events|UPDATE|authenticated', '((department_id = my_department_id()) AND is_canmanage_ops())|((department_id = my_department_id()) AND is_canmanage_ops())',
    'recruitment_events|leaders write recruitment_events|INSERT|authenticated',  '|((department_id = my_department_id()) AND is_canmanage_ops())',
    'recruitment_events|members read recruitment_events|SELECT|authenticated',  '(department_id = my_department_id())|',
    'funding_events|leaders delete funding_events|DELETE|authenticated',         '((department_id = my_department_id()) AND is_canmanage_ops())|',
    'funding_events|leaders update funding_events|UPDATE|authenticated',         '((department_id = my_department_id()) AND is_canmanage_ops())|((department_id = my_department_id()) AND is_canmanage_ops())',
    'funding_events|leaders write funding_events|INSERT|authenticated',          '|((department_id = my_department_id()) AND is_canmanage_ops())',
    'funding_events|members read funding_events|SELECT|authenticated',          '(department_id = my_department_id())|',
    'action_items|canmanage insert action_items|INSERT|authenticated',           '|(is_canmanage() AND (department_id = my_department_id()))',
    'action_items|leaders can read action_items|SELECT|public',                  '(is_leader() AND (department_id = my_department_id()))|',
    'action_items|members read own action_items|SELECT|authenticated',           '(assigned_to = my_member_id())|');
  v_types constant text[] := array['open_house', 'booth', 'school_visit', 'parade', 'community_safety', 'other'];
  v_rpcs constant text[] := array['public.claim_event_need(uuid)', 'public.unclaim_event_need(uuid)',
    'public.assign_event_need(uuid,uuid)', 'public.remove_event_need_claim(uuid)'];
  v_new_fns constant text[] := array['claim_event_need', 'unclaim_event_need', 'assign_event_need', 'remove_event_need_claim', 'tg_event_needs_guard'];
  v_new_cons constant text[] := array['recruitment_events_id_dept_key', 'funding_events_id_dept_key', 'recruitment_events_event_type_check',
    'action_items_recruitment_event_fkey'];
  v_fn_before text; v_fn_after text; v_pol_before text; v_pol_after text; v_acl_before text; v_acl_after text;
  v_con_before text; v_con_after text; v_trg_before text; v_trg_after text;
  v_ver_before bigint; v_ver_after bigint; v_pol_n_before int;
  k text; v text; v_n int;
BEGIN
  -- =================================================================
  -- 0. PRE-FLIGHT — refuse, don't break.
  -- =================================================================
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'PREFLIGHT: needs Postgres 15+ (ON DELETE SET NULL (column)). Found %.', current_setting('server_version');
  END IF;
  IF to_regclass('public.event_needs') IS NOT NULL OR to_regclass('public.event_need_claims') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: event_needs / event_need_claims already exist — FE-B-DB looks applied. Refusing.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (v_new_fns);
  IF v_n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT: % FE-B function name(s) already exist. Refusing.', v_n; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND ((table_name = 'recruitment_events' AND column_name = 'event_type') OR (table_name = 'action_items' AND column_name = 'recruitment_event_id'))) THEN
    RAISE EXCEPTION 'PREFLIGHT: event_type / recruitment_event_id already exists — partially applied? Refusing.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY (v_new_cons)) THEN
    RAISE EXCEPTION 'PREFLIGHT: an FE-B constraint name already exists. Refusing.';
  END IF;
  -- (a) md5 pins: the gates, identity, the rollup, the action-item lifecycle + trigger, station sharing
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF to_regprocedure(k) IS NULL THEN RAISE EXCEPTION 'PREFLIGHT: % is missing.', k; END IF;
    IF md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN
      RAISE EXCEPTION 'PREFLIGHT: % has drifted (live md5 %, pinned %). Re-audit.', k, md5(pg_get_functiondef(to_regprocedure(k))), v;
    END IF;
  END LOOP;
  -- (b) the three tables' policies: exactly these, exactly this text
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('recruitment_events', 'funding_events', 'action_items');
  IF v_n <> 11 THEN RAISE EXCEPTION 'PREFLIGHT: expected 11 policies on the event tables + action_items, found %.', v_n; END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pol) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = split_part(k, '|', 1) AND policyname = split_part(k, '|', 2)
                     AND cmd = split_part(k, '|', 3) AND array_to_string(roles, ',') = split_part(k, '|', 4)
                     AND coalesce(qual, '') = split_part(v, '|', 1) AND coalesce(with_check, '') = split_part(v, '|', 2)) THEN
      RAISE EXCEPTION 'PREFLIGHT: policy "%" on % is not the audited text. Re-audit.', split_part(k, '|', 2), split_part(k, '|', 1);
    END IF;
  END LOOP;
  -- (c) the shapes this builds on
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.recruitment_events'::regclass AND attname = 'date') <> 'date'
     OR (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.funding_events'::regclass AND attname = 'date') <> 'date'
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.recruitment_events'::regclass AND attname = 'department_id' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.funding_events'::regclass AND attname = 'department_id' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.action_items'::regclass AND attname = 'department_id' AND attnotnull) THEN
    RAISE EXCEPTION 'PREFLIGHT: the event tables / action_items are not the audited shape (date / department_id). Re-audit.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recruitment_events GROUP BY id, department_id HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.funding_events GROUP BY id, department_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PREFLIGHT: duplicate (id, department_id) — impossible with id as PK; refusing anyway.';
  END IF;

  -- (d) snapshots for the "nothing else moved" post-conditions
  SELECT md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || '/' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
    INTO v_fn_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p');
  SELECT md5(string_agg(tablename || '.' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)),
         count(*) INTO v_pol_before, v_pol_n_before FROM pg_policies WHERE schemaname = 'public';
  SELECT md5(string_agg(c.relname || '=' || coalesce(c.relacl::text, '') || '/' || c.relrowsecurity, ',' ORDER BY c.relname))
    INTO v_acl_before FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm');
  SELECT md5(string_agg(conrelid::regclass::text || '.' || conname || '=' || pg_get_constraintdef(oid), ',' ORDER BY conrelid::regclass::text, conname))
    INTO v_con_before FROM pg_constraint WHERE connamespace = 'public'::regnamespace;
  SELECT md5(string_agg(tgrelid::regclass::text || '.' || tgname || '=' || pg_get_triggerdef(oid) || '/' || tgenabled::text, ',' ORDER BY tgrelid::regclass::text, tgname))
    INTO v_trg_before FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace);
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;

  -- =================================================================
  -- 1. THE EVENT TABLES: (id, department_id) keys + community subtypes (FE2 b).
  -- =================================================================
  EXECUTE 'ALTER TABLE public.recruitment_events ADD CONSTRAINT recruitment_events_id_dept_key UNIQUE (id, department_id)';
  EXECUTE 'ALTER TABLE public.funding_events ADD CONSTRAINT funding_events_id_dept_key UNIQUE (id, department_id)';
  EXECUTE $ddl$ ALTER TABLE public.recruitment_events ADD COLUMN event_type text
                  CONSTRAINT recruitment_events_event_type_check
                  CHECK (event_type IS NULL OR event_type IN ('open_house', 'booth', 'school_visit', 'parade', 'community_safety', 'other')) $ddl$;

  -- =================================================================
  -- 2. JOBS ON COMMUNITY EVENTS (FE6) — same-department link; the job outlives the event.
  -- =================================================================
  EXECUTE $ddl$ ALTER TABLE public.action_items ADD COLUMN recruitment_event_id uuid,
                  ADD CONSTRAINT action_items_recruitment_event_fkey FOREIGN KEY (recruitment_event_id, department_id)
                    REFERENCES public.recruitment_events (id, department_id) ON DELETE SET NULL (recruitment_event_id) $ddl$;
  EXECUTE 'CREATE INDEX action_items_recruitment_event_idx ON public.action_items (recruitment_event_id) WHERE recruitment_event_id IS NOT NULL';

  -- =================================================================
  -- 3. NEEDS (FE5) — hung off the event row; exactly one parent.
  -- =================================================================
  EXECUTE $ddl$
    CREATE TABLE public.event_needs (
      id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      department_id        uuid        NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
      recruitment_event_id uuid,
      funding_event_id     uuid,
      role_label           text        NOT NULL CHECK (length(btrim(role_label)) BETWEEN 1 AND 80),
      slots_needed         integer     NOT NULL CHECK (slots_needed BETWEEN 1 AND 50),
      start_time           time,
      end_time             time,
      notes                text        CHECK (notes IS NULL OR length(notes) <= 1000),
      sort                 integer     NOT NULL DEFAULT 0,
      created_by           uuid        DEFAULT public.my_member_id(),   -- no FK (D5)
      created_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT event_needs_one_parent CHECK (num_nonnulls(recruitment_event_id, funding_event_id) = 1),
      CONSTRAINT event_needs_shift_order CHECK (start_time IS NULL OR end_time IS NULL OR end_time >= start_time),
      CONSTRAINT event_needs_recruitment_event_fkey FOREIGN KEY (recruitment_event_id, department_id)
        REFERENCES public.recruitment_events (id, department_id) ON DELETE CASCADE,
      CONSTRAINT event_needs_funding_event_fkey FOREIGN KEY (funding_event_id, department_id)
        REFERENCES public.funding_events (id, department_id) ON DELETE CASCADE,
      CONSTRAINT event_needs_id_dept_key UNIQUE (id, department_id)
    ) $ddl$;
  EXECUTE 'CREATE INDEX event_needs_recruitment_event_idx ON public.event_needs (recruitment_event_id) WHERE recruitment_event_id IS NOT NULL';
  EXECUTE 'CREATE INDEX event_needs_funding_event_idx ON public.event_needs (funding_event_id) WHERE funding_event_id IS NOT NULL';
  EXECUTE 'ALTER TABLE public.event_needs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE public.event_needs FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_needs TO authenticated';
  EXECUTE $p$ CREATE POLICY "dept reads event_needs" ON public.event_needs FOR SELECT TO authenticated
                USING (department_id = public.my_department_id()) $p$;
  EXECUTE $p$ CREATE POLICY "leaders insert event_needs" ON public.event_needs FOR INSERT TO authenticated
                WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops() AND created_by = public.my_member_id()) $p$;
  EXECUTE $p$ CREATE POLICY "leaders update event_needs" ON public.event_needs FOR UPDATE TO authenticated
                USING (department_id = public.my_department_id() AND public.is_canmanage_ops())
                WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops()) $p$;
  EXECUTE $p$ CREATE POLICY "leaders delete event_needs" ON public.event_needs FOR DELETE TO authenticated
                USING (department_id = public.my_department_id() AND public.is_canmanage_ops()) $p$;

  -- =================================================================
  -- 4. SIGN-UPS (FE5) — read dept-wide (FE5.2); written only by the RPCs below.
  -- =================================================================
  EXECUTE $ddl$
    CREATE TABLE public.event_need_claims (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      department_id uuid        NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
      need_id       uuid        NOT NULL,
      member_id     uuid        NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
      claimed_by    uuid,                                 -- the member, or the leader who assigned them (D6); no FK
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT event_need_claims_need_fkey FOREIGN KEY (need_id, department_id)
        REFERENCES public.event_needs (id, department_id) ON DELETE CASCADE,
      CONSTRAINT event_need_claims_one_per_member UNIQUE (need_id, member_id)
    ) $ddl$;
  EXECUTE 'CREATE INDEX event_need_claims_member_idx ON public.event_need_claims (member_id)';
  EXECUTE 'ALTER TABLE public.event_need_claims ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE public.event_need_claims FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.event_need_claims FROM service_role';
  EXECUTE 'GRANT SELECT ON TABLE public.event_need_claims TO authenticated';
  EXECUTE $p$ CREATE POLICY "dept reads event_need_claims" ON public.event_need_claims FOR SELECT TO authenticated
                USING (department_id = public.my_department_id()) $p$;

  -- =================================================================
  -- 5. THE GUARD (D3).
  -- =================================================================
  EXECUTE $fn$
    CREATE FUNCTION public.tg_event_needs_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $body$
    -- B4C:fe_b — a need stays on its event, keeps its author, and never offers fewer slots than people already signed up.
    DECLARE v_taken int;
    BEGIN
      IF NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.recruitment_event_id IS DISTINCT FROM OLD.recruitment_event_id
         OR NEW.funding_event_id IS DISTINCT FROM OLD.funding_event_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'PARENT_LOCKED: a need stays on its event — delete it and add it to the other event.';
      END IF;
      IF NEW.slots_needed < OLD.slots_needed THEN
        SELECT count(*) INTO v_taken FROM public.event_need_claims WHERE need_id = OLD.id;
        IF NEW.slots_needed < v_taken THEN
          RAISE EXCEPTION 'SLOTS_BELOW_CLAIMS: % people are signed up — remove someone before lowering it to %.', v_taken, NEW.slots_needed;
        END IF;
      END IF;
      RETURN NEW;
    END $body$ $fn$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.tg_event_needs_guard() FROM PUBLIC, anon, authenticated';
  EXECUTE 'CREATE TRIGGER event_needs_guard BEFORE UPDATE ON public.event_needs FOR EACH ROW EXECUTE FUNCTION public.tg_event_needs_guard()';

  -- =================================================================
  -- 6. THE FOUR RPCs (FE5, FE5.3, FE5.4).
  -- =================================================================
  EXECUTE $fn$
    CREATE FUNCTION public.claim_event_need(p_need_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $body$
    -- B4C:fe_b — sign MYSELF up for one slot. The need row is locked FOR UPDATE, so two people can't both take the last slot.
    DECLARE
      v_me uuid := public.my_member_id();
      v_dept uuid := public.my_department_id();
      n public.event_needs; v_date date; v_taken int; v_id uuid;
    BEGIN
      IF v_me IS NULL OR v_dept IS NULL THEN RAISE EXCEPTION 'NO_MEMBER: we could not match your login to an active member of this department.'; END IF;
      SELECT * INTO n FROM public.event_needs WHERE id = p_need_id AND department_id = v_dept FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: that need is not in your department.' USING errcode = 'P0002'; END IF;
      v_date := coalesce((SELECT e.date FROM public.recruitment_events e WHERE e.id = n.recruitment_event_id),
                         (SELECT e.date FROM public.funding_events e WHERE e.id = n.funding_event_id));
      IF v_date IS NULL OR v_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
        RAISE EXCEPTION 'CLOSED: this event has passed — sign-ups are closed.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.event_need_claims c WHERE c.need_id = n.id AND c.member_id = v_me) THEN
        RAISE EXCEPTION 'ALREADY: you are already signed up for this.';
      END IF;
      SELECT count(*) INTO v_taken FROM public.event_need_claims c WHERE c.need_id = n.id;
      IF v_taken >= n.slots_needed THEN RAISE EXCEPTION 'FULL: every slot for this is taken.'; END IF;
      INSERT INTO public.event_need_claims (department_id, need_id, member_id, claimed_by) VALUES (v_dept, n.id, v_me, v_me) RETURNING id INTO v_id;
      RETURN jsonb_build_object('claim_id', v_id, 'need_id', n.id, 'taken', v_taken + 1, 'slots_needed', n.slots_needed);
    END $body$ $fn$;

  EXECUTE $fn$
    CREATE FUNCTION public.unclaim_event_need(p_need_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $body$
    -- B4C:fe_b — take MYSELF off a need ("Can't make it"). Only my own row; closed after the event day.
    DECLARE
      v_me uuid := public.my_member_id();
      v_dept uuid := public.my_department_id();
      n public.event_needs; v_date date; v_taken int;
    BEGIN
      IF v_me IS NULL OR v_dept IS NULL THEN RAISE EXCEPTION 'NO_MEMBER: we could not match your login to an active member of this department.'; END IF;
      SELECT * INTO n FROM public.event_needs WHERE id = p_need_id AND department_id = v_dept FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: that need is not in your department.' USING errcode = 'P0002'; END IF;
      v_date := coalesce((SELECT e.date FROM public.recruitment_events e WHERE e.id = n.recruitment_event_id),
                         (SELECT e.date FROM public.funding_events e WHERE e.id = n.funding_event_id));
      IF v_date IS NULL OR v_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
        RAISE EXCEPTION 'CLOSED: this event has passed — sign-ups are closed.';
      END IF;
      DELETE FROM public.event_need_claims c WHERE c.need_id = n.id AND c.member_id = v_me;
      IF NOT FOUND THEN RAISE EXCEPTION 'NOT_SIGNED_UP: you are not signed up for this.'; END IF;
      SELECT count(*) INTO v_taken FROM public.event_need_claims c WHERE c.need_id = n.id;
      RETURN jsonb_build_object('need_id', n.id, 'taken', v_taken, 'slots_needed', n.slots_needed);
    END $body$ $fn$;

  EXECUTE $fn$
    CREATE FUNCTION public.assign_event_need(p_need_id uuid, p_member_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $body$
    -- B4C:fe_b — a leader (DA / Officer — the event write gate) puts a member of THIS department on a need (FE5.3).
    DECLARE
      v_me uuid := public.my_member_id();
      v_dept uuid := public.my_department_id();
      n public.event_needs; v_date date; v_taken int; v_id uuid;
    BEGIN
      IF v_me IS NULL OR v_dept IS NULL THEN RAISE EXCEPTION 'NO_MEMBER: we could not match your login to an active member of this department.'; END IF;
      IF NOT public.is_canmanage_ops() THEN RAISE EXCEPTION 'NOT_ALLOWED: only a Department Admin or an Officer can assign people.'; END IF;
      SELECT * INTO n FROM public.event_needs WHERE id = p_need_id AND department_id = v_dept FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: that need is not in your department.' USING errcode = 'P0002'; END IF;
      v_date := coalesce((SELECT e.date FROM public.recruitment_events e WHERE e.id = n.recruitment_event_id),
                         (SELECT e.date FROM public.funding_events e WHERE e.id = n.funding_event_id));
      IF v_date IS NULL OR v_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
        RAISE EXCEPTION 'CLOSED: this event has passed — sign-ups are closed.';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.members m WHERE m.id = p_member_id AND m.department_id = v_dept AND m.status IN ('Active', 'Probationary')) THEN
        RAISE EXCEPTION 'NOT_IN_DEPT: that person is not an active member of your department.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.event_need_claims c WHERE c.need_id = n.id AND c.member_id = p_member_id) THEN
        RAISE EXCEPTION 'ALREADY: they are already signed up for this.';
      END IF;
      SELECT count(*) INTO v_taken FROM public.event_need_claims c WHERE c.need_id = n.id;
      IF v_taken >= n.slots_needed THEN RAISE EXCEPTION 'FULL: every slot for this is taken.'; END IF;
      INSERT INTO public.event_need_claims (department_id, need_id, member_id, claimed_by) VALUES (v_dept, n.id, p_member_id, v_me) RETURNING id INTO v_id;
      RETURN jsonb_build_object('claim_id', v_id, 'need_id', n.id, 'taken', v_taken + 1, 'slots_needed', n.slots_needed);
    END $body$ $fn$;

  EXECUTE $fn$
    CREATE FUNCTION public.remove_event_need_claim(p_claim_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $body$
    -- B4C:fe_b — a leader takes someone off a need (anyone's sign-up in THIS department).
    DECLARE
      v_me uuid := public.my_member_id();
      v_dept uuid := public.my_department_id();
      c public.event_need_claims; n public.event_needs; v_date date; v_taken int;
    BEGIN
      IF v_me IS NULL OR v_dept IS NULL THEN RAISE EXCEPTION 'NO_MEMBER: we could not match your login to an active member of this department.'; END IF;
      IF NOT public.is_canmanage_ops() THEN RAISE EXCEPTION 'NOT_ALLOWED: only a Department Admin or an Officer can remove someone.'; END IF;
      SELECT * INTO c FROM public.event_need_claims x WHERE x.id = p_claim_id AND x.department_id = v_dept;
      IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: that sign-up is not in your department.' USING errcode = 'P0002'; END IF;
      SELECT * INTO n FROM public.event_needs WHERE id = c.need_id FOR UPDATE;
      v_date := coalesce((SELECT e.date FROM public.recruitment_events e WHERE e.id = n.recruitment_event_id),
                         (SELECT e.date FROM public.funding_events e WHERE e.id = n.funding_event_id));
      IF v_date IS NULL OR v_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
        RAISE EXCEPTION 'CLOSED: this event has passed — sign-ups are closed.';
      END IF;
      DELETE FROM public.event_need_claims x WHERE x.id = c.id;
      SELECT count(*) INTO v_taken FROM public.event_need_claims x WHERE x.need_id = n.id;
      RETURN jsonb_build_object('need_id', n.id, 'member_id', c.member_id, 'taken', v_taken, 'slots_needed', n.slots_needed);
    END $body$ $fn$;

  FOREACH k IN ARRAY v_rpcs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', k);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', k);
  END LOOP;

  -- =================================================================
  -- 7. POST-CONDITIONS — any miss rolls the whole thing back.
  -- =================================================================
  -- (a) every pre-existing function (body + ACL) is byte-identical; exactly the 5 new ones were added
  SELECT md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || '/' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
    INTO v_fn_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND NOT (p.proname = ANY (v_new_fns));
  IF v_fn_after <> v_fn_before THEN RAISE EXCEPTION 'POST: a pre-existing function (or its ACL) changed — it must not.'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (v_new_fns);
  IF v_n <> 5 THEN RAISE EXCEPTION 'POST: expected 5 new functions, found %.', v_n; END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN RAISE EXCEPTION 'POST: % changed — it must not.', k; END IF;
  END LOOP;
  -- (b) every pre-existing policy byte-identical; exactly 5 new ones, all on the new tables
  SELECT md5(string_agg(tablename || '.' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public' AND tablename NOT IN ('event_needs', 'event_need_claims');
  IF v_pol_after <> v_pol_before THEN RAISE EXCEPTION 'POST: a pre-existing policy changed — it must not.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_pol_n_before + 5
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_needs') <> 4
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_need_claims') <> 1
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('event_needs', 'event_need_claims') AND roles <> '{authenticated}'::name[]) THEN
    RAISE EXCEPTION 'POST: the new tables'' policies are not exactly 4 + 1, all TO authenticated.';
  END IF;
  -- (c) every pre-existing table's ACL + RLS flag unchanged; triggers unchanged; constraints changed only by the 4 named adds
  SELECT md5(string_agg(c.relname || '=' || coalesce(c.relacl::text, '') || '/' || c.relrowsecurity, ',' ORDER BY c.relname))
    INTO v_acl_after FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm') AND c.relname NOT IN ('event_needs', 'event_need_claims');
  IF v_acl_after <> v_acl_before THEN RAISE EXCEPTION 'POST: a pre-existing table''s grants / RLS changed — they must not.'; END IF;
  SELECT md5(string_agg(conrelid::regclass::text || '.' || conname || '=' || pg_get_constraintdef(oid), ',' ORDER BY conrelid::regclass::text, conname))
    INTO v_con_after FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT (conname = ANY (v_new_cons))
     AND conrelid NOT IN ('public.event_needs'::regclass, 'public.event_need_claims'::regclass);
  IF v_con_after <> v_con_before THEN RAISE EXCEPTION 'POST: a pre-existing constraint changed — it must not.'; END IF;
  SELECT md5(string_agg(tgrelid::regclass::text || '.' || tgname || '=' || pg_get_triggerdef(oid) || '/' || tgenabled::text, ',' ORDER BY tgrelid::regclass::text, tgname))
    INTO v_trg_after FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
     AND tgrelid <> 'public.event_needs'::regclass;
  IF v_trg_after <> v_trg_before THEN RAISE EXCEPTION 'POST: a pre-existing trigger changed — it must not.'; END IF;
  -- (d) the new pieces are exactly as intended
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.recruitment_events'::regclass AND conname = 'recruitment_events_id_dept_key' AND contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.funding_events'::regclass AND conname = 'funding_events_id_dept_key' AND contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.action_items'::regclass AND conname = 'action_items_recruitment_event_fkey'
                      AND pg_get_constraintdef(oid) = 'FOREIGN KEY (recruitment_event_id, department_id) REFERENCES recruitment_events(id, department_id) ON DELETE SET NULL (recruitment_event_id)') THEN
    RAISE EXCEPTION 'POST: the (id, department_id) keys / the action_items link are not as intended.';
  END IF;
  FOREACH k IN ARRAY v_types LOOP
    IF position(quote_literal(k) in (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'recruitment_events_event_type_check')) = 0 THEN
      RAISE EXCEPTION 'POST: event_type CHECK is missing %.', k;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.recruitment_events'::regclass AND attname = 'event_type' AND (attnotnull OR atthasdef))
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.action_items'::regclass AND attname = 'recruitment_event_id' AND (attnotnull OR atthasdef)) THEN
    RAISE EXCEPTION 'POST: event_type / recruitment_event_id must be nullable with no default.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recruitment_events WHERE event_type IS NOT NULL) OR EXISTS (SELECT 1 FROM public.action_items WHERE recruitment_event_id IS NOT NULL) THEN
    RAISE EXCEPTION 'POST: an existing row was touched.';
  END IF;
  -- (e) the new tables: RLS on; anon nothing; claims read-only for authenticated
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_needs'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_need_claims'::regclass)
     OR has_table_privilege('anon', 'public.event_needs', 'SELECT') OR has_table_privilege('anon', 'public.event_needs', 'INSERT')
     OR has_table_privilege('anon', 'public.event_need_claims', 'SELECT') OR has_table_privilege('anon', 'public.event_need_claims', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.event_needs', 'SELECT') OR NOT has_table_privilege('authenticated', 'public.event_needs', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.event_needs', 'UPDATE') OR NOT has_table_privilege('authenticated', 'public.event_needs', 'DELETE')
     OR has_table_privilege('authenticated', 'public.event_needs', 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.event_need_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.event_need_claims', 'INSERT') OR has_table_privilege('authenticated', 'public.event_need_claims', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.event_need_claims', 'DELETE') OR has_table_privilege('authenticated', 'public.event_need_claims', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POST: the new tables'' RLS / grants are wrong (anon must have nothing; claims are RPC-only writes).';
  END IF;
  -- (f) the RPCs: definer, pinned search_path, authenticated-only; the guard executable by no one
  FOREACH k IN ARRAY v_rpcs LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') OR NOT has_function_privilege('authenticated', k, 'EXECUTE')
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(k))
       OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(k) AND proconfig @> array['search_path=public']) THEN
      RAISE EXCEPTION 'POST: % privileges / definer / search_path wrong.', k;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.tg_event_needs_guard()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.tg_event_needs_guard()', 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.event_needs'::regclass AND tgname = 'event_needs_guard' AND tgenabled = 'O'
                      AND pg_get_triggerdef(oid) LIKE '%BEFORE UPDATE ON public.event_needs%') THEN
    RAISE EXCEPTION 'POST: the event_needs guard / its trigger is not as intended.';
  END IF;
  -- (g) verified untouched (nothing here writes station_presence; prove it)
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'POST: the verified count moved (% -> %).', v_ver_before, v_ver_after; END IF;
END
$mig$;

NOTIFY pgrst, 'reload schema';

-- =====================================================================
-- STATE ROW (read-only) — paste this back with the apply.
-- =====================================================================
SELECT jsonb_build_object(
  'event_needs',          to_regclass('public.event_needs') IS NOT NULL,
  'event_need_claims',    to_regclass('public.event_need_claims') IS NOT NULL,
  'new_policies',         (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('event_needs', 'event_need_claims')),
  'total_policies',       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'rpcs',                 (SELECT jsonb_agg(p.proname || ' anon=' || has_function_privilege('anon', p.oid, 'EXECUTE') || ' auth=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') ORDER BY p.proname)
                             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                              AND p.proname IN ('claim_event_need', 'unclaim_event_need', 'assign_event_need', 'remove_event_need_claim', 'tg_event_needs_guard')),
  'event_type_null_rows', (SELECT count(*) FROM public.recruitment_events WHERE event_type IS NULL),
  'recruitment_events',   (SELECT count(*) FROM public.recruitment_events),
  'action_items_linked',  (SELECT count(*) FROM public.action_items WHERE recruitment_event_id IS NOT NULL),
  'id_dept_keys',         (SELECT count(*) FROM pg_constraint WHERE conname IN ('recruitment_events_id_dept_key', 'funding_events_id_dept_key')),
  'anon_on_new_tables',   has_table_privilege('anon', 'public.event_needs', 'SELECT') OR has_table_privilege('anon', 'public.event_need_claims', 'SELECT'),
  'claims_write_grant',   has_table_privilege('authenticated', 'public.event_need_claims', 'INSERT'),
  'fn_count',             (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence',    (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
