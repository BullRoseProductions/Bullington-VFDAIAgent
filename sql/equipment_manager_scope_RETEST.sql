-- =====================================================================
-- RETEST for equipment_manager_scope (DRAFT, not applied) — run AFTER the migration, separately.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). The final
-- RAISE is the report — the "ERROR" IS the report.
-- The ROLE PROBE: mark_equipment_lost(<random id>) tests "is_equipment_manager() OR is_dept_admin()" BEFORE it looks at any
-- item — refused on authority = not a manager here; any other error (no such item) = the role check passed. Conclusive even
-- in a department with no equipment. The write probe: a no-op UPDATE of the department's equipment rows through the
-- "da or manager manage equipment" policy (rows touched = all of them, or 0).
--   S0 (once) is_equipment_manager() is department-scoped (my_member_id() in my_department_id(), no email match), STABLE,
--      SECURITY DEFINER, search_path public, authenticated-only
-- Per department (needs an active equipment manager who is NOT a Department Admin / Project Admin, a plain member, a DA; unique
-- emails):
--   E1 the manager manages in their OWN department: is_equipment_manager() true, the role probe passes, the equipment write
--      probe touches every row of theirs
--   E2 a plain member: false, refused on authority, 0 rows
--   E3 the DA (not a manager): the role probe passes via is_dept_admin(), every row touched
--   X1 THE FIX: the same manager given a member row in ANOTHER department (synthesized inside the rollback) and acting there:
--      is_equipment_manager() false, refused on authority, 0 of that department's equipment rows — then back home: true again.
--      (If the synthetic member row can't be inserted — a members constraint / trigger — X1 is SKIPPED with the reason and the
--      PGlite dry run is the proof.)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_ok boolean; v_n int; v_cnt int; v_b boolean; v_b2 boolean;
  v_mgr text; v_mgr_mid uuid; v_mgr_name text; v_mem text; v_da text; v_other uuid; v_other_cnt int; v_dup uuid;
  e1 text; e2 text; e3 text;
  REFUSED constant text := 'Only an equipment manager or department admin can mark an item lost';
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT position('em.member_id = public.my_member_id()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) > 0
     AND position('em.department_id = public.my_department_id()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) > 0
     AND position('auth.email()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) = 0
     AND (SELECT p.provolatile = 's' AND p.prosecdef AND p.proconfig = array['search_path=public'] FROM pg_proc p WHERE p.oid = 'public.is_equipment_manager()'::regprocedure)
     AND has_function_privilege('authenticated', 'public.is_equipment_manager()'::regprocedure, 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.is_equipment_manager()'::regprocedure, 'EXECUTE')
    INTO v_ok;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 is_equipment_manager() scoped to my_member_id() in my_department_id() (no email match); STABLE, definer, search_path public, authenticated-only%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 is_equipment_manager() shape%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_mgr := NULL; v_mgr_mid := NULL; v_mgr_name := NULL; v_mem := NULL; v_da := NULL; v_other := NULL;
    SELECT lower(m.email), m.id, m.name INTO v_mgr, v_mgr_mid, v_mgr_name FROM public.equipment_manager em JOIN public.members m ON m.id = em.member_id
     WHERE em.department_id = rec.dept_id AND em.removed_at IS NULL AND m.department_id = rec.dept_id AND m.status IN ('Active', 'Probationary')
       AND NOT coalesce(m.access && array['Department Admin','Project Admin']::text[], false) AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_mem FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND NOT EXISTS (SELECT 1 FROM public.equipment_manager em WHERE em.member_id = m.id AND em.removed_at IS NULL)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND NOT EXISTS (SELECT 1 FROM public.equipment_manager em WHERE em.member_id = m.id AND em.removed_at IS NULL)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT d.id INTO v_other FROM public.departments d WHERE d.id <> rec.dept_id
     ORDER BY (SELECT count(*) FROM public.equipment e WHERE e.department_id = d.id) DESC, d.id LIMIT 1;
    IF v_mgr IS NULL OR v_mem IS NULL OR v_da IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs an active equipment manager (not DA / PA), a plain member and a DA here, unique emails (manager %s, member %s, DA %s)%s',
        coalesce(v_mgr, 'none'), coalesce(v_mem, 'none'), coalesce(v_da, 'none'), chr(10));
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_cnt FROM public.equipment WHERE department_id = rec.dept_id;
    SELECT count(*) INTO v_other_cnt FROM public.equipment WHERE department_id = v_other;
    BEGIN
      -- E1 the manager, home department
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT public.is_equipment_manager() INTO v_b;
      e1 := 'ok'; BEGIN PERFORM public.mark_equipment_lost(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      UPDATE public.equipment SET department_id = department_id WHERE department_id = rec.dept_id; GET DIAGNOSTICS v_n = ROW_COUNT;
      PERFORM set_config('role', 'postgres', true);
      IF v_b AND e1 IS DISTINCT FROM REFUSED AND v_n = v_cnt THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  E1 manager in their own department: manager true, role probe passes, writes all %s equipment rows%s', v_cnt, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E1 manager %s · probe: %s · rows %s of %s%s', v_b, e1, v_n, v_cnt, chr(10)); END IF;

      -- E2 a plain member
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT public.is_equipment_manager() INTO v_b;
      e1 := 'ok'; BEGIN PERFORM public.mark_equipment_lost(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      UPDATE public.equipment SET department_id = department_id WHERE department_id = rec.dept_id; GET DIAGNOSTICS v_n = ROW_COUNT;
      PERFORM set_config('role', 'postgres', true);
      IF NOT v_b AND e1 = REFUSED AND v_n = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  E2 plain member: manager false, refused on authority, 0 rows%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E2 manager %s · probe: %s · rows %s%s', v_b, e1, v_n, chr(10)); END IF;

      -- E3 the DA
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; BEGIN PERFORM public.mark_equipment_lost(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      UPDATE public.equipment SET department_id = department_id WHERE department_id = rec.dept_id; GET DIAGNOSTICS v_n = ROW_COUNT;
      PERFORM set_config('role', 'postgres', true);
      IF e1 IS DISTINCT FROM REFUSED AND v_n = v_cnt THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  E3 DA (not a manager): role probe passes via is_dept_admin(), writes all %s rows%s', v_cnt, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E3 probe: %s · rows %s of %s%s', e1, v_n, v_cnt, chr(10)); END IF;

      -- X1 the fix: the manager, synthesized into another department and acting there
      v_dup := NULL; e3 := 'ok';
      BEGIN
        INSERT INTO public.members (department_id, email, name, access, status) VALUES (v_other, v_mgr, coalesce(v_mgr_name, 'RETEST manager') || ' (RETEST second department)', '{Member}', 'Active') RETURNING id INTO v_dup;
      EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      IF v_dup IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  X1 — could not synthesize a second-department member row (%s); the PGlite dry run is the proof%s', left(e3, 120), chr(10));
      ELSE
        INSERT INTO public.member_active_department (email, department_id) VALUES (v_mgr, v_other) ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_mgr, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        SELECT public.my_department_id() = v_other, public.is_equipment_manager() INTO v_b2, v_b;
        e1 := 'ok'; BEGIN PERFORM public.mark_equipment_lost(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
        UPDATE public.equipment SET department_id = department_id WHERE department_id = v_other; GET DIAGNOSTICS v_n = ROW_COUNT;
        PERFORM set_config('role', 'postgres', true);
        UPDATE public.member_active_department SET department_id = rec.dept_id WHERE email = v_mgr;
        PERFORM set_config('role', 'authenticated', true);
        e2 := 'ok'; BEGIN PERFORM public.mark_equipment_lost(gen_random_uuid()); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
        SELECT public.is_equipment_manager() INTO v_ok;
        PERFORM set_config('role', 'postgres', true);
        IF v_b2 AND NOT v_b AND e1 = REFUSED AND v_n = 0 AND v_ok AND e2 IS DISTINCT FROM REFUSED THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  X1 the manager acting in another department: manager false, refused on authority, 0 of its %s equipment rows; back home: manager again%s', v_other_cnt, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 acting there %s · manager %s · probe: %s · rows %s of %s · home manager %s / probe %s%s', v_b2, v_b, e1, v_n, v_other_cnt, v_ok, e2, chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
