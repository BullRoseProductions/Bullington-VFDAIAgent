-- =====================================================================
-- E1/E3 (training time + reactions) — STEP 0 LIVE CAPTURE. READ-ONLY, one row, one jsonb. No member data beyond counts.
--   fns       · every public function that reads training_sessions.duration_min or writes training_sessions /
--               session_attendance (def, md5, DEFINER, ACL)
--   triggers  · every trigger on training_sessions / session_attendance (def + its function's def)
--   columns   · training_sessions + session_attendance columns
--   policies  · their RLS policies (full expressions)
--   profile   · how duration_min / start_time / done / is_meeting / counts_toward_attendance are populated today
-- =====================================================================
WITH f AS (
  SELECT p.oid, p.proname FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
     AND (p.prosrc ~* 'duration_min'
          OR p.prosrc ~* '(update|insert\s+into)\s+(public\.)?(training_sessions|session_attendance)\y'
          OR p.proname ~* 'attested_training|iso_hours|station_shifts|finalize_training|correct_training|lock_.*session|reopen_training|session_change')
)
SELECT jsonb_pretty(jsonb_build_object(
  'read_at', now()::text,
  'fns', (SELECT jsonb_object_agg(f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')', jsonb_build_object(
            'md5', md5(pg_get_functiondef(f.oid)), 'secdef', p.prosecdef, 'acl', p.proacl::text,
            'reads_duration', p.prosrc ~* 'duration_min', 'def', pg_get_functiondef(f.oid)))
          FROM f JOIN pg_proc p ON p.oid = f.oid),
  'triggers', (SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'name', t.tgname, 'def', pg_get_triggerdef(t.oid),
                 'fn', t.tgfoid::regproc::text, 'fn_def', pg_get_functiondef(t.tgfoid)) ORDER BY c.relname, t.tgname)
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('training_sessions', 'session_attendance') AND NOT t.tgisinternal),
  'columns', (SELECT jsonb_object_agg(c.table_name, c.cols) FROM (
                SELECT table_name, jsonb_agg(column_name || ' ' || data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '') ORDER BY ordinal_position) cols
                  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('training_sessions', 'session_attendance') GROUP BY table_name) c),
  'policies', (SELECT jsonb_agg(jsonb_build_object('table', tablename, 'name', policyname, 'cmd', cmd, 'roles', roles::text, 'qual', qual, 'check', with_check) ORDER BY tablename, policyname)
                 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('training_sessions', 'session_attendance')),
  'profile', (SELECT jsonb_build_object(
      'sessions', count(*),
      'done', count(*) FILTER (WHERE done),
      'done_with_duration', count(*) FILTER (WHERE done AND duration_min IS NOT NULL),
      'done_without_duration', count(*) FILTER (WHERE done AND duration_min IS NULL),
      'with_start_time', count(*) FILTER (WHERE start_time IS NOT NULL),
      'meetings', count(*) FILTER (WHERE is_meeting),
      'duration_min_range', min(duration_min)::text || '..' || max(duration_min)::text)
    FROM public.training_sessions),
  'attendance_cols_profile', (SELECT jsonb_build_object('rows', count(*)) FROM public.session_attendance)
)) AS capture;
