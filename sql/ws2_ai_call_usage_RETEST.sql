-- =====================================================================
-- RETEST for ws2_ai_call_usage (WS-2 DB half). READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Every fixture lives in a per-department sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in a
-- RAISE that IS the report. NOTHING CHANGES. The "ERROR" is the report.
--
-- Once:
--   O1 ai_call_usage: RLS on, 0 policies, no anon / authenticated SELECT/INSERT/UPDATE/DELETE; PK (member_id, day, route)
--   O2 record_ai_call: SECURITY DEFINER, search_path=public, anon can't EXECUTE, authenticated can
--   O3 the four pinned functions (my_member_id, my_department_id, record_assistant_turn, record_image_generation) byte-identical
-- Per department (fixtures: an Active member M, a second Active member B for the backstop, an Inactive member I, and an
-- email with NO member row N):
--   T1 member under cap: M calls claude → allowed, used 1, ceiling 150; a second call → used 2
--   T2 over the member cap: M at 30 concepts today → allowed:false, scope member (the API answers 429; the model is never called)
--   T3 the claude department backstop: the department at 1,500 today → M is refused, scope department — though M is under 150
--   T4 non-member: N (no member row) and I (Inactive) both RAISE "could not match" (the API answers 403)
--   T5 an unknown route RAISES
--   T6 the ruled ceilings: claude 150 · concepts 30 · assistant 60 · image 20 (fresh member, one call each)
--   T7 anon can't EXECUTE record_ai_call
--   T8 the table is unreadable by authenticated (M's SELECT is denied)
--   T9 station_presence byte-identical; verified unchanged; the monthly ceilings' tables untouched by record_ai_call
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_ok boolean; v_err text;
  rec record; d uuid; dn text; tag text;
  e_m text; e_b text; e_i text; e_n text; e_f text; m_m uuid; m_b uuid; m_i uuid; m_f uuid;
  r jsonb; r2 jsonb; k int; v_day date := (now() at time zone 'America/Chicago')::date;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint; v_au_before text; v_au_after text; v_ig_before text; v_ig_after text;
  v_ceil text;
BEGIN
  -- ---------------------------------------------------------------- once
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_call_usage'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_call_usage')
     AND NOT (SELECT bool_or(has_table_privilege(ro, 'public.ai_call_usage', p)) FROM unnest(array['anon', 'authenticated']) ro, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p)
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.ai_call_usage'::regclass AND contype = 'p') = 'PRIMARY KEY (member_id, day, route)' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 ai_call_usage: RLS on, no policies, no anon/authenticated access; PK (member_id, day, route)' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 ai_call_usage RLS / policies / grants / PK not as intended' || chr(10); END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_ai_call(text)'::regprocedure)
     AND (SELECT proconfig FROM pg_proc WHERE oid = 'public.record_ai_call(text)'::regprocedure) = ARRAY['search_path=public']
     AND NOT has_function_privilege('anon', 'public.record_ai_call(text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.record_ai_call(text)', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 record_ai_call: definer, search_path=public, authenticated-only' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 record_ai_call privileges / definer / search_path' || chr(10); END IF;

  IF md5(pg_get_functiondef('public.my_member_id()'::regprocedure)) = '3f66369c8af7bc07ec59831af6536fee'
     AND md5(pg_get_functiondef('public.my_department_id()'::regprocedure)) = '87f546659c3804a943b48e419e017f18'
     AND md5(pg_get_functiondef('public.record_assistant_turn()'::regprocedure)) = 'fc69fdaf65f51072cbdd8c1400e85467'
     AND md5(pg_get_functiondef('public.record_image_generation(text)'::regprocedure)) = '668c0a92223cd8187264c5f469844d69' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 the four pinned functions are byte-identical' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 a pinned function changed' || chr(10); END IF;

  -- ---------------------------------------------------------------- per department
  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; dn := rec.name; tag := 'ws2rt-' || left(replace(d::text, '-', ''), 8);
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      SELECT md5(coalesce(string_agg(to_jsonb(u)::text, '|' ORDER BY u.department_id, u.period_month), '')) INTO v_au_before FROM public.assistant_usage u;
      SELECT md5(coalesce(string_agg(to_jsonb(u)::text, '|' ORDER BY u.department_id, u.period_month), '')) INTO v_ig_before FROM public.image_gen_usage u;
      e_m := tag || '-m@retest.invalid'; e_b := tag || '-b@retest.invalid'; e_i := tag || '-i@retest.invalid'; e_n := tag || '-nomember@retest.invalid';
      e_f := tag || '-f@retest.invalid';
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST M', e_m, '{Member}', 'Active') RETURNING id INTO m_m;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST B', e_b, '{Member}', 'Active') RETURNING id INTO m_b;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Inactive', e_i, '{Member}', 'Inactive') RETURNING id INTO m_i;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Fresh', e_f, '{Member}', 'Probationary') RETURNING id INTO m_f;

      -- ---- T1 under cap
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        r := public.record_ai_call('claude'); r2 := public.record_ai_call('claude');
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND (r->>'allowed')::boolean AND (r->>'used')::int = 1 AND (r->>'ceiling')::int = 150 AND (r2->>'used')::int = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T1 under cap: claude allowed (used 1 then 2, ceiling 150)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 under cap: %s / %s %s%s', r, r2, v_err, chr(10)); END IF;

      -- ---- T2 over the member cap (concepts 30)
      INSERT INTO public.ai_call_usage (member_id, department_id, day, route, count) VALUES (m_m, d, v_day, 'concepts', 30);
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        r := public.record_ai_call('concepts');
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND NOT (r->>'allowed')::boolean AND r->>'scope' = 'member' AND (r->>'used')::int = 30 AND (r->>'ceiling')::int = 30
         AND (SELECT count FROM public.ai_call_usage WHERE member_id = m_m AND day = v_day AND route = 'concepts') = 30 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 over the member cap: concepts at 30 → refused (scope member), count stays 30' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 over cap: %s %s%s', r, v_err, chr(10)); END IF;

      -- ---- T3 the claude department backstop (1,500)
      INSERT INTO public.ai_call_usage (member_id, department_id, day, route, count)
        VALUES (m_b, d, v_day, 'claude', 1500 - coalesce((SELECT sum(count) FROM public.ai_call_usage WHERE department_id = d AND day = v_day AND route = 'claude'), 0)::int);
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        r := public.record_ai_call('claude');
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND NOT (r->>'allowed')::boolean AND r->>'scope' = 'department' AND (r->>'dept_used')::int = 1500 AND (r->>'dept_ceiling')::int = 1500 AND (r->>'used')::int = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || '   PASS  T3 department backstop: claude at 1,500 for the department → M refused (scope department) at 2 of 150' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 backstop: %s %s%s', r, v_err, chr(10)); END IF;

      -- ---- T4 non-member + Inactive
      v_ok := true; v_err := '';
      FOREACH v_ceil IN ARRAY ARRAY[e_n, e_i] LOOP
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_ceil)::text, true);
        BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
          r := public.record_ai_call('claude');
          EXECUTE 'RESET ROLE';
          v_ok := false; v_err := v_err || ' ' || v_ceil || ' was allowed: ' || r::text;
        EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE';
          IF SQLERRM NOT LIKE 'We could not match your login%' THEN v_ok := false; v_err := v_err || ' ' || SQLERRM; END IF;
        END;
      END LOOP;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T4 no member row / Inactive member → "could not match your login" (403 at the API)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 non-member:%s%s', v_err, chr(10)); END IF;

      -- ---- T5 unknown route
      v_ok := false; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        r := public.record_ai_call('gpt');
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := SQLERRM = 'Unknown AI route.'; v_err := SQLERRM; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T5 an unknown route raises' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 unknown route: %s%s', v_err, chr(10)); END IF;

      -- ---- T6 the ruled ceilings (a fresh member, one call per route)
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_f)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        v_ceil := (public.record_ai_call('concepts')->>'ceiling') || '/' || (public.record_ai_call('assistant')->>'ceiling') || '/' || (public.record_ai_call('image')->>'ceiling');
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND v_ceil = '30/60/20' THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T6 ceilings: concepts 30 · assistant 60 · image 20 (claude 150, T1)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T6 ceilings %s %s%s', v_ceil, v_err, chr(10)); END IF;

      -- ---- T7 anon can't execute
      v_ok := false; v_err := '';
      PERFORM set_config('request.jwt.claims', '', true);
      BEGIN EXECUTE 'SET LOCAL ROLE anon';
        r := public.record_ai_call('claude');
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := SQLERRM LIKE 'permission denied%'; v_err := SQLERRM; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T7 anon can''t execute record_ai_call' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T7 anon: %s%s', coalesce(nullif(v_err, ''), 'executed'), chr(10)); END IF;

      -- ---- T8 the table is unreadable by authenticated
      v_ok := false; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_m)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM count(*) FROM public.ai_call_usage;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := SQLERRM LIKE 'permission denied%'; v_err := SQLERRM; END;
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T8 ai_call_usage unreadable by authenticated' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T8 authenticated read the table %s%s', v_err, chr(10)); END IF;

      -- ---- T9 untouched
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      SELECT md5(coalesce(string_agg(to_jsonb(u)::text, '|' ORDER BY u.department_id, u.period_month), '')) INTO v_au_after FROM public.assistant_usage u;
      SELECT md5(coalesce(string_agg(to_jsonb(u)::text, '|' ORDER BY u.department_id, u.period_month), '')) INTO v_ig_after FROM public.image_gen_usage u;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before AND v_au_after = v_au_before AND v_ig_after = v_ig_before THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T9 station_presence byte-identical; verified %s unchanged; monthly ceilings untouched%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T9 station_presence / verified / a monthly ceiling table changed' || chr(10); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
