-- =====================================================================
-- RETEST for weekly_drill_db_DRAFT.sql. Run AFTER the migration.
-- NOTHING CHANGES: every write happens inside a sub-block that ends in RAISE 'SENTINEL' (rolled back) — the fixture
-- department's toggle, the fixture weekly draft (week 2099-W01), the approval fixtures, the usage counters. No real plan,
-- setting or counter survives. The final RAISE is the report — the "ERROR" IS the report. No email or name is printed.
--
--   G0 shape: toggle column NOT NULL DEFAULT false; source CHECK carries ai_weekly; weekly_key CHECK + unique index;
--      approval CHECK + trigger; put / record = definer, search_path, auth.role() check, service_role-only; set_weekly =
--      definer, authenticated-only; trigger fns not callable by anon/authenticated; ai_dept_call_usage RLS on, no client grant
--   T1 the toggle: a plain member is refused (exact message); a real DA turns it on and off; a DA's direct UPDATE of the
--      column never changes it
--   W1 put, toggle OFF -> {result: disabled}, nothing written
--   W2 put, toggle ON -> inserted: draft, ai_weekly, weekly_key, no author, no approver, title trimmed, blank category NULL
--   W3 put again, same week -> {result: exists}, same id, still one row
--   W4 validation, exact messages: bad week / blank title / non-object content / length 0 / unknown department
--   W5 callers: a signed-in DA has no EXECUTE; a session with no service_role claim gets 'Not authorized'
--   A1 the human-approval law: service_role and a claim-less session UPDATE to approved -> refused; an INSERT born approved
--      -> refused; the draft is still a draft
--   A2 approve_drill_plan as the DA -> approved, approved_by = the DA; as the plain member -> refused
--   A3 the approved plan edited through set_drill_plan -> still approved, same approver (today's flow unchanged)
--   A4 service_role re-attributing an approved plan -> refused
--   A5 unapprove -> draft, approver cleared
--   A6 provenance CHECKs: a manual row with a weekly_key / an ai_weekly row without one -> refused; set_drill_plan can't
--      create ai_weekly
--   R1 record_dept_ai_call: counts (1, 2); at members + cron = 1,500 it refuses (scope department); bad route; a DA has no
--      EXECUTE; no claim -> 'Not authorized'
--   V  station_presence.verified count unchanged
-- =====================================================================
DO $retest$
DECLARE
  v_da text; v_mem text; v_da_id uuid; v_dept uuid; v_dept_name text; v_row record; v_j jsonb; v_j2 jsonb;
  v_id uuid; v_id2 uuid; v_err text; v_n int; v_ok boolean; v_t bigint; v_day date := (now() at time zone 'America/Chicago')::date;
  v_ver_before bigint; v_ver_after bigint;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
  c_week constant text := '2099-W01';
  c_content constant jsonb := '{"summary":"RETEST fixture — rolled back","objectives":["a"],"run_of_show":[],"materials":[],"safety":[]}';
  c_bad constant uuid := '00000000-0000-0000-0000-0000000000ff';
  c_svc constant text := '{"role":"service_role"}';
BEGIN
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;

  -- G0
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('put_weekly_drill_draft', 'record_dept_ai_call')
     AND p.prosecdef AND 'search_path=public' = ANY (coalesce(p.proconfig, '{}')) AND position('auth.role()' in p.prosrc) > 0
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
  IF v_n = 2
     AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_weekly_drill_draft_enabled(boolean)') AND p.prosecdef
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))
     AND NOT has_function_privilege('authenticated', 'public.tg_drill_plans_human_approval()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.tg_departments_weekly_drill_draft_guard()', 'EXECUTE')
     AND (SELECT a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) = 'false' FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
           WHERE a.attrelid = 'public.departments'::regclass AND a.attname = 'weekly_drill_draft_enabled')
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass AND conname = 'drill_plans_source_chk')
         = 'CHECK ((source = ANY (ARRAY[''ai''::text, ''manual''::text, ''library''::text, ''ai_weekly''::text])))'
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass AND conname = 'drill_plans_weekly_key_chk')
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass AND conname = 'drill_plans_approved_by_chk')
         = 'CHECK (((status <> ''approved''::text) OR (approved_by IS NOT NULL)))'
     AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'drill_plans_weekly_key_uniq' AND indexdef LIKE 'CREATE UNIQUE INDEX%(department_id, weekly_key) WHERE (weekly_key IS NOT NULL)')
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.drill_plans'::regclass AND tgname = 'drill_plans_human_approval' AND tgenabled = 'O')
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.departments'::regclass AND tgname = 'departments_weekly_drill_draft_guard' AND tgenabled = 'O')
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_dept_call_usage'::regclass)
     AND NOT (has_table_privilege('anon', 'public.ai_dept_call_usage', 'SELECT') OR has_table_privilege('authenticated', 'public.ai_dept_call_usage', 'SELECT')
              OR has_table_privilege('service_role', 'public.ai_dept_call_usage', 'SELECT') OR has_table_privilege('service_role', 'public.ai_dept_call_usage', 'INSERT')) THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  G0 toggle default off; source has ai_weekly; weekly_key CHECK + unique; approval CHECK + trigger; service-role-only put/record; DA toggle RPC; usage table sealed%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  G0 shape / rights not as expected (service-role fns ok: %s of 2)%s', v_n, chr(10)); END IF;

  -- Actors: a department with a real DA (one membership row for that email, so my_department_id is that department) and a plain
  -- member (not a DA / PA / Officer, not an active training officer, one membership row).
  FOR v_row IN SELECT d.id, d.name FROM public.departments d ORDER BY d.name LOOP
    v_da := NULL; v_mem := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m
     WHERE m.department_id = v_row.id AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL AND m.status IN ('Active', 'Probationary')
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email) AND x.status IN ('Active', 'Probationary')) = 1
     ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_mem FROM public.members m
     WHERE m.department_id = v_row.id AND m.email IS NOT NULL AND m.status IN ('Active', 'Probationary')
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer']::text[], false)
       AND NOT EXISTS (SELECT 1 FROM public.training_officer t WHERE t.member_id = m.id AND t.removed_at IS NULL)
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email) AND x.status IN ('Active', 'Probationary')) = 1
     ORDER BY m.id LIMIT 1;
    IF v_da IS NOT NULL AND v_mem IS NOT NULL THEN v_dept := v_row.id; v_dept_name := v_row.name; EXIT; END IF;
  END LOOP;
  SELECT m.id INTO v_da_id FROM public.members m WHERE lower(m.email) = v_da AND m.department_id = v_dept;

  IF v_dept IS NULL THEN
    v_skip := v_skip + 1; rpt := rpt || format('SKIP  all signed-in checks — no department with a single-membership DA + plain member%s', chr(10));
  ELSE
    rpt := rpt || format('— actors from %s%s', v_dept_name, chr(10));
    BEGIN
      -- T1: the toggle.
      UPDATE public.departments SET weekly_drill_draft_enabled = false WHERE id = v_dept;
      v_ok := true;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_weekly_drill_draft_enabled(true); v_ok := false; v_err := 'member accepted';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Only a Department Admin can turn the weekly AI drill draft on or off.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      BEGIN UPDATE public.departments SET weekly_drill_draft_enabled = true WHERE id = v_dept;
      EXCEPTION WHEN OTHERS THEN NULL; END;    -- refused by the guard, or filtered by RLS: either way it must not change
      PERFORM set_config('role', 'postgres', true);
      IF (SELECT weekly_drill_draft_enabled FROM public.departments WHERE id = v_dept) THEN v_ok := false; v_err := 'a direct UPDATE flipped it'; END IF;
      PERFORM set_config('role', 'authenticated', true);
      BEGIN IF NOT public.set_weekly_drill_draft_enabled(true) THEN v_ok := false; END IF;
            IF public.set_weekly_drill_draft_enabled(false) THEN v_ok := false; END IF;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_ok AND NOT (SELECT weekly_drill_draft_enabled FROM public.departments WHERE id = v_dept) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 member refused (exact message); DA on -> off; a direct UPDATE never flips it%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 -> %s%s', coalesce(v_err, 'state wrong'), chr(10)); END IF;

      -- W1: toggle off -> disabled.
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      BEGIN v_j := public.put_weekly_drill_draft(v_dept, c_week, 'ZZ RETEST weekly', NULL, 60, NULL, c_content); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_j := NULL; v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_j ->> 'result' = 'disabled' AND NOT EXISTS (SELECT 1 FROM public.drill_plans WHERE department_id = v_dept AND weekly_key = c_week) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W1 toggle off -> disabled, nothing written%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W1 -> %s / %s%s', coalesce(v_j::text, '-'), v_err, chr(10)); END IF;

      -- W2: toggle on -> inserted.
      UPDATE public.departments SET weekly_drill_draft_enabled = true WHERE id = v_dept;
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      BEGIN v_j := public.put_weekly_drill_draft(v_dept, c_week, '  ZZ RETEST weekly  ', '  ', 60, NULL, c_content); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_j := NULL; v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      v_id := (v_j ->> 'id')::uuid;
      SELECT * INTO v_row FROM public.drill_plans WHERE id = v_id;
      IF v_j ->> 'result' = 'inserted' AND v_row.status = 'draft' AND v_row.source = 'ai_weekly' AND v_row.weekly_key = c_week
         AND v_row.created_by IS NULL AND v_row.updated_by IS NULL AND v_row.approved_by IS NULL AND v_row.department_id = v_dept
         AND v_row.title = 'ZZ RETEST weekly' AND v_row.category IS NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W2 toggle on -> inserted: draft, ai_weekly, keyed, no author, no approver, trimmed%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W2 -> %s / %s%s', coalesce(v_j::text, '-'), v_err, chr(10)); END IF;

      -- W3: same week again -> exists.
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      BEGIN v_j2 := public.put_weekly_drill_draft(v_dept, c_week, 'ZZ RETEST weekly again', NULL, 30, NULL, c_content); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_j2 := NULL; v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM public.drill_plans WHERE department_id = v_dept AND weekly_key = c_week;
      IF v_j2 ->> 'result' = 'exists' AND (v_j2 ->> 'id')::uuid = v_id AND v_n = 1
         AND (SELECT title FROM public.drill_plans WHERE id = v_id) = 'ZZ RETEST weekly' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W3 same week again -> exists, same id, one row, unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W3 -> %s / rows %s%s', coalesce(v_j2::text, v_err), v_n, chr(10)); END IF;

      -- W4: validation.
      v_ok := true; v_err := NULL;
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      BEGIN PERFORM public.put_weekly_drill_draft(v_dept, '2099-46', 'x', NULL, NULL, NULL, c_content); v_ok := false;
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'The week must look like 2026-W46.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      BEGIN PERFORM public.put_weekly_drill_draft(v_dept, '2099-W02', '   ', NULL, NULL, NULL, c_content); v_ok := false;
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'A drill plan needs a title.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      BEGIN PERFORM public.put_weekly_drill_draft(v_dept, '2099-W02', 'x', NULL, NULL, NULL, '[]'::jsonb); v_ok := false;
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'A drill plan''s content must be a JSON object.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      BEGIN PERFORM public.put_weekly_drill_draft(v_dept, '2099-W02', 'x', NULL, 0, NULL, c_content); v_ok := false;
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'The length must be between 1 and 1440 minutes.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      BEGIN PERFORM public.put_weekly_drill_draft(c_bad, '2099-W02', 'x', NULL, NULL, NULL, c_content); v_ok := false;
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Department not found' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_ok AND NOT EXISTS (SELECT 1 FROM public.drill_plans WHERE department_id = v_dept AND weekly_key = '2099-W02') THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W4 bad week / blank title / non-object / length 0 / unknown department -> the exact messages, nothing written%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W4 -> "%s"%s', coalesce(v_err, 'accepted'), chr(10)); END IF;

      -- W5: callers.
      v_ok := true; v_err := NULL;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.put_weekly_drill_draft(v_dept, '2099-W03', 'x', NULL, NULL, NULL, c_content); v_ok := false; v_err := 'DA accepted';
      EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN OTHERS THEN v_ok := false; v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      PERFORM set_config('request.jwt.claims', '', true);
      BEGIN PERFORM public.put_weekly_drill_draft(v_dept, '2099-W03', 'x', NULL, NULL, NULL, c_content); v_ok := false; v_err := 'no-claim accepted';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Not authorized' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      IF v_ok AND NOT EXISTS (SELECT 1 FROM public.drill_plans WHERE department_id = v_dept AND weekly_key = '2099-W03') THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W5 a signed-in DA has no EXECUTE; a session without the service_role claim -> Not authorized%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W5 -> %s%s', v_err, chr(10)); END IF;

      -- A1: nobody without a member approves.
      v_ok := true; v_err := NULL;
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      BEGIN UPDATE public.drill_plans SET status = 'approved', approved_by = v_da_id, approved_at = now() WHERE id = v_id; v_ok := false; v_err := 'service_role approved';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Only an officer can approve a drill plan, as themselves.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      BEGIN INSERT INTO public.drill_plans (department_id, title, content, status, source, approved_by, approved_at)
            VALUES (v_dept, 'ZZ RETEST born approved', c_content, 'approved', 'manual', v_da_id, now()); v_ok := false; v_err := 'born approved';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Only an officer can approve a drill plan, as themselves.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      PERFORM set_config('role', 'postgres', true);
      PERFORM set_config('request.jwt.claims', '', true);
      BEGIN UPDATE public.drill_plans SET status = 'approved', approved_by = v_da_id, approved_at = now() WHERE id = v_id; v_ok := false; v_err := 'editor approved';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Only an officer can approve a drill plan, as themselves.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      IF v_ok AND (SELECT status FROM public.drill_plans WHERE id = v_id) = 'draft' AND NOT EXISTS (SELECT 1 FROM public.drill_plans WHERE title = 'ZZ RETEST born approved') THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A1 service_role UPDATE / INSERT-approved and a claim-less UPDATE -> refused; still a draft%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 -> %s%s', coalesce(v_err, 'state wrong'), chr(10)); END IF;

      -- A2: a person approves.
      v_ok := true; v_err := NULL;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.approve_drill_plan(v_id); v_ok := false; v_err := 'member approved';
      EXCEPTION WHEN OTHERS THEN NULL; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.approve_drill_plan(v_id);
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO v_row FROM public.drill_plans WHERE id = v_id;
      IF v_ok AND v_row.status = 'approved' AND v_row.approved_by = v_da_id AND v_row.approved_at IS NOT NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A2 approve_drill_plan: plain member refused; the DA approves, approved_by = the DA%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A2 -> %s%s', coalesce(v_err, 'state wrong'), chr(10)); END IF;

      -- A3: edit an approved plan (today's flow) -> still approved, same approver.
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_drill_plan(v_id, 'ZZ RETEST weekly edited', NULL, 45, NULL, c_content, 'ai_weekly'); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO v_row FROM public.drill_plans WHERE id = v_id;
      IF v_err = 'OK' AND v_row.title = 'ZZ RETEST weekly edited' AND v_row.status = 'approved' AND v_row.approved_by = v_da_id AND v_row.source = 'ai_weekly' AND v_row.weekly_key = c_week THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A3 an approved plan edited through set_drill_plan: still approved, same approver, provenance kept%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A3 -> %s%s', v_err, chr(10)); END IF;

      -- A4: re-attribution without a person.
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      BEGIN UPDATE public.drill_plans SET approved_by = c_bad WHERE id = v_id; v_err := 'accepted';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err = 'Only an officer can approve a drill plan, as themselves.' AND (SELECT approved_by FROM public.drill_plans WHERE id = v_id) = v_da_id THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A4 service_role re-attributing an approved plan -> refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A4 -> %s%s', v_err, chr(10)); END IF;

      -- A5: unapprove.
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.unapprove_drill_plan(v_id); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO v_row FROM public.drill_plans WHERE id = v_id;
      IF v_err = 'OK' AND v_row.status = 'draft' AND v_row.approved_by IS NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A5 unapprove -> draft, approver cleared%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A5 -> %s%s', v_err, chr(10)); END IF;

      -- A6: provenance CHECKs.
      v_ok := true; v_err := NULL;
      BEGIN INSERT INTO public.drill_plans (department_id, title, content, source, weekly_key) VALUES (v_dept, 'ZZ RETEST keyed manual', c_content, 'manual', '2099-W04'); v_ok := false; v_err := 'keyed manual';
      EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN INSERT INTO public.drill_plans (department_id, title, content, source) VALUES (v_dept, 'ZZ RETEST unkeyed weekly', c_content, 'ai_weekly'); v_ok := false; v_err := 'unkeyed weekly';
      EXCEPTION WHEN check_violation THEN NULL; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_drill_plan(NULL, 'ZZ RETEST member weekly', NULL, NULL, NULL, c_content, 'ai_weekly'); v_ok := false; v_err := 'set_drill_plan made ai_weekly';
      EXCEPTION WHEN OTHERS THEN NULL; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_ok AND NOT EXISTS (SELECT 1 FROM public.drill_plans WHERE title IN ('ZZ RETEST keyed manual', 'ZZ RETEST unkeyed weekly', 'ZZ RETEST member weekly')) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A6 keyed manual / unkeyed ai_weekly refused by CHECK; set_drill_plan cannot create ai_weekly%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A6 -> %s%s', v_err, chr(10)); END IF;

      -- R1: the department backstop.
      v_ok := true; v_err := NULL;
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      v_j := public.record_dept_ai_call(v_dept, 'claude');
      v_j2 := public.record_dept_ai_call(v_dept, 'claude');
      PERFORM set_config('role', 'postgres', true);
      IF NOT ((v_j ->> 'allowed')::boolean AND (v_j2 ->> 'allowed')::boolean AND (v_j2 ->> 'cron_used')::int = (v_j ->> 'cron_used')::int + 1
              AND (v_j2 ->> 'dept_used')::int = (v_j ->> 'dept_used')::int + 1 AND (v_j ->> 'dept_ceiling')::int = 1500) THEN v_ok := false; v_err := 'counting: ' || v_j::text || ' ' || v_j2::text; END IF;
      -- bring members + cron to exactly 1,499 today (a member row for the DA, inside the rolled-back block), then one more is allowed and the next refused
      SELECT coalesce((SELECT sum(count) FROM public.ai_call_usage WHERE department_id = v_dept AND day = v_day AND route = 'claude'), 0)
           + coalesce((SELECT count FROM public.ai_dept_call_usage WHERE department_id = v_dept AND day = v_day AND route = 'claude'), 0) INTO v_t;
      IF v_t > 1499 THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  R1 ceiling half — the department is already at %s claude calls today%s', v_t, chr(10));
      ELSE
        INSERT INTO public.ai_call_usage (member_id, department_id, day, route, count) VALUES (v_da_id, v_dept, v_day, 'claude', 1499 - v_t)
          ON CONFLICT (member_id, day, route) DO UPDATE SET count = public.ai_call_usage.count + (1499 - v_t);
        PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
        v_j := public.record_dept_ai_call(v_dept, 'claude');
        v_j2 := public.record_dept_ai_call(v_dept, 'claude');
        PERFORM set_config('role', 'postgres', true);
        IF NOT ((v_j ->> 'allowed')::boolean AND (v_j ->> 'dept_used')::int = 1500 AND NOT (v_j2 ->> 'allowed')::boolean
                AND v_j2 ->> 'scope' = 'department' AND (v_j2 ->> 'dept_used')::int = 1500) THEN v_ok := false; v_err := 'ceiling: ' || v_j::text || ' ' || v_j2::text; END IF;
      END IF;
      PERFORM set_config('request.jwt.claims', c_svc, true); PERFORM set_config('role', 'service_role', true);
      BEGIN PERFORM public.record_dept_ai_call(v_dept, 'concepts'); v_ok := false; v_err := 'bad route accepted';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Unknown AI route.' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.record_dept_ai_call(v_dept, 'claude'); v_ok := false; v_err := 'DA accepted';
      EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN OTHERS THEN v_ok := false; v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      PERFORM set_config('request.jwt.claims', '', true);
      BEGIN PERFORM public.record_dept_ai_call(v_dept, 'claude'); v_ok := false; v_err := 'no-claim accepted';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'Not authorized' THEN v_ok := false; v_err := SQLERRM; END IF; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 backstop counts (+1, +1); refuses at 1,500 members + cron (scope department); bad route; DA no EXECUTE; no claim -> Not authorized%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 -> %s%s', v_err, chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('role', 'postgres', true);
      PERFORM set_config('request.jwt.claims', '', true);
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  the fixture block died: %s%s', SQLERRM, chr(10)); END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.drill_plans WHERE title LIKE 'ZZ RETEST%' OR weekly_key LIKE '2099-%') THEN
      v_fail := v_fail + 1; rpt := rpt || format('FAIL  fixtures survived the rollback%s', chr(10));
    ELSE rpt := rpt || format('— fixtures rolled back (no ZZ RETEST / 2099 rows remain)%s', chr(10)); END IF;
  END IF;

  -- V
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after = v_ver_before THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  V  station_presence.verified count unchanged (%s)%s', v_ver_after, chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  V  verified count moved %s -> %s%s', v_ver_before, v_ver_after, chr(10)); END IF;

  RAISE EXCEPTION '%', rpt || format('%s passed / %s failed / %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
