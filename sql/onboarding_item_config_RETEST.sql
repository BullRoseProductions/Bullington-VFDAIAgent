-- =====================================================================
-- RETEST for onboarding_item_config_2026-10-19.sql (applied 2026-10-19) — run AFTER the migration, separately. NOTHING CHANGES: each department's
-- checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on FIXTURE checklist items it creates
-- itself. The final RAISE is the report. The "ERROR" IS the report.
--   S0 (once) grants: anon can't run the four RPCs, members can; the internals aren't callable; a client can't write ANY
--      onboarding_progress column or the four config columns (R2); mark_onboarding_ready takes no member; no stored-file
--      column on either table
-- Per department (needs a DA and two plain members with unique emails — A is the "cadet", B the named approver, the
-- department's "medical officer"; an Officer (not DA) and another department's member are used when present, else
-- that part SKIPs):
--   C1 config: A and the Officer refused (DA / PA only); the DA sets T = tier Officer, P = person B + document check;
--      person + tier together, a tier with a member, an unknown tier, another department's member, and a document check
--      on an item that completes itself are all refused; a person approver with no member is refused by the table;
--      a client can't write the config columns directly; B is pinged once per item as the approver, and a re-save pings no one again
--   R1 ready: A marks T, P and U (unconfigured) ready -> awaiting_approval / awaiting_check / awaiting_approval (T reads
--      approver_not_set in a department with no active Officer), none complete; marking again changes nothing; a mentor item is refused; B is pinged that P is ready — and, after B mutes tasks, not for P2
--   Q1 queue: the Officer (or DA) sees A's three; B sees only P (can sign); A sees none of their own
--   G1 sign-off: A can't sign their own, nor can B sign B's own item they are the approver of (the self-sign block's
--      exact message); B signing P without the check is refused,
--      with it -> signed + doc_checked_by = B; B can't sign T (tier Officer); the Officer can't sign P (person B) or T2
--      (tier Board Member) but signs T and U; signing again is refused; the old set_onboarding_item refuses T (configured) and still ticks an
--      unconfigured item and still UNticks a configured one; the DA signs a person item that isn't theirs (the override,
--      recorded as the DA); neither the cadet nor the DA can write a progress row directly (R2)
--   H1 honest: a person approver who goes Inactive -> approver_not_set (never a silent pass)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_e2 text; v_e3 text; v_e4 text; v_n int; v_ok boolean; v_t text; v_ts timestamptz; v_row record;
  v_da text; v_off text; v_a text; v_b text; v_x text; v_a_id uuid; v_b_id uuid; v_off_id uuid; v_x_id uuid;
  i_t uuid; i_t2 uuid; i_p uuid; i_u uuid; i_u2 uuid; i_p2 uuid; i_m uuid; i_h uuid; v_e5 text; v_mute boolean;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  v_ok := true; v_t := '';
  FOREACH v_err IN ARRAY array['public.set_onboarding_item_config(uuid,boolean,text,text,uuid)', 'public.mark_onboarding_ready(uuid)',
                               'public.sign_off_onboarding_item(uuid,uuid,boolean)', 'public.onboarding_signoff_queue()'] LOOP
    IF has_function_privilege('anon', v_err, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_err, 'EXECUTE') THEN v_ok := false; v_t := v_t || ' grant:' || v_err; END IF;
  END LOOP;
  FOREACH v_err IN ARRAY array['public.onboarding_ping(uuid,uuid,text,text,text,text)', 'public.onboarding_caller_can_sign(uuid)', 'public.probation_item_states(uuid,uuid)'] LOOP
    IF has_function_privilege('authenticated', v_err, 'EXECUTE') THEN v_ok := false; v_t := v_t || ' internal:' || v_err; END IF;
  END LOOP;
  FOREACH v_err IN ARRAY array['done', 'checked_by', 'checked_at', 'member_id', 'item_id', 'ready_at', 'ready_by', 'doc_checked_at', 'doc_checked_by'] LOOP
    IF has_column_privilege('authenticated', 'public.onboarding_progress', v_err, 'UPDATE') OR has_column_privilege('authenticated', 'public.onboarding_progress', v_err, 'INSERT') THEN v_ok := false; v_t := v_t || ' col:' || v_err; END IF;
  END LOOP;
  FOREACH v_err IN ARRAY array['requires_doc', 'approver_kind', 'approver_role', 'approver_member_id'] LOOP
    IF has_column_privilege('authenticated', 'public.onboarding_items', v_err, 'UPDATE') OR has_column_privilege('authenticated', 'public.onboarding_items', v_err, 'INSERT') THEN v_ok := false; v_t := v_t || ' col:' || v_err; END IF;
  END LOOP;
  IF pg_get_function_identity_arguments('public.mark_onboarding_ready(uuid)'::regprocedure) <> 'p_item_id uuid' THEN v_ok := false; v_t := v_t || ' ready-args'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('onboarding_items', 'onboarding_progress')
       AND column_name ~* '(proof|path|file|upload|scan|storage|url|attach|document|image|photo)') THEN v_ok := false; v_t := v_t || ' file-column'; END IF;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 grants right; internals not callable; progress + config columns RPC-only; mark-ready has no member argument; no stored-file column%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0%s%s', v_t, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_a := NULL; v_b := NULL; v_x := NULL; v_a_id := NULL; v_b_id := NULL; v_off_id := NULL; v_x_id := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_off, v_off_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_a, v_a_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_b, v_b_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.id IS DISTINCT FROM v_a_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT m.id INTO v_x_id FROM public.members m WHERE m.department_id <> rec.dept_id AND m.status IN ('Active', 'Probationary') ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL OR v_b IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and two plain members with unique emails (DA %s, A %s, B %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), coalesce(v_b, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- fixtures (owner): five manual items, one mentor item, one hours item; B not muted for tasks
      INSERT INTO public.onboarding_items (department_id, category, label, kind) VALUES (rec.dept_id, 'RETEST', 'RETEST tier item', 'manual') RETURNING id INTO i_t;
      INSERT INTO public.onboarding_items (department_id, category, label, kind) VALUES (rec.dept_id, 'RETEST', 'RETEST board tier item', 'manual') RETURNING id INTO i_t2;
      INSERT INTO public.onboarding_items (department_id, category, label, kind) VALUES (rec.dept_id, 'RETEST', 'RETEST medical statement', 'manual') RETURNING id INTO i_p;
      INSERT INTO public.onboarding_items (department_id, category, label, kind) VALUES (rec.dept_id, 'RETEST', 'RETEST unconfigured', 'manual') RETURNING id INTO i_u;
      INSERT INTO public.onboarding_items (department_id, category, label, kind) VALUES (rec.dept_id, 'RETEST', 'RETEST legacy tick', 'manual') RETURNING id INTO i_u2;
      INSERT INTO public.onboarding_items (department_id, category, label, kind) VALUES (rec.dept_id, 'RETEST', 'RETEST DA override', 'manual') RETURNING id INTO i_p2;
      INSERT INTO public.onboarding_items (department_id, category, label, kind, is_mentor) VALUES (rec.dept_id, 'RETEST', 'RETEST mentor', 'manual', true) RETURNING id INTO i_m;
      INSERT INTO public.onboarding_items (department_id, category, label, kind) VALUES (rec.dept_id, 'RETEST', 'RETEST hours', 'hours') RETURNING id INTO i_h;
      DELETE FROM public.notification_prefs WHERE member_id = v_b_id AND family = 'tasks';
      DELETE FROM public.notifications WHERE member_id = v_b_id AND type IN ('onboarding_approver', 'onboarding_ready');

      -- C1 config
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_onboarding_item_config(i_t, false, 'tier', 'Officer', NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_e2 := 'n/a';
      IF v_off IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.set_onboarding_item_config(i_t, false, 'tier', 'Officer', NULL); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM public.set_onboarding_item_config(i_t, false, 'tier', 'Officer', NULL);
      PERFORM public.set_onboarding_item_config(i_p, true, 'person', NULL, v_b_id);
      PERFORM public.set_onboarding_item_config(i_p2, false, 'person', NULL, v_b_id);
      PERFORM public.set_onboarding_item_config(i_t2, false, 'tier', 'Board Member', NULL);
      PERFORM public.set_onboarding_item_config(i_p, true, 'person', NULL, v_b_id);   -- a re-save: same approver, no second ping
      v_n := 0;
      BEGIN PERFORM public.set_onboarding_item_config(i_u, false, 'person', 'Officer', v_b_id); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Pick a person or a tier, not both.' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.set_onboarding_item_config(i_u, false, 'tier', NULL, v_b_id); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Pick a person or a tier, not both.' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.set_onboarding_item_config(i_u, false, 'tier', 'Chief', NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM = 'Unknown command tier.' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.set_onboarding_item_config(i_h, true, 'tier', NULL, NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Only a checklist item an officer checks off%' THEN v_n := v_n + 1; END IF; END;
      IF v_x_id IS NOT NULL THEN
        BEGIN PERFORM public.set_onboarding_item_config(i_u, false, 'person', NULL, v_x_id); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'That approver isn''t an active member%' THEN v_n := v_n + 1; END IF; END;
      ELSE v_n := v_n + 1; END IF;
      BEGIN UPDATE public.onboarding_items SET approver_kind = 'person', approver_member_id = v_b_id WHERE id = i_u; v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      BEGIN UPDATE public.onboarding_items SET approver_kind = 'person' WHERE id = i_u; v_e4 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e4 := SQLERRM; END;
      IF v_err = 'Only a Department Admin can set who signs off an item.' AND (v_e2 = 'n/a' OR v_e2 = 'Only a Department Admin can set who signs off an item.')
         AND v_n = 5 AND v_e3 ILIKE '%permission denied%' AND v_e4 ILIKE '%onboarding_items_approver_shape_chk%'
         AND (SELECT count(*) FROM public.onboarding_items WHERE (id = i_t AND approver_role = 'Officer' AND NOT requires_doc)
               OR (id = i_p AND approver_kind = 'person' AND approver_member_id = v_b_id AND requires_doc)) = 2
         AND (SELECT count(*) FROM public.notifications WHERE member_id = v_b_id AND type = 'onboarding_approver') = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  C1 member%s refused; DA sets tier + person/document; 5 bad configs refused; table refuses a person with no member; client can''t write config; B pinged once per item (a re-save adds none)%s',
          CASE WHEN v_e2 = 'n/a' THEN '' ELSE ' + Officer' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C1 member "%s" officer "%s" refused %s/5 direct "%s" shape "%s" pings %s%s', v_err, v_e2, v_n, v_e3, v_e4,
        (SELECT count(*) FROM public.notifications WHERE member_id = v_b_id AND type = 'onboarding_approver'), chr(10)); END IF;

      -- R1 ready
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM set_config('role', 'postgres', true);
      BEGIN INSERT INTO public.notification_prefs (member_id, family, enabled) VALUES (v_b_id, 'tasks', true)
              ON CONFLICT (member_id, family) DO UPDATE SET enabled = true; v_mute := true; EXCEPTION WHEN OTHERS THEN v_mute := false; END;
      PERFORM set_config('role', 'authenticated', true);
      v_ts := (public.mark_onboarding_ready(i_t)).ready_at;
      PERFORM public.mark_onboarding_ready(i_p);
      PERFORM public.mark_onboarding_ready(i_u);
      -- idempotent: now() is fixed inside this transaction, so backdate the mark first — a second call must leave it alone
      PERFORM set_config('role', 'postgres', true);
      UPDATE public.onboarding_progress SET ready_at = timestamptz '2020-01-01 12:00+00' WHERE member_id = v_a_id AND item_id = i_t;
      PERFORM set_config('role', 'authenticated', true);
      v_ok := (public.mark_onboarding_ready(i_t)).ready_at = timestamptz '2020-01-01 12:00+00' AND v_ts IS NOT NULL;
      BEGIN PERFORM public.mark_onboarding_ready(i_m); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_mute THEN UPDATE public.notification_prefs SET enabled = false WHERE member_id = v_b_id AND family = 'tasks'; END IF;   -- B mutes tasks
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.mark_onboarding_ready(i_p2);   -- B is its approver, but muted now: no ping
      PERFORM set_config('role', 'postgres', true);
      SELECT string_agg(s.label || '=' || s.state || '/' || s.satisfied::text, ' ' ORDER BY s.label) INTO v_t
        FROM public.probation_item_states(v_a_id, rec.dept_id) s WHERE s.item_id IN (i_t, i_p, i_u);
      -- the Officer tier resolves only if the department has an active Officer; with none it honestly reads approver_not_set
      v_e2 := CASE WHEN EXISTS (SELECT 1 FROM public.members WHERE department_id = rec.dept_id AND status IN ('Active', 'Probationary') AND access && array['Officer']::text[])
                   THEN 'awaiting_approval' ELSE 'approver_not_set' END;
      IF v_ok AND v_t = 'RETEST medical statement=awaiting_check/false RETEST tier item=' || v_e2 || '/false RETEST unconfigured=awaiting_approval/false'
         AND NOT EXISTS (SELECT 1 FROM public.onboarding_progress WHERE member_id = v_a_id AND item_id IN (i_t, i_p, i_u) AND (done OR checked_by IS NOT NULL))
         AND v_err LIKE 'This item completes on its own%'
         AND (SELECT count(*) FROM public.notifications WHERE member_id = v_b_id AND type = 'onboarding_ready' AND subject_ref = 'onb-ready:' || v_a_id || ':' || i_p) = 1
         AND (SELECT count(*) FROM public.notifications WHERE member_id = v_b_id AND type = 'onboarding_ready') = (CASE WHEN v_mute THEN 1 ELSE 2 END) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 A marks 3 ready -> awaiting check / approval%s, none complete; idempotent; mentor item refused; B pinged for P%s%s',
          CASE WHEN v_e2 = 'approver_not_set' THEN ' (Officer tier: approver_not_set — no Officer here)' ELSE '' END,
          CASE WHEN v_mute THEN ', not once B muted tasks' ELSE ' (mute check skipped: notification_prefs refused the fixture row)' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 idem %s states "%s" mentor "%s" ready-pings %s (muted %s)%s', v_ok, v_t, v_err,
        (SELECT count(*) FROM public.notifications WHERE member_id = v_b_id AND type = 'onboarding_ready'), v_mute, chr(10)); END IF;

      -- Q1 queue
      PERFORM set_config('request.jwt.claims', json_build_object('email', coalesce(v_off, v_da), 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.onboarding_signoff_queue() q WHERE q.member_id = v_a_id AND q.item_id IN (i_t, i_p, i_u);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      SELECT string_agg(q.label || ':' || q.can_sign::text, ',' ORDER BY q.label) INTO v_t FROM public.onboarding_signoff_queue() q WHERE q.label LIKE 'RETEST%';
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      SELECT count(*) = 0 INTO v_ok FROM public.onboarding_signoff_queue() q WHERE q.member_id = v_a_id;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 3 AND v_t = 'RETEST DA override:true,RETEST medical statement:true' AND v_ok THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q1 %s sees A''s 3; B sees only the two items they sign; A sees none of their own%s', CASE WHEN v_off IS NULL THEN 'DA' ELSE 'Officer' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q1 leader %s/3 B "%s" A-sees-none %s%s', v_n, v_t, v_ok, chr(10)); END IF;

      -- G1 sign-off
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.sign_off_onboarding_item(v_a_id, i_t, false); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.sign_off_onboarding_item(v_b_id, i_p, true); v_e5 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e5 := SQLERRM; END;   -- the approver, on their OWN item
      BEGIN PERFORM public.sign_off_onboarding_item(v_a_id, i_p, false); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      PERFORM public.sign_off_onboarding_item(v_a_id, i_p, true);
      BEGIN PERFORM public.sign_off_onboarding_item(v_a_id, i_t, false); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      v_e4 := 'n/a'; v_t := 'n/a';
      IF v_off IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.sign_off_onboarding_item(v_a_id, i_p2, false); v_e4 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e4 := SQLERRM; END;
        BEGIN PERFORM public.sign_off_onboarding_item(v_a_id, i_t2, false); v_e4 := v_e4 || ' | OK'; EXCEPTION WHEN OTHERS THEN v_e4 := v_e4 || ' | ' || SQLERRM; END;
        PERFORM public.sign_off_onboarding_item(v_a_id, i_t, false);
        PERFORM public.sign_off_onboarding_item(v_a_id, i_u, false);
        BEGIN PERFORM public.sign_off_onboarding_item(v_a_id, i_t, false); v_t := 'OK'; EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', coalesce(v_off, v_da), 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.set_onboarding_item(v_a_id, i_t, true); v_x := 'OK'; EXCEPTION WHEN OTHERS THEN v_x := SQLERRM; END;
      PERFORM public.set_onboarding_item(v_a_id, i_u2, true);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      v_ok := (public.sign_off_onboarding_item(v_a_id, i_p2, false)).checked_by = (SELECT id FROM public.members WHERE lower(email) = v_da AND department_id = rec.dept_id);   -- the override, recorded as the DA
      v_ok := v_ok AND (public.set_onboarding_item(v_a_id, i_p2, false)).done = false;   -- unticking a configured, signed item is unchanged
      BEGIN UPDATE public.onboarding_progress SET done = true WHERE member_id = v_a_id AND item_id = i_u2; v_e3 := v_e3 || ' | OK'; EXCEPTION WHEN OTHERS THEN v_e3 := v_e3 || ' | ' || SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      BEGIN INSERT INTO public.onboarding_progress (department_id, member_id, item_id, done) VALUES (rec.dept_id, v_a_id, i_t, true); v_e3 := v_e3 || ' | OK'; EXCEPTION WHEN OTHERS THEN v_e3 := v_e3 || ' | ' || SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO v_row FROM public.onboarding_progress WHERE member_id = v_a_id AND item_id = i_p;
      IF v_err = 'You can''t sign off your own onboarding — a mentor or officer does.' AND v_e5 = v_err
         AND v_e2 LIKE 'This item needs its document checked in person%'
         AND v_row.done AND v_row.checked_by = v_b_id AND v_row.doc_checked_by = v_b_id AND v_row.doc_checked_at IS NOT NULL
         AND v_e3 LIKE 'Only someone with Officer access (or a Department Admin) can sign this item off. | %permission denied% | %permission denied%' AND v_ok
         AND (v_e4 = 'n/a' OR v_e4 = 'Only the approver set for this item (or a Department Admin) can sign it off. | Only someone with Board Member access (or a Department Admin) can sign this item off.')
         AND (v_t = 'n/a' OR v_t = 'This item is already signed off.')
         AND v_x = 'This item has a set approver — sign it off from the sign-off list.'
         AND EXISTS (SELECT 1 FROM public.onboarding_progress WHERE member_id = v_a_id AND item_id = i_u2 AND done AND checked_by IS NOT NULL)
         AND (v_off IS NULL OR (SELECT count(*) FROM public.onboarding_progress WHERE member_id = v_a_id AND item_id IN (i_t, i_u) AND done AND checked_by = v_off_id) = 2)
         AND NOT EXISTS (SELECT 1 FROM public.onboarding_progress WHERE member_id = v_a_id AND item_id IN (i_t, i_u, i_u2, i_p2) AND doc_checked_at IS NOT NULL) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  G1 self refused (the cadet, and the approver on their own item); no check -> refused, check -> signed by B with who + when; B refused the tier item%s; old path refuses configured, ticks unconfigured, unticks configured; DA override; no direct progress writes (DA, cadet)%s',
          CASE WHEN v_off IS NULL THEN '' ELSE '; Officer refused the person item and the Board tier item, signs Officer tier + unconfigured; re-sign refused' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  G1 self "%s" approver-own "' || coalesce(v_e5, '') || '" nocheck "%s" P %s/%s/%s tierB "%s" offP "%s" resign "%s" old "%s"%s', v_err, v_e2, v_row.done, v_row.checked_by = v_b_id, v_row.doc_checked_by = v_b_id, v_e3, v_e4, v_t, v_x, chr(10)); END IF;

      -- H1 honest: the person approver goes Inactive -> approver_not_set on an open item
      UPDATE public.onboarding_items SET approver_kind = 'tier', approver_member_id = NULL, approver_role = NULL, requires_doc = false WHERE id = i_u;   -- reuse: reconfigure as owner
      UPDATE public.onboarding_progress SET done = false, checked_by = NULL, checked_at = NULL, ready_at = NULL, ready_by = NULL WHERE member_id = v_a_id AND item_id = i_u;
      UPDATE public.onboarding_items SET approver_kind = 'person', approver_member_id = v_b_id WHERE id = i_u;
      UPDATE public.members SET status = 'Inactive' WHERE id = v_b_id;
      SELECT s.state INTO v_t FROM public.probation_item_states(v_a_id, rec.dept_id) s WHERE s.item_id = i_u;
      SELECT s.satisfied INTO v_ok FROM public.probation_item_states(v_a_id, rec.dept_id) s WHERE s.item_id = i_u;
      IF v_t = 'approver_not_set' AND NOT v_ok THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  H1 an inactive person approver -> approver_not_set, not satisfied%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  H1 state %s satisfied %s%s', v_t, v_ok, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
