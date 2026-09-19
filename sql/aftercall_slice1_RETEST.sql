-- =====================================================================
-- RETEST for aftercall_slice1_2026-09-19.sql. READ-ONLY IN EFFECT.
--
-- RAN 2026-09-19 against the live database: 29 passed, 0 failed of 29. Safe to
-- re-run at any time — it is the regression check for this feature.
--
-- RUN AFTER the migration, on the same database. It writes fixture rows and
-- throws them away: the whole harness is ONE DO block ending in RAISE
-- EXCEPTION, which prints the report AND forces the rollback. Nothing it
-- inserts survives, including the impersonation.
--
-- WHY ONE BLOCK AND NOT BEGIN…temp table…ROLLBACK. Supabase pools connections,
-- so a temp table created in one statement is not reliably visible to the next
-- and the harness dies with 'relation does not exist' before testing anything.
-- A single block sidesteps the pool. Learned the hard way in this repo.
--
-- IMPERSONATION IS BY EMAIL — my_member_id() and the gates resolve the caller
-- from request.jwt.claims->>'email'. Matching every other RETEST here.
--
-- WHAT THIS DOES AND DOES NOT COVER. Sections 1-7 run as the table OWNER —
-- the Supabase SQL editor is a superuser connection, and set_config on the JWT
-- claims changes who my_member_id() REPORTS, not which role the statements RUN
-- AS. So those sections exercise the RPC's own gates and the grant layer, and
-- bypass RLS completely. Section 8 switches to `authenticated` and exercises
-- the policies directly; without it this report would look like full coverage
-- while the policies had never been tested at all.
--
-- THE SANITY CHECK IN SECTION 0 IS NOT OPTIONAL. If impersonation silently
-- fails, my_member_id() is null for everyone: every "refused" case passes FOR
-- THE WRONG REASON while the positive cases fail, and the report looks
-- half-broken when it is entirely meaningless. Section 0 proves the identity
-- took before a single assertion runs, and aborts if it did not.
-- =====================================================================

DO $retest$
DECLARE
  v_dept     uuid;
  v_member   uuid;  v_email text;
  v_app      uuid;
  v_other_app uuid;                       -- an apparatus in ANOTHER department
  v_item     uuid;
  v_run      uuid;
  v_label    text;
  v_n        int;
  v_ts       timestamptz;
  v_by       uuid;   v_by_name text;
  v_r_dept   uuid;   v_r_app   uuid;    -- what the RUN recorded, read back separately
  v_note     text;
  n          int := 0;
  v_pass     int := 0;
  v_fail     int := 0;
  rpt        text := chr(10);
  v_err      text;
  v_fn       text;
BEGIN
  -- =================== 0. FIXTURES + THE SANITY CHECK ====================
  /* PICK THE DEPARTMENT FIRST, then the people and the rig from inside it.
     Choosing a member first and hoping their department also has an apparatus
     is choosing before the constraint is known — the early-catch harness
     aborted on production for exactly that reason. */
  SELECT d.id INTO v_dept
    FROM public.departments d
   WHERE EXISTS (SELECT 1 FROM public.apparatus a WHERE a.department_id = d.id)
     AND EXISTS (SELECT 1 FROM public.members m
                  WHERE m.department_id = d.id AND m.email IS NOT NULL
                    AND m.status IS DISTINCT FROM 'Inactive')
   ORDER BY d.id LIMIT 1;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'RETEST ABORTED: no department has BOTH an apparatus and a non-Inactive member with an email. Nothing below can be tested without both.';
  END IF;

  SELECT m.id, lower(m.email) INTO v_member, v_email
    FROM public.members m
   WHERE m.department_id = v_dept AND m.email IS NOT NULL
     AND m.status IS DISTINCT FROM 'Inactive'
   ORDER BY m.id LIMIT 1;

  SELECT a.id INTO v_app FROM public.apparatus a WHERE a.department_id = v_dept ORDER BY a.id LIMIT 1;

  -- A rig belonging to somebody else, for the cross-department rejection.
  SELECT a.id INTO v_other_app
    FROM public.apparatus a WHERE a.department_id <> v_dept ORDER BY a.id LIMIT 1;

  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);

  IF public.my_member_id() IS DISTINCT FROM v_member THEN
    RAISE EXCEPTION 'RETEST ABORTED: impersonation did not take — my_member_id() returned %, expected %. Every assertion below would be meaningless.', public.my_member_id(), v_member;
  END IF;
  IF public.my_department_id() IS DISTINCT FROM v_dept THEN
    RAISE EXCEPTION 'RETEST ABORTED: my_department_id() returned %, expected %.', public.my_department_id(), v_dept;
  END IF;

  -- ============ 1. THE SHAPE INSTALLED ====================================
  FOREACH v_fn IN ARRAY array['aftercall_items','aftercall_runs','aftercall_run_items'] LOOP
    n := n + 1;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace
                AND relname = v_fn AND relrowsecurity) THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  %s exists with RLS enabled%s', n, v_fn, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  %s missing, or RLS is OFF — policies on a table without RLS defend nothing%s', n, v_fn, chr(10));
    END IF;
  END LOOP;

  n := n + 1;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'departments'
                AND column_name = 'aftercall_enabled' AND is_nullable = 'NO'
                AND column_default LIKE '%false%') THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  departments.aftercall_enabled is NOT NULL DEFAULT false — every department starts OFF%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  departments.aftercall_enabled missing, nullable, or not defaulting false%s', n, chr(10));
  END IF;

  -- ============ 2. anon HOLDS NOTHING =====================================
  n := n + 1;
  IF has_function_privilege('anon', 'public.aftercall_log(uuid, jsonb, text)', 'EXECUTE') = false THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  anon cannot EXECUTE aftercall_log%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  anon CAN execute aftercall_log%s', n, chr(10));
  END IF;

  /* TRUNCATE is the one RLS cannot defend: it removes every row while taking
     none, so a department's whole log could go in one statement with all the
     policies still in force. */
  FOREACH v_fn IN ARRAY array['aftercall_items','aftercall_runs','aftercall_run_items'] LOOP
    n := n + 1;
    IF has_table_privilege('authenticated', 'public.' || v_fn, 'TRUNCATE') = false
       AND has_table_privilege('anon', 'public.' || v_fn, 'TRUNCATE') = false THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  no TRUNCATE on %s for anon/authenticated%s', n, v_fn, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  TRUNCATE still held on %s — RLS does not stop it%s', n, v_fn, chr(10));
    END IF;
  END LOOP;

  n := n + 1;
  IF has_table_privilege('authenticated', 'public.aftercall_runs', 'UPDATE') = false
     AND has_table_privilege('authenticated', 'public.aftercall_runs', 'DELETE') = false THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a logged run cannot be edited or deleted%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  aftercall_runs is editable — runs are supposed to be immutable%s', n, chr(10));
  END IF;

  -- ============ 3. AN ACTIVE MEMBER LOGS A RUN ============================
  INSERT INTO public.aftercall_items (department_id, label, sort_order)
  VALUES (v_dept, 'RETEST — wash the rig', 1) RETURNING id INTO v_item;

  v_run := public.aftercall_log(
    v_app,
    jsonb_build_array(
      jsonb_build_object('label', 'RETEST — wash the rig', 'done', true,  'note', NULL),
      jsonb_build_object('label', 'RETEST — restock gloves', 'done', false, 'note', '  none left  ')
    ),
    '  back at 0230  ');

  -- Read back into SEPARATE variables: overwriting v_dept/v_app here would have
  -- worked only because the values happen to match, and would silently poison
  -- every later section the moment they did not.
  SELECT department_id, apparatus_id, performed_by, performed_by_name, performed_at, note
    INTO v_r_dept, v_r_app, v_by, v_by_name, v_ts, v_note
    FROM public.aftercall_runs WHERE id = v_run;

  n := n + 1;
  IF v_by = v_member AND v_by_name IS NOT NULL AND v_ts <= now() AND v_ts > now() - interval '1 minute' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  the run is stamped with the CALLER and the server clock (%s)%s', n, v_by_name, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  wrong stamp: by=%s name=%s at=%s%s', n, v_by, v_by_name, v_ts, chr(10));
  END IF;

  n := n + 1;
  IF v_r_dept = v_dept AND v_r_app = v_app THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  the run is filed under the caller''s own department and the chosen rig%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  run filed under dept=%s app=%s%s', n, v_r_dept, v_r_app, chr(10));
  END IF;

  n := n + 1;
  IF v_note = 'back at 0230' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  the run note is trimmed, not stored with its whitespace%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  run note came back as "%s"%s', n, v_label, chr(10));
  END IF;

  SELECT count(*) INTO v_n FROM public.aftercall_run_items WHERE run_id = v_run;
  n := n + 1;
  IF v_n = 2 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  both item rows landed%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  expected 2 item rows, found %s%s', n, v_n, chr(10));
  END IF;

  n := n + 1;
  IF EXISTS (SELECT 1 FROM public.aftercall_run_items
              WHERE run_id = v_run AND item_label = 'RETEST — restock gloves'
                AND done = false AND note = 'none left') THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  done=false and its note are recorded, note trimmed%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  the not-done item did not land as expected%s', n, chr(10));
  END IF;

  -- ============ 4. THE SNAPSHOT SURVIVES RETIRING THE ITEM ================
  /* The whole reason item_label is copied rather than referenced. Retire the
     list entry and the history must read exactly as it did — a log that
     changes when the list changes is not a log. */
  UPDATE public.aftercall_items SET active = false, label = 'RETEST — RENAMED AFTER THE FACT'
   WHERE id = v_item;

  SELECT item_label INTO v_label
    FROM public.aftercall_run_items
   WHERE run_id = v_run AND item_label LIKE 'RETEST — wash%';
  n := n + 1;
  IF v_label = 'RETEST — wash the rig' THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  retiring AND renaming the item left the run''s label untouched%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  history was rewritten: the run now reads "%s"%s', n, coalesce(v_label, '(gone)'), chr(10));
  END IF;

  n := n + 1;
  IF (SELECT count(*) FROM public.aftercall_run_items WHERE run_id = v_run) = 2 THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  and the run still has both items after the retire%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  retiring an item destroyed run history%s', n, chr(10));
  END IF;

  -- ============ 5. CROSS-DEPARTMENT APPARATUS IS REFUSED ==================
  IF v_other_app IS NULL THEN
    rpt := rpt || format('   SKIP  cross-department test: no apparatus exists outside this department%s', chr(10));
  ELSE
    BEGIN
      PERFORM public.aftercall_log(v_other_app,
        jsonb_build_array(jsonb_build_object('label', 'RETEST', 'done', true)), NULL);
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err IS NOT NULL THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  another department''s apparatus refused: "%s"%s', n, v_err, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  logged a run against ANOTHER DEPARTMENT''S apparatus%s', n, chr(10));
    END IF;
  END IF;

  -- ============ 6. MALFORMED RUNS ARE REFUSED =============================
  -- An item with no label, or a done that is not a boolean, would otherwise
  -- write a row nobody can read as done or not-done.
  FOREACH v_fn IN ARRAY array['[]', 'null', '{"not":"an array"}',
                              '[{"done":true}]',
                              '[{"label":"  ","done":true}]',
                              '[{"label":"x","done":"yes"}]',
                              '[{"label":"x"}]'] LOOP
    BEGIN
      PERFORM public.aftercall_log(v_app, v_fn::jsonb, NULL);
      v_err := NULL;
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err IS NOT NULL THEN
      v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  refused %s%s', n, v_fn, chr(10));
    ELSE
      v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  ACCEPTED malformed items %s%s', n, v_fn, chr(10));
    END IF;
  END LOOP;

  -- ============ 7. A NON-MEMBER IS REFUSED ================================
  /* An authenticated identity with no member row — the shape of somebody who
     signed up but was never added to a roster. my_member_id() is null, so the
     RPC must refuse rather than write a run belonging to nobody. */
  PERFORM set_config('request.jwt.claims',
                     json_build_object('email', 'retest-nobody-' || gen_random_uuid()::text || '@example.invalid')::text,
                     true);
  n := n + 1;
  IF public.my_member_id() IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  the stranger fixture really has no member row%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  harness error: the stranger resolved to a member, so the next test is vacuous%s', n, chr(10));
  END IF;

  BEGIN
    PERFORM public.aftercall_log(v_app,
      jsonb_build_array(jsonb_build_object('label', 'RETEST', 'done', true)), NULL);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a non-member is refused: "%s"%s', n, v_err, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  somebody with no member record logged a run%s', n, chr(10));
  END IF;

  -- ============ 8. RLS ACTUALLY BITES ====================================
  /* EVERYTHING ABOVE RAN AS THE TABLE OWNER, which bypasses RLS entirely — the
     Supabase SQL editor connects as a superuser, and set_config on the JWT
     claims changes who my_member_id() reports, NOT which role the statements
     run as. So sections 1-7 prove the RPC's own gates and the privilege layer,
     and prove NOTHING about the policies. Without this section the report
     would look like full coverage while the policies were never exercised.

     Switching to `authenticated` for the last few assertions closes that. It
     is last on purpose: everything after it is the RAISE that ends the block,
     which needs no rights at all. */
  PERFORM set_config('role', 'authenticated', true);

  -- Back to the real member — the stranger from section 7 is still in scope.
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);

  BEGIN
    INSERT INTO public.aftercall_runs (department_id, apparatus_id, performed_by, performed_by_name)
    VALUES (v_dept, v_app, v_member, 'RETEST direct write');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err IS NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a member CAN insert their own run directly (the policy permits what the RPC does)%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  the insert policy rejected a member''s own run: "%s"%s', n, v_err, chr(10));
  END IF;

  /* The same insert stamped with SOMEBODY ELSE. This is the assertion that
     makes the policy worth having: without the performed_by check, any member
     could file a run in another member's name. */
  BEGIN
    INSERT INTO public.aftercall_runs (department_id, apparatus_id, performed_by, performed_by_name)
    VALUES (v_dept, v_app, gen_random_uuid(), 'RETEST someone else');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  a run stamped with someone else is refused by RLS%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  a member logged a run in ANOTHER member''s name%s', n, chr(10));
  END IF;

  -- A run belonging to another department must not even be visible.
  BEGIN
    INSERT INTO public.aftercall_items (department_id, label)
    VALUES ((SELECT id FROM public.departments WHERE id <> v_dept ORDER BY id LIMIT 1), 'RETEST cross-dept item');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  n := n + 1;
  IF v_err IS NOT NULL THEN
    v_pass := v_pass + 1; rpt := rpt || format('%2s PASS  an item for another department is refused by RLS%s', n, chr(10));
  ELSE
    v_fail := v_fail + 1; rpt := rpt || format('%2s FAIL  wrote a checklist item into ANOTHER DEPARTMENT%s', n, chr(10));
  END IF;

  RAISE EXCEPTION E'%\n---- % passed, % failed of % ----\n(this exception IS the rollback — every fixture row above is discarded)',
        rpt, v_pass, v_fail, n;
END
$retest$;
