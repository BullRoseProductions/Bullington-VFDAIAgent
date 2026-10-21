-- =====================================================================
-- CERT CATALOG (option 4) — Step 0 (claude/B4C_CertCatalog_Concept_Step0.md). READ-ONLY, one result set.
--   1 certs: columns, constraints, RLS, policies, client grants (table + column), triggers  · the same for
--     cert_submissions — the app never inserts a cert directly; every cert starts as a submission
--   2 the cert write / read path: every public function that touches certs (writes flag + md5), and the FULL
--     definition of update_cert, delete_cert, approve_cert_submission, reject_cert_submission, dept_cert_readiness
--   3 expiration_rows — full definition
--   4 readiness machinery — readiness_requirements columns / constraints (the kind CHECK) / policies, and the full
--     definitions of set_readiness_requirement, member_scorecard, readiness_items, readiness_verdict
--   5 no catalog yet — any table or column whose name looks like a cert catalog / required-cert list
--   7 per department: cert rows, distinct names, blank exp, malformed exp, well-formed 'YYYY-MM'
--   + is_dept_admin() md5 (the catalog writes gate on it; expect c692e44f62923d2bf4c1a39a21a87bf7)
--
-- RAN ON LIVE 2026-10-21 — full output + findings: docs/review/cert_catalog_STEP0_OUTPUT.md
--   F1 update_cert / delete_cert gate on is_department_admin() (unscoped) with NO department check — latent cross-dept write
--   F2 three YYYY-MM rules (update_cert + dept_cert_readiness lax \d{2}; expiration_rows strict 01-12); approve copies exp unchecked
--   F3 dashboard <=3 months / all rows vs expiration_rows <=30 days / active roster only
--   F4 Indian Harbor 169 certs, 120 distinct names, 112 blank, 21 malformed, 36 YYYY-MM; Demo 6 all malformed; others 0
--   no catalog yet · no triggers · certs SELECT-only RLS · is_dept_admin() md5 unchanged
-- =====================================================================
SELECT 1 AS ord, 'col' AS what, table_name || '.' || column_name AS name,
       data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '') AS detail
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('certs', 'cert_submissions')
UNION ALL
SELECT 1, 'constraint', c.conrelid::regclass::text || ' · ' || c.conname, pg_get_constraintdef(c.oid)
  FROM pg_constraint c WHERE c.conrelid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass)
UNION ALL
SELECT 1, 'rls', c.relname, 'rls ' || c.relrowsecurity::text || ' · forced ' || c.relforcerowsecurity::text
  FROM pg_class c WHERE c.oid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass)
UNION ALL
SELECT 1, 'policy', tablename || ' · ' || policyname || ' [' || cmd || '] ' || roles::text,
       'USING ' || coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('certs', 'cert_submissions')
UNION ALL
SELECT 1, 'grant', t || ' -> ' || r, concat_ws(' ',
         CASE WHEN has_table_privilege(r, 'public.' || t, 'SELECT') THEN 'SELECT' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'INSERT') THEN 'INSERT' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'UPDATE') THEN 'UPDATE' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'DELETE') THEN 'DELETE' END)
       || ' · some column insertable ' || has_any_column_privilege(r, 'public.' || t, 'INSERT')::text
       || ' · some column updatable ' || has_any_column_privilege(r, 'public.' || t, 'UPDATE')::text
  FROM unnest(array['certs', 'cert_submissions']) t CROSS JOIN unnest(array['authenticated', 'anon']) r
UNION ALL
SELECT 1, 'trigger', c.relname || ' · ' || t.tgname, pg_get_triggerdef(t.oid) || ' · fn md5 ' || md5(pg_get_functiondef(t.tgfoid))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.oid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass)
UNION ALL
SELECT 2, 'fn touching certs', p.oid::regprocedure::text,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · md5 ' || md5(pg_get_functiondef(p.oid))
       || ' · writes certs: ' || (p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?certs\y')::text
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
       || ' · anon exec: ' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.prosrc ~* '(public\.)?certs\y'
UNION ALL
SELECT 2, 'full def', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('update_cert', 'delete_cert', 'approve_cert_submission', 'reject_cert_submission', 'dept_cert_readiness')
UNION ALL
SELECT 3, 'full def', p.oid::regprocedure::text, 'md5 ' || md5(pg_get_functiondef(p.oid)) || E'\n' || pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'expiration_rows'
UNION ALL
SELECT 4, 'col', 'readiness_requirements.' || column_name,
       data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '')
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'readiness_requirements'
UNION ALL
SELECT 4, 'constraint', 'readiness_requirements · ' || c.conname, pg_get_constraintdef(c.oid)
  FROM pg_constraint c WHERE c.conrelid = 'public.readiness_requirements'::regclass
UNION ALL
SELECT 4, 'policy', 'readiness_requirements · ' || policyname || ' [' || cmd || '] ' || roles::text,
       'USING ' || coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'readiness_requirements'
UNION ALL
SELECT 4, 'full def', p.oid::regprocedure::text, 'md5 ' || md5(pg_get_functiondef(p.oid)) || E'\n' || pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('set_readiness_requirement', 'member_scorecard', 'readiness_items', 'readiness_verdict')
UNION ALL
SELECT 5, 'catalog-like table', c.relname, c.relkind::text
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm')
   AND c.relname ~* '(cert_?type|required_?cert|cert_?catalog|cert_?requirement|certification_?type)'
UNION ALL
SELECT 5, 'catalog-like column', table_name || '.' || column_name, data_type
  FROM information_schema.columns WHERE table_schema = 'public'
   AND column_name ~* '(cert_?type|cert_?catalog|never_?expires|no_?expir)'
UNION ALL
SELECT 5, 'catalog check', 'tables + columns matching a cert catalog', 'see the rows above (none = no catalog yet)'
UNION ALL
SELECT 7, 'certs per department', d.name,
       count(c.id)::text || ' rows · ' || count(DISTINCT lower(btrim(c.name)))::text || ' distinct names · '
       || count(c.id) FILTER (WHERE nullif(btrim(coalesce(c.exp, '')), '') IS NULL)::text || ' blank exp · '
       || count(c.id) FILTER (WHERE nullif(btrim(coalesce(c.exp, '')), '') IS NOT NULL AND c.exp !~ '^\d{4}-(0[1-9]|1[0-2])$')::text || ' malformed exp · '
       || count(c.id) FILTER (WHERE c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$')::text || ' YYYY-MM'
  FROM public.departments d LEFT JOIN public.certs c ON c.department_id = d.id GROUP BY d.name
UNION ALL
SELECT 8, 'gate', 'is_dept_admin()', 'md5 ' || md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure))
       || CASE WHEN md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) = 'c692e44f62923d2bf4c1a39a21a87bf7' THEN ' (= Step A, dept-scoped)' ELSE ' (CHANGED since Step A!)' END
ORDER BY 1, 2, 3;
