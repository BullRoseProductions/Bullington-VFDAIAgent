-- =====================================================================
-- RETEST for equipment_issues_DRAFT.sql (B3 report issue). READ-ONLY IN EFFECT.
--
-- RAN 2026-10-13 against the live database: 15 passed, 0 failed of 15 (second run — the first
-- picked an orphaned custody period with no equipment_id; the fixture now requires a real unit).
-- Safe to re-run at any time — it is the regression check for report/resolve.
--
-- Same harness as apparatus_check_interval_RETEST.sql: ONE DO block; every test that
-- writes runs in its own sub-block ending in RAISE 'SENTINEL' (rolls it back, role and
-- claims included); the block ends in RAISE EXCEPTION = the report + the final rollback.
-- The editor shows the report as an "ERROR" — that is the report, not a failure.
--
-- Fixtures are picked by what the LIVE gate functions say, not by guessing access arrays:
--   H = a member holding an OPEN custody period (the reporter)
--   P = a plain member in the same dept: not H, not equipment manager, not dept admin
--   M = an equipment manager or dept admin in the same dept (the resolver), not H
-- Every behavioural test runs as role `authenticated`, so RLS + grants are exercised.
-- =====================================================================

DO $retest$
DECLARE
  v_dept uuid;  v_eq uuid;  v_custody uuid;  v_cond_before text;  v_eq_name text;
  v_h uuid;  v_h_email text;
  v_p uuid;  v_p_email text;
  v_m uuid;  v_m_email text;
  v_other_eq uuid;  v_other_dept uuid;
  v_start bigint;  v_n bigint;
  v_id uuid;  v_cid uuid;  v_by uuid;  v_byname text;  v_cond text;
  v_seen_p bigint;  v_seen_m bigint;  v_seen_h bigint;
  v_e_p text;  v_e_again text;  v_resolved timestamptz;
  v_err text;
  rec record;
  n int := 0;  v_pass int := 0;  v_fail int := 0;
  rpt text := chr(10);
BEGIN
  SELECT count(*) INTO v_start FROM public.equipment_issues;

  -- ============ 0. FIXTURES + SANITY ======================================
  -- H + the item: an open custody period whose holder has an email.
  SELECT c.department_id, c.equipment_id, c.id, c.holder_member_id, lower(m.email), c.equipment_name
    INTO v_dept, v_eq, v_custody, v_h, v_h_email, v_eq_name
    FROM public.equipment_custody c JOIN public.members m ON m.id = c.holder_member_id
   WHERE c.closed_at IS NULL AND m.email IS NOT NULL AND m.status IS DISTINCT FROM 'Inactive'
     -- a REAL unit: open periods can be orphaned (equipment_id NULL / unit gone) — the first run picked one
     AND c.equipment_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.equipment e WHERE e.id = c.equipment_id)
   ORDER BY c.opened_at LIMIT 1;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: no open custody period on a real unit whose holder has an email — nothing to report on.';
  END IF;
  IF v_eq IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: the picked custody period has no equipment_id.';
  END IF;
  SELECT condition INTO v_cond_before FROM public.equipment WHERE id = v_eq;

  -- P and M chosen by the live gate functions.
  FOR rec IN SELECT m.id, lower(m.email) AS email FROM public.members m
              WHERE m.department_id = v_dept AND m.email IS NOT NULL AND m.id <> v_h
                AND m.status IS DISTINCT FROM 'Inactive' ORDER BY m.id LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
    IF public.my_member_id() IS DISTINCT FROM rec.id THEN CONTINUE; END IF;
    IF v_m IS NULL AND (public.is_equipment_manager() OR public.is_dept_admin()) THEN
      v_m := rec.id; v_m_email := rec.email;
    ELSIF v_p IS NULL AND NOT public.is_equipment_manager() AND NOT public.is_dept_admin() THEN
      v_p := rec.id; v_p_email := rec.email;
    END IF;
    EXIT WHEN v_m IS NOT NULL AND v_p IS NOT NULL;
  END LOOP;
  IF v_m IS NULL OR v_p IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: dept % needs (besides the holder) a plain member AND an equipment manager/dept admin with emails. plain=%, manager=%', v_dept, v_p, v_m;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_h_email, 'role', 'authenticated')::text, true);
  IF public.my_member_id() IS DISTINCT FROM v_h THEN
    RAISE EXCEPTION 'RETEST ABORTED: holder impersonation did not take (my_member_id %, expected %).', public.my_member_id(), v_h;
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT e.id, e.department_id INTO v_other_eq, v_other_dept FROM public.equipment e
   WHERE e.department_id <> v_dept ORDER BY e.id LIMIT 1;

  rpt := rpt || format('   fixtures: dept %s · item %s (%s, condition %s) · holder %s · plain %s · manager/DA %s%s',
                       v_dept, v_eq, v_eq_name, coalesce(v_cond_before, 'NULL'), v_h, v_p, v_m, chr(10));

  -- ============ 1. GRANTS =================================================
  n := n + 1;
  IF NOT has_function_privilege('anon', 'public.report_equipment_issue(uuid, text, text)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.resolve_equipment_issue(uuid, text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.report_equipment_issue(uuid, text, text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.resolve_equipment_issue(uuid, text)', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  both RPCs: anon cannot EXECUTE, authenticated can%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  RPC grants wrong%s', n, chr(10));
  END IF;
  n := n + 1;
  IF NOT has_table_privilege('authenticated', 'public.equipment_issues', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.equipment_issues', 'UPDATE')
     AND NOT has_table_privilege('authenticated', 'public.equipment_issues', 'DELETE')
     AND NOT has_table_privilege('anon', 'public.equipment_issues', 'INSERT') THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  no direct INSERT/UPDATE/DELETE on equipment_issues for app roles%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  app roles hold a direct write privilege on equipment_issues%s', n, chr(10));
  END IF;

  -- ============ 2. THE LIFECYCLE (one sub-block, rolled back) =============
  BEGIN
    PERFORM set_config('role', 'authenticated', true);
    -- H reports
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_h_email, 'role', 'authenticated')::text, true);
    v_id := public.report_equipment_issue(v_eq, 'damaged', '  RETEST — strap frayed  ');
    SELECT custody_id, reported_by, reported_by_name INTO v_cid, v_by, v_byname FROM public.equipment_issues WHERE id = v_id;
    SELECT condition INTO v_cond FROM public.equipment WHERE id = v_eq;
    SELECT count(*) INTO v_seen_h FROM public.equipment_issues WHERE id = v_id;
    -- P can't see it, can't resolve it
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_p_email, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_seen_p FROM public.equipment_issues WHERE id = v_id;
    BEGIN PERFORM public.resolve_equipment_issue(v_id, 'nope'); v_e_p := NULL;
    EXCEPTION WHEN OTHERS THEN v_e_p := SQLERRM; END;
    -- M sees it and resolves it; a second resolve is refused
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_m_email, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_seen_m FROM public.equipment_issues WHERE id = v_id;
    PERFORM public.resolve_equipment_issue(v_id, 'RETEST — replaced strap');
    SELECT resolved_at INTO v_resolved FROM public.equipment_issues WHERE id = v_id;
    BEGIN PERFORM public.resolve_equipment_issue(v_id, NULL); v_e_again := NULL;
    EXCEPTION WHEN OTHERS THEN v_e_again := SQLERRM; END;
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;

  n := n + 1;
  IF v_err = 'SENTINEL' AND v_id IS NOT NULL AND v_cid = v_custody AND v_by = v_h AND v_byname IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  holder reported: linked to the open custody period, reporter + name snapshotted%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  holder report — id %s, custody %s (want %s), by %s, err "%s"%s', n, v_id, v_cid, v_custody, v_by, v_err, chr(10));
  END IF;
  n := n + 1;
  IF v_cond IS NOT DISTINCT FROM v_cond_before THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  reporting did NOT change the item''s condition (still %s)%s', n, coalesce(v_cond, 'NULL'), chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  reporting changed condition %s -> %s%s', n, v_cond_before, v_cond, chr(10));
  END IF;
  n := n + 1;
  IF v_seen_h = 1 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  the reporter can read their own issue%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  the reporter sees %s rows of their own issue%s', n, v_seen_h, chr(10));
  END IF;
  n := n + 1;
  IF v_id IS NULL THEN
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  not reached — the holder report (above) failed, so there was no issue to test visibility on%s', n, chr(10));
  ELSIF v_seen_p = 0 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a plain member cannot read someone else''s issue%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  a plain member can read someone else''s issue%s', n, chr(10));
  END IF;
  n := n + 1;
  IF v_e_p = 'Not authorized' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a plain member cannot resolve: "%s"%s', n, v_e_p, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  plain member resolve — got "%s"%s', n, v_e_p, chr(10));
  END IF;
  n := n + 1;
  IF v_seen_m = 1 AND v_resolved IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  manager/DA can read the dept''s issue and resolve it%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  manager/DA — saw %s rows, resolved_at %s%s', n, v_seen_m, v_resolved, chr(10));
  END IF;
  n := n + 1;
  IF v_e_again = 'Issue not found or already resolved.' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  resolving twice is refused%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  second resolve — got "%s"%s', n, v_e_again, chr(10));
  END IF;

  -- ============ 3. A NON-HOLDER CAN'T REPORT THE ITEM ======================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_p_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.report_equipment_issue(v_eq, 'damaged', 'RETEST — not mine');
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err = 'You can only report gear you are signed for.' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a member not signed for the item is refused: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  non-holder report — got "%s"%s', n, v_err, chr(10));
  END IF;

  -- ============ 4. BLANK NOTE / BAD KIND / DIRECT INSERT ==================
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_h_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.report_equipment_issue(v_eq, 'damaged', '   ');
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err = 'Describe the issue.' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a blank note is refused%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  blank note — got "%s"%s', n, v_err, chr(10));
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_h_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    PERFORM public.report_equipment_issue(v_eq, 'exploded', 'RETEST — bad kind');
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err <> 'SENTINEL' AND v_err LIKE '%check constraint%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  an unknown kind is refused by the check constraint%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  unknown kind — got "%s"%s', n, v_err, chr(10));
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_h_email, 'role', 'authenticated')::text, true);
    PERFORM set_config('role', 'authenticated', true);
    INSERT INTO public.equipment_issues (department_id, equipment_id, equipment_name, kind, note, reported_by, reported_by_name)
    VALUES (v_dept, v_eq, 'RETEST', 'other', 'RETEST — direct insert', v_h, 'RETEST');
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err LIKE 'permission denied%' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a direct INSERT is refused: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  direct INSERT — got "%s"%s', n, v_err, chr(10));
  END IF;

  -- ============ 5. ANOTHER DEPARTMENT'S ISSUE CAN'T BE RESOLVED ===========
  IF v_other_eq IS NULL THEN
    rpt := rpt || format('   SKIP  cross-department: no equipment in any other department%s', chr(10));
  ELSE
    v_id := NULL;
    BEGIN
      -- fixture written as the owner (no role switch yet), then resolved as M
      INSERT INTO public.equipment_issues (department_id, equipment_id, equipment_name, kind, note, reported_by_name)
      VALUES (v_other_dept, v_other_eq, 'RETEST other dept', 'other', 'RETEST — other dept', 'RETEST')
      RETURNING id INTO v_id;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_m_email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.equipment_issues WHERE id = v_id;
      PERFORM public.resolve_equipment_issue(v_id, 'RETEST');
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err = 'Issue not found or already resolved.' AND v_n = 0 THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  another department''s issue is invisible and can''t be resolved%s', n, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  cross-dept — visible rows %s, got "%s"%s', n, v_n, v_err, chr(10));
    END IF;
  END IF;

  -- ============ 6. NOTHING LEAKED =========================================
  SELECT count(*) INTO v_n FROM public.equipment_issues;
  SELECT condition INTO v_cond FROM public.equipment WHERE id = v_eq;
  n := n + 1;
  IF v_n = v_start AND v_cond IS NOT DISTINCT FROM v_cond_before THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  nothing kept: %s issue rows before and after, condition unchanged%s', n, v_start, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  leak — issues %s -> %s, condition %s -> %s%s', n, v_start, v_n, v_cond_before, v_cond, chr(10));
  END IF;

  RAISE EXCEPTION E'%\n---- % passed, % failed of % ----\n(this exception IS the rollback — nothing above is kept)',
        rpt, v_pass, v_fail, n;
END
$retest$;
