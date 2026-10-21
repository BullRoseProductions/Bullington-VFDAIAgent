-- =====================================================================
-- EVENT DETAILS / combined Fundraising & Community Events — Step 0 (claude/B4C_EventDetails_Concept_Step0.md).
-- READ-ONLY, one result set.
--   1 funding_events + recruitment_events: columns, constraints, RLS, every policy, triggers, table grants
--   2 PER-COLUMN grants for authenticated + anon (insert / update / select on each column), and whether either table
--     has ANY column-level ACL (attacl) — i.e. whether a new column is client-writable by default
--   3 training_sessions: every column whose name or type looks like a time (the app's time convention)
--   4 every public function that reads or writes either table (definer?, writes?, md5) — an edit path or another reader
--   5 row counts per department (blast radius; how many existing events would show "all-day")
--
-- RAN ON LIVE 2026-10-21 — output + findings: docs/review/event_details_STEP0_OUTPUT.md
--   no column ACLs (new columns client-writable, RLS is the gate) · UPDATE policies exist (DA/Officer via is_canmanage_ops)
--   E1 UI delete gate (DA/PA) vs DB (DA/Officer): a PA's delete/edit would silently hit 0 rows · training has location_label
--   only my_department_rollup() reads them (date, title) · 7 events in all
-- =====================================================================
SELECT 1 AS ord, 'col' AS what, table_name || '.' || column_name AS name,
       data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '') AS detail
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('funding_events', 'recruitment_events')
UNION ALL
SELECT 1, 'constraint', c.conrelid::regclass::text || ' · ' || c.conname, pg_get_constraintdef(c.oid)
  FROM pg_constraint c WHERE c.conrelid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass)
UNION ALL
SELECT 1, 'index', i.tablename || ' · ' || i.indexname, i.indexdef
  FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename IN ('funding_events', 'recruitment_events')
UNION ALL
SELECT 1, 'rls', c.relname, 'rls ' || c.relrowsecurity::text || ' · forced ' || c.relforcerowsecurity::text
  FROM pg_class c WHERE c.oid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass)
UNION ALL
SELECT 1, 'policy', tablename || ' · ' || policyname || ' [' || cmd || '] ' || roles::text,
       'USING ' || coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('funding_events', 'recruitment_events')
UNION ALL
SELECT 1, 'trigger', c.relname || ' · ' || t.tgname, pg_get_triggerdef(t.oid) || ' · fn md5 ' || md5(pg_get_functiondef(t.tgfoid))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.oid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass)
UNION ALL
SELECT 1, 'table grant', t || ' -> ' || r, concat_ws(' ',
         CASE WHEN has_table_privilege(r, 'public.' || t, 'SELECT') THEN 'SELECT' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'INSERT') THEN 'INSERT' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'UPDATE') THEN 'UPDATE' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'DELETE') THEN 'DELETE' END)
       || ' · relacl ' || coalesce((SELECT relacl::text FROM pg_class WHERE oid = ('public.' || t)::regclass), 'default')
  FROM unnest(array['funding_events', 'recruitment_events']) t CROSS JOIN unnest(array['authenticated', 'anon']) r
UNION ALL
SELECT 2, 'column grant', a.attrelid::regclass::text || '.' || a.attname || ' -> ' || r,
       'select ' || has_column_privilege(r, a.attrelid, a.attnum, 'SELECT')::text
       || ' · insert ' || has_column_privilege(r, a.attrelid, a.attnum, 'INSERT')::text
       || ' · update ' || has_column_privilege(r, a.attrelid, a.attnum, 'UPDATE')::text
       || ' · column acl ' || coalesce(a.attacl::text, 'none')
  FROM pg_attribute a CROSS JOIN unnest(array['authenticated', 'anon']) r
 WHERE a.attrelid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass) AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 2, 'column-acl summary', c.relname,
       count(*) FILTER (WHERE a.attacl IS NOT NULL)::text || ' of ' || count(*)::text || ' columns carry a column-level ACL'
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.oid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass) GROUP BY c.relname
UNION ALL
SELECT 3, 'training time col', 'training_sessions.' || column_name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '')
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions'
   AND (column_name ~* '(time|start|end|_at$|date|duration|location|notes|description)' OR data_type ~* 'time')
UNION ALL
SELECT 4, 'fn touching events', p.oid::regprocedure::text,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · md5 ' || md5(pg_get_functiondef(p.oid))
       || ' · writes: ' || (p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(funding|recruitment)_events\y')::text
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.prosrc ~* '(funding|recruitment)_events\y'
UNION ALL
SELECT 5, 'rows per department', d.name,
       (SELECT count(*) FROM public.funding_events f WHERE f.department_id = d.id)::text || ' funding · '
       || (SELECT count(*) FROM public.recruitment_events r WHERE r.department_id = d.id)::text || ' recruitment'
  FROM public.departments d
ORDER BY 1, 2, 3;
