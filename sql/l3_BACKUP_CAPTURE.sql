-- L-3 BACKUP CAPTURE — every row of public.profiles and public._d2a_resync_backup, exactly, plus the md5 the migration re-checks
-- before it drops anything. READ-ONLY (the only side effect: this session's TimeZone set to UTC so timestamps print canonically).
-- Output (Copy as JSON) → docs/review/l3_BACKUP_LIVE.json → generated into sql/l3_backup_rows.sql
WITH tz AS (SELECT set_config('TimeZone', 'UTC', false) AS z)
SELECT (SELECT z FROM tz) AS tz, jsonb_build_object(
  'read_at', now()::text,
  'profiles_rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id::text, 'department_id', p.department_id::text, 'member_id', p.member_id::text,
                      'access', p.access, 'email', p.email, 'created_at', p.created_at::text) ORDER BY p.id), '[]'::jsonb) FROM public.profiles p),
  'profiles_md5', (SELECT md5(coalesce(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id), '')) FROM public.profiles p),
  'd2a_rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('station_id', b.station_id::text, 'lat', b.lat::text, 'lng', b.lng::text, 'radius_m', b.radius_m::text,
                 'geofence_enabled', b.geofence_enabled::text, 'captured_at', b.captured_at::text) ORDER BY b.station_id), '[]'::jsonb) FROM public._d2a_resync_backup b),
  'd2a_md5', (SELECT md5(coalesce(string_agg(to_jsonb(b)::text, ',' ORDER BY b.station_id), '')) FROM public._d2a_resync_backup b)
) AS backup;
