-- =====================================================================
-- CERT CATALOG — Step 0b (claude/B4C_CertCatalog_Step0_Review.md, bottom list). READ-ONLY, one result set.
--   1 full pg_get_functiondef (with md5) of readiness_window, my_expirations, my_department_rollup, pa_department_radar,
--     probation_item_states, is_muted, qualification_cells — every overload, so a missing one shows as a 'missing' row
--   7 the readiness_requirements_uq index: indexdef + valid / ready flags (or a 'missing' row)
--   8 the malformed certs.exp values — DISTINCT raw strings with a count, by department; no names, no member ids.
--     "Malformed" = non-blank and not '^\d{4}-(0[1-9]|1[0-2])$' (the Step 0 rule: expect 21 Indian Harbor + 6 Demo rows)
--
-- RAN ON LIVE 2026-10-21 — full output + findings: docs/review/cert_catalog_STEP0B_OUTPUT.md (all 7 md5s reproduced byte-exact)
--   G1 Indian Harbor's 21 malformed = '0000-00', which the lax regex reads as EXPIRED (certStatus, dept_cert_readiness, radar)
--   G2 my_department_rollup()'s cert regex has a doubled backslash -> its 5 cert counts are always 0
--   G3 readiness_window has no never-expires path · G4 probation cert items match by name, blank exp = missing
--   readiness_requirements_uq live, NULLS NOT DISTINCT · Demo's 6 malformed are YYYY-MM-DD
-- =====================================================================
SELECT 1 AS ord, 'full def' AS what, p.oid::regprocedure::text AS name,
       'md5 ' || md5(pg_get_functiondef(p.oid)) || E'\n' || pg_get_functiondef(p.oid) AS detail
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('readiness_window', 'my_expirations', 'my_department_rollup', 'pa_department_radar',
                     'probation_item_states', 'is_muted', 'qualification_cells')
UNION ALL
SELECT 1, 'missing', f, 'no public function by this name'
  FROM unnest(array['readiness_window', 'my_expirations', 'my_department_rollup', 'pa_department_radar',
                    'probation_item_states', 'is_muted', 'qualification_cells']) f
 WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f)
UNION ALL
SELECT 7, 'index', i.indexname, i.indexdef || ' · valid ' || x.indisvalid::text || ' · ready ' || x.indisready::text || ' · unique ' || x.indisunique::text
  FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname AND c.relnamespace = 'public'::regnamespace JOIN pg_index x ON x.indexrelid = c.oid
 WHERE i.schemaname = 'public' AND i.tablename = 'readiness_requirements'
UNION ALL
SELECT 7, 'missing', 'readiness_requirements_uq', 'no index by this name'
 WHERE NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'readiness_requirements_uq')
UNION ALL
SELECT 8, 'malformed exp', d.name, '[' || c.exp || '] × ' || count(*)::text
  FROM public.certs c JOIN public.departments d ON d.id = c.department_id
 WHERE nullif(btrim(coalesce(c.exp, '')), '') IS NOT NULL AND c.exp !~ '^\d{4}-(0[1-9]|1[0-2])$'
 GROUP BY d.name, c.exp
UNION ALL
SELECT 8, 'malformed total', d.name, count(c.id)::text || ' rows · ' || count(DISTINCT c.exp)::text || ' distinct values'
  FROM public.certs c JOIN public.departments d ON d.id = c.department_id
 WHERE nullif(btrim(coalesce(c.exp, '')), '') IS NOT NULL AND c.exp !~ '^\d{4}-(0[1-9]|1[0-2])$'
 GROUP BY d.name
ORDER BY 1, 2, 3, 4;
