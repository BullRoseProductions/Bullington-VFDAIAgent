-- =====================================================================
-- RETEST for apparatus_check_interval_DRAFT.sql (B2 check scheduling). READ-ONLY IN EFFECT.
--
-- RAN 2026-10-13 against the live database: 10 passed, 0 failed of 10. Safe to re-run at any
-- time — it is the regression check for check scheduling.
--
-- Same harness as aftercall_slice1_RETEST.sql: ONE DO block. Each test runs in its own
-- sub-block; a test that would change data ends in RAISE 'SENTINEL', which rolls that
-- sub-block back (the role + claims switch included). The block itself ends in RAISE
-- EXCEPTION, which prints the report AND rolls back everything. Nothing survives.
-- The editor will show the report as an "ERROR" — that is the report, not a failure.
--
-- Impersonation is by email (request.jwt.claims->>'email'), and every behavioural test
-- also switches to role `authenticated`, so the apparatus RLS policy and the guard
-- trigger are exercised exactly as the app hits them. Section 0 aborts if the identity
-- didn't take — otherwise every "refused" case would pass for the wrong reason.
-- =====================================================================

DO $retest$
DECLARE
  v_dept   uuid;
  v_plain  uuid;  v_plain_email text;
  v_ops    uuid;  v_ops_email   text;
  v_app    uuid;  v_before int;
  v_other  uuid;
  v_got    text;  v_n int;  v_rows int;
  v_err    text;
  n        int := 0;  v_pass int := 0;  v_fail int := 0;
  rpt      text := chr(10);
  OPS      text[] := array['Department Admin','Officer'];
  LEAD     text[] := array['Department Admin','Project Admin','Board Member','Officer'];
BEGIN
  -- ============ 0. FIXTURES + SANITY ======================================
  -- Department first: it must have a live rig, a plain member and a DA/Officer, all with emails.
  SELECT d.id INTO v_dept FROM public.departments d
   WHERE EXISTS (SELECT 1 FROM public.apparatus a WHERE a.department_id = d.id AND a.deleted_at IS NULL)
     AND EXISTS (SELECT 1 FROM public.members m WHERE m.department_id = d.id AND m.email IS NOT NULL
                  AND m.status IS DISTINCT FROM 'Inactive' AND NOT (coalesce(m.access, '{}') && LEAD))
     AND EXISTS (SELECT 1 FROM public.members m WHERE m.department_id = d.id AND m.email IS NOT NULL
                  AND m.status IS DISTINCT FROM 'Inactive' AND m.access && OPS
                  AND NOT (m.access && array['Project Admin']))
   ORDER BY d.id LIMIT 1;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: no department has a live rig + a plain member + a DA/Officer, all with emails.';
  END IF;

  SELECT m.id, lower(m.email) INTO v_plain, v_plain_email FROM public.members m
   WHERE m.department_id = v_dept AND m.email IS NOT NULL AND m.status IS DISTINCT FROM 'Inactive'
     AND NOT (coalesce(m.access, '{}') && LEAD) ORDER BY m.id LIMIT 1;
  SELECT m.id, lower(m.email) INTO v_ops, v_ops_email FROM public.members m
   WHERE m.department_id = v_dept AND m.email IS NOT NULL AND m.status IS DISTINCT FROM 'Inactive'
     AND m.access && OPS AND NOT (m.access && array['Project Admin']) ORDER BY m.id LIMIT 1;
  SELECT a.id, a.check_interval_days INTO v_app, v_before FROM public.apparatus a
   WHERE a.department_id = v_dept AND a.deleted_at IS NULL ORDER BY a.id LIMIT 1;
  SELECT a.id INTO v_other FROM public.apparatus a
   WHERE a.department_id <> v_dept AND a.deleted_at IS NULL ORDER BY a.id LIMIT 1;

  -- the identities must take, and the gate must see them as we expect
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_plain_email, 'role', 'authenticated')::text, true);
  IF public.my_member_id() IS DISTINCT FROM v_plain OR public.my_department_id() IS DISTINCT FROM v_dept THEN
    RAISE EXCEPTION 'RETEST ABORTED: plain-member impersonation did not take (my_member_id %, expected %).', public.my_member_id(), v_plain;
  END IF;
  IF public.is_canmanage_ops() THEN
    RAISE EXCEPTION 'RETEST ABORTED: the "plain" fixture passes is_canmanage_ops() — the refusal tests would be vacuous.';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_ops_email, 'role', 'authenticated')::text, true);
  IF public.my_member_id() IS DISTINCT FROM v_ops OR NOT public.is_canmanage_ops() THEN
    RAISE EXCEPTION 'RETEST ABORTED: DA/Officer impersonation did not take, or is_canmanage_ops() is false for them.';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  rpt := rpt || format('   fixtures: dept %s · rig %s (interval before: %s) · plain %s · DA/Officer %s%s',
                       v_dept, v_app, coalesce(v_before::text, 'NULL'), v_plain, v_ops, chr(10));

  -- ============ 1. SHAPE + GRANTS =========================================
  n := n + 1;
  IF NOT has_function_privilege('anon', 'public.set_apparatus_check_interval(uuid, integer)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.set_apparatus_check_interval(uuid, integer)', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  setter: anon cannot EXECUTE, authenticated can%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  setter grants wrong (anon or authenticated)%s', n, chr(10));
  END IF;

  -- ============ 2. PLAIN MEMBER, DIRECT UPDATE OF THE COLUMN → guard refuses ==
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_plain_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    UPDATE public.apparatus SET check_interval_days = 7 WHERE id = v_app;
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err LIKE 'Use set_apparatus_check_interval%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  plain member direct PATCH refused: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  plain member direct PATCH — got "%s"%s', n, v_err, chr(10));
  END IF;

  -- ============ 3. PLAIN MEMBER VIA THE SETTER → Not authorized ===========
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_plain_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.set_apparatus_check_interval(v_app, 7);
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err = 'Not authorized' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  plain member via setter refused: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  plain member via setter — got "%s"%s', n, v_err, chr(10));
  END IF;

  -- ============ 4. DA/OFFICER VIA THE SETTER → 7, and it reads back 7 =====
  v_got := NULL; v_n := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_ops_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    v_got := public.set_apparatus_check_interval(v_app, 7)::text;
    SELECT check_interval_days INTO v_n FROM public.apparatus WHERE id = v_app;
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err = 'SENTINEL' AND v_got = '7' AND v_n = 7 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  DA/Officer via setter: returned 7, row reads 7%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  DA/Officer via setter — returned %s, row %s, err "%s"%s', n, v_got, v_n, v_err, chr(10));
  END IF;

  -- ============ 5. DA/OFFICER CLEARS IT (NULL = no schedule) ==============
  v_got := 'unset';
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_ops_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.set_apparatus_check_interval(v_app, 7);
    v_got := coalesce(public.set_apparatus_check_interval(v_app, NULL)::text, 'NULL');
    SELECT check_interval_days INTO v_n FROM public.apparatus WHERE id = v_app;
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err = 'SENTINEL' AND v_got = 'NULL' AND v_n IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  DA/Officer can clear the schedule (NULL)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  clearing — returned %s, row %s, err "%s"%s', n, v_got, v_n, v_err, chr(10));
  END IF;

  -- ============ 6. OUT OF RANGE → refused ================================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_ops_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.set_apparatus_check_interval(v_app, 0);
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err LIKE 'Interval must be%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  interval 0 refused: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  interval 0 — got "%s"%s', n, v_err, chr(10));
  END IF;

  -- ============ 7. ANOTHER DEPARTMENT'S RIG → not found ===================
  IF v_other IS NULL THEN
    rpt := rpt || format('   SKIP  cross-department: no live rig in any other department%s', chr(10));
  ELSE
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_ops_email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.set_apparatus_check_interval(v_other, 7);
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err = 'Apparatus not found.' THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  another department''s rig refused: "%s"%s', n, v_err, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  another department''s rig — got "%s"%s', n, v_err, chr(10));
    END IF;
  END IF;

  -- ============ 8. DA/OFFICER DIRECT UPDATE → also refused (setter is the only path) ==
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_ops_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    UPDATE public.apparatus SET check_interval_days = 7 WHERE id = v_app;
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err LIKE 'Use set_apparatus_check_interval%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  DA/Officer direct PATCH also refused — setter is the only path%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  DA/Officer direct PATCH — got "%s"%s', n, v_err, chr(10));
  END IF;

  -- ============ 9. PLAIN MEMBER'S ORDINARY RIG UPDATE STILL WORKS (truck checks) ==
  v_rows := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_plain_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    UPDATE public.apparatus SET note = note WHERE id = v_app;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err = 'SENTINEL' AND v_rows = 1 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  plain member ordinary rig update still works (1 row)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  plain member ordinary update — rows %s, err "%s"%s', n, v_rows, v_err, chr(10));
  END IF;

  -- ============ 10. NOTHING LEAKED =======================================
  SELECT check_interval_days INTO v_n FROM public.apparatus WHERE id = v_app;
  n := n + 1;
  IF v_n IS NOT DISTINCT FROM v_before THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  the test rig''s interval is back to %s%s', n, coalesce(v_before::text, 'NULL'), chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  the test rig''s interval is %s, was %s%s', n, v_n, v_before, chr(10));
  END IF;

  RAISE EXCEPTION E'%\n---- % passed, % failed of % ----\n(this exception IS the rollback — nothing above is kept)',
        rpt, v_pass, v_fail, n;
END
$retest$;
