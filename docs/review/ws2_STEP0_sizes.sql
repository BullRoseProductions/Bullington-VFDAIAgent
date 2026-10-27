-- READ-ONLY (WS-2 Step 0): how big Station Q&A's system prompt gets — SOP text per department. Lengths only, no content.
SELECT jsonb_pretty(jsonb_build_object(
  'per_dept', (SELECT jsonb_agg(jsonb_build_object('dept', left(department_id::text, 8), 'docs', n, 'total_chars', tot, 'max_doc', mx) ORDER BY tot DESC)
                 FROM (SELECT department_id, count(*) n, sum(length(content_text)) tot, max(length(content_text)) mx
                         FROM public.documents WHERE content_text IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL GROUP BY 1) x),
  'assistant_usage', (SELECT jsonb_agg(jsonb_build_object('dept', left(department_id::text, 8), 'month', period_month, 'count', count)) FROM public.assistant_usage),
  'image_usage', (SELECT jsonb_agg(jsonb_build_object('dept', left(department_id::text, 8), 'month', period_month, 'count', count)) FROM public.image_gen_usage),
  'auth_users', (SELECT count(*) FROM auth.users),
  'auth_users_without_member', (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.members m WHERE lower(m.email) = lower(u.email))),
  'auth_users_without_active_member', (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.members m WHERE lower(m.email) = lower(u.email) AND m.status IN ('Active', 'Probationary'))),
  'ai_outputs_last_30d', (SELECT count(*) FROM public.ai_outputs WHERE created_at > now() - interval '30 days')
)) AS r;
