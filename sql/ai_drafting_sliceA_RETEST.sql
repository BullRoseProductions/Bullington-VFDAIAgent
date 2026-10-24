-- =====================================================================
-- RETEST for ai_drafting_sliceA (DRAFT, not applied) — run AFTER the migration, separately.
-- RAN on live 2026-10-24: 28 passed, 0 failed, 2 skipped — S0; Indian Harbor + Lipan + North Hood A1 W1 A2–A7 O1 (Officer-only
-- exercised in all three; Board/PA-only refusal exercised in North Hood); Demo (no plain member) + Granbury (no plain member, no
-- session) skip. Rollback confirmed after: drill_plans 0 rows, session_plans 39 / 0 linked, no RETEST rows. Slice A proven on live.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). The
-- fixtures are what the RPCs themselves write. The final RAISE is the report — the "ERROR" IS the report.
--   S0 (once) structure: drill_plans RLS on + its one SELECT policy; the six RPCs authenticated-only
-- Per department (needs an ops person = Department Admin or Officer, a plain member, an ops person of ANOTHER department
-- with a session there, and a session here; unique emails):
--   W1 a plain member reads the library (dept_drill_plans + the table) but can't write: set / approve refused on
--      authority, a direct INSERT refused by RLS, an UPDATE touches 0 rows
--   A1 ops creates a draft via set_drill_plan: status draft, source ai, created_by = their member row; blank title,
--      non-object content and duration 0 are refused with their messages
--   A2 ops approves their OWN plan (self-approval): approved, approved_by = them, approved_at set; approving again is a
--      no-op (approved_at unchanged)
--   A3 an edit keeps status (still approved) and stamps updated_by / updated_at
--   A4 another department's ops person: the plan isn't in their dept_drill_plans or their SELECT; edit / approve /
--      unapprove / attach / delete all refused "not in your department"; attaching THIS plan to THEIR session refused
--   A5 attach to a session here: a session_plans row with drill_plan_id, source 'ai', the plan's title, ai_text starting
--      "## Quick Run Sheet" and carrying "## <title> — Drill Plan"; attached_sessions = 1; again -> "already attached";
--      a session of another department -> "not in your department"
--   A6 unapprove -> draft, approved_by / approved_at cleared
--   A7 delete -> the plan is gone; the session_plans row is KEPT with drill_plan_id NULL and its text intact
--   O1 (if the department has one) an Officer who is not a Department Admin can create + approve; a Board Member / Project
--      Admin who is neither DA nor Officer is refused
-- =====================================================================
DO $retest$
DECLARE
  rec record; r record; v_ok boolean; v_n int; v_n2 int; v_t timestamptz; v_t2 timestamptz;
  v_op text; v_op_mid uuid; v_mem text; v_xop text; v_xhome uuid; v_xsess uuid; v_sess uuid; v_off text; v_off_mid uuid; v_nop text;
  v_p uuid; v_p2 uuid; v_sp uuid; e1 text; e2 text; e3 text; e4 text; e5 text; e6 text; v_txt text;
  C constant jsonb := '{"summary":"Hose advance drill.","objectives":["Advance a charged line","Call for water"],"run_of_show":[{"t":"Brief","d":"Assign crews"},{"t":"Evolution","d":"Two runs"}],"materials":["1.75 in line"],"safety":["Full PPE"]}';
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.drill_plans'::regclass)
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drill_plans') = 1
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drill_plans' AND cmd = 'SELECT' AND roles = '{authenticated}') = 1
     AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
            AND proname IN ('set_drill_plan', 'approve_drill_plan', 'unapprove_drill_plan', 'delete_drill_plan', 'dept_drill_plans', 'attach_drill_plan_to_session')
            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) = 6 INTO v_ok;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 drill_plans RLS on + one SELECT policy; six RPCs definer + authenticated-only%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 structure%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_op := NULL; v_op_mid := NULL; v_mem := NULL; v_xop := NULL; v_xhome := NULL; v_xsess := NULL; v_sess := NULL; v_off := NULL; v_off_mid := NULL; v_nop := NULL;
    SELECT lower(m.email), m.id INTO v_op, v_op_mid FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin','Officer']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_mem FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_xop, v_xhome FROM public.members m WHERE m.department_id <> rec.dept_id
       AND m.access && array['Department Admin','Officer']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
       AND EXISTS (SELECT 1 FROM public.training_sessions t WHERE t.department_id = m.department_id) ORDER BY m.id LIMIT 1;
    SELECT t.id INTO v_sess FROM public.training_sessions t WHERE t.department_id = rec.dept_id ORDER BY t.date DESC NULLS LAST, t.id LIMIT 1;
    SELECT t.id INTO v_xsess FROM public.training_sessions t WHERE t.department_id = v_xhome ORDER BY t.date DESC NULLS LAST, t.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_off, v_off_mid FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_nop FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Board Member','Project Admin']::text[]
       AND NOT m.access && array['Department Admin','Officer']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_op IS NULL OR v_mem IS NULL OR v_xop IS NULL OR v_sess IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA/Officer here, a plain member here, a session here, and a DA/Officer of another department with a session there, unique emails (ops %s, member %s, session %s, other-dept ops %s)%s',
        coalesce(v_op, 'none'), coalesce(v_mem, 'none'), coalesce(v_sess::text, 'none'), coalesce(v_xop, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_xop, v_xhome) ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;

      -- A1 ops creates a draft; the validations
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_op, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok'; v_p := NULL;
      BEGIN SELECT (public.set_drill_plan(NULL, '  RETEST hose advance  ', 'Hose', 45, 'All members', C)).id INTO v_p; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.set_drill_plan(NULL, '   ', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST x', NULL, NULL, NULL, '["not","an","object"]'::jsonb); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST y', NULL, 0, NULL, C); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO r FROM public.drill_plans WHERE id = v_p;
      IF e1 = 'ok' AND r.department_id = rec.dept_id AND r.status = 'draft' AND r.source = 'ai' AND r.title = 'RETEST hose advance' AND r.created_by = v_op_mid AND r.updated_by = v_op_mid
         AND e2 = 'A drill plan needs a title.' AND e3 = 'A drill plan''s content must be a JSON object.' AND e4 = 'Duration must be a positive number of minutes.' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A1 ops creates a draft (trimmed title, source ai, created_by them); blank title / non-object content / duration 0 refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 create: %s · row %s · blank: %s · object: %s · duration: %s%s', e1, row_to_json(r), e2, e3, e4, chr(10)); END IF;

      -- W1 a plain member reads, can't write
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.dept_drill_plans() x WHERE x.id = v_p;
      SELECT count(*) INTO v_n2 FROM public.drill_plans WHERE id = v_p;
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok';
      BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST member', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.approve_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN INSERT INTO public.drill_plans (department_id, title, content) VALUES (rec.dept_id, 'RETEST direct', '{}'); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      UPDATE public.drill_plans SET title = 'RETEST hijack' WHERE id = v_p; GET DIAGNOSTICS v_n2 = ROW_COUNT;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 1 AND e1 = 'Only a Department Admin or Officer can manage drill plans.' AND e2 = 'Only a Department Admin or Officer can approve drill plans.'
         AND e3 ILIKE '%row-level security%' AND v_n2 = 0 AND (SELECT status FROM public.drill_plans WHERE id = v_p) = 'draft' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  W1 plain member reads the library; set / approve refused on authority; INSERT refused by RLS; UPDATE touches 0 rows%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  W1 reads %s · set: %s · approve: %s · insert: %s · update rows %s%s', v_n, e1, e2, e3, v_n2, chr(10)); END IF;

      -- A2 self-approval, then a no-op re-approve
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_op, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok';
      BEGIN PERFORM public.approve_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT approved_at INTO v_t FROM public.drill_plans WHERE id = v_p;
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.approve_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO r FROM public.drill_plans WHERE id = v_p;
      IF e1 = 'ok' AND e2 = 'ok' AND r.status = 'approved' AND r.approved_by = v_op_mid AND r.created_by = v_op_mid AND v_t IS NOT NULL AND r.approved_at = v_t THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A2 the author approves their own plan (approved_by them); approving again is a no-op%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A2 approve: %s / again: %s · %s%s', e1, e2, row_to_json(r), chr(10)); END IF;

      -- A3 an edit keeps status
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok';
      BEGIN PERFORM public.set_drill_plan(v_p, 'RETEST hose advance v2', 'Hose', 60, NULL, C || '{"summary":"Edited."}', 'manual'); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO r FROM public.drill_plans WHERE id = v_p;
      IF e1 = 'ok' AND r.status = 'approved' AND r.source = 'ai' AND r.title = 'RETEST hose advance v2' AND r.duration_min = 60 AND r.content ->> 'summary' = 'Edited.' AND r.updated_by = v_op_mid THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A3 an edit keeps status (approved) and source; updated_by stamped%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A3 edit: %s · %s%s', e1, row_to_json(r), chr(10)); END IF;

      -- A4 another department's ops person
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_xop, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.dept_drill_plans() x WHERE x.id = v_p;
      SELECT count(*) INTO v_n2 FROM public.drill_plans WHERE id = v_p;
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; e4 := 'ok'; e5 := 'ok'; e6 := 'ok';
      BEGIN PERFORM public.set_drill_plan(v_p, 'RETEST hijack', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.approve_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN PERFORM public.unapprove_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      BEGIN PERFORM public.attach_drill_plan_to_session(v_p, v_xsess); EXCEPTION WHEN OTHERS THEN e4 := SQLERRM; END;
      BEGIN PERFORM public.delete_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e5 := SQLERRM; END;
      BEGIN PERFORM public.attach_drill_plan_to_session(v_p, v_sess); EXCEPTION WHEN OTHERS THEN e6 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 0 AND v_n2 = 0 AND e1 = 'That drill plan is not in your department.' AND e2 = e1 AND e3 = e1 AND e4 = e1 AND e5 = e1 AND e6 = e1
         AND (SELECT status = 'approved' AND title = 'RETEST hose advance v2' FROM public.drill_plans WHERE id = v_p)
         AND NOT EXISTS (SELECT 1 FROM public.session_plans WHERE drill_plan_id = v_p) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A4 another department''s DA/Officer can''t see it; edit / approve / unapprove / attach / delete all refused; nothing moved%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A4 sees %s/%s · set: %s · approve: %s · unapprove: %s · attach theirs: %s · delete: %s · attach ours: %s%s', v_n, v_n2, e1, e2, e3, e4, e5, e6, chr(10)); END IF;

      -- A5 attach, dedupe, cross-department session
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_op, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok'; v_sp := NULL;
      BEGIN SELECT (public.attach_drill_plan_to_session(v_p, v_sess)).id INTO v_sp; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      SELECT x.attached_sessions INTO v_n FROM public.dept_drill_plans() x WHERE x.id = v_p;
      BEGIN PERFORM public.attach_drill_plan_to_session(v_p, v_sess); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN PERFORM public.attach_drill_plan_to_session(v_p, v_xsess); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO r FROM public.session_plans WHERE id = v_sp;
      IF e1 = 'ok' AND r.drill_plan_id = v_p AND r.session_id = v_sess AND r.department_id = rec.dept_id AND r.source = 'ai' AND r.title = 'RETEST hose advance v2'
         AND r.ai_text LIKE '## Quick Run Sheet%' AND position('## RETEST hose advance v2 — Drill Plan' in r.ai_text) > 0 AND position('**1. Brief**' in r.ai_text) > 0
         AND position('## Objectives' in r.ai_text) > 0 AND position('- Full PPE' in r.ai_text) > 0
         AND r.created_by = (SELECT name FROM public.members WHERE id = v_op_mid) AND v_n = 1
         AND e2 = 'That plan is already attached to this session.' AND e3 = 'That session is not in your department.'
         AND (SELECT count(*) FROM public.session_plans WHERE drill_plan_id = v_p) = 1 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A5 attach -> a session_plans row (drill_plan_id, source ai, title, run-sheet ai_text, created_by their name); count 1; again -> "already attached"; another dept''s session refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A5 attach: %s · count %s · again: %s · cross: %s · row %s%s', e1, v_n, e2, e3, left(row_to_json(r)::text, 300), chr(10)); END IF;

      -- A6 unapprove
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok';
      BEGIN PERFORM public.unapprove_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT * INTO r FROM public.drill_plans WHERE id = v_p;
      IF e1 = 'ok' AND r.status = 'draft' AND r.approved_by IS NULL AND r.approved_at IS NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A6 unapprove -> draft, approved_by / approved_at cleared%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A6 unapprove: %s · %s%s', e1, row_to_json(r), chr(10)); END IF;

      -- A7 delete keeps the session plan, unlinked
      SELECT ai_text INTO v_txt FROM public.session_plans WHERE id = v_sp;
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok';
      BEGIN PERFORM public.delete_drill_plan(v_p); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'ok' AND NOT EXISTS (SELECT 1 FROM public.drill_plans WHERE id = v_p)
         AND (SELECT drill_plan_id IS NULL AND ai_text = v_txt AND session_id = v_sess FROM public.session_plans WHERE id = v_sp) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  A7 delete -> the plan is gone; the session plan is kept, unlinked, text intact%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A7 delete: %s · plan still there %s · session plan %s%s', e1, EXISTS (SELECT 1 FROM public.drill_plans WHERE id = v_p),
        (SELECT row_to_json(x)::text FROM (SELECT drill_plan_id, session_id FROM public.session_plans WHERE id = v_sp) x), chr(10)); END IF;

      -- O1 an Officer (not a DA) writes + approves; a Board Member / Project Admin who is neither is refused
      IF v_off IS NULL AND v_nop IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  O1 — no Officer-only and no Board/PA-only member here%s', chr(10));
      ELSE
        e1 := 'n/a'; e2 := 'n/a'; e3 := 'n/a'; v_p2 := NULL;
        IF v_off IS NOT NULL THEN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          e1 := 'ok'; e2 := 'ok';
          BEGIN SELECT (public.set_drill_plan(NULL, 'RETEST officer plan', NULL, NULL, NULL, C, 'manual')).id INTO v_p2; EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
          BEGIN PERFORM public.approve_drill_plan(v_p2); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
          PERFORM set_config('role', 'postgres', true);
        END IF;
        IF v_nop IS NOT NULL THEN
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_nop, 'role', 'authenticated')::text, true);
          PERFORM set_config('role', 'authenticated', true);
          e3 := 'ok';
          BEGIN PERFORM public.set_drill_plan(NULL, 'RETEST board plan', NULL, NULL, NULL, C); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
          PERFORM set_config('role', 'postgres', true);
        END IF;
        IF (v_off IS NULL OR (e1 = 'ok' AND e2 = 'ok' AND (SELECT status = 'approved' AND source = 'manual' AND approved_by = v_off_mid AND created_by = v_off_mid FROM public.drill_plans WHERE id = v_p2)))
           AND (v_nop IS NULL OR e3 = 'Only a Department Admin or Officer can manage drill plans.') THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  O1 Officer-only creates + self-approves (%s); Board/PA-only refused (%s)%s', CASE WHEN v_off IS NULL THEN 'no Officer-only here' ELSE 'yes' END, CASE WHEN v_nop IS NULL THEN 'none here' ELSE 'yes' END, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  O1 officer create: %s · approve: %s · board/PA: %s%s', e1, e2, e3, chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
