-- E1/E3 T2 — LIVE CAPTURE (B): tables, triggers, constraints, columns, policies, grants, counts, and the per-department
-- LEDGER baseline. READ-ONLY, one row. No member data: names of objects, md5s and counts only.
-- Output (Copy as JSON) → docs/review/e1e3_T2_LIVE_meta.json
SELECT jsonb_build_object(
  'read_at', now()::text,
  'search_path', current_setting('search_path'),
  'reactions_table', to_regclass('public.training_session_reactions') IS NOT NULL,
  'triggers', (SELECT jsonb_object_agg(c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE t.tgrelid IN ('public.training_sessions'::regclass, 'public.session_attendance'::regclass) AND NOT t.tgisinternal),
  'constraints', (SELECT jsonb_object_agg(conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)) FROM pg_constraint
                   WHERE conrelid IN ('public.training_sessions'::regclass, 'public.session_attendance'::regclass) AND contype <> 'n'),
  'columns', (SELECT jsonb_object_agg(c.table_name, c.cols) FROM (
                SELECT table_name, jsonb_agg(jsonb_build_object('name', column_name, 'type', udt_name, 'null', is_nullable = 'YES', 'default', column_default) ORDER BY ordinal_position) cols
                  FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name IN ('training_sessions', 'session_attendance', 'training_session_audit', 'training_plans', 'station_presence', 'members', 'departments', 'member_active_department', 'training_officer')
                 GROUP BY table_name) c),
  'sa_policies', (SELECT jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles::text, 'qual', qual, 'check', with_check) ORDER BY policyname)
                    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'session_attendance'),
  'sa_acl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.session_attendance'::regclass),
  'default_acl', (SELECT jsonb_agg(jsonb_build_object('role', defaclrole::regrole::text, 'ns', defaclnamespace::regnamespace::text, 'type', defaclobjtype, 'acl', defaclacl::text))
                    FROM pg_default_acl),
  'policies_md5', (SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
                     FROM pg_policies WHERE schemaname = 'public'),
  'counts', jsonb_build_object(
    'fns', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
    'policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm')),
    'verified', (SELECT count(*) FROM public.station_presence WHERE verified),
    'sessions', (SELECT count(*) FROM public.training_sessions),
    'attendance', (SELECT count(*) FROM public.session_attendance),
    'cancelled', (SELECT count(*) FROM public.training_sessions WHERE status = 'cancelled'),
    'done_and_cancelled', (SELECT count(*) FROM public.training_sessions WHERE done AND status = 'cancelled'),
    'status_values', (SELECT string_agg(DISTINCT coalesce(status, '(null)'), ',') FROM public.members),
    -- RETEST feasibility: Department Admins (unique email) whose department has ≥ 4 OTHER Active members with unique emails
    'retest_das', (SELECT count(*) FROM public.members m WHERE m.status = 'Active' AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
                     AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
                     AND (SELECT count(*) FROM public.members o WHERE o.department_id = m.department_id AND o.id <> m.id AND o.status = 'Active' AND o.email IS NOT NULL
                            AND (SELECT count(*) FROM public.members y WHERE lower(y.email) = lower(o.email)) = 1) >= 4)),
  'ledger', (SELECT jsonb_object_agg(d.id::text, jsonb_build_object(
      'attested', (SELECT md5(coalesce(string_agg(a.member_id || '|' || a.session_id || '|' || a.start_at || '|' || a.end_at || '|' || a.optional, ',' ORDER BY a.member_id, a.session_id), ''))
                     FROM public.attested_training(d.id, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) a),
      'iso', (SELECT md5(coalesce(string_agg(h.member_id || '|' || h.training_hours || '|' || h.standby_hours || '|' || h.iso_total_hours, ',' ORDER BY h.member_id), ''))
                FROM public.dept_iso_hours_for(d.id, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) h)))
    FROM public.departments d)
) AS meta;
