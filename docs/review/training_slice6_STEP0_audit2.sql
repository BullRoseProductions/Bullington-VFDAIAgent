-- READ-ONLY Step 0 (Slice 6), part 2: the hours readers' bodies (does standby de-overlap against attested?) and a sizing of
-- the standby-overlap pairs by kind. No writes.
SELECT jsonb_pretty(jsonb_build_object(
  'dept_station_shifts', (SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'dept_station_shifts' LIMIT 1),
  'dept_iso_hours_for', (SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'dept_iso_hours_for' LIMIT 1),
  'dept_iso_hours_head', (SELECT left(pg_get_functiondef(p.oid), 1500) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'dept_iso_hours' LIMIT 1),
  'overlap_pairs_by_kind_onroll', (SELECT jsonb_object_agg(k, n) FROM (
      SELECT sp.kind || '/onroll=' || (EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id AND sa.member_id = sp.member_id))::text AS k, count(*) n
        FROM public.training_sessions ts JOIN public.station_presence sp ON sp.department_id = ts.department_id AND sp.kind <> 'training'
         AND sp.checked_in_at < ((ts.date + ts.start_time) AT TIME ZONE 'America/Chicago') + make_interval(mins => coalesce(ts.duration_min, 90))
         AND coalesce(sp.checked_out_at, now()) > ((ts.date + ts.start_time) AT TIME ZONE 'America/Chicago')
       WHERE ts.done AND ts.start_time IS NOT NULL GROUP BY 1) x),
  'done_sessions_no_start_time', (SELECT count(*) FROM public.training_sessions WHERE done AND start_time IS NULL),
  'done_sessions_no_duration', (SELECT count(*) FROM public.training_sessions WHERE done AND duration_min IS NULL)
)) AS r;
