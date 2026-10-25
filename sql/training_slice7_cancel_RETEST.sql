-- =====================================================================
-- RETEST for training_slice7_cancel (Slice 7-DB). READ-ONLY IN EFFECT — run AFTER the migration, separately.
--
-- Every fixture and write lives inside a per-department sub-block ending in RAISE 'SENTINEL' (rolled back); the whole
-- block ends in a RAISE that IS the report. NOTHING CHANGES. The "ERROR" is the report.
--
-- Once:
--   O1 anon can't EXECUTE the 5 new RPCs; authenticated can; the 9 repointed readers kept their ACL (anon no, auth yes);
--      the guard isn't executable by anyone but its owner
--   O2 swap_week_dates and move_week are gone
--   O3 the 6 hours readers + attested_training are byte-identical to their pins
--   O4 training_sessions.status: NOT NULL, default 'scheduled', CHECK scheduled|cancelled
--   O5 the audit action CHECK carries cancel + restore (and correct/reopen/finalize)
--   O6 training_session_requests: RLS, one SELECT policy, no write grant, signatures NOT column-selectable
--   O7 the lock-guard trigger is BEFORE INSERT OR UPDATE
-- Per department (fixtures; manager #1 = a REAL active training officer where one exists, manager #2 = a REAL DA where
-- one exists; fixture Officer / Board / PA / Member / plain-Member TO for the matrix):
--   T1  #1 files a cancel -> pending; the session is untouched; no log row yet
--   T2  #1 can't approve their own request (SAME_PERSON); still pending
--   T3  a second request on the same session -> PENDING
--   T4  #2 approves -> approved; status cancelled; QR sign-in closed; ONE 'cancel' log row (old->new, request_id, actor #2)
--   T5  the 8 readers refuse the cancelled session (open_signin, member_check_in, set_session_location,
--       set_my_session_registration, finalize, correct, attach -> CANCELLED; current_signin_token -> NULL)
--   T6  my_department_rollup's next event skips the cancelled session
--   T7  a raw status UPDATE (owner AND authenticated) or a cancelled INSERT -> STATUS_LOCKED; a cancelled row is locked
--   T8  restore: #2 files, #1 approves -> scheduled; a 'restore' log row
--   T9  request refusals: ATTENDED / FINALIZED / NOT_UPCOMING / NOT_CANCELLED / BAD_KIND / REASON_REQUIRED / BAD_SIGNATURE (x2)
--   T10 reject (another manager, reason) + withdraw (initiator only) leave the session untouched
--   T11 a pending request whose drill date passes -> approve returns 'expired'; nothing applied, nothing logged
--   T12 Officer-not-TO / Board / PA / Member refused on request / approve / reject / withdraw
--   T13 another department's session / request -> NOT_FOUND
--   T14 the requests table: Board + a plain-Member TO read it (D2); a Member doesn't; signatures only via the RPC; no INSERT
--   T15 station_presence byte-identical across every RPC call; verified count unchanged
-- =====================================================================
DO $retest$
DECLARE
  rec record; k text; v text; v_err text; v_res jsonb; v_n int; v_n2 int; v_ok boolean; v_t text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_sig constant text := 'data:image/png;base64,' || repeat('Q', 64);
  v_pins constant jsonb := jsonb_build_object(
    'public.attested_training(uuid,timestamptz,timestamptz)',              'aff25333771cd38c1f473bcde5e1e96e',
    'public.dept_station_shifts(timestamptz,timestamptz)',                 '894bbaa8f37ca95da454dd075aab1d41',
    'public.dept_iso_hours(timestamptz,timestamptz)',                      '306fa11b6473fefa9c737c3a59bfe826',
    'public.dept_iso_hours_for(uuid,timestamptz,timestamptz)',             '91ceb031497e2e70d64f07540f7bd0a9',
    'public.dept_iso_hours_by_station(timestamptz,timestamptz)',           '5a895ed77425f86287ac9b9afa1dbf5e',
    'public.dept_member_iso_hours_by_month(uuid,timestamptz[],timestamptz[])', 'cb10fc24fcf25d0e919ead5299e71dcc');
  v_rpcs constant text[] := array['public.request_session_change(uuid,text,text,text)', 'public.approve_session_change(uuid,text)',
    'public.reject_session_change(uuid,text)', 'public.withdraw_session_change(uuid)', 'public.session_change_signatures(uuid)'];
  v_readers constant text[] := array['public.open_signin(uuid)', 'public.current_signin_token(uuid)',
    'public.member_check_in(uuid,text,double precision,double precision,double precision)',
    'public.set_session_location(uuid,double precision,double precision,integer,text)', 'public.set_my_session_registration(uuid,text)',
    'public.finalize_training_session(uuid,integer)', 'public.correct_training_session(uuid,jsonb,uuid[],uuid[],text)',
    'public.attach_drill_plan_to_session(uuid,uuid)', 'public.my_department_rollup()'];
  d uuid; dn text; tag text;
  e1 text; e2 text; m1 uuid; m2 uuid; real1 boolean; real2 boolean;
  e_off text; e_board text; e_pa text; e_mem text; e_to2 text; a1 uuid; dp uuid;
  su uuid; sa uuid; sf uuid; sp uuid; sx uuid; s_other uuid; r1 uuid; r2 uuid; r3 uuid; r_other uuid;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint; v_next0 text; v_next1 text;
BEGIN
  -- ---------------------------------------------------------------- once
  v_ok := true; v_err := '';
  FOREACH k IN ARRAY v_rpcs LOOP
    IF to_regprocedure(k) IS NULL OR has_function_privilege('anon', k, 'EXECUTE') OR NOT has_function_privilege('authenticated', k, 'EXECUTE') THEN v_ok := false; v_err := v_err || ' ' || k; END IF;
  END LOOP;
  FOREACH k IN ARRAY v_readers LOOP
    IF to_regprocedure(k) IS NULL OR has_function_privilege('anon', k, 'EXECUTE') OR NOT has_function_privilege('authenticated', k, 'EXECUTE') THEN v_ok := false; v_err := v_err || ' ' || k; END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.tg_training_session_lock_guard()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.tg_training_session_lock_guard()', 'EXECUTE') THEN v_ok := false; v_err := v_err || ' guard'; END IF;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 privileges: 5 RPCs auth-only; 9 readers kept their ACL; guard owner-only' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 privileges:' || v_err || chr(10); END IF;

  IF to_regproc('public.swap_week_dates') IS NULL AND to_regproc('public.move_week') IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 swap_week_dates + move_week are gone' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 swap_week_dates / move_week still exist' || chr(10); END IF;

  v_ok := true; v_err := '';
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF to_regprocedure(k) IS NULL OR md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN v_ok := false; v_err := v_err || ' ' || k; END IF;
  END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 the 6 hours readers are byte-identical to their pins' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 hours reader(s) changed:' || v_err || chr(10); END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'status'
               AND is_nullable = 'NO' AND column_default LIKE '''scheduled''%')
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND conname = 'training_sessions_status_check'
                   AND pg_get_constraintdef(oid) LIKE '%scheduled%' AND pg_get_constraintdef(oid) LIKE '%cancelled%') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O4 status: NOT NULL, default scheduled, CHECK scheduled|cancelled' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O4 status column not as intended' || chr(10); END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.training_session_audit'::regclass AND conname = 'training_session_audit_action_check'
               AND pg_get_constraintdef(oid) LIKE '%cancel''%' AND pg_get_constraintdef(oid) LIKE '%restore%' AND pg_get_constraintdef(oid) LIKE '%correct%'
               AND pg_get_constraintdef(oid) LIKE '%reopen%' AND pg_get_constraintdef(oid) LIKE '%finalize%') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O5 audit actions: correct, reopen, finalize, cancel, restore' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O5 audit action CHECK' || chr(10); END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.training_session_requests'::regclass)
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_requests' AND cmd = 'SELECT') = 1
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_requests') = 1
     AND NOT has_table_privilege('authenticated', 'public.training_session_requests', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.training_session_requests', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.training_session_requests', 'DELETE')
     AND NOT has_table_privilege('anon', 'public.training_session_requests', 'SELECT')
     AND NOT has_column_privilege('authenticated', 'public.training_session_requests', 'initiator_signature', 'SELECT')
     AND NOT has_column_privilege('authenticated', 'public.training_session_requests', 'approver_signature', 'SELECT')
     AND has_column_privilege('authenticated', 'public.training_session_requests', 'state', 'SELECT') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O6 requests: RLS, one SELECT policy, no write grant, signatures not selectable' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O6 requests table RLS/grants' || chr(10); END IF;

  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.training_sessions'::regclass AND tgname = 'training_session_lock_guard'
               AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE%' AND tgenabled = 'O') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O7 lock guard: BEFORE INSERT OR UPDATE, enabled' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O7 lock guard trigger' || chr(10); END IF;

  -- ---------------------------------------------------------------- per department
  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; dn := rec.name; tag := 's7rt-' || left(replace(d::text, '-', ''), 8);
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      e1 := null; m1 := null; e2 := null; m2 := null;
      SELECT lower(m.email), m.id INTO e1, m1 FROM public.training_officer t JOIN public.members m ON m.id = t.member_id
       WHERE t.department_id = d AND t.removed_at IS NULL AND m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
         AND NOT m.access && array['Department Admin']::text[]
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      real1 := e1 IS NOT NULL;
      IF NOT real1 THEN
        e1 := tag || '-to@retest.invalid';
        INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST TO', e1, '{Member}', 'Active') RETURNING id INTO m1;
        INSERT INTO public.training_officer (department_id, member_id) VALUES (d, m1);
      END IF;
      SELECT lower(m.email), m.id INTO e2, m2 FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary')
         AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL AND m.id <> m1
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      real2 := e2 IS NOT NULL;
      IF NOT real2 THEN
        e2 := tag || '-da@retest.invalid';
        INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST DA', e2, '{Department Admin}', 'Active') RETURNING id INTO m2;
      END IF;
      e_off := tag || '-off@retest.invalid'; e_board := tag || '-board@retest.invalid'; e_pa := tag || '-pa@retest.invalid';
      e_mem := tag || '-mem@retest.invalid'; e_to2 := tag || '-to2@retest.invalid';
      INSERT INTO public.members (department_id, name, email, access, status) VALUES
        (d, 'RETEST Officer', e_off, '{Officer}', 'Active'), (d, 'RETEST Board', e_board, '{Board Member}', 'Active'),
        (d, 'RETEST PA', e_pa, '{Project Admin}', 'Active'), (d, 'RETEST Member', e_mem, '{Member}', 'Active'),
        (d, 'RETEST TO2', e_to2, '{Member}', 'Active');
      INSERT INTO public.training_officer (department_id, member_id) SELECT d, id FROM public.members WHERE email = e_to2;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST A1', tag || '-a1@retest.invalid', '{Member}', 'Active') RETURNING id INTO a1;
      INSERT INTO public.drill_plans (department_id, title, content) VALUES (d, 'RETEST plan', '{}'::jsonb) RETURNING id INTO dp;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (d, 'S7RT U ' || tag, v_today, '23:59', 60) RETURNING id INTO su;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (d, 'S7RT A ' || tag, v_today + 2, '19:00', 60) RETURNING id INTO sa;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min, done) VALUES (d, 'S7RT F ' || tag, v_today, '08:00', 60, true) RETURNING id INTO sf;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (d, 'S7RT P ' || tag, v_today - 2, '19:00', 60) RETURNING id INTO sp;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (d, 'S7RT X ' || tag, v_today + 5, '19:00', 60) RETURNING id INTO sx;
      INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (d, sa, a1, now());
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      rpt := rpt || format('   (manager #1 = a %s training officer, manager #2 = a %s Department Admin)%s',
                           CASE WHEN real1 THEN 'REAL' ELSE 'fixture' END, CASE WHEN real2 THEN 'REAL' ELSE 'fixture' END, chr(10));

      -- T0 (for T6): the member's next event before the cancel
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem)::text, true);
      SELECT x.my_next_event_title INTO v_next0 FROM public.my_department_rollup() x WHERE x.department_id = d;

      -- ---- T1 file a cancel
      PERFORM set_config('request.jwt.claims', json_build_object('email', e1)::text, true);
      v_err := null;
      BEGIN v_res := public.request_session_change(su, 'cancel', 'Storm warning — station closed tonight', v_sig); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      r1 := (v_res->>'request_id')::uuid;
      IF v_err IS NULL AND (SELECT state = 'pending' AND kind = 'cancel' AND initiator_id = m1 FROM public.training_session_requests WHERE id = r1)
         AND (SELECT status FROM public.training_sessions WHERE id = su) = 'scheduled'
         AND NOT EXISTS (SELECT 1 FROM public.training_session_audit WHERE session_id = su) THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T1 #1 files a cancel -> pending; session untouched; nothing logged yet' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 request: %s%s', coalesce(v_err, 'state wrong'), chr(10)); END IF;

      -- ---- T2 self-approve refused
      v_err := null; BEGIN PERFORM public.approve_session_change(r1, v_sig); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'SAME_PERSON%' AND (SELECT state FROM public.training_session_requests WHERE id = r1) = 'pending' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 the initiator can''t approve their own request (SAME_PERSON)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 self-approve: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;

      -- ---- T3 second pending refused
      PERFORM set_config('request.jwt.claims', json_build_object('email', e2)::text, true);
      v_err := null; BEGIN PERFORM public.request_session_change(su, 'cancel', 'Second request on the same drill', v_sig); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'PENDING%' THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T3 one pending request per session (PENDING)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 second pending: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;

      -- ---- T4 #2 approves
      UPDATE public.training_sessions SET signin_open = true, signin_token = 'RT7777' WHERE id = su;   -- an open QR, to prove D5
      v_err := null; v_res := null;
      BEGIN v_res := public.approve_session_change(r1, v_sig); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err IS NULL AND v_res->>'state' = 'approved'
         AND (SELECT status = 'cancelled' AND NOT signin_open AND signin_token IS NULL FROM public.training_sessions WHERE id = su)
         AND (SELECT state = 'approved' AND approver_id = m2 AND approver_signature IS NOT NULL FROM public.training_session_requests WHERE id = r1)
         AND (SELECT count(*) FROM public.training_session_audit WHERE session_id = su) = 1
         AND EXISTS (SELECT 1 FROM public.training_session_audit a WHERE a.session_id = su AND a.action = 'cancel' AND a.actor_id = m2
                       AND a.changes->'status'->>'old' = 'scheduled' AND a.changes->'status'->>'new' = 'cancelled'
                       AND a.changes->>'request_id' = r1::text AND a.reason = 'Storm warning — station closed tonight') THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T4 #2 approves -> cancelled, QR closed, ONE cancel log row (old->new, request_id, actor #2)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 approve: %s %s%s', coalesce(v_err, ''), coalesce(v_res::text, ''), chr(10)); END IF;

      -- ---- T5 the 8 readers refuse a cancelled session
      v_ok := true; v_err := '';
      BEGIN PERFORM public.open_signin(su); v_ok := false; v_err := v_err || ' open_signin:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CANCELLED%' THEN v_ok := false; v_err := v_err || ' open_signin:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.set_session_location(su, 30.0, -97.0, 200, 'x'); v_ok := false; v_err := v_err || ' set_session_location:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CANCELLED%' THEN v_ok := false; v_err := v_err || ' set_session_location:' || SQLERRM; END IF; END;
      UPDATE public.training_sessions SET signin_open = true, signin_token = 'RT8888' WHERE id = su;   -- sign-in fields stay writable
      IF public.current_signin_token(su) IS NOT NULL THEN v_ok := false; v_err := v_err || ' current_signin_token:returned a code'; END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e1)::text, true);
      BEGIN PERFORM public.finalize_training_session(su, null); v_ok := false; v_err := v_err || ' finalize:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CANCELLED%' THEN v_ok := false; v_err := v_err || ' finalize:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.correct_training_session(su, '{"title":"renamed"}', null, null, 'Correcting a cancelled one'); v_ok := false; v_err := v_err || ' correct:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CANCELLED%' THEN v_ok := false; v_err := v_err || ' correct:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.attach_drill_plan_to_session(dp, su); v_ok := false; v_err := v_err || ' attach:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CANCELLED%' THEN v_ok := false; v_err := v_err || ' attach:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem)::text, true);
      BEGIN PERFORM public.member_check_in(su, 'RT8888', null, null, null); v_ok := false; v_err := v_err || ' member_check_in:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CANCELLED%' THEN v_ok := false; v_err := v_err || ' member_check_in:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.set_my_session_registration(su, 'coming'); v_ok := false; v_err := v_err || ' rsvp:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CANCELLED%' THEN v_ok := false; v_err := v_err || ' rsvp:' || SQLERRM; END IF; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T5 the 8 readers refuse a cancelled session (7 CANCELLED; current_signin_token -> no code)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 readers:%s%s', v_err, chr(10)); END IF;

      -- ---- T6 the rollup's next event skips it
      SELECT x.my_next_event_title INTO v_next1 FROM public.my_department_rollup() x WHERE x.department_id = d;
      IF v_next0 IS DISTINCT FROM ('S7RT U ' || tag) THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  T6 rollup: the fixture wasn''t this member''s next event before the cancel (%s)%s', coalesce(v_next0, 'none'), chr(10));
      ELSIF v_next1 IS DISTINCT FROM ('S7RT U ' || tag) THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T6 my_department_rollup: the cancelled drill is no longer the next event' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T6 rollup still shows the cancelled drill as next' || chr(10); END IF;

      -- ---- T7 the guard: status is RPC-only; a cancelled row is locked
      v_ok := true; v_err := '';
      BEGIN UPDATE public.training_sessions SET status = 'scheduled' WHERE id = su; v_ok := false; v_err := v_err || ' owner-update:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'STATUS_LOCKED%' THEN v_ok := false; v_err := v_err || ' owner-update:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e1)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.training_sessions SET status = 'cancelled' WHERE id = sx;
        v_ok := false; v_err := v_err || ' auth-update:ACCEPTED'; EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; IF SQLERRM NOT LIKE 'STATUS_LOCKED%' THEN v_ok := false; v_err := v_err || ' auth-update:' || SQLERRM; END IF; END;
      BEGIN INSERT INTO public.training_sessions (department_id, title, "date", status) VALUES (d, 'born cancelled', v_today + 9, 'cancelled');
        v_ok := false; v_err := v_err || ' insert:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'STATUS_LOCKED%' THEN v_ok := false; v_err := v_err || ' insert:' || SQLERRM; END IF; END;
      BEGIN UPDATE public.training_sessions SET title = 'quietly renamed' WHERE id = su; v_ok := false; v_err := v_err || ' cancelled-edit:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'LOCKED_SESSION%' THEN v_ok := false; v_err := v_err || ' cancelled-edit:' || SQLERRM; END IF; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T7 raw status UPDATE (owner + authenticated) / cancelled INSERT -> STATUS_LOCKED; a cancelled row is locked' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T7 guard:%s%s', v_err, chr(10)); END IF;

      -- ---- T8 restore (#2 files, #1 approves)
      PERFORM set_config('request.jwt.claims', json_build_object('email', e2)::text, true);
      v_err := null;
      BEGIN v_res := public.request_session_change(su, 'restore', 'Storm passed — drill is back on', v_sig); r2 := (v_res->>'request_id')::uuid;
            PERFORM set_config('request.jwt.claims', json_build_object('email', e1)::text, true);
            v_res := public.approve_session_change(r2, v_sig);
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err IS NULL AND v_res->>'state' = 'approved' AND (SELECT status FROM public.training_sessions WHERE id = su) = 'scheduled'
         AND (SELECT count(*) FROM public.training_session_audit WHERE session_id = su) = 2
         AND EXISTS (SELECT 1 FROM public.training_session_audit a WHERE a.session_id = su AND a.action = 'restore' AND a.actor_id = m1
                       AND a.changes->'status'->>'new' = 'scheduled') THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T8 restore: #2 files, #1 approves -> scheduled + a restore log row' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T8 restore: %s %s%s', coalesce(v_err, ''), coalesce(v_res::text, ''), chr(10)); END IF;

      -- ---- T9 request refusals
      v_ok := true; v_err := '';
      FOR v_t, k IN SELECT * FROM (VALUES
          ('ATTENDED', sa::text || '|cancel|Attended drill cancel try|' || v_sig),
          ('FINALIZED', sf::text || '|cancel|Finalized drill cancel try|' || v_sig),
          ('NOT_UPCOMING', sp::text || '|cancel|Past drill cancel try here|' || v_sig),
          ('NOT_CANCELLED', su::text || '|restore|Restore a scheduled one|' || v_sig),
          ('BAD_KIND', su::text || '|reschedule|Rescheduling is not built|' || v_sig),
          ('REASON_REQUIRED', su::text || '|cancel|short|' || v_sig),
          ('BAD_SIGNATURE', su::text || '|cancel|Typed name, not drawn|Jane Doe'),
          ('BAD_SIGNATURE', su::text || '|cancel|An enormous drawing here|data:image/png;base64,' || repeat('Z', 210000))) z LOOP
        BEGIN PERFORM public.request_session_change(split_part(k, '|', 1)::uuid, split_part(k, '|', 2), split_part(k, '|', 3), split_part(k, '|', 4));
          v_ok := false; v_err := v_err || ' ' || v_t || ':ACCEPTED';
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE v_t || '%' THEN v_ok := false; v_err := v_err || ' ' || v_t || ':' || left(SQLERRM, 60); END IF; END;
      END LOOP;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T9 refusals: ATTENDED / FINALIZED / NOT_UPCOMING / NOT_CANCELLED / BAD_KIND / REASON_REQUIRED / BAD_SIGNATURE x2' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T9 refusals:%s%s', v_err, chr(10)); END IF;

      -- ---- T10 reject + withdraw
      v_ok := true; v_err := '';
      v_res := public.request_session_change(sx, 'cancel', 'Not enough instructors that night', v_sig); r3 := (v_res->>'request_id')::uuid;
      BEGIN PERFORM public.reject_session_change(r3, 'I asked for it myself'); v_ok := false; v_err := v_err || ' self-reject:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'USE_WITHDRAW%' THEN v_ok := false; v_err := v_err || ' self-reject:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e2)::text, true);
      BEGIN PERFORM public.reject_session_change(r3, 'no'); v_ok := false; v_err := v_err || ' short-reject:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'REASON_REQUIRED%' THEN v_ok := false; v_err := v_err || ' short-reject:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.withdraw_session_change(r3); v_ok := false; v_err := v_err || ' others-withdraw:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_YOURS%' THEN v_ok := false; v_err := v_err || ' others-withdraw:' || SQLERRM; END IF; END;
      PERFORM public.reject_session_change(r3, 'We found a second instructor');
      IF (SELECT state <> 'rejected' OR approver_id <> m2 FROM public.training_session_requests WHERE id = r3) THEN v_ok := false; v_err := v_err || ' reject-state'; END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e1)::text, true);
      v_res := public.request_session_change(sx, 'cancel', 'Asking again, then thinking better', v_sig); r3 := (v_res->>'request_id')::uuid;
      PERFORM public.withdraw_session_change(r3);
      IF (SELECT state FROM public.training_session_requests WHERE id = r3) <> 'withdrawn' THEN v_ok := false; v_err := v_err || ' withdraw-state'; END IF;
      IF (SELECT status FROM public.training_sessions WHERE id = sx) <> 'scheduled' OR EXISTS (SELECT 1 FROM public.training_session_audit WHERE session_id = sx) THEN
        v_ok := false; v_err := v_err || ' session-touched'; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T10 reject (another manager, reason) + withdraw (initiator only); the session untouched, nothing logged' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T10 reject/withdraw:%s%s', v_err, chr(10)); END IF;

      -- ---- T11 lazy expiry
      v_res := public.request_session_change(sx, 'cancel', 'This one will go stale first', v_sig); r3 := (v_res->>'request_id')::uuid;
      UPDATE public.training_sessions SET "date" = v_today - 1 WHERE id = sx;   -- an unattended scheduled drill: plain Edit may move it
      PERFORM set_config('request.jwt.claims', json_build_object('email', e2)::text, true);
      v_err := null; v_res := null;
      BEGIN v_res := public.approve_session_change(r3, v_sig); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err IS NULL AND v_res->>'state' = 'expired' AND (SELECT state FROM public.training_session_requests WHERE id = r3) = 'expired'
         AND (SELECT status FROM public.training_sessions WHERE id = sx) = 'scheduled' AND NOT EXISTS (SELECT 1 FROM public.training_session_audit WHERE session_id = sx) THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T11 a request past its drill date -> approve returns expired; nothing applied or logged' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T11 expiry: %s %s%s', coalesce(v_err, ''), coalesce(v_res::text, ''), chr(10)); END IF;

      -- ---- T12 role matrix
      PERFORM set_config('request.jwt.claims', json_build_object('email', e1)::text, true);
      v_res := public.request_session_change(su, 'cancel', 'Pending one for the role matrix', v_sig); r3 := (v_res->>'request_id')::uuid;
      v_ok := true; v_err := '';
      FOREACH k IN ARRAY array[e_off, e_board, e_pa, e_mem] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', k)::text, true);
        BEGIN PERFORM public.request_session_change(sx, 'cancel', 'A role that must be refused', v_sig); v_ok := false; v_err := v_err || ' request:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' request:' || SQLERRM; END IF; END;
        BEGIN PERFORM public.approve_session_change(r3, v_sig); v_ok := false; v_err := v_err || ' approve:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' approve:' || SQLERRM; END IF; END;
        BEGIN PERFORM public.reject_session_change(r3, 'A role that must be refused'); v_ok := false; v_err := v_err || ' reject:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' reject:' || SQLERRM; END IF; END;
        BEGIN PERFORM public.withdraw_session_change(r3); v_ok := false; v_err := v_err || ' withdraw:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' withdraw:' || SQLERRM; END IF; END;
      END LOOP;
      IF v_ok AND (SELECT state FROM public.training_session_requests WHERE id = r3) = 'pending' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T12 Officer-not-TO / Board / PA / Member refused on request / approve / reject / withdraw' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T12 role matrix:%s%s', v_err, chr(10)); END IF;

      -- ---- T13 another department
      SELECT ts.id INTO s_other FROM public.training_sessions ts WHERE ts.department_id <> d ORDER BY ts.id LIMIT 1;
      IF s_other IS NULL THEN v_skip := v_skip + 1; rpt := rpt || '   SKIP  T13 no other department to try' || chr(10);
      ELSE
        INSERT INTO public.training_session_requests (department_id, session_id, kind, reason, initiator_id, initiator_name, initiator_signature)
        SELECT ts.department_id, ts.id, 'cancel', 'Another department request', gen_random_uuid(), 'Someone else', v_sig FROM public.training_sessions ts WHERE ts.id = s_other
        ON CONFLICT DO NOTHING RETURNING id INTO r_other;
        PERFORM set_config('request.jwt.claims', json_build_object('email', e2)::text, true);
        v_ok := true;
        BEGIN PERFORM public.request_session_change(s_other, 'cancel', 'Another department — must be refused', v_sig); v_ok := false;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; END IF; END;
        IF r_other IS NOT NULL THEN
          BEGIN PERFORM public.approve_session_change(r_other, v_sig); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; END IF; END;
          BEGIN PERFORM public.session_change_signatures(r_other); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; END IF; END;
        END IF;
        IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T13 another department''s session / request / signatures -> NOT_FOUND' || chr(10);
        ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T13 a foreign session/request was not refused' || chr(10); END IF;
      END IF;

      -- ---- T14 the requests table
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_board)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.training_session_requests WHERE session_id = su;
      SELECT count(*) INTO v_n2 FROM public.training_session_requests WHERE department_id <> d;
      EXECUTE 'RESET ROLE';
      IF v_n < 3 OR v_n2 <> 0 THEN v_ok := false; v_err := v_err || format(' board %s/%s', v_n, v_n2); END IF;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM initiator_signature FROM public.training_session_requests WHERE session_id = su;
        v_ok := false; v_err := v_err || ' signature-selectable'; EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      v_res := public.session_change_signatures(r1);
      IF v_res->>'initiator_signature' IS NULL OR v_res->>'approver_signature' IS NULL THEN v_ok := false; v_err := v_err || ' rpc-signatures'; END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_to2)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.training_session_requests WHERE session_id = su;
      EXECUTE 'RESET ROLE';
      IF v_n < 3 THEN v_ok := false; v_err := v_err || format(' plain-member-TO %s', v_n); END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.training_session_requests;
      EXECUTE 'RESET ROLE';
      IF v_n <> 0 THEN v_ok := false; v_err := v_err || format(' member %s', v_n); END IF;
      BEGIN PERFORM public.session_change_signatures(r1); v_ok := false; v_err := v_err || ' member-rpc';
      EXCEPTION WHEN OTHERS THEN NULL; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e1)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.training_session_requests (department_id, session_id, kind, reason, initiator_id, initiator_name, initiator_signature)
        VALUES (d, sx, 'cancel', 'forged straight into the table', m1, 'forger', v_sig);
        v_ok := false; v_err := v_err || ' insert'; EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T14 requests: Board + plain-Member TO read (own dept only); Member none; signatures RPC-only; no INSERT' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T14 requests table:%s%s', v_err, chr(10)); END IF;

      -- ---- T15 station_presence untouched; verified unchanged
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T15 station_presence byte-identical across every RPC call; verified count %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T15 station_presence changed (verified %s -> %s)%s', v_ver_before, v_ver_after, chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
