-- READ-ONLY Step 0 for Training Overhaul Slice 6 (corrections + audit log + roll-call-at-close). No writes.
WITH fn AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
         md5(pg_get_functiondef(p.oid)) AS md5, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
)
SELECT jsonb_pretty(jsonb_build_object(
  'policies', (SELECT jsonb_agg(tablename || ' | ' || policyname || ' | ' || cmd || ' | ' || array_to_string(roles, ',') || ' | USING ' || coalesce(qual, '-') || ' | CHECK ' || coalesce(with_check, '-') ORDER BY tablename, cmd, policyname)
                 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('training_sessions', 'session_attendance', 'training_plans')),
  'triggers', (SELECT jsonb_agg(c.relname || ' | ' || t.tgname || ' | ' || pg_get_triggerdef(t.oid) ORDER BY c.relname, t.tgname)
                 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname IN ('training_sessions', 'session_attendance', 'station_presence')),
  'trigger_fn_defs', (SELECT jsonb_object_agg(f.proname, f.def) FROM fn f
                       WHERE f.oid IN (SELECT t.tgfoid FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                                        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname IN ('training_sessions', 'session_attendance'))),
  'fns', (SELECT jsonb_agg(jsonb_build_object('fn', f.proname || '(' || f.args || ')', 'definer', f.prosecdef, 'anon', f.anon_x, 'auth', f.auth_x, 'md5', f.md5) ORDER BY f.proname)
            FROM fn f WHERE f.proname IN ('is_training_manager', 'is_dept_admin', 'session_has_attendance', 'open_signin', 'close_signin', 'member_check_in',
                                          'attested_training', 'dept_station_shifts', 'dept_iso_hours', 'my_department_id', 'my_member_id', 'is_leadership')
               OR f.proname ILIKE '%reopen%' OR f.proname ILIKE '%correct%' OR f.proname ILIKE '%audit%' OR f.proname ILIKE '%presence%' OR f.proname ILIKE '%standby%' OR f.proname ILIKE '%signature%'),
  'def_is_training_manager', (SELECT def FROM fn WHERE proname = 'is_training_manager' LIMIT 1),
  'def_session_has_attendance', (SELECT def FROM fn WHERE proname = 'session_has_attendance' LIMIT 1),
  'attested_training_callers', (SELECT jsonb_agg(proname) FROM fn WHERE proname <> 'attested_training' AND def ILIKE '%attested_training%'),
  'dept_station_shifts_presence_kinds', (SELECT regexp_matches(def, 'kind\s*(=|in|<>)\s*[^\n]{0,80}', 'gi')::text FROM fn WHERE proname = 'dept_station_shifts' LIMIT 1),
  'session_attendance_cols', (SELECT jsonb_agg(column_name || ' ' || data_type || coalesce(' default ' || column_default, '') ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'session_attendance'),
  'training_sessions_cols', (SELECT jsonb_agg(column_name || ' ' || data_type ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions'),
  'station_presence_cols', (SELECT jsonb_agg(column_name || ' ' || data_type ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'station_presence'),
  'station_presence_checks', (SELECT jsonb_agg(conname || ' | ' || pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid = 'public.station_presence'::regclass AND contype = 'c'),
  'presence_by_kind_source', (SELECT jsonb_object_agg(k, n) FROM (SELECT kind || '/' || coalesce(to_jsonb(sp) ->> 'source', '-') || '/verified=' || coalesce(to_jsonb(sp) ->> 'verified', '-') AS k, count(*) n FROM public.station_presence sp GROUP BY 1) x),
  'audit_like_tables', (SELECT jsonb_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%audit%' OR table_name ILIKE '%log%' OR table_name ILIKE '%correction%' OR table_name ILIKE '%history%' OR table_name ILIKE '%signature%' OR table_name ILIKE '%version%')),
  'signature_cols', (SELECT jsonb_agg(table_name || '.' || column_name) FROM information_schema.columns WHERE table_schema = 'public' AND column_name ILIKE '%signature%'),
  'sessions_done', (SELECT count(*) FROM public.training_sessions WHERE done),
  'sessions_done_empty_roll', (SELECT count(*) FROM public.training_sessions ts WHERE done AND NOT EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id)),
  'sessions_done_roll_le2', (SELECT count(*) FROM public.training_sessions ts WHERE done AND (SELECT count(*) FROM public.session_attendance sa WHERE sa.session_id = ts.id) BETWEEN 1 AND 2),
  'sessions_done_with_presence_overlap', (SELECT count(*) FROM public.training_sessions ts WHERE done AND ts.start_time IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.station_presence sp WHERE sp.department_id = ts.department_id AND sp.kind <> 'training'
         AND sp.checked_in_at < ((ts.date + ts.start_time) AT TIME ZONE 'America/Chicago') + make_interval(mins => coalesce(ts.duration_min, 90))
         AND coalesce(sp.checked_out_at, now()) > ((ts.date + ts.start_time) AT TIME ZONE 'America/Chicago'))),
  'presence_members_not_on_roll_in_drill_window', (SELECT count(*) FROM public.training_sessions ts JOIN public.station_presence sp ON sp.department_id = ts.department_id AND sp.kind <> 'training'
         AND sp.checked_in_at < ((ts.date + ts.start_time) AT TIME ZONE 'America/Chicago') + make_interval(mins => coalesce(ts.duration_min, 90))
         AND coalesce(sp.checked_out_at, now()) > ((ts.date + ts.start_time) AT TIME ZONE 'America/Chicago')
       WHERE ts.done AND ts.start_time IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id AND sa.member_id = sp.member_id)),
  'sep3_row', (SELECT jsonb_build_object('title', title, 'date', date, 'done', done, 'att', (SELECT count(*) FROM public.session_attendance sa WHERE sa.session_id = ts.id)) FROM public.training_sessions ts WHERE id = 'e1b7d1a8-7e24-48ee-a3fd-3bce49f3900c'),
  'verified_presence_count', (SELECT count(*) FROM public.station_presence sp WHERE (to_jsonb(sp) ->> 'verified') = 'true')
)) AS r;
