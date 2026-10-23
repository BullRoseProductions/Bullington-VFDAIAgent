-- =====================================================================
-- STANDARD CERT PRE-LOAD (DB) — Review PASS 2026-10-22 (d55e35d). APPLIED live 2026-10-23; RETEST 19/0/2 (docs/review/standard_certs_LIVE_RETEST.md).
-- Order: claude/B4C_StandardCerts_DB_BuildOrder.md. Built on the live cert catalog (Slices A + B).
--
-- THE CHANGE — additive only:
--   1 standard_cert_types — a GLOBAL reference list (above departments: no department_id, no FK): track (sffma | tcfp |
--     ems | cards), name, never_expires, category (certification | continuing_education), sort_order, created_at.
--     RLS on; ONE policy — SELECT TO authenticated USING (true) (identical, non-sensitive reference data for every
--     department); no write policy (seed-only). Unique on (track, lower(btrim(name))).
--   2 the seed — 69 rows (SFFMA 24 · TCFP 32 · Texas EMS 5 · cards 8). The never_expires flags are PROPOSED defaults
--     (Tommy reviews after); a later migration can UPDATE them without touching any department's catalog — a
--     department's copy is an independent cert_types row once added.
--   3 add_standard_cert_type(p_standard_id) — SECURITY DEFINER, search_path public, EXECUTE authenticated only. Same
--     gate as set_cert_type: is_dept_admin() + my_department_id(). Copies the standard row's name / never_expires /
--     category into the caller's cert_types (created_by / updated_by = my_member_id()) and returns the new row. The
--     existing per-department unique name → "That cert type is already in your catalog."
-- NOT touched: cert_types' shape (columns, constraints, indexes, policy), set_cert_type / delete_cert_type /
-- dept_cert_types / assign_cert_type, the readers (expiration_rows, readiness_window, dept_cert_readiness,
-- probation_item_states, readiness_items, ...), any gate. No list RPC — the picker reads the table through its policy.
--
-- Single all-or-nothing DO block; refuses a second apply (the table and the RPC must not exist) and refuses on drift
-- (Slice A live; is_dept_admin md5 c692e44f…). Post-conditions: the table, RLS, its one policy, the CHECKs and unique
-- index; 69 seed rows (24 / 32 / 5 / 8) with the proposed flags; the RPC's definer / search_path / grants; cert_types'
-- shape byte-identical; every other function and policy byte-identical; total_policies +1; the locked-token count
-- unchanged. The locked verification column is never touched. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  v_cert_types_before text; v_cert_types_after text;
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_total_before int; v_tok_before int;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.standard_cert_types') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: public.standard_cert_types already exists — already applied. Nothing changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'add_standard_cert_type') THEN
    RAISE EXCEPTION 'Precondition failed: add_standard_cert_type already exists. Nothing changed.';
  END IF;
  IF to_regclass('public.cert_types') IS NULL OR to_regprocedure('public.set_cert_type(uuid,text,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: the cert catalog (Slice A: cert_types + set_cert_type) is not live. Nothing changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cert_types_dept_name_uq'
                  AND indexdef = 'CREATE UNIQUE INDEX cert_types_dept_name_uq ON public.cert_types USING btree (department_id, lower(btrim(name)))') THEN
    RAISE EXCEPTION 'Precondition failed: cert_types_dept_name_uq is not the Slice A index (the friendly clash relies on it). Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) <> 'c692e44f62923d2bf4c1a39a21a87bf7' THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is not the department-scoped Step A version (md5 c692e44f…). Nothing changed.';
  END IF;

  -- snapshots: cert_types' whole shape, every function, every policy, counts
  SELECT string_agg(x, E'\n' ORDER BY x) INTO v_cert_types_before FROM (
    SELECT 'col|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS x
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.cert_types'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'con|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.cert_types'::regclass
    UNION ALL SELECT 'idx|' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'cert_types'
    UNION ALL SELECT 'rls|' || relrowsecurity::text || '|' || relforcerowsecurity::text || '|' || coalesce(relacl::text, '') FROM pg_class WHERE oid = 'public.cert_types'::regclass) s;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p');
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;

  -- ---------------------------------------------------------------- 1 the table
  CREATE TABLE public.standard_cert_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    track text NOT NULL CONSTRAINT standard_cert_types_track_chk CHECK (track IN ('sffma', 'tcfp', 'ems', 'cards')),
    name text NOT NULL CONSTRAINT standard_cert_types_name_chk CHECK (btrim(name) <> ''),
    never_expires boolean NOT NULL,
    category text NOT NULL CONSTRAINT standard_cert_types_category_chk CHECK (category IN ('certification', 'continuing_education')),
    sort_order int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX standard_cert_types_track_name_uq ON public.standard_cert_types (track, lower(btrim(name)));
  ALTER TABLE public.standard_cert_types ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "authenticated read standard_cert_types" ON public.standard_cert_types FOR SELECT TO authenticated USING (true);

  -- ---------------------------------------------------------------- 2 the seed (proposed flags — Tommy reviews after)
  INSERT INTO public.standard_cert_types (track, name, never_expires, category, sort_order)
  SELECT v.track, v.name, v.never_expires, v.category, v.ord
    FROM (
      SELECT 'sffma'::text AS track, n AS name, true AS never_expires, 'certification'::text AS category, o::int AS ord
        FROM unnest(array['Firefighter', 'Master Firefighter', 'Support Personnel', 'Instructor', 'Fire Inspector', 'Fire/Arson Investigator',
                          'Driver/Operator', 'Fire Officer', 'Incident Safety Officer', 'Public Information Officer', 'Fire & Life Safety Educator',
                          'Wildland Fire Fighting', 'Telecommunicator', 'Rope Rescue', 'Confined Space Rescue', 'Trench Rescue',
                          'Structural Collapse Rescue', 'Common Vehicle Rescue', 'Surface Water Rescue', 'Swiftwater Rescue',
                          'Wilderness Search & Rescue', 'Machinery Rescue', 'Heavy Vehicle Rescue', 'Hazardous Materials']) WITH ORDINALITY u(n, o)
      UNION ALL
      SELECT 'tcfp', n, true, 'certification', o::int
        FROM unnest(array['Full Structure Fire Fighting', 'Firefighter I', 'Firefighter II', 'Aircraft Rescue Firefighter', 'Marine Firefighter',
                          'Driver Operator–Pumper', 'Driver Operator–Aerial', 'Officer I', 'Officer II', 'Officer III', 'Officer IV',
                          'Instructor I', 'Instructor II', 'Instructor III', 'Fire Inspector', 'Inspector I', 'Inspector II', 'Plans Examiner I',
                          'Investigator', 'Fire Marshal', 'Fire & Life Safety Educator I', 'Fire & Life Safety Educator II',
                          'Incident Safety Officer', 'Incident Commander', 'Basic Wildland Firefighter', 'Intermediate Wildland',
                          'Hazardous Materials Awareness', 'Hazardous Materials Operations', 'Hazardous Materials Technician',
                          'Hazardous Materials Incident Commander', 'Rope Rescue Awareness/Operations', 'Rope Rescue Technician']) WITH ORDINALITY u(n, o)
      UNION ALL
      SELECT 'ems', n, false, 'certification', o::int   -- DSHS: renew every 4 years
        FROM unnest(array['Emergency Care Attendant (ECA)', 'Emergency Medical Technician (EMT)', 'Advanced EMT (AEMT)',
                          'EMT-Paramedic (EMT-P)', 'Licensed Paramedic (LP)']) WITH ORDINALITY u(n, o)
      UNION ALL
      SELECT 'cards', n, ne, 'continuing_education', o::int
        FROM unnest(array['CPR / BLS', 'ACLS', 'PALS', 'PHTLS / ITLS', 'NIMS/ICS 100', 'NIMS/ICS 200', 'NIMS/ICS 700', 'NIMS/ICS 800'],
                    array[false, false, false, false, true, true, true, true]) WITH ORDINALITY u(n, ne, o)
    ) v
  ON CONFLICT (track, lower(btrim(name))) DO NOTHING;

  -- ---------------------------------------------------------------- 3 the RPC
  CREATE FUNCTION public.add_standard_cert_type(p_standard_id uuid)
   RETURNS public.cert_types LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:standard certs — a Department Admin (or PA) copies a standard cert type into their OWN department's catalog. The
  -- copy is an ordinary cert_types row afterwards (edit via set_cert_type, delete via delete_cert_type).
  declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
          v_std public.standard_cert_types; v_row public.cert_types;
  begin
    if v_dept is null or not coalesce(public.is_dept_admin(), false) then
      raise exception 'Only a Department Admin can manage cert types.';
    end if;
    select * into v_std from public.standard_cert_types where id = p_standard_id;
    if not found then raise exception 'That standard cert type was not found.'; end if;
    begin
      insert into public.cert_types (department_id, name, never_expires, category, created_by, updated_by)
      values (v_dept, btrim(v_std.name), v_std.never_expires, v_std.category, v_me, v_me)
      returning * into v_row;
    exception when unique_violation then
      raise exception 'That cert type is already in your catalog.';
    end;
    return v_row;
  end;
  $fn$;
  REVOKE EXECUTE ON FUNCTION public.add_standard_cert_type(uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.add_standard_cert_type(uuid) TO authenticated;

  -- ---------------------------------------------------------------- post-conditions
  -- (1) the table: columns, RLS, the one policy, CHECKs, unique index; global (no department column, no FK)
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid = 'public.standard_cert_types'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
     IS DISTINCT FROM 'id:uuid:true,track:text:true,name:text:true,never_expires:boolean:true,category:text:true,sort_order:integer:true,created_at:timestamp with time zone:true' THEN
    RAISE EXCEPTION 'Post-condition failed: standard_cert_types columns are not as designed.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.standard_cert_types'::regclass) THEN RAISE EXCEPTION 'Post-condition failed: RLS is off on standard_cert_types.'; END IF;
  IF (SELECT string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'standard_cert_types')
     IS DISTINCT FROM 'authenticated read standard_cert_types|SELECT|{authenticated}|true|' THEN
    RAISE EXCEPTION 'Post-condition failed: standard_cert_types must have exactly one policy — SELECT, authenticated, USING (true).';
  END IF;
  IF (SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.standard_cert_types'::regclass AND contype IN ('c', 'f'))
     IS DISTINCT FROM 'CHECK ((category = ANY (ARRAY[''certification''::text, ''continuing_education''::text]))) | CHECK ((btrim(name) <> ''''::text)) | CHECK ((track = ANY (ARRAY[''sffma''::text, ''tcfp''::text, ''ems''::text, ''cards''::text])))' THEN
    RAISE EXCEPTION 'Post-condition failed: the CHECKs are not as designed (or a foreign key was added).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'standard_cert_types_track_name_uq'
                  AND indexdef = 'CREATE UNIQUE INDEX standard_cert_types_track_name_uq ON public.standard_cert_types USING btree (track, lower(btrim(name)))') THEN
    RAISE EXCEPTION 'Post-condition failed: the (track, name) unique index is missing or different.';
  END IF;
  -- (2) the seed: 69 rows, the per-track counts, the proposed flags and categories, sort_order 1..n per track
  IF (SELECT string_agg(track || ':' || n || ':' || ne || ':' || cat || ':' || ord_ok, ',' ORDER BY track) FROM (
        SELECT track, count(*) AS n, count(*) FILTER (WHERE never_expires) AS ne, string_agg(DISTINCT category, '/') AS cat,
               (min(sort_order) = 1 AND max(sort_order) = count(*) AND count(DISTINCT sort_order) = count(*))::text AS ord_ok
          FROM public.standard_cert_types GROUP BY track) s)
     IS DISTINCT FROM 'cards:8:4:continuing_education:true,ems:5:0:certification:true,sffma:24:24:certification:true,tcfp:32:32:certification:true' THEN
    RAISE EXCEPTION 'Post-condition failed: the seed is not the 69 rows (sffma 24 · tcfp 32 · ems 5 · cards 8) with the proposed flags.';
  END IF;
  -- (3) the RPC: definer, search_path pinned, EXECUTE authenticated only
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.add_standard_cert_type(uuid)'::regprocedure AND p.prosecdef AND p.proconfig = array['search_path=public']
                  AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
    RAISE EXCEPTION 'Post-condition failed: add_standard_cert_type is not SECURITY DEFINER / search_path public / authenticated-only.';
  END IF;
  -- (4) cert_types untouched; nothing else moved
  SELECT string_agg(x, E'\n' ORDER BY x) INTO v_cert_types_after FROM (
    SELECT 'col|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS x
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.cert_types'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'con|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.cert_types'::regclass
    UNION ALL SELECT 'idx|' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'cert_types'
    UNION ALL SELECT 'rls|' || relrowsecurity::text || '|' || relforcerowsecurity::text || '|' || coalesce(relacl::text, '') FROM pg_class WHERE oid = 'public.cert_types'::regclass) s;
  IF v_cert_types_after IS DISTINCT FROM v_cert_types_before THEN RAISE EXCEPTION 'Post-condition failed: cert_types'' shape changed.'; END IF;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND p.proname <> 'add_standard_cert_type';
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: an existing public function (or its grants) changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'standard_cert_types';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: an existing policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before + 1 THEN RAISE EXCEPTION 'Post-condition failed: total_policies is not +1.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: std_rls true · std_policies 1 · std_rows 69 · by_track cards 8 · ems 5 · sffma 24 · tcfp 32 · rpc_ok true ·
--              total_policies 171 · locked_token_fns 17)
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.standard_cert_types'::regclass) AS std_rls,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'standard_cert_types') AS std_policies,
  (SELECT count(*) FROM public.standard_cert_types) AS std_rows,
  (SELECT string_agg(track || ' ' || n, ' · ' ORDER BY track) FROM (SELECT track, count(*) AS n FROM public.standard_cert_types GROUP BY track) s) AS by_track,
  (SELECT prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
     FROM pg_proc WHERE oid = 'public.add_standard_cert_type(uuid)'::regprocedure) AS rpc_ok,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
