-- =====================================================================
-- SECURITY FIX — apparatus_maintenance UPDATE gate: Department Admin + Officer only (is_canmanage_ops()), dept-scoped.
-- Record: Claude gate review PASS 2026-10-18 on 7bdaa2f (recorded BEFORE apply). Not applied. Live Step 0 ran 2026-10-18 and matches every precondition
-- (sql/apparatus_maintenance_gate_STEP0_CHECK.sql); the preconditions re-check it at apply time anyway. Test: sql/apparatus_maintenance_gate_RETEST.sql (run AFTER, separately).
-- Built from the reviewed + applied sql/apparatus_update_gate_2026-10-18.sql — same shape, the table swapped.
-- Found in #3 Step 0 (3c38ac1); left out of the apparatus fix's scope; Ashlea asked to close it 2026-10-18.
--
-- THE HOLE: "members update apparatus_maintenance" is department-only (USING department_id = my_department_id()), so
-- any member can edit any maintenance row — the task, its cadence, last_done_at (reset a due item without doing it).
-- WHY IT'S SAFE TO TIGHTEN (code side, src/App.jsx): the only client writes are the maintenance card's add / Mark done /
-- edit / remove, every control gated canManage = CANMANAGE_OPS_ROLES (DA / Officer); Mark done first INSERTs
-- apparatus_maintenance_log, whose policy is already is_canmanage_ops() — so a member could never complete it anyway.
-- The precondition refuses if any SECURITY INVOKER function updates apparatus_maintenance.
--
-- WHAT CHANGES: the apparatus_maintenance UPDATE policy only —
--   DROP "members update apparatus_maintenance"  USING (department_id = my_department_id())
--   ADD  "ops update apparatus_maintenance"      USING + CHECK (department_id = my_department_id() AND is_canmanage_ops())
--   — matching its INSERT / DELETE policies, which are already department AND is_canmanage_ops().
-- UNCHANGED (post-conditions prove it): every other policy character for character (incl. the 2026-10-18 apparatus
--   fix), apparatus_maintenance's triggers, and every function that writes it. Never touches the locked verification column.
-- DRY RUN 2026-10-18 (PGlite, the live policy shape incl. aml_insert, with the applied apparatus fix in place): RETEST
-- 9 passed / 0 failed / 3 skipped; the SAME RETEST before the fix fails M1 (a member rewrites the task, its cadence and
-- last_done_at) — the hole is real; the apparatus RETEST still passes after it. Mutations caught: gate dropped -> M1/G0 ·
-- old policy left -> rolls back · the apparatus fix's policy touched -> rolls back · an INVOKER writer -> refused · re-run -> refused.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_trg_before text; v_trg_after text; v_fn_before text; v_fn_after text; v_n int;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND NOT (tablename = 'apparatus_maintenance' AND cmd = 'UPDATE')$q$;
  trg_sql constant text := $q$
    SELECT coalesce(string_agg(tgname || '|' || tgenabled::text || '|' || pg_get_triggerdef(oid), E'\n' ORDER BY tgname), '')
      FROM pg_trigger WHERE tgrelid = 'public.apparatus_maintenance'::regclass AND NOT tgisinternal$q$;
  fn_sql constant text := $q$
    SELECT coalesce(string_agg(p.proname || '|' || p.prosecdef || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.proname, p.oid), '')
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?apparatus_maintenance\s'$q$;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND policyname = 'ops update apparatus_maintenance') THEN
    RAISE EXCEPTION 'Precondition failed: "ops update apparatus_maintenance" already exists — already applied. Nothing changed.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND cmd IN ('UPDATE', 'ALL');
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance'
                               AND policyname = 'members update apparatus_maintenance' AND cmd = 'UPDATE'
                               AND regexp_replace(qual, '\s', '', 'g') = '(department_id=my_department_id())'
                               AND coalesce(regexp_replace(with_check, '\s', '', 'g'), '(department_id=my_department_id())') = '(department_id=my_department_id())') THEN
    RAISE EXCEPTION 'Precondition failed: the apparatus_maintenance UPDATE policy is not exactly the department-only "members update apparatus_maintenance" Step 0 saw. Nothing changed.';
  END IF;
  IF to_regprocedure('public.is_canmanage_ops()') IS NULL OR position('my_department_id()' in pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: is_canmanage_ops() is missing or no longer department-scoped.';
  END IF;
  -- the safety argument, re-checked at apply time: nothing that writes apparatus may run as the caller
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND NOT p.prosecdef
     AND pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?apparatus_maintenance\s';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Precondition failed: % SECURITY INVOKER function(s) update apparatus_maintenance — a member flow could depend on the broad policy. STOP and report.', v_n;
  END IF;
  EXECUTE pol_sql INTO v_pol_before;
  EXECUTE trg_sql INTO v_trg_before;
  EXECUTE fn_sql INTO v_fn_before;

  -- ---------------------------------------------------------------- the fix
  DROP POLICY "members update apparatus_maintenance" ON public.apparatus_maintenance;
  CREATE POLICY "ops update apparatus_maintenance" ON public.apparatus_maintenance FOR UPDATE TO authenticated
    USING (department_id = public.my_department_id() AND public.is_canmanage_ops())
    WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops());

  -- ---------------------------------------------------------------- post-conditions (any failure undoes the change)
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND cmd IN ('UPDATE', 'ALL');
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND policyname = 'ops update apparatus_maintenance'
                               AND cmd = 'UPDATE' AND roles = '{authenticated}'
                               AND position('my_department_id()' in qual) > 0 AND position('is_canmanage_ops()' in qual) > 0
                               AND position('my_department_id()' in with_check) > 0 AND position('is_canmanage_ops()' in with_check) > 0
                               AND position('is_leader' in qual || with_check) = 0 AND position('is_canmanage()' in qual || with_check) = 0) THEN
    RAISE EXCEPTION 'Post-condition failed: apparatus_maintenance must have exactly one UPDATE policy, department-scoped AND is_canmanage_ops() on both sides.';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy other than the apparatus_maintenance UPDATE changed.'; END IF;
  EXECUTE trg_sql INTO v_trg_after;
  IF v_trg_after IS DISTINCT FROM v_trg_before THEN RAISE EXCEPTION 'Post-condition failed: an apparatus_maintenance trigger changed.'; END IF;
  EXECUTE fn_sql INTO v_fn_after;
  IF v_fn_after IS DISTINCT FROM v_fn_before THEN RAISE EXCEPTION 'Post-condition failed: a function that writes apparatus_maintenance changed.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: update_policies 1 · gate true · old_gone true · invoker_writers 0 · apparatus_gate_kept
-- true (the 2026-10-18 apparatus fix untouched) · total_policies 165 (one dropped, one added)
SELECT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND cmd IN ('UPDATE', 'ALL')) AS update_policies,
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND policyname = 'ops update apparatus_maintenance'
                 AND position('is_canmanage_ops()' in qual) > 0 AND position('is_canmanage_ops()' in with_check) > 0) AS gate,
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus_maintenance' AND policyname = 'members update apparatus_maintenance') AS old_gone,
       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND NOT p.prosecdef
          AND pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?apparatus_maintenance\s') AS invoker_writers,
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'ops update apparatus') AS apparatus_gate_kept,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately):
-- DROP POLICY "ops update apparatus_maintenance" ON public.apparatus_maintenance;
-- CREATE POLICY "members update apparatus_maintenance" ON public.apparatus_maintenance FOR UPDATE TO authenticated
--   USING (department_id = my_department_id());
-- NOTIFY pgrst, 'reload schema';
