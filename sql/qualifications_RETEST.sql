-- =====================================================================
-- RETEST for qualifications_2026-10-18.sql (Phase 3.1 #3). Run AFTER the migration, separately. NOTHING CHANGES: each department's
-- checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on FIXTURE qualification types it creates.
-- The final RAISE is the report. The "ERROR" IS the report.
--   Z0 (once) anon can't execute any RPC; members can't execute the internal qualification_cells
-- Per department (needs a DA, two plain members with unique emails and one non-deleted apparatus; an Officer, a Board
-- Member and another department's DA are used when present, else that check SKIPs):
--   C1 config: a member / an Officer can't set up types (DA / PA); the DA creates an apparatus-driver type (target 3)
--      and a position type; bad shapes refused (position + apparatus, driver without apparatus, target on a position,
--      another department's apparatus, a duplicate name)
--   M1 matrix (as the DA): both types listed; A not_started on both; the member list = an independent honest count
--      (not Inactive / former / Project Admin); a member is refused the matrix
--   D1 drives: A can't log their own; the DA logs one for A -> in_progress, 1 drive (and ONLY toward that type);
--      supervisor = the member refused;
--      a future date refused; a position type refused; a void stops it counting -> back to not_started
--   S1 sign-off: A can't sign their own; the DA can't sign their own; the DA signs A -> qualified (signed-by name);
--      a second sign-off refused; A's my_qualifications shows qualified + the drive count
--   R1 revoke: a reason is required; revoke -> not qualified, the row kept with revoked_*; a re-sign clears it
--   L1 lock: once used, the driver type's apparatus can't change (rename still works); deactivating hides it from the
--      matrix and my_qualifications and refuses new sign-offs / drives
--   V1 visibility: B can't read A's member_qualifications row but CAN read the department's types; A reads their own;
--      direct INSERTs on both tables refused
--   X1 another department's DA: sign / revoke / log for A refused; can't edit this department's type; their matrix has no A
--   O1 an Officer logs a drive and signs off (DA / Officer); a Board Member can't (SKIP when there's none)
--   P1 decision #1: the qualification drive is also counted as probation supervised time (probation_status)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_e2 text; v_e3 text; v_e4 text; v_n int; v_m int; v_k int; v_js jsonb; v_ok boolean; v_t text;
  v_da text; v_off text; v_board text; v_a text; v_b text; v_other_da text; v_da_id uuid; v_a_id uuid; v_b_id uuid;
  v_app uuid; v_app2 uuid; v_other_app uuid; v_drv uuid; v_pos uuid; v_sess uuid;
  v_today date := (now() at time zone 'America/Chicago')::date;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- Z0
  v_ok := true;
  FOREACH v_t IN ARRAY array['public.set_qualification_type(uuid,text,text,uuid,integer,integer,boolean)', 'public.sign_qualification(uuid,uuid,text)',
      'public.revoke_qualification(uuid,uuid,text)', 'public.log_qualification_drive(uuid,uuid,numeric,date,uuid,text)',
      'public.my_qualifications()', 'public.dept_qualification_matrix()'] LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN v_ok := false; END IF;
  END LOOP;
  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    BEGIN PERFORM * FROM public.qualification_cells(gen_random_uuid(), NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    PERFORM set_config('role', 'anon', true);
    BEGIN PERFORM public.dept_qualification_matrix(); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
    PERFORM set_config('role', 'postgres', true);
  END;
  IF v_ok AND v_err ILIKE '%permission denied%' AND v_e2 ILIKE '%permission denied%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  Z0 anon can''t execute the RPCs; members can''t execute qualification_cells%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  Z0 grants %s internal "%s" anon "%s"%s', v_ok, v_err, v_e2, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_board := NULL; v_a := NULL; v_b := NULL; v_other_da := NULL; v_da_id := NULL; v_a_id := NULL; v_b_id := NULL;
    v_app := NULL; v_app2 := NULL; v_other_app := NULL;
    SELECT lower(m.email), m.id INTO v_da, v_da_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_board FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Board Member']::text[]
       AND NOT m.access && array['Department Admin','Project Admin','Officer']::text[] AND m.status IN ('Active', 'Probationary')
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
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT a.id INTO v_app FROM public.apparatus a WHERE a.department_id = rec.dept_id AND a.deleted_at IS NULL ORDER BY a.id LIMIT 1;
    SELECT a.id INTO v_app2 FROM public.apparatus a WHERE a.department_id = rec.dept_id AND a.deleted_at IS NULL AND a.id <> v_app ORDER BY a.id LIMIT 1;
    SELECT a.id INTO v_other_app FROM public.apparatus a WHERE a.department_id <> rec.dept_id AND a.deleted_at IS NULL ORDER BY a.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL OR v_b IS NULL OR v_app IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA, two plain members with unique emails and an apparatus (DA %s, A %s, B %s, apparatus %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), coalesce(v_b, 'none'), CASE WHEN v_app IS NULL THEN 'none' ELSE 'yes' END, chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- C1 config
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_qualification_type(NULL, 'RETEST member type', 'position'); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_e4 := 'n/a';
      IF v_off IS NOT NULL THEN
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.set_qualification_type(NULL, 'RETEST officer type', 'position'); v_e4 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e4 := SQLERRM; END;
      END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      v_drv := (public.set_qualification_type(NULL, 'RETEST Driver', 'apparatus_driver', v_app, 3, 1, true)).id;
      v_pos := (public.set_qualification_type(NULL, 'RETEST Interior', 'position', NULL, NULL, 2, true)).id;
      v_n := 0;
      BEGIN PERFORM public.set_qualification_type(NULL, 'RETEST bad1', 'position', v_app); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      BEGIN PERFORM public.set_qualification_type(NULL, 'RETEST bad2', 'apparatus_driver', NULL); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      BEGIN PERFORM public.set_qualification_type(NULL, 'RETEST bad3', 'position', NULL, 5); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      IF v_other_app IS NOT NULL THEN
        BEGIN PERFORM public.set_qualification_type(NULL, 'RETEST bad4', 'apparatus_operator', v_other_app); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      ELSE v_n := v_n + 1; END IF;
      BEGIN PERFORM public.set_qualification_type(NULL, '  retest DRIVER ', 'position'); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only a Department Admin%' AND (v_e4 = 'n/a' OR v_e4 LIKE 'Only a Department Admin%') AND v_drv IS NOT NULL AND v_pos IS NOT NULL AND v_n = 5 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  C1 member%s refused; DA creates a driver + a position type; 5 bad shapes refused%s', CASE WHEN v_e4 = 'n/a' THEN '' ELSE ' + Officer' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C1 member "%s" officer "%s" types %s/%s bad-refused %s of 5%s', v_err, v_e4, v_drv, v_pos, v_n, chr(10)); END IF;

      -- M1 matrix
      SELECT count(*) INTO v_m FROM public.members m WHERE m.department_id = rec.dept_id AND m.status IS DISTINCT FROM 'Inactive'
         AND NOT coalesce(m.access && array['Project Admin']::text[], false) AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.dept_qualification_matrix();
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.dept_qualification_matrix(); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM jsonb_array_elements(v_js->'cells') c
       WHERE (c->>'member_id')::uuid = v_a_id AND (c->>'type_id')::uuid IN (v_drv, v_pos) AND c->>'status' = 'not_started';
      IF (SELECT count(*) FROM jsonb_array_elements(v_js->'types') t WHERE (t->>'id')::uuid IN (v_drv, v_pos)) = 2 AND v_n = 2
         AND jsonb_array_length(v_js->'members') = v_m AND v_err LIKE 'Only department leadership%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  M1 matrix: both types, A not_started on both; %s members = honest count; member refused%s', v_m, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M1 A-not-started %s members %s vs %s member "%s"%s', v_n, jsonb_array_length(v_js->'members'), v_m, v_err, chr(10)); END IF;

      -- D1 drives
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.log_qualification_drive(v_a_id, v_drv, 1, v_today); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      v_sess := (public.log_qualification_drive(v_a_id, v_drv, 1.5, v_today - 2, NULL, 'RETEST')).id;
      PERFORM set_config('role', 'postgres', true);   -- qualification_cells is internal: read it as the owner
      SELECT c.status || '/' || c.drives INTO v_e2 FROM public.qualification_cells(rec.dept_id, v_a_id) c WHERE c.type_id = v_drv;
      SELECT c.status || '/' || c.drives INTO v_e4 FROM public.qualification_cells(rec.dept_id, v_a_id) c WHERE c.type_id = v_pos;   -- the drive counts toward ITS type only
      PERFORM set_config('role', 'authenticated', true);
      v_n := 0;
      BEGIN PERFORM public.log_qualification_drive(v_a_id, v_drv, 1, v_today, v_a_id); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'A member can''t supervise%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.log_qualification_drive(v_a_id, v_drv, 1, v_today + 1); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'The date must be%' THEN v_n := v_n + 1; END IF; END;
      BEGIN PERFORM public.log_qualification_drive(v_a_id, v_pos, 1, v_today); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'Drives are logged against%' THEN v_n := v_n + 1; END IF; END;
      PERFORM public.void_supervised_session(v_sess, 'RETEST void');
      PERFORM set_config('role', 'postgres', true);
      SELECT c.status || '/' || c.drives INTO v_e3 FROM public.qualification_cells(rec.dept_id, v_a_id) c WHERE c.type_id = v_drv;
      IF v_err LIKE 'Only a Department Admin or Officer%' AND v_e2 = 'in_progress/1' AND v_e4 = 'not_started/0' AND v_n = 3 AND v_e3 = 'not_started/0'
         AND (SELECT kind || '/' || apparatus_id || '/' || counts_toward FROM public.supervised_sessions WHERE id = v_sess) = 'drive/' || v_app || '/' || v_drv THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  D1 member refused; DA logs -> in_progress/1 (drive row on the type''s apparatus); 3 bad drives refused; void -> not_started/0%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D1 member "%s" after-log %s (other type %s) bad-refused %s after-void %s%s', v_err, v_e2, v_e4, v_n, v_e3, chr(10)); END IF;

      -- S1 sign-off
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.log_qualification_drive(v_a_id, v_drv, 2, v_today - 1);
      BEGIN PERFORM public.sign_qualification(v_da_id, v_drv, NULL); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      PERFORM public.sign_qualification(v_a_id, v_drv, 'RETEST ready');
      BEGIN PERFORM public.sign_qualification(v_a_id, v_drv, NULL); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.sign_qualification(v_a_id, v_pos, NULL); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      v_js := public.my_qualifications();
      PERFORM set_config('role', 'postgres', true);
      v_t := (SELECT e->>'status' || '/' || (e->>'drives') || '/' || coalesce(e->>'signed_off_by_name', '-') FROM jsonb_array_elements(v_js) e WHERE (e->>'type_id')::uuid = v_drv);
      IF v_err LIKE 'Only a Department Admin or Officer%' AND v_e2 LIKE 'You can''t sign off your own%' AND v_e3 LIKE 'They''re already signed off%'
         AND v_t = 'qualified/1/' || (SELECT name FROM public.members WHERE id = v_da_id) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  S1 member + own sign-off refused; DA signs A -> qualified (%s); double sign refused%s', v_t, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  S1 member "%s" own "%s" again "%s" mine %s%s', v_err, v_e2, v_e3, v_t, chr(10)); END IF;

      -- R1 revoke + re-sign
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.revoke_qualification(v_a_id, v_drv, '  '); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM public.revoke_qualification(v_a_id, v_drv, 'RETEST: needs another check ride');
      PERFORM set_config('role', 'postgres', true);
      SELECT c.status INTO v_e2 FROM public.qualification_cells(rec.dept_id, v_a_id) c WHERE c.type_id = v_drv;
      SELECT count(*) INTO v_n FROM public.member_qualifications WHERE member_id = v_a_id AND qualification_type_id = v_drv AND revoked_by = v_da_id AND revoke_reason LIKE 'RETEST:%';
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.sign_qualification(v_a_id, v_drv, NULL);
      PERFORM set_config('role', 'postgres', true);
      SELECT c.status INTO v_e3 FROM public.qualification_cells(rec.dept_id, v_a_id) c WHERE c.type_id = v_drv;
      IF v_err LIKE 'Say why%' AND v_e2 = 'in_progress' AND v_n = 1 AND v_e3 = 'qualified'
         AND (SELECT revoked_at FROM public.member_qualifications WHERE member_id = v_a_id AND qualification_type_id = v_drv) IS NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 blank reason refused; revoke -> in_progress, row kept with the reason; re-sign -> qualified%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 blank "%s" after-revoke %s trail %s after-resign %s%s', v_err, v_e2, v_n, v_e3, chr(10)); END IF;

      -- L1 lock + deactivate
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_err := 'n/a';
      IF v_app2 IS NOT NULL THEN
        BEGIN PERFORM public.set_qualification_type(v_drv, 'RETEST Driver', 'apparatus_driver', v_app2, 3, 1, true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      END IF;
      BEGIN PERFORM public.set_qualification_type(v_drv, 'RETEST Driver (renamed)', 'apparatus_driver', v_app, 4, 1, true); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      PERFORM public.set_qualification_type(v_pos, 'RETEST Interior', 'position', NULL, NULL, 2, false);
      v_js := public.dept_qualification_matrix();
      BEGIN PERFORM public.sign_qualification(v_a_id, v_pos, NULL); v_e3 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e3 := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      v_n := (SELECT count(*) FROM jsonb_array_elements(public.my_qualifications()) e WHERE (e->>'type_id')::uuid = v_pos);
      PERFORM set_config('role', 'postgres', true);
      IF (v_err = 'n/a' OR v_err LIKE 'This qualification already has%') AND v_e2 = 'OK' AND v_e3 LIKE 'That qualification is not set up%' AND v_n = 0
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_js->'types') t WHERE (t->>'id')::uuid = v_pos)
         AND (SELECT name FROM public.qualification_types WHERE id = v_drv) = 'RETEST Driver (renamed)' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  L1 used type: apparatus locked%s, rename ok; deactivated type hidden + refuses sign-off%s', CASE WHEN v_err = 'n/a' THEN ' (n/a — one apparatus)' ELSE '' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  L1 change-apparatus "%s" rename "%s" inactive-sign "%s" mine %s%s', v_err, v_e2, v_e3, v_n, chr(10)); END IF;

      -- V1 visibility + direct writes
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.member_qualifications WHERE member_id = v_a_id;
      SELECT count(*) INTO v_m FROM public.qualification_types WHERE id IN (v_drv, v_pos);
      BEGIN INSERT INTO public.member_qualifications (member_id, department_id, qualification_type_id, signed_off_by) VALUES (v_b_id, rec.dept_id, v_drv, v_a_id); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN INSERT INTO public.qualification_types (department_id, name, kind) VALUES (rec.dept_id, 'RETEST direct', 'position'); v_e2 := 'OK';
      EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      SELECT count(*) INTO v_k FROM public.member_qualifications WHERE member_id = v_a_id;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 0 AND v_m = 2 AND v_k = 1 AND v_err ILIKE '%permission denied%' AND v_e2 ILIKE '%permission denied%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  V1 B can''t read A''s sign-off but reads the types; A reads their own; direct INSERTs refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  V1 B-sees-A %s B-types %s A-own %s insert "%s" / "%s"%s', v_n, v_m, v_k, v_err, v_e2, chr(10)); END IF;

      -- X1 another department's DA
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  X1 — no other-department DA%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        v_n := 0;
        BEGIN PERFORM public.sign_qualification(v_a_id, v_drv, NULL); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
        BEGIN PERFORM public.revoke_qualification(v_a_id, v_drv, 'x'); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
        BEGIN PERFORM public.log_qualification_drive(v_a_id, v_drv, 1, v_today); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
        BEGIN PERFORM public.set_qualification_type(v_drv, 'hijack', 'apparatus_driver', v_app, 3, 1, true); EXCEPTION WHEN OTHERS THEN v_n := v_n + 1; END;
        v_js := public.dept_qualification_matrix();
        PERFORM set_config('role', 'postgres', true);
        IF v_n = 4 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_js->'members') x WHERE (x->>'member_id')::uuid = v_a_id)
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_js->'types') x WHERE (x->>'id')::uuid = v_drv)
           AND (SELECT name FROM public.qualification_types WHERE id = v_drv) = 'RETEST Driver (renamed)' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  X1 another department''s DA: sign / revoke / log / edit refused; A and the type not on their matrix%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 refused %s of 4%s', v_n, chr(10)); END IF;
      END IF;

      -- O1 Officer can; Board can't
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  O1 — no Officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.log_qualification_drive(v_b_id, v_drv, 1, v_today); PERFORM public.sign_qualification(v_b_id, v_drv, NULL); v_err := 'OK';
        EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        v_e2 := 'n/a';
        IF v_board IS NOT NULL THEN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_board, 'role', 'authenticated')::text, true);
          BEGIN PERFORM public.revoke_qualification(v_b_id, v_drv, 'board try'); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
        END IF;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' AND (v_e2 = 'n/a' OR v_e2 LIKE 'Only a Department Admin or Officer%') THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  O1 an Officer logs + signs off%s%s', CASE WHEN v_e2 = 'n/a' THEN '' ELSE '; a Board Member can''t revoke' END, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  O1 officer "%s" board "%s"%s', v_err, v_e2, chr(10)); END IF;
      END IF;

      -- P1 decision #1: the qualification drive is also probation supervised time
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_js := public.member_probation_status(v_a_id);
      PERFORM set_config('role', 'postgres', true);
      IF (v_js->>'supervised_hours')::numeric = (SELECT coalesce(sum(hours), 0) FROM public.supervised_sessions WHERE member_id = v_a_id AND voided_at IS NULL) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  P1 qualification drives count as probation supervised time (%s h; the voided one doesn''t)%s', v_js->>'supervised_hours', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P1 probation supervised %s%s', v_js->>'supervised_hours', chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
