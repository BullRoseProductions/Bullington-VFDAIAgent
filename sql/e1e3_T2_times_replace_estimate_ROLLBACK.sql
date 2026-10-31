-- =====================================================================
-- ROLLBACK for e1e3_T2_times_replace_estimate — insurance, GENERATED from the same capture.
-- Refuses unless T2 is applied (the times finalize = the T2 body). Restores the times finalize from its exact CAPTURED pre-T2
-- definition (CREATE OR REPLACE — ACL kept) and proves it is back on b702ad77a183903c06710e3edc33b637 with everything else untouched. No data
-- consequence: sessions finalized under T2 have duration_min = their span, which Slice T's CHECK + body accept as they are.
-- =====================================================================
DO $rollback$
DECLARE v_others text; v_acl text; v_n bigint;
BEGIN
  IF md5(pg_get_functiondef('public.finalize_training_session(uuid, time without time zone, time without time zone, integer)'::regprocedure)) IS DISTINCT FROM 'f3ef2eb69c220812a9863ff3f5c431e3' THEN RAISE EXCEPTION 'ROLLBACK: T2 is not applied (the times finalize is not the T2 body). Refusing.'; END IF;
  v_others := (SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.oid::regprocedure::text <> 'finalize_training_session(uuid,time without time zone,time without time zone,integer)'); v_acl := coalesce((SELECT proacl::text FROM pg_proc WHERE oid = 'public.finalize_training_session(uuid, time without time zone, time without time zone, integer)'::regprocedure), ''); v_n := (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f');
CREATE OR REPLACE FUNCTION public.finalize_training_session(p_session_id uuid, p_actual_start time without time zone, p_actual_end time without time zone, p_setup_min integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    -- B4C:E1E3 slice T — FINALIZE WITH THE ACTUAL TIMES (the length-only finalize_training_session(uuid, integer) stays as the
    -- fallback). The length is DERIVED from the actual start/end (an end at or before the start ran past midnight); setup_min
    -- is recorded only, never credited. NO DEFAULTS, on purpose: PostgREST picks an overload by its set of argument names, so
    -- this one answers ONLY {p_session_id, p_actual_start, p_actual_end, p_setup_min} and the length-only one ONLY
    -- {p_session_id, p_duration_min} — no call shape can match both (the clients that send p_duration_min keep the old
    -- function until they're updated). Otherwise exactly slice 6 C4: done, plus a FIRST length, logged. R4: a category's
    -- last_iso becomes greatest(existing, the drill's date) — and only when the roll is non-empty. If the session was
    -- reopened, the roster change since that Reopen is logged here (D4).
    declare
      v_dept  uuid := public.my_department_id();
      v_me    uuid := public.my_member_id();
      s       public.training_sessions%rowtype;
      v_dur   integer;
      v_span  integer; v_setup integer;
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
      -- B4C:slice7 — a cancelled drill didn't happen: nothing to finalize.
      if s.status = 'cancelled' then raise exception 'CANCELLED: this session was cancelled — restore it before finalizing.'; end if;
      if s.signin_open then raise exception 'SIGNIN_OPEN: close the QR sign-in first.'; end if;
      if p_actual_start is null or p_actual_end is null then
        raise exception 'BAD_VALUE: give both the actual start and end — or finalize with just a length.';
      end if;
      if p_actual_end = p_actual_start then raise exception 'BAD_VALUE: the actual end must differ from the start.'; end if;
      if extract(second from p_actual_start) <> 0 or extract(second from p_actual_end) <> 0 then raise exception 'BAD_VALUE: actual times are whole minutes.'; end if;
      if p_setup_min is not null and (p_setup_min < 0 or p_setup_min > 600) then raise exception 'BAD_VALUE: setup is 0–600 minutes.'; end if;
      v_span := ((extract(epoch from (p_actual_end - p_actual_start)) / 60)::integer + case when p_actual_end <= p_actual_start then 1440 else 0 end);   -- an end at or before the start ran past midnight
      if s.duration_min is not null and s.duration_min <> v_span then
        raise exception 'USE_CORRECT: this drill already has a length — change it with Correct.';
      end if;
      if s.actual_start is not null and (s.actual_start, s.actual_end) is distinct from (p_actual_start, p_actual_end) then
        raise exception 'USE_CORRECT: this drill already has actual times — change them with Correct.';
      end if;
      if s.setup_min is not null and p_setup_min is not null and s.setup_min <> p_setup_min then
        raise exception 'USE_CORRECT: this drill already has a setup time — change it with Correct.';
      end if;
      v_dur := v_span;
      v_setup := coalesce(s.setup_min, p_setup_min);
      if v_dur is distinct from s.duration_min then
        v_diff := v_diff || jsonb_build_object('duration_min', jsonb_build_object('old', s.duration_min, 'new', v_dur));
      end if;
      if p_actual_start is distinct from s.actual_start then v_diff := v_diff || jsonb_build_object('actual_start', jsonb_build_object('old', s.actual_start, 'new', p_actual_start)); end if;
      if p_actual_end is distinct from s.actual_end then v_diff := v_diff || jsonb_build_object('actual_end', jsonb_build_object('old', s.actual_end, 'new', p_actual_end)); end if;
      if v_setup is distinct from s.setup_min then v_diff := v_diff || jsonb_build_object('setup_min', jsonb_build_object('old', s.setup_min, 'new', v_setup)); end if;
      select coalesce(array_agg(sa.member_id order by sa.member_id), '{}') into v_now
        from public.session_attendance sa where sa.session_id = s.id;
      -- the latest log entry for this session: if it is a Reopen, compare the roll now with the roll then
      select a.action, a.roster_snapshot into v_last, v_snap
        from public.training_session_audit a where a.session_id = s.id order by a.seq desc limit 1;
      if v_last = 'reopen' then
        select coalesce(array_agg(x order by x), '{}') into v_add from unnest(v_now) x where x <> all (coalesce(v_snap, '{}'));
        select coalesce(array_agg(x order by x), '{}') into v_rem from unnest(coalesce(v_snap, '{}')) x where x <> all (v_now);
      end if;
      update public.training_sessions set done = true, duration_min = v_dur, actual_start = p_actual_start, actual_end = p_actual_end, setup_min = v_setup where id = s.id;
      if s.plan_id is not null and cardinality(v_now) > 0 then
        update public.training_plans set last_iso = greatest(coalesce(last_iso, s."date"), s."date") where id = s.plan_id;
      end if;
      insert into public.training_session_audit (department_id, session_id, action, actor_id, actor_name, reason, changes,
                                                 roster_added, roster_removed, roster_before, roster_after)
      values (v_dept, s.id, 'finalize', v_me, coalesce((select m.name from public.members m where m.id = v_me), 'Unknown'),
              null, v_diff, v_add, v_rem,
              cardinality(v_now) - cardinality(v_add) + cardinality(v_rem), cardinality(v_now))
      returning id into v_audit;
      return jsonb_build_object('audit_id', v_audit, 'present', cardinality(v_now), 'duration_min', v_dur, 'actual_start', p_actual_start, 'actual_end', p_actual_end, 'setup_min', v_setup,
                                'roster_added', to_jsonb(v_add), 'roster_removed', to_jsonb(v_rem));
    end;
    $function$
;
  IF md5(pg_get_functiondef('public.finalize_training_session(uuid, time without time zone, time without time zone, integer)'::regprocedure)) IS DISTINCT FROM 'b702ad77a183903c06710e3edc33b637' OR coalesce((SELECT proacl::text FROM pg_proc WHERE oid = 'public.finalize_training_session(uuid, time without time zone, time without time zone, integer)'::regprocedure), '') IS DISTINCT FROM v_acl OR (SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.oid::regprocedure::text <> 'finalize_training_session(uuid,time without time zone,time without time zone,integer)') IS DISTINCT FROM v_others OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f') <> v_n
     OR (SELECT string_agg(array_to_string(p.proargnames, ',') || '/' || p.pronargdefaults, ' | ' ORDER BY p.pronargs) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'finalize_training_session') IS DISTINCT FROM 'p_session_id,p_duration_min/0 | p_session_id,p_actual_start,p_actual_end,p_setup_min/0' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: not back to the captured pre-T2 state. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
