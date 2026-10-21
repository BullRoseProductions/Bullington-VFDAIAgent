-- =====================================================================
-- RETEST for cert_write_gate_fix (DRAFT, not applied) — run AFTER the migration, separately.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on a
-- FIXTURE cert it creates itself (for a plain member of the department). The final RAISE is the report — the "ERROR"
-- IS the report. Each RPC call is caught in its own sub-block (its error text recorded); the cert's state is then read
-- back as the owner (name / exp / still there).
--   S0 (once) both functions use is_dept_admin(), neither uses is_department_admin(), both scope to my_department_id()
-- Per department B (needs a real DA of B, a plain member of B and a DA of ANOTHER department A, all unique emails):
--   X1  the DA of A (A active) on B's cert: the PRE-FIX gate would have let them in (is_department_admin() true, and
--       the old `where id = cert_id` matches the row) — the regression-catch — and now update_cert AND delete_cert are
--       refused with 'Certification not found'; the cert is unchanged and still there
--   X1b the same DA of A given a plain-member row in B, B active: refused on authority ('Not authorized …'); unchanged
--   X2  the real DA of B: update_cert renames + re-dates it; delete_cert removes it
--   X3  the plain member of B (the cert's owner): both refused on authority; unchanged
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_t text; v_n int; v_old boolean;
  v_bob text; v_cal text; v_cal_id uuid; v_ada text; v_ada_home uuid; v_cert uuid;
  e1 text; e2 text; v_name text; v_exp text; v_there boolean;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure)
     AND position('public.is_dept_admin()' in prosrc) > 0 AND position('is_department_admin' in prosrc) = 0
     AND position('department_id = public.my_department_id()' in prosrc) > 0;
  IF v_n = 2 THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 update_cert + delete_cert use is_dept_admin(), not is_department_admin(), and scope to my_department_id()%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 only %s/2 functions re-gated and department-scoped%s', v_n, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_bob := NULL; v_cal := NULL; v_cal_id := NULL; v_ada := NULL; v_ada_home := NULL;
    SELECT lower(m.email) INTO v_bob FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_cal, v_cal_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_ada, v_ada_home FROM public.members m WHERE m.department_id <> rec.dept_id
       AND m.access && array['Department Admin']::text[] AND NOT m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_bob IS NULL OR v_cal IS NULL OR v_ada IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA here, a plain member here and a DA of another department, unique emails (DA %s, member %s, other-dept DA %s)%s',
        coalesce(v_bob, 'none'), coalesce(v_cal, 'none'), coalesce(v_ada, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- fixture (owner): a cert of the plain member here; Ada's active department is her own
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_cal_id, 'RETEST cert-gate fixture', '2027-01') RETURNING id INTO v_cert;
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_ada, v_ada_home)
        ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;

      -- X1 the DA of another department, that department active
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_ada, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_old := public.is_department_admin();   -- the PRE-FIX gate (and the old WHERE matched by id alone)
      BEGIN PERFORM public.update_cert(v_cert, 'RETEST X1 renamed', '2030-01'); e1 := 'ok'; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.delete_cert(v_cert); e2 := 'ok'; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT c.name, c.exp INTO v_name, v_exp FROM public.certs c WHERE c.id = v_cert; v_there := FOUND;
      IF v_old AND e1 = 'Certification not found' AND e2 = 'Certification not found' AND v_there AND v_name = 'RETEST cert-gate fixture' AND v_exp = '2027-01' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X1 DA of another department: the pre-fix gate would have let them in; now update + delete both "Certification not found", cert unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 pre-fix gate %s · update: %s · delete: %s · still there %s · name %s · exp %s%s', v_old, e1, e2, v_there, v_name, v_exp, chr(10)); END IF;

      -- X1b the same DA, given a plain-member row here and this department active
      INSERT INTO public.members (department_id, email, name, access, status) VALUES (rec.dept_id, v_ada, 'RETEST multi-dept admin', array['Member']::text[], 'Active');
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_ada, rec.dept_id)
        ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
      PERFORM set_config('role', 'authenticated', true);
      v_old := public.is_department_admin();
      BEGIN PERFORM public.update_cert(v_cert, 'RETEST X1b renamed', '2030-01'); e1 := 'ok'; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.delete_cert(v_cert); e2 := 'ok'; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT c.name, c.exp INTO v_name, v_exp FROM public.certs c WHERE c.id = v_cert; v_there := FOUND;
      IF v_old AND e1 = 'Not authorized to edit certifications' AND e2 = 'Not authorized to delete certifications' AND v_there AND v_name = 'RETEST cert-gate fixture' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X1b DA elsewhere / plain member here (this department active): the pre-fix gate would have let them in; now both refused on authority, cert unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1b pre-fix gate %s · update: %s · delete: %s · still there %s · name %s%s', v_old, e1, e2, v_there, v_name, chr(10)); END IF;

      -- X3 the plain member (the cert's owner)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_cal, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.update_cert(v_cert, 'RETEST X3 renamed', '2030-01'); e1 := 'ok'; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.delete_cert(v_cert); e2 := 'ok'; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT c.name INTO v_name FROM public.certs c WHERE c.id = v_cert; v_there := FOUND;
      IF e1 = 'Not authorized to edit certifications' AND e2 = 'Not authorized to delete certifications' AND v_there AND v_name = 'RETEST cert-gate fixture' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X3 plain member: update + delete both refused on authority, cert unchanged%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X3 update: %s · delete: %s · still there %s · name %s%s', e1, e2, v_there, v_name, chr(10)); END IF;

      -- X2 the real DA of this department (delete last)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_bob, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.update_cert(v_cert, '  RETEST X2 renamed  ', '2030-02'); e1 := 'ok'; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT c.name, c.exp INTO v_name, v_exp FROM public.certs c WHERE c.id = v_cert;
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.delete_cert(v_cert); e2 := 'ok'; EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      v_there := EXISTS (SELECT 1 FROM public.certs c WHERE c.id = v_cert);
      IF e1 = 'ok' AND v_name = 'RETEST X2 renamed' AND v_exp = '2030-02' AND e2 = 'ok' AND NOT v_there THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X2 the real DA: update_cert renamed (trimmed) + re-dated it; delete_cert removed it%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X2 update: %s (name %s, exp %s) · delete: %s · still there %s%s', e1, v_name, v_exp, e2, v_there, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
