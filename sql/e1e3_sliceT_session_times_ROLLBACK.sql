-- =====================================================================
-- ROLLBACK for e1e3_sliceT_session_times — insurance, GENERATED from the same capture.
-- Refuses unless Slice T is applied, and REFUSES while any session holds actual times or a setup time (dropping the columns
-- would destroy them — clear them with Correct first, or keep the slice). Then: drop the times finalize, restore
-- correct_training_session + the lock guard from their exact captured definitions (CREATE OR REPLACE — ACLs kept), drop the four
-- CHECKs and the three columns, and prove every pin is back.
-- =====================================================================
DO $rollback$
DECLARE v_n bigint;
BEGIN
  IF to_regprocedure('public.finalize_training_session(uuid, time without time zone, time without time zone, integer)') IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'actual_start') THEN
    RAISE EXCEPTION 'ROLLBACK: Slice T is not applied. Refusing.';
  END IF;
  SELECT count(*) INTO v_n FROM public.training_sessions WHERE actual_start IS NOT NULL OR actual_end IS NOT NULL OR setup_min IS NOT NULL;
  IF v_n > 0 THEN RAISE EXCEPTION 'ROLLBACK: % session(s) hold actual times or a setup time — dropping the columns would lose them. Refusing.', v_n; END IF;
  DROP FUNCTION public.finalize_training_session(uuid, time without time zone, time without time zone, integer);
CREATE OR REPLACE FUNCTION public.correct_training_session(p_session_id uuid, p_changes jsonb, p_add uuid[], p_remove uuid[], p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- B4C:slice7 — a cancelled session is restored (two-person), not corrected.
      if s.status = 'cancelled' then raise exception 'CANCELLED: this session was cancelled — restore it before correcting it.'; end if;
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
    $function$
;
CREATE OR REPLACE FUNCTION public.tg_training_session_lock_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- B4C:slice6 C7 — once a session is FINALIZED or HAS ATTENDANCE (Slice 7: or is CANCELLED), the fields that define the
    -- record (and the attested hours derived from it) change only through the RPCs, which set the transaction-local flag.
    -- Exempt so Finalize / sign-in keep working: done, signin_open, signin_token, location_lat/lng/radius_m,
    -- location_label, and duration_min NULL -> a value on a not-yet-finalized row (Finalize's length prompt).
    -- Slice 7: status ('scheduled'/'cancelled') changes ONLY under the flag (approve_session_change), on any row, and a new
    -- row is always 'scheduled'. date / start_time stay free on an upcoming, unattended session (plain Edit — ruling 3b).
    -- Applies to EVERY writer, the table owner included — a hand fix in the SQL editor must set the flag on purpose.
    begin
      if coalesce(current_setting('b4c.session_correction', true), '') = 'on' then return NEW; end if;
      if TG_OP = 'INSERT' then
        if NEW.status is distinct from 'scheduled' then
          raise exception 'STATUS_LOCKED: a session is created scheduled — cancelling takes the two-person sign-off.' using errcode = '42501';
        end if;
        return NEW;
      end if;
      if NEW.status is distinct from OLD.status then
        raise exception 'STATUS_LOCKED: a session is cancelled or restored only through the two-person sign-off.' using errcode = '42501';
      end if;
      if not (OLD.done is true or OLD.status = 'cancelled' or exists (select 1 from public.session_attendance sa where sa.session_id = OLD.id)) then
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
        raise exception 'LOCKED_SESSION: this session is finalized, cancelled or has attendance — change it with Correct (or Restore), which is logged.'
          using errcode = '42501';
      end if;
      return NEW;
    end;
    $function$
;
  ALTER TABLE public.training_sessions DROP CONSTRAINT training_sessions_actual_pair;
  ALTER TABLE public.training_sessions DROP CONSTRAINT training_sessions_actual_whole_minutes;
  ALTER TABLE public.training_sessions DROP CONSTRAINT training_sessions_actual_length;
  ALTER TABLE public.training_sessions DROP CONSTRAINT training_sessions_setup_range;
  ALTER TABLE public.training_sessions DROP COLUMN actual_start, DROP COLUMN actual_end, DROP COLUMN setup_min;
  IF md5(pg_get_functiondef('public.correct_training_session(uuid, jsonb, uuid[], uuid[], text)'::regprocedure)) IS DISTINCT FROM 'ec6b3c29d4cf472527ec84f948b84b88' OR md5(pg_get_functiondef('public.tg_training_session_lock_guard()'::regprocedure)) IS DISTINCT FROM '47918d20ab527240e54360eacca00cac' OR md5(pg_get_functiondef('public.finalize_training_session(uuid, integer)'::regprocedure)) IS DISTINCT FROM '3f31142bae70c8fd2001c4fb657f4efa'
     OR coalesce((SELECT proacl::text FROM pg_proc WHERE oid = 'public.correct_training_session(uuid, jsonb, uuid[], uuid[], text)'::regprocedure), '') IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' OR coalesce((SELECT proacl::text FROM pg_proc WHERE oid = 'public.tg_training_session_lock_guard()'::regprocedure), '') IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR (SELECT string_agg(column_name || ':' || udt_name || ':' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions') IS DISTINCT FROM 'id:uuid:NO,department_id:uuid:NO,plan_id:uuid:YES,title:text:NO,date:date:NO,done:bool:NO,created_at:timestamptz:NO,signin_token:text:YES,signin_open:bool:NO,series_id:uuid:YES,audience:text:NO,start_time:time:YES,counts_toward_attendance:bool:NO,location_lat:float8:YES,location_lng:float8:YES,location_radius_m:int4:YES,location_label:text:YES,is_offsite:bool:NO,duration_min:int2:YES,is_meeting:bool:NO,status:text:NO' OR (SELECT md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' ORDER BY conname COLLATE "C")) FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND contype <> 'n' AND conname NOT LIKE 'training_sessions\_actual\_%' AND conname <> 'training_sessions_setup_range') IS DISTINCT FROM '56d93bbf68ed673369ecc7f1f9b0f981' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: not back to the captured state. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
