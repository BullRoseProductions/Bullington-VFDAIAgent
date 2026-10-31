-- =====================================================================
-- ROLLBACK for l3_drop_dead_tables — re-create both tables from the CAPTURED DDL and restore every backed-up row
-- (the same rows as sql/l3_backup_rows.sql), then prove shape + content are byte-identical to the capture. GENERATED.
-- Refuses unless both tables are absent.
-- =====================================================================
DO $rollback$
BEGIN
  PERFORM set_config('TimeZone', 'UTC', true);
  IF to_regclass('public.profiles') IS NOT NULL OR to_regclass('public._d2a_resync_backup') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK: a table on the L-3 list still exists — nothing to restore. Refusing.';
  END IF;
  CREATE TABLE public.profiles (
    id uuid NOT NULL,
    department_id uuid,
    member_id uuid,
    access text NOT NULL DEFAULT 'Member'::text,
    email text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
  );
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL;
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE SET NULL;
  COMMENT ON TABLE public.profiles IS 'Bridges a real login (auth.users) to a department and a roster member.';
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated, service_role;
  GRANT ALL ON TABLE public.profiles TO authenticated;
  GRANT ALL ON TABLE public.profiles TO service_role;
  CREATE TABLE public._d2a_resync_backup (
    station_id uuid NOT NULL,
    lat double precision,
    lng double precision,
    radius_m integer,
    geofence_enabled boolean,
    captured_at timestamp with time zone NOT NULL DEFAULT now()
  );
  ALTER TABLE public._d2a_resync_backup ADD CONSTRAINT _d2a_resync_backup_pkey PRIMARY KEY (station_id);
  COMMENT ON TABLE public._d2a_resync_backup IS 'Pre-D2a values of the DEFAULT stations geo columns, captured before the resync in sql/phaseD2a_per_station_fences.sql. Exists solely so section 1 can be undone. Not read by the app.';
  ALTER TABLE public._d2a_resync_backup ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public._d2a_resync_backup FROM PUBLIC, anon, authenticated, service_role;
  GRANT ALL ON TABLE public._d2a_resync_backup TO service_role;
  -- public.profiles: 0 rows at capture (md5 d41d8cd98f00b204e9800998ecf8427e) — nothing to insert.
  -- public._d2a_resync_backup: 5 rows at capture (md5 f04e8dffd94cad6bc21dd0b7ec786e21); values as Postgres printed them (shortest exact float text).
  INSERT INTO public._d2a_resync_backup (station_id, lat, lng, radius_m, geofence_enabled, captured_at) VALUES
    ('098b694b-35b5-4721-91eb-f8102733aaf3', '32.517875'::double precision, '-98.044255'::double precision, '50'::integer, 'true'::boolean, '2026-08-27 05:29:20.319228+00'::timestamptz),
    ('997ab6d4-b7a1-495d-8c1c-b5fd55781b56', '32.492551'::double precision, '-97.778922'::double precision, '400'::integer, 'false'::boolean, '2026-08-27 05:29:20.319228+00'::timestamptz),
    ('a0e2363c-cf2c-4229-94a4-e279e5addcc2', NULL, NULL, '150'::integer, 'false'::boolean, '2026-08-27 05:29:20.319228+00'::timestamptz),
    ('b8bab945-f201-47fd-90ea-df3b918b3888', NULL, NULL, '150'::integer, 'false'::boolean, '2026-08-27 05:29:20.319228+00'::timestamptz),
    ('c07322cd-3e9e-4cc3-8e95-84c47505004b', NULL, NULL, '150'::integer, 'false'::boolean, '2026-08-27 05:29:20.319228+00'::timestamptz);
  IF NOT (((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped) = 'id:uuid:NO:,department_id:uuid:YES:,member_id:uuid:YES:,access:text:NO:''Member''::text,email:text:YES:,created_at:timestamp with time zone:NO:now()'
       AND (SELECT md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' ORDER BY conname COLLATE "C")) FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND contype <> 'n') = 'c2f5181873570a64c3d5b75ec8ad09a5'
       AND (SELECT string_agg(pg_get_indexdef(indexrelid), ';' ORDER BY indexrelid::regclass::text COLLATE "C") FROM pg_index WHERE indrelid = 'public.profiles'::regclass) = 'CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id)'
       AND obj_description('public.profiles'::regclass, 'pg_class') = 'Bridges a real login (auth.users) to a department and a roster member.'
       AND (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal)
       AND (SELECT string_agg(rl.rolname || '=' || coalesce((SELECT string_agg(pv.priv, '+' ORDER BY pv.priv) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pv(priv)
           WHERE has_table_privilege(rl.rolname, 'public.profiles', pv.priv)), ''), ',' ORDER BY rl.rolname) FROM unnest(ARRAY['anon','authenticated','service_role']) rl(rolname)) = 'anon=,authenticated=DELETE+INSERT+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE,service_role=DELETE+INSERT+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE'
       AND (SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) FROM public.profiles x) = 'd41d8cd98f00b204e9800998ecf8427e')
     AND ((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'public._d2a_resync_backup'::regclass AND a.attnum > 0 AND NOT a.attisdropped) = 'station_id:uuid:NO:,lat:double precision:YES:,lng:double precision:YES:,radius_m:integer:YES:,geofence_enabled:boolean:YES:,captured_at:timestamp with time zone:NO:now()'
       AND (SELECT md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' ORDER BY conname COLLATE "C")) FROM pg_constraint WHERE conrelid = 'public._d2a_resync_backup'::regclass AND contype <> 'n') = 'a8830bdb52fca9c22823a63ebb25fe2a'
       AND (SELECT string_agg(pg_get_indexdef(indexrelid), ';' ORDER BY indexrelid::regclass::text COLLATE "C") FROM pg_index WHERE indrelid = 'public._d2a_resync_backup'::regclass) = 'CREATE UNIQUE INDEX _d2a_resync_backup_pkey ON public._d2a_resync_backup USING btree (station_id)'
       AND obj_description('public._d2a_resync_backup'::regclass, 'pg_class') = 'Pre-D2a values of the DEFAULT stations geo columns, captured before the resync in sql/phaseD2a_per_station_fences.sql. Exists solely so section 1 can be undone. Not read by the app.'
       AND (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public._d2a_resync_backup'::regclass)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = '_d2a_resync_backup')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public._d2a_resync_backup'::regclass AND NOT tgisinternal)
       AND (SELECT string_agg(rl.rolname || '=' || coalesce((SELECT string_agg(pv.priv, '+' ORDER BY pv.priv) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pv(priv)
           WHERE has_table_privilege(rl.rolname, 'public._d2a_resync_backup', pv.priv)), ''), ',' ORDER BY rl.rolname) FROM unnest(ARRAY['anon','authenticated','service_role']) rl(rolname)) = 'anon=,authenticated=,service_role=DELETE+INSERT+REFERENCES+SELECT+TRIGGER+TRUNCATE+UPDATE'
       AND (SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.station_id), '')) FROM public._d2a_resync_backup x) = 'f04e8dffd94cad6bc21dd0b7ec786e21')) OR (SELECT md5(string_agg(c.relname || ':' || c.relkind::text, ',' ORDER BY c.relname COLLATE "C")) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')) IS DISTINCT FROM '13be068aabe92320a6beb5d9a7ef4f18' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: the re-created tables are not exactly the captured ones. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
