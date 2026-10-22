-- =====================================================================
-- CERT CATALOG — SLICE A (catalog foundation + "doesn't expire") — Review PASS 2026-10-21 (738b711).
-- APPLIED on live 2026-10-21 — state check clean: cert_types_rls true · cert_types_policies 1 · cert_types_rows 0 · typed_certs 0 ·
-- rpcs 4 · readers_ok true · dcr_anon_exec false · total_policies 170 · locked_token_fns 17.
-- Order: claude/B4C_CertCatalog_DB_BuildOrder.md (Slice A + the Oct 21 amendment: a category column, no seed list).
-- Off the live Step 0 / 0b (docs/review/cert_catalog_STEP0_OUTPUT.md, ..._STEP0B_OUTPUT.md); F1 / G1 / G2 live.
--
-- A1 cert_types — per-department catalog: name, never_expires, category ('certification' | 'continuing_education',
--    default 'certification'), created/updated at+by. RLS on; ONE policy (SELECT, {authenticated}, own department);
--    no write policy — writes are RPC-only. Unique per department on lower(btrim(name)). Created EMPTY (no seed list).
-- A2 certs.cert_type_id uuid → cert_types(id) ON DELETE SET NULL, nullable. Every existing cert stays NULL = today.
-- A3 RPCs (SECURITY DEFINER, search_path public, EXECUTE authenticated only):
--      set_cert_type(p_id, p_name, p_never_expires, p_category DEFAULT 'certification') — is_dept_admin(), own dept
--      delete_cert_type(p_id) — is_dept_admin(), own dept; certs keep their row, the FK clears their link
--      dept_cert_types() — the caller's department catalog (+ how many certs use each type)
--      assign_cert_type(p_cert_id, p_cert_type_id) — is_dept_admin(); the cert AND the type must be in the caller's
--        department; NULL un-assigns. update_cert (F1, md5 08ec5f34…) is NOT touched.
-- A4 "doesn't expire" lands in exactly four readers, each a minimal edit to its live definition (pinned md5):
--      expiration_rows   — a cert whose type never_expires: bucket 'no_expiry', expires_on / days_until NULL, ranked
--                          with current. Untyped / expiring-type certs: unchanged.
--      readiness_window  — passes 'no_expiry' through (like expired / no_date), never collapsing it to no_date.
--      dept_cert_readiness — a distinct no_expiry count, counted as satisfied in pct; NOT in no_date. Adding a column
--                          changes the return shape, so this one is DROP + CREATE: the EXECUTE grants are captured
--                          first and restored exactly (proven below) — a bare re-create would re-open anon / PUBLIC.
--      probation_item_states — a kind='cert' item is current if the matched cert's type never_expires.
--    my_department_rollup / pa_department_radar count dated certs only (an undated never-expires cert is uncounted,
--    never "expired") and my_expirations / dept_expirations delegate to expiration_rows: unchanged.
--
-- Single all-or-nothing DO block. Refuses on drift (every touched function's live md5 pinned; is_dept_admin c692e44f…)
-- and refuses a second apply (no catalog table / column / RPC may exist yet). Post-conditions: the table, its RLS,
-- policy, constraints and unique index; the FK column; each reader = its live body with exactly the listed edits
-- (and its reviewed md5); grants on dept_cert_readiness identical to before; every OTHER function and policy
-- byte-identical; total_policies +1; the locked-token function count unchanged. The locked verification column is
-- never touched. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  -- live md5s (Step 0 / 0b, 2026-10-21) and the reviewed md5s after this slice
  OLD constant jsonb := '{"expiration_rows(uuid,uuid)":"3223629e82c12eeec2cbd34daebf8085","readiness_window(text,date)":"35a62755ffc68b4db8b05dbe26d3b37b",
                          "dept_cert_readiness()":"808e173f70446e20e15626cd9bb282dd","probation_item_states(uuid,uuid)":"bbe66fcac2ddd9931e12d9226d1ed800"}';
  NEW constant jsonb := '{"expiration_rows(uuid,uuid)":"27645093a86b7a67dfb04a21d0fca536","readiness_window(text,date)":"f3d7788e1ee66a039d46b7e960d1a480",
                          "dept_cert_readiness()":"d0d54de6a9533e6faa9d0c065c5439df","probation_item_states(uuid,uuid)":"c663eb8a6d16905ab7a45b763130388f"}';
  NEW_RPCS constant text[] := array['set_cert_type', 'delete_cert_type', 'dept_cert_types', 'assign_cert_type'];
  e record; f text; n int; v_def text; v_src text;
  v_defs jsonb := '{}'; v_srcs jsonb := '{}'; v_exp_src jsonb := '{}';
  v_dcr_acl text; v_dcr_meta text; g record;
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_total_before int; v_tok_before int;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.cert_types') IS NOT NULL THEN RAISE EXCEPTION 'Precondition failed: public.cert_types already exists — already applied. Nothing changed.'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'certs' AND column_name = 'cert_type_id') THEN
    RAISE EXCEPTION 'Precondition failed: certs.cert_type_id already exists. Nothing changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (NEW_RPCS)) THEN
    RAISE EXCEPTION 'Precondition failed: a cert-type RPC already exists. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) <> 'c692e44f62923d2bf4c1a39a21a87bf7' THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is not the department-scoped Step A version (md5 c692e44f…). Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.update_cert(uuid,text,text)'::regprocedure)) <> '08ec5f34bf3d897d95bdbeda5ec52ae7' THEN
    RAISE EXCEPTION 'Precondition failed: update_cert is not the F1 version (md5 08ec5f34…). Nothing changed.';
  END IF;
  FOR f IN SELECT jsonb_object_keys(OLD) LOOP
    IF to_regprocedure('public.' || f) IS NULL THEN RAISE EXCEPTION 'Precondition failed: public.% is missing. Nothing changed.', f; END IF;
    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> OLD ->> f THEN
      RAISE EXCEPTION 'Precondition failed: public.% is not the Step 0 version (md5 %, expected %). Nothing changed.', f, md5(pg_get_functiondef(('public.' || f)::regprocedure)), OLD ->> f;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------- the edits to the four readers (fn, old fragment, new fragment)
  CREATE TEMP TABLE _sliceA_edits (ord int, fn text, old_frag text, new_frag text, in_body boolean) ON COMMIT DROP;
  INSERT INTO _sliceA_edits VALUES
  -- expiration_rows: the final select — a never-expires cert reads 'no_expiry' with no date, ranked with current
  (1, 'expiration_rows(uuid,uuid)', $o$  select r.scope, r.source, r.item_id, r.member_id, r.apparatus_id, r.subject, r.kind, r.label, r.cls, r.expires_on,
         case when r.expires_on is null then null else (r.expires_on - td.d) end,
         case when r.expires_on is null then 'no_date'
              when r.expires_on < td.d then 'expired'
              when r.expires_on - td.d <= 30 then 'soon'
              else 'current' end
    from raw r cross join td
   order by case when r.expires_on is null then 1 when r.expires_on < td.d then 0 when r.expires_on - td.d <= 30 then 2 else 3 end,
            r.expires_on nulls last, r.subject, r.label;$o$,
   $n$  -- cert catalog: a cert whose type never expires reads 'no_expiry' — no date, satisfied, ranked with current;
  -- never a no_date gap and never expired (whatever its old exp says)
  select r.scope, r.source, r.item_id, r.member_id, r.apparatus_id, r.subject, r.kind, r.label, r.cls,
         case when nx.flag then null else r.expires_on end,
         case when nx.flag or r.expires_on is null then null else (r.expires_on - td.d) end,
         case when nx.flag then 'no_expiry'
              when r.expires_on is null then 'no_date'
              when r.expires_on < td.d then 'expired'
              when r.expires_on - td.d <= 30 then 'soon'
              else 'current' end
    from raw r cross join td
    cross join lateral (select r.source = 'cert' and exists (select 1 from public.certs c join public.cert_types t on t.id = c.cert_type_id
                                                              where c.id = r.item_id and t.department_id = p_dept and t.never_expires) as flag) nx
   order by case when nx.flag then 3 when r.expires_on is null then 1 when r.expires_on < td.d then 0 when r.expires_on - td.d <= 30 then 2 else 3 end,
            case when nx.flag then null else r.expires_on end nulls last, r.subject, r.label;$n$, true),
  -- readiness_window: no_expiry stands, like expired / no_date
  (2, 'readiness_window(text,date)', $o$    when p_bucket in ('expired', 'no_date') then p_bucket$o$,
                                     $n$    when p_bucket in ('expired', 'no_date', 'no_expiry') then p_bucket$n$, true),
  -- dept_cert_readiness: the return shape gains no_expiry (header — not in prosrc), then four body edits
  (3, 'dept_cert_readiness()', $o$ RETURNS TABLE(current integer, expiring integer, expired integer, no_date integer, total_dated integer, pct integer)$o$,
                               $n$ RETURNS TABLE(current integer, expiring integer, expired integer, no_date integer, no_expiry integer, total_dated integer, pct integer)$n$, false),
  (4, 'dept_cert_readiness()', $o$      case
        when c.exp is null or c.exp !~ '^\d{4}-\d{2}$' then 'no_date'$o$,
                               $n$      case
        when coalesce(t.never_expires, false) then 'no_expiry'   -- cert catalog: satisfied, never a "needs a date" gap
        when c.exp is null or c.exp !~ '^\d{4}-\d{2}$' then 'no_date'$n$, true),
  (5, 'dept_cert_readiness()', $o$    from public.certs c
    cross join n$o$,
                               $n$    from public.certs c
    left join public.cert_types t on t.id = c.cert_type_id and t.department_id = c.department_id
    cross join n$n$, true),
  (6, 'dept_cert_readiness()', $o$    count(*) filter (where bucket = 'no_date')::int                         as no_date,$o$,
                               $n$    count(*) filter (where bucket = 'no_date')::int                         as no_date,
    count(*) filter (where bucket = 'no_expiry')::int                       as no_expiry,$n$, true),
  (7, 'dept_cert_readiness()', $o$      100.0 * count(*) filter (where bucket = 'current')
      / nullif(count(*) filter (where bucket in ('current','expiring','expired')), 0)$o$,
                               $n$      100.0 * count(*) filter (where bucket in ('current','no_expiry'))
      / nullif(count(*) filter (where bucket in ('current','expiring','expired','no_expiry')), 0)$n$, true),
  -- probation_item_states: a kind='cert' item is current if the matched cert's type never expires
  (8, 'probation_item_states(uuid,uuid)', $o$    left join lateral (select exists (select 1 from public.certs c
                                        where c.member_id = p_member and lower(btrim(c.name)) = lower(btrim(i.cert_name))
                                          and c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                                          and split_part(c.exp, '-', 1)::int * 12 + split_part(c.exp, '-', 2)::int
                                              >= extract(year from td.d)::int * 12 + extract(month from td.d)::int) as current$o$,
                                          $n$    left join lateral (select exists (select 1 from public.certs c
                                        left join public.cert_types t on t.id = c.cert_type_id and t.department_id = p_dept
                                        where c.member_id = p_member and lower(btrim(c.name)) = lower(btrim(i.cert_name))
                                          and (coalesce(t.never_expires, false)   -- cert catalog: a never-expires type is current
                                               or (c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                                                   and split_part(c.exp, '-', 1)::int * 12 + split_part(c.exp, '-', 2)::int
                                                       >= extract(year from td.d)::int * 12 + extract(month from td.d)::int))) as current$n$, true);

  -- every fragment occurs exactly once where it is applied; build each new definition + its expected prosrc
  FOR f IN SELECT DISTINCT fn FROM _sliceA_edits LOOP
    v_def := pg_get_functiondef(('public.' || f)::regprocedure);
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = ('public.' || f)::regprocedure;
    v_srcs := v_srcs || jsonb_build_object(f, v_src);
    FOR e IN SELECT * FROM _sliceA_edits WHERE fn = f ORDER BY ord LOOP
      n := (length(v_def) - length(replace(v_def, e.old_frag, ''))) / length(e.old_frag);
      IF n <> 1 THEN RAISE EXCEPTION 'Precondition failed: edit % (%) anchors % times in the live definition, not once. Nothing changed.', e.ord, f, n; END IF;
      IF e.in_body AND (length(v_src) - length(replace(v_src, e.old_frag, ''))) / length(e.old_frag) <> 1 THEN
        RAISE EXCEPTION 'Precondition failed: edit % (%) is not in the function body exactly once. Nothing changed.', e.ord, f;
      END IF;
      v_def := replace(v_def, e.old_frag, e.new_frag);
      IF e.in_body THEN v_src := replace(v_src, e.old_frag, e.new_frag); END IF;
    END LOOP;
    v_defs := v_defs || jsonb_build_object(f, v_def);
    v_exp_src := v_exp_src || jsonb_build_object(f, v_src);
  END LOOP;

  -- snapshots: every function except the four readers (the four new RPCs don't exist yet), every policy, counts
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT DISTINCT ('public.' || fn)::regprocedure::oid FROM _sliceA_edits);
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;
  -- dept_cert_readiness is re-created: its owner / definer / config / volatility and EXECUTE grantees, to restore + prove
  SELECT p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
    INTO v_dcr_meta FROM pg_proc p WHERE p.oid = 'public.dept_cert_readiness()'::regprocedure;
  SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type, ',' ORDER BY 1)
    INTO v_dcr_acl FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = 'public.dept_cert_readiness()'::regprocedure;

  -- ---------------------------------------------------------------- A1 cert_types
  CREATE TABLE public.cert_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    name text NOT NULL CONSTRAINT cert_types_name_chk CHECK (btrim(name) <> ''),
    never_expires boolean NOT NULL DEFAULT false,
    category text NOT NULL DEFAULT 'certification' CONSTRAINT cert_types_category_chk CHECK (category IN ('certification', 'continuing_education')),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
  );
  CREATE UNIQUE INDEX cert_types_dept_name_uq ON public.cert_types (department_id, lower(btrim(name)));
  ALTER TABLE public.cert_types ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "members read cert_types" ON public.cert_types FOR SELECT TO authenticated USING (department_id = public.my_department_id());

  -- ---------------------------------------------------------------- A2 the link
  ALTER TABLE public.certs ADD COLUMN cert_type_id uuid REFERENCES public.cert_types(id) ON DELETE SET NULL;

  -- ---------------------------------------------------------------- A3 RPCs
  CREATE FUNCTION public.set_cert_type(p_id uuid, p_name text, p_never_expires boolean, p_category text DEFAULT 'certification')
   RETURNS public.cert_types LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:cert catalog — a Department Admin (or PA) adds (p_id NULL) or edits a cert type in their own department.
  declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_name text := btrim(coalesce(p_name, ''));
          v_cat text := coalesce(nullif(btrim(p_category), ''), 'certification'); v_row public.cert_types;
  begin
    if v_dept is null or not coalesce(public.is_dept_admin(), false) then
      raise exception 'Only a Department Admin can manage cert types.';
    end if;
    if v_name = '' then raise exception 'A cert type needs a name.'; end if;
    if v_cat not in ('certification', 'continuing_education') then raise exception 'Unknown category — use certification or continuing_education.'; end if;
    begin
      if p_id is null then
        insert into public.cert_types (department_id, name, never_expires, category, created_by, updated_by)
        values (v_dept, v_name, coalesce(p_never_expires, false), v_cat, v_me, v_me)
        returning * into v_row;
      else
        update public.cert_types
           set name = v_name, never_expires = coalesce(p_never_expires, false), category = v_cat, updated_by = v_me, updated_at = now()
         where id = p_id and department_id = v_dept
        returning * into v_row;
        if not found then raise exception 'That cert type is not in your department.'; end if;
      end if;
    exception when unique_violation then
      raise exception 'Your department already has a cert type named "%".', v_name;
    end;
    return v_row;
  end;
  $fn$;

  CREATE FUNCTION public.delete_cert_type(p_id uuid)
   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:cert catalog — remove a type from your department's catalog. Certs that used it keep their row; the FK
  -- (ON DELETE SET NULL) clears their cert_type_id, so they read exactly as an untyped cert does.
  declare v_dept uuid := public.my_department_id();
  begin
    if v_dept is null or not coalesce(public.is_dept_admin(), false) then
      raise exception 'Only a Department Admin can manage cert types.';
    end if;
    delete from public.cert_types where id = p_id and department_id = v_dept;
    if not found then raise exception 'That cert type is not in your department.'; end if;
  end;
  $fn$;

  CREATE FUNCTION public.dept_cert_types()
   RETURNS TABLE(id uuid, name text, never_expires boolean, category text, cert_count integer, created_at timestamptz, updated_at timestamptz)
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:cert catalog — the caller's department catalog, for any member of it; how many certs use each type. Read-only.
    select t.id, t.name, t.never_expires, t.category,
           (select count(*)::int from public.certs c where c.cert_type_id = t.id and c.department_id = t.department_id),
           t.created_at, t.updated_at
      from public.cert_types t
     where t.department_id = public.my_department_id()
     order by t.category, lower(t.name);
  $fn$;

  CREATE FUNCTION public.assign_cert_type(p_cert_id uuid, p_cert_type_id uuid)
   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:cert catalog — link a cert to a type (or NULL to unlink). The cert AND the type must both be in the caller's
  -- department; a cross-department cert reads "not found", never revealing it exists elsewhere (as update_cert does).
  declare v_dept uuid := public.my_department_id();
  begin
    if v_dept is null or not coalesce(public.is_dept_admin(), false) then
      raise exception 'Only a Department Admin can assign cert types.';
    end if;
    if p_cert_type_id is not null and not exists (select 1 from public.cert_types where id = p_cert_type_id and department_id = v_dept) then
      raise exception 'That cert type is not in your department.';
    end if;
    update public.certs set cert_type_id = p_cert_type_id where id = p_cert_id and department_id = v_dept;
    if not found then raise exception 'Certification not found'; end if;
  end;
  $fn$;

  REVOKE EXECUTE ON FUNCTION public.set_cert_type(uuid, text, boolean, text), public.delete_cert_type(uuid),
                             public.dept_cert_types(), public.assign_cert_type(uuid, uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.set_cert_type(uuid, text, boolean, text), public.delete_cert_type(uuid),
                            public.dept_cert_types(), public.assign_cert_type(uuid, uuid) TO authenticated;

  -- ---------------------------------------------------------------- A4 the four readers
  EXECUTE v_defs ->> 'expiration_rows(uuid,uuid)';
  EXECUTE v_defs ->> 'readiness_window(text,date)';
  EXECUTE v_defs ->> 'probation_item_states(uuid,uuid)';
  DROP FUNCTION public.dept_cert_readiness();
  EXECUTE v_defs ->> 'dept_cert_readiness()';
  -- restore dept_cert_readiness' EXECUTE grants exactly: start from nothing, re-grant each captured grantee
  REVOKE ALL ON FUNCTION public.dept_cert_readiness() FROM PUBLIC;
  FOR g IN SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.oid = 'public.dept_cert_readiness()'::regprocedure AND a.grantee <> p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.dept_cert_readiness() FROM %s', CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.grantee::regrole::text) END);
  END LOOP;
  FOR g IN SELECT split_part(x, ':', 1) AS who FROM unnest(string_to_array(v_dcr_acl, ',')) x
            WHERE split_part(x, ':', 2) = 'EXECUTE' AND split_part(x, ':', 1) <> (SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'public.dept_cert_readiness()'::regprocedure) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.dept_cert_readiness() TO %s', CASE WHEN g.who = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.who) END);
  END LOOP;

  -- ---------------------------------------------------------------- post-conditions
  -- (1) the table, RLS, its one policy, constraints, the unique index; the FK column
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cert_types'::regclass) THEN RAISE EXCEPTION 'Post-condition failed: RLS is off on cert_types.'; END IF;
  IF (SELECT string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cert_types')
     IS DISTINCT FROM 'members read cert_types|SELECT|{authenticated}|(department_id = my_department_id())|' THEN
    RAISE EXCEPTION 'Post-condition failed: cert_types must have exactly one policy — the department-scoped SELECT.';
  END IF;
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid = 'public.cert_types'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
     IS DISTINCT FROM 'id:uuid:true,department_id:uuid:true,name:text:true,never_expires:boolean:true,category:text:true,created_at:timestamp with time zone:true,created_by:uuid:false,updated_at:timestamp with time zone:true,updated_by:uuid:false' THEN
    RAISE EXCEPTION 'Post-condition failed: cert_types columns are not as designed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'cert_types_dept_name_uq'
                  AND indexdef = 'CREATE UNIQUE INDEX cert_types_dept_name_uq ON public.cert_types USING btree (department_id, lower(btrim(name)))') THEN
    RAISE EXCEPTION 'Post-condition failed: the per-department unique name index is missing or different.';
  END IF;
  IF (SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.cert_types'::regclass AND contype = 'c')
     IS DISTINCT FROM 'CHECK ((category = ANY (ARRAY[''certification''::text, ''continuing_education''::text]))) | CHECK ((btrim(name) <> ''''::text))' THEN
    RAISE EXCEPTION 'Post-condition failed: the category / name CHECKs are not as designed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cert_types'::regclass AND contype = 'f'
                  AND pg_get_constraintdef(oid) = 'FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.certs'::regclass AND contype = 'f'
                     AND pg_get_constraintdef(oid) = 'FOREIGN KEY (cert_type_id) REFERENCES cert_types(id) ON DELETE SET NULL') THEN
    RAISE EXCEPTION 'Post-condition failed: a foreign key is missing or different.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'certs' AND column_name = 'cert_type_id' AND data_type = 'uuid' AND is_nullable = 'YES' AND column_default IS NULL)
     OR EXISTS (SELECT 1 FROM public.certs WHERE cert_type_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.cert_types) THEN
    RAISE EXCEPTION 'Post-condition failed: certs.cert_type_id is not a nullable, default-less uuid with every row NULL, or cert_types is not empty.';
  END IF;
  -- (2) each reader = its live body with exactly the listed edits, at its reviewed md5
  FOR f IN SELECT jsonb_object_keys(OLD) LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = ('public.' || f)::regprocedure) IS DISTINCT FROM v_exp_src ->> f THEN
      RAISE EXCEPTION 'Post-condition failed: % differs from its live body by more than the listed edits.', f;
    END IF;
    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> NEW ->> f THEN
      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', f;
    END IF;
  END LOOP;
  IF pg_get_function_result('public.dept_cert_readiness()'::regprocedure)
     <> 'TABLE(current integer, expiring integer, expired integer, no_date integer, no_expiry integer, total_dated integer, pct integer)' THEN
    RAISE EXCEPTION 'Post-condition failed: dept_cert_readiness return shape is not as designed.';
  END IF;
  -- (3) dept_cert_readiness: owner / definer / config / volatility and EXECUTE grantees identical to before the re-create
  IF (SELECT p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')
        FROM pg_proc p WHERE p.oid = 'public.dept_cert_readiness()'::regprocedure) IS DISTINCT FROM v_dcr_meta
     OR (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type, ',' ORDER BY 1)
           FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = 'public.dept_cert_readiness()'::regprocedure) IS DISTINCT FROM v_dcr_acl THEN
    RAISE EXCEPTION 'Post-condition failed: dept_cert_readiness lost or gained a grant (or its owner / definer / config) in the re-create.';
  END IF;
  -- (4) the four new RPCs: definer, search_path pinned, EXECUTE authenticated only (never anon / PUBLIC)
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (NEW_RPCS) AND p.prosecdef
        AND p.proconfig = array['search_path=public'] AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) <> 4 THEN
    RAISE EXCEPTION 'Post-condition failed: a cert-type RPC is not SECURITY DEFINER / search_path public / authenticated-only.';
  END IF;
  -- (5) nothing else moved
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT DISTINCT ('public.' || fn)::regprocedure::oid FROM _sliceA_edits) AND p.proname <> ALL (NEW_RPCS);
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: another public function changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'cert_types';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: an existing policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before + 1 THEN RAISE EXCEPTION 'Post-condition failed: total_policies is not +1.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: cert_types_rls true · cert_types_policies 1 · cert_types_rows 0 · typed_certs 0 · rpcs 4 · readers_ok true ·
--              dcr_anon_exec false · total_policies 170 · locked_token_fns 17)
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cert_types'::regclass) AS cert_types_rls,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cert_types') AS cert_types_policies,
  (SELECT count(*) FROM public.cert_types) AS cert_types_rows,
  (SELECT count(*) FROM public.certs WHERE cert_type_id IS NOT NULL) AS typed_certs,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_cert_type', 'delete_cert_type', 'dept_cert_types', 'assign_cert_type')) AS rpcs,
  (md5(pg_get_functiondef('public.expiration_rows(uuid,uuid)'::regprocedure)) = '27645093a86b7a67dfb04a21d0fca536'
   AND md5(pg_get_functiondef('public.readiness_window(text,date)'::regprocedure)) = 'f3d7788e1ee66a039d46b7e960d1a480'
   AND md5(pg_get_functiondef('public.dept_cert_readiness()'::regprocedure)) = 'd0d54de6a9533e6faa9d0c065c5439df'
   AND md5(pg_get_functiondef('public.probation_item_states(uuid,uuid)'::regprocedure)) = 'c663eb8a6d16905ab7a45b763130388f') AS readers_ok,
  has_function_privilege('anon', 'public.dept_cert_readiness()'::regprocedure, 'EXECUTE') AS dcr_anon_exec,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
