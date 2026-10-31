-- =====================================================================
-- RETEST for l3_drop_dead_tables. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- One sub-block ending in RAISE 'SENTINEL' (rolled back) — the re-create in R1 never stays. The final RAISE is the report.
--   S0 both tables are gone; the relation list = the capture minus the two; the function / policy / trigger sets = the capture
--   R1 THE DROP IS REVERSIBLE: the ROLLBACK's re-create (the captured DDL + every backed-up row) runs, and the tables come back
--      exactly — columns + defaults, constraints (incl. profiles → auth.users / members / departments), indexes, comment, RLS on
--      with no policy, privileges — with content md5s byte-identical to the backup (profiles d41d8cd9 · _d2a f04e8dff)
--   R2 …and are still unreachable from the API: anon / authenticated read nothing
-- =====================================================================
DO $retest$
DECLARE rpt text := ''; v_pass int := 0; v_fail int := 0;
BEGIN
  BEGIN
    PERFORM set_config('TimeZone', 'UTC', true);
    IF to_regclass('public.profiles') IS NULL AND to_regclass('public._d2a_resync_backup') IS NULL AND (SELECT md5(string_agg(c.relname || ':' || c.relkind::text, ',' ORDER BY c.relname COLLATE "C")) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')) = '1c8d4cd0649e9a40fa709fe74cef5377'
       AND (SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text COLLATE "C")) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f') = '85880f476a81c1f4a1a63eded0b91765' AND (SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename COLLATE "C", policyname COLLATE "C")) FROM pg_policies WHERE schemaname = 'public') = 'c9815df77d8354f69b28aa415452c2e5' AND (SELECT md5(string_agg(c.relname || '.' || t.tgname || '|' || pg_get_triggerdef(t.oid), ',' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C")) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) = '8b46073b5a8154e5d38235a7c509dfc7' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 both tables gone; relations = the capture minus the two; the function / policy / trigger sets unchanged' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S0 the drop is not in place as intended' || chr(10); END IF;

    -- R1 — the ROLLBACK's re-create, verbatim (generated from the same capture), then the exact-shape + exact-content proof
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
    IF ((SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
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
       AND (SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.station_id), '')) FROM public._d2a_resync_backup x) = 'f04e8dffd94cad6bc21dd0b7ec786e21') THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R1 reversible: the captured DDL + the backup re-create both tables exactly (shape, constraints, RLS, privileges) with content md5s = the backup' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  R1 the re-create does not reproduce the captured tables' || chr(10); END IF;

    -- R2 — the re-created tables are as unreachable as the originals (RLS on, no policy; _d2a with no grant)
    IF NOT has_table_privilege('anon', 'public.profiles', 'SELECT') AND NOT has_table_privilege('anon', 'public._d2a_resync_backup', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public._d2a_resync_backup', 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('profiles', '_d2a_resync_backup')) THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R2 re-created, they are as unreachable as before: no anon grant, no policy (RLS denies authenticated on profiles), no grant on _d2a' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  R2 the re-created tables are reachable' || chr(10); END IF;

    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  the RETEST block aborted: %s%s', SQLERRM, chr(10)); END IF;
  END;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, 0 skipped', v_pass, v_fail);
END
$retest$;
