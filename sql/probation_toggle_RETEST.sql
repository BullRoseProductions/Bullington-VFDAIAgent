-- =====================================================================
-- RETEST for probation_toggle_2026-10-18.sql (departments.probation_enabled + set_probation_enabled + the board guard). Run AFTER
-- RAN on live 2026-10-18: 16 passed, 0 failed, 5 skipped — T0 pass; IH / Lipan / North Hood Q1-Q4 + Q6 pass; Q5 skipped x3
-- (no pure Project Admin with a unique email — the PA refusal is covered by the post-condition + dry-run mutation MB);
-- Demo + Granbury skip all (no plain member).
-- the migration, separately. NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE
-- 'SENTINEL' (rolled back). The final RAISE is the report. The "ERROR" IS the report.
--   T0 (once) backfill = exactly Indian Harbor, Lipan, North Hood ON; every other department OFF; anon can't execute;
--      none of the three new / changed bodies mentions the locked verification column
-- Per department with a real DA (not a Project Admin) and a plain member, both with unique emails:
--   Q1 a plain member can't flip it
--   Q2 the DA flips their own department off and on; every OTHER department's value is untouched
--   Q3 the board: ON with a probationary member -> listed; OFF -> no rows (and the member's own status still loads —
--      the plain checklist keeps working)
--   Q4 a direct client UPDATE of probation_enabled is refused (guard trigger); the DA's direct update of another
--      departments column still works (the other settings' write path is untouched)
--   Q5 a pure Project Admin of the department can't flip it (SKIP when there's none)
--   Q6 another department's DA flips only THEIR department, never this one (SKIP when there's none)
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_e2 text; v_n int; v_m int; v_ok boolean; v_snap jsonb; v_js jsonb;
  v_da text; v_a text; v_a_id uuid; v_pa text; v_other_da text; v_other_dept uuid; v_orig boolean;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- T0
  SELECT count(*) FILTER (WHERE probation_enabled AND (name ILIKE 'Indian Harbor%' OR name ILIKE 'Lipan%' OR name ILIKE 'North Hood%')),
         count(*) FILTER (WHERE probation_enabled)
    INTO v_n, v_m FROM public.departments;
  v_ok := position(('verifie' || 'd') in lower(pg_get_functiondef('public.set_probation_enabled(boolean)'::regprocedure)
            || pg_get_functiondef('public.tg_departments_probation_enabled_guard()'::regprocedure)
            || pg_get_functiondef('public.dept_probation_board()'::regprocedure))) = 0;
  BEGIN
    PERFORM set_config('role', 'anon', true);
    BEGIN PERFORM public.set_probation_enabled(true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    PERFORM set_config('role', 'postgres', true);
  END;
  IF v_n = 3 AND v_m = 3 AND v_ok AND v_err ILIKE '%permission denied%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  T0 backfill = exactly IH / Lipan / North Hood on, all others off; anon denied; no verification column%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T0 the-three-on %s, total-on %s, clean-bodies %s, anon "%s"%s', v_n, v_m, v_ok, v_err, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept, d.probation_enabled AS was_on FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s (%s)%s', rec.dept, CASE WHEN rec.was_on THEN 'on' ELSE 'off' END, chr(10));
    v_da := NULL; v_a := NULL; v_a_id := NULL; v_pa := NULL; v_other_da := NULL; v_other_dept := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND NOT m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_a, v_a_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IS DISTINCT FROM 'Inactive' AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_pa FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Project Admin']::text[]
       AND NOT m.access && array['Department Admin']::text[]
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_other_da, v_other_dept FROM public.members m WHERE m.department_id <> rec.dept_id
       AND m.access && array['Department Admin']::text[] AND NOT m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA (not a PA) and a plain member with unique emails (DA %s, member %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      SELECT jsonb_object_agg(id, probation_enabled) INTO v_snap FROM public.departments WHERE id <> rec.dept_id;
      UPDATE public.members SET status = 'Probationary' WHERE id = v_a_id;   -- fixture: someone to put on the board

      -- Q1 a member can't flip it
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_probation_enabled(NOT rec.was_on); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only a Department Admin%' AND (SELECT probation_enabled FROM public.departments WHERE id = rec.dept_id) = rec.was_on THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q1 a member can''t flip it%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q1 member -> "%s"%s', v_err, chr(10)); END IF;

      -- Q2 + Q3 the DA flips their own department; the board follows
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_ok := public.set_probation_enabled(true);
      SELECT count(*) INTO v_n FROM public.dept_probation_board() b WHERE b.member_id = v_a_id;
      v_err := (public.set_probation_enabled(false))::text;
      SELECT count(*) INTO v_m FROM public.dept_probation_board();
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      v_js := public.my_probation_status();
      PERFORM set_config('role', 'postgres', true);
      IF v_ok AND v_err = 'false' AND (SELECT probation_enabled FROM public.departments WHERE id = rec.dept_id) = false
         AND (SELECT jsonb_object_agg(id, probation_enabled) FROM public.departments WHERE id <> rec.dept_id) = v_snap THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q2 the DA turns it on and off; no other department changed%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q2 on %s off %s others unchanged %s%s', v_ok, v_err,
             (SELECT jsonb_object_agg(id, probation_enabled) FROM public.departments WHERE id <> rec.dept_id) = v_snap, chr(10)); END IF;
      IF v_n = 1 AND v_m = 0 AND v_js IS NOT NULL AND jsonb_typeof(v_js->'items') = 'array' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q3 board lists the probationary member when on, nothing when off; the member''s own status still loads%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q3 on-listed %s off-rows %s own-status %s%s', v_n, v_m, v_js IS NOT NULL, chr(10)); END IF;

      -- Q4 the direct path: probation_enabled refused; another column still writable by the DA
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN UPDATE public.departments SET probation_enabled = true WHERE id = rec.dept_id; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK ' || v_n;
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN UPDATE public.departments SET week_start_day = week_start_day WHERE id = rec.dept_id; GET DIAGNOSTICS v_m = ROW_COUNT; v_e2 := 'OK';
      EXCEPTION WHEN OTHERS THEN v_e2 := SQLERRM; v_m := NULL; END;
      PERFORM set_config('role', 'postgres', true);
      IF (v_err LIKE 'Only a Department Admin%' OR v_err = 'OK 0') AND (SELECT probation_enabled FROM public.departments WHERE id = rec.dept_id) = false
         AND v_e2 = 'OK' AND v_m = 1 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q4 direct UPDATE of probation_enabled refused ("%s"); the DA''s other settings still save%s', v_err, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q4 direct flag "%s" (now %s); other column "%s" rows %s%s', v_err,
             (SELECT probation_enabled FROM public.departments WHERE id = rec.dept_id), v_e2, v_m, chr(10)); END IF;

      -- Q5 a pure Project Admin
      IF v_pa IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  Q5 — no pure Project Admin with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_pa, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.set_probation_enabled(true); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err LIKE 'Only a Department Admin%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q5 a Project Admin can''t flip it%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q5 PA -> "%s"%s', v_err, chr(10)); END IF;
      END IF;

      -- Q6 another department's DA only ever touches their own department
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  Q6 — no other-department DA%s', chr(10));
      ELSE
        UPDATE public.departments SET probation_enabled = true WHERE id = rec.dept_id;   -- owner: this department on
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        v_orig := public.set_probation_enabled(false);
        PERFORM set_config('role', 'postgres', true);
        IF v_orig = false AND (SELECT probation_enabled FROM public.departments WHERE id = rec.dept_id) = true
           AND (SELECT probation_enabled FROM public.departments WHERE id = v_other_dept) = false THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q6 another department''s DA switched only their own department%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q6 this dept now %s, theirs %s%s', (SELECT probation_enabled FROM public.departments WHERE id = rec.dept_id),
               (SELECT probation_enabled FROM public.departments WHERE id = v_other_dept), chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
