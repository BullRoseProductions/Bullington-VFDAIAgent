-- =====================================================================
-- RETEST for image_gen_usage_2026-10-15.sql.
-- RAN 2026-10-15 on live: 36 passed, 0 failed, 0 skipped (all 5 departments A-E). READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Once: anon can't execute the RPC; authenticated has no privilege on the table; a bad tier is refused.
-- For each department with a signed-in-able member, sign in exactly as the app does (JWT email claim + role
-- authenticated) and check:
--   A. a call is allowed and increments THIS department's current-month count by exactly 1 (used = before + 1)
--   B. at the ceiling (fixture: this department's row set to the ceiling) -> allowed:false, used = ceiling, and the
--      count is NOT incremented
--   C. another department's member calling the RPC increments only THEIR row — this department's count is unchanged
--   D. a member can't read or write the table directly (permission denied)
--   E. anon calling the RPC -> permission denied
-- Every write is inside a sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in a RAISE that is
-- the report + final rollback. NOTHING CHANGES — including real usage counts. The "ERROR" IS the report.
-- DRY RUN 2026-10-15 — NOT the live DB (PGlite mock, 2 departments, Supabase-style default grants on new tables AND
-- functions, which the migration must revoke): migration OK + idempotent; this RETEST 15 passed / 0 failed / 0 skipped;
-- three real calls -> count 3. Mutation checks: ceiling WHERE removed -> B/C FAIL (501 allowed); SELECT granted ->
-- post-condition rolls back; anon left executable -> rolls back; another table's policy changed -> rolls back.
-- =====================================================================
DO $retest$
DECLARE
  rec record;
  v_err text; v_res jsonb; v_before int; v_after int; v_ceiling int; v_n int;
  v_member text; v_other text; v_other_dept uuid;
  v_period date := date_trunc('month', (now() at time zone 'America/Chicago'))::date;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  IF NOT has_function_privilege('anon', 'public.record_image_generation(text)', 'EXECUTE')
     AND NOT has_table_privilege('authenticated', 'public.image_gen_usage', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.image_gen_usage', 'UPDATE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  anon can''t execute; authenticated has no table privilege%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  privileges too open%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    v_member := NULL; v_other := NULL; v_other_dept := NULL;
    SELECT lower(m.email) INTO v_member FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_other, v_other_dept FROM public.members m
     WHERE m.department_id <> rec.dept_id AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    IF v_member IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — no member with a unique email%s', chr(10)); CONTINUE; END IF;

    BEGIN
      SELECT coalesce((SELECT count FROM public.image_gen_usage WHERE department_id = rec.dept_id AND period_month = v_period), 0) INTO v_before;
      -- bad tier (first time only is enough, but cheap to repeat)
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_member, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.record_image_generation('low'); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err = 'Image quality must be medium or high' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  bad tier refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  bad tier -> "%s"%s', v_err, chr(10)); END IF;
      -- A
      v_res := public.record_image_generation('medium');
      v_ceiling := (v_res->>'ceiling')::int;
      PERFORM set_config('role', 'postgres', true);
      SELECT count INTO v_after FROM public.image_gen_usage WHERE department_id = rec.dept_id AND period_month = v_period;
      IF (v_res->>'allowed')::boolean AND (v_res->>'used')::int = v_before + 1 AND v_after = v_before + 1 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A allowed; count %s -> %s (ceiling %s)%s', v_before, v_after, v_ceiling, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A -> %s, count %s -> %s%s', v_res, v_before, v_after, chr(10)); END IF;
      -- B: put this department at the ceiling (as the owner), then call as the member
      UPDATE public.image_gen_usage SET count = v_ceiling WHERE department_id = rec.dept_id AND period_month = v_period;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_member, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      v_res := public.record_image_generation('high');
      PERFORM set_config('role', 'postgres', true);
      SELECT count INTO v_after FROM public.image_gen_usage WHERE department_id = rec.dept_id AND period_month = v_period;
      IF NOT (v_res->>'allowed')::boolean AND (v_res->>'used')::int = v_ceiling AND v_after = v_ceiling THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  B at the ceiling -> denied, count stays %s%s', v_after, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B -> %s, count %s%s', v_res, v_after, chr(10)); END IF;
      -- C: another department's member touches only their own row
      IF v_other IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  C — no other-department member%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        v_res := public.record_image_generation('medium');
        PERFORM set_config('role', 'postgres', true);
        SELECT count INTO v_n FROM public.image_gen_usage WHERE department_id = rec.dept_id AND period_month = v_period;
        IF v_n = v_ceiling AND EXISTS (SELECT 1 FROM public.image_gen_usage WHERE department_id = v_other_dept AND period_month = v_period) THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  C other department counted on their own row; this one unchanged%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C this department''s count became %s%s', v_n, chr(10)); END IF;
      END IF;
      -- D: direct read / write refused
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_member, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN SELECT count(*) INTO v_n FROM public.image_gen_usage; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err ILIKE '%permission denied%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D direct read refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D direct read -> "%s"%s', v_err, chr(10)); END IF;
      BEGIN UPDATE public.image_gen_usage SET count = 0; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err ILIKE '%permission denied%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  D direct write refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  D direct write -> "%s"%s', v_err, chr(10)); END IF;
      -- E: anon
      PERFORM set_config('role', 'anon', true);
      BEGIN PERFORM public.record_image_generation('medium'); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      IF v_err ILIKE '%permission denied%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  E anon refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  E anon -> "%s"%s', v_err, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
