-- =====================================================================
-- APPLIED on live 2026-10-24 after the migration (this file byte-for-byte, sha256 b9733640…); state row: demo_fixed 6 ·
-- demo_values 2026-09,2026-12,2027-03,2027-05,2027-06,2028-01 · north_hood_exp NULL · malformed_certs 0 · certs_total 179 ·
-- total_policies 173 · locked_token_fns 17.
-- CERT EXPIRY — THE 7 MALFORMED ROWS (data cleanup, Review PASS fc78b4d). Apply AFTER
-- sql/cert_expiry_valid_ym_DRAFT.sql (it refuses to run before it). Ashlea's call: fix the data, not just the reading of it.
-- The rows — read from live, docs/review/cert_expiry_malformed_STEP0B_OUTPUT.json (cleanup_targets):
--   B4C Demo Department (94667450-…)  6 rows stored as full dates -> their month ('2026-09-15' -> '2026-09'):
--       d19a5449 2026-09-15 · 75badecf 2026-12-31 · 3a9c1f96 2027-03-01 · 4aace421 2027-05-01 · b82eb65a 2027-06-01 · 00b3562b 2028-01-01
--   North Hood County VFD (6d51b00a-…) 1 row '0000-00' (the reported Boaters Ed Cert) -> NULL ("No expiration date"; the
--       department can then enter the real month).
-- Effect the reviewer should expect: the 6 Demo certs stop reading "No expiration date" and read as their months — as of today
-- (2026-10) 2026-09 reads EXPIRED, 2026-12 EXPIRING, the rest CURRENT; Demo's readiness numbers move accordingly. North Hood's
-- reads "No expiration date" — which is what it already reads once the code migration is in.
-- NOT touched: any other cert row, any other column of these 7, cert_submissions (the 24 malformed submissions are all already
-- approved — history; 0 pending), every function / policy / trigger.
--
-- Single all-or-nothing DO block. Preconditions: valid_exp_ym() present at its reviewed md5 (the code migration is in); each of
-- the 7 exists with exactly its pinned department and current value; refuses if they already read their target values
-- ("already applied"). Each UPDATE is scoped by department + id + the exact old value, and its row count asserted (6, 1).
-- Post-conditions: the 7 hold their target values (the Demo 6 now valid_exp_ym); every other cert row byte-identical; the 7's
-- other columns unchanged; certs count unchanged; malformed certs down by exactly 7; total_policies / locked-token unchanged.
-- =====================================================================
DO $cleanup$
DECLARE
  DEMO constant uuid := '94667450-481c-4f40-a6b6-86e1b364be93';
  NH   constant uuid := '6d51b00a-bdb0-4807-8e45-70bb53d4dcff';
  HELPER_MD5 constant text := '51b8cde1acf4a8e5db26a81dc65bee68';
  v_t jsonb; v_ids uuid[]; v_n int; v_done int; v_drift int;
  v_others_before text; v_cols_before text; v_count_before int; v_bad_before int; v_total_before int; v_tok_before int;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('id', id, 'dept', dept, 'was', was, 'to', tgt)), array_agg(id) INTO v_t, v_ids FROM (VALUES
    ('d19a5449-c5e4-47f5-9a91-74bb71894b4d'::uuid, DEMO, '2026-09-15', '2026-09'),
    ('75badecf-7628-4232-9ac8-7415d9915656'::uuid, DEMO, '2026-12-31', '2026-12'),
    ('3a9c1f96-243e-4b42-b398-e46b9235e3dc'::uuid, DEMO, '2027-03-01', '2027-03'),
    ('4aace421-14ba-4d14-b138-5e83d8e4b5ec'::uuid, DEMO, '2027-05-01', '2027-05'),
    ('b82eb65a-78b0-4bbd-853f-a148e75835d4'::uuid, DEMO, '2027-06-01', '2027-06'),
    ('00b3562b-1352-421c-a122-18ad2089a9a9'::uuid, DEMO, '2028-01-01', '2028-01'),
    ('8599898a-0a71-4664-82ae-6e97ede8e7fe'::uuid, NH,   '0000-00',    NULL)
  ) v(id, dept, was, tgt);

  -- ---------------------------------------------------------------- preconditions
  IF to_regprocedure('public.valid_exp_ym(text)') IS NULL
     OR md5(pg_get_functiondef('public.valid_exp_ym(text)'::regprocedure)) <> HELPER_MD5 THEN
    RAISE EXCEPTION 'Precondition failed: public.valid_exp_ym(text) is not in at its reviewed md5 — apply sql/cert_expiry_valid_ym_DRAFT.sql first. Nothing changed.';
  END IF;
  SELECT count(*) FILTER (WHERE c.department_id = (e ->> 'dept')::uuid AND c.exp IS NOT DISTINCT FROM e ->> 'to'),
         count(*) FILTER (WHERE c.id IS NULL OR c.department_id IS DISTINCT FROM (e ->> 'dept')::uuid OR c.exp IS DISTINCT FROM e ->> 'was')
    INTO v_done, v_drift
    FROM jsonb_array_elements(v_t) e LEFT JOIN public.certs c ON c.id = (e ->> 'id')::uuid;
  IF v_done = 7 THEN RAISE EXCEPTION 'Precondition failed: all 7 rows already hold their target values — already applied. Nothing changed.'; END IF;
  IF v_drift > 0 THEN
    RAISE EXCEPTION 'Precondition failed: % of the 7 rows is missing, moved department, or no longer holds its reviewed value — re-audit. Nothing changed.', v_drift;
  END IF;

  -- snapshots
  SELECT md5(coalesce(string_agg(c::text, E'\n' ORDER BY c.id), '')) INTO v_others_before FROM public.certs c WHERE c.id <> ALL (v_ids);
  SELECT md5(string_agg((to_jsonb(c) - 'exp')::text, E'\n' ORDER BY c.id)) INTO v_cols_before FROM public.certs c WHERE c.id = ANY (v_ids);
  SELECT count(*) INTO v_count_before FROM public.certs;
  SELECT count(*) INTO v_bad_before FROM public.certs c WHERE c.exp IS NOT NULL AND btrim(c.exp) <> '' AND NOT public.valid_exp_ym(c.exp);
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;

  -- ---------------------------------------------------------------- the cleanup
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
  IF (SELECT count(*) FROM jsonb_array_elements(v_t) e JOIN public.certs c ON c.id = (e ->> 'id')::uuid
       WHERE c.department_id = (e ->> 'dept')::uuid AND c.exp IS NOT DISTINCT FROM e ->> 'to'
         AND (c.exp IS NULL OR public.valid_exp_ym(c.exp))) <> 7 THEN
    RAISE EXCEPTION 'Post-condition failed: the 7 rows do not all hold their reviewed target values.';
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
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: total_policies or the locked-token count changed.';
  END IF;
END
$cleanup$;

-- state check (expect: demo_fixed 6 · demo_values 2026-09,2026-12,2027-03,2027-05,2027-06,2028-01 · north_hood_exp NULL ·
--   malformed_certs 0 · certs_total 179 (unchanged) · total_policies 173 · locked_token_fns 17)
SELECT
  (SELECT count(*) FROM public.certs WHERE department_id = '94667450-481c-4f40-a6b6-86e1b364be93' AND id IN ('d19a5449-c5e4-47f5-9a91-74bb71894b4d',
     '75badecf-7628-4232-9ac8-7415d9915656', '3a9c1f96-243e-4b42-b398-e46b9235e3dc', '4aace421-14ba-4d14-b138-5e83d8e4b5ec',
     'b82eb65a-78b0-4bbd-853f-a148e75835d4', '00b3562b-1352-421c-a122-18ad2089a9a9') AND public.valid_exp_ym(exp)) AS demo_fixed,
  (SELECT string_agg(exp, ',' ORDER BY exp) FROM public.certs WHERE id IN ('d19a5449-c5e4-47f5-9a91-74bb71894b4d',
     '75badecf-7628-4232-9ac8-7415d9915656', '3a9c1f96-243e-4b42-b398-e46b9235e3dc', '4aace421-14ba-4d14-b138-5e83d8e4b5ec',
     'b82eb65a-78b0-4bbd-853f-a148e75835d4', '00b3562b-1352-421c-a122-18ad2089a9a9')) AS demo_values,
  (SELECT coalesce(exp, 'NULL') FROM public.certs WHERE id = '8599898a-0a71-4664-82ae-6e97ede8e7fe') AS north_hood_exp,
  (SELECT count(*) FROM public.certs c WHERE c.exp IS NOT NULL AND btrim(c.exp) <> '' AND NOT public.valid_exp_ym(c.exp)) AS malformed_certs,
  (SELECT count(*) FROM public.certs) AS certs_total,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
