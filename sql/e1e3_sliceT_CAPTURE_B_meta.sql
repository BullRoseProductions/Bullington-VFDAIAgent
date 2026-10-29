-- E1/E3 Slice T — LIVE CAPTURE (B): triggers, constraints, columns, policy md5, counts, and the per-department LEDGER
-- baseline (md5 of attested_training + dept_iso_hours_for, all time). READ-ONLY, one row. No member data: md5s and counts.
-- Output (Copy as JSON) → docs/review/e1e3_sliceT_LIVE_meta.json
SELECT jsonb_build_object(
  'read_at', now()::text,
  'triggers', (SELECT jsonb_object_agg(t.tgname, pg_get_triggerdef(t.oid)) FROM pg_trigger t
                WHERE t.tgrelid = 'public.training_sessions'::regclass AND NOT t.tgisinternal),
  'constraints', (SELECT jsonb_object_agg(conname, pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass),
  'columns', (SELECT jsonb_object_agg(c.table_name, c.cols) FROM (
                SELECT table_name, jsonb_agg(jsonb_build_object('name', column_name, 'type', udt_name, 'null', is_nullable = 'YES', 'default', column_default) ORDER BY ordinal_position) cols
                  FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name IN ('training_sessions', 'session_attendance', 'training_session_audit', 'training_plans', 'station_presence', 'members', 'departments')
                 GROUP BY table_name) c),
  'policies_md5', (SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
                     FROM pg_policies WHERE schemaname = 'public'),
  'counts', jsonb_build_object(
    'fns', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
    'policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'verified', (SELECT count(*) FROM public.station_presence WHERE verified),
    'sessions', (SELECT count(*) FROM public.training_sessions),
    'done_with_duration', (SELECT count(*) FROM public.training_sessions WHERE done AND duration_min IS NOT NULL)),
  'ledger', (SELECT jsonb_object_agg(d.id::text, jsonb_build_object(
      'attested', (SELECT md5(coalesce(string_agg(a.member_id || '|' || a.session_id || '|' || a.start_at || '|' || a.end_at || '|' || a.optional, ',' ORDER BY a.member_id, a.session_id), ''))
                     FROM public.attested_training(d.id, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) a),
      'iso', (SELECT md5(coalesce(string_agg(h.member_id || '|' || h.training_hours || '|' || h.standby_hours || '|' || h.iso_total_hours, ',' ORDER BY h.member_id), ''))
                FROM public.dept_iso_hours_for(d.id, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) h)))
    FROM public.departments d)
) AS meta;
