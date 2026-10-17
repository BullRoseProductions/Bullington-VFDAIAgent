-- =====================================================================
-- SECURITY FIX — members INSERT / DELETE: add the department scope. DRAFT — for the reviewing Claude, then Ashlea applies.
-- Probe first: sql/members_crossdept_PROBE.sql (rollback-wrapped). Test after: sql/members_crossdept_fix_RETEST.sql.
-- PROBE RAN on live 2026-10-17 — CONFIRMED in all 5 departments: a leader of one department can INSERT a member row into
-- another (X2 "CROSS-TENANT INSERT allowed" ×5); cross-department DELETE returned 0 rows ×5 (blocked only because the
-- SELECT policies hide the other department's rows). Live is_leader() is itself department-aware (the CALLER must lead
-- their active department) but nothing ties the ROW's department_id to it — that is the hole this closes.
--
-- THE HOLE (same class as the 2026-10-13 cert leak): the live members write policies are
--   "leaders insert members" FOR INSERT  WITH CHECK (is_leader())
--   "leaders delete members" FOR DELETE  USING      (is_leader())
-- with no department term. is_leader() says "a leader somewhere", so a leader of department A can INSERT a member row
-- into department B (they choose department_id). DELETE across departments is blocked today only INCIDENTALLY — the
-- members SELECT policies hide B's rows, so the DELETE finds nothing — which is a dependency, not a rule (the same
-- fails-open shape noted in lock_sessions_with_attendance). Both get an explicit department term.
--
-- THE CHANGE — two ALTER POLICY statements, nothing else:
--   INSERT  WITH CHECK (is_leader() AND department_id = my_department_id())
--   DELETE  USING      (is_leader() AND department_id = my_department_id())
-- is_leader() itself is NOT edited (other policies use it). my_department_id() is the caller's active department (the
-- multi-station picker) — a leader adds/removes members in the department they're working in, as the Roster does.
-- Unaffected by design: PA tools write through SECURITY DEFINER RPCs (pa_add_member, pa_create_department), which
-- bypass RLS and keep their own gates; members UPDATE is already is_dept_admin() + department.
--
-- GUARDED: refuses unless each live policy expression is exactly is_leader() (ALTER POLICY replaces the whole
-- expression, so it must be what this was written against), and unless there is exactly one INSERT and one DELETE
-- policy on members (permissive policies OR together — a second one would keep the hole open).
-- POST-CONDITIONS: both expressions now carry my_department_id(); every OTHER policy in public is byte-identical.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard (already fixed).
-- =====================================================================
DO $fix$
DECLARE
  v_before text; v_after text; v_n int; v_ins text; v_del text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'
       AND NOT (tablename = 'members' AND policyname IN ('leaders insert members', 'leaders delete members'))$q$;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND cmd = 'INSERT';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected exactly one INSERT policy on members, found %. Nothing changed.', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND cmd = 'DELETE';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected exactly one DELETE policy on members, found %. Nothing changed.', v_n; END IF;
  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND policyname = 'leaders insert members' AND cmd = 'INSERT';
  SELECT qual       INTO v_del FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND policyname = 'leaders delete members' AND cmd = 'DELETE';
  IF v_ins IS DISTINCT FROM 'is_leader()' THEN
    RAISE EXCEPTION 'The INSERT policy is not the expected is_leader() (live: %). Already fixed, or drifted. Nothing changed.', coalesce(v_ins, 'missing');
  END IF;
  IF v_del IS DISTINCT FROM 'is_leader()' THEN
    RAISE EXCEPTION 'The DELETE policy is not the expected is_leader() (live: %). Already fixed, or drifted. Nothing changed.', coalesce(v_del, 'missing');
  END IF;
  EXECUTE pol_sql INTO v_before;

  ALTER POLICY "leaders insert members" ON public.members WITH CHECK (public.is_leader() AND department_id = public.my_department_id());
  ALTER POLICY "leaders delete members" ON public.members USING      (public.is_leader() AND department_id = public.my_department_id());

  SELECT with_check INTO v_ins FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND policyname = 'leaders insert members';
  SELECT qual       INTO v_del FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND policyname = 'leaders delete members';
  IF position('my_department_id()' in v_ins) = 0 OR position('is_leader()' in v_ins) = 0
     OR position('my_department_id()' in v_del) = 0 OR position('is_leader()' in v_del) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: the new expressions are not as intended (insert %, delete %). Rolling back.', v_ins, v_del;
  END IF;
  EXECUTE pol_sql INTO v_after;
  IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'Post-condition failed: a policy other than these two changed. Rolling back.'; END IF;
  RAISE NOTICE 'members INSERT check: %; DELETE using: %', v_ins, v_del;
END
$fix$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect both rows to carry "my_department_id()"; total_policies unchanged (157)
SELECT policyname, cmd, coalesce(qual, with_check) AS expression,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' AND cmd IN ('INSERT', 'DELETE') ORDER BY cmd;

-- =====================================================================
-- ROLLBACK (only if needed, separately) — restores the exact pre-fix expressions (re-opens the hole).
-- =====================================================================
-- ALTER POLICY "leaders insert members" ON public.members WITH CHECK (public.is_leader());
-- ALTER POLICY "leaders delete members" ON public.members USING (public.is_leader());
-- NOTIFY pgrst, 'reload schema';
