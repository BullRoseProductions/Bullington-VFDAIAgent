-- =====================================================================
-- RETEST for cert_submissions_dept_scope_DRAFT.sql. READ-ONLY IN EFFECT.
-- RAN 2026-10-13 (v1): 10/10 passed — but B/C/E all SKIPPED (no pending submissions existed anywhere).
-- RAN 2026-10-13 (v2): 23/23 passed, 0 failed — all 5 departments; only E skipped for Granbury + Lipan
-- (no submissions of their own). Safe to re-run any time: the regression check for cert_submissions scoping.
-- v2: makes its own fixtures — at the start it flips ONE existing submission per department to
-- 'pending' (as the owner, inside this block), so B/C/E always run. The final RAISE rolls every one
-- of those flips back, along with any cert the own-department approve creates.
-- Run AFTER the fix. One DO block: for each department, sign in as one ordinary Dept Admin
-- (not a Project Admin) exactly as the app does (JWT email claim + role authenticated), then:
--   A. sees 0 OTHER-department submissions (and still sees its own)
--   B. reject_cert_submission on another department's PENDING submission -> 'Not in your department'
--   C. approve_cert_submission on it -> 'Not in your department' (no cert created)
--   D. inserting a pending submission for another department's member -> refused by RLS
--   E. approve on an OWN-department pending submission still works (if one exists)
-- Every write attempt is inside a sub-block ending in RAISE 'SENTINEL' (rolled back), and the
-- whole block ends in RAISE = the report + final rollback. Nothing changes. The "ERROR" IS the report.
-- =====================================================================
DO $retest$
DECLARE
  rec record;
  v_other int; v_own int; v_err text; v_target uuid; v_own_target uuid; v_tmember uuid; v_tdept uuid;
  rpt text := chr(10); n int := 0; v_pass int := 0; v_fail int := 0;
BEGIN
  -- Josh Merritt's 23 (reset to pending earlier today) — where are they now? (read as owner)
  rpt := rpt || (SELECT format('   Josh Merritt: %s pending · %s approved · %s rejected (of %s)%s',
                   count(*) FILTER (WHERE status = 'pending'), count(*) FILTER (WHERE status = 'approved'),
                   count(*) FILTER (WHERE status = 'rejected'), count(*), chr(10))
                   FROM public.cert_submissions WHERE member_id = '019d1fd0-e063-4d7d-adae-d770d444a1dd');
  -- FIXTURES: one submission per department becomes 'pending' for the duration of this block (rolled back at the end)
  UPDATE public.cert_submissions cs SET status = 'pending'
   WHERE cs.id IN (SELECT DISTINCT ON (department_id) id FROM public.cert_submissions ORDER BY department_id, created_at DESC)
     AND cs.status <> 'pending';
  FOR rec IN
    SELECT DISTINCT ON (m.department_id) m.department_id, d.name AS dept, m.id AS mid, lower(m.email) AS email, m.name
      FROM public.members m JOIN public.departments d ON d.id = m.department_id
     WHERE m.email IS NOT NULL AND m.status IS DISTINCT FROM 'Inactive'
       AND m.access && array['Department Admin'] AND NOT (m.access && array['Project Admin'])
     ORDER BY m.department_id, m.id
  LOOP
    rpt := rpt || format('— %s (DA %s)%s', rec.dept, rec.name, chr(10));
    -- fixtures, read as the table owner: another department's pending submission + member; an own-dept pending one
    SELECT id INTO v_target FROM public.cert_submissions WHERE status = 'pending' AND department_id <> rec.department_id ORDER BY created_at LIMIT 1;
    SELECT id INTO v_own_target FROM public.cert_submissions WHERE status = 'pending' AND department_id = rec.department_id ORDER BY created_at LIMIT 1;
    SELECT m.id, m.department_id INTO v_tmember, v_tdept FROM public.members m WHERE m.department_id <> rec.department_id ORDER BY m.id LIMIT 1;

    -- A. visibility
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      IF public.my_member_id() IS DISTINCT FROM rec.mid THEN RAISE EXCEPTION 'IMPERSONATION FAILED'; END IF;
      SELECT count(*) FILTER (WHERE department_id <> rec.department_id), count(*) FILTER (WHERE department_id = rec.department_id)
        INTO v_other, v_own FROM public.cert_submissions;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    n := n + 1;
    IF v_err = 'SENTINEL' AND v_other = 0 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  sees 0 other-dept submissions (own dept: %s)%s', v_own, chr(10));
    ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  other-dept visible: %s (err %s)%s', v_other, v_err, chr(10)); END IF;

    IF v_target IS NULL THEN
      rpt := rpt || format('   SKIP  B/C — no other-department pending submission exists%s', chr(10));
    ELSE
      -- B. reject another department's
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.reject_cert_submission(v_target, 'RETEST');
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'Not in your department' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  reject other-dept refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  reject other-dept -> "%s"%s', v_err, chr(10)); END IF;
      -- C. approve another department's
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.approve_cert_submission(v_target);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'Not in your department' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  approve other-dept refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  approve other-dept -> "%s"%s', v_err, chr(10)); END IF;
    END IF;

    -- D. leader insert for another department's member
    IF v_tmember IS NOT NULL THEN
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        INSERT INTO public.cert_submissions (department_id, member_id, name, status, source, proposed_by)
        VALUES (v_tdept, v_tmember, 'RETEST cross-dept', 'pending', 'leader', auth.uid());
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      -- must be refused BY THE POLICY — a constraint error would pass for the wrong reason
      IF v_err ILIKE '%row-level security%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  cross-dept insert refused by RLS%s', chr(10));
      ELSIF v_err = 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  cross-dept insert WAS ALLOWED%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   CHECK insert failed for another reason: "%s"%s', left(v_err, 90), chr(10)); END IF;
    END IF;

    -- E. own department still works
    IF v_own_target IS NULL THEN
      rpt := rpt || format('   SKIP  E — no own-department pending submission to try%s', chr(10));
    ELSE
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('email', rec.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        PERFORM public.approve_cert_submission(v_own_target);
        RAISE EXCEPTION 'SENTINEL';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
      END;
      n := n + 1;
      IF v_err = 'SENTINEL' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  own-dept approve still works (rolled back)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  own-dept approve -> "%s"%s', v_err, chr(10)); END IF;
    END IF;
  END LOOP;
  RAISE EXCEPTION E'%\n---- % passed, % failed of % ----\n(this exception IS the rollback — nothing changed)', rpt, v_pass, v_fail, n;
END
$retest$;
