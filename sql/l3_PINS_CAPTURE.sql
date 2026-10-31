-- L-3 PINS CAPTURE — the set-level hashes the migration's preflight pins. READ-ONLY, one row. Hashes and counts only.
-- Output (Copy as JSON) → docs/review/l3_PINS_LIVE.json
SELECT jsonb_build_object(
  'read_at', now()::text,
  'fn_set_md5', (SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text COLLATE "C"))
                   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'),
  'fn_count', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'policy_set_md5', (SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename COLLATE "C", policyname COLLATE "C"))
                       FROM pg_policies WHERE schemaname = 'public'),
  'policy_count', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'trigger_set_md5', (SELECT md5(string_agg(c.relname || '.' || t.tgname || '|' || pg_get_triggerdef(t.oid), ',' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"))
                        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal),
  'relations', (SELECT jsonb_agg(c.relname || ':' || c.relkind::text ORDER BY c.relname COLLATE "C") FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')),
  'auth_users', (SELECT count(*) FROM auth.users)
) AS pins;
