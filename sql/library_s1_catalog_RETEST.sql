-- =====================================================================
-- RETEST for library_s1_catalog (Training Library slice 1-DB). READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Every fixture/write lives in a per-department sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in
-- a RAISE that IS the report. NOTHING CHANGES.
--
-- Once:
--   O1 library_drills: RLS on; ONE policy (SELECT TO authenticated, published only); anon nothing; authenticated SELECT on
--      every column but origin_department_id; no INSERT/UPDATE/DELETE for authenticated
--   O2 the 6 seed packets are published (FIRE-203 FIRE-118 EMS-114 EMS-203 LEAD-140 OPS-120), content has the drill keys
--   O3 pull_library_drill + library_drill_usage: SECURITY DEFINER, authenticated-only
--   O4 drill_plans source CHECK = ai|manual|library; library_id ⇒ source 'library'
-- Per department (a REAL Department Admin where one exists, else a fixture; fixture training officer, Officer-not-TO,
-- Board, Project Admin, Member; another department's fixture DA):
--   T1 a member reads exactly the published catalog — a submitted and a withdrawn row stay invisible; origin_department_id
--      can't be selected; anon is refused
--   T2 pull: the DA pulls FIRE-203 → a DRAFT in this department (source library, library_id set, content = the snapshot);
--      a second pull → ALREADY_PULLED; the training officer pulls EMS-114; Officer-not-TO / Board / PA / Member →
--      NOT_ALLOWED; an unpublished drill → NOT_FOUND
--   T3 the pulled draft is a normal drill plan: set_drill_plan edits it (source stays 'library'), approve_drill_plan approves
--   T4 "used" (L3): attached to a finalized + attended session counts; attached to a not-finalized or an unattended one
--      doesn't; a login with no member row gets nothing
--   T5 another department: can't see this department's copy; pulls its own independent copy of the same drill
--   T6 delete the copy → it can be pulled again (D3)
--   T7 station_presence byte-identical; verified count unchanged
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_t text; v_n int; v_n2 int; v_ok boolean; v_err text; v_res uuid; v_row record;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
  d uuid; od uuid; tag text; e_da text; m_da uuid; real_da boolean; e_to text; m_to uuid; e_off text; e_board text; e_pa text; e_mem text; m_mem uuid; e_xda text;
  l_fire uuid; l_ems uuid; l_sub uuid; l_wd uuid; p1 uuid; p2 uuid; p3 uuid; s_ok uuid; s_open uuid; s_empty uuid;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint;
BEGIN
  -- ---------------------------------------------------------------- once
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.library_drills'::regclass)
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'library_drills') = 1
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'library_drills' AND cmd = 'SELECT' AND roles = '{authenticated}'::name[] AND qual LIKE '%published%')
     AND NOT has_table_privilege('anon', 'public.library_drills', 'SELECT')
     AND NOT has_column_privilege('authenticated', 'public.library_drills', 'origin_department_id', 'SELECT')
     AND has_column_privilege('authenticated', 'public.library_drills', 'content', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.library_drills', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.library_drills', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.library_drills', 'DELETE') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 library_drills: RLS, one published-only SELECT policy; anon nothing; origin_department_id unselectable; no writes' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 library_drills RLS / grants' || chr(10); END IF;
  SELECT count(*) INTO v_n FROM public.library_drills WHERE origin = 'seed' AND state = 'published'
     AND code IN ('FIRE-203', 'FIRE-118', 'EMS-114', 'EMS-203', 'LEAD-140', 'OPS-120')
     AND content ?& array['summary', 'objectives', 'run_of_show', 'materials', 'safety'];
  IF v_n = 6 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 the 6 seed packets are published with the drill_plans content keys' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  O2 seed packets: %s of 6%s', v_n, chr(10)); END IF;
  v_ok := true;
  FOREACH v_t IN ARRAY array['public.pull_library_drill(uuid)', 'public.library_drill_usage()'] LOOP
    IF to_regprocedure(v_t) IS NULL OR has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE')
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_t)) THEN v_ok := false; END IF;
  END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 pull + usage: SECURITY DEFINER, authenticated-only' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 RPC privileges' || chr(10); END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'drill_plans_source_chk') = 'CHECK ((source = ANY (ARRAY[''ai''::text, ''manual''::text, ''library''::text])))'
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drill_plans_library_source_chk') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O4 drill_plans source = ai|manual|library; library_id ⇒ source library' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O4 drill_plans CHECKs' || chr(10); END IF;
  SELECT id INTO l_fire FROM public.library_drills WHERE code = 'FIRE-203';
  SELECT id INTO l_ems FROM public.library_drills WHERE code = 'EMS-114';

  -- ---------------------------------------------------------------- per department
  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; tag := 'libs1-' || left(replace(d::text, '-', ''), 8);
    SELECT dep.id INTO od FROM public.departments dep WHERE dep.id <> d ORDER BY dep.name LIMIT 1;
    rpt := rpt || '— ' || rec.name || chr(10);
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
      e_to := tag || '-to@retest.invalid'; e_off := tag || '-off@retest.invalid'; e_board := tag || '-board@retest.invalid';
      e_pa := tag || '-pa@retest.invalid'; e_mem := tag || '-mem@retest.invalid'; e_xda := tag || '-xda@retest.invalid';
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST TO', e_to, '{Member}', 'Active') RETURNING id INTO m_to;
      INSERT INTO public.training_officer (department_id, member_id) VALUES (d, m_to);
      INSERT INTO public.members (department_id, name, email, access, status) VALUES
        (d, 'RETEST Officer', e_off, '{Officer}', 'Active'), (d, 'RETEST Board', e_board, '{Board Member}', 'Active'),
        (d, 'RETEST PA', e_pa, '{Project Admin}', 'Active'), (od, 'RETEST other DA', e_xda, '{Department Admin}', 'Active');
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Member', e_mem, '{Member}', 'Active') RETURNING id INTO m_mem;
      INSERT INTO public.library_drills (code, title, track, content, origin, state) VALUES ('RT-SUB-' || tag, 'RT submitted ' || tag, 'Fire', '{"summary":"s"}', 'shared', 'submitted') RETURNING id INTO l_sub;
      INSERT INTO public.library_drills (code, title, track, content, origin, state) VALUES ('RT-WD-' || tag, 'RT withdrawn ' || tag, 'Fire', '{"summary":"w"}', 'shared', 'withdrawn') RETURNING id INTO l_wd;
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      rpt := rpt || format('   (leader = a %s Department Admin)%s', CASE WHEN real_da THEN 'REAL' ELSE 'fixture' END, chr(10));

      -- ---- T1 reading the catalog
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*), count(*) FILTER (WHERE id IN (l_sub, l_wd)) INTO v_n, v_n2 FROM public.library_drills;
      EXECUTE 'RESET ROLE';
      IF v_n <> (SELECT count(*) FROM public.library_drills WHERE state = 'published') OR v_n2 <> 0 THEN v_ok := false; v_err := v_err || format(' member-sees:%s/unpublished:%s', v_n, v_n2); END IF;
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM origin_department_id FROM public.library_drills LIMIT 1;
        EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' origin_department_id:SELECTABLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      PERFORM set_config('request.jwt.claims', '', true);
      BEGIN EXECUTE 'SET LOCAL ROLE anon';
        PERFORM 1 FROM public.library_drills LIMIT 1;
        EXECUTE 'RESET ROLE'; v_ok := false; v_err := v_err || ' anon:READ';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T1 a member reads the published catalog only; origin_department_id refused; anon refused' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 catalog read:%s%s', v_err, chr(10)); END IF;

      -- ---- T2 pull
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da, 'role', 'authenticated')::text, true);
      BEGIN p1 := public.pull_library_drill(l_fire); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' da-pull:' || SQLERRM; END;
      SELECT * INTO v_row FROM public.drill_plans WHERE id = p1;
      IF v_row.department_id IS DISTINCT FROM d OR v_row.status <> 'draft' OR v_row.source <> 'library' OR v_row.library_id IS DISTINCT FROM l_fire
         OR v_row.content <> (SELECT content FROM public.library_drills WHERE id = l_fire) OR v_row.created_by IS DISTINCT FROM m_da THEN
        v_ok := false; v_err := v_err || ' copy-wrong';
      END IF;
      BEGIN PERFORM public.pull_library_drill(l_fire); v_ok := false; v_err := v_err || ' second:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'ALREADY_PULLED%' THEN v_ok := false; v_err := v_err || ' second:' || SQLERRM; END IF; END;
      BEGIN PERFORM public.pull_library_drill(l_sub); v_ok := false; v_err := v_err || ' unpublished:ACCEPTED';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_FOUND%' THEN v_ok := false; v_err := v_err || ' unpublished:' || SQLERRM; END IF; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_to, 'role', 'authenticated')::text, true);
      BEGIN p2 := public.pull_library_drill(l_ems); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' to-pull:' || SQLERRM; END;
      FOREACH v_t IN ARRAY array[e_off, e_board, e_pa, e_mem] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_t, 'role', 'authenticated')::text, true);
        BEGIN PERFORM public.pull_library_drill((SELECT id FROM public.library_drills WHERE code = 'OPS-120')); v_ok := false; v_err := v_err || ' accepted:' || split_part(v_t, '@', 1);
        EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NOT_ALLOWED%' THEN v_ok := false; v_err := v_err || ' ' || split_part(v_t, '@', 1) || ':' || SQLERRM; END IF; END;
      END LOOP;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 pull: DA + training officer copy a draft (source library, snapshot content); second ALREADY_PULLED; unpublished NOT_FOUND; Officer / Board / PA / Member NOT_ALLOWED' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 pull:%s%s', v_err, chr(10)); END IF;

      -- ---- T3 a pulled draft is a normal drill plan
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.set_drill_plan(p1, 'Primary search — our way', 'RETEST cat', 80, 'Crew', (SELECT content FROM public.drill_plans WHERE id = p1), 'ai');
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' edit:' || SQLERRM; END;
      IF (SELECT source FROM public.drill_plans WHERE id = p1) <> 'library' OR (SELECT library_id FROM public.drill_plans WHERE id = p1) IS DISTINCT FROM l_fire
         OR (SELECT title FROM public.drill_plans WHERE id = p1) <> 'Primary search — our way' THEN v_ok := false; v_err := v_err || ' edit-lost-link'; END IF;
      BEGIN PERFORM public.approve_drill_plan(p1); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' approve:' || SQLERRM; END;
      IF (SELECT status FROM public.drill_plans WHERE id = p1) <> 'approved' THEN v_ok := false; v_err := v_err || ' not-approved'; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T3 the pulled draft edits (source + link kept) and approves like any drill plan' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 edit / approve:%s%s', v_err, chr(10)); END IF;

      -- ---- T4 "used" (L3)
      v_ok := true; v_err := '';
      INSERT INTO public.training_sessions (department_id, title, "date", done) VALUES (d, 'LIBS1 held ' || tag, current_date - 3, true) RETURNING id INTO s_ok;
      INSERT INTO public.training_sessions (department_id, title, "date", done) VALUES (d, 'LIBS1 upcoming ' || tag, current_date + 3, false) RETURNING id INTO s_open;
      INSERT INTO public.training_sessions (department_id, title, "date", done) VALUES (d, 'LIBS1 empty ' || tag, current_date - 4, true) RETURNING id INTO s_empty;
      INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (d, s_ok, m_mem, now()), (d, s_open, m_mem, now());
      INSERT INTO public.session_plans (department_id, session_id, title, source, ai_text, drill_plan_id) VALUES
        (d, s_ok, 'RT', 'ai', 'RT', p1), (d, s_open, 'RT', 'ai', 'RT', p1), (d, s_empty, 'RT', 'ai', 'RT', p1);
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem, 'role', 'authenticated')::text, true);
      SELECT held, departments INTO v_n, v_n2 FROM public.library_drill_usage() WHERE library_id = l_fire;
      IF coalesce(v_n, 0) <> 1 OR coalesce(v_n2, 0) <> 1 THEN v_ok := false; v_err := v_err || format(' usage:%s/%s (want 1/1)', v_n, v_n2); END IF;
      PERFORM set_config('request.jwt.claims', json_build_object('email', tag || '-stranger@retest.invalid', 'role', 'authenticated')::text, true);
      SELECT count(*) INTO v_n FROM public.library_drill_usage();
      IF v_n <> 0 THEN v_ok := false; v_err := v_err || ' stranger-sees:' || v_n; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T4 used = finalized + attended only (1 held, 1 department); upcoming / unattended not counted; a non-member gets nothing' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 usage:%s%s', v_err, chr(10)); END IF;

      -- ---- T5 another department
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_xda, 'role', 'authenticated')::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_n FROM public.drill_plans WHERE id IN (p1, p2);
      EXECUTE 'RESET ROLE';
      IF v_n <> 0 THEN v_ok := false; v_err := v_err || ' sees-our-copy:' || v_n; END IF;
      BEGIN p3 := public.pull_library_drill(l_fire); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' own-pull:' || SQLERRM; END;
      IF (SELECT department_id FROM public.drill_plans WHERE id = p3) IS DISTINCT FROM od THEN v_ok := false; v_err := v_err || ' wrong-dept'; END IF;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T5 another department can''t see this copy and pulls its own' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 cross-department:%s%s', v_err, chr(10)); END IF;

      -- ---- T6 delete then pull again
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_to, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.delete_drill_plan(p2); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' delete:' || SQLERRM; END;
      BEGIN PERFORM public.pull_library_drill(l_ems); EXCEPTION WHEN OTHERS THEN v_ok := false; v_err := v_err || ' re-pull:' || SQLERRM; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T6 a deleted copy can be pulled again' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T6 delete / re-pull:%s%s', v_err, chr(10)); END IF;

      -- ---- T7 station_presence untouched
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T7 station_presence byte-identical; verified count %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T7 station_presence changed (verified %s -> %s)%s', v_ver_before, v_ver_after, chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      BEGIN EXECUTE 'RESET ROLE'; EXCEPTION WHEN OTHERS THEN NULL; END;
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
