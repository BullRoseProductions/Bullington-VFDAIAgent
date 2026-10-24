-- =====================================================================
-- CERT EXPIRY — MALFORMED DATE, THE SQL HALF (DRAFT — for gate review, NOT applied).
-- Order: claude/B4C_CertExpiry_MalformedDate_Fix_BuildOrder.md · Step 0 PASS:
-- claude/B4C_CertExpiry_MalformedDate_Fix_ClientAndStep0_ReviewRecord.md (audit claude/B4C_CertExpiry_MalformedDate_Fix_Step0.md,
-- live evidence docs/review/cert_expiry_malformed_STEP0_OUTPUT.json + _STEP0B_OUTPUT.json — 173 policies, 17 locked-token
-- functions, 179 certs, no triggers on certs / cert_submissions, 0 PENDING malformed submissions).
-- The client half (shared/expiry.js validExpYM) is live in 9e2b170. This makes the SQL read every cert date by the SAME rule.
--
-- THE CHANGE
--   1. public.valid_exp_ym(text) — the SQL twin of validExpYM: 'YYYY-MM', month 01–12, year >= 1900; NULL / blank / anything
--      else -> FALSE (never NULL — the review's coalesce note, so "not valid_exp_ym(exp)" can't drop a row under 3-valued logic).
--      Written as ONE regex with [0-9] (JS \d is ASCII-only; Postgres \d can match non-ASCII digits) and NO ::int cast, so it
--      can never raise. IMMUTABLE, LANGUAGE sql, no SET clause, not definer — so the planner INLINES it (post-condition below
--      checks the plan). That matters: pa_department_radar / my_department_rollup put "c.exp ~ regex AND split_part(c.exp)::int
--      ..." in a WHERE, where the planner orders quals by cost. Inlined, the test costs what the regex costs today and still runs
--      before the cast; a non-inlined call (default COST 100) could be ordered AFTER it and a '' / 'TBD' exp would then raise.
--      Operator schema-qualified (OPERATOR(pg_catalog.~)), so no search_path is needed. EXECUTE authenticated + service_role.
--   2. The five readers' validity tests -> the helper (10 sites). Each re-created from its LIVE body with exactly one token
--      swapped, nothing else:
--        dept_cert_readiness()            1  c.exp !~ '^\d{4}-\d{2}$'              -> not public.valid_exp_ym(c.exp)
--        pa_department_radar()            2  c.exp ~ '^\d{4}-\d{2}$'               -> public.valid_exp_ym(c.exp)
--        my_department_rollup()           5  c.exp ~ '^\d{4}-\d{2}$'               -> public.valid_exp_ym(c.exp)
--        expiration_rows(uuid,uuid)       1  c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'     -> public.valid_exp_ym(c.exp)   (adds the year bound)
--        probation_item_states(uuid,uuid) 1  c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'     -> public.valid_exp_ym(c.exp)   (consistency only)
--   3. update_cert refuses a non-blank exp that isn't valid, with the client's message (blank / NULL still clears the date).
--   4. approve_cert_submission (Ashlea's call): approves, but a malformed exp is CLEARED — the new cert reads "No expiration
--      date" — instead of being copied verbatim. A valid 'YYYY-MM' is copied as before. (Live: 0 pending malformed today.)
--   5. THE DATA (scoped, in this same block) — the 7 live malformed certs, pinned by id + department + current value
--      (docs/review/cert_expiry_malformed_STEP0B_OUTPUT.json, cleanup_targets):
--        B4C Demo Department (94667450-…)  6 full dates -> their month: d19a5449 2026-09-15 · 75badecf 2026-12-31 ·
--            3a9c1f96 2027-03-01 · 4aace421 2027-05-01 · b82eb65a 2027-06-01 · 00b3562b 2028-01-01
--        North Hood County VFD (6d51b00a-…) 1 '0000-00' (the reported Boaters Ed Cert) -> NULL ("No expiration date")
--      Demo's 6 stop reading "No expiration date" and read as their months (as of 2026-10: 2026-09 EXPIRED, 2026-12 EXPIRING,
--      the rest CURRENT) — Demo's readiness numbers move accordingly.
-- NOT touched: every other function, every policy, every trigger, every other cert row, any other column of the 7,
-- cert_submissions (the 24 malformed submissions are all already approved — history; 0 pending). No CHECK on certs.exp.
-- verified never touched.
--
-- Single all-or-nothing DO block. Preconditions: the 7 live md5s (Step 0) and the exact token counts; the 7 cert rows exactly
-- as pinned; refuses if the helper exists ("already applied"). Post-conditions: the helper's shape / grants / truth table /
-- inlining / reviewed md5; each of the 7 functions is EXACTLY its live pre-image with its swap (and its reviewed md5), identity /
-- language / volatility / definer / search_path / grants / owner unchanged; every other function (md5 + grants), every policy and
-- every trigger in public byte-identical; function count +1; total_policies and the locked-token count unchanged; the 7 rows
-- hold their targets (UPDATE row counts 6 and 1 asserted), every other cert row and the 7's other columns byte-identical, the
-- certs count unchanged, malformed certs down by exactly 7; cert_submissions unchanged. State check.
-- =====================================================================
DO $migrate$
DECLARE
  v_spec jsonb; s jsonb; v_def text; v_pre jsonb := '{}'; v_meta jsonb := '{}'; v_line text; v_plan text := '';
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_trg_before text; v_trg_after text;
  v_total_before int; v_tok_before int; v_nfn_before int; v_subs_before text; v_acl_ref text;
  v_t jsonb; v_ids uuid[]; v_n int; v_drift int; v_others_before text; v_cols_before text; v_count_before int; v_bad_before int;
  HELPER_MD5 constant text := '51b8cde1acf4a8e5db26a81dc65bee68';
  DEMO constant uuid := '94667450-481c-4f40-a6b6-86e1b364be93';
  NH   constant uuid := '6d51b00a-bdb0-4807-8e45-70bb53d4dcff';
BEGIN
  -- the 7 malformed certs: id · department · the value now · the value after
  SELECT jsonb_agg(jsonb_build_object('id', id, 'dept', dept, 'was', was, 'to', tgt)), array_agg(id) INTO v_t, v_ids FROM (VALUES
    ('d19a5449-c5e4-47f5-9a91-74bb71894b4d'::uuid, DEMO, '2026-09-15', '2026-09'),
    ('75badecf-7628-4232-9ac8-7415d9915656'::uuid, DEMO, '2026-12-31', '2026-12'),
    ('3a9c1f96-243e-4b42-b398-e46b9235e3dc'::uuid, DEMO, '2027-03-01', '2027-03'),
    ('4aace421-14ba-4d14-b138-5e83d8e4b5ec'::uuid, DEMO, '2027-05-01', '2027-05'),
    ('b82eb65a-78b0-4bbd-853f-a148e75835d4'::uuid, DEMO, '2027-06-01', '2027-06'),
    ('00b3562b-1352-421c-a122-18ad2089a9a9'::uuid, DEMO, '2028-01-01', '2028-01'),
    ('8599898a-0a71-4664-82ae-6e97ede8e7fe'::uuid, NH,   '0000-00',    NULL)
  ) v(id, dept, was, tgt);

  -- the seven: live md5 (Step 0) · the token · its replacement · how many times it occurs · the reviewed md5 after
  SELECT jsonb_agg(jsonb_build_object('fn', fn, 'pre', pre, 'old', old, 'new', new, 'n', n, 'post', post) ORDER BY ord) INTO v_spec FROM (VALUES
    (1, 'public.dept_cert_readiness()', 'd0d54de6a9533e6faa9d0c065c5439df',
        $t$c.exp !~ '^\d{4}-\d{2}$'$t$, $t$not public.valid_exp_ym(c.exp)$t$, 1, '6a55033101e75f1a9c088aaa8bf3e861'),
    (2, 'public.pa_department_radar()', '224f9ec3d5cdd53600b7d5d74319708a',
        $t$c.exp ~ '^\d{4}-\d{2}$'$t$, $t$public.valid_exp_ym(c.exp)$t$, 2, '5093693f4b8941f22a4b4a47263ee1ec'),
    (3, 'public.my_department_rollup()', '7b12e359bf7af9343565435658253a23',
        $t$c.exp ~ '^\d{4}-\d{2}$'$t$, $t$public.valid_exp_ym(c.exp)$t$, 5, 'f46794ccdcd94451ff71f1fa404acefe'),
    (4, 'public.expiration_rows(uuid,uuid)', '27645093a86b7a67dfb04a21d0fca536',
        $t$c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'$t$, $t$public.valid_exp_ym(c.exp)$t$, 1, '4ccf41b4f5d87c1d45ada59a2b91686f'),
    (5, 'public.probation_item_states(uuid,uuid)', 'c663eb8a6d16905ab7a45b763130388f',
        $t$c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'$t$, $t$public.valid_exp_ym(c.exp)$t$, 1, '677b005d7543c35d5c926ca9798e67d6'),
    (6, 'public.update_cert(uuid,text,text)', '08ec5f34bf3d897d95bdbeda5ec52ae7',
        $t$new_exp !~ '^\d{4}-\d{2}$' then
    raise exception 'Expiration must be YYYY-MM (got: %)', new_exp;$t$,
        $t$not public.valid_exp_ym(new_exp) then
    raise exception 'Expiration must be a real month as YYYY-MM (e.g. 2027-06).';$t$, 1, '232cd2f1b6aaf51ec2ec7bf9560f7870'),
    (7, 'public.approve_cert_submission(uuid)', '5a1a89ee0cc2254ad4347f27a141b94e',
        $t$sub.name, sub.exp, sub.proof_path$t$, $t$sub.name, case when public.valid_exp_ym(sub.exp) then sub.exp end, sub.proof_path$t$, 1, '01c1c75c16f24b3fd6209808955f5bd0')
  ) v(ord, fn, pre, old, new, n, post);

  -- ---------------------------------------------------------------- preconditions
  IF to_regprocedure('public.valid_exp_ym(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: public.valid_exp_ym(text) already exists — already applied. Nothing changed.';
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    IF to_regprocedure(s ->> 'fn') IS NULL THEN RAISE EXCEPTION 'Precondition failed: % is missing. Nothing changed.', s ->> 'fn'; END IF;
    v_def := pg_get_functiondef((s ->> 'fn')::regprocedure);
    IF md5(v_def) <> s ->> 'pre' THEN
      RAISE EXCEPTION 'Precondition failed: % drifted from the reviewed live body (md5 %…). Nothing changed.', s ->> 'fn', left(s ->> 'pre', 8);
    END IF;
    IF (length(v_def) - length(replace(v_def, s ->> 'old', ''))) / length(s ->> 'old') <> (s ->> 'n')::int THEN
      RAISE EXCEPTION 'Precondition failed: % does not contain its validity test exactly % time(s). Nothing changed.', s ->> 'fn', s ->> 'n';
    END IF;
    v_pre := v_pre || jsonb_build_object(s ->> 'fn', v_def);
    v_meta := v_meta || jsonb_build_object(s ->> 'fn', (
      SELECT p.prorettype::regtype::text || '|' || pg_get_function_identity_arguments(p.oid) || '|' || l.lanname || '|' || p.provolatile::text || '|'
             || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|'
             || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), '') || '|' || p.proowner::regrole::text
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = (s ->> 'fn')::regprocedure));
  END LOOP;
  SELECT count(*) INTO v_drift FROM jsonb_array_elements(v_t) e LEFT JOIN public.certs c ON c.id = (e ->> 'id')::uuid
   WHERE c.id IS NULL OR c.department_id IS DISTINCT FROM (e ->> 'dept')::uuid OR c.exp IS DISTINCT FROM e ->> 'was';
  IF v_drift > 0 THEN
    RAISE EXCEPTION 'Precondition failed: % of the 7 malformed cert rows is missing, moved department, or no longer holds its reviewed value — re-audit. Nothing changed.', v_drift;
  END IF;

  -- snapshots: everything that must NOT move
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT (e ->> 'fn')::regprocedure::oid FROM jsonb_array_elements(v_spec) e);
  SELECT count(*) INTO v_nfn_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p');
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT string_agg(c.relname || '.' || t.tgname || '|' || t.tgfoid::regprocedure::text || '|' || t.tgenabled::text, E'\n' ORDER BY c.relname, t.tgname)
    INTO v_trg_before FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace;
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;
  SELECT md5(coalesce(string_agg(c::text, E'\n' ORDER BY c.id), '')) INTO v_others_before FROM public.certs c WHERE c.id <> ALL (v_ids);
  SELECT md5(string_agg((to_jsonb(c) - 'exp')::text, E'\n' ORDER BY c.id)) INTO v_cols_before FROM public.certs c WHERE c.id = ANY (v_ids);
  SELECT count(*) INTO v_count_before FROM public.certs;
  SELECT count(*) INTO v_bad_before FROM public.certs c
   WHERE c.exp IS NOT NULL AND btrim(c.exp) <> '' AND NOT coalesce(c.exp ~ '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$', false);
  SELECT md5(coalesce(string_agg(s2::text, E'\n' ORDER BY s2.id), '')) INTO v_subs_before FROM public.cert_submissions s2;
  -- the grants every one of these cert functions carries today (dept_cert_readiness: postgres, authenticated, service_role)
  SELECT string_agg(a::text, ',' ORDER BY a::text) INTO v_acl_ref FROM pg_proc p, unnest(p.proacl) a WHERE p.oid = 'public.dept_cert_readiness()'::regprocedure;

  -- ---------------------------------------------------------------- the fix
  CREATE FUNCTION public.valid_exp_ym(p_exp text)
   RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $fn$
  -- B4C:cert expiry — the ONE rule for "is this a real expiration month", the SQL twin of shared/expiry.js validExpYM():
  -- 'YYYY-MM', month 01-12, year >= 1900. NULL / blank / '0000-00' / '2026-13' / a full date / anything else -> false, never
  -- NULL. [0-9], not \d (ASCII digits, like JS). No cast, so it cannot raise. Kept inlinable (no SET, not definer): the cert
  -- readers test it in a WHERE ahead of split_part(exp)::int arithmetic, and inlined it is ordered like the regex it replaced.
    select coalesce(p_exp OPERATOR(pg_catalog.~) '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$', false)
  $fn$;
  REVOKE ALL ON FUNCTION public.valid_exp_ym(text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.valid_exp_ym(text) TO authenticated, service_role;

  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    EXECUTE replace(v_pre ->> (s ->> 'fn'), s ->> 'old', s ->> 'new');   -- CREATE OR REPLACE from the live body: grants, definer, search_path kept
  END LOOP;

  -- the data: each UPDATE scoped by department + id + the exact old shape, its row count asserted
  UPDATE public.certs c SET exp = left(c.exp, 7)
   WHERE c.department_id = DEMO
     AND c.id IN (SELECT (e ->> 'id')::uuid FROM jsonb_array_elements(v_t) e WHERE (e ->> 'dept')::uuid = DEMO)
     AND c.exp ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 6 THEN RAISE EXCEPTION 'Cleanup failed: the Demo full-date UPDATE touched % rows, not 6.', v_n; END IF;
  UPDATE public.certs c SET exp = NULL
   WHERE c.department_id = NH AND c.id = '8599898a-0a71-4664-82ae-6e97ede8e7fe'::uuid AND c.exp = '0000-00';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'Cleanup failed: the North Hood UPDATE touched % rows, not 1.', v_n; END IF;

  -- ---------------------------------------------------------------- post-conditions
  -- (1) the helper: shape, grants, the rule, inlining, its reviewed md5
  IF (SELECT p.prorettype = 'boolean'::regtype AND l.lanname = 'sql' AND p.provolatile = 'i' AND NOT p.prosecdef AND p.proconfig IS NULL
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.valid_exp_ym(text)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'Post-condition failed: valid_exp_ym() is not boolean / sql / IMMUTABLE / invoker / without a SET clause.';
  END IF;
  IF (SELECT string_agg(a::text, ',' ORDER BY a::text) FROM pg_proc p, unnest(p.proacl) a WHERE p.oid = 'public.valid_exp_ym(text)'::regprocedure) IS DISTINCT FROM v_acl_ref
     OR has_function_privilege('anon', 'public.valid_exp_ym(text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.valid_exp_ym(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: valid_exp_ym() grants are not exactly the cert functions'' grants (authenticated + service_role, no anon / PUBLIC).';
  END IF;
  IF (SELECT bool_and(public.valid_exp_ym(t.v) IS NOT DISTINCT FROM t.e) FROM (VALUES
        ('2027-06', true), ('1900-01', true), ('2026-12', true), ('9999-12', true), ('2000-10', true),
        (NULL, false), ('', false), ('0000-00', false), ('0000-01', false), ('2026-00', false), ('2026-13', false), ('1899-12', false),
        ('2026-09-15', false), ('2026-1', false), ('26-06', false), ('TBD', false), (' 2027-06', false), ('2027-06 ', false),
        (E'２０２７-06', false)) t(v, e)) IS NOT TRUE THEN
    RAISE EXCEPTION 'Post-condition failed: valid_exp_ym() does not match validExpYM (YYYY-MM, month 01-12, year >= 1900, NULL -> false).';
  END IF;
  FOR v_line IN EXECUTE 'EXPLAIN (VERBOSE, COSTS OFF) SELECT count(*) FROM public.certs c WHERE public.valid_exp_ym(c.exp)' LOOP
    v_plan := v_plan || v_line || E'\n';
  END LOOP;
  IF position('valid_exp_ym' in v_plan) > 0 OR position('~' in v_plan) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: valid_exp_ym() is not inlined by the planner (plan: %).', v_plan;
  END IF;
  -- [md5-pin] (the dry-run harness strips this block once, to read the reviewed md5s it then writes in)
  IF md5(pg_get_functiondef('public.valid_exp_ym(text)'::regprocedure)) <> HELPER_MD5 THEN
    RAISE EXCEPTION 'Post-condition failed: valid_exp_ym() does not match its reviewed md5.';
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    IF md5(pg_get_functiondef((s ->> 'fn')::regprocedure)) <> s ->> 'post' THEN
      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', s ->> 'fn';
    END IF;
  END LOOP;
  -- [/md5-pin]
  -- (2) the seven: EXACTLY the live pre-image with the swap; the old test gone; identity / grants / definer / search_path kept
  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    v_def := pg_get_functiondef((s ->> 'fn')::regprocedure);
    IF v_def IS DISTINCT FROM replace(v_pre ->> (s ->> 'fn'), s ->> 'old', s ->> 'new') OR position(s ->> 'old' in v_def) > 0 THEN
      RAISE EXCEPTION 'Post-condition failed: % is not exactly its live body with the validity test swapped.', s ->> 'fn';
    END IF;
    IF (SELECT p.prorettype::regtype::text || '|' || pg_get_function_identity_arguments(p.oid) || '|' || l.lanname || '|' || p.provolatile::text || '|'
               || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|'
               || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), '') || '|' || p.proowner::regrole::text
          FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = (s ->> 'fn')::regprocedure) IS DISTINCT FROM v_meta ->> (s ->> 'fn') THEN
      RAISE EXCEPTION 'Post-condition failed: %''s return type / arguments / language / volatility / definer / search_path / grants / owner changed.', s ->> 'fn';
    END IF;
  END LOOP;
  -- (3) nothing else moved
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT (e ->> 'fn')::regprocedure::oid FROM jsonb_array_elements(v_spec) e) AND p.oid <> 'public.valid_exp_ym(text)'::regprocedure;
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: another function (or its grants) changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')) <> v_nfn_before + 1 THEN
    RAISE EXCEPTION 'Post-condition failed: the function count is not exactly +1 (valid_exp_ym).';
  END IF;
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
  -- (4) the data: the 7 at their targets, nothing else moved
  IF (SELECT count(*) FROM jsonb_array_elements(v_t) e JOIN public.certs c ON c.id = (e ->> 'id')::uuid
       WHERE c.department_id = (e ->> 'dept')::uuid AND c.exp IS NOT DISTINCT FROM e ->> 'to'
         AND (c.exp IS NULL OR public.valid_exp_ym(c.exp))) <> 7 THEN
    RAISE EXCEPTION 'Post-condition failed: the 7 malformed certs do not all hold their reviewed target values.';
  END IF;
  IF (SELECT md5(coalesce(string_agg(c::text, E'\n' ORDER BY c.id), '')) FROM public.certs c WHERE c.id <> ALL (v_ids)) IS DISTINCT FROM v_others_before THEN
    RAISE EXCEPTION 'Post-condition failed: a cert row outside the 7 changed.';
  END IF;
  IF (SELECT md5(string_agg((to_jsonb(c) - 'exp')::text, E'\n' ORDER BY c.id)) FROM public.certs c WHERE c.id = ANY (v_ids)) IS DISTINCT FROM v_cols_before THEN
    RAISE EXCEPTION 'Post-condition failed: a column other than exp changed on the 7 rows.';
  END IF;
  IF (SELECT count(*) FROM public.certs) <> v_count_before THEN RAISE EXCEPTION 'Post-condition failed: the certs count changed.'; END IF;
  IF (SELECT count(*) FROM public.certs c WHERE c.exp IS NOT NULL AND btrim(c.exp) <> '' AND NOT public.valid_exp_ym(c.exp)) <> v_bad_before - 7 THEN
    RAISE EXCEPTION 'Post-condition failed: malformed certs did not drop by exactly 7.';
  END IF;
  IF (SELECT md5(coalesce(string_agg(s2::text, E'\n' ORDER BY s2.id), '')) FROM public.cert_submissions s2) IS DISTINCT FROM v_subs_before THEN
    RAISE EXCEPTION 'Post-condition failed: a cert_submissions row changed.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: helper_ok true · helper_inlinable true · grants_ok true · sites_repointed 10 · old_tests_left 0 ·
--   update_refuses true · approve_clears true · helper_md5 51b8cde1 · demo_values 2026-09,2026-12,2027-03,2027-05,2027-06,2028-01 ·
--   north_hood_exp NULL · malformed_certs 0 · certs_total 179 (unchanged) · total_policies 173 · locked_token_fns 17)
SELECT
  public.valid_exp_ym('2027-06') AND NOT public.valid_exp_ym('0000-00') AND NOT public.valid_exp_ym('0000-01')
    AND NOT public.valid_exp_ym('2026-13') AND NOT public.valid_exp_ym('2026-09-15') AND public.valid_exp_ym(NULL) = false AS helper_ok,
  (SELECT p.provolatile = 'i' AND NOT p.prosecdef AND p.proconfig IS NULL FROM pg_proc p WHERE p.oid = 'public.valid_exp_ym(text)'::regprocedure) AS helper_inlinable,
  has_function_privilege('authenticated', 'public.valid_exp_ym(text)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.valid_exp_ym(text)'::regprocedure, 'EXECUTE') AS grants_ok,
  (SELECT sum((length(d) - length(replace(d, 'public.valid_exp_ym(c.exp)', ''))) / length('public.valid_exp_ym(c.exp)'))::int
     FROM (SELECT pg_get_functiondef(f::regprocedure) d FROM unnest(array['public.dept_cert_readiness()', 'public.pa_department_radar()',
           'public.my_department_rollup()', 'public.expiration_rows(uuid,uuid)', 'public.probation_item_states(uuid,uuid)']) f) x) AS sites_repointed,
  (SELECT count(*)::int FROM unnest(array['public.dept_cert_readiness()', 'public.pa_department_radar()', 'public.my_department_rollup()',
           'public.expiration_rows(uuid,uuid)', 'public.probation_item_states(uuid,uuid)', 'public.update_cert(uuid,text,text)']) f
     WHERE position($t$'^\d{4}-\d{2}$'$t$ in pg_get_functiondef(f::regprocedure)) > 0
        OR position($t$'^\d{4}-(0[1-9]|1[0-2])$'$t$ in pg_get_functiondef(f::regprocedure)) > 0) AS old_tests_left,
  position('not public.valid_exp_ym(new_exp)' in pg_get_functiondef('public.update_cert(uuid,text,text)'::regprocedure)) > 0 AS update_refuses,
  position('case when public.valid_exp_ym(sub.exp) then sub.exp end' in pg_get_functiondef('public.approve_cert_submission(uuid)'::regprocedure)) > 0 AS approve_clears,
  left(md5(pg_get_functiondef('public.valid_exp_ym(text)'::regprocedure)), 8) AS helper_md5,
  (SELECT string_agg(exp, ',' ORDER BY exp) FROM public.certs WHERE department_id = '94667450-481c-4f40-a6b6-86e1b364be93'
      AND id IN ('d19a5449-c5e4-47f5-9a91-74bb71894b4d', '75badecf-7628-4232-9ac8-7415d9915656', '3a9c1f96-243e-4b42-b398-e46b9235e3dc',
                 '4aace421-14ba-4d14-b138-5e83d8e4b5ec', 'b82eb65a-78b0-4bbd-853f-a148e75835d4', '00b3562b-1352-421c-a122-18ad2089a9a9')) AS demo_values,
  (SELECT coalesce(exp, 'NULL') FROM public.certs WHERE id = '8599898a-0a71-4664-82ae-6e97ede8e7fe') AS north_hood_exp,
  (SELECT count(*) FROM public.certs c WHERE c.exp IS NOT NULL AND btrim(c.exp) <> '' AND NOT public.valid_exp_ym(c.exp)) AS malformed_certs,
  (SELECT count(*) FROM public.certs) AS certs_total,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
