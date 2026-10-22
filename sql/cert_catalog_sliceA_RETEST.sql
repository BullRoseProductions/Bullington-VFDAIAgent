-- =====================================================================
-- RETEST for cert_catalog_sliceA (applied 2026-10-21) — run AFTER the migration, separately.
-- RAN on live 2026-10-21: 22 passed, 0 failed, 5 skipped — S0; Indian Harbor + Lipan + North Hood T1 T2 T2b T3 T4 T5 T6;
-- Demo + Granbury skip all (no plain member); T3b skipped in all three (onboarding_items.category is NOT NULL on live —
-- the minimal fixture item couldn't be inserted) — closed by sql/cert_catalog_sliceA_RETEST_T3b.sql: live 3/0/2, 2026-10-21.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on
-- FIXTURES it creates itself: two certs for a plain member of the department (one blank exp, one long-expired
-- '2020-01'), each named 'RETEST cert-catalog …'. The final RAISE is the report — the "ERROR" IS the report.
-- The readers are called as the owner with the caller's JWT claims set (expiration_rows / probation_item_states are
-- internal — members can't EXECUTE them); writes and the catalog read go through the RPCs as the role 'authenticated'.
--   S0 (once) the table (RLS on, 1 policy, empty), the FK column, the 4 RPCs, no anon EXECUTE on any of them or on
--      dept_cert_readiness
-- Per department (needs a DA, a plain member and a DA of ANOTHER department, unique emails):
--   T1 the DA: set_cert_type creates a never-expires continuing_education type; a same-name (case / spaces) second
--      add is refused with the friendly message; a bad category is refused; an edit (p_id) persists
--   T2 the DA: assign_cert_type links both fixture certs; dept_cert_types() lists the type with cert_count 2;
--      T2b linking a cert to ANOTHER department's type is refused
--   T3 readers: expiration_rows → both certs 'no_expiry' (expires_on NULL, days_until NULL), never no_date / expired;
--      readiness_window('no_expiry', NULL) = 'no_expiry'; dept_cert_readiness() no_expiry = the department's
--      never-expires certs counted directly, no_date excludes them; probation_item_states → a kind='cert' item naming
--      the fixture reads satisfied / 'current' (SKIP if a fixture onboarding item can't be inserted)
--   T4 the DA of another department: set_cert_type (edit), delete_cert_type, assign_cert_type on this department's
--      type / cert all refused; nothing changed
--   T5 the plain member: dept_cert_types() reads the catalog; set_cert_type / assign / delete refused on authority;
--      a direct INSERT into cert_types refused by RLS
--   T6 the DA: delete_cert_type → both certs survive with cert_type_id NULL and read as before (no_date / expired)
-- =====================================================================
DO $retest$
DECLARE
  rec record; r record; v_n int; v_ok boolean; v_t text;
  v_da text; v_mem text; v_mem_id uuid; v_ada text; v_ada_home uuid; v_type uuid; v_c1 uuid; v_c2 uuid; v_item uuid;
  e1 text; e2 text; e3 text; e4 text; v_b1 text; v_b2 text; x1 date; x2 date; v_dcr record; v_direct int;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cert_types'::regclass)
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cert_types') = 1
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'certs' AND column_name = 'cert_type_id' AND is_nullable = 'YES')
     AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_cert_type', 'delete_cert_type', 'dept_cert_types', 'assign_cert_type')
            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) = 4
     AND NOT has_function_privilege('anon', 'public.dept_cert_readiness()'::regprocedure, 'EXECUTE')
    INTO v_ok;
  SELECT count(*) INTO v_n FROM public.cert_types;
  IF v_ok AND v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 cert_types (RLS on, 1 policy, empty) · certs.cert_type_id nullable · 4 RPCs authenticated-only · dept_cert_readiness no anon EXECUTE%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 shape %s · cert_types rows %s%s', v_ok, v_n, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_mem := NULL; v_mem_id := NULL; v_ada := NULL; v_ada_home := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_mem, v_mem_id FROM public.members m WHERE m.department_id = rec.dept_id
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
    BEGIN
      -- fixtures (owner)
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_mem_id, 'RETEST cert-catalog blank', NULL) RETURNING id INTO v_c1;
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_mem_id, 'RETEST cert-catalog old', '2020-01') RETURNING id INTO v_c2;

      -- T1 the DA manages the catalog
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok'; v_type := NULL;
      BEGIN SELECT (public.set_cert_type(NULL, 'RETEST Hazmat Awareness', true, 'continuing_education')).id INTO v_type; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.set_cert_type(NULL, '  retest hazmat AWARENESS ', false, 'certification'); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN PERFORM public.set_cert_type(NULL, 'RETEST other', false, 'bogus'); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      BEGIN PERFORM public.set_cert_type(v_type, 'RETEST Hazmat Awareness (OPS)', true, 'continuing_education'); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT t.name, t.never_expires, t.category, t.department_id INTO r FROM public.cert_types t WHERE t.id = v_type;
      IF e1 = 'ok' AND e4 = 'ok' AND e2 LIKE 'Your department already has a cert type named%' AND e3 LIKE 'Unknown category%'
         AND r.name = 'RETEST Hazmat Awareness (OPS)' AND r.never_expires AND r.category = 'continuing_education' AND r.department_id = rec.dept_id THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 DA creates a never-expires continuing_education type; a duplicate name (case / spaces) and a bad category are refused; an edit persists%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 create: %s · dup: %s · bad cat: %s · edit: %s · row %s%s', e1, e2, e3, e4, row_to_json(r), chr(10)); END IF;

      -- T2 assign both fixtures; the catalog read counts them
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok';
      BEGIN PERFORM public.assign_cert_type(v_c1, v_type); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.assign_cert_type(v_c2, v_type); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      SELECT x.cert_count INTO v_n FROM public.dept_cert_types() x WHERE x.id = v_type;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'ok' AND e2 = 'ok' AND v_n = 2 AND (SELECT count(*) FROM public.certs WHERE id IN (v_c1, v_c2) AND cert_type_id = v_type) = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T2 DA assigns the type to both fixture certs; dept_cert_types() shows cert_count 2%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 assign 1: %s · assign 2: %s · cert_count %s%s', e1, e2, v_n, chr(10)); END IF;

      -- T2b the DA can't link this department's cert to ANOTHER department's type (owner-made fixture type there)
      INSERT INTO public.cert_types (department_id, name, never_expires) VALUES (v_ada_home, 'RETEST foreign type', true) RETURNING id INTO v_t;
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok';
      BEGIN PERFORM public.assign_cert_type(v_c1, v_t::uuid); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'That cert type is not in your department.' AND (SELECT cert_type_id FROM public.certs WHERE id = v_c1) = v_type THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T2b DA can''t link a cert to another department''s type ("not in your department"); the link is unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2b foreign-type assign: %s%s', e1, chr(10)); END IF;

      -- T3 the readers (as owner, DA claims set)
      SELECT e.bucket, e.expires_on INTO v_b1, x1 FROM public.expiration_rows(rec.dept_id, v_mem_id) e WHERE e.item_id = v_c1;
      SELECT e.bucket, e.expires_on INTO v_b2, x2 FROM public.expiration_rows(rec.dept_id, v_mem_id) e WHERE e.item_id = v_c2;
      SELECT count(*) INTO v_n FROM public.expiration_rows(rec.dept_id, NULL) e WHERE e.item_id IN (v_c1, v_c2) AND e.bucket = 'no_expiry' AND e.days_until IS NULL;
      SELECT * INTO v_dcr FROM public.dept_cert_readiness();
      SELECT count(*) INTO v_direct FROM public.certs c JOIN public.cert_types t ON t.id = c.cert_type_id AND t.department_id = c.department_id
       WHERE c.department_id = rec.dept_id AND t.never_expires;
      IF v_b1 = 'no_expiry' AND v_b2 = 'no_expiry' AND x1 IS NULL AND x2 IS NULL AND v_n = 2 AND public.readiness_window('no_expiry', NULL) = 'no_expiry'
         AND v_dcr.no_expiry = v_direct AND v_direct >= 2
         AND v_dcr.no_date = (SELECT count(*) FROM public.certs c LEFT JOIN public.cert_types t ON t.id = c.cert_type_id AND t.department_id = c.department_id
                               WHERE c.department_id = rec.dept_id AND NOT coalesce(t.never_expires, false) AND (c.exp IS NULL OR c.exp !~ '^\d{4}-\d{2}$')) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 expiration_rows: both no_expiry (no date) for the member and the roster; readiness_window passes it through; dept_cert_readiness no_expiry %s = counted directly, no_date excludes them%s', v_direct, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 blank %s/%s · old %s/%s · roster %s · window %s · dcr no_expiry %s vs %s · dcr no_date %s%s',
        v_b1, x1, v_b2, x2, v_n, public.readiness_window('no_expiry', NULL), v_dcr.no_expiry, v_direct, v_dcr.no_date, chr(10)); END IF;
      -- probation: a fixture kind='cert' item naming the blank cert
      BEGIN
        INSERT INTO public.onboarding_items (department_id, label, kind, cert_name) VALUES (rec.dept_id, 'RETEST cert-catalog item', 'cert', 'RETEST cert-catalog blank') RETURNING id INTO v_item;
        SELECT p.satisfied, p.state INTO r FROM public.probation_item_states(v_mem_id, rec.dept_id) p WHERE p.item_id = v_item;
        IF r.satisfied AND r.state = 'current' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3b probation_item_states: a cert item matched to a never-expires (blank-exp) cert reads satisfied / current%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3b probation satisfied %s · state %s%s', r.satisfied, r.state, chr(10)); END IF;
      EXCEPTION WHEN OTHERS THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  T3b couldn''t insert a fixture onboarding item (%s)%s', SQLERRM, chr(10));
      END;

      -- T4 a DA of another department, their own department active
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_ada, v_ada_home)
        ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_ada, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok';
      BEGIN PERFORM public.set_cert_type(v_type, 'RETEST hijack', false, 'certification'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.assign_cert_type(v_c1, NULL); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN PERFORM public.delete_cert_type(v_type); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'That cert type is not in your department.' AND e2 = 'Certification not found' AND e3 = 'That cert type is not in your department.'
         AND EXISTS (SELECT 1 FROM public.cert_types WHERE id = v_type AND name = 'RETEST Hazmat Awareness (OPS)')
         AND (SELECT count(*) FROM public.certs WHERE id IN (v_c1, v_c2) AND cert_type_id = v_type) = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T4 DA of another department: edit / assign / delete all refused ("not in your department" / "not found"); nothing changed%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 edit: %s · assign: %s · delete: %s%s', e1, e2, e3, chr(10)); END IF;

      -- T5 the plain member
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok';
      SELECT count(*) INTO v_n FROM public.dept_cert_types() x WHERE x.id = v_type;
      BEGIN PERFORM public.set_cert_type(NULL, 'RETEST member type', false, 'certification'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.assign_cert_type(v_c1, NULL); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN PERFORM public.delete_cert_type(v_type); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      BEGIN INSERT INTO public.cert_types (department_id, name) VALUES (rec.dept_id, 'RETEST direct'); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 1 AND e1 = 'Only a Department Admin can manage cert types.' AND e2 = 'Only a Department Admin can assign cert types.'
         AND e3 = 'Only a Department Admin can manage cert types.' AND e4 ILIKE '%row-level security%'
         AND NOT EXISTS (SELECT 1 FROM public.cert_types WHERE name IN ('RETEST member type', 'RETEST direct')) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T5 plain member reads the catalog; set / assign / delete refused on authority; a direct INSERT refused by RLS%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 reads %s · set: %s · assign: %s · delete: %s · direct: %s%s', v_n, e1, e2, e3, e4, chr(10)); END IF;

      -- T6 the DA deletes the type: certs survive, unlinked, reading as before
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok';
      BEGIN PERFORM public.delete_cert_type(v_type); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT e.bucket INTO v_b1 FROM public.expiration_rows(rec.dept_id, v_mem_id) e WHERE e.item_id = v_c1;
      SELECT e.bucket INTO v_b2 FROM public.expiration_rows(rec.dept_id, v_mem_id) e WHERE e.item_id = v_c2;
      IF e1 = 'ok' AND NOT EXISTS (SELECT 1 FROM public.cert_types WHERE id = v_type)
         AND (SELECT count(*) FROM public.certs WHERE id IN (v_c1, v_c2) AND cert_type_id IS NULL) = 2 AND v_b1 = 'no_date' AND v_b2 = 'expired' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T6 DA deletes the type: both certs survive, unlinked, and read no_date / expired again%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T6 delete: %s · blank reads %s · old reads %s%s', e1, v_b1, v_b2, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
