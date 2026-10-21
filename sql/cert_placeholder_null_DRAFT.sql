-- =====================================================================
-- CERT DISPLAY FIX G1 — null Indian Harbor's '0000-00' placeholder dates — DRAFT, NOT REVIEWED, NOT APPLIED.
-- Order: claude/B4C_CertDisplayFixes_BuildOrder.md. Off Step 0b (2026-10-21, docs/review/cert_catalog_STEP0B_OUTPUT.md).
--
-- THE BUG: 21 Indian Harbor certs carry exp = '0000-00' (an import placeholder for "no date"). It passes the lax
-- '^\d{4}-\d{2}$' and month 0 is in the past, so certStatus() (roster badge), dept_cert_readiness() (dashboard %) and
-- pa_department_radar() read them EXPIRED (red), while expiration_rows() / the scorecard read them "no date".
--
-- THE FIX — data only: `update public.certs set exp = null where exp = '0000-00'`. A null exp reads "no date" in every
-- reader, so the false red goes with no reader change. Demo's 6 malformed rows (full YYYY-MM-DD dates) are NOT touched.
-- Guards: exactly 21 rows match, all in one department whose name is Indian Harbor, and the UPDATE touches exactly
-- those 21; afterwards 0 rows carry '0000-00', the certs row count is unchanged, nothing but exp moved on those rows,
-- and Demo's 6 malformed rows are still there. Refuses a second apply (0 rows match).
--
-- REVERSIBLE: the 21 cert ids are kept in a temp table and returned by the final SELECT — save that output. To undo:
--   update public.certs set exp = '0000-00' where id in (<those ids>);
-- No function, policy, grant or schema change. The locked verification column is never touched.
-- =====================================================================
CREATE TEMP TABLE g1_nulled (id uuid PRIMARY KEY, department text) ON COMMIT PRESERVE ROWS;

DO $migrate$
DECLARE
  v_n int; v_depts int; v_dept_name text; v_total_before bigint; v_other_malformed_before bigint; v_snap_before text; v_snap_after text;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  SELECT count(*), count(DISTINCT c.department_id), min(d.name) INTO v_n, v_depts, v_dept_name
    FROM public.certs c JOIN public.departments d ON d.id = c.department_id WHERE c.exp = '0000-00';
  IF v_n = 0 THEN
    RAISE EXCEPTION 'Precondition failed: no cert carries ''0000-00'' — already applied. Nothing changed.';
  END IF;
  IF v_n <> 21 THEN
    RAISE EXCEPTION 'Precondition failed: % certs carry ''0000-00'' (Step 0b counted 21). Nothing changed.', v_n;
  END IF;
  IF v_depts <> 1 OR v_dept_name NOT ILIKE 'Indian Harbor%' THEN
    RAISE EXCEPTION 'Precondition failed: the ''0000-00'' certs are not all Indian Harbor (% department(s), first %). Nothing changed.', v_depts, v_dept_name;
  END IF;
  SELECT count(*) INTO v_total_before FROM public.certs;
  SELECT count(*) INTO v_other_malformed_before FROM public.certs
   WHERE nullif(btrim(coalesce(exp, '')), '') IS NOT NULL AND exp !~ '^\d{4}-(0[1-9]|1[0-2])$' AND exp <> '0000-00';
  IF v_other_malformed_before <> 6 THEN
    RAISE EXCEPTION 'Precondition failed: expected Demo''s 6 other malformed certs, found %. Nothing changed.', v_other_malformed_before;
  END IF;
  INSERT INTO g1_nulled (id, department) SELECT c.id, d.name FROM public.certs c JOIN public.departments d ON d.id = c.department_id WHERE c.exp = '0000-00';
  -- every column except exp, for the 21 rows (proves nothing else moved)
  SELECT string_agg(c.id::text || '|' || c.department_id || '|' || c.member_id || '|' || c.name || '|' || coalesce(c.proof_path, '') || '|' || c.created_at, E'\n' ORDER BY c.id)
    INTO v_snap_before FROM public.certs c WHERE c.id IN (SELECT id FROM g1_nulled);

  -- ---------------------------------------------------------------- the change
  UPDATE public.certs SET exp = NULL WHERE exp = '0000-00';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- ---------------------------------------------------------------- post-conditions
  IF v_n <> 21 THEN RAISE EXCEPTION 'Post-condition failed: the update touched % rows, not 21.', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.certs WHERE exp = '0000-00') THEN RAISE EXCEPTION 'Post-condition failed: a ''0000-00'' remains.'; END IF;
  IF (SELECT count(*) FROM public.certs WHERE id IN (SELECT id FROM g1_nulled) AND exp IS NULL) <> 21 THEN
    RAISE EXCEPTION 'Post-condition failed: the 21 recorded certs are not all null-dated.';
  END IF;
  IF (SELECT count(*) FROM public.certs) <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: the certs row count changed.'; END IF;
  IF (SELECT count(*) FROM public.certs WHERE nullif(btrim(coalesce(exp, '')), '') IS NOT NULL AND exp !~ '^\d{4}-(0[1-9]|1[0-2])$') <> v_other_malformed_before THEN
    RAISE EXCEPTION 'Post-condition failed: the other malformed certs (Demo''s 6) changed.';
  END IF;
  SELECT string_agg(c.id::text || '|' || c.department_id || '|' || c.member_id || '|' || c.name || '|' || coalesce(c.proof_path, '') || '|' || c.created_at, E'\n' ORDER BY c.id)
    INTO v_snap_after FROM public.certs c WHERE c.id IN (SELECT id FROM g1_nulled);
  IF v_snap_after IS DISTINCT FROM v_snap_before THEN RAISE EXCEPTION 'Post-condition failed: a column other than exp changed on the 21 rows.'; END IF;
END
$migrate$;

-- state check + the undo record (expect: placeholders_left 0 · nulled 21 · department Indian Harbor… · other_malformed 6;
-- the ids column is the reversal list — save it)
SELECT
  (SELECT count(*) FROM public.certs WHERE exp = '0000-00') AS placeholders_left,
  (SELECT count(*) FROM g1_nulled) AS nulled,
  (SELECT string_agg(DISTINCT department, ', ') FROM g1_nulled) AS department,
  (SELECT count(*) FROM public.certs WHERE nullif(btrim(coalesce(exp, '')), '') IS NOT NULL AND exp !~ '^\d{4}-(0[1-9]|1[0-2])$') AS other_malformed,
  (SELECT string_agg(id::text, ',' ORDER BY id) FROM g1_nulled) AS ids;
