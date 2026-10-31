-- L-3 STEP 0 — prove public.profiles and public._d2a_resync_backup are dead. READ-ONLY, one row, one jsonb.
-- No row CONTENT (counts, column lists, timestamps' min/max only). Output (Copy as JSON) → docs/review/l3_STEP0_LIVE.json
WITH t AS (SELECT c.oid, c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('profiles', '_d2a_resync_backup')),
     pat AS (SELECT '(\mprofiles\M|_d2a_resync_backup)'::text AS re)
SELECT jsonb_build_object(
  'read_at', now()::text,
  'stats_reset', (SELECT stats_reset::text FROM pg_stat_database WHERE datname = current_database()),
  'tables', (SELECT jsonb_object_agg(t.relname, jsonb_build_object(
      'kind', c.relkind::text, 'owner', pg_get_userbyid(c.relowner), 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
      'acl', c.relacl::text, 'comment', obj_description(c.oid, 'pg_class'),
      'reachable', jsonb_build_object(
         'anon', (SELECT jsonb_object_agg(p, has_table_privilege('anon', c.oid, p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p),
         'authenticated', (SELECT jsonb_object_agg(p, has_table_privilege('authenticated', c.oid, p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p)),
      'columns', (SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
                    'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
      'constraints', (SELECT jsonb_object_agg(k.conname, pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype <> 'n'),
      'indexes', (SELECT jsonb_object_agg(i.relname, pg_get_indexdef(x.indexrelid)) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = c.oid),
      'triggers', (SELECT jsonb_object_agg(g.tgname, pg_get_triggerdef(g.oid)) FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal),
      'policies', (SELECT jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles::text, 'qual', qual, 'check', with_check)) FROM pg_policies WHERE schemaname = 'public' AND tablename = t.relname),
      'fks_in', (SELECT jsonb_agg(k.conrelid::regclass::text || '.' || k.conname) FROM pg_constraint k WHERE k.confrelid = c.oid AND k.contype = 'f'),
      'publications', (SELECT jsonb_agg(pubname) FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = t.relname),
      'dependents', (SELECT jsonb_agg(DISTINCT pg_describe_object(dp.classid, dp.objid, dp.objsubid) || ' [' || dp.deptype::text || ']')
                       FROM pg_depend dp
                      WHERE dp.refclassid = 'pg_class'::regclass AND dp.refobjid = c.oid
                        AND NOT (dp.classid = 'pg_class'::regclass AND dp.objid = c.oid)                                     -- itself
                        AND NOT (dp.classid = 'pg_type'::regclass AND dp.objid IN (c.reltype, (SELECT typarray FROM pg_type WHERE oid = c.reltype)))   -- its row type
                        AND NOT (dp.classid = 'pg_constraint'::regclass AND dp.objid IN (SELECT oid FROM pg_constraint WHERE conrelid = c.oid))         -- its own constraints
                        AND NOT (dp.classid = 'pg_class'::regclass AND dp.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid = c.oid))           -- its own indexes
                        AND NOT (dp.classid = 'pg_attrdef'::regclass AND dp.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid = c.oid))),             -- its own defaults
      'stats', (SELECT jsonb_build_object('n_live_tup', s.n_live_tup, 'n_tup_ins', s.n_tup_ins, 'n_tup_upd', s.n_tup_upd, 'n_tup_del', s.n_tup_del,
                  'seq_scan', s.seq_scan, 'last_seq_scan', s.last_seq_scan::text, 'idx_scan', s.idx_scan, 'last_idx_scan', s.last_idx_scan::text,
                  'last_autoanalyze', s.last_autoanalyze::text, 'last_autovacuum', s.last_autovacuum::text) FROM pg_stat_user_tables s WHERE s.relid = c.oid)))
    FROM t JOIN pg_class c ON c.oid = t.oid),
  'rows', jsonb_build_object(
    'profiles', (SELECT count(*) FROM public.profiles),
    'profiles_created_at', (SELECT jsonb_build_object('min', min(created_at)::text, 'max', max(created_at)::text) FROM public.profiles),
    'profiles_member_id_set', (SELECT count(*) FROM public.profiles WHERE member_id IS NOT NULL),
    'profiles_member_id_resolves', (SELECT count(*) FROM public.profiles p WHERE EXISTS (SELECT 1 FROM public.members m WHERE m.id = p.member_id)),
    '_d2a_resync_backup', (SELECT count(*) FROM public._d2a_resync_backup),
    '_d2a_captured_at', (SELECT jsonb_build_object('min', min(captured_at)::text, 'max', max(captured_at)::text) FROM public._d2a_resync_backup)),
  -- REFERENCES, anywhere: every function body in every non-system schema, every policy expression, every view/matview definition,
  -- every trigger anywhere (incl. auth.users), every rule, every pg_cron job command
  'ref_functions', (SELECT jsonb_agg(p.oid::regprocedure::text || ' :: ' ||
                       (SELECT string_agg(DISTINCT m[1], ',') FROM regexp_matches(p.prosrc, (SELECT re FROM pat), 'g') m))
                      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND p.prosrc ~ (SELECT re FROM pat)),
  'ref_function_snippets', (SELECT jsonb_agg(p.oid::regprocedure::text || ' :: ' || substr(p.prosrc, greatest(1, position_hit - 60), 140))
                      FROM (SELECT p.oid, p.prosrc, (SELECT min(strpos(lower(p.prosrc), w)) FILTER (WHERE strpos(lower(p.prosrc), w) > 0)
                                                    FROM unnest(ARRAY['profiles', '_d2a_resync_backup']) w) AS position_hit
                              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ (SELECT re FROM pat)) p),
  'ref_policies', (SELECT jsonb_agg(schemaname || '.' || tablename || '.' || policyname) FROM pg_policies
                    WHERE coalesce(qual, '') ~ (SELECT re FROM pat) OR coalesce(with_check, '') ~ (SELECT re FROM pat)),
  'ref_views', (SELECT jsonb_agg(c.oid::regclass::text) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND pg_get_viewdef(c.oid) ~ (SELECT re FROM pat)),
  'ref_triggers_anywhere', (SELECT jsonb_agg(g.tgrelid::regclass::text || '.' || g.tgname || ' -> ' || g.tgfoid::regprocedure::text)
                             FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid WHERE NOT g.tgisinternal AND p.prosrc ~ (SELECT re FROM pat)),
  'auth_users_triggers', (SELECT jsonb_agg(g.tgname || ' -> ' || g.tgfoid::regprocedure::text) FROM pg_trigger g WHERE g.tgrelid = to_regclass('auth.users') AND NOT g.tgisinternal),
  'ref_rules', (SELECT jsonb_agg(schemaname || '.' || tablename || '.' || rulename) FROM pg_rules WHERE definition ~ (SELECT re FROM pat)),
  'ref_cron', (SELECT CASE WHEN to_regclass('cron.job') IS NULL THEN to_jsonb('pg_cron not installed'::text)
                ELSE (SELECT jsonb_agg(jobid) FROM cron.job WHERE command ~ (SELECT re FROM pat)) END),
  'counts', jsonb_build_object(
    'public_relations', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm')),
    'fns', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
    'policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'verified', (SELECT count(*) FROM public.station_presence WHERE verified))
) AS step0;
