-- =====================================================================
-- CERT DISPLAY FIX G2 — my_department_rollup() cert-count regex — Review PASS 2026-10-21 (28e4b09). Not yet applied.
-- Order: claude/B4C_CertDisplayFixes_BuildOrder.md. Off Step 0b (2026-10-21, docs/review/cert_catalog_STEP0B_OUTPUT.md).
--
-- THE BUG: live my_department_rollup() (md5 058316de…) carries '^\\d{4}-\\d{2}$' — TWO backslashes — in all five
-- cert counts (expiring_certs_count, expired_certs_count, my_certs_current, my_certs_expiring, my_certs_expired). Under
-- standard_conforming_strings = on that is "a literal backslash, then dddd": it never matches a real date, so all five
-- read 0 for every caller. Its siblings pa_department_radar() and dept_cert_readiness() carry one backslash and count.
--
-- THE FIX — the five literals only: '^\\d{4}-\\d{2}$' -> '^\d{4}-\d{2}$' (the siblings' form). The new definition is
-- BUILT from the live one (pg_get_functiondef + replace) rather than retyped, so nothing else can move; the
-- post-condition proves it — the new prosrc must equal the old live prosrc with exactly those five substitutions, and
-- match its reviewed md5. Month arithmetic, UTC now(), the 0–3 window, the can_manage gating, the authorization
-- boundary, owner / SECURITY DEFINER / search_path / EXECUTE grants: all unchanged. Display only; no write path.
-- (The lax-vs-strict month rule, UTC vs Chicago, and never_expires are the catalog's G3/G5 work — not here.)
--
-- Single all-or-nothing DO block; refuses on drift (md5 pinned) and refuses a second apply. Every other public
-- function's definition and every policy byte-identical; total_policies and the locked-token function count unchanged.
-- The locked verification column is never touched. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  FN constant regprocedure := 'public.my_department_rollup()'::regprocedure;
  MD5_OLD constant text := '058316de93cfdde8fbe732121c4b903f';   -- live 2026-10-21 (Step 0b)
  MD5_NEW constant text := '7b12e359bf7af9343565435658253a23';   -- the old body with the five substitutions
  RE_OLD constant text := $re$'^\\d{4}-\\d{2}$'$re$;                -- two backslashes (the bug)
  RE_NEW constant text := $re$'^\d{4}-\d{2}$'$re$;                  -- one backslash (pa_department_radar's form)
  v_md5 text; v_src text; v_meta text; v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text;
  v_total_before int; v_tok_before int;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  v_md5 := md5(pg_get_functiondef(FN));
  IF v_md5 = MD5_NEW THEN
    RAISE EXCEPTION 'Precondition failed: my_department_rollup() already carries the single-backslash regex — already applied. Nothing changed.';
  END IF;
  IF v_md5 <> MD5_OLD THEN
    RAISE EXCEPTION 'Precondition failed: my_department_rollup() is not the Step 0b version (md5 %, expected 058316de…). Nothing changed.', v_md5;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = FN;
  IF (length(v_src) - length(replace(v_src, RE_OLD, ''))) / length(RE_OLD) <> 5 THEN
    RAISE EXCEPTION 'Precondition failed: expected exactly 5 doubled-backslash cert regexes. Nothing changed.';
  END IF;
  IF position(RE_NEW in v_src) > 0 THEN
    RAISE EXCEPTION 'Precondition failed: the body already has a single-backslash regex somewhere — unexpected. Nothing changed.';
  END IF;
  SELECT p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
         || '|' || coalesce(p.proacl::text, '') || '|' || pg_get_function_result(p.oid)
    INTO v_meta FROM pg_proc p WHERE p.oid = FN;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND p.oid <> FN;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;

  -- ---------------------------------------------------------------- the change: the live definition, five literals corrected
  EXECUTE replace(pg_get_functiondef(FN), RE_OLD, RE_NEW);

  -- ---------------------------------------------------------------- post-conditions
  IF (SELECT prosrc FROM pg_proc WHERE oid = FN) IS DISTINCT FROM replace(v_src, RE_OLD, RE_NEW) THEN
    RAISE EXCEPTION 'Post-condition failed: my_department_rollup() differs from the live body by more than the five regex literals.';
  END IF;
  IF md5(pg_get_functiondef(FN)) <> MD5_NEW THEN
    RAISE EXCEPTION 'Post-condition failed: my_department_rollup() does not match its reviewed md5.';
  END IF;
  IF (SELECT position(RE_OLD in prosrc) FROM pg_proc WHERE oid = FN) > 0
     OR (SELECT (length(prosrc) - length(replace(prosrc, RE_NEW, ''))) / length(RE_NEW) FROM pg_proc WHERE oid = FN) <> 5 THEN
    RAISE EXCEPTION 'Post-condition failed: the five cert regexes are not all single-backslash.';
  END IF;
  IF (SELECT p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
             || '|' || coalesce(p.proacl::text, '') || '|' || pg_get_function_result(p.oid) FROM pg_proc p WHERE p.oid = FN) IS DISTINCT FROM v_meta THEN
    RAISE EXCEPTION 'Post-condition failed: owner, SECURITY DEFINER, volatility, search_path, EXECUTE grants or the return shape changed.';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND p.oid <> FN;
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: another public function changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: the policy count changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: rollup_md5_ok true · doubled_left 0 · single_backslash 5 · total_policies 169 · locked_token_fns 17)
SELECT
  md5(pg_get_functiondef('public.my_department_rollup()'::regprocedure)) = '7b12e359bf7af9343565435658253a23' AS rollup_md5_ok,
  (SELECT (length(prosrc) - length(replace(prosrc, $re$'^\\d{4}-\\d{2}$'$re$, ''))) / length($re$'^\\d{4}-\\d{2}$'$re$)
     FROM pg_proc WHERE oid = 'public.my_department_rollup()'::regprocedure) AS doubled_left,
  (SELECT (length(prosrc) - length(replace(prosrc, $re$'^\d{4}-\d{2}$'$re$, ''))) / length($re$'^\d{4}-\d{2}$'$re$)
     FROM pg_proc WHERE oid = 'public.my_department_rollup()'::regprocedure) AS single_backslash,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
