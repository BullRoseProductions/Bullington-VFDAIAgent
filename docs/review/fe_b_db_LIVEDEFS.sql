-- READ-ONLY: the live state FE-B-DB pins against (claude/B4C_FundingEvents_Redesign_Step0_ReviewRecord.md). No writes.
WITH fn AS (SELECT p.oid, p.proname, p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def, p.prosecdef,
                   has_function_privilege('anon', p.oid, 'EXECUTE') anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x
              FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'),
tb AS (SELECT c.oid, c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
         AND c.relname IN ('funding_events', 'recruitment_events', 'action_items', 'fundraisers', 'members', 'departments', 'ai_outputs', 'notifications'))
SELECT jsonb_pretty(jsonb_build_object(
  'server_version', current_setting('server_version'),
  'defs', (SELECT jsonb_object_agg(sig, jsonb_build_object('md5', md5(def), 'definer', prosecdef, 'anon', anon_x, 'auth', auth_x, 'def', def)) FROM fn
            WHERE proname IN ('my_department_id', 'my_member_id', 'is_leader', 'is_canmanage', 'is_canmanage_ops', 'is_dept_admin', 'is_muted',
                              'my_department_rollup', 'complete_action_item', 'reopen_action_item', 'cancel_action_item',
                              'notify_action_item_assigned', 'set_fundraiser_step_visible', 'get_station_fundraisers', 'set_fundraiser_shared')),
  'name_clash', (SELECT coalesce(jsonb_agg(proname), '[]'::jsonb) FROM fn WHERE proname IN ('claim_event_need', 'unclaim_event_need', 'assign_event_need', 'remove_event_need_claim', 'tg_event_needs_guard')),
  'table_clash', (SELECT coalesce(jsonb_agg(relname), '[]'::jsonb) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('event_needs', 'event_need_claims')),
  'tables', (SELECT jsonb_object_agg(relname, jsonb_build_object(
      'cols', (SELECT jsonb_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                                || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum)
                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = tb.oid AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_agg(conname || ' | ' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = tb.oid),
      'indexes', (SELECT jsonb_agg(indexrelid::regclass::text || ' | ' || pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid = tb.oid),
      'policies', (SELECT coalesce(jsonb_agg(policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',') || ' | ' || coalesce(qual, '') || ' | ' || coalesce(with_check, '') ORDER BY policyname), '[]'::jsonb)
                     FROM pg_policies WHERE schemaname = 'public' AND tablename = tb.relname),
      'triggers', (SELECT coalesce(jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname), '[]'::jsonb) FROM pg_trigger WHERE tgrelid = tb.oid AND NOT tgisinternal),
      'relacl', (SELECT relacl::text FROM pg_class WHERE oid = tb.oid),
      'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = tb.oid),
      'rows', (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) n FROM public.%I', relname), false, true, '')))[1]::text::int
    )) FROM tb),
  'member_status_values', (SELECT jsonb_object_agg(coalesce(status, '(null)'), n) FROM (SELECT status, count(*) n FROM public.members GROUP BY 1) x),
  'depts', (SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name,
      'da', (SELECT count(*) FROM public.members m WHERE m.department_id = d.id AND 'Department Admin' = ANY (m.access)),
      'officer', (SELECT count(*) FROM public.members m WHERE m.department_id = d.id AND 'Officer' = ANY (m.access)),
      'recruitment_events', (SELECT count(*) FROM public.recruitment_events e WHERE e.department_id = d.id)) ORDER BY d.name) FROM public.departments d),
  'fn_count', (SELECT count(*) FROM fn),
  'fn_snapshot_md5', (SELECT md5(string_agg(sig || '=' || md5(def), ',' ORDER BY sig)) FROM fn),
  'total_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'policy_snapshot_md5', (SELECT md5(string_agg(tablename || '.' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
)) AS r;
