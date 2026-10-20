-- =====================================================================
-- RETEST for rls_admin_gate_fix_2026-10-20.sql (applied 2026-10-20) — run AFTER the migration, separately. NOTHING CHANGES: each department's
-- checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on FIXTURES it creates itself — a
-- multi-department admin (a real DA of ANOTHER department, given a plain-member row here and this department as their
-- active one), a fixture announcement (authored by a plain member here) and a fixture duty_log row. The final RAISE is
-- the report. The "ERROR" IS the report. Writes are measured by ROW_COUNT (RLS filters a refused UPDATE / DELETE to
-- 0 rows rather than raising).
--   S0 (once) the four policies read the department-scoped gate; none still uses is_department_admin()
-- Per department B (needs a real DA of B, a plain member of B and a DA of another department, all unique emails):
--   X1 the multi-dept admin (DA elsewhere, plain member here, B active): the PRE-FIX predicate would have let them in
--      (is_department_admin() true, department matches) — the regression-catch — and now every write is refused:
--      announcements UPDATE 0 · announcements DELETE 0 · departments UPDATE 0 · duty_log UPDATE 0
--   X2 the real DA of B: announcements UPDATE 1 · departments UPDATE 1 · duty_log UPDATE 1 · announcements DELETE 1;
--      and another department's departments row 0 (cross-department stays shut)
--   X3 the plain member who authored the announcement: edits their own (1); departments 0; duty_log 0
--   P1 each Project Admin with a row in B (B active): departments UPDATE 1 (the plain swap kept their reach)
-- =====================================================================
DO $retest$
DECLARE
  rec record; pa record; v_ok boolean; v_t text; v_n int; v_old boolean; v_new boolean; v_md uuid; v_mm uuid;
  v_bob text; v_cal text; v_cal_id uuid; v_ada text; v_ada_home uuid; v_ann uuid; v_dl uuid;
  u1 int; u2 int; u3 int; u4 int; b1 int; b2 int; b3 int; b4 int; b5 int; c1 int; c2 int; c3 int;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT string_agg(c.relname || '.' || p.polcmd::text, ',' ORDER BY c.relname, p.polcmd) INTO v_t
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('announcements', 'departments', 'duty_log') AND c.relnamespace = 'public'::regnamespace AND p.polcmd IN ('w', 'd')
     AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ 'is_department_admin';
  SELECT count(*) INTO v_n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('announcements', 'departments', 'duty_log') AND c.relnamespace = 'public'::regnamespace AND p.polcmd IN ('w', 'd')
     AND coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'is_dept_admin\(\)';
  IF v_t IS NULL AND v_n = 4 THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 all 4 policies use the department-scoped is_dept_admin(); none uses is_department_admin()%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 still role-anywhere: %s; scoped: %s/4%s', coalesce(v_t, 'none'), v_n, chr(10)); END IF;

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
      -- fixtures (owner): Ada gets a plain-member row here and this department as her active one
      INSERT INTO public.members (department_id, email, name, access, status) VALUES (rec.dept_id, v_ada, 'RETEST multi-dept admin', array['Member']::text[], 'Active');
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_ada, rec.dept_id)
        ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
      INSERT INTO public.announcements (department_id, author_id, title, body, audience) VALUES (rec.dept_id, v_cal_id, 'RETEST', 'admin-gate fixture', 'everyone') RETURNING id INTO v_ann;
      INSERT INTO public.duty_log (department_id, duty_name) VALUES (rec.dept_id, 'RETEST admin-gate fixture') RETURNING id INTO v_dl;

      -- X1 the multi-dept admin, with this department active
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_ada, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_md := public.my_department_id(); v_mm := public.my_member_id();
      v_old := (v_md = rec.dept_id) AND public.is_department_admin();   -- the PRE-FIX role half + department half
      v_new := (v_md = rec.dept_id) AND public.is_dept_admin();         -- the fixed one
      UPDATE public.announcements SET body = body WHERE id = v_ann; GET DIAGNOSTICS u1 = ROW_COUNT;
      UPDATE public.departments SET name = name WHERE id = rec.dept_id; GET DIAGNOSTICS u2 = ROW_COUNT;
      UPDATE public.duty_log SET duty_name = duty_name WHERE id = v_dl; GET DIAGNOSTICS u3 = ROW_COUNT;
      DELETE FROM public.announcements WHERE id = v_ann; GET DIAGNOSTICS u4 = ROW_COUNT;
      PERFORM set_config('role', 'postgres', true);
      IF v_md = rec.dept_id AND v_old AND NOT v_new AND u1 = 0 AND u2 = 0 AND u3 = 0 AND u4 = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X1 DA-elsewhere / plain member here: the pre-fix gate would have let them in; now announcements U/D, departments U, duty_log U all refused (0 rows)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 active %s old %s new %s ann-upd %s dept-upd %s dlog-upd %s ann-del %s%s', v_md = rec.dept_id, v_old, v_new, u1, u2, u3, u4, chr(10)); END IF;

      -- X3 the plain member who wrote the announcement
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_cal, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      UPDATE public.announcements SET body = body WHERE id = v_ann; GET DIAGNOSTICS c1 = ROW_COUNT;
      UPDATE public.departments SET name = name WHERE id = rec.dept_id; GET DIAGNOSTICS c2 = ROW_COUNT;
      UPDATE public.duty_log SET duty_name = duty_name WHERE id = v_dl; GET DIAGNOSTICS c3 = ROW_COUNT;
      -- X2 the real DA of this department (delete last)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_bob, 'role', 'authenticated')::text, true);
      UPDATE public.announcements SET body = body WHERE id = v_ann; GET DIAGNOSTICS b1 = ROW_COUNT;
      UPDATE public.departments SET name = name WHERE id = rec.dept_id; GET DIAGNOSTICS b2 = ROW_COUNT;
      UPDATE public.duty_log SET duty_name = duty_name WHERE id = v_dl; GET DIAGNOSTICS b3 = ROW_COUNT;
      DELETE FROM public.announcements WHERE id = v_ann; GET DIAGNOSTICS b4 = ROW_COUNT;
      UPDATE public.departments SET name = name WHERE id = v_ada_home; GET DIAGNOSTICS b5 = ROW_COUNT;   -- another department's row
      PERFORM set_config('role', 'postgres', true);
      IF b1 = 1 AND b2 = 1 AND b3 = 1 AND b4 = 1 AND b5 = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X2 the real DA: announcements U + D, departments U, duty_log U all allowed; another department''s row still refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X2 real DA ann-upd %s dept-upd %s dlog-upd %s ann-del %s other-dept-upd %s%s', b1, b2, b3, b4, b5, chr(10)); END IF;
      IF c1 = 1 AND c2 = 0 AND c3 = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  X3 the author edits their own announcement; a plain member can''t touch departments or duty_log%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X3 author ann-upd %s dept-upd %s dlog-upd %s%s', c1, c2, c3, chr(10)); END IF;

      -- P1 each Project Admin with a row here, this department active: the plain swap kept their reach
      v_n := 0; v_t := '';
      FOR pa IN SELECT lower(m.email) AS email FROM public.members m
                 WHERE m.department_id = rec.dept_id AND m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL LOOP
        INSERT INTO public.member_active_department (email, department_id) VALUES (pa.email, rec.dept_id)
          ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
        PERFORM set_config('request.jwt.claims', json_build_object('email', pa.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        UPDATE public.departments SET name = name WHERE id = rec.dept_id; GET DIAGNOSTICS u1 = ROW_COUNT;
        PERFORM set_config('role', 'postgres', true);
        v_n := v_n + 1; IF u1 <> 1 THEN v_t := v_t || ' refused'; END IF;
      END LOOP;
      IF v_n = 0 THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  P1 no Project Admin has a row here%s', chr(10));
      ELSIF v_t = '' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  P1 %s Project Admin(s) with a row here still update the department%s', v_n, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P1 a Project Admin with a row here was refused:%s%s', v_t, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
