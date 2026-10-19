-- =====================================================================
-- SECURITY FIX — apparatus UPDATE gate: Department Admin + Officer only (is_canmanage_ops()), department-scoped.
-- Record: Claude gate review PASS 2026-10-18 (recorded BEFORE apply). Not yet applied. Test: sql/apparatus_update_gate_RETEST.sql (run AFTER, separately).
-- Brief: claude/B4C_Apparatus_UpdateGate_Fix_BuildOrder.md. Found in #3 Step 0 (3c38ac1).
-- Step 0: sql/apparatus_update_gate_STEP0_CHECK.sql — RAN on live 2026-10-18:
--   * the live UPDATE policy "members update apparatus" is department-only — ANY member can update any apparatus column
--     (name, type, costs, in_service, station_id, deleted_at…);
--   * every function that writes apparatus is SECURITY DEFINER (finalize_check, resolve_apparatus_failure,
--     retire_ / restore_apparatus, take_ / return_apparatus_to_service, set_apparatus_check_interval) — they write as the
--     owner, so this policy never touched them; start_or_resume_check / mark_check_item don't write apparatus at all;
--   * no trigger anywhere writes apparatus; the only client-side apparatus UPDATE is the DA/Officer-gated admin edit
--     (saveEditRig). => members don't need a direct apparatus UPDATE to run a check. Tighten the policy (§1), no guard
--     triggers needed.
--
-- WHAT CHANGES: the apparatus UPDATE policy only —
--   DROP "members update apparatus"  USING (department_id = my_department_id())  CHECK (same)
--   ADD  "ops update apparatus"      USING (department_id = my_department_id() AND is_canmanage_ops())  CHECK (same)
-- is_canmanage_ops() is department-scoped + status-aware (DA / Officer, Active / Probationary) — the same gate the
-- apparatus INSERT policy already uses. NOT is_canmanage() (Board would be looser) and never is_leader().
-- UNCHANGED (post-conditions prove it): apparatus SELECT / INSERT / DELETE policies; every other table's policies,
--   character for character (incl. apparatus_maintenance's own broad UPDATE — a separate finding, not this fix);
--   the check / service RPCs; the apparatus triggers (check-interval guard + removal guard — now belt-and-suspenders).
--   Never touches the locked verification column.
-- DRY RUN 2026-10-18 (PGlite; stand-in check RPCs with the live signatures + definer behaviour): RETEST 13 passed /
-- 0 failed / 3 skipped; the SAME RETEST against the database BEFORE the fix fails U1 (a member renames, takes out of
-- service and soft-deletes a rig) — the hole is real. Mutations, each caught: gate dropped -> U1/G0 · department
-- dropped -> G0 · old policy left -> rolls back · another table's policy touched -> rolls back · an INVOKER apparatus
-- writer present -> refused before any change · a check RPC drifting -> rolls back · re-run -> refused.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_trg_before text; v_trg_after text; v_fn_before text; v_fn_after text; v_n int;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND NOT (tablename = 'apparatus' AND cmd = 'UPDATE')$q$;
  trg_sql constant text := $q$
    SELECT coalesce(string_agg(tgname || '|' || tgenabled::text || '|' || pg_get_triggerdef(oid), E'\n' ORDER BY tgname), '')
      FROM pg_trigger WHERE tgrelid = 'public.apparatus'::regclass AND NOT tgisinternal$q$;
  fn_sql constant text := $q$
    SELECT coalesce(string_agg(p.proname || '|' || p.prosecdef || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.proname, p.oid), '')
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
       AND p.proname IN ('start_or_resume_check', 'mark_check_item', 'finalize_check', 'resolve_apparatus_failure', 'retire_apparatus',
                         'restore_apparatus', 'take_apparatus_out_of_service', 'return_apparatus_to_service', 'set_apparatus_check_interval')$q$;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'ops update apparatus') THEN
    RAISE EXCEPTION 'Precondition failed: "ops update apparatus" already exists — already applied. Nothing changed.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND cmd IN ('UPDATE', 'ALL');
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus'
                               AND policyname = 'members update apparatus' AND cmd = 'UPDATE'
                               AND regexp_replace(qual, '\s', '', 'g') = '(department_id=my_department_id())'
                               AND regexp_replace(with_check, '\s', '', 'g') = '(department_id=my_department_id())') THEN
    RAISE EXCEPTION 'Precondition failed: the apparatus UPDATE policy is not exactly the department-only "members update apparatus" Step 0 saw. Nothing changed.';
  END IF;
  IF to_regprocedure('public.is_canmanage_ops()') IS NULL OR position('my_department_id()' in pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: is_canmanage_ops() is missing or no longer department-scoped.';
  END IF;
  -- the safety argument, re-checked at apply time: nothing that writes apparatus may run as the caller
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND NOT p.prosecdef
     AND pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?apparatus\s';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'Precondition failed: % SECURITY INVOKER function(s) write apparatus — a member flow could depend on the broad policy. STOP: use per-column guard triggers instead.', v_n;
  END IF;
  EXECUTE pol_sql INTO v_pol_before;
  EXECUTE trg_sql INTO v_trg_before;
  EXECUTE fn_sql INTO v_fn_before;

  -- ---------------------------------------------------------------- the fix
  DROP POLICY "members update apparatus" ON public.apparatus;
  CREATE POLICY "ops update apparatus" ON public.apparatus FOR UPDATE TO authenticated
    USING (department_id = public.my_department_id() AND public.is_canmanage_ops())
    WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops());

  -- ---------------------------------------------------------------- post-conditions (any failure undoes the change)
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND cmd IN ('UPDATE', 'ALL');
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'ops update apparatus'
                               AND cmd = 'UPDATE' AND roles = '{authenticated}'
                               AND position('my_department_id()' in qual) > 0 AND position('is_canmanage_ops()' in qual) > 0
                               AND position('my_department_id()' in with_check) > 0 AND position('is_canmanage_ops()' in with_check) > 0
                               AND position('is_leader' in qual || with_check) = 0 AND position('is_canmanage()' in qual || with_check) = 0) THEN
    RAISE EXCEPTION 'Post-condition failed: apparatus must have exactly one UPDATE policy, department-scoped AND is_canmanage_ops() on both sides.';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy other than the apparatus UPDATE changed.'; END IF;
  EXECUTE trg_sql INTO v_trg_after;
  IF v_trg_after IS DISTINCT FROM v_trg_before THEN RAISE EXCEPTION 'Post-condition failed: an apparatus trigger changed.'; END IF;
  EXECUTE fn_sql INTO v_fn_after;
  IF v_fn_after IS DISTINCT FROM v_fn_before THEN RAISE EXCEPTION 'Post-condition failed: a check / service RPC changed.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: update_policies 1 · gate true · old_gone true · invoker_writers 0 · triggers 3 ·
-- total_policies 165 (one dropped, one added). The last column is INFORMATIONAL (the second Step 0 side finding):
-- whether RLS is on for the check tables members hold grants on but that have no write policies — RLS on = writes refused.
SELECT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND cmd IN ('UPDATE', 'ALL')) AS update_policies,
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'ops update apparatus'
                 AND position('is_canmanage_ops()' in qual) > 0 AND position('is_canmanage_ops()' in with_check) > 0) AS gate,
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'apparatus' AND policyname = 'members update apparatus') AS old_gone,
       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND NOT p.prosecdef
          AND pg_get_functiondef(p.oid) ~* 'update\s+(public\.)?apparatus\s') AS invoker_writers,
       (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.apparatus'::regclass AND NOT tgisinternal) AS triggers,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
       (SELECT string_agg(relname || '=' || CASE WHEN relrowsecurity THEN 'rls on' ELSE 'RLS OFF (!)' END, ' · ' ORDER BY relname)
          FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('apparatus_checks', 'apparatus_check_results', 'apparatus_service_periods')) AS check_tables_rls;

-- ROLLBACK (only if needed, separately):
-- DROP POLICY "ops update apparatus" ON public.apparatus;
-- CREATE POLICY "members update apparatus" ON public.apparatus FOR UPDATE TO authenticated
--   USING (department_id = my_department_id()) WITH CHECK (department_id = my_department_id());
-- NOTIFY pgrst, 'reload schema';
