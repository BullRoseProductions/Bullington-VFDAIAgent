-- =====================================================================
-- RETEST for training_slice6_corrections (Slice 6-DB). READ-ONLY IN EFFECT — run AFTER the migration, separately.
--
-- Every fixture and every write lives inside a per-department sub-block that ends in RAISE 'SENTINEL' (rolled back);
-- the whole block ends in a RAISE that IS the report. NOTHING CHANGES. The "ERROR" is the report.
--
-- Once:
--   O1 anon can't EXECUTE any new function; authenticated can EXECUTE the 4 RPCs and NOT the 3 internal functions
--   O2 training_session_audit: RLS on, exactly one policy (SELECT); authenticated SELECT only; anon nothing
--   O3 the training_sessions UPDATE policy carries done IS NOT TRUE (CHECK unchanged); the guard trigger exists
--   O4 the C1/C2 hours readers are byte-identical to their pins (attested_training, dept_station_shifts, dept_iso_hours,
--      dept_iso_hours_for, dept_iso_hours_by_station, dept_member_iso_hours_by_month)
-- Per department, on FIXTURES (members a1..a3, personas, five sessions S1..S5, a category P) — a REAL active training
-- officer is used where one exists (else a fixture one), a real DA where one exists:
--   T1  TO corrects a finalized, attended drill (title + date) -> one audit row, old->new right, actor right, roll intact
--   T2  TO corrects the roll (+a3, -a2) -> attested_training follows (a3 in, a2 out); roster_before/after right
--   T3  blank reason -> REASON_REQUIRED, nothing written       T4  no-op -> NO_CHANGE       T5 unknown key -> UNKNOWN_FIELD
--   T6  an unlocked session -> NOT_LOCKED
--   T7  a date outside an attendee's membership window -> MEMBERSHIP_WINDOW, nothing written (date + log unchanged)
--   T8  C1 hybrid: TO on a 30-day-old drill -> DA_ONLY; TO moving a recent drill 20 days back -> DA_ONLY; DA -> allowed
--   T8b a Project Admin who is ALSO a training officer -> DA_ONLY on a 30-day drill, correct and reopen (D1: never PA)
--   T9  direct UPDATE (as authenticated TO) of a finalized session -> 0 rows (policy), unchanged
--   T10 direct date UPDATE (as authenticated TO) of an attended, not-finalized session -> LOCKED_SESSION
--   T11 today's client finalize (direct UPDATE done + first length, as authenticated TO) still works; sign-in fields
--       (signin_open/token) still writable on an attended session
--   T12 finalize RPC: done + length + one 'finalize' row; category last_iso = greatest(existing, drill date);
--       a different length than recorded -> USE_CORRECT; an empty roll leaves last_iso alone
--   T13 reopen: no reason -> REASON_REQUIRED; with -> done=false + 'reopen' row with the roll snapshot; then a direct
--       roster change (as authenticated TO) + finalize RPC -> the 'finalize' row lists exactly who was added/removed
--   T14 Officer-not-TO / Board / PA / Member refused on every RPC (correct, reopen, finalize, drill_window_presence)
--   T15 another department's session id -> NOT_FOUND (no write)
--   T16 the audit table: authenticated INSERT/UPDATE/DELETE refused; Board (leadership) reads this department's rows
--       only; a Member reads none; the owner can't UPDATE/DELETE either (append-only trigger)
--   T17 drill_window_presence: a standby overlapping the window is returned (with on_roll), one outside is not
--   T18 the correction flag does not leak: after an RPC, a direct protected-field update on an attended row -> LOCKED
--   T19 station_presence for the department is byte-identical before/after every RPC call; verified count unchanged
-- =====================================================================
DO $retest$
DECLARE
  rec record; k text; v text; v_err text; v_res jsonb; v_n int; v_n2 int; v_ok boolean;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_pins constant jsonb := jsonb_build_object(
    'public.attested_training(uuid,timestamptz,timestamptz)',              'aff25333771cd38c1f473bcde5e1e96e',
    'public.dept_station_shifts(timestamptz,timestamptz)',                 '894bbaa8f37ca95da454dd075aab1d41',
    'public.dept_iso_hours(timestamptz,timestamptz)',                      '306fa11b6473fefa9c737c3a59bfe826',
    'public.dept_iso_hours_for(uuid,timestamptz,timestamptz)',             '91ceb031497e2e70d64f07540f7bd0a9',
    'public.dept_iso_hours_by_station(timestamptz,timestamptz)',           '5a895ed77425f86287ac9b9afa1dbf5e',
    'public.dept_member_iso_hours_by_month(uuid,timestamptz[],timestamptz[])', 'cb10fc24fcf25d0e919ead5299e71dcc');
  v_rpcs constant text[] := array['public.correct_training_session(uuid,jsonb,uuid[],uuid[],text)', 'public.reopen_training_session(uuid,text)',
                                  'public.finalize_training_session(uuid,integer)', 'public.drill_window_presence(uuid)'];
  v_internal constant text[] := array['public.recompute_training_plan_last_iso(uuid)', 'public.tg_training_session_lock_guard()',
                                      'public.tg_training_session_audit_append_only()'];
  -- per-department
  d uuid; dn text; tag text;
  e_to text; e_da text; e_off text; e_board text; e_pa text; e_mem text; to_real boolean; da_real boolean;
  m_to uuid; a1 uuid; a2 uuid; a3 uuid; p uuid; p2 uuid; v_res_member uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s_other uuid;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint;
  v_date date; v_title text; v_iso date;
BEGIN
  -- ---------------------------------------------------------------- once
  v_ok := true;
  FOREACH k IN ARRAY v_rpcs || v_internal LOOP
    IF to_regprocedure(k) IS NULL OR has_function_privilege('anon', k, 'EXECUTE') THEN v_ok := false; END IF;
  END LOOP;
  FOREACH k IN ARRAY v_rpcs LOOP IF NOT has_function_privilege('authenticated', k, 'EXECUTE') THEN v_ok := false; END IF; END LOOP;
  FOREACH k IN ARRAY v_internal LOOP IF has_function_privilege('authenticated', k, 'EXECUTE') THEN v_ok := false; END IF; END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 privileges: anon none; authenticated = the 4 RPCs only' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 function privileges wrong (or a function is missing)' || chr(10); END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.training_session_audit'::regclass)
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_audit') = 1
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_audit' AND cmd = 'SELECT')
     AND has_table_privilege('authenticated', 'public.training_session_audit', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.training_session_audit', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.training_session_audit', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.training_session_audit', 'DELETE')
     AND NOT has_table_privilege('authenticated', 'public.training_session_audit', 'TRUNCATE')
     AND NOT has_table_privilege('anon', 'public.training_session_audit', 'SELECT') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 audit table: RLS, one SELECT policy, authenticated SELECT only, anon nothing' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 audit table RLS/policy/grants wrong' || chr(10); END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_sessions' AND policyname = 'leaders update training_sessions'
               AND qual = '((department_id = my_department_id()) AND is_training_manager() AND (done IS NOT TRUE))'
               AND with_check = '((department_id = my_department_id()) AND is_training_manager())')
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.training_sessions'::regclass AND tgname = 'training_session_lock_guard' AND tgenabled = 'O') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 UPDATE policy has done IS NOT TRUE (CHECK unchanged); guard trigger enabled' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 UPDATE policy / guard trigger not as intended' || chr(10); END IF;

  v_ok := true; v_err := '';
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF to_regprocedure(k) IS NULL OR md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN v_ok := false; v_err := v_err || ' ' || k; END IF;
  END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O4 the 6 hours readers are byte-identical to their pins' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O4 hours reader(s) changed:' || v_err || chr(10); END IF;

  -- ---------------------------------------------------------------- per department
  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; dn := rec.name; tag := 's6rt-' || left(replace(d::text, '-', ''), 8);
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      -- personas: a real active TO / DA where one exists (unique email), else fixtures
      SELECT lower(m.email), m.id INTO e_to, m_to FROM public.training_officer t JOIN public.members m ON m.id = t.member_id
       WHERE t.department_id = d AND t.removed_at IS NULL AND m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
         AND NOT m.access && array['Department Admin']::text[]
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      to_real := e_to IS NOT NULL;
      IF NOT to_real THEN
        e_to := tag || '-to@retest.invalid';
        INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST TO', e_to, '{Member}', 'Active') RETURNING id INTO m_to;
        INSERT INTO public.training_officer (department_id, member_id) VALUES (d, m_to);
      END IF;
      SELECT lower(m.email) INTO e_da FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary')
         AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      da_real := e_da IS NOT NULL;
      IF NOT da_real THEN
        e_da := tag || '-da@retest.invalid';
        INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST DA', e_da, '{Department Admin}', 'Active');
      END IF;
      e_off := tag || '-off@retest.invalid'; e_board := tag || '-board@retest.invalid'; e_pa := tag || '-pa@retest.invalid'; e_mem := tag || '-mem@retest.invalid';
      INSERT INTO public.members (department_id, name, email, access, status) VALUES
        (d, 'RETEST Officer', e_off, '{Officer}', 'Active'), (d, 'RETEST Board', e_board, '{Board Member}', 'Active'),
        (d, 'RETEST PA', e_pa, '{Project Admin}', 'Active'), (d, 'RETEST Member', e_mem, '{Member}', 'Active');
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST A1', tag || '-a1@retest.invalid', '{Member}', 'Active') RETURNING id INTO a1;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST A2', tag || '-a2@retest.invalid', '{Member}', 'Active') RETURNING id INTO a2;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST A3', tag || '-a3@retest.invalid', '{Member}', 'Active') RETURNING id INTO a3;
      INSERT INTO public.training_plans (department_id, name, cadence, last_iso) VALUES (d, 'RETEST category', 'Monthly', v_today - 60) RETURNING id INTO p;
      INSERT INTO public.training_plans (department_id, name, cadence, last_iso) VALUES (d, 'RETEST category 2', 'Monthly', v_today - 60) RETURNING id INTO p2;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min, done) VALUES (d, 'RETEST S1', v_today - 3, '19:00', 120, true) RETURNING id INTO s1;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min, done) VALUES (d, 'RETEST S2', v_today - 30, '19:00', 120, true) RETURNING id INTO s2;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min, done) VALUES (d, 'RETEST S3', v_today - 1, '18:00', null, false) RETURNING id INTO s3;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min, done, plan_id) VALUES (d, 'RETEST S4', v_today, '18:00', 60, false, p2) RETURNING id INTO s4;
      INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min, done, plan_id) VALUES (d, 'RETEST S5', v_today - 2, '18:00', null, false, p) RETURNING id INTO s5;
      INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES
        (d, s1, a1, now()), (d, s1, a2, now()), (d, s2, a1, now()), (d, s3, a1, now()), (d, s5, a1, now());
      -- T17 fixtures: a3 on standby across S1's window (as corrected in T1: today-4 19:00 Central), a2 the day before
      INSERT INTO public.station_presence (department_id, member_id, kind, source, verified, checked_in_at, checked_out_at)
      VALUES (d, a3, 'standby', 'geo', false, ((v_today - 4) + time '18:30') AT TIME ZONE 'America/Chicago', ((v_today - 4) + time '20:00') AT TIME ZONE 'America/Chicago'),
             (d, a2, 'standby', 'geo', false, ((v_today - 5) + time '18:30') AT TIME ZONE 'America/Chicago', ((v_today - 5) + time '20:00') AT TIME ZONE 'America/Chicago');
      SELECT md5(coalesce(string_agg(to_jsonb(sp)::text, '|' ORDER BY sp.id), '')) INTO v_sp_before FROM public.station_presence sp WHERE sp.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      rpt := rpt || format('   (acting as a %s training officer, a %s DA)%s', CASE WHEN to_real THEN 'REAL' ELSE 'fixture' END, CASE WHEN da_real THEN 'real' ELSE 'fixture' END, chr(10));

      -- ---- T1 TO corrects title + date of finalized, attended S1
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_to)::text, true);
      v_err := null;
      BEGIN v_res := public.correct_training_session(s1, jsonb_build_object('title', 'RETEST S1 corrected', 'date', v_today - 4), null, null, 'Wrong night on the QR — moved to the real drill');
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      SELECT count(*) INTO v_n FROM public.session_attendance WHERE session_id = s1 AND member_id IN (a1, a2);
      IF v_err IS NULL AND (SELECT title = 'RETEST S1 corrected' AND "date" = v_today - 4 FROM public.training_sessions WHERE id = s1)
         AND (SELECT count(*) FROM public.training_session_audit WHERE session_id = s1) = 1
         AND EXISTS (SELECT 1 FROM public.training_session_audit a WHERE a.session_id = s1 AND a.action = 'correct' AND a.actor_id = m_to
                       AND a.changes->'date'->>'old' = (v_today - 3)::text AND a.changes->'date'->>'new' = (v_today - 4)::text
                       AND a.changes->'title'->>'old' = 'RETEST S1' AND a.roster_before = 2 AND a.roster_after = 2 AND length(a.reason) >= 10)
         AND v_n = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T1 correct (title+date): one audit row, old->new + actor right, roll intact' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 correct: %s%s', coalesce(v_err, 'state/log wrong'), chr(10)); END IF;

      -- ---- T2 roster delta moves attested_training
      v_err := null;
      BEGIN v_res := public.correct_training_session(s1, null, array[a3], array[a2], 'A3 was there, A2 was not — fixing the roll');
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err IS NULL
         AND EXISTS (SELECT 1 FROM public.attested_training(d, now() - interval '60 days', now() + interval '1 day') t WHERE t.session_id = s1 AND t.member_id = a3)
         AND NOT EXISTS (SELECT 1 FROM public.attested_training(d, now() - interval '60 days', now() + interval '1 day') t WHERE t.session_id = s1 AND t.member_id = a2)
         AND EXISTS (SELECT 1 FROM public.training_session_audit a WHERE a.session_id = s1 AND a.roster_added = array[a3] AND a.roster_removed = array[a2]
                       AND a.roster_before = 2 AND a.roster_after = 2 AND a.changes = '{}'::jsonb) THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 roster correction (+a3 −a2): attested_training follows; log right' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 roster correction: %s%s', coalesce(v_err, 'attested/log wrong'), chr(10)); END IF;

      -- ---- T3 / T4 / T5 / T6 refusals, nothing written
      SELECT count(*) INTO v_n FROM public.training_session_audit WHERE department_id = d;
      v_err := null; BEGIN PERFORM public.correct_training_session(s1, '{"title":"x y z"}', null, null, '  short  '); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'REASON_REQUIRED%' THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T3 short reason -> REASON_REQUIRED' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 short reason: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;
      v_err := null; BEGIN PERFORM public.correct_training_session(s1, '{"title":"RETEST S1 corrected"}', null, null, 'Nothing actually changes here'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'NO_CHANGE%' THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T4 no-op -> NO_CHANGE' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 no-op: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;
      v_err := null; BEGIN PERFORM public.correct_training_session(s1, '{"signin_open":true,"done":false}', null, null, 'Trying a field that is not allowed'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'UNKNOWN_FIELD%' THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T5 unknown keys (done, signin_open) -> UNKNOWN_FIELD' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 unknown keys: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;
      v_err := null; BEGIN PERFORM public.correct_training_session(s4, '{"title":"S4 renamed"}', null, null, 'An unlocked session needs no correction'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      SELECT count(*) INTO v_n2 FROM public.training_session_audit WHERE department_id = d;
      IF v_err LIKE 'NOT_LOCKED%' AND v_n2 = v_n THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T6 unlocked session -> NOT_LOCKED (and T3–T6 wrote nothing)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T6 unlocked: %s (log %s -> %s)%s', coalesce(v_err, 'ACCEPTED'), v_n, v_n2, chr(10)); END IF;

      -- ---- T7 membership window: a1 joined 2 days before S1's corrected date; moving S1 earlier than that is refused
      INSERT INTO public.member_private (member_id, department_id, joined_date) VALUES (a1, d, v_today - 6)
        ON CONFLICT (member_id) DO UPDATE SET joined_date = excluded.joined_date;
      v_err := null; BEGIN PERFORM public.correct_training_session(s1, jsonb_build_object('date', v_today - 8), null, null, 'Moving it before A1 joined — must fail'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      SELECT count(*) INTO v_n2 FROM public.training_session_audit WHERE department_id = d;
      IF v_err LIKE 'MEMBERSHIP_WINDOW%' AND (SELECT "date" FROM public.training_sessions WHERE id = s1) = v_today - 4 AND v_n2 = v_n THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T7 date outside an attendee''s window -> MEMBERSHIP_WINDOW; date + log unchanged' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T7 window: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;

      -- ---- T8 C1 hybrid
      v_err := null; BEGIN PERFORM public.correct_training_session(s2, '{"title":"S2 renamed by TO"}', null, null, 'Thirty days old — TO should be refused'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_title := v_err;
      v_err := null; BEGIN PERFORM public.correct_training_session(s1, jsonb_build_object('date', v_today - 20), null, null, 'Moving a recent drill far back — DA only'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      v_res := null;
      BEGIN v_res := public.correct_training_session(s2, '{"title":"S2 renamed by DA"}', null, null, 'Old drill fixed by the Department Admin'); EXCEPTION WHEN OTHERS THEN v_res := jsonb_build_object('err', SQLERRM); END;
      IF v_title LIKE 'DA_ONLY%' AND v_err LIKE 'DA_ONLY%' AND v_res ? 'audit_id' AND (SELECT title FROM public.training_sessions WHERE id = s2) = 'S2 renamed by DA' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T8 hybrid: TO refused on a 30-day drill and on a 20-day move back; DA allowed' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T8 hybrid: TO-old=%s TO-move=%s DA=%s%s', coalesce(v_title, 'ACCEPTED'), coalesce(v_err, 'ACCEPTED'), v_res, chr(10)); END IF;
      -- ---- T8b a Project Admin who is ALSO a training officer: a training manager, but never "DA" for old drills (D1)
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST PA+TO', tag || '-pato@retest.invalid', '{Project Admin}', 'Active') RETURNING id INTO v_res_member;
      INSERT INTO public.training_officer (department_id, member_id) VALUES (d, v_res_member);
      PERFORM set_config('request.jwt.claims', json_build_object('email', tag || '-pato@retest.invalid')::text, true);
      v_err := null; BEGIN PERFORM public.correct_training_session(s2, '{"title":"S2 renamed by PA"}', null, null, 'A Project Admin rewriting an old drill'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_title := v_err;
      v_err := null; BEGIN PERFORM public.reopen_training_session(s2, 'A Project Admin reopening an old drill'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_title LIKE 'DA_ONLY%' AND v_err LIKE 'DA_ONLY%' AND (SELECT title FROM public.training_sessions WHERE id = s2) = 'S2 renamed by DA' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T8b a Project Admin who is a training officer -> DA_ONLY on a 30-day drill (correct + reopen)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T8b PA+TO on an old drill: correct=%s reopen=%s%s', coalesce(v_title, 'ACCEPTED'), coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_to)::text, true);

      -- ---- T9 direct UPDATE of a finalized session, as the authenticated TO -> 0 rows
      v_err := null;
      BEGIN
        EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.training_sessions SET title = 'direct rewrite' WHERE id = s1;
        GET DIAGNOSTICS v_n2 = ROW_COUNT;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; EXECUTE 'RESET ROLE'; END;
      IF v_err IS NULL AND v_n2 = 0 AND (SELECT title FROM public.training_sessions WHERE id = s1) = 'RETEST S1 corrected' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T9 direct UPDATE of a finalized session -> 0 rows (policy), unchanged' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T9 direct UPDATE of finalized: %s rows, %s%s', v_n2, coalesce(v_err, ''), chr(10)); END IF;

      -- ---- T10 direct date UPDATE of an attended, not-finalized session -> LOCKED_SESSION
      v_err := null;
      BEGIN
        EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.training_sessions SET "date" = v_today - 2 WHERE id = s3;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; EXECUTE 'RESET ROLE'; END;
      IF v_err LIKE 'LOCKED_SESSION%' AND (SELECT "date" FROM public.training_sessions WHERE id = s3) = v_today - 1 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T10 direct date UPDATE of an attended, open session -> LOCKED_SESSION' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T10 attended date UPDATE: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;

      -- ---- T11 today's client finalize (done + first length) and sign-in fields still work on attended rows
      v_err := null;
      BEGIN
        EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.training_sessions SET signin_open = true, signin_token = 'RT1234' WHERE id = s5;
        UPDATE public.training_sessions SET signin_open = false, signin_token = null WHERE id = s5;
        UPDATE public.training_sessions SET done = true, duration_min = 90 WHERE id = s3;
        GET DIAGNOSTICS v_n2 = ROW_COUNT;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; EXECUTE 'RESET ROLE'; END;
      IF v_err IS NULL AND v_n2 = 1 AND (SELECT done AND duration_min = 90 FROM public.training_sessions WHERE id = s3) THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T11 client finalize (done + first length) and sign-in open/close still work on attended rows' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T11 client finalize / sign-in: %s%s', coalesce(v_err, v_n2 || ' rows'), chr(10)); END IF;

      -- ---- T12 finalize RPC
      v_err := null; v_res := null;
      BEGIN v_res := public.finalize_training_session(s5, 75); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      SELECT last_iso INTO v_iso FROM public.training_plans WHERE id = p;
      IF v_err IS NULL AND (SELECT done AND duration_min = 75 FROM public.training_sessions WHERE id = s5)
         AND (SELECT count(*) FROM public.training_session_audit a WHERE a.session_id = s5 AND a.action = 'finalize' AND a.changes->'duration_min'->>'new' = '75') = 1
         AND v_iso = v_today - 2 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T12 finalize RPC: done + first length + one finalize row; last_iso -> the drill''s date' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T12 finalize: %s (last_iso %s)%s', coalesce(v_err, 'state/log wrong'), v_iso, chr(10)); END IF;
      v_err := null; BEGIN PERFORM public.finalize_training_session(s4, 45); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_title := v_err;
      v_err := null; BEGIN PERFORM public.finalize_training_session(s4, null); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_title LIKE 'USE_CORRECT%' AND v_err IS NULL AND (SELECT last_iso FROM public.training_plans WHERE id = p2) = v_today - 60 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T12b a different length -> USE_CORRECT; an empty-roll finalize leaves last_iso alone' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T12b: length=%s empty=%s%s', coalesce(v_title, 'ACCEPTED'), coalesce(v_err, 'ok'), chr(10)); END IF;

      -- ---- T13 reopen -> direct roster change -> finalize logs the delta
      v_err := null; BEGIN PERFORM public.reopen_training_session(s5, 'nope'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_title := v_err; v_err := null;
      BEGIN PERFORM public.reopen_training_session(s5, 'Two members were missed off the roll'); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_ok := v_title LIKE 'REASON_REQUIRED%' AND v_err IS NULL AND NOT (SELECT done FROM public.training_sessions WHERE id = s5)
              AND EXISTS (SELECT 1 FROM public.training_session_audit a WHERE a.session_id = s5 AND a.action = 'reopen' AND a.roster_snapshot = array[a1]);
      BEGIN
        EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (d, s5, a2, now());
        DELETE FROM public.session_attendance WHERE session_id = s5 AND member_id = a1;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; EXECUTE 'RESET ROLE'; END;
      BEGIN PERFORM public.finalize_training_session(s5, null); EXCEPTION WHEN OTHERS THEN v_err := coalesce(v_err, SQLERRM); END;
      IF v_ok AND v_err IS NULL AND EXISTS (SELECT 1 FROM public.training_session_audit a WHERE a.session_id = s5 AND a.action = 'finalize'
                                             AND a.roster_added = array[a2] AND a.roster_removed = array[a1] AND a.roster_before = 1 AND a.roster_after = 1
                                             AND a.seq = (SELECT max(seq) FROM public.training_session_audit WHERE session_id = s5)) THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T13 reopen needs a reason; logs the roll; the next finalize logs +a2 −a1 made while open' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T13 reopen/finalize roster: reason-check=%s %s%s', coalesce(v_title, 'ACCEPTED'), coalesce(v_err, 'log wrong'), chr(10)); END IF;

      -- ---- T14 role matrix: every RPC refused for Officer-not-TO / Board / PA / Member
      v_ok := true; v_err := '';
      FOREACH k IN ARRAY array[e_off, e_board, e_pa, e_mem] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', k)::text, true);
        BEGIN PERFORM public.correct_training_session(s1, '{"title":"role test"}', null, null, 'A role that must be refused'); v_ok := false; v_err := v_err || ' correct:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' correct:' || SQLERRM; END IF; END;
        BEGIN PERFORM public.reopen_training_session(s1, 'A role that must be refused'); v_ok := false; v_err := v_err || ' reopen:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' reopen:' || SQLERRM; END IF; END;
        BEGIN PERFORM public.finalize_training_session(s4, null); v_ok := false; v_err := v_err || ' finalize:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' finalize:' || SQLERRM; END IF; END;
        BEGIN PERFORM * FROM public.drill_window_presence(s1); v_ok := false; v_err := v_err || ' presence:' || k;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'Only a training officer%' THEN v_ok := false; v_err := v_err || ' presence:' || SQLERRM; END IF; END;
      END LOOP;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T14 Officer-not-TO / Board / PA / Member refused on all 4 RPCs' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T14 role matrix:%s%s', v_err, chr(10)); END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_to)::text, true);

      -- ---- T15 another department's session
      SELECT ts.id INTO s_other FROM public.training_sessions ts WHERE ts.department_id <> d ORDER BY ts.id LIMIT 1;
      IF s_other IS NULL THEN v_skip := v_skip + 1; rpt := rpt || '   SKIP  T15 no other department''s session to try' || chr(10);
      ELSE
        v_ok := true;
        BEGIN PERFORM public.correct_training_session(s_other, '{"title":"cross-dept"}', null, null, 'Another department — must be refused'); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; END IF; END;
        BEGIN PERFORM public.reopen_training_session(s_other, 'Another department — must be refused'); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; END IF; END;
        BEGIN PERFORM public.finalize_training_session(s_other, null); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; END IF; END;
        BEGIN PERFORM * FROM public.drill_window_presence(s_other); v_ok := false; EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; END IF; END;
        IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T15 another department''s session -> NOT_FOUND on all 4 RPCs' || chr(10);
        ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T15 a foreign session was not refused as NOT_FOUND' || chr(10); END IF;
      END IF;

      -- ---- T16 the audit table: no write path; leadership reads own department only; owner can't change it
      v_ok := true; v_err := '';
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.training_session_audit (department_id, session_id, action, actor_id, actor_name, reason, roster_before, roster_after)
        VALUES (d, s1, 'correct', m_to, 'forger', 'forged entry, should fail', 0, 0);
        v_ok := false; v_err := v_err || ' insert'; EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated'; UPDATE public.training_session_audit SET reason = 'rewritten history' WHERE session_id = s1;
        v_ok := false; v_err := v_err || ' update'; EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated'; DELETE FROM public.training_session_audit WHERE session_id = s1;
        v_ok := false; v_err := v_err || ' delete'; EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      BEGIN UPDATE public.training_session_audit SET reason = 'owner rewrite attempt' WHERE session_id = s1; v_ok := false; v_err := v_err || ' owner-update';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'AUDIT_APPEND_ONLY%' THEN v_ok := false; v_err := v_err || ' owner-update:' || SQLERRM; END IF; END;
      BEGIN DELETE FROM public.training_session_audit WHERE session_id = s1; v_ok := false; v_err := v_err || ' owner-delete';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'AUDIT_APPEND_ONLY%' THEN v_ok := false; v_err := v_err || ' owner-delete:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_board)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.training_session_audit WHERE session_id = s1;
      SELECT count(*) INTO v_n2 FROM public.training_session_audit WHERE department_id <> d;
      EXECUTE 'RESET ROLE';
      IF v_n < 2 OR v_n2 <> 0 THEN v_ok := false; v_err := v_err || format(' board-read %s/%s', v_n, v_n2); END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.training_session_audit;
      EXECUTE 'RESET ROLE';
      IF v_n <> 0 THEN v_ok := false; v_err := v_err || format(' member-read %s', v_n); END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_to)::text, true);
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T16 audit: no INSERT/UPDATE/DELETE for authenticated; owner append-only; Board reads own dept only; Member none' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T16 audit table:%s%s', v_err, chr(10)); END IF;

      -- ---- T17 drill_window_presence (S1 now today-4 19:00, 120 min)
      v_err := null;
      BEGIN
        SELECT count(*) FILTER (WHERE w.member_id = a3 AND w.on_roll), count(*) FILTER (WHERE w.member_id = a2) INTO v_n, v_n2
          FROM public.drill_window_presence(s1) w;
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err IS NULL AND v_n = 1 AND v_n2 = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T17 drill_window_presence: the overlapping standby (a3, on the roll) in; the day-before one (a2) out' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T17 presence: in=%s out=%s %s%s', v_n, v_n2, coalesce(v_err, ''), chr(10)); END IF;

      -- ---- T18 the flag doesn't leak past an RPC
      v_err := null;
      BEGIN UPDATE public.training_sessions SET title = 'owner, no flag' WHERE id = s1; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err LIKE 'LOCKED_SESSION%' AND coalesce(current_setting('b4c.session_correction', true), '') = '' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T18 flag reset after the RPCs: even the owner hits LOCKED_SESSION on a protected field' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T18 flag leak: %s%s', coalesce(v_err, 'ACCEPTED'), chr(10)); END IF;

      -- ---- T19 station_presence untouched by every RPC above; verified count unchanged
      SELECT md5(coalesce(string_agg(to_jsonb(sp)::text, '|' ORDER BY sp.id), '')) INTO v_sp_after FROM public.station_presence sp WHERE sp.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T19 station_presence byte-identical across all RPC calls; verified count %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T19 station_presence changed (verified %s -> %s)%s', v_ver_before, v_ver_after, chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
