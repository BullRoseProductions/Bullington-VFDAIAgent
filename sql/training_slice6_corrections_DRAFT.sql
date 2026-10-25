-- =====================================================================
-- TRAINING OVERHAUL SLICE 6-DB — corrections + audit log + lock enforcement.          DRAFT — NOT APPLIED. NOT REVIEWED.
--
-- Rulings: claude/B4C_TrainingOverhaul_Slice6_Step0_ReviewRecord.md (C1–C7, R1–R4, locked Oct 25).
-- Step 0:  claude/B4C_TrainingOverhaul_Slice6_Step0.md (feat/training-slice6-step0 @ 49fc23f).
-- Binding: claude/B4C_Training_Hours_From_Attendance_Brief.md — officer-attested hours are DERIVED (attested_training,
--          flat 90 / verified=false / observed wins). Nothing here writes station_presence or touches `verified`.
--
-- ONE ALL-OR-NOTHING DO BLOCK. Any failed pre-flight, DDL or post-condition raises and the whole thing rolls back.
-- Then one read-only state row. Then the RETEST (sql/training_slice6_corrections_RETEST.sql), separately.
--
-- WHAT IT ADDS
--   training_session_audit         append-only, dept-scoped log: who / when / what (old -> new) / roster ± / why.
--                                  RLS; SELECT for is_leadership() in the row's own department; NO write policy and NO
--                                  write grant — only the SECURITY DEFINER RPCs below write it. An append-only trigger
--                                  refuses UPDATE/DELETE even from the owner.
--   correct_training_session(…)   the gated, logged correction of a LOCKED session (C1 hybrid, C2 reason, §2a fields,
--                                  roster deltas). One audit row.
--   reopen_training_session(…)    done -> false + reason + audit row (snapshots the roll — see finalize).
--   finalize_training_session(…)  what the client's finalize does today (done + a first length) + audit row (C4) + R4
--                                  last_iso; logs roster changes made between a Reopen and this close.
--   drill_window_presence(…)      R2 read: standby rows overlapping the drill window, timezone math as attested_training.
--   recompute_training_plan_last_iso(…)  R4 helper, internal (no EXECUTE for anyone but the owner).
--   tg_training_session_lock_guard  C7: BEFORE UPDATE — an attended or finalized session's protected fields can only
--                                  change inside the RPCs (transaction-local flag b4c.session_correction).
--   UPDATE policy                  C7: "leaders update training_sessions" USING gains AND done IS NOT TRUE.
--
-- DECISIONS MADE HERE THAT THE RECORD DID NOT SPELL OUT (each flagged for the gate review — see the DRYRUN doc):
--   D1  The C1 "DA-only after 14 days" branch checks the 'Department Admin' ROLE directly, NOT is_dept_admin():
--       live is_dept_admin() also admits Project Admin, and a PA must never rewrite a finalized attendance record
--       ([[pa-support-action-boundary]]). Same DA arm as is_training_manager().
--   D2  "Older than 14 days" uses the EARLIER of the drill's current date and a corrected date, in Central time — moving
--       a recent drill back into the past is rewriting an old record too.
--   D3  Reopen uses the same 14-day hybrid. Without it Reopen -> re-mark -> Finalize is a way around C1.
--   D4  Two columns beyond the record's list: roster_snapshot (Reopen only) and seq (an identity for ordering), so
--       Finalize can log who was added/removed between a Reopen and the close (toggleAttend writes directly while the
--       session is open). Otherwise the "complete close -> reopen -> correct history" has a hole exactly where Reopen
--       is used.
--   D5  actor_id has NO foreign key (members can be deleted; the log must neither block that nor lose its row);
--       actor_name is the snapshot. department_id -> departments with NO ACTION (a department with a correction log
--       can't be deleted without deliberately clearing it).
--   D6  R4 recompute = the latest done, attended session's date in that category; if no such session exists the stored
--       value is LEFT AS IS (never nulled). It CAN move the date backward — that is how a Sep-24 -> Sep-3 correction
--       un-stamps a wrong Sep-24. Finalize itself uses greatest(existing, drill date) per the record.
--   D7  Finalize refuses while the QR sign-in is open (the client already closes it first via close_signin) and refuses
--       a length that differs from one already recorded (that is a Correct).
--
-- APPLY TIMING (important): the policy term makes today's client Reopen (a direct update on a done row) affect 0 rows
-- SILENTLY until 6-UI ships the RPC call. Apply this in the same window as the 6-UI promote, not days before.
-- =====================================================================

DO $mig$
DECLARE
  -- ---- pins (live, 2026-10-25) ----
  v_pin_fns constant jsonb := jsonb_build_object(
    'public.is_training_manager()',                                        '472b87b0abca586ba0a13cd615b376fe',
    'public.is_training_officer()',                                        '248392a51fe913771f725b2a51013302',
    'public.is_leadership()',                                              'cc5861c24398fbf58147fee6f60cf410',
    'public.my_department_id()',                                           '87f546659c3804a943b48e419e017f18',
    'public.my_member_id()',                                               '3f66369c8af7bc07ec59831af6536fee',
    'public.membership_window_allows(uuid,date)',                          '8f38fbf3f99e1580d13d2b33fa806191',
    'public.tg_session_attendance_membership_window()',                    '3cebc508f04b88fcdbba2c11d07ca25e',
    'public.tg_training_session_date_membership_window()',                 '2729b8d90a36eeed3d617e5e98235ae9',
    'public.close_training_presence_on_done()',                            '710973082e68dc14177879de7d10af75');
  -- read-only hours readers: pinned before AND re-checked after — this migration must not change any of them
  v_pin_readers constant jsonb := jsonb_build_object(
    'public.attested_training(uuid,timestamptz,timestamptz)',              'aff25333771cd38c1f473bcde5e1e96e',
    'public.dept_station_shifts(timestamptz,timestamptz)',                 '894bbaa8f37ca95da454dd075aab1d41',
    'public.dept_iso_hours(timestamptz,timestamptz)',                      '306fa11b6473fefa9c737c3a59bfe826',
    'public.dept_iso_hours_for(uuid,timestamptz,timestamptz)',             '91ceb031497e2e70d64f07540f7bd0a9',
    'public.dept_iso_hours_by_station(timestamptz,timestamptz)',           '5a895ed77425f86287ac9b9afa1dbf5e',
    'public.dept_member_iso_hours_by_month(uuid,timestamptz[],timestamptz[])', 'cb10fc24fcf25d0e919ead5299e71dcc');
  v_upd_expr constant text := '((department_id = my_department_id()) AND is_training_manager())';
  v_new_using constant text := '((department_id = my_department_id()) AND is_training_manager() AND (done IS NOT TRUE))';
  v_rpcs constant text[] := array[
    'public.correct_training_session(uuid,jsonb,uuid[],uuid[],text)',
    'public.reopen_training_session(uuid,text)',
    'public.finalize_training_session(uuid,integer)',
    'public.drill_window_presence(uuid)'];
  v_internal constant text[] := array[
    'public.recompute_training_plan_last_iso(uuid)',
    'public.tg_training_session_lock_guard()',
    'public.tg_training_session_audit_append_only()'];
  k text; v text; v_md5 text; v_n int; r record;
BEGIN
  -- =================================================================
  -- 0. PRE-FLIGHT — refuse, don't break.
  -- =================================================================
  -- (a) double-apply
  IF to_regclass('public.training_session_audit') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: training_session_audit already exists — Slice 6-DB looks applied. Refusing to re-run.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('correct_training_session', 'reopen_training_session', 'finalize_training_session', 'drill_window_presence',
                     'recompute_training_plan_last_iso', 'tg_training_session_lock_guard', 'tg_training_session_audit_append_only');
  IF v_n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT: % Slice 6 function name(s) already exist. Refusing.', v_n; END IF;

  -- (b) md5 pins: everything this migration calls, wraps or depends on, plus the read-only hours readers
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pin_fns || v_pin_readers) LOOP
    IF to_regprocedure(k) IS NULL THEN RAISE EXCEPTION 'PREFLIGHT: % is missing.', k; END IF;
    v_md5 := md5(pg_get_functiondef(to_regprocedure(k)));
    IF v_md5 <> v THEN RAISE EXCEPTION 'PREFLIGHT: % has drifted (live md5 %, pinned %). Re-audit before applying.', k, v_md5, v; END IF;
  END LOOP;

  -- (c) the training_sessions UPDATE policy: exactly one, with exactly the audited text (a second permissive UPDATE
  --     policy would bypass the new done term)
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_sessions' AND cmd IN ('UPDATE', 'ALL');
  IF v_n <> 1 THEN RAISE EXCEPTION 'PREFLIGHT: expected exactly 1 UPDATE/ALL policy on training_sessions, found %.', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_sessions'
                   AND policyname = 'leaders update training_sessions' AND cmd = 'UPDATE' AND permissive = 'PERMISSIVE'
                   AND roles = array['authenticated']::name[] AND qual = v_upd_expr AND with_check = v_upd_expr) THEN
    RAISE EXCEPTION 'PREFLIGHT: "leaders update training_sessions" is not the audited text (USING/CHECK %). Re-audit.', v_upd_expr;
  END IF;

  -- (d) R2: station_presence is RLS-on with NO policy a client could read through — the reason drill_window_presence is
  --     a DEFINER read. If that changes, the R2 design needs re-review.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.station_presence'::regclass) THEN
    RAISE EXCEPTION 'PREFLIGHT: station_presence RLS is off — R2 premise changed.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'station_presence' AND cmd IN ('SELECT', 'ALL');
  IF v_n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT: station_presence now has % SELECT/ALL policy(ies) — R2 premise changed. Re-audit.', v_n; END IF;

  -- (e) the triggers on training_sessions are the three audited ones (the guard joins them)
  SELECT count(*) INTO v_n FROM pg_trigger t WHERE t.tgrelid = 'public.training_sessions'::regclass AND NOT t.tgisinternal;
  IF v_n <> 3 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.training_sessions'::regclass AND tgname = 'training_session_date_membership_window')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.training_sessions'::regclass AND tgname = 'trg_close_training_presence_on_done')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.training_sessions'::regclass AND tgname = 'trg_close_training_presence_on_delete') THEN
    RAISE EXCEPTION 'PREFLIGHT: training_sessions triggers differ from the audit (found %). Re-audit.', v_n;
  END IF;

  -- =================================================================
  -- 1. THE AUDIT TABLE (C3, C5) — append-only by construction.
  -- =================================================================
  EXECUTE $ddl$
    CREATE TABLE public.training_session_audit (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      seq             bigint      GENERATED ALWAYS AS IDENTITY,          -- D4: total order, even within one transaction
      department_id   uuid        NOT NULL REFERENCES public.departments(id),          -- D5: NO ACTION
      session_id      uuid        NOT NULL REFERENCES public.training_sessions(id) ON DELETE RESTRICT,
      action          text        NOT NULL CHECK (action IN ('correct', 'reopen', 'finalize')),
      actor_id        uuid        NOT NULL,                              -- D5: deliberately no FK
      actor_name      text        NOT NULL,                              -- snapshot at write time
      at              timestamptz NOT NULL DEFAULT now(),
      reason          text,
      changes         jsonb       NOT NULL DEFAULT '{}'::jsonb,          -- {"field": {"old": …, "new": …}}
      roster_added    uuid[]      NOT NULL DEFAULT '{}',
      roster_removed  uuid[]      NOT NULL DEFAULT '{}',
      roster_before   integer     NOT NULL,
      roster_after    integer     NOT NULL,
      roster_snapshot uuid[],                                            -- D4: the roll at a Reopen
      CONSTRAINT training_session_audit_reason_chk CHECK (action = 'finalize' OR length(btrim(coalesce(reason, ''))) >= 10)
    )
  $ddl$;
  EXECUTE 'CREATE INDEX training_session_audit_session_idx ON public.training_session_audit (session_id, seq)';
  EXECUTE 'ALTER TABLE public.training_session_audit ENABLE ROW LEVEL SECURITY';
  -- Supabase's default ACL grants ALL on new tables to anon/authenticated/service_role: take it all back, give SELECT.
  EXECUTE 'REVOKE ALL ON TABLE public.training_session_audit FROM PUBLIC, anon, authenticated';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.training_session_audit FROM service_role';
  EXECUTE 'GRANT SELECT ON TABLE public.training_session_audit TO authenticated';
  -- is_leadership() is role-anywhere, so the row's own department is compared too ([[both-admin-gate-fns-exist]])
  EXECUTE $ddl$
    CREATE POLICY "leadership reads training_session_audit" ON public.training_session_audit
      FOR SELECT TO authenticated
      USING ((department_id = public.my_department_id()) AND public.is_leadership())
  $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION public.tg_training_session_audit_append_only()
     RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
    AS $fn$
    -- B4C:slice6 — the correction log is append-only: no UPDATE, no DELETE, from anyone (the owner included).
    begin
      raise exception 'AUDIT_APPEND_ONLY: training_session_audit rows cannot be changed or removed.' using errcode = '42501';
    end;
    $fn$
  $ddl$;
  EXECUTE $ddl$
    CREATE TRIGGER training_session_audit_append_only BEFORE UPDATE OR DELETE ON public.training_session_audit
      FOR EACH ROW EXECUTE FUNCTION public.tg_training_session_audit_append_only()
  $ddl$;

  -- =================================================================
  -- 2. R4 — the last_iso recompute helper (internal).
  -- =================================================================
  EXECUTE $ddl$
    CREATE FUNCTION public.recompute_training_plan_last_iso(p_plan_id uuid)
     RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    AS $fn$
    -- B4C:slice6 R4 — a category's "last trained" = the latest FINALIZED drill in it with a NON-EMPTY roll. Called by the
    -- correction / reopen RPCs so a corrected date, category or roll can't leave it stale. No such drill -> left as is
    -- (never nulled: a value set before the app tracked sessions has no evidence to replace it with).
    begin
      if p_plan_id is null then return; end if;
      update public.training_plans tp
         set last_iso = coalesce((select max(ts."date") from public.training_sessions ts
                                   where ts.plan_id = tp.id and ts.done
                                     and exists (select 1 from public.session_attendance sa where sa.session_id = ts.id)),
                                 tp.last_iso)
       where tp.id = p_plan_id;
    end;
    $fn$
  $ddl$;

  -- =================================================================
  -- 3. C7 — the lock guard + the UPDATE-policy term.
  -- =================================================================
  EXECUTE $ddl$
    CREATE FUNCTION public.tg_training_session_lock_guard()
     RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    AS $fn$
    -- B4C:slice6 C7 — once a session is FINALIZED or HAS ATTENDANCE, the fields that define the record (and the attested
    -- hours derived from it) change only through correct_training_session, which sets the transaction-local flag.
    -- Exempt so Finalize / sign-in keep working: done, signin_open, signin_token, location_lat/lng/radius_m,
    -- location_label, and duration_min NULL -> a value on a not-yet-finalized row (Finalize's length prompt).
    -- Applies to EVERY writer, the table owner included — a hand fix in the SQL editor must set the flag on purpose.
    begin
      if coalesce(current_setting('b4c.session_correction', true), '') = 'on' then return NEW; end if;
      if not (OLD.done is true or exists (select 1 from public.session_attendance sa where sa.session_id = OLD.id)) then
        return NEW;
      end if;
      if NEW.title is distinct from OLD.title
         or NEW."date" is distinct from OLD."date"
         or NEW.start_time is distinct from OLD.start_time
         or NEW.audience is distinct from OLD.audience
         or NEW.plan_id is distinct from OLD.plan_id
         or NEW.counts_toward_attendance is distinct from OLD.counts_toward_attendance
         or NEW.is_meeting is distinct from OLD.is_meeting
         or NEW.is_offsite is distinct from OLD.is_offsite
         or NEW.department_id is distinct from OLD.department_id
         or NEW.series_id is distinct from OLD.series_id
         or (NEW.duration_min is distinct from OLD.duration_min
             and not (OLD.duration_min is null and OLD.done is not true)) then
        raise exception 'LOCKED_SESSION: this session is finalized or has attendance — change it with Correct, which is logged.'
          using errcode = '42501';
      end if;
      return NEW;
    end;
    $fn$
  $ddl$;
  EXECUTE $ddl$
    CREATE TRIGGER training_session_lock_guard BEFORE UPDATE ON public.training_sessions
      FOR EACH ROW EXECUTE FUNCTION public.tg_training_session_lock_guard()
  $ddl$;
  EXECUTE 'DROP POLICY "leaders update training_sessions" ON public.training_sessions';
  EXECUTE $ddl$
    CREATE POLICY "leaders update training_sessions" ON public.training_sessions
      FOR UPDATE TO authenticated
      USING ((department_id = my_department_id()) AND is_training_manager() AND (done IS NOT TRUE))
      WITH CHECK ((department_id = my_department_id()) AND is_training_manager())
  $ddl$;

  -- =================================================================
  -- 4. THE RPCs.
  -- =================================================================
  EXECUTE $ddl$
    CREATE FUNCTION public.correct_training_session(p_session_id uuid, p_changes jsonb, p_add uuid[], p_remove uuid[], p_reason text)
     RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    AS $fn$
    -- B4C:slice6 — the gated, logged correction of a LOCKED session (finalized, sign-in open, or anyone on the roll).
    -- C1 hybrid: a training manager within 14 days of the drill (Central); older = Department Admin only (D1: the ROLE,
    -- never Project Admin). C2: a reason of 10+ characters. Fields: §2a whitelist only. Roster: add/remove in the same
    -- transaction; the membership-window triggers still run, and a refusal there aborts the whole call (nothing written).
    declare
      v_dept   uuid := public.my_department_id();
      v_me     uuid := public.my_member_id();
      v_today  date := (now() at time zone 'America/Chicago')::date;
      v_reason text := btrim(coalesce(p_reason, ''));
      v_chg    jsonb := coalesce(p_changes, '{}'::jsonb);
      v_keys   constant text[] := array['title', 'date', 'start_time', 'duration_min', 'audience', 'plan_id',
                                        'counts_toward_attendance', 'is_meeting', 'is_offsite', 'location_label'];
      s        public.training_sessions%rowtype;
      v_bad    text[];
      n_title text; n_date date; n_start time; n_dur integer; n_aud text; n_plan uuid;
      n_counts boolean; n_meet boolean; n_off boolean; n_label text;
      v_diff   jsonb := '{}'::jsonb;
      v_add    uuid[]; v_rem uuid[];
      v_before integer; v_after integer;
      v_audit  uuid;
    begin
      if v_dept is null or v_me is null or not coalesce(public.is_training_manager(), false) then
        raise exception 'Only a training officer or a Department Admin can correct a session.' using errcode = '42501';
      end if;
      select * into s from public.training_sessions where id = p_session_id and department_id = v_dept for update;
      if not found then raise exception 'NOT_FOUND: that session is not in your department.' using errcode = 'P0002'; end if;
      if not (s.done or s.signin_open or exists (select 1 from public.session_attendance sa where sa.session_id = s.id)) then
        raise exception 'NOT_LOCKED: this session can still be edited normally — no correction needed.';
      end if;
      if length(v_reason) < 10 then raise exception 'REASON_REQUIRED: say why (at least 10 characters).'; end if;
      if jsonb_typeof(v_chg) <> 'object' then raise exception 'BAD_CHANGES: changes must be a JSON object.'; end if;
      select array_agg(k order by k) into v_bad from jsonb_object_keys(v_chg) k where k <> all (v_keys);
      if v_bad is not null then raise exception 'UNKNOWN_FIELD: % cannot be corrected here.', array_to_string(v_bad, ', '); end if;

      -- the corrected values (an absent key = unchanged)
      n_title  := case when v_chg ? 'title'        then btrim(v_chg->>'title') else s.title end;
      n_date   := case when v_chg ? 'date'         then (v_chg->>'date')::date else s."date" end;
      n_start  := case when v_chg ? 'start_time'   then nullif(v_chg->>'start_time', '')::time else s.start_time end;
      n_dur    := case when v_chg ? 'duration_min' then nullif(v_chg->>'duration_min', '')::integer else s.duration_min end;
      n_aud    := case when v_chg ? 'audience'     then v_chg->>'audience' else s.audience end;
      n_plan   := case when v_chg ? 'plan_id'      then nullif(v_chg->>'plan_id', '')::uuid else s.plan_id end;
      n_counts := case when v_chg ? 'counts_toward_attendance' then (v_chg->>'counts_toward_attendance')::boolean else s.counts_toward_attendance end;
      n_meet   := case when v_chg ? 'is_meeting'   then (v_chg->>'is_meeting')::boolean else s.is_meeting end;
      n_off    := case when v_chg ? 'is_offsite'   then (v_chg->>'is_offsite')::boolean else s.is_offsite end;
      n_label  := case when v_chg ? 'location_label' then nullif(btrim(v_chg->>'location_label'), '') else s.location_label end;
      if n_title is null or n_title = '' then raise exception 'BAD_VALUE: a session needs a title.'; end if;
      if n_date is null then raise exception 'BAD_VALUE: a session needs a date.'; end if;
      if n_counts is null or n_off is null then raise exception 'BAD_VALUE: counts_toward_attendance / is_offsite cannot be blank.'; end if;
      if n_dur is not null and (n_dur < 1 or n_dur > 1440) then raise exception 'BAD_VALUE: a length is 1–1440 minutes.'; end if;
      if n_aud is null or n_aud not in ('everyone', 'leadership', 'board') then raise exception 'BAD_VALUE: unknown audience.'; end if;
      if n_plan is distinct from s.plan_id and n_plan is not null
         and not exists (select 1 from public.training_plans tp where tp.id = n_plan and tp.department_id = v_dept) then
        raise exception 'BAD_VALUE: that training category is not in your department.';
      end if;
      if n_aud <> 'everyone' then n_meet := false; end if;      -- only an everyone session carries the meeting flag (client rule)
      if not n_off then n_label := null; end if;                -- off -> no label / coordinates (coords CHECK)

      -- C1 hybrid (D2: the earlier of the current and corrected date)
      if least(s."date", n_date) < v_today - 14
         and not exists (select 1 from public.members m where m.id = v_me and m.department_id = v_dept
                           and m.status in ('Active', 'Probationary') and m.access && array['Department Admin']::text[]) then
        raise exception 'DA_ONLY: correcting a drill more than 14 days old is for a Department Admin.' using errcode = '42501';
      end if;

      -- old -> new, only what actually changes
      if n_title  is distinct from s.title        then v_diff := v_diff || jsonb_build_object('title',        jsonb_build_object('old', s.title, 'new', n_title)); end if;
      if n_date   is distinct from s."date"       then v_diff := v_diff || jsonb_build_object('date',         jsonb_build_object('old', s."date", 'new', n_date)); end if;
      if n_start  is distinct from s.start_time   then v_diff := v_diff || jsonb_build_object('start_time',   jsonb_build_object('old', s.start_time, 'new', n_start)); end if;
      if n_dur    is distinct from s.duration_min then v_diff := v_diff || jsonb_build_object('duration_min', jsonb_build_object('old', s.duration_min, 'new', n_dur)); end if;
      if n_aud    is distinct from s.audience     then v_diff := v_diff || jsonb_build_object('audience',     jsonb_build_object('old', s.audience, 'new', n_aud)); end if;
      if n_plan   is distinct from s.plan_id      then v_diff := v_diff || jsonb_build_object('plan_id',      jsonb_build_object('old', s.plan_id, 'new', n_plan)); end if;
      if n_counts is distinct from s.counts_toward_attendance then v_diff := v_diff || jsonb_build_object('counts_toward_attendance', jsonb_build_object('old', s.counts_toward_attendance, 'new', n_counts)); end if;
      if n_meet   is distinct from s.is_meeting   then v_diff := v_diff || jsonb_build_object('is_meeting',   jsonb_build_object('old', s.is_meeting, 'new', n_meet)); end if;
      if n_off    is distinct from s.is_offsite   then v_diff := v_diff || jsonb_build_object('is_offsite',   jsonb_build_object('old', s.is_offsite, 'new', n_off)); end if;
      if n_label  is distinct from s.location_label then v_diff := v_diff || jsonb_build_object('location_label', jsonb_build_object('old', s.location_label, 'new', n_label)); end if;
      if not n_off and (s.location_lat is not null or s.location_lng is not null) then
        v_diff := v_diff || jsonb_build_object('location', jsonb_build_object('old', jsonb_build_object('lat', s.location_lat, 'lng', s.location_lng, 'radius_m', s.location_radius_m), 'new', null));
      end if;

      -- roster deltas: deduped, disjoint, truthful (no "adding" someone already there, no "removing" someone absent)
      select coalesce(array_agg(distinct x order by x), '{}') into v_add from unnest(coalesce(p_add, '{}')) x where x is not null;
      select coalesce(array_agg(distinct x order by x), '{}') into v_rem from unnest(coalesce(p_remove, '{}')) x where x is not null;
      if v_add && v_rem then raise exception 'BAD_ROSTER: a member cannot be both added and removed.'; end if;
      if exists (select 1 from unnest(v_add) x where not exists (select 1 from public.members m where m.id = x and m.department_id = v_dept)) then
        raise exception 'BAD_ROSTER: someone being added is not a member of your department.';
      end if;
      if exists (select 1 from unnest(v_add) x where exists (select 1 from public.session_attendance sa where sa.session_id = s.id and sa.member_id = x)) then
        raise exception 'BAD_ROSTER: someone being added is already on the roll.';
      end if;
      if exists (select 1 from unnest(v_rem) x where not exists (select 1 from public.session_attendance sa where sa.session_id = s.id and sa.member_id = x)) then
        raise exception 'BAD_ROSTER: someone being removed is not on the roll.';
      end if;
      if v_diff = '{}'::jsonb and cardinality(v_add) = 0 and cardinality(v_rem) = 0 then
        raise exception 'NO_CHANGE: nothing to correct.';
      end if;

      select count(*) into v_before from public.session_attendance where session_id = s.id;
      perform set_config('b4c.session_correction', 'on', true);
      -- removals BEFORE the date moves (someone leaving the roll must not block a date their window excludes);
      -- additions AFTER (their window is checked against the corrected date)
      delete from public.session_attendance where session_id = s.id and member_id = any (v_rem);
      if v_diff <> '{}'::jsonb then
        update public.training_sessions
           set title = n_title, "date" = n_date, start_time = n_start, duration_min = n_dur, audience = n_aud, plan_id = n_plan,
               counts_toward_attendance = n_counts, is_meeting = n_meet, is_offsite = n_off, location_label = n_label,
               location_lat = case when n_off then location_lat end,
               location_lng = case when n_off then location_lng end,
               location_radius_m = case when n_off then location_radius_m end
         where id = s.id;
      end if;
      insert into public.session_attendance (department_id, session_id, member_id, checked_in_at)
      select v_dept, s.id, x, now() from unnest(v_add) x;
      perform set_config('b4c.session_correction', '', true);
      select count(*) into v_after from public.session_attendance where session_id = s.id;

      perform public.recompute_training_plan_last_iso(s.plan_id);
      if n_plan is distinct from s.plan_id then perform public.recompute_training_plan_last_iso(n_plan); end if;

      insert into public.training_session_audit (department_id, session_id, action, actor_id, actor_name, reason, changes,
                                                 roster_added, roster_removed, roster_before, roster_after)
      values (v_dept, s.id, 'correct', v_me, coalesce((select m.name from public.members m where m.id = v_me), 'Unknown'),
              v_reason, v_diff, v_add, v_rem, v_before, v_after)
      returning id into v_audit;
      return jsonb_build_object('audit_id', v_audit, 'changes', v_diff, 'roster_added', to_jsonb(v_add),
                                'roster_removed', to_jsonb(v_rem), 'roster_before', v_before, 'roster_after', v_after);
    end;
    $fn$
  $ddl$;

  EXECUTE $ddl$
    CREATE FUNCTION public.reopen_training_session(p_session_id uuid, p_reason text)
     RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    AS $fn$
    -- B4C:slice6 C6 — Reopen with a reason, logged. Same C1 hybrid as a correction (D3). Snapshots the roll so the next
    -- Finalize can log who was added/removed while it was open (D4).
    declare
      v_dept   uuid := public.my_department_id();
      v_me     uuid := public.my_member_id();
      v_today  date := (now() at time zone 'America/Chicago')::date;
      v_reason text := btrim(coalesce(p_reason, ''));
      s        public.training_sessions%rowtype;
      v_snap   uuid[];
      v_audit  uuid;
    begin
      if v_dept is null or v_me is null or not coalesce(public.is_training_manager(), false) then
        raise exception 'Only a training officer or a Department Admin can reopen a session.' using errcode = '42501';
      end if;
      select * into s from public.training_sessions where id = p_session_id and department_id = v_dept for update;
      if not found then raise exception 'NOT_FOUND: that session is not in your department.' using errcode = 'P0002'; end if;
      if not s.done then raise exception 'NOT_FINALIZED: this session is not finalized.'; end if;
      if length(v_reason) < 10 then raise exception 'REASON_REQUIRED: say why (at least 10 characters).'; end if;
      if s."date" < v_today - 14
         and not exists (select 1 from public.members m where m.id = v_me and m.department_id = v_dept
                           and m.status in ('Active', 'Probationary') and m.access && array['Department Admin']::text[]) then
        raise exception 'DA_ONLY: reopening a drill more than 14 days old is for a Department Admin.' using errcode = '42501';
      end if;
      select coalesce(array_agg(sa.member_id order by sa.member_id), '{}') into v_snap
        from public.session_attendance sa where sa.session_id = s.id;
      update public.training_sessions set done = false where id = s.id;
      perform public.recompute_training_plan_last_iso(s.plan_id);
      insert into public.training_session_audit (department_id, session_id, action, actor_id, actor_name, reason, changes,
                                                 roster_before, roster_after, roster_snapshot)
      values (v_dept, s.id, 'reopen', v_me, coalesce((select m.name from public.members m where m.id = v_me), 'Unknown'),
              v_reason, jsonb_build_object('done', jsonb_build_object('old', true, 'new', false)),
              cardinality(v_snap), cardinality(v_snap), v_snap)
      returning id into v_audit;
      return jsonb_build_object('audit_id', v_audit, 'roster', cardinality(v_snap));
    end;
    $fn$
  $ddl$;

  EXECUTE $ddl$
    CREATE FUNCTION public.finalize_training_session(p_session_id uuid, p_duration_min integer)
     RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
    AS $fn$
    -- B4C:slice6 C4 — what the client's finalize does today (done, plus a FIRST length), logged. R4: a category's
    -- last_iso becomes greatest(existing, the drill's date) — and only when the roll is non-empty. If the session was
    -- reopened, the roster change since that Reopen is logged here (D4).
    declare
      v_dept  uuid := public.my_department_id();
      v_me    uuid := public.my_member_id();
      s       public.training_sessions%rowtype;
      v_dur   integer;
      v_now   uuid[]; v_snap uuid[]; v_last text;
      v_add   uuid[] := '{}'; v_rem uuid[] := '{}';
      v_diff  jsonb := jsonb_build_object('done', jsonb_build_object('old', false, 'new', true));
      v_audit uuid;
    begin
      if v_dept is null or v_me is null or not coalesce(public.is_training_manager(), false) then
        raise exception 'Only a training officer or a Department Admin can finalize a session.' using errcode = '42501';
      end if;
      select * into s from public.training_sessions where id = p_session_id and department_id = v_dept for update;
      if not found then raise exception 'NOT_FOUND: that session is not in your department.' using errcode = 'P0002'; end if;
      if s.done then raise exception 'ALREADY_FINALIZED: this session is already finalized.'; end if;
      if s.signin_open then raise exception 'SIGNIN_OPEN: close the QR sign-in first.'; end if;
      if p_duration_min is not null then
        if p_duration_min < 1 or p_duration_min > 1440 then raise exception 'BAD_VALUE: a length is 1–1440 minutes.'; end if;
        if s.duration_min is not null and s.duration_min <> p_duration_min then
          raise exception 'USE_CORRECT: this drill already has a length — change it with Correct.';
        end if;
      end if;
      v_dur := coalesce(s.duration_min, p_duration_min);
      if v_dur is distinct from s.duration_min then
        v_diff := v_diff || jsonb_build_object('duration_min', jsonb_build_object('old', s.duration_min, 'new', v_dur));
      end if;
      select coalesce(array_agg(sa.member_id order by sa.member_id), '{}') into v_now
        from public.session_attendance sa where sa.session_id = s.id;
      -- the latest log entry for this session: if it is a Reopen, compare the roll now with the roll then
      select a.action, a.roster_snapshot into v_last, v_snap
        from public.training_session_audit a where a.session_id = s.id order by a.seq desc limit 1;
      if v_last = 'reopen' then
        select coalesce(array_agg(x order by x), '{}') into v_add from unnest(v_now) x where x <> all (coalesce(v_snap, '{}'));
        select coalesce(array_agg(x order by x), '{}') into v_rem from unnest(coalesce(v_snap, '{}')) x where x <> all (v_now);
      end if;
      update public.training_sessions set done = true, duration_min = v_dur where id = s.id;
      if s.plan_id is not null and cardinality(v_now) > 0 then
        update public.training_plans set last_iso = greatest(coalesce(last_iso, s."date"), s."date") where id = s.plan_id;
      end if;
      insert into public.training_session_audit (department_id, session_id, action, actor_id, actor_name, reason, changes,
                                                 roster_added, roster_removed, roster_before, roster_after)
      values (v_dept, s.id, 'finalize', v_me, coalesce((select m.name from public.members m where m.id = v_me), 'Unknown'),
              null, v_diff, v_add, v_rem,
              cardinality(v_now) - cardinality(v_add) + cardinality(v_rem), cardinality(v_now))
      returning id into v_audit;
      return jsonb_build_object('audit_id', v_audit, 'present', cardinality(v_now), 'duration_min', v_dur,
                                'roster_added', to_jsonb(v_add), 'roster_removed', to_jsonb(v_rem));
    end;
    $fn$
  $ddl$;

  EXECUTE $ddl$
    CREATE FUNCTION public.drill_window_presence(p_session_id uuid)
     RETURNS TABLE(member_id uuid, member_name text, first_in timestamptz, last_out timestamptz,
                   still_open boolean, auto_closed boolean, on_roll boolean)
     LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
    AS $fn$
    -- B4C:slice6 R1/R2 — who was ON STANDBY while this drill ran: the roll-call prefill's suggestions. READ ONLY.
    -- Window start = (date + start_time) read in America/Chicago — the same expression attested_training uses; window
    -- length = the drill's duration_min, else the flat 90. No start time -> no window -> no rows. The caller decides
    -- (pre-ticked suggestions); confirming writes plain session_attendance via the existing roster path, never this.
    declare
      v_dept  uuid := public.my_department_id();
      s       public.training_sessions%rowtype;
      v_start timestamptz; v_end timestamptz;
    begin
      if v_dept is null or not coalesce(public.is_training_manager(), false) then
        raise exception 'Only a training officer or a Department Admin can see who was on station.' using errcode = '42501';
      end if;
      select * into s from public.training_sessions where id = p_session_id and department_id = v_dept;
      if not found then raise exception 'NOT_FOUND: that session is not in your department.' using errcode = 'P0002'; end if;
      if s.start_time is null then return; end if;
      v_start := (s."date" + s.start_time) at time zone 'America/Chicago';
      v_end   := v_start + make_interval(mins => coalesce(s.duration_min, 90));
      return query
        select sp.member_id, m.name, min(sp.checked_in_at), max(sp.checked_out_at),
               bool_or(sp.checked_out_at is null), bool_or(sp.auto_closed),
               exists (select 1 from public.session_attendance sa where sa.session_id = s.id and sa.member_id = sp.member_id)
          from public.station_presence sp
          join public.members m on m.id = sp.member_id and m.department_id = s.department_id
         where sp.department_id = s.department_id
           and sp.kind = 'standby'
           and sp.checked_in_at < v_end
           and coalesce(sp.checked_out_at, now()) > v_start
         group by sp.member_id, m.name
         order by m.name;
    end;
    $fn$
  $ddl$;

  -- =================================================================
  -- 5. PRIVILEGES — the anon/public revoke pattern ([[anon-execute-revoke-pattern]]).
  -- =================================================================
  FOREACH k IN ARRAY v_rpcs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', k);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', k);
  END LOOP;
  FOREACH k IN ARRAY v_internal LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', k);
  END LOOP;

  -- =================================================================
  -- 6. POST-CONDITIONS — any miss rolls the whole thing back.
  -- =================================================================
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pin_readers || v_pin_fns) LOOP
    IF md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN RAISE EXCEPTION 'POST: % changed — it must not.', k; END IF;
  END LOOP;
  FOREACH k IN ARRAY v_rpcs LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') OR NOT has_function_privilege('authenticated', k, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST: % privileges wrong (anon must not, authenticated must).', k;
    END IF;
    IF NOT (SELECT prosecdef AND proconfig @> array['search_path=public'] FROM pg_proc WHERE oid = to_regprocedure(k)) THEN
      RAISE EXCEPTION 'POST: % is not SECURITY DEFINER with search_path=public.', k;
    END IF;
  END LOOP;
  FOREACH k IN ARRAY v_internal LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') OR has_function_privilege('authenticated', k, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST: % must not be executable by anon/authenticated.', k;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.training_session_audit', 'SELECT')
     OR has_table_privilege('authenticated', 'public.training_session_audit', 'INSERT')
     OR has_table_privilege('authenticated', 'public.training_session_audit', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.training_session_audit', 'DELETE')
     OR has_table_privilege('authenticated', 'public.training_session_audit', 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.training_session_audit', 'SELECT') THEN
    RAISE EXCEPTION 'POST: training_session_audit grants wrong (authenticated SELECT only; anon nothing).';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_audit';
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_audit' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'POST: training_session_audit must have exactly one policy, SELECT (found %).', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_sessions'
                   AND policyname = 'leaders update training_sessions' AND qual = v_new_using AND with_check = v_upd_expr) THEN
    RAISE EXCEPTION 'POST: the training_sessions UPDATE policy is not the intended text.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_sessions' AND cmd IN ('UPDATE', 'ALL');
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST: expected exactly 1 UPDATE policy on training_sessions, found %.', v_n; END IF;

  PERFORM pg_notify('pgrst', 'reload schema');
END
$mig$;

-- ---------------------------------------------------------------------
-- STATE ROW (read-only) — paste this back with the apply.
-- ---------------------------------------------------------------------
SELECT jsonb_build_object(
  'audit_table',      to_regclass('public.training_session_audit') IS NOT NULL,
  'audit_rows',       (SELECT count(*) FROM public.training_session_audit),
  'update_policy',    (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_sessions' AND policyname = 'leaders update training_sessions'),
  'guard_trigger',    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.training_sessions'::regclass AND tgname = 'training_session_lock_guard'),
  'rpcs',             (SELECT jsonb_agg(p.proname || ' anon=' || has_function_privilege('anon', p.oid, 'EXECUTE') || ' auth=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') ORDER BY p.proname)
                         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                          AND p.proname IN ('correct_training_session', 'reopen_training_session', 'finalize_training_session', 'drill_window_presence',
                                            'recompute_training_plan_last_iso', 'tg_training_session_lock_guard', 'tg_training_session_audit_append_only')),
  'sessions_done',    (SELECT count(*) FROM public.training_sessions WHERE done),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified),
  'attested_md5',     md5(pg_get_functiondef('public.attested_training(uuid,timestamptz,timestamptz)'::regprocedure))
) AS slice6_db_state;
