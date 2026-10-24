-- =====================================================================
-- TRAINING OVERHAUL · SLICE 1 (DB): the Training Officers registry — Review PASS (ba051e3). APPLIED on live 2026-10-24; state row:
-- to_rls true · to_policies 1 · seeded 8 (Indian Harbor 1 · Lipan 2 · North Hood 5) · gate_fns 4 · repointed 13 · canmanage_ops_md5 92fa1803 ·
-- total_policies 173 · locked_token_fns 17.
-- Order: claude/B4C_TrainingOverhaul_Slice1_TrainingOfficers_BuildOrder.md · Step 0 PASS:
-- claude/B4C_TrainingOverhaul_Slice1_TrainingOfficers_Step0_ReviewRecord.md (decisions 1–8 locked). Built on live
-- (Step 0 read 2026-10-24: 172 policies, 17 locked-token functions — docs/review/training_officers_STEP0_OUTPUT.json).
--
-- THE CHANGE:
--   1 training_officer — the per-department registry, equipment_manager's columns 1:1 (+ a department FK): history model,
--     one ACTIVE row per (department, member) by a partial unique index; RLS on; ONE policy — SELECT to authenticated,
--     own department; no write policy (writes via the two RPCs).
--   2 is_training_officer() — an active row for my_member_id() IN my_department_id(). Department-scoped on purpose: the
--     live is_equipment_manager() is not (flagged in Step 0, untouched here).
--   3 is_training_manager() — THE training gate: a Department Admin in my_department_id() (NOT is_dept_admin(): that
--     admits Project Admin — decision 1) OR is_training_officer().
--   4 assign_training_officer(p_member_id) / remove_training_officer(p_member_id) — is_dept_admin() (DA + PA may APPOINT —
--     decision 6); the target must be an Active / Probationary member of the caller's department; history model with
--     friendly no-ops (assigning an active officer returns that row; removing a non-officer returns NULL — decision 7).
--   5 THE 13 REPOINTS — is_canmanage_ops() -> is_training_manager(), nothing else:
--       policies (ALTER POLICY, same name / command / roles): training_sessions INSERT + UPDATE · training_plans INSERT +
--         UPDATE · session_attendance INSERT + DELETE · session_plans UPDATE + DELETE
--       functions (re-created from their LIVE bodies): set_drill_plan · approve_drill_plan · unapprove_drill_plan ·
--         delete_drill_plan · attach_drill_plan_to_session — the gate token, and "a Department Admin or Officer" ->
--         "a Department Admin or training officer" in the refusal text.
--     One gate for everything (decision 8): meetings and leadership / board events are training_sessions rows, so they
--     follow too.
--   6 THE SEED (decision 5) — every Active / Probationary Officer who is not a Department Admin becomes an active training
--     officer of their department (assigned_by NULL, 'Migration seed (was Officer)'), so deploy day changes nothing.
--     Step 0 counted 8 (North Hood 5 · Lipan 2 · Indian Harbor 1); the block seeds whatever the live count is and the
--     state check reports it.
-- NOT touched: is_canmanage_ops() (54 users — pinned byte-identical before AND after), every other function and policy,
-- the delete policies (is_dept_admin()), session_plans INSERT (is_canmanage() — Slice 3), the QR sign-in functions
-- (decision 3), is_equipment_manager(), qualifications. verified never touched.
--
-- Single all-or-nothing DO block. Preconditions refuse a second apply and refuse on drift (gate md5s, the five drill-plan
-- bodies, the eight policy expressions). Post-conditions: the table / RLS / its one policy / FKs / indexes; the four new
-- functions definer + search_path + authenticated-only + reviewed md5; each of the 13 equals its PRE-IMAGE with exactly
-- the gate swap applied (and the five functions' reviewed md5s); is_canmanage_ops() unchanged; every OTHER function,
-- policy and training-table trigger byte-identical; total_policies +1; the locked-token count unchanged; the seed equals
-- the qualifying Officers exactly. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_trg_before text; v_trg_after text;
  v_total_before int; v_tok_before int; v_seed_expect int; v_seed_got int; r record; f text; v_def text;
  -- the 13: eight policies (table, name, live md5 of coalesce(qual,'')||'|'||coalesce(with_check,'')) ...
  POL constant jsonb := '[
    ["training_sessions",  "leaders write training_sessions",   "b947f8c7b75dfb475030a11f44914d8a"],
    ["training_sessions",  "leaders update training_sessions",  "073b3fa400695fbd3e7ed1659546af8a"],
    ["training_plans",     "leaders write training_plans",      "b947f8c7b75dfb475030a11f44914d8a"],
    ["training_plans",     "leaders update training_plans",     "073b3fa400695fbd3e7ed1659546af8a"],
    ["session_attendance", "leaders insert session_attendance", "9ca04447b06154c625bda3567aab1567"],
    ["session_attendance", "leaders delete session_attendance", "0293eb3bd2b59b3c720b95821a0d6343"],
    ["session_plans",      "canmanage update session_plans",    "073b3fa400695fbd3e7ed1659546af8a"],
    ["session_plans",      "canmanage delete session_plans",    "c8803153ab847764f52a09f820623d7a"]
  ]';
  -- ... and five functions: live md5 (= Slice A's reviewed pins) -> reviewed md5 after the swap
  FNS constant jsonb := '{
    "set_drill_plan(uuid,text,text,integer,text,jsonb,text)": ["7d7fcbeac484f5be702f9bfde9106195", "f574003f5c6905d120fd6365a1b7ce11"],
    "approve_drill_plan(uuid)":                               ["5bebe24cee1d7edac3a7ae74251b6363", "a01c872bc14561fcb633796353a4b694"],
    "unapprove_drill_plan(uuid)":                             ["dcf77b1911fd2fe2328b57e30c206360", "6012d001e95c3a5d6bdd0f6a49e8daf0"],
    "delete_drill_plan(uuid)":                                ["b249789e3cb72fd01544d2cefe51ac6c", "fc5a12df02bf1216815c361f985aaa1b"],
    "attach_drill_plan_to_session(uuid,uuid)":                ["e3c1abb406d91d5c491483305c43bbaa", "62590b6a9006b28cd009f70e6a11327d"]
  }';
  NEWFNS constant jsonb := '{
    "is_training_officer()": "248392a51fe913771f725b2a51013302",
    "is_training_manager()": "472b87b0abca586ba0a13cd615b376fe",
    "assign_training_officer(uuid)": "5d98ae4b1aa67846e3c6c131102a6418",
    "remove_training_officer(uuid)": "327fd3c832d93b8ac41e762d912baea8"
  }';
  GATE_OLD constant text := 'is_canmanage_ops()';
  GATE_NEW constant text := 'is_training_manager()';
  v_pre jsonb := '{}';   -- the 13 objects' pre-images, keyed
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.training_officer') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: public.training_officer already exists — already applied. Nothing changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('is_training_officer', 'is_training_manager', 'assign_training_officer', 'remove_training_officer')) THEN
    RAISE EXCEPTION 'Precondition failed: a training-officer function already exists. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)) <> '92fa180343748968dff96fa044b0420d'
     OR md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) <> 'c692e44f62923d2bf4c1a39a21a87bf7'
     OR md5(pg_get_functiondef('public.my_department_id()'::regprocedure)) <> '87f546659c3804a943b48e419e017f18'
     OR md5(pg_get_functiondef('public.my_member_id()'::regprocedure)) <> '3f66369c8af7bc07ec59831af6536fee'
     OR md5(pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) <> 'c4d54ae10cb936dcc5f185ae38ec5fcd' THEN
    RAISE EXCEPTION 'Precondition failed: a pinned gate drifted from Step 0 (is_canmanage_ops 92fa1803… / is_dept_admin c692e44f… / my_department_id 87f54665… / my_member_id 3f66369c… / is_equipment_manager c4d54ae1…). Nothing changed.';
  END IF;
  FOR f IN SELECT jsonb_object_keys(FNS) LOOP
    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> FNS -> f ->> 0 THEN
      RAISE EXCEPTION 'Precondition failed: % drifted from its Slice A body (md5 %). Nothing changed.', f, left(FNS -> f ->> 0, 8);
    END IF;
    IF (SELECT count(*) FROM regexp_matches(pg_get_functiondef(('public.' || f)::regprocedure), 'coalesce\(public\.is_canmanage_ops\(\), false\)', 'g')) <> 1 THEN
      RAISE EXCEPTION 'Precondition failed: % does not carry exactly one is_canmanage_ops() gate. Nothing changed.', f;
    END IF;
    v_pre := v_pre || jsonb_build_object('fn:' || f, pg_get_functiondef(('public.' || f)::regprocedure));
  END LOOP;
  FOR r IN SELECT x ->> 0 AS t, x ->> 1 AS n, x ->> 2 AS m FROM jsonb_array_elements(POL) x LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.t AND p.policyname = r.n
                    AND p.roles = '{authenticated}' AND md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) = r.m) THEN
      RAISE EXCEPTION 'Precondition failed: policy "%" on % is missing or drifted from Step 0. Nothing changed.', r.n, r.t;
    END IF;
    v_pre := v_pre || (SELECT jsonb_build_object('pol:' || r.t || '.' || r.n, jsonb_build_array(p.cmd, p.roles::text, p.qual, p.with_check))
                         FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.t AND p.policyname = r.n);
  END LOOP;

  -- snapshots: every function (md5 + grants), every policy, the training tables' triggers, counts
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND NOT (p.oid::regprocedure::text = ANY (ARRAY(SELECT jsonb_object_keys(FNS))));
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(POL) x WHERE x ->> 0 = tablename AND x ->> 1 = policyname);
  SELECT string_agg(c.relname || '.' || t.tgname || '|' || t.tgfoid::regprocedure::text || '|' || t.tgenabled::text, E'\n' ORDER BY c.relname, t.tgname)
    INTO v_trg_before FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('training_sessions', 'training_plans', 'session_attendance', 'session_plans', 'drill_plans');
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;
  SELECT count(*) INTO v_seed_expect FROM public.members m
   WHERE m.status IN ('Active', 'Probationary') AND m.access && array['Officer']::text[] AND NOT m.access && array['Department Admin']::text[];

  -- ---------------------------------------------------------------- 1 the registry
  CREATE TABLE public.training_officer (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id   uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    member_id       uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    assigned_by     uuid REFERENCES public.members(id) ON DELETE SET NULL,
    assigned_by_name text,
    assigned_at     timestamptz NOT NULL DEFAULT now(),
    removed_at      timestamptz,
    removed_by      uuid REFERENCES public.members(id) ON DELETE SET NULL,
    removed_by_name text
  );
  CREATE INDEX training_officer_dept_active_idx ON public.training_officer (department_id) WHERE removed_at IS NULL;
  CREATE UNIQUE INDEX training_officer_one_active_per_member ON public.training_officer (department_id, member_id) WHERE removed_at IS NULL;
  ALTER TABLE public.training_officer ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "members read training officers" ON public.training_officer FOR SELECT TO authenticated USING (department_id = my_department_id());

  -- ---------------------------------------------------------------- 2 + 3 the gates
  CREATE FUNCTION public.is_training_officer()
   RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:training officers — an ACTIVE registry row for the caller's member row in the caller's department. Department-scoped
  -- (unlike is_equipment_manager()): an officer of one department is not one in another.
    select exists (
      select 1 from public.training_officer t
       where t.member_id = public.my_member_id()
         and t.department_id = public.my_department_id()
         and t.removed_at is null
    );
  $fn$;

  CREATE FUNCTION public.is_training_manager()
   RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:training officers — THE training-management gate: a Department Admin in the caller's department (not Project Admin —
  -- deliberately not is_dept_admin()) OR an active training officer there. Schedules / edits / completes / reopens sessions
  -- (meetings and board events included), marks the roster, manages categories and the drill-plan library.
    select exists (
      select 1 from public.members m
       where lower(m.email) = lower(auth.email())
         and m.status in ('Active','Probationary')
         and m.department_id = public.my_department_id()
         and m.access && array['Department Admin']::text[]
    ) or public.is_training_officer();
  $fn$;

  -- ---------------------------------------------------------------- 4 assign / remove
  CREATE FUNCTION public.assign_training_officer(p_member_id uuid)
   RETURNS public.training_officer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:training officers — a Department Admin (or Project Admin) designates a member of their OWN department. History model:
  -- a new row per assignment; an already-active officer is returned unchanged (no error on a double tap).
  declare v_actor public.members; v_target public.members; v_row public.training_officer;
  begin
    select * into v_actor from public.members where id = public.my_member_id();
    if v_actor.id is null then raise exception 'No member record for the signed-in user.'; end if;
    if not coalesce(public.is_dept_admin(), false) then
      raise exception 'Only a Department Admin can assign training officers.';
    end if;
    select * into v_target from public.members
     where id = p_member_id and department_id = v_actor.department_id and status in ('Active','Probationary');
    if v_target.id is null then raise exception 'That member is not an active member of your department.'; end if;
    select * into v_row from public.training_officer
     where department_id = v_actor.department_id and member_id = p_member_id and removed_at is null;
    if v_row.id is not null then return v_row; end if;
    begin
      insert into public.training_officer (department_id, member_id, assigned_by, assigned_by_name, assigned_at)
      values (v_actor.department_id, p_member_id, v_actor.id, v_actor.name, now())
      returning * into v_row;
    exception when unique_violation then   -- a concurrent assign won: return its row
      select * into v_row from public.training_officer
       where department_id = v_actor.department_id and member_id = p_member_id and removed_at is null;
    end;
    return v_row;
  end;
  $fn$;

  CREATE FUNCTION public.remove_training_officer(p_member_id uuid)
   RETURNS public.training_officer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:training officers — end a member's active designation in the caller's OWN department (stamped, kept as history).
  -- Not an active officer there: returns NULL (no error on a double tap).
  declare v_actor public.members; v_row public.training_officer;
  begin
    select * into v_actor from public.members where id = public.my_member_id();
    if v_actor.id is null then raise exception 'No member record for the signed-in user.'; end if;
    if not coalesce(public.is_dept_admin(), false) then
      raise exception 'Only a Department Admin can remove training officers.';
    end if;
    select * into v_row from public.training_officer
     where department_id = v_actor.department_id and member_id = p_member_id and removed_at is null
     for update;
    if v_row.id is null then return null; end if;
    update public.training_officer
       set removed_at = now(), removed_by = v_actor.id, removed_by_name = v_actor.name
     where id = v_row.id
    returning * into v_row;
    return v_row;
  end;
  $fn$;

  REVOKE EXECUTE ON FUNCTION public.is_training_officer(), public.is_training_manager(),
                             public.assign_training_officer(uuid), public.remove_training_officer(uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.is_training_officer(), public.is_training_manager(),
                            public.assign_training_officer(uuid), public.remove_training_officer(uuid) TO authenticated;

  -- ---------------------------------------------------------------- 5 the 13 repoints (from the live text; one token each)
  FOR r IN SELECT p.tablename AS t, p.policyname AS n, p.cmd, p.qual, p.with_check
             FROM pg_policies p JOIN jsonb_array_elements(POL) x ON x ->> 0 = p.tablename AND x ->> 1 = p.policyname
            WHERE p.schemaname = 'public' LOOP
    IF r.cmd = 'INSERT' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', r.n, r.t, replace(r.with_check, GATE_OLD, GATE_NEW));
    ELSIF r.cmd = 'DELETE' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', r.n, r.t, replace(r.qual, GATE_OLD, GATE_NEW));
    ELSE
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s) WITH CHECK (%s)', r.n, r.t, replace(r.qual, GATE_OLD, GATE_NEW), replace(r.with_check, GATE_OLD, GATE_NEW));
    END IF;
  END LOOP;
  FOR f IN SELECT jsonb_object_keys(FNS) LOOP
    v_def := replace(replace(v_pre ->> ('fn:' || f), 'coalesce(public.is_canmanage_ops(), false)', 'coalesce(public.is_training_manager(), false)'),
                     'a Department Admin or Officer', 'a Department Admin or training officer');
    EXECUTE v_def;   -- CREATE OR REPLACE from the live body: grants, definer and search_path are kept
  END LOOP;

  -- ---------------------------------------------------------------- 6 the seed
  INSERT INTO public.training_officer (department_id, member_id, assigned_by, assigned_by_name, assigned_at)
  SELECT m.department_id, m.id, NULL, 'Migration seed (was Officer)', now()
    FROM public.members m
   WHERE m.status IN ('Active', 'Probationary') AND m.access && array['Officer']::text[] AND NOT m.access && array['Department Admin']::text[];

  -- ---------------------------------------------------------------- post-conditions
  -- (1) the registry
  IF (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid = 'public.training_officer'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
     IS DISTINCT FROM 'id:uuid:true,department_id:uuid:true,member_id:uuid:true,assigned_by:uuid:false,assigned_by_name:text:false,assigned_at:timestamp with time zone:true,removed_at:timestamp with time zone:false,removed_by:uuid:false,removed_by_name:text:false' THEN
    RAISE EXCEPTION 'Post-condition failed: training_officer columns are not as designed.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.training_officer'::regclass) THEN RAISE EXCEPTION 'Post-condition failed: RLS is off on training_officer.'; END IF;
  IF (SELECT string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_officer')
     IS DISTINCT FROM 'members read training officers|SELECT|{authenticated}|(department_id = my_department_id())|' THEN
    RAISE EXCEPTION 'Post-condition failed: training_officer must have exactly one policy — SELECT, authenticated, own department.';
  END IF;
  IF (SELECT string_agg(pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.training_officer'::regclass AND contype = 'f')
     IS DISTINCT FROM 'FOREIGN KEY (assigned_by) REFERENCES members(id) ON DELETE SET NULL | FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE | FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE | FOREIGN KEY (removed_by) REFERENCES members(id) ON DELETE SET NULL' THEN
    RAISE EXCEPTION 'Post-condition failed: training_officer foreign keys are not as designed.';
  END IF;
  IF (SELECT string_agg(indexdef, ' | ' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'training_officer' AND indexname <> 'training_officer_pkey')
     IS DISTINCT FROM 'CREATE INDEX training_officer_dept_active_idx ON public.training_officer USING btree (department_id) WHERE (removed_at IS NULL) | CREATE UNIQUE INDEX training_officer_one_active_per_member ON public.training_officer USING btree (department_id, member_id) WHERE (removed_at IS NULL)' THEN
    RAISE EXCEPTION 'Post-condition failed: training_officer indexes are not as designed (the one-active-per-member guard?).';
  END IF;
  -- (2) the four new functions: definer, search_path, authenticated-only, the reviewed bodies
  FOR f IN SELECT jsonb_object_keys(NEWFNS) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ('public.' || f)::regprocedure AND p.prosecdef AND p.proconfig = array['search_path=public']
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) THEN
      RAISE EXCEPTION 'Post-condition failed: % is not SECURITY DEFINER / search_path public / authenticated-only.', f;
    END IF;
    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> NEWFNS ->> f THEN
      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', f;
    END IF;
  END LOOP;
  -- (3) the 13: each is EXACTLY its pre-image with the gate swapped — and no longer mentions is_canmanage_ops()
  FOR r IN SELECT x ->> 0 AS t, x ->> 1 AS n FROM jsonb_array_elements(POL) x LOOP
    IF (SELECT jsonb_build_array(p.cmd, p.roles::text, p.qual, p.with_check) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.t AND p.policyname = r.n)
       IS DISTINCT FROM (SELECT jsonb_build_array(e ->> 0, e ->> 1, replace(e ->> 2, GATE_OLD, GATE_NEW), replace(e ->> 3, GATE_OLD, GATE_NEW)) FROM (SELECT v_pre -> ('pol:' || r.t || '.' || r.n) AS e) s)
       OR (SELECT position(GATE_OLD in coalesce(p.qual, '') || coalesce(p.with_check, '')) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.t AND p.policyname = r.n) <> 0 THEN
      RAISE EXCEPTION 'Post-condition failed: policy "%" on % is not exactly its pre-image with is_canmanage_ops() -> is_training_manager().', r.n, r.t;
    END IF;
  END LOOP;
  FOR f IN SELECT jsonb_object_keys(FNS) LOOP
    IF pg_get_functiondef(('public.' || f)::regprocedure)
       IS DISTINCT FROM replace(replace(v_pre ->> ('fn:' || f), 'coalesce(public.is_canmanage_ops(), false)', 'coalesce(public.is_training_manager(), false)'),
                                'a Department Admin or Officer', 'a Department Admin or training officer')
       OR position(GATE_OLD in pg_get_functiondef(('public.' || f)::regprocedure)) <> 0
       OR md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> FNS -> f ->> 1 THEN
      RAISE EXCEPTION 'Post-condition failed: % is not exactly its live body with the gate swapped (or not its reviewed md5).', f;
    END IF;
  END LOOP;
  -- (4) is_canmanage_ops() byte-identical; nothing else moved
  IF md5(pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)) <> '92fa180343748968dff96fa044b0420d' THEN
    RAISE EXCEPTION 'Post-condition failed: is_canmanage_ops() changed.';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND NOT (p.oid::regprocedure::text = ANY (ARRAY(SELECT jsonb_object_keys(FNS))))
     AND NOT (p.oid::regprocedure::text = ANY (ARRAY(SELECT jsonb_object_keys(NEWFNS))));
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: a function outside the 13 (or its grants) changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'training_officer'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(POL) x WHERE x ->> 0 = tablename AND x ->> 1 = policyname);
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy outside the 13 changed.'; END IF;
  SELECT string_agg(c.relname || '.' || t.tgname || '|' || t.tgfoid::regprocedure::text || '|' || t.tgenabled::text, E'\n' ORDER BY c.relname, t.tgname)
    INTO v_trg_after FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('training_sessions', 'training_plans', 'session_attendance', 'session_plans', 'drill_plans');
  IF v_trg_after IS DISTINCT FROM v_trg_before THEN RAISE EXCEPTION 'Post-condition failed: a training-table trigger changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before + 1 THEN RAISE EXCEPTION 'Post-condition failed: total_policies is not +1.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
  -- (5) the seed: exactly the qualifying Officers, each active in their own department
  SELECT count(*) INTO v_seed_got FROM public.training_officer t JOIN public.members m ON m.id = t.member_id AND m.department_id = t.department_id
   WHERE t.removed_at IS NULL AND t.assigned_by_name = 'Migration seed (was Officer)';
  IF v_seed_got <> v_seed_expect OR (SELECT count(*) FROM public.training_officer) <> v_seed_expect THEN
    RAISE EXCEPTION 'Post-condition failed: seeded % training officers, expected % (active Officers who are not Department Admins).', v_seed_got, v_seed_expect;
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: to_rls true · to_policies 1 · seeded 8 (North Hood 5 · Lipan 2 · Indian Harbor 1, or the live count of
--              active non-DA Officers) · gate_fns 4 · repointed 13 · canmanage_ops_md5 92fa1803… · total_policies 173 ·
--              locked_token_fns 17)
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.training_officer'::regclass) AS to_rls,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_officer') AS to_policies,
  (SELECT count(*) FROM public.training_officer WHERE removed_at IS NULL) AS seeded,
  (SELECT string_agg(d.name || ' ' || n, ' · ' ORDER BY d.name) FROM (SELECT department_id, count(*) AS n FROM public.training_officer WHERE removed_at IS NULL GROUP BY department_id) s
     JOIN public.departments d ON d.id = s.department_id) AS seeded_by_dept,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
      AND proname IN ('is_training_officer', 'is_training_manager', 'assign_training_officer', 'remove_training_officer')
      AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) AS gate_fns,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%is_training_manager()%')
   + (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position('coalesce(public.is_training_manager(), false)' in prosrc) > 0) AS repointed,
  left(md5(pg_get_functiondef('public.is_canmanage_ops()'::regprocedure)), 8) AS canmanage_ops_md5,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
