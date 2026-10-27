-- READ-ONLY Step 0 (Funding / Events redesign): the event, fundraiser, action-item and sign-up tables as they are LIVE.
-- No writes. Tables are discovered by name pattern so nothing is assumed from schema.sql (which lags the live DB).
WITH tabs AS (SELECT c.oid, c.relname, c.relrowsecurity rls FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            AND (c.relname ~ '(fund|fundrais|recruit|event|action_item|registration|signup|sign_up|volunteer|need|slot|shift_need|donation)')),
fn AS (SELECT p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
              pg_get_functiondef(p.oid) def
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f')
SELECT jsonb_pretty(jsonb_build_object(
  'tables', (SELECT jsonb_object_agg(relname, jsonb_build_object(
      'rls', rls,
      'rows', (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) n FROM public.%I', relname), false, true, '')))[1]::text::int,
      'cols', (SELECT jsonb_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                                || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum)
                 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = tabs.oid AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_agg(conname || ' | ' || pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid = tabs.oid),
      'policies', (SELECT coalesce(jsonb_agg(policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',') || ' | USING ' || coalesce(qual, '-') || ' | CHECK ' || coalesce(with_check, '-')), '[]'::jsonb)
                     FROM pg_policies WHERE schemaname = 'public' AND tablename = tabs.relname),
      'grants', (SELECT jsonb_agg(DISTINCT grantee || ':' || privilege_type) FROM information_schema.role_table_grants
                  WHERE table_schema = 'public' AND table_name = tabs.relname AND grantee IN ('anon', 'authenticated')),
      'triggers', (SELECT coalesce(jsonb_agg(tgname || ' | ' || pg_get_triggerdef(oid)), '[]'::jsonb) FROM pg_trigger WHERE tgrelid = tabs.oid AND NOT tgisinternal)
    )) FROM tabs),
  'event_type_values', jsonb_build_object(
      'funding_events', (SELECT jsonb_object_agg(coalesce(k, '(null)'), n) FROM (SELECT to_jsonb(f) ->> 'type' k, count(*) n FROM public.funding_events f GROUP BY 1) x),
      'recruitment_events', (SELECT jsonb_object_agg(coalesce(k, '(null)'), n) FROM (SELECT to_jsonb(r) ->> 'type' k, count(*) n FROM public.recruitment_events r GROUP BY 1) x)),
  'events_per_dept', jsonb_build_object(
      'funding_events', (SELECT jsonb_object_agg(d.name, n) FROM (SELECT department_id, count(*) n FROM public.funding_events GROUP BY 1) x JOIN public.departments d ON d.id = x.department_id),
      'recruitment_events', (SELECT jsonb_object_agg(d.name, n) FROM (SELECT department_id, count(*) n FROM public.recruitment_events GROUP BY 1) x JOIN public.departments d ON d.id = x.department_id)),
  'action_items_links', (SELECT jsonb_build_object('total', count(*),
      'with_source_output', count(*) FILTER (WHERE (to_jsonb(a) ->> 'source_output_id') IS NOT NULL),
      'with_fundraiser', count(*) FILTER (WHERE (to_jsonb(a) ->> 'fundraiser_id') IS NOT NULL),
      'keys_seen', (SELECT jsonb_agg(DISTINCT k) FROM public.action_items a2, jsonb_object_keys(to_jsonb(a2)) k))
      FROM public.action_items a),
  'action_items_by_source_feature', (SELECT coalesce(jsonb_object_agg(coalesce(f, '(no source)'), n), '{}'::jsonb) FROM (
      SELECT o.feature f, count(*) n FROM public.action_items a LEFT JOIN public.ai_outputs o ON o.id::text = to_jsonb(a) ->> 'source_output_id' GROUP BY 1) y),
  'ai_outputs_features', (SELECT jsonb_object_agg(feature, n) FROM (SELECT feature, count(*) n FROM public.ai_outputs GROUP BY 1) z),
  'rpcs', (SELECT jsonb_object_agg(proname || '(' || args || ')', jsonb_build_object('definer', definer, 'anon', anon_x, 'auth', auth_x, 'md5', md5(def)))
             FROM fn WHERE proname ~ '(action_item|fundrais|funding|recruit|registration|event|signup|volunteer|need|operationaliz)'),
  'action_item_rpc_defs', (SELECT jsonb_object_agg(proname || '(' || args || ')', def) FROM fn WHERE proname ~ '(action_item|registration)'),
  'gate_fns', (SELECT jsonb_object_agg(proname, md5(def)) FROM fn WHERE proname IN ('is_canmanage', 'is_canmanage_ops', 'is_dept_admin', 'my_department_id', 'my_member_id', 'is_training_manager')),
  'total_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE (to_jsonb(station_presence) ->> 'verified')::boolean IS TRUE)
)) AS r;
