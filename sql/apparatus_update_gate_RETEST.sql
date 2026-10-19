-- =====================================================================
-- RETEST for apparatus_update_gate_2026-10-18.sql (the apparatus UPDATE policy -> DA / Officer only). Run AFTER the migration,
-- RAN on live 2026-10-18: 20 passed, 0 failed, 4 skipped — IH / Lipan / NH: K1 (a member's real start -> mark -> finalize)
-- U1 U2 U3 U5 R1 pass; U4 passes in NH, skipped in IH + Lipan (no Board Member with a unique email); Demo + Granbury
-- skip all (no plain member).
-- separately. NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled
-- back), on a FIXTURE rig + checklist item it creates itself — no real truck or open check is touched. The final RAISE
-- is the report. The "ERROR" IS the report.
--   G0 (once) exactly one apparatus UPDATE policy, department-scoped AND is_canmanage_ops(); the old one gone
-- Per department (needs a DA and a plain member with unique emails; an Officer, a Board Member and another
-- department's DA are used when present, else that check SKIPs):
--   K1 a MEMBER still runs a full check: start_or_resume_check -> mark_check_item (pass) -> finalize_check, and the
--      rig's status / last_check_at / checked_by update (the definer RPCs are unaffected)
--   U1 a MEMBER's direct UPDATE of apparatus changes nothing (0 rows): name, in_service, deleted_at
--   U2 the DA's direct UPDATE of their department's apparatus works (1 row) — the admin edit keeps working
--   U3 an Officer's direct UPDATE works (1 row)          U4 a Board Member's direct UPDATE changes nothing (0 rows)
--   U5 another department's DA can't update this department's rig (0 rows)
--   R1 the check-interval setter + take-out-of-service still work for the DA (definer RPCs, unchanged)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_e2 text; v_n int; v_m int; v_k int; v_ok boolean; v_check uuid; v_rig uuid; v_item uuid;
  v_da text; v_off text; v_board text; v_a text; v_other_da text; v_da_id uuid; v_a_id uuid;
  v_before record; v_after record;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- G0
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND cmd IN ('UPDATE', 'ALL')) = 1
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'ops update apparatus'
                   AND position('my_department_id()' in qual) > 0 AND position('is_canmanage_ops()' in qual) > 0
                   AND position('my_department_id()' in with_check) > 0 AND position('is_canmanage_ops()' in with_check) > 0)
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'members update apparatus') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  G0 one apparatus UPDATE policy: department AND is_canmanage_ops(); the member-wide one is gone%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  G0 apparatus UPDATE policies are not as expected%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_board := NULL; v_a := NULL; v_other_da := NULL; v_da_id := NULL; v_a_id := NULL;
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
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_da FROM public.members m WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and a plain member with unique emails (DA %s, member %s)%s', coalesce(v_da, 'none'), coalesce(v_a, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- fixture: a rig + one active checklist item (owner inserts)
      INSERT INTO public.apparatus (department_id, name, type, status, in_service, note)
      VALUES (rec.dept_id, 'RETEST rig', 'Pumper', 'Needs attention', true, 'RETEST fixture') RETURNING id INTO v_rig;
      INSERT INTO public.apparatus_check_items (department_id, apparatus_id, label, sort_order, active)
      VALUES (rec.dept_id, v_rig, 'RETEST item', 1, true) RETURNING id INTO v_item;

      -- K1 a member runs a full check
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN
        v_check := public.start_or_resume_check(v_rig);
        PERFORM public.mark_check_item(v_check, v_item, 'pass', NULL);
        PERFORM public.finalize_check(v_check);
        v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT status, last_check_at, checked_by INTO v_after FROM public.apparatus WHERE id = v_rig;
      IF v_err = 'OK' AND v_after.status = 'Pass' AND v_after.last_check_at IS NOT NULL AND v_after.checked_by = v_a_id
         AND (SELECT state FROM public.apparatus_checks WHERE id = v_check) = 'finalized' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  K1 a member runs a full check (start -> mark -> finalize); the rig reads Pass, checked by them%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  K1 check "%s" rig status %s checked_by %s%s', v_err, v_after.status, v_after.checked_by, chr(10)); END IF;

      -- U1 a member's direct UPDATE changes nothing
      SELECT name, in_service, deleted_at INTO v_before FROM public.apparatus WHERE id = v_rig;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_k := 0;
      BEGIN UPDATE public.apparatus SET name = 'hijacked' WHERE id = v_rig; GET DIAGNOSTICS v_n = ROW_COUNT; v_k := v_k + v_n; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN UPDATE public.apparatus SET in_service = false WHERE id = v_rig; GET DIAGNOSTICS v_n = ROW_COUNT; v_k := v_k + v_n; EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN UPDATE public.apparatus SET deleted_at = now() WHERE id = v_rig; GET DIAGNOSTICS v_n = ROW_COUNT; v_k := v_k + v_n; EXCEPTION WHEN OTHERS THEN NULL; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT name, in_service, deleted_at INTO v_after FROM public.apparatus WHERE id = v_rig;
      IF v_k = 0 AND v_after.name = v_before.name AND v_after.in_service = v_before.in_service AND v_after.deleted_at IS NOT DISTINCT FROM v_before.deleted_at THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  U1 a member''s direct UPDATE changes nothing (name / in_service / deleted_at: 0 rows)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  U1 member updated %s row(s); name %s in_service %s deleted_at %s%s', v_k, v_after.name, v_after.in_service, v_after.deleted_at, chr(10)); END IF;

      -- U2 the DA's direct UPDATE works
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN UPDATE public.apparatus SET name = 'RETEST rig (DA edit)' WHERE id = v_rig; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err = 'OK' AND v_n = 1 AND (SELECT name FROM public.apparatus WHERE id = v_rig) = 'RETEST rig (DA edit)' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  U2 the DA''s direct edit of their department''s rig works (1 row)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  U2 DA -> "%s" rows %s%s', v_err, v_n, chr(10)); END IF;

      -- U3 Officer
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  U3 — no Officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN UPDATE public.apparatus SET note = 'RETEST officer edit' WHERE id = v_rig; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'OK' AND v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  U3 an Officer''s direct edit works (1 row)%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  U3 Officer -> "%s" rows %s%s', v_err, v_n, chr(10)); END IF;
      END IF;

      -- U4 Board Member
      IF v_board IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  U4 — no Board Member with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_board, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN UPDATE public.apparatus SET note = 'board try' WHERE id = v_rig; GET DIAGNOSTICS v_n = ROW_COUNT; EXCEPTION WHEN OTHERS THEN v_n := 0; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  U4 a Board Member''s direct edit changes nothing (0 rows)%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  U4 Board updated %s row(s)%s', v_n, chr(10)); END IF;
      END IF;

      -- U5 another department's DA
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  U5 — no other-department DA%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN UPDATE public.apparatus SET name = 'cross-dept' WHERE id = v_rig; GET DIAGNOSTICS v_n = ROW_COUNT; EXCEPTION WHEN OTHERS THEN v_n := 0; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_n = 0 AND (SELECT name FROM public.apparatus WHERE id = v_rig) = 'RETEST rig (DA edit)' THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  U5 another department''s DA can''t edit this rig (0 rows)%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  U5 cross-dept updated %s row(s)%s', v_n, chr(10)); END IF;
      END IF;

      -- R1 the other definer RPCs still work for the DA
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_apparatus_check_interval(v_rig, 14); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN PERFORM public.take_apparatus_out_of_service(v_rig, 'RETEST'); v_e2 := 'OK'; EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err = 'OK' AND v_e2 = 'OK' AND (SELECT check_interval_days FROM public.apparatus WHERE id = v_rig) = 14
         AND (SELECT in_service FROM public.apparatus WHERE id = v_rig) = false THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 check-interval setter + take-out-of-service still work (definer RPCs)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 interval "%s" out-of-service "%s"%s', v_err, v_e2, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
