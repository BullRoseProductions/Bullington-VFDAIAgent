-- READ-ONLY Step 0 for Training Overhaul Slice 7 (reschedule / cancel + two-person + drawn signature). No writes.
WITH fn AS (SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) args, pg_get_functiondef(p.oid) def, p.prosecdef
              FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f')
SELECT jsonb_pretty(jsonb_build_object(
  'fns_reading_training_sessions', (SELECT jsonb_agg(proname || '(' || args || ')' ORDER BY proname) FROM fn WHERE def ILIKE '%training_sessions%'),
  'views_reading_training_sessions', (SELECT jsonb_agg(table_name) FROM information_schema.views WHERE table_schema = 'public' AND view_definition ILIKE '%training_sessions%'),
  'issue_equipment_batch_witness_lines', (SELECT jsonb_agg(l) FROM fn, regexp_split_to_table(def, E'\n') l
                                            WHERE proname = 'issue_equipment_batch' AND (l ILIKE '%witness%' OR l ILIKE '%signature%' OR l ILIKE '%raise%')),
  'equipment_issue_batch_cols', (SELECT jsonb_agg(column_name || ' ' || udt_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'equipment_issue_batch'),
  'signature_sizes', (SELECT jsonb_build_object('n', count(*), 'avg_len', round(avg(length(signature_data))), 'max_len', max(length(signature_data)),
                         'data_url', bool_and(signature_data LIKE 'data:image/png;base64,%')) FROM public.equipment_issue_batch WHERE signature_data IS NOT NULL),
  'witnessed_batches', (SELECT count(*) FROM public.equipment_issue_batch WHERE witness_signature IS NOT NULL),
  'audit_cols', (SELECT jsonb_agg(column_name || ' ' || udt_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_session_audit'),
  'audit_action_check', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.training_session_audit'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%action%' LIMIT 1),
  'audit_rows_by_action', (SELECT coalesce(jsonb_object_agg(action, n), '{}'::jsonb) FROM (SELECT action, count(*) n FROM public.training_session_audit GROUP BY 1) x),
  'sessions', (SELECT jsonb_build_object(
      'total', count(*),
      'done', count(*) FILTER (WHERE done),
      'future_not_done', count(*) FILTER (WHERE NOT done AND date >= current_date),
      'past_not_done_no_att', count(*) FILTER (WHERE NOT done AND date < current_date AND NOT EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id)),
      'past_not_done_with_att', count(*) FILTER (WHERE NOT done AND date < current_date AND EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id)),
      'in_series', count(*) FILTER (WHERE series_id IS NOT NULL),
      'with_plans', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.session_plans sp WHERE sp.session_id = ts.id)),
      'with_registrations', count(*) FILTER (WHERE to_regclass('public.session_registrations') IS NOT NULL)) FROM public.training_sessions ts),
  'title_hints', (SELECT jsonb_agg(DISTINCT title) FROM public.training_sessions WHERE title ~* 'cancel|postpon|resched|moved|rain ?date'),
  'fk_into_training_sessions', (SELECT jsonb_agg(conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid)) FROM pg_constraint
                                  WHERE contype = 'f' AND confrelid = 'public.training_sessions'::regclass),
  'ts_status_like_cols', (SELECT jsonb_agg(column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions'
                            AND column_name ~* 'status|cancel|resched|state|void'),
  'leaders_per_dept', (SELECT jsonb_object_agg(d.name, jsonb_build_object(
      'da', (SELECT count(*) FROM public.members m WHERE m.department_id = d.id AND m.status IN ('Active','Probationary') AND m.access && array['Department Admin']::text[]),
      'to', (SELECT count(*) FROM public.training_officer t WHERE t.department_id = d.id AND t.removed_at IS NULL),
      'to_not_da', (SELECT count(*) FROM public.training_officer t JOIN public.members m ON m.id = t.member_id WHERE t.department_id = d.id AND t.removed_at IS NULL AND NOT m.access && array['Department Admin']::text[])))
     FROM public.departments d)
)) AS r;
