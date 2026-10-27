-- =====================================================================
-- RETEST for fe_b_event_needs (FE-B-DB). READ-ONLY IN EFFECT — run AFTER the migration, separately.
--
-- Every fixture and write lives inside a per-department sub-block ending in RAISE 'SENTINEL' (rolled back); the whole
-- block ends in a RAISE that IS the report. NOTHING CHANGES. The "ERROR" is the report.
--
-- Once:
--   O1 the 4 RPCs: anon can't EXECUTE, authenticated can, SECURITY DEFINER; the guard is executable by no one
--   O2 event_needs: RLS, 4 policies TO authenticated, S/I/U/D for authenticated, nothing for anon;
--      event_need_claims: RLS, 1 SELECT policy, SELECT-only for authenticated (no write grant), nothing for anon
--   O3 the 15 pinned functions (gates, identity, rollup, action-item lifecycle + trigger, station sharing) unchanged
--   O4 event_type CHECK carries the 6 types, nullable; the (id, department_id) keys; the action_items composite FK
--   O5 no existing row touched: every recruitment_events.event_type NULL; no action_items.recruitment_event_id set
-- Per department (a REAL Department Admin where one exists; fixture Officer / Board / PA / 3 Members / an Inactive member;
-- another department's fixture event + need + sign-up for the cross-department checks):
--   T1  needs write gate: DA + Officer insert (created_by = self); Board / PA / Member insert refused; Member + Board
--       update / delete touch 0 rows
--   T2  needs shape: two parents / no parent / another department's event / slots 0 + 51 / end before start — all refused
--   T3  claim: a Member signs up (taken 1); again -> ALREADY; the last slot gone -> FULL; an Inactive member -> NO_MEMBER
--   T4  claim + assign lock the need row FOR UPDATE (the last-slot race)
--   T5  unclaim: own row removed; again -> NOT_SIGNED_UP; the freed slot can be taken
--   T6  the window (D1): today's event open; yesterday's -> CLOSED for claim / unclaim / assign / remove
--   T7  assign / remove: an Officer assigns (claimed_by = the Officer); Member / Board / PA -> NOT_ALLOWED; another
--       department's or an Inactive member -> NOT_IN_DEPT; a full need -> FULL; the Officer removes; a Member can't
--   T8  sign-ups are visible to every member of the department (FE5.2) and to no one else; no direct INSERT / DELETE
--   T9  another department's need / sign-up -> NOT_FOUND for claim / assign / remove; its needs aren't readable
--   T10 the guard (D3): slots below the sign-ups -> SLOTS_BELOW_CLAIMS; raising is fine; moving a need -> PARENT_LOCKED
--   T11 jobs on a community event (FE6): a DA links one; another department's event refused; complete_action_item works;
--       deleting the event keeps the job (link -> NULL) and removes its needs + sign-ups
--   T12 deleting a fundraiser event removes its needs + sign-ups (FE5.1 arm)
--   T13 station_presence byte-identical across everything; verified count unchanged
-- =====================================================================
DO $retest$
DECLARE
  rec record; k text; v text; v_err text; v_res jsonb; v_n int; v_n2 int; v_ok boolean; v_t text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_today date := (now() at time zone 'America/Chicago')::date;
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
  v_rpcs constant text[] := array['public.claim_event_need(uuid)', 'public.unclaim_event_need(uuid)',
    'public.assign_event_need(uuid,uuid)', 'public.remove_event_need_claim(uuid)'];
  d uuid; dn text; tag text; od uuid;
  e_da text; m_da uuid; real_da boolean; e_off text; m_off uuid; e_board text; e_pa text;
  e_m1 text; m1 uuid; e_m2 text; m2 uuid; e_m3 text; m3 uuid; e_in text; m_in uuid; e_x text; m_x uuid;
  ev_f uuid; ev_t uuid; ev_p uuid; fe_f uuid; ev_x uuid; n1 uuid; n2 uuid; n_t uuid; n_p uuid; n_x uuid;
  c_p uuid; c_x uuid; c3 uuid; ai uuid;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint;
BEGIN
  -- ---------------------------------------------------------------- once
  v_ok := true; v_err := '';
  FOREACH k IN ARRAY v_rpcs LOOP
    IF to_regprocedure(k) IS NULL OR has_function_privilege('anon', k, 'EXECUTE') OR NOT has_function_privilege('authenticated', k, 'EXECUTE')
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(k)) THEN v_ok := false; v_err := v_err || ' ' || k; END IF;
  END LOOP;
  IF to_regprocedure('public.tg_event_needs_guard()') IS NULL OR has_function_privilege('anon', 'public.tg_event_needs_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_event_needs_guard()', 'EXECUTE') THEN v_ok := false; v_err := v_err || ' guard'; END IF;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 privileges: 4 RPCs definer + authenticated-only; guard executable by no one' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 privileges:' || v_err || chr(10); END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_needs'::regclass)
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.event_need_claims'::regclass)
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_needs' AND roles = '{authenticated}'::name[]) = 4
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_needs') = 4
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_need_claims' AND cmd = 'SELECT' AND roles = '{authenticated}'::name[]) = 1
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_need_claims') = 1
     AND has_table_privilege('authenticated', 'public.event_needs', 'SELECT') AND has_table_privilege('authenticated', 'public.event_needs', 'INSERT')
     AND has_table_privilege('authenticated', 'public.event_needs', 'UPDATE') AND has_table_privilege('authenticated', 'public.event_needs', 'DELETE')
     AND has_table_privilege('authenticated', 'public.event_need_claims', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.event_need_claims', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.event_need_claims', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.event_need_claims', 'DELETE')
     AND NOT has_table_privilege('anon', 'public.event_needs', 'SELECT') AND NOT has_table_privilege('anon', 'public.event_needs', 'INSERT')
     AND NOT has_table_privilege('anon', 'public.event_need_claims', 'SELECT') AND NOT has_table_privilege('anon', 'public.event_need_claims', 'INSERT') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 new tables: RLS; needs 4 policies + S/I/U/D; claims 1 SELECT policy, read-only; anon nothing' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 new tables RLS / policies / grants' || chr(10); END IF;

  v_ok := true; v_err := '';
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF to_regprocedure(k) IS NULL OR md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN v_ok := false; v_err := v_err || ' ' || k; END IF;
  END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 the 15 pinned functions are byte-identical' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 pinned function(s) changed:' || v_err || chr(10); END IF;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'recruitment_events_event_type_check') LIKE ALL
       (array['%open_house%', '%booth%', '%school_visit%', '%parade%', '%community_safety%', '%other%'])
     AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.recruitment_events'::regclass AND attname = 'event_type' AND (attnotnull OR atthasdef))
     AND (SELECT count(*) FROM pg_constraint WHERE conname IN ('recruitment_events_id_dept_key', 'funding_events_id_dept_key') AND contype = 'u') = 2
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'action_items_recruitment_event_fkey')
         = 'FOREIGN KEY (recruitment_event_id, department_id) REFERENCES recruitment_events(id, department_id) ON DELETE SET NULL (recruitment_event_id)' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O4 event_type CHECK (6 types, nullable); (id, department_id) keys; action_items composite FK SET NULL (link)' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O4 columns / keys / FK not as intended' || chr(10); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.recruitment_events WHERE event_type IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM public.action_items WHERE recruitment_event_id IS NOT NULL) THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  O5 no existing row touched (%s community events all event_type NULL; no job linked)%s', (SELECT count(*) FROM public.recruitment_events), chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O5 an existing row carries a new value' || chr(10); END IF;

  -- ---------------------------------------------------------------- per department
  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; dn := rec.name; tag := 'febrt-' || left(replace(d::text, '-', ''), 8);
    SELECT dep.id INTO od FROM public.departments dep WHERE dep.id <> d ORDER BY dep.name LIMIT 1;
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      e_da := null; m_da := null;
      SELECT lower(m.email), m.id INTO e_da, m_da FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary')
         AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      real_da := e_da IS NOT NULL;
      IF NOT real_da THEN
        e_da := tag || '-da@retest.invalid';
        INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST DA', e_da, '{Department Admin}', 'Active') RETURNING id INTO m_da;
      END IF;
      e_off := tag || '-off@retest.invalid'; e_board := tag || '-board@retest.invalid'; e_pa := tag || '-pa@retest.invalid';
      e_m1 := tag || '-m1@retest.invalid'; e_m2 := tag || '-m2@retest.invalid'; e_m3 := tag || '-m3@retest.invalid'; e_in := tag || '-in@retest.invalid';
      e_x := tag || '-x@retest.invalid';
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Officer', e_off, '{Officer}', 'Active') RETURNING id INTO m_off;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES
        (d, 'RETEST Board', e_board, '{Board Member}', 'Active'), (d, 'RETEST PA', e_pa, '{Project Admin}', 'Active');
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST M1', e_m1, '{Member}', 'Active') RETURNING id INTO m1;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST M2', e_m2, '{Member}', 'Probationary') RETURNING id INTO m2;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST M3', e_m3, '{Member}', 'Active') RETURNING id INTO m3;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Inactive', e_in, '{Member}', 'Inactive') RETURNING id INTO m_in;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (od, 'RETEST other-dept', e_x, '{Member}', 'Active') RETURNING id INTO m_x;
      -- events (owner inserts — the fixtures, not the thing under test)
      INSERT INTO public.recruitment_events (department_id, title, "date") VALUES (d, 'FEBRT future ' || tag, v_today + 3) RETURNING id INTO ev_f;
      INSERT INTO public.recruitment_events (department_id, title, "date") VALUES (d, 'FEBRT today ' || tag, v_today) RETURNING id INTO ev_t;
      INSERT INTO public.recruitment_events (department_id, title, "date") VALUES (d, 'FEBRT past ' || tag, v_today - 1) RETURNING id INTO ev_p;
      INSERT INTO public.funding_events (department_id, title, "date") VALUES (d, 'FEBRT fundraiser ' || tag, v_today + 3) RETURNING id INTO fe_f;
      INSERT INTO public.recruitment_events (department_id, title, "date") VALUES (od, 'FEBRT other dept ' || tag, v_today + 3) RETURNING id INTO ev_x;
      INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed, created_by) VALUES (d, ev_t, 'Today crew', 1, m_da) RETURNING id INTO n_t;
      INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed, created_by) VALUES (d, ev_p, 'Past crew', 3, m_da) RETURNING id INTO n_p;
      INSERT INTO public.event_need_claims (department_id, need_id, member_id, claimed_by) VALUES (d, n_p, m1, m1) RETURNING id INTO c_p;
      INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed, created_by) VALUES (od, ev_x, 'Other crew', 5, m_x) RETURNING id INTO n_x;
      INSERT INTO public.event_need_claims (department_id, need_id, member_id, claimed_by) VALUES (od, n_x, m_x, m_x) RETURNING id INTO c_x;
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      rpt := rpt || format('   (leader = a %s Department Admin; other department for cross-checks: %s)%s',
                           CASE WHEN real_da THEN 'REAL' ELSE 'fixture' END, (SELECT name FROM public.departments WHERE id = od), chr(10));

      -- ---- T1 needs write gate (as the authenticated role, so RLS applies)
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed) VALUES (d, ev_f, 'Engine crew', 2) RETURNING id INTO n1;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' DA-insert:' || SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_off)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.event_needs (department_id, funding_event_id, role_label, slots_needed) VALUES (d, fe_f, 'Griddle', 1) RETURNING id INTO n2;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' Officer-insert:' || SQLERRM; END;
      IF (SELECT created_by FROM public.event_needs WHERE id = n1) IS DISTINCT FROM m_da OR (SELECT created_by FROM public.event_needs WHERE id = n2) IS DISTINCT FROM m_off THEN
        v_ok := false; v_err := v_err || ' created_by';
      END IF;
      FOREACH v_t IN ARRAY array[e_board, e_pa, e_m1] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_t)::text, true);
        BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
          INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed) VALUES (d, ev_f, 'Forged', 1);
          EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' insert-accepted:' || v_t;
        EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      END LOOP;
      FOREACH v_t IN ARRAY array[e_board, e_m1] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_t)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.event_needs SET role_label = 'Hijacked' WHERE id = n1; GET DIAGNOSTICS v_n = ROW_COUNT;
        DELETE FROM public.event_needs WHERE id = n1; GET DIAGNOSTICS v_n2 = ROW_COUNT;
        EXECUTE 'RESET ROLE';
        IF v_n <> 0 OR v_n2 <> 0 THEN v_ok := false; v_err := v_err || format(' %s-update/delete:%s/%s', v_t, v_n, v_n2); END IF;
      END LOOP;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T1 needs: DA + Officer add (created_by = self); Board / PA / Member refused; Member + Board touch 0 rows' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 needs write gate:%s%s', v_err, chr(10)); END IF;

      -- ---- T2 needs shape (owner — the constraints, not RLS)
      v_ok := true; v_err := '';
      BEGIN INSERT INTO public.event_needs (department_id, recruitment_event_id, funding_event_id, role_label, slots_needed) VALUES (d, ev_f, fe_f, 'Both', 1);
        v_ok := false; v_err := v_err || ' two-parents'; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN INSERT INTO public.event_needs (department_id, role_label, slots_needed) VALUES (d, 'Neither', 1);
        v_ok := false; v_err := v_err || ' no-parent'; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed) VALUES (d, ev_x, 'Cross', 1);
        v_ok := false; v_err := v_err || ' other-dept-event'; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed) VALUES (d, ev_f, 'Zero', 0);
        v_ok := false; v_err := v_err || ' slots0'; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed) VALUES (d, ev_f, 'Many', 51);
        v_ok := false; v_err := v_err || ' slots51'; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN INSERT INTO public.event_needs (department_id, recruitment_event_id, role_label, slots_needed, start_time, end_time) VALUES (d, ev_f, 'Backwards', 1, '14:00', '09:00');
        v_ok := false; v_err := v_err || ' end<start'; EXCEPTION WHEN OTHERS THEN NULL; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 shape: two / no parent, another department''s event, slots 0 / 51, end < start — all refused' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 needs shape accepted:%s%s', v_err, chr(10)); END IF;

      -- ---- T3 claim
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m1)::text, true);
      BEGIN v_res := public.claim_event_need(n2); IF (v_res ->> 'taken')::int <> 1 THEN v_ok := false; v_err := v_err || ' taken:' || v_res::text; END IF;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' claim:' || SQLERRM; END;
      BEGIN PERFORM public.claim_event_need(n2); v_ok := false; v_err := v_err || ' again:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'ALREADY%' THEN v_ok := false; v_err := v_err || ' again:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m2)::text, true);
      BEGIN PERFORM public.claim_event_need(n2); v_ok := false; v_err := v_err || ' full:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'FULL%' THEN v_ok := false; v_err := v_err || ' full:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_in)::text, true);
      BEGIN PERFORM public.claim_event_need(n1); v_ok := false; v_err := v_err || ' inactive:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NO_MEMBER%' THEN v_ok := false; v_err := v_err || ' inactive:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m1)::text, true);
      BEGIN PERFORM public.claim_event_need(n1); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' claim-n1:' || SQLERRM; END;
      IF (SELECT claimed_by FROM public.event_need_claims WHERE need_id = n2 AND member_id = m1) IS DISTINCT FROM m1 THEN v_ok := false; v_err := v_err || ' claimed_by'; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T3 claim: signed up (taken 1, claimed_by = self); again ALREADY; last slot gone FULL; Inactive NO_MEMBER' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 claim:%s%s', v_err, chr(10)); END IF;

      -- ---- T4 the last-slot race: claim + assign take the need row FOR UPDATE
      IF pg_get_functiondef('public.claim_event_need(uuid)'::regprocedure) ILIKE '%department_id = v_dept FOR UPDATE%'
         AND pg_get_functiondef('public.assign_event_need(uuid,uuid)'::regprocedure) ILIKE '%department_id = v_dept FOR UPDATE%' THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T4 claim + assign lock the need row FOR UPDATE before counting' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T4 no FOR UPDATE on the need row' || chr(10); END IF;

      -- ---- T5 unclaim
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m1)::text, true);
      BEGIN v_res := public.unclaim_event_need(n2); IF (v_res ->> 'taken')::int <> 0 THEN v_ok := false; v_err := v_err || ' taken:' || v_res::text; END IF;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' unclaim:' || SQLERRM; END;
      BEGIN PERFORM public.unclaim_event_need(n2); v_ok := false; v_err := v_err || ' again:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_SIGNED_UP%' THEN v_ok := false; v_err := v_err || ' again:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m2)::text, true);
      BEGIN PERFORM public.claim_event_need(n2); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' freed-slot:' || SQLERRM; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T5 unclaim: own row gone (taken 0); again NOT_SIGNED_UP; the freed slot taken by another member' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 unclaim:%s%s', v_err, chr(10)); END IF;

      -- ---- T6 the window (D1)
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m1)::text, true);
      BEGIN PERFORM public.claim_event_need(n_t); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' today:' || SQLERRM; END;
      BEGIN PERFORM public.claim_event_need(n_p); v_ok := false; v_err := v_err || ' past-claim:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CLOSED%' THEN v_ok := false; v_err := v_err || ' past-claim:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.unclaim_event_need(n_p); v_ok := false; v_err := v_err || ' past-unclaim:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CLOSED%' THEN v_ok := false; v_err := v_err || ' past-unclaim:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_off)::text, true);
      BEGIN PERFORM public.assign_event_need(n_p, m3); v_ok := false; v_err := v_err || ' past-assign:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CLOSED%' THEN v_ok := false; v_err := v_err || ' past-assign:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.remove_event_need_claim(c_p); v_ok := false; v_err := v_err || ' past-remove:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'CLOSED%' THEN v_ok := false; v_err := v_err || ' past-remove:' || SQLERRM; END IF; END;
      IF NOT EXISTS (SELECT 1 FROM public.event_need_claims WHERE id = c_p) THEN v_ok := false; v_err := v_err || ' past-claim-row-gone'; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T6 window: today''s event open; yesterday''s CLOSED for claim / unclaim / assign / remove' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T6 window:%s%s', v_err, chr(10)); END IF;

      -- ---- T7 assign / remove
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_off)::text, true);
      BEGIN v_res := public.assign_event_need(n1, m3); c3 := (v_res ->> 'claim_id')::uuid;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' officer-assign:' || SQLERRM; END;
      IF (SELECT claimed_by FROM public.event_need_claims WHERE id = c3) IS DISTINCT FROM m_off THEN v_ok := false; v_err := v_err || ' claimed_by'; END IF;
      FOREACH v_t IN ARRAY array[e_m1, e_board, e_pa] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_t)::text, true);
        BEGIN PERFORM public.assign_event_need(n1, m2); v_ok := false; v_err := v_err || ' assign-accepted:' || v_t;
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_ALLOWED%' THEN v_ok := false; v_err := v_err || ' ' || v_t || ':' || SQLERRM; END IF; END;
      END LOOP;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      BEGIN PERFORM public.assign_event_need(n1, m_x); v_ok := false; v_err := v_err || ' other-dept-member:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_IN_DEPT%' THEN v_ok := false; v_err := v_err || ' other-dept-member:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.assign_event_need(n1, m_in); v_ok := false; v_err := v_err || ' inactive:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_IN_DEPT%' THEN v_ok := false; v_err := v_err || ' inactive:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.assign_event_need(n2, m3); v_ok := false; v_err := v_err || ' full:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'FULL%' THEN v_ok := false; v_err := v_err || ' full:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m1)::text, true);
      BEGIN PERFORM public.remove_event_need_claim(c3); v_ok := false; v_err := v_err || ' member-remove:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_ALLOWED%' THEN v_ok := false; v_err := v_err || ' member-remove:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_off)::text, true);
      BEGIN PERFORM public.remove_event_need_claim(c3); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' officer-remove:' || SQLERRM; END;
      IF EXISTS (SELECT 1 FROM public.event_need_claims WHERE id = c3) THEN v_ok := false; v_err := v_err || ' still-there'; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T7 assign / remove: Officer assigns (claimed_by = Officer) + removes; Member / Board / PA NOT_ALLOWED; other-dept / Inactive NOT_IN_DEPT; full FULL' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T7 assign / remove:%s%s', v_err, chr(10)); END IF;

      -- ---- T8 visibility of sign-ups (FE5.2); no direct writes
      v_ok := true; v_err := '';
      SELECT count(*) INTO v_n2 FROM public.event_need_claims WHERE department_id = d;   -- owner's view
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m3)::text, true);   -- m3 holds no sign-up now
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.event_need_claims;
      EXECUTE 'RESET ROLE';
      IF v_n <> v_n2 OR v_n2 < 3 THEN v_ok := false; v_err := v_err || format(' member-sees:%s-of-%s', v_n, v_n2); END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_x)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.event_need_claims WHERE department_id = d;
      EXECUTE 'RESET ROLE';
      IF v_n <> 0 THEN v_ok := false; v_err := v_err || ' other-dept-sees:' || v_n; END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.event_need_claims (department_id, need_id, member_id, claimed_by) VALUES (d, n1, m3, m3);
        EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' direct-insert';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        DELETE FROM public.event_need_claims WHERE need_id = n1;
        EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' direct-delete';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T8 sign-ups: a member with none of their own sees all %s in the department; another department sees 0; no direct INSERT / DELETE%s', v_n2, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T8 sign-up visibility / writes:%s%s', v_err, chr(10)); END IF;

      -- ---- T9 another department
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m1)::text, true);
      BEGIN PERFORM public.claim_event_need(n_x); v_ok := false; v_err := v_err || ' claim:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; v_err := v_err || ' claim:' || SQLERRM; END IF; END;
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.event_needs WHERE id = n_x;
      EXECUTE 'RESET ROLE';
      IF v_n <> 0 THEN v_ok := false; v_err := v_err || ' need-readable'; END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      BEGIN PERFORM public.assign_event_need(n_x, m1); v_ok := false; v_err := v_err || ' assign:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; v_err := v_err || ' assign:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.remove_event_need_claim(c_x); v_ok := false; v_err := v_err || ' remove:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; v_err := v_err || ' remove:' || SQLERRM; END IF; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T9 another department''s need / sign-up: NOT_FOUND for claim / assign / remove; not readable' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T9 cross-department:%s%s', v_err, chr(10)); END IF;

      -- ---- T10 the guard (D3) — n1 now holds m1 + one more
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      PERFORM public.assign_event_need(n1, m2);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.event_needs SET slots_needed = 1 WHERE id = n1;
        EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' below:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; IF SQLERRM NOT LIKE 'SLOTS_BELOW_CLAIMS%' THEN v_ok := false; v_err := v_err || ' below:' || SQLERRM; END IF; END;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.event_needs SET slots_needed = 4, role_label = 'Engine crew (4)' WHERE id = n1; GET DIAGNOSTICS v_n = ROW_COUNT;
        EXECUTE 'RESET ROLE'; IF v_n <> 1 THEN v_ok := false; v_err := v_err || ' raise:' || v_n; END IF;
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' raise:' || SQLERRM; END;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.event_needs SET recruitment_event_id = ev_t WHERE id = n1;
        EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' move:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; IF SQLERRM NOT LIKE 'PARENT_LOCKED%' THEN v_ok := false; v_err := v_err || ' move:' || SQLERRM; END IF; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T10 guard: slots below sign-ups SLOTS_BELOW_CLAIMS; raising + relabelling fine; moving PARENT_LOCKED' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T10 guard:%s%s', v_err, chr(10)); END IF;

      -- ---- T11 jobs on a community event (FE6)
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.action_items (department_id, text, recruitment_event_id, source_label) VALUES (d, 'FEBRT bring the banner', ev_f, 'FEBRT') RETURNING id INTO ai;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' link:' || SQLERRM; END;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        INSERT INTO public.action_items (department_id, text, recruitment_event_id) VALUES (d, 'FEBRT cross', ev_x);
        EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' cross-link:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      BEGIN PERFORM public.complete_action_item(ai); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' complete:' || SQLERRM; END;
      IF (SELECT status FROM public.action_items WHERE id = ai) IS DISTINCT FROM 'done' THEN v_ok := false; v_err := v_err || ' not-done'; END IF;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        DELETE FROM public.recruitment_events WHERE id = ev_f; GET DIAGNOSTICS v_n = ROW_COUNT;
        EXECUTE 'RESET ROLE'; IF v_n <> 1 THEN v_ok := false; v_err := v_err || ' event-delete:' || v_n; END IF;
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' event-delete:' || SQLERRM; END;
      IF NOT EXISTS (SELECT 1 FROM public.action_items WHERE id = ai AND recruitment_event_id IS NULL AND department_id = d) THEN v_ok := false; v_err := v_err || ' job-not-kept'; END IF;
      IF EXISTS (SELECT 1 FROM public.event_needs WHERE id = n1) OR EXISTS (SELECT 1 FROM public.event_need_claims WHERE need_id = n1) THEN v_ok := false; v_err := v_err || ' needs-not-cascaded'; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T11 jobs: DA links one; cross-department refused; complete works; event delete keeps the job (link NULL), drops needs + sign-ups' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T11 jobs on events:%s%s', v_err, chr(10)); END IF;

      -- ---- T12 the fundraiser-event arm cascades too
      DELETE FROM public.funding_events WHERE id = fe_f;
      IF NOT EXISTS (SELECT 1 FROM public.event_needs WHERE id = n2) AND NOT EXISTS (SELECT 1 FROM public.event_need_claims WHERE need_id = n2) THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T12 deleting a fundraiser event removes its needs + sign-ups' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T12 fundraiser-event needs not cascaded' || chr(10); END IF;

      -- ---- T13 station_presence untouched; verified unchanged
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T13 station_presence byte-identical; verified count %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T13 station_presence changed (verified %s -> %s)%s', v_ver_before, v_ver_after, chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
