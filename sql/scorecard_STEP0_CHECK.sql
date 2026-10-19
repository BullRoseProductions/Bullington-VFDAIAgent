-- =====================================================================
-- PHASE 3.1 #5 (Readiness scorecard + ISO packet) — Step 0. READ-ONLY, one result set.
--   1 the reads the scorecard must REUSE (signatures, return shape, security, gate) — quals, #4 expirations,
--     Read & Sign, probation, activity
--   2 id columns a requirement would reference (qualification_types.id, document_series.series_id, documents.series_id)
--   3 THE STOP-RULE EVIDENCE: certs are untyped free text — each department's distinct cert names, grouped after
--     normalizing case / spaces / punctuation, with how many members hold each spelling (variants = the risk)
--   4 the helpers (is_dept_admin, is_canmanage, my_member_id, my_department_id) — body + department-scoped?
--   5 the honest denominator (members.status values, member_separation, Project Admins)
--   6 activity sources (station hours / training attendance / supervised drives) — what exists to count
--   7 the new name is free · total policies
-- =====================================================================
SELECT 1 AS ord, 'read' AS what, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
       'returns ' || pg_get_function_result(p.oid) || ' · ' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
       || ' · gate: ' || concat_ws('+',
            CASE WHEN position('is_canmanage_ops()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_canmanage_ops' END,
            CASE WHEN position('is_canmanage()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_canmanage' END,
            CASE WHEN position('is_dept_admin()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_dept_admin' END,
            CASE WHEN position('my_member_id()' in pg_get_functiondef(p.oid)) > 0 THEN 'my_member_id' END)
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text AS detail
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND p.proname IN ('my_qualifications', 'dept_qualification_matrix', 'qualification_cells',
                     'dept_expirations', 'my_expirations', 'expiration_rows',
                     'my_read_sign_queue', 'dept_read_sign_compliance', 'rs_member_in_audience',
                     'my_probation_status', 'probation_status', 'dept_probation_board')
UNION ALL
SELECT 2, 'id col', table_name || '.' || column_name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
  FROM information_schema.columns WHERE table_schema = 'public'
   AND ((table_name = 'qualification_types' AND column_name IN ('id', 'department_id', 'name', 'kind', 'active'))
     OR (table_name = 'document_series' AND column_name IN ('series_id', 'department_id', 'requires_ack', 'current_version', 'required_roles', 'annual_resign', 'title'))
     OR (table_name = 'documents' AND column_name IN ('id', 'series_id', 'department_id'))
     OR (table_name = 'member_credentials' AND column_name IN ('kind', 'expires_on'))
     OR (table_name = 'certs' AND column_name IN ('name', 'exp')))
UNION ALL
SELECT 3, 'cert names · ' || d.name, x.norm,
       x.holders || ' member(s) · spellings: ' || x.spellings
  FROM public.departments d
  JOIN LATERAL (
    SELECT regexp_replace(lower(c.name), '[^a-z0-9]+', '', 'g') AS norm,
           count(DISTINCT c.member_id) AS holders,
           string_agg(DISTINCT c.name, ' | ') AS spellings
      FROM public.certs c WHERE c.department_id = d.id GROUP BY 1
  ) x ON true
UNION ALL
SELECT 4, 'helper', p.proname || '() -> ' || format_type(p.prorettype, NULL),
       CASE WHEN position('my_department_id()' in pg_get_functiondef(p.oid)) > 0 OR p.proname IN ('my_department_id', 'my_member_id')
            THEN 'department-scoped' ELSE 'NOT department-scoped (!)' END
       || ' · ' || regexp_replace(substring(pg_get_functiondef(p.oid) from 'AS \$[a-z]*\$(.*)\$[a-z]*\$'), '\s+', ' ', 'g')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_dept_admin', 'is_canmanage', 'my_member_id', 'my_department_id')
UNION ALL
SELECT 5, 'members.status', coalesce(status, '(null)'), count(*)::text FROM public.members GROUP BY status
UNION ALL
SELECT 5, 'separated', 'member_separation rows', count(*)::text FROM public.member_separation
UNION ALL
SELECT 5, 'project admins', 'members with Project Admin', count(*)::text FROM public.members WHERE access && array['Project Admin']::text[]
UNION ALL
SELECT 6, 'activity source', c.relname,
       (SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = c.relname
           AND column_name IN ('member_id', 'department_id', 'check_in_at', 'check_out_at', 'credited_minutes', 'hours', 'session_id', 'date', 'kind', 'voided_at', 'auto_closed'))
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
   AND c.relname IN ('station_presence', 'session_attendance', 'training_sessions', 'supervised_sessions', 'calls', 'incident_responses', 'call_responses')
UNION ALL
SELECT 7, 'name free?', t, CASE WHEN to_regclass('public.' || t) IS NULL AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = t AND pronamespace = 'public'::regnamespace) THEN 'free' ELSE 'TAKEN' END
  FROM unnest(array['readiness_requirements', 'set_readiness_requirement', 'dept_readiness_requirements', 'member_scorecard', 'dept_readiness_packet']) t
UNION ALL
SELECT 7, 'policies', 'total', count(*)::text FROM pg_policies WHERE schemaname = 'public'
ORDER BY 1, 2, 3;
