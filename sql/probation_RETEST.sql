-- =====================================================================
-- RETEST for probation_2026-10-18.sql (Phase 3.1 #2). RAN on live 2026-10-18 (first run): 53 passed, 3 failed, 7 skipped —
-- the 3 FAILs were all T1, a TEST bug: it hard-coded 2 -> 3 nights but training nights are all-time and live members
-- have real attendance (IH 5, Lipan 1, NH 6). The live deltas were exactly +2 then +1 (the future night never counted),
-- so the function was right. T1 now measures the member's real count first and expects +2 / +1.
-- RAN on live 2026-10-18 (second run, fixed T1): 56 passed, 0 failed, 7 skipped — IH / Lipan / North Hood all pass
-- (T1 5+2->7->8, 1+2->3->4, 6+2->8->9); skips: Demo + Granbury (no plain members), S2 x3 (no pure Project Admin),
-- B2 in IH + Lipan (no Board Member with a unique email). Run AFTER the migration, separately. NOTHING CHANGES: each department's checks
-- run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on FIXTURE items / a fixture document / fixture
-- statuses it sets itself. The final RAISE is the report. The "ERROR" IS the report.
-- Per department (needs a DA and two plain members with unique emails; an Officer and another department's DA are
-- used when present, else that check SKIPs). Member A is made Probationary for the run.
--   P0 (once) anon can't execute any public RPC; members can't execute the internal helpers
--   G1 no item marked clears_to_run -> "Gate not configured": configured false, cleared false, never ready
--   S1 the DA sets A's start (40 days ago) -> day 41, milestone due dates = start + 30/60/90/180; a future date refused;
--      a member and an Officer refused (DA only); the DA can't set their own
--   C1 custody: A can't sign / log for themself (member gate; logging is DA/Officer only) and the DA can't sign their own review
--   W1 a member's direct INSERT on each new table is refused
--   K1 ack item: needs_signature (not satisfied, gate 0) -> A signs the fixture document -> signed_current (Level 1)
--   K2 manual gate item: open -> the DA signs it (set_onboarding_item, unchanged) -> signed; gate cleared
--   K3 hours item (supervised, target 2): 1.5 logged -> in_progress (have 1.5) -> +1 -> met; supervisor = the member
--      refused; a future date refused
--   K4 cert item: an expired and an undated cert don't count (missing); a dated unexpired one does (current)
--   L1 a legacy done tick with no checked_by reads done_unrecorded (and counts)
--   R1 three reviews done -> not ready; the final done -> ready_for_vote; reviews refused for a non-probationary member
--   B1 board (as the DA): A listed + ready; a former probationary member (member_separation) and a Project Admin are
--      not listed; the count equals an independent count; a member is refused the board
--   V1 visibility: B sees none of A's rows in the three tables and can't read A's status; A reads only their own
--   X1 another department's DA: can't set A's start / sign A's review / log for A / read A's status; their board has no A
--   O1 an Officer signs a review and logs a session (is_canmanage), but can't set a start (DA only)
--   K5 ack edge states: outside the document's audience -> not_required (satisfied); a broken link -> not_configured
--   T1 training_nights counts sessions attended all-time, up to today (future never)
--   S2 a pure Project Admin can't set a start (a real Department Admin only — not the is_dept_admin() PA path)
--   B2 a Board Member can't log or void supervised time (operational: DA / Officer)
--   D1 void_supervised_session: member / other department / blank reason refused; the voided row stays and stops
--      counting (hours item and supervised_hours both drop); a second void refused. (P0 covers anon.)
--   D2 custody on the void: nobody voids a session logged for themself
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_e2 text; v_e3 text; v_n int; v_m int; v_k int; v_sess uuid; v_h0 numeric; v_h1 numeric; v_board text; v_pa_em text; v_js jsonb; v_ok boolean; v_hash text;
  v_da text; v_off text; v_a text; v_b text; v_other_da text; v_pa uuid;
  v_da_id uuid; v_a_id uuid; v_b_id uuid;
  v_doc uuid; v_series uuid; v_i_man uuid; v_i_ack uuid; v_i_hrs uuid; v_i_cert uuid; v_i_leg uuid;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_t text;
  SIG constant text := 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- P0 grants (once)
  v_ok := true;
  FOREACH v_t IN ARRAY array['public.set_member_probation(uuid,date,text)', 'public.set_probation_milestone(uuid,text,text,text)',
      'public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text)', 'public.void_supervised_session(uuid,text)', 'public.my_probation_status()',
      'public.member_probation_status(uuid)', 'public.dept_probation_board()'] LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN v_ok := false; END IF;
  END LOOP;
  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    BEGIN PERFORM public.probation_status(gen_random_uuid(), gen_random_uuid()); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    BEGIN PERFORM * FROM public.probation_item_states(gen_random_uuid(), gen_random_uuid()); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
    PERFORM set_config('role', 'anon', true);
    BEGIN PERFORM public.my_probation_status(); PERFORM public.void_supervised_session(gen_random_uuid(), 'x'); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
    PERFORM set_config('role', 'postgres', true);
  END;
  IF v_ok AND v_err ILIKE '%permission denied%' AND v_e2 ILIKE '%permission denied%' AND v_e3 ILIKE '%permission denied%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  P0 anon can''t execute the RPCs; members can''t execute the internal helpers%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  P0 grants ok %s; internal "%s" / "%s"; anon "%s"%s', v_ok, v_err, v_e2, v_e3, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_a := NULL; v_b := NULL; v_other_da := NULL; v_da_id := NULL; v_a_id := NULL; v_b_id := NULL; v_pa := NULL; v_board := NULL; v_pa_em := NULL;
    SELECT lower(m.email), m.id INTO v_da, v_da_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND NOT m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_board FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Board Member']::text[]
       AND NOT m.access && array['Department Admin','Project Admin','Officer']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_pa_em FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Project Admin']::text[]
       AND NOT m.access && array['Department Admin']::text[]
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_a, v_a_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IS DISTINCT FROM 'Inactive' AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_b, v_b_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.id IS DISTINCT FROM v_a_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IS DISTINCT FROM 'Inactive' AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_da FROM public.members m WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL OR v_b IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and two plain members with unique emails (DA %s, A %s, B %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), coalesce(v_b, 'none'), chr(10));
      CONTINUE;
    END IF;

    BEGIN
      -- ---------- fixtures (as the owner): A probationary; no existing item in the gate or the probation phase; no prior
      -- probation rows for A; one item of each kind
      UPDATE public.members SET status = 'Probationary' WHERE id = v_a_id;
      UPDATE public.onboarding_items SET clears_to_run = false, phase = 'onboarding' WHERE department_id = rec.dept_id;
      DELETE FROM public.member_probation WHERE member_id = v_a_id;
      DELETE FROM public.probation_milestones WHERE member_id = v_a_id;
      DELETE FROM public.supervised_sessions WHERE member_id = v_a_id;

      -- G1 gate not configured
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      IF (v_js->'gate'->>'configured')::boolean = false AND (v_js->>'cleared_to_run')::boolean = false AND (v_js->>'ready_for_vote')::boolean = false
         AND v_js->>'started_on' IS NULL AND v_js->>'day_n' IS NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  G1 no gate items -> not configured, not cleared, not ready; start not set -> no day count%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G1 %s%s', v_js - 'items' - 'milestones', chr(10)); END IF;

      INSERT INTO public.onboarding_items (department_id, category, label, sort_order, clears_to_run, phase, kind)
        VALUES (rec.dept_id, 'RETEST', 'RETEST manual gate item', 9001, true, 'onboarding', 'manual') RETURNING id INTO v_i_man;
      INSERT INTO public.documents (department_id, name, type, storage_path, content_text)
        VALUES (rec.dept_id, 'RETEST probation SOP', 'SOP', rec.dept_id || '/retest-' || gen_random_uuid() || '.pdf', 'Fixture text.')
        RETURNING id, series_id INTO v_doc, v_series;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.set_document_ack_config(v_doc, true, NULL, false);
      PERFORM set_config('role', 'postgres', true);
      INSERT INTO public.onboarding_items (department_id, category, label, sort_order, clears_to_run, phase, kind, ack_series_id)
        VALUES (rec.dept_id, 'RETEST', 'RETEST ack gate item', 9002, true, 'onboarding', 'ack', v_series) RETURNING id INTO v_i_ack;
      INSERT INTO public.onboarding_items (department_id, category, label, sort_order, phase, kind, hours_target, hours_source)
        VALUES (rec.dept_id, 'RETEST', 'RETEST hours item', 9003, 'probation', 'hours', 2, 'supervised') RETURNING id INTO v_i_hrs;
      INSERT INTO public.onboarding_items (department_id, category, label, sort_order, phase, kind, cert_name)
        VALUES (rec.dept_id, 'RETEST', 'RETEST cert item', 9004, 'probation', 'cert', '  Retest Cert ') RETURNING id INTO v_i_cert;
      INSERT INTO public.onboarding_items (department_id, category, label, sort_order, phase, kind)
        VALUES (rec.dept_id, 'RETEST', 'RETEST legacy item', 9005, 'probation', 'manual') RETURNING id INTO v_i_leg;

      -- S1 start date
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_member_probation(v_a_id, v_today - 40, NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.set_member_probation(v_a_id, v_today + 1, NULL); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      BEGIN PERFORM public.set_member_probation(v_da_id, v_today - 5, NULL); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM public.set_member_probation(v_a_id, v_today - 40, 'RETEST');
      v_js := public.member_probation_status(v_a_id);
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only a Department Admin%' AND v_e2 LIKE 'The probation start must be%' AND v_e3 LIKE 'You can''t set your own%'
         AND (v_js->>'day_n')::int = 41 AND (v_js->>'started_on')::date = v_today - 40
         AND (v_js->'milestones'->0->>'due_on')::date = v_today - 10 AND (v_js->'milestones'->3->>'due_on')::date = v_today + 140 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  S1 DA sets the start -> day 41, due dates from it; member / future / own refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  S1 member "%s" future "%s" own "%s" day %s due %s / %s%s', v_err, v_e2, v_e3,
             v_js->>'day_n', v_js->'milestones'->0->>'due_on', v_js->'milestones'->3->>'due_on', chr(10)); END IF;

      -- S2 a pure Project Admin of the department can't set a start (a real Department Admin only)
      IF v_pa_em IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  S2 — no pure Project Admin with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa_em, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.set_member_probation(v_a_id, v_today - 7, NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err LIKE 'Only a Department Admin%' AND (SELECT started_on FROM public.member_probation WHERE member_id = v_a_id) = v_today - 40 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  S2 a Project Admin (not a DA) is refused the start date%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  S2 PA -> "%s"%s', v_err, chr(10)); END IF;
      END IF;

      -- C1 custody
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_probation_milestone(v_a_id, '30day', 'done', NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN PERFORM public.log_supervised_session(v_a_id, 'ride_along', 2, v_today); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.set_probation_milestone(v_da_id, '30day', 'done', NULL); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only department leadership%' AND v_e2 LIKE 'Only a Department Admin or Officer%' AND v_e3 LIKE 'You can''t sign your own%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  C1 a member can''t sign / log for themself; the DA can''t sign their own review%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C1 member sign "%s" log "%s" DA own "%s"%s', v_err, v_e2, v_e3, chr(10)); END IF;

      -- W1 direct writes refused
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN INSERT INTO public.member_probation (member_id, department_id, started_on) VALUES (v_b_id, rec.dept_id, v_today); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN INSERT INTO public.probation_milestones (department_id, member_id, kind, status, signed_by) VALUES (rec.dept_id, v_a_id, 'final', 'done', v_b_id); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      BEGIN INSERT INTO public.supervised_sessions (department_id, member_id, kind, hours, occurred_on, supervisor_id, created_by)
            VALUES (rec.dept_id, v_a_id, 'drive', 5, v_today, v_b_id, v_b_id); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err ILIKE '%permission denied%' AND v_e2 ILIKE '%permission denied%' AND v_e3 ILIKE '%permission denied%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W1 direct INSERT refused on all three tables%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W1 "%s" / "%s" / "%s"%s', v_err, v_e2, v_e3, chr(10)); END IF;

      -- K1 ack item via Read & Sign
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      v_err := (SELECT e->>'state' || '/' || (e->>'satisfied') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_ack)
               || '/' || (v_js->'gate'->>'satisfied');
      SELECT q.content_hash INTO v_hash FROM public.my_read_sign_queue() q WHERE q.series_id = v_series;
      PERFORM public.acknowledge_document((SELECT id FROM public.documents WHERE id = v_doc), 1, v_hash, SIG);
      v_js := public.my_probation_status();
      v_e2 := (SELECT e->>'state' || '/' || (e->>'satisfied') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_ack);
      PERFORM set_config('role', 'postgres', true);
      IF v_err = 'needs_signature/false/0' AND v_e2 = 'signed_current/true' AND (v_js->>'cleared_to_run')::boolean = false THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K1 ack item: needs_signature -> signed via Read & Sign -> signed_current (gate still open)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K1 before %s after %s cleared %s%s', v_err, v_e2, v_js->>'cleared_to_run', chr(10)); END IF;

      -- K2 manual gate item signed by the DA through the unchanged set_onboarding_item
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.set_onboarding_item(v_a_id, v_i_man, true);
      v_js := public.member_probation_status(v_a_id);
      PERFORM set_config('role', 'postgres', true);
      v_err := (SELECT e->>'state' || '/' || coalesce(e->>'signed_by_name', '-') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_man);
      IF v_err = 'signed/' || (SELECT name FROM public.members WHERE id = v_da_id) AND (v_js->>'cleared_to_run')::boolean
         AND (v_js->'gate'->>'required')::int = 2 AND (v_js->'gate'->>'satisfied')::int = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K2 manual gate item signed by the DA (name shown); gate 2 of 2 -> cleared to run%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K2 state %s gate %s%s', v_err, v_js->'gate', chr(10)); END IF;

      -- K3 hours
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_sess := (public.log_supervised_session(v_a_id, 'ride_along', 1.5, v_today - 3)).id;
      v_js := public.member_probation_status(v_a_id);
      v_err := (SELECT e->>'state' || '/' || (e->>'have') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_hrs);
      BEGIN PERFORM public.log_supervised_session(v_a_id, 'drive', 1, v_today, NULL, v_a_id); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      BEGIN PERFORM public.log_supervised_session(v_a_id, 'drive', 1, v_today + 1); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM public.log_supervised_session(v_a_id, 'drive', 1, v_today);
      v_js := public.member_probation_status(v_a_id);
      PERFORM set_config('role', 'postgres', true);
      v_t := (SELECT e->>'state' || '/' || (e->>'have') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_hrs);
      IF v_err = 'in_progress/1.5' AND v_t = 'met/2.5' AND v_e2 LIKE 'A member can''t supervise%' AND v_e3 LIKE 'The date must be%'
         AND (v_js->>'supervised_hours')::numeric = 2.5 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K3 hours: 1.5 -> in_progress, 2.5 -> met (target 2); self-supervised + future date refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K3 %s -> %s; self-sup "%s" future "%s"%s', v_err, v_t, v_e2, v_e3, chr(10)); END IF;

      -- K4 cert (fixture rows as the owner)
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_a_id, 'retest cert', to_char(v_today - interval '2 months', 'YYYY-MM'));
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_a_id, 'Retest Cert', NULL);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      v_err := (SELECT e->>'state' FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_cert);
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_a_id, 'RETEST CERT', to_char(v_today + interval '14 months', 'YYYY-MM'));
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      v_e2 := (SELECT e->>'state' FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_cert);
      IF v_err = 'missing' AND v_e2 = 'current' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K4 cert: expired + undated -> missing; a dated, unexpired one -> current%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K4 %s -> %s%s', v_err, v_e2, chr(10)); END IF;

      -- L1 legacy tick (owner insert = the old direct-tick shape)
      INSERT INTO public.onboarding_progress (department_id, member_id, item_id, done) VALUES (rec.dept_id, v_a_id, v_i_leg, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      v_err := (SELECT e->>'state' || '/' || (e->>'satisfied') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_leg);
      IF v_err = 'done_unrecorded/true' AND (v_js->'probation'->>'required')::int = 3 AND (v_js->'probation'->>'satisfied')::int = 3 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  L1 legacy tick -> done_unrecorded (counts); probation items 3 of 3%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  L1 %s probation %s%s', v_err, v_js->'probation', chr(10)); END IF;

      -- R1 reviews -> ready
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.set_probation_milestone(v_a_id, '30day', 'done', 'RETEST');
      PERFORM public.set_probation_milestone(v_a_id, '60day', 'on_track', NULL);
      PERFORM public.set_probation_milestone(v_a_id, '60day', 'done', NULL);
      PERFORM public.set_probation_milestone(v_a_id, '90day', 'done', NULL);
      v_ok := (public.member_probation_status(v_a_id)->>'ready_for_vote')::boolean;
      PERFORM public.set_probation_milestone(v_a_id, 'final', 'done', NULL);
      v_js := public.member_probation_status(v_a_id);
      BEGIN PERFORM public.set_probation_milestone(v_b_id, '30day', 'done', NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM public.probation_milestones WHERE member_id = v_a_id AND signed_by = v_da_id;
      IF NOT v_ok AND (v_js->>'ready_for_vote')::boolean AND (v_js->>'milestones_done')::int = 4 AND v_n = 4
         AND (v_err LIKE 'Probation reviews are for probationary%' OR (SELECT status FROM public.members WHERE id = v_b_id) = 'Probationary') THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 3 reviews -> not ready; final done -> ready_for_vote; review refused for a non-probationary member%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 ready-before %s after %s done %s rows %s non-prob "%s"%s', v_ok, v_js->>'ready_for_vote', v_js->>'milestones_done', v_n, v_err, chr(10)); END IF;

      -- B1 board: honest denominator. B becomes a FORMER probationary member; the PA (if any) is made probationary.
      UPDATE public.members SET status = 'Probationary' WHERE id = v_b_id;
      INSERT INTO public.member_separation (member_id, department_id, terminated_on) VALUES (v_b_id, rec.dept_id, v_today) ON CONFLICT (member_id) DO NOTHING;
      SELECT m.id INTO v_pa FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Project Admin']::text[] LIMIT 1;
      IF v_pa IS NOT NULL THEN UPDATE public.members SET status = 'Probationary' WHERE id = v_pa; END IF;
      SELECT count(*) INTO v_m FROM public.members m WHERE m.department_id = rec.dept_id AND m.status = 'Probationary'
         AND NOT coalesce(m.access && array['Project Admin']::text[], false)
         AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*), bool_or(b.member_id = v_a_id AND b.ready_for_vote AND b.cleared_to_run), bool_or(b.member_id = v_b_id), bool_or(b.member_id = v_pa)
        INTO v_n, v_ok, v_err, v_e2 FROM public.dept_probation_board() b;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      BEGIN PERFORM * FROM public.dept_probation_board(); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = v_m AND v_ok AND NOT v_err::boolean AND coalesce(v_e2::boolean, false) = false AND v_e3 LIKE 'Only department leadership%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  B1 board: %s listed = independent count; A ready; former + PA excluded; member refused%s', v_n, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B1 board %s vs %s, A ready %s, former listed %s, PA listed %s, member "%s"%s', v_n, v_m, v_ok, v_err, v_e2, v_e3, chr(10)); END IF;

      -- V1 visibility
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT (SELECT count(*) FROM public.member_probation WHERE member_id = v_a_id) + (SELECT count(*) FROM public.probation_milestones WHERE member_id = v_a_id)
             + (SELECT count(*) FROM public.supervised_sessions WHERE member_id = v_a_id) INTO v_n;
      BEGIN PERFORM public.member_probation_status(v_a_id); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      SELECT (SELECT count(*) FROM public.member_probation) + (SELECT count(*) FROM public.probation_milestones) + (SELECT count(*) FROM public.supervised_sessions),
             (SELECT count(*) FROM public.probation_milestones WHERE member_id <> v_a_id) + (SELECT count(*) FROM public.supervised_sessions WHERE member_id <> v_a_id)
        INTO v_m, v_k;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 0 AND v_err LIKE 'Only department leadership%' AND v_m = 1 + 4 + 2 AND v_k = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  V1 B sees none of A''s rows and can''t read A''s status; A reads exactly their own 7%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V1 B saw %s, B status "%s", A saw %s (others'' %s)%s', v_n, v_err, v_m, v_k, chr(10)); END IF;

      -- X1 another department's DA
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  X1 — no other-department DA%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.set_member_probation(v_a_id, v_today, NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        BEGIN PERFORM public.set_probation_milestone(v_a_id, '30day', 'needs_work', NULL); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
        BEGIN PERFORM public.log_supervised_session(v_a_id, 'shift', 3, v_today); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
        BEGIN PERFORM public.member_probation_status(v_a_id); v_t := 'OK'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
        SELECT count(*) INTO v_n FROM public.dept_probation_board() b WHERE b.member_id = v_a_id;
        SELECT count(*) INTO v_m FROM public.member_probation WHERE member_id = v_a_id;
        PERFORM set_config('role', 'postgres', true);
        IF v_err LIKE 'That member is not in your department%' AND v_e2 LIKE 'That member is not in your department%'
           AND v_e3 LIKE 'That member is not in your department%' AND v_t LIKE 'That member is not in your department%' AND v_n = 0 AND v_m = 0 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  X1 another department''s DA: start / review / log / status refused; not on their board; no rows%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 start "%s" review "%s" log "%s" status "%s" board %s rows %s%s', v_err, v_e2, v_e3, v_t, v_n, v_m, chr(10)); END IF;
      END IF;

      -- O1 Officer
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  O1 — no Officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.set_probation_milestone(v_a_id, '30day', 'on_track', NULL); PERFORM public.log_supervised_session(v_a_id, 'shift', 2, v_today); v_err := 'OK';
        EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        BEGIN PERFORM public.set_member_probation(v_a_id, v_today - 3, NULL); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' AND v_e2 LIKE 'Only a Department Admin%' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  O1 Officer signs a review + logs a session; can''t set a start%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  O1 sign/log "%s" start "%s"%s', v_err, v_e2, chr(10)); END IF;
      END IF;
      -- K5 ack item edge states: a document A isn't in the audience of reads not_required (satisfied); a link to no
      -- published series reads not_configured (NOT satisfied)
      UPDATE public.document_series SET required_roles = array['Board Member'] WHERE series_id = v_series;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      v_err := (SELECT e->>'state' || '/' || (e->>'satisfied') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_ack);
      UPDATE public.onboarding_items SET ack_series_id = gen_random_uuid() WHERE id = v_i_ack;
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      v_e2 := (SELECT e->>'state' || '/' || (e->>'satisfied') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_ack);
      IF v_err = 'not_required/true' AND v_e2 = 'not_configured/false' AND (v_js->>'cleared_to_run')::boolean = false THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K5 ack: outside the audience -> not_required; broken link -> not_configured, gate reopens%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K5 audience %s link %s cleared %s%s', v_err, v_e2, v_js->>'cleared_to_run', chr(10)); END IF;

      -- T1 training nights: all-time, up to today (future never). RELATIVE to A's real attendance (live members have some):
      -- baseline counted independently as the owner; two past + one future fixture night -> +2; one more past -> +1 = target.
      SELECT count(DISTINCT a.session_id) INTO v_k FROM public.session_attendance a
        JOIN public.training_sessions t ON t.id = a.session_id AND t.department_id = rec.dept_id
       WHERE a.member_id = v_a_id AND t.date <= v_today;
      INSERT INTO public.onboarding_items (department_id, category, label, sort_order, phase, kind, hours_target, hours_source)
        VALUES (rec.dept_id, 'RETEST', 'RETEST training nights', 9006, 'onboarding', 'hours', v_k + 3, 'training_nights') RETURNING id INTO v_doc;
      WITH s AS (INSERT INTO public.training_sessions (department_id, title, date)
                 SELECT rec.dept_id, 'RETEST night ' || x, v_today + x FROM unnest(array[-50, -5, 3]) x RETURNING id)
      INSERT INTO public.session_attendance (department_id, session_id, member_id) SELECT rec.dept_id, s.id, v_a_id FROM s;
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      v_err := (SELECT e->>'state' || '/' || (e->>'have') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_doc);
      WITH s AS (INSERT INTO public.training_sessions (department_id, title, date) VALUES (rec.dept_id, 'RETEST night -1', v_today - 1) RETURNING id)
      INSERT INTO public.session_attendance (department_id, session_id, member_id) SELECT rec.dept_id, s.id, v_a_id FROM s;
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      v_e2 := (SELECT e->>'state' || '/' || (e->>'have') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_doc);
      IF v_err = format('in_progress/%s', v_k + 2) AND v_e2 = format('met/%s', v_k + 3) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 training nights: all-time, future never — %s real + 2 -> %s, +1 -> %s = met%s', v_k, v_k + 2, v_k + 3, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 baseline %s: %s -> %s (expected in_progress/%s -> met/%s)%s', v_k, v_err, v_e2, v_k + 2, v_k + 3, chr(10)); END IF;
      -- B2 a Board Member can't log supervised time (operational: DA / Officer only)
      IF v_board IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  B2 — no Board Member with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_board, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.log_supervised_session(v_a_id, 'ride_along', 1, v_today); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        BEGIN PERFORM public.void_supervised_session(v_sess, 'board try'); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err LIKE 'Only a Department Admin or Officer%' AND v_e2 LIKE 'Only a Department Admin or Officer%' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  B2 a Board Member can''t log or void supervised time%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B2 log "%s" void "%s"%s', v_err, v_e2, chr(10)); END IF;
      END IF;

      -- D1 void: a member can't; another department's DA can't; a reason is required; the DA voids the 1.5 h session ->
      -- the row stays, it stops counting (hours item + supervised_hours drop by 1.5); voiding again is refused
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.member_probation_status(v_a_id);
      v_h0 := (v_js->>'supervised_hours')::numeric;
      v_err := (SELECT (e->>'have') FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_hrs);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.void_supervised_session(v_sess, 'member try'); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      v_e3 := 'n/a';
      IF v_other_da IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.void_supervised_session(v_sess, 'other dept try'); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.void_supervised_session(v_sess, '   '); v_t := 'OK'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
      PERFORM public.void_supervised_session(v_sess, 'RETEST: logged against the wrong member');
      BEGIN PERFORM public.void_supervised_session(v_sess, 'again'); v_hash := 'OK'; EXCEPTION WHEN OTHERS THEN v_hash := SQLERRM; END;
      v_js := public.member_probation_status(v_a_id);
      v_h1 := (v_js->>'supervised_hours')::numeric;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM public.supervised_sessions WHERE id = v_sess AND voided_at IS NOT NULL AND voided_by = v_da_id AND void_reason LIKE 'RETEST:%';
      IF v_e2 LIKE 'Only a Department Admin or Officer%' AND (v_e3 = 'n/a' OR v_e3 LIKE 'That session is not in your department%')
         AND v_t LIKE 'Say why%' AND v_hash LIKE 'That session is already voided%' AND v_n = 1 AND v_h1 = v_h0 - 1.5
         AND (SELECT (e->>'have')::numeric FROM jsonb_array_elements(v_js->'items') e WHERE (e->>'item_id')::uuid = v_i_hrs) = v_err::numeric - 1.5 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  D1 void: member / other dept / blank reason refused; voided row kept, stops counting (%s -> %s h); no double void%s', v_h0, v_h1, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D1 member "%s" other "%s" blank "%s" again "%s" row %s hours %s -> %s item %s%s', v_e2, v_e3, v_t, v_hash, v_n, v_h0, v_h1, v_err, chr(10)); END IF;
      -- D2 custody on the void: a session logged FOR the DA (fixture, as the owner) can't be voided by the DA themself
      INSERT INTO public.supervised_sessions (department_id, member_id, kind, hours, occurred_on, supervisor_id, created_by)
        VALUES (rec.dept_id, v_da_id, 'drive', 2, v_today, v_a_id, v_a_id) RETURNING id INTO v_sess;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.void_supervised_session(v_sess, 'my own'); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'You can''t void your own%' AND (SELECT voided_at FROM public.supervised_sessions WHERE id = v_sess) IS NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  D2 the DA can''t void a session logged for themself%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D2 own void -> "%s"%s', v_err, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
