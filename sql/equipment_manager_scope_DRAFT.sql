-- =====================================================================
-- EQUIPMENT-MANAGER DEPARTMENT-SCOPE FIX — DRAFT, not reviewed, not applied.
-- Order: claude/B4C_EquipmentManager_DeptScope_Fix_BuildOrder.md · Step 0 PASS:
-- claude/B4C_EquipmentManager_DeptScope_Fix_Step0_ReviewRecord.md (audit: claude/B4C_EquipmentManager_DeptScope_Fix_Step0.md,
-- live evidence docs/review/equipment_manager_scope_STEP0_OUTPUT.json — 173 policies, 17 locked-token functions).
--
-- THE CHANGE — one function, nothing else:
--   is_equipment_manager() today is true for an active equipment_manager row matched by the caller's EMAIL in ANY department,
--   so a manager in A who acts in B is a manager in B. All 9 policies and 5 RPCs that take their role from it leak that way
--   (their row-department checks scope the ROW, not the ROLE). Re-created with the is_training_officer() shape: an active row
--   for my_member_id() IN my_department_id(). Same signature, LANGUAGE sql, STABLE, SECURITY DEFINER, search_path public;
--   CREATE OR REPLACE keeps the owner and grants. The old join's status filter ('Active','Probationary') is already enforced
--   by my_member_id(). Tightening only: a single-department manager is unaffected (live today: all 6 managers are
--   single-department — no live exposure; this closes the latent case).
-- NOT touched: every other function (incl. the 5 RPCs and the department-safe inline checks — witness, assign / remove, cap),
-- every policy, every trigger, the client. verified never touched.
--
-- Single all-or-nothing DO block. Preconditions: is_equipment_manager() is the reviewed leaking body (c4d54ae1) — refuses if
-- it already carries the department scope ("already applied") or drifted otherwise; my_member_id() / my_department_id() pinned.
-- Post-conditions: the new body's reviewed md5 and both scopes; identity / language / volatility / definer / search_path /
-- grants unchanged; every other function (md5 + grants), every policy and every trigger in public byte-identical;
-- total_policies unchanged; the locked-token count unchanged. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_trg_before text; v_trg_after text;
  v_total_before int; v_tok_before int; v_meta_before text;
  NEW_MD5 constant text := 'a979933dac145e88d58331a04d6c918a';
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF position('em.department_id = public.my_department_id()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'Precondition failed: is_equipment_manager() is already department-scoped — already applied. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) <> 'c4d54ae10cb936dcc5f185ae38ec5fcd' THEN
    RAISE EXCEPTION 'Precondition failed: is_equipment_manager() drifted from the reviewed body (md5 c4d54ae1…). Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.my_member_id()'::regprocedure)) <> '3f66369c8af7bc07ec59831af6536fee'
     OR md5(pg_get_functiondef('public.my_department_id()'::regprocedure)) <> '87f546659c3804a943b48e419e017f18' THEN
    RAISE EXCEPTION 'Precondition failed: my_member_id() / my_department_id() drifted (3f66369c… / 87f54665…). Nothing changed.';
  END IF;

  -- snapshots: the function's identity + everything else
  SELECT p.prorettype::regtype::text || '|' || l.lanname || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(p.proacl::text, '') || '|' || p.proowner::regrole::text
    INTO v_meta_before FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.is_equipment_manager()'::regprocedure;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND p.oid <> 'public.is_equipment_manager()'::regprocedure;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT string_agg(c.relname || '.' || t.tgname || '|' || t.tgfoid::regprocedure::text || '|' || t.tgenabled::text, E'\n' ORDER BY c.relname, t.tgname)
    INTO v_trg_before FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace;
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;

  -- ---------------------------------------------------------------- the fix
  CREATE OR REPLACE FUNCTION public.is_equipment_manager()
   RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:equipment managers — an ACTIVE registry row for the caller's member row IN the caller's department. Department-scoped
  -- 2026-10-24 (the is_training_officer() shape): it used to match the caller's email in ANY department, so a manager in one
  -- department was a manager in every department they belonged to.
    select exists (
      select 1 from public.equipment_manager em
       where em.member_id = public.my_member_id()
         and em.department_id = public.my_department_id()
         and em.removed_at is null
    );
  $fn$;

  -- ---------------------------------------------------------------- post-conditions
  IF position('em.member_id = public.my_member_id()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) = 0
     OR position('em.department_id = public.my_department_id()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) = 0
     OR position('auth.email()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'Post-condition failed: is_equipment_manager() is not scoped to my_member_id() in my_department_id() (or still matches by email).';
  END IF;
  IF md5(pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) <> NEW_MD5 THEN
    RAISE EXCEPTION 'Post-condition failed: is_equipment_manager() does not match its reviewed md5.';
  END IF;
  IF (SELECT p.prorettype::regtype::text || '|' || l.lanname || '|' || p.provolatile::text || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(p.proacl::text, '') || '|' || p.proowner::regrole::text
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.is_equipment_manager()'::regprocedure) IS DISTINCT FROM v_meta_before THEN
    RAISE EXCEPTION 'Post-condition failed: is_equipment_manager()''s return type / language / volatility / definer / search_path / grants / owner changed.';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND p.oid <> 'public.is_equipment_manager()'::regprocedure;
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: another function (or its grants) changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed.'; END IF;
  SELECT string_agg(c.relname || '.' || t.tgname || '|' || t.tgfoid::regprocedure::text || '|' || t.tgenabled::text, E'\n' ORDER BY c.relname, t.tgname)
    INTO v_trg_after FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace;
  IF v_trg_after IS DISTINCT FROM v_trg_before THEN RAISE EXCEPTION 'Post-condition failed: a trigger changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: total_policies changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: scoped true · by_email false · eqm_md5 <the reviewed md5, first 8> · grants authenticated-only
--              (anon false) · managers_active 6 (unchanged) · total_policies 173 · locked_token_fns 17)
SELECT
  position('em.department_id = public.my_department_id()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) > 0
    AND position('em.member_id = public.my_member_id()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) > 0 AS scoped,
  position('auth.email()' in pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) > 0 AS by_email,
  left(md5(pg_get_functiondef('public.is_equipment_manager()'::regprocedure)), 8) AS eqm_md5,
  has_function_privilege('authenticated', 'public.is_equipment_manager()'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.is_equipment_manager()'::regprocedure, 'EXECUTE') AS grants_ok,
  (SELECT count(*) FROM public.equipment_manager WHERE removed_at IS NULL) AS managers_active,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
