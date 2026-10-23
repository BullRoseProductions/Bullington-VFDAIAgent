-- =====================================================================
-- RETEST for standard_certs (DRAFT, not applied) — run AFTER the migration, separately.
-- RAN on live 2026-10-23: 19 passed, 0 failed, 2 skipped — S0; Indian Harbor + Lipan + North Hood M1 A1–A5;
-- Demo + Granbury skip all (no plain member). Standard certs DB fully proven on live.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). No
-- fixtures needed beyond what the RPC itself writes. The final RAISE is the report — the "ERROR" IS the report.
-- Standard rows are picked whose name the department doesn't already have (so a live catalog can't make it skip).
--   S0 (once) the master list: 69 rows (sffma 24 · tcfp 32 · ems 5 · cards 8); add_standard_cert_type authenticated-only
-- Per department (needs a DA, a plain member and a DA of ANOTHER department, unique emails):
--   M1 a plain member reads the whole master list (69 rows) through the SELECT policy, and can't write it
--   A1 the DA adds a never-expires standard (SFFMA) and an expiring one (Texas EMS): each lands in THIS department's
--      dept_cert_types() with the standard's name / never_expires / category, created_by = the DA's member row
--   A2 the same standard again → "That cert type is already in your catalog."; an unknown id → "not found"
--   A3 a plain member → "Only a Department Admin can manage cert types."; nothing added
--   A4 a DA of another department adds the same standard → it lands in THEIR department; this one's count is unchanged
--   A5 the copy is an ordinary cert_types row: set_cert_type edits it, delete_cert_type removes it; the master row is
--      untouched
-- =====================================================================
DO $retest$
DECLARE
  rec record; r record; v_ok boolean; v_n int; v_n2 int;
  v_da text; v_da_mid uuid; v_mem text; v_ada text; v_ada_home uuid; v_s1 uuid; v_s2 uuid; v_c1 uuid; v_c2 uuid; v_o uuid;
  e1 text; e2 text; e3 text; v_txt text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT string_agg(track || ' ' || n, ' · ' ORDER BY track) INTO v_txt FROM (SELECT track, count(*) AS n FROM public.standard_cert_types GROUP BY track) s;
  SELECT has_function_privilege('authenticated', 'public.add_standard_cert_type(uuid)'::regprocedure, 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.add_standard_cert_type(uuid)'::regprocedure, 'EXECUTE') INTO v_ok;
  IF v_txt = 'cards 8 · ems 5 · sffma 24 · tcfp 32' AND v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 master list 69 rows (%s); add_standard_cert_type authenticated-only%s', v_txt, chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 tracks %s · grants ok %s%s', v_txt, v_ok, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_da_mid := NULL; v_mem := NULL; v_ada := NULL; v_ada_home := NULL;
    SELECT lower(m.email), m.id INTO v_da, v_da_mid FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_mem FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_ada, v_ada_home FROM public.members m WHERE m.department_id <> rec.dept_id
       AND m.access && array['Department Admin']::text[] AND NOT m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_mem IS NULL OR v_ada IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA here, a plain member here and a DA of another department, unique emails (DA %s, member %s, other-dept DA %s)%s',
        coalesce(v_da, 'none'), coalesce(v_mem, 'none'), coalesce(v_ada, 'none'), chr(10));
      CONTINUE;
    END IF;
    -- a never-expires SFFMA standard and an expiring EMS one that neither this department nor the other already has
    SELECT s.id INTO v_s1 FROM public.standard_cert_types s WHERE s.track = 'sffma' AND s.never_expires
       AND NOT EXISTS (SELECT 1 FROM public.cert_types t WHERE t.department_id IN (rec.dept_id, v_ada_home) AND lower(btrim(t.name)) = lower(btrim(s.name))) ORDER BY s.sort_order LIMIT 1;
    SELECT s.id INTO v_s2 FROM public.standard_cert_types s WHERE s.track = 'ems' AND NOT s.never_expires
       AND NOT EXISTS (SELECT 1 FROM public.cert_types t WHERE t.department_id = rec.dept_id AND lower(btrim(t.name)) = lower(btrim(s.name))) ORDER BY s.sort_order LIMIT 1;
    IF v_s1 IS NULL OR v_s2 IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — every candidate standard is already in this catalog%s', chr(10)); CONTINUE;
    END IF;
    BEGIN
      -- M1 a plain member reads the master list; can't write it
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.standard_cert_types;
      e1 := 'ok';
      BEGIN INSERT INTO public.standard_cert_types (track, name, never_expires, category) VALUES ('cards', 'RETEST member write', true, 'certification'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      UPDATE public.standard_cert_types SET never_expires = NOT never_expires WHERE id = v_s1; GET DIAGNOSTICS v_n2 = ROW_COUNT;
      -- A3 (as the same plain member) the RPC refuses
      e2 := 'ok';
      BEGIN PERFORM public.add_standard_cert_type(v_s1); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 69 AND e1 ILIKE '%row-level security%' AND v_n2 = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  M1 plain member reads all 69 standard rows; an INSERT is refused by RLS, an UPDATE touches 0 rows%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M1 reads %s · insert: %s · update rows %s%s', v_n, e1, v_n2, chr(10)); END IF;
      IF e2 = 'Only a Department Admin can manage cert types.' AND NOT EXISTS (SELECT 1 FROM public.cert_types c JOIN public.standard_cert_types s ON s.id = v_s1
                                                                               WHERE c.department_id = rec.dept_id AND lower(btrim(c.name)) = lower(btrim(s.name))) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A3 plain member: add_standard_cert_type refused on authority; nothing added%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A3 member add: %s%s', e2, chr(10)); END IF;

      -- A1 the DA adds two standards
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; v_c1 := NULL; v_c2 := NULL;
      BEGIN
        SELECT (public.add_standard_cert_type(v_s1)).id INTO v_c1;
        SELECT (public.add_standard_cert_type(v_s2)).id INTO v_c2;
      EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      SELECT count(*) INTO v_n FROM public.dept_cert_types() x JOIN public.standard_cert_types s ON lower(btrim(s.name)) = lower(btrim(x.name))
       WHERE (x.id = v_c1 AND s.id = v_s1 AND x.never_expires AND x.category = 'certification')
          OR (x.id = v_c2 AND s.id = v_s2 AND NOT x.never_expires AND x.category = 'certification');
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'ok' AND v_n = 2 AND (SELECT count(*) FROM public.cert_types WHERE id IN (v_c1, v_c2) AND department_id = rec.dept_id AND created_by = v_da_mid AND updated_by = v_da_mid) = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A1 DA adds a never-expires SFFMA + an expiring EMS standard; both in this catalog with the standard''s name / flag / category, created_by the DA%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 add: %s · matching rows %s%s', e1, v_n, chr(10)); END IF;

      -- A2 the clash, and an unknown id
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok';
      BEGIN PERFORM public.add_standard_cert_type(v_s1); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.add_standard_cert_type(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'That cert type is already in your catalog.' AND e2 = 'That standard cert type was not found.' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A2 the same standard twice → "already in your catalog"; an unknown id → "not found"%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A2 twice: %s · unknown: %s%s', e1, e2, chr(10)); END IF;

      -- A4 a DA of another department adds the same standard — to THEIR catalog
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_ada, v_ada_home) ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
      SELECT count(*) INTO v_n FROM public.cert_types WHERE department_id = rec.dept_id;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_ada, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; v_o := NULL;
      BEGIN SELECT (public.add_standard_cert_type(v_s1)).id INTO v_o; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'ok' AND (SELECT department_id FROM public.cert_types WHERE id = v_o) = v_ada_home
         AND (SELECT count(*) FROM public.cert_types WHERE department_id = rec.dept_id) = v_n THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A4 a DA of another department adds the same standard — it lands in their catalog; this one is unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A4 other-dept add: %s · landed in %s%s', e1, (SELECT department_id FROM public.cert_types WHERE id = v_o), chr(10)); END IF;

      -- A5 the copy is an ordinary row (the DA again)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok';
      BEGIN PERFORM public.set_cert_type(v_c1, 'RETEST renamed standard', false, 'continuing_education'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      SELECT x.name, x.never_expires, x.category INTO r FROM public.dept_cert_types() x WHERE x.id = v_c1;
      BEGIN PERFORM public.delete_cert_type(v_c2); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'ok' AND r.name = 'RETEST renamed standard' AND r.never_expires IS FALSE AND r.category = 'continuing_education' AND e2 = 'ok'
         AND NOT EXISTS (SELECT 1 FROM public.cert_types WHERE id = v_c2)
         AND (SELECT never_expires AND category = 'certification' FROM public.standard_cert_types WHERE id = v_s1)
         AND (SELECT count(*) FROM public.standard_cert_types) = 69 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A5 the copy edits via set_cert_type and deletes via delete_cert_type; the master row is untouched (still 69)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A5 edit: %s (%s) · delete: %s%s', e1, row_to_json(r), e2, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
