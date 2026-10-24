-- =====================================================================
-- AI DRAFTING — SLICE A (DB): the drill-plan library — DRAFT, not reviewed, not applied.
-- Order: claude/B4C_AIDrafting_SliceA_DB_BuildOrder.md. Built on live (Step 0 read 2026-10-24: 171 policies, 17 locked-
-- token functions, session_plans 39 rows, no function references session_plans, is_canmanage_ops() = DA + Officer).
--
-- THE CHANGE — additive only:
--   1 drill_plans — the department's reusable plan library: title (non-blank), category / audience (free text),
--     duration_min (> 0 when set), content jsonb (must be a JSON OBJECT — inner shape documented, not enforced:
--     { summary, objectives[], run_of_show[{t, d}], materials[], safety[] }), status draft | approved, source ai | manual,
--     created / approved / updated by + at. FK departments ON DELETE CASCADE. RLS on; ONE policy — SELECT to authenticated
--     USING (department_id = my_department_id()); NO write policy (every write is an RPC). Index (department_id, status).
--   2 session_plans.drill_plan_id uuid NULL REFERENCES drill_plans(id) ON DELETE SET NULL — existing rows stay NULL and
--     behave exactly as today. Nothing else on session_plans changes (columns, CHECKs, policies, grants, no index).
--   3 six RPCs — SECURITY DEFINER, search_path public, EXECUTE authenticated only (revoked from PUBLIC + anon):
--       set_drill_plan(p_id, p_title, p_category, p_duration_min, p_audience, p_content, p_source default 'ai')
--           is_canmanage_ops() + my_department_id(). p_id NULL = create (status draft); else edit — keeps status AND source
--           (source records where the plan came from); stamps updated_by / updated_at.
--       approve_drill_plan(p_id)    -> approved, approved_by = me, approved_at = now(). SELF-APPROVAL ALLOWED (Ashlea's
--           call: a lesson plan, not a custody attestation). Already approved -> returns the row unchanged (no re-stamp).
--       unapprove_drill_plan(p_id)  -> draft, approved_by / approved_at cleared. Already draft -> unchanged.
--       delete_drill_plan(p_id)     -> the row goes; the FK clears session_plans.drill_plan_id; those rows are KEPT.
--       dept_drill_plans()          -> any department member: the library + attached_sessions (count of session_plans
--           pointing at it), ordered by status (approved before draft) then updated_at desc.
--       attach_drill_plan_to_session(p_plan_id, p_session_id) -> is_canmanage_ops(); the plan AND the session must be in
--           my_department_id(); dedupe per (session, plan) under a lock on the plan row; inserts a session_plans row:
--           title = the plan's, source = 'ai' (the live CHECK allows only upload | ai | NULL — widening it would touch
--           session_plans), ai_text = the content serialized in the same "## Quick Run Sheet" / "## <title> — Drill Plan"
--           layout serializeDrillPlan writes (so the existing View plan / Print render it with no new code), created_by =
--           the caller's NAME (session_plans.created_by is text; the client stores the name), drill_plan_id = the plan.
-- NOT touched: the session_plans flow (its policies — insert is_canmanage(), update/delete is_canmanage_ops() — CHECKs,
-- grants), the inline "Draft with AI" planner, any gate, any existing function or policy. verified never touched.
--
-- Single all-or-nothing DO block. Refuses a second apply and refuses on drift (gate md5s pinned; session_plans' shape
-- pinned). Post-conditions: the table / RLS / its one policy / CHECKs / FK / index; the session_plans column + FK; each
-- RPC definer + search_path + authenticated-only + its gate + its reviewed md5; session_plans otherwise byte-identical;
-- every other function + policy byte-identical; total_policies +1; the locked-token count unchanged. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  v_sp_before text; v_sp_after text; v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text;
  v_total_before int; v_tok_before int; f text;
  NEW constant jsonb := '{
    "set_drill_plan(uuid,text,text,integer,text,jsonb,text)": "7d7fcbeac484f5be702f9bfde9106195",
    "approve_drill_plan(uuid)": "5bebe24cee1d7edac3a7ae74251b6363",
    "unapprove_drill_plan(uuid)": "dcf77b1911fd2fe2328b57e30c206360",
    "delete_drill_plan(uuid)": "b249789e3cb72fd01544d2cefe51ac6c",
    "dept_drill_plans()": "d786d5593ef494c71549054d85864c8c",
    "attach_drill_plan_to_session(uuid,uuid)": "e3c1abb406d91d5c491483305c43bbaa"
  }';
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.drill_plans') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: public.drill_plans already exists — already applied. Nothing changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('set_drill_plan', 'approve_drill_plan', 'unapprove_drill_plan', 'delete_drill_plan', 'dept_drill_plans', 'attach_drill_plan_to_session')) THEN
    RAISE EXCEPTION 'Precondition failed: a drill-plan RPC already exists. Nothing changed.';
  END IF;
  IF to_regclass('public.session_plans') IS NULL OR to_regclass('public.training_sessions') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: session_plans / training_sessions not found. Nothing changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.session_plans'::regclass AND attname = 'drill_plan_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Precondition failed: session_plans.drill_plan_id already exists. Nothing changed.';
  END IF;
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid = 'public.session_plans'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
     IS DISTINCT FROM 'id:uuid:true,department_id:uuid:true,session_id:uuid:false,title:text:false,source:text:false,storage_path:text:false,ai_text:text:false,created_by:text:false,created_at:timestamp with time zone:true' THEN
    RAISE EXCEPTION 'Precondition failed: session_plans is not the Step 0 shape. Nothing changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.session_plans'::regclass AND conname = 'session_plans_source_check'
                  AND pg_get_constraintdef(oid) = 'CHECK (((source IS NULL) OR (source = ANY (ARRAY[''upload''::text, ''ai''::text]))))') THEN
    RAISE EXCEPTION 'Precondition failed: session_plans_source_check is not the Step 0 CHECK (attach writes source = ''ai''). Nothing changed.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.session_plans'::regclass) THEN
    RAISE EXCEPTION 'Precondition failed: RLS is off on session_plans. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)) <> '92fa180343748968dff96fa044b0420d'
     OR md5(pg_get_functiondef('public.my_department_id()'::regprocedure)) <> '87f546659c3804a943b48e419e017f18'
     OR md5(pg_get_functiondef('public.my_member_id()'::regprocedure)) <> '3f66369c8af7bc07ec59831af6536fee' THEN
    RAISE EXCEPTION 'Precondition failed: is_canmanage_ops() / my_department_id() / my_member_id() drifted from Step 0 (92fa1803… / 87f54665… / 3f66369c…). Nothing changed.';
  END IF;
  IF position('array[''Department Admin'',''Officer'']' in pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: is_canmanage_ops() is not the Department Admin + Officer gate. Nothing changed.';
  END IF;

  -- snapshots: session_plans' whole shape, every function, every policy, counts
  SELECT string_agg(x, E'\n' ORDER BY x) INTO v_sp_before FROM (
    SELECT 'col|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS x
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.session_plans'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL SELECT 'con|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.session_plans'::regclass
    UNION ALL SELECT 'idx|' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'session_plans'
    UNION ALL SELECT 'trg|' || tgname FROM pg_trigger WHERE tgrelid = 'public.session_plans'::regclass AND NOT tgisinternal
    UNION ALL SELECT 'rls|' || relrowsecurity::text || '|' || relforcerowsecurity::text || '|' || coalesce(relacl::text, '') FROM pg_class WHERE oid = 'public.session_plans'::regclass) s;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p');
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;

  -- ---------------------------------------------------------------- 1 the table
  CREATE TABLE public.drill_plans (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    title         text NOT NULL CONSTRAINT drill_plans_title_chk CHECK (btrim(title) <> ''),
    category      text,
    duration_min  int CONSTRAINT drill_plans_duration_chk CHECK (duration_min IS NULL OR duration_min > 0),
    audience      text,
    content       jsonb NOT NULL CONSTRAINT drill_plans_content_chk CHECK (jsonb_typeof(content) = 'object'),
    status        text NOT NULL DEFAULT 'draft' CONSTRAINT drill_plans_status_chk CHECK (status IN ('draft', 'approved')),
    source        text NOT NULL DEFAULT 'ai' CONSTRAINT drill_plans_source_chk CHECK (source IN ('ai', 'manual')),
    created_by    uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    approved_by   uuid,
    approved_at   timestamptz,
    updated_by    uuid,
    updated_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX drill_plans_dept_status_idx ON public.drill_plans (department_id, status);
  ALTER TABLE public.drill_plans ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "members read drill_plans" ON public.drill_plans FOR SELECT TO authenticated USING (department_id = my_department_id());

  -- ---------------------------------------------------------------- 2 the session_plans link
  ALTER TABLE public.session_plans ADD COLUMN drill_plan_id uuid
    CONSTRAINT session_plans_drill_plan_id_fkey REFERENCES public.drill_plans(id) ON DELETE SET NULL;

  -- ---------------------------------------------------------------- 3 the RPCs
  CREATE FUNCTION public.set_drill_plan(p_id uuid, p_title text, p_category text, p_duration_min integer, p_audience text, p_content jsonb, p_source text DEFAULT 'ai')
   RETURNS public.drill_plans LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:drill plans — create (p_id null, as a draft) or edit a plan in the caller's OWN department. Edit keeps status + source.
  declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.drill_plans;
  begin
    if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then
      raise exception 'Only a Department Admin or Officer can manage drill plans.';
    end if;
    if p_title is null or btrim(p_title) = '' then raise exception 'A drill plan needs a title.'; end if;
    if p_content is null or jsonb_typeof(p_content) <> 'object' then raise exception 'A drill plan''s content must be a JSON object.'; end if;
    if p_duration_min is not null and p_duration_min <= 0 then raise exception 'Duration must be a positive number of minutes.'; end if;
    if p_id is null then
      if p_source is null or p_source not in ('ai', 'manual') then raise exception 'A drill plan''s source must be ai or manual.'; end if;
      insert into public.drill_plans (department_id, title, category, duration_min, audience, content, source, created_by, updated_by)
      values (v_dept, btrim(p_title), nullif(btrim(p_category), ''), p_duration_min, nullif(btrim(p_audience), ''), p_content, p_source, v_me, v_me)
      returning * into v_row;
    else
      update public.drill_plans
         set title = btrim(p_title), category = nullif(btrim(p_category), ''), duration_min = p_duration_min,
             audience = nullif(btrim(p_audience), ''), content = p_content, updated_by = v_me, updated_at = now()
       where id = p_id and department_id = v_dept
      returning * into v_row;
      if not found then raise exception 'That drill plan is not in your department.'; end if;
    end if;
    return v_row;
  end;
  $fn$;

  CREATE FUNCTION public.approve_drill_plan(p_id uuid)
   RETURNS public.drill_plans LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:drill plans — approve a plan in the caller's OWN department. Self-approval allowed (a lesson plan, not a custody
  -- attestation). Already approved: returned unchanged.
  declare v_dept uuid := public.my_department_id(); v_row public.drill_plans;
  begin
    if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then
      raise exception 'Only a Department Admin or Officer can approve drill plans.';
    end if;
    select * into v_row from public.drill_plans where id = p_id and department_id = v_dept for update;
    if not found then raise exception 'That drill plan is not in your department.'; end if;
    if v_row.status = 'approved' then return v_row; end if;
    update public.drill_plans set status = 'approved', approved_by = public.my_member_id(), approved_at = now()
     where id = p_id returning * into v_row;
    return v_row;
  end;
  $fn$;

  CREATE FUNCTION public.unapprove_drill_plan(p_id uuid)
   RETURNS public.drill_plans LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:drill plans — pull a plan in the caller's OWN department back to draft. Already a draft: returned unchanged.
  declare v_dept uuid := public.my_department_id(); v_row public.drill_plans;
  begin
    if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then
      raise exception 'Only a Department Admin or Officer can change a drill plan''s approval.';
    end if;
    select * into v_row from public.drill_plans where id = p_id and department_id = v_dept for update;
    if not found then raise exception 'That drill plan is not in your department.'; end if;
    if v_row.status = 'draft' then return v_row; end if;
    update public.drill_plans set status = 'draft', approved_by = null, approved_at = null
     where id = p_id returning * into v_row;
    return v_row;
  end;
  $fn$;

  CREATE FUNCTION public.delete_drill_plan(p_id uuid)
   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:drill plans — delete a plan in the caller's OWN department. The session_plans.drill_plan_id FK (ON DELETE SET
  -- NULL) clears its attachments; the per-session plan rows (and their text) are kept.
  declare v_dept uuid := public.my_department_id();
  begin
    if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then
      raise exception 'Only a Department Admin or Officer can delete drill plans.';
    end if;
    delete from public.drill_plans where id = p_id and department_id = v_dept;
    if not found then raise exception 'That drill plan is not in your department.'; end if;
  end;
  $fn$;

  CREATE FUNCTION public.dept_drill_plans()
   RETURNS TABLE (id uuid, title text, category text, duration_min integer, audience text, content jsonb, status text, source text,
                  created_by uuid, created_at timestamptz, approved_by uuid, approved_at timestamptz, updated_by uuid, updated_at timestamptz,
                  attached_sessions integer)
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:drill plans — the caller's department library (any member), with how many session plans point at each.
  select p.id, p.title, p.category, p.duration_min, p.audience, p.content, p.status, p.source,
         p.created_by, p.created_at, p.approved_by, p.approved_at, p.updated_by, p.updated_at,
         (select count(*)::int from public.session_plans sp where sp.drill_plan_id = p.id and sp.department_id = p.department_id)
    from public.drill_plans p
   where p.department_id = public.my_department_id()
   order by p.status, p.updated_at desc, p.title;
  $fn$;

  CREATE FUNCTION public.attach_drill_plan_to_session(p_plan_id uuid, p_session_id uuid)
   RETURNS public.session_plans LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:drill plans — attach a library plan to a training session in the caller's OWN department, as an ordinary
  -- session_plans row (the existing View plan renders its ai_text). One attachment per (session, plan).
  declare v_dept uuid := public.my_department_id(); v_p public.drill_plans; v_row public.session_plans;
          v_c jsonb; v_who text; L text[] := array[]::text[]; s jsonb; i int := 0;
  begin
    if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then
      raise exception 'Only a Department Admin or Officer can attach drill plans.';
    end if;
    select * into v_p from public.drill_plans where id = p_plan_id and department_id = v_dept for update;
    if not found then raise exception 'That drill plan is not in your department.'; end if;
    if not exists (select 1 from public.training_sessions where id = p_session_id and department_id = v_dept) then
      raise exception 'That session is not in your department.';
    end if;
    if exists (select 1 from public.session_plans where session_id = p_session_id and drill_plan_id = p_plan_id) then
      raise exception 'That plan is already attached to this session.';
    end if;
    v_c := v_p.content;
    -- the Quick Run Sheet, then the full plan — the layout serializeDrillPlan writes and the plan viewer splits on
    L := L || '## Quick Run Sheet'::text;
    if v_p.duration_min is not null then L := L || ''::text || ('Total time: ' || v_p.duration_min || ' min'); end if;
    if jsonb_typeof(v_c -> 'run_of_show') = 'array' then
      for s in select x from jsonb_array_elements(v_c -> 'run_of_show') x loop
        i := i + 1;
        if jsonb_typeof(s) = 'object' then
          L := L || ''::text || ('**' || i || '. ' || coalesce(nullif(s ->> 't', ''), 'Step') || '**');
          if coalesce(s ->> 'd', '') <> '' then L := L || ('- ' || (s ->> 'd')); end if;
        else
          L := L || ''::text || ('**' || i || '. ' || (s #>> '{}') || '**');
        end if;
      end loop;
    end if;
    if jsonb_typeof(v_c -> 'safety') = 'array' and jsonb_array_length(v_c -> 'safety') > 0 then
      L := L || ''::text || '**Safety first:**'::text || array(select '- ' || (x #>> '{}') from jsonb_array_elements(v_c -> 'safety') x);
    end if;
    L := L || ''::text || ('## ' || v_p.title || ' — Drill Plan');
    if coalesce(v_c ->> 'summary', '') <> '' then L := L || ''::text || (v_c ->> 'summary'); end if;
    if v_p.duration_min is not null then L := L || ''::text || ('Duration: ' || v_p.duration_min || ' minutes'); end if;
    if jsonb_typeof(v_c -> 'objectives') = 'array' and jsonb_array_length(v_c -> 'objectives') > 0 then
      L := L || ''::text || '## Objectives'::text || array(select '- ' || (x #>> '{}') from jsonb_array_elements(v_c -> 'objectives') x);
    end if;
    if jsonb_typeof(v_c -> 'safety') = 'array' and jsonb_array_length(v_c -> 'safety') > 0 then
      L := L || ''::text || '## Safety notes'::text || array(select '- ' || (x #>> '{}') from jsonb_array_elements(v_c -> 'safety') x);
    end if;
    if jsonb_typeof(v_c -> 'materials') = 'array' and jsonb_array_length(v_c -> 'materials') > 0 then
      L := L || ''::text || '## Equipment'::text || array(select '- ' || (x #>> '{}') from jsonb_array_elements(v_c -> 'materials') x);
    end if;
    select name into v_who from public.members where id = public.my_member_id();
    insert into public.session_plans (department_id, session_id, title, source, ai_text, created_by, drill_plan_id)
    values (v_dept, p_session_id, v_p.title, 'ai', array_to_string(L, E'\n'), coalesce(v_who, 'Unknown'), p_plan_id)
    returning * into v_row;
    return v_row;
  end;
  $fn$;

  REVOKE EXECUTE ON FUNCTION public.set_drill_plan(uuid, text, text, integer, text, jsonb, text), public.approve_drill_plan(uuid),
                             public.unapprove_drill_plan(uuid), public.delete_drill_plan(uuid), public.dept_drill_plans(),
                             public.attach_drill_plan_to_session(uuid, uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.set_drill_plan(uuid, text, text, integer, text, jsonb, text), public.approve_drill_plan(uuid),
                            public.unapprove_drill_plan(uuid), public.delete_drill_plan(uuid), public.dept_drill_plans(),
                            public.attach_drill_plan_to_session(uuid, uuid) TO authenticated;

  -- ---------------------------------------------------------------- post-conditions
  -- (1) the table
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid = 'public.drill_plans'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
     IS DISTINCT FROM 'id:uuid:true,department_id:uuid:true,title:text:true,category:text:false,duration_min:integer:false,audience:text:false,content:jsonb:true,status:text:true,source:text:true,created_by:uuid:false,created_at:timestamp with time zone:true,approved_by:uuid:false,approved_at:timestamp with time zone:false,updated_by:uuid:false,updated_at:timestamp with time zone:true' THEN
    RAISE EXCEPTION 'Post-condition failed: drill_plans columns are not as designed.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.drill_plans'::regclass) THEN RAISE EXCEPTION 'Post-condition failed: RLS is off on drill_plans.'; END IF;
  IF (SELECT string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drill_plans')
     IS DISTINCT FROM 'members read drill_plans|SELECT|{authenticated}|(department_id = my_department_id())|' THEN
    RAISE EXCEPTION 'Post-condition failed: drill_plans must have exactly one policy — SELECT, authenticated, own department.';
  END IF;
  IF (SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass AND contype IN ('c', 'f'))
     IS DISTINCT FROM 'CHECK ((jsonb_typeof(content) = ''object''::text)) | FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE | CHECK (((duration_min IS NULL) OR (duration_min > 0))) | CHECK ((source = ANY (ARRAY[''ai''::text, ''manual''::text]))) | CHECK ((status = ANY (ARRAY[''draft''::text, ''approved''::text]))) | CHECK ((btrim(title) <> ''''::text))' THEN
    RAISE EXCEPTION 'Post-condition failed: drill_plans CHECKs / FK are not as designed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'drill_plans_dept_status_idx'
                  AND indexdef = 'CREATE INDEX drill_plans_dept_status_idx ON public.drill_plans USING btree (department_id, status)') THEN
    RAISE EXCEPTION 'Post-condition failed: the (department_id, status) index is missing or different.';
  END IF;
  -- (2) the session_plans link: nullable uuid, FK ON DELETE SET NULL, readable / writable by authenticated under RLS like the rest
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.session_plans'::regclass AND attname = 'drill_plan_id' AND NOT attisdropped
                  AND atttypid = 'uuid'::regtype AND NOT attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.session_plans'::regclass AND conname = 'session_plans_drill_plan_id_fkey'
                     AND pg_get_constraintdef(oid) = 'FOREIGN KEY (drill_plan_id) REFERENCES drill_plans(id) ON DELETE SET NULL')
     OR NOT has_column_privilege('authenticated', 'public.session_plans', 'drill_plan_id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.session_plans', 'drill_plan_id', 'INSERT') THEN
    RAISE EXCEPTION 'Post-condition failed: session_plans.drill_plan_id is not a nullable uuid FK (ON DELETE SET NULL) with the table''s grants.';
  END IF;
  SELECT string_agg(x, E'\n' ORDER BY x) INTO v_sp_after FROM (
    SELECT 'col|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS x
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.session_plans'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'drill_plan_id'
    UNION ALL SELECT 'con|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.session_plans'::regclass AND conname <> 'session_plans_drill_plan_id_fkey'
    UNION ALL SELECT 'idx|' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'session_plans'
    UNION ALL SELECT 'trg|' || tgname FROM pg_trigger WHERE tgrelid = 'public.session_plans'::regclass AND NOT tgisinternal
    UNION ALL SELECT 'rls|' || relrowsecurity::text || '|' || relforcerowsecurity::text || '|' || coalesce(relacl::text, '') FROM pg_class WHERE oid = 'public.session_plans'::regclass) s;
  IF v_sp_after IS DISTINCT FROM v_sp_before THEN RAISE EXCEPTION 'Post-condition failed: session_plans changed beyond the drill_plan_id column + its FK.'; END IF;
  -- (3) the RPCs: definer, search_path pinned, authenticated-only, gated, own department, and the reviewed bodies
  FOR f IN SELECT jsonb_object_keys(NEW) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ('public.' || f)::regprocedure AND p.prosecdef AND p.proconfig = array['search_path=public']
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
      RAISE EXCEPTION 'Post-condition failed: % is not SECURITY DEFINER / search_path public / authenticated-only.', f;
    END IF;
    IF position('public.my_department_id()' in pg_get_functiondef(('public.' || f)::regprocedure)) = 0
       OR (f <> 'dept_drill_plans()' AND position('coalesce(public.is_canmanage_ops(), false)' in pg_get_functiondef(('public.' || f)::regprocedure)) = 0) THEN
      RAISE EXCEPTION 'Post-condition failed: % is not gated on is_canmanage_ops() and scoped to my_department_id().', f;
    END IF;
    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> NEW ->> f THEN
      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', f;
    END IF;
  END LOOP;
  -- (4) nothing else moved
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.proname NOT IN ('set_drill_plan', 'approve_drill_plan', 'unapprove_drill_plan', 'delete_drill_plan', 'dept_drill_plans', 'attach_drill_plan_to_session');
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: an existing public function (or its grants) changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'drill_plans';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: an existing policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before + 1 THEN RAISE EXCEPTION 'Post-condition failed: total_policies is not +1.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: dp_rls true · dp_policies 1 · dp_rows 0 · link true · rpcs_ok 6 · sp_rows unchanged (39 at Step 0) ·
--              sp_linked 0 · total_policies 172 · locked_token_fns 17)
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.drill_plans'::regclass) AS dp_rls,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drill_plans') AS dp_policies,
  (SELECT count(*) FROM public.drill_plans) AS dp_rows,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.session_plans'::regclass AND conname = 'session_plans_drill_plan_id_fkey') AS link,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
      AND proname IN ('set_drill_plan', 'approve_drill_plan', 'unapprove_drill_plan', 'delete_drill_plan', 'dept_drill_plans', 'attach_drill_plan_to_session')
      AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) AS rpcs_ok,
  (SELECT count(*) FROM public.session_plans) AS sp_rows,
  (SELECT count(*) FROM public.session_plans WHERE drill_plan_id IS NOT NULL) AS sp_linked,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
