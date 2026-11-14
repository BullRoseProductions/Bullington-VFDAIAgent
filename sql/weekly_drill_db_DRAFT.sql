-- =====================================================================
-- WEEKLY TRAINING CONTENT SLICE 4 — the weekly AI draft's database.   DRAFT — NOT APPLIED. NOT REVIEWED.
-- Design + rulings: docs/design/training_content_step0.md §5.1, §5.3 (record_dept_ai_call), §5.4 (gate PASS @2a0768c;
-- rulings @4cfe29f: R1 YES, R3 DA-owned; the service-role-only grants on put_weekly_drill_draft / record_dept_ai_call
-- were gate-approved WITH the no-approve-without-a-human trigger + CHECK as compensating controls).
-- Live base: docs/review/weekly_db_LIVEDEFS.json (read-only capture 2026-11-14, sha a173e3fb…, every body md5-checked).
--
-- ONE ALL-OR-NOTHING DO BLOCK, then NOTIFY pgrst, then a read-only state row. RETEST separately
-- (sql/weekly_drill_db_RETEST.sql, SENTINEL). Dry run: docs/review/weekly_db_dryrun_harness.mjs.
--
-- WHAT IT DOES
--   departments.weekly_drill_draft_enabled  boolean NOT NULL DEFAULT false — every department starts OFF (opt-in).
--   set_weekly_drill_draft_enabled(bool)    a REAL Department Admin of the caller's department only (the set_probation_enabled
--                                           shape, byte-for-byte the same check); + a guard trigger so no client UPDATE can flip it.
--   drill_plans.source CHECK                ai|manual|library -> ai|manual|library|ai_weekly (pinned drop + re-add, same name).
--   drill_plans.weekly_key text             'YYYY-Www'; set IF AND ONLY IF source = 'ai_weekly' (CHECK), unique per department
--                                           (partial unique index) — at most one weekly draft per department per week.
--   put_weekly_drill_draft(...)             service_role ONLY. Re-checks the toggle at write time; hardcodes status 'draft',
--                                           source 'ai_weekly', created_by / updated_by NULL (no person wrote it); ON CONFLICT
--                                           DO NOTHING. Returns {result: inserted|exists|disabled, id}.
--   record_dept_ai_call(dept, route)        service_role ONLY. The department's 'claude' backstop for a cron call: counts into a
--                                           NEW table ai_dept_call_usage and refuses once members' + cron calls reach 1,500/day.
--   THE HUMAN-APPROVAL LAW                  trigger drill_plans_human_approval: a row may become (or be inserted) 'approved', or
--                                           change approver while approved, ONLY when approved_by = my_member_id() and that is
--                                           not NULL. A service-role or SQL-editor session has no member, so it can never
--                                           approve by any path. + CHECK (status <> 'approved' OR approved_by IS NOT NULL).
--   Both service-role functions ALSO check auth.role() = 'service_role' inside the body (defence in depth: if a later
--   DROP + CREATE ever re-opened EXECUTE, a member still could not call them).
--
-- NOT TOUCHED: every existing function (the 7 drill_plans writers, the probation pair, record_ai_call, my_member_id /
-- my_department_id, is_training_*: md5-pinned and snapshot-compared), drill_plans' policy and grants, ai_call_usage,
-- every other policy / ACL / constraint / trigger, station_presence.verified.
--
-- DECISIONS FOR THE GATE (beyond the Step 0 text):
--   WK-1 The cron's backstop counter is a NEW table, ai_dept_call_usage (department, day, route). ai_call_usage's key is
--        (member_id, day, route) with member_id NOT NULL, and a cron call has no member. record_dept_ai_call refuses when
--        members' calls + cron calls reach the same 1,500/day ceiling; record_ai_call (members) is NOT changed, so it does not
--        see the cron's at most 6 attempts a week. Route is 'claude' only (the only route with a department ceiling).
--   WK-2 weekly_key format is pinned to ISO week 'YYYY-Www' in the CHECK as well as the RPC.
--   WK-3 put_weekly_drill_draft returns jsonb {result, id} (not a bare uuid) so the cron can tell "already done this week"
--        and "toggled off" from a write; neither is a failure (Step 0 §5.6).
--   WK-4 The approval trigger also fires on INSERT and on an approver change while approved — a row can't be born approved
--        or re-attributed without a human. An approved plan EDITED through set_drill_plan (status + approver unchanged) is
--        untouched, so today's flows are unchanged.
-- =====================================================================

DO $mig$
DECLARE
  v_pins constant jsonb := jsonb_build_object(   -- live capture 2026-11-14 (is_training_*: S1's live capture 2026-10-27)
    'public.set_probation_enabled(boolean)',                         '7989e962a9db4edfe78f845625b3db4c',
    'public.tg_departments_probation_enabled_guard()',               '77886627feaf6d2b121d4287530659c7',
    'public.record_ai_call(text)',                                   'bc12991cbd6fd2c1efc6794affbb5e27',
    'public.approve_drill_plan(uuid)',                               'a01c872bc14561fcb633796353a4b694',
    'public.unapprove_drill_plan(uuid)',                             '6012d001e95c3a5d6bdd0f6a49e8daf0',
    'public.set_drill_plan(uuid,text,text,integer,text,jsonb,text)', 'f574003f5c6905d120fd6365a1b7ce11',
    'public.delete_drill_plan(uuid)',                                'fc5a12df02bf1216815c361f985aaa1b',
    'public.dept_drill_plans()',                                     'd786d5593ef494c71549054d85864c8c',
    'public.attach_drill_plan_to_session(uuid,uuid)',                'a2fa184580b3be907d9dad944775c6a2',
    'public.pull_library_drill(uuid)',                               '1ae158e5ebb511cb71d614ba0c2c279d',
    'public.my_member_id()',                                         '3f66369c8af7bc07ec59831af6536fee',
    'public.my_department_id()',                                     '87f546659c3804a943b48e419e017f18',
    'public.is_training_manager()',                                  '472b87b0abca586ba0a13cd615b376fe',
    'public.is_training_officer()',                                  '248392a51fe913771f725b2a51013302');
  v_src_old constant text := 'CHECK ((source = ANY (ARRAY[''ai''::text, ''manual''::text, ''library''::text])))';
  v_src_new constant text := 'CHECK ((source = ANY (ARRAY[''ai''::text, ''manual''::text, ''library''::text, ''ai_weekly''::text])))';
  v_pol constant text := 'members read drill_plans|SELECT|authenticated|(department_id = my_department_id())|';
  v_new_fns constant text[] := array['set_weekly_drill_draft_enabled', 'put_weekly_drill_draft', 'record_dept_ai_call',
                                     'tg_departments_weekly_drill_draft_guard', 'tg_drill_plans_human_approval'];
  v_new_cons constant text[] := array['drill_plans_source_chk', 'drill_plans_weekly_key_chk', 'drill_plans_approved_by_chk'];
  v_fn_before text; v_fn_after text; v_pol_before text; v_pol_after text; v_acl_before text; v_acl_after text;
  v_con_before text; v_con_after text; v_trg_before text; v_trg_after text; v_ver_before bigint; v_ver_after bigint;
  k text; v text; v_n int;
BEGIN
  -- ---------------------------------------------------------------- 0. pre-flight
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (v_new_fns))
     OR to_regclass('public.ai_dept_call_usage') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.departments'::regclass AND attname = 'weekly_drill_draft_enabled' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.drill_plans'::regclass AND attname = 'weekly_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PREFLIGHT: a slice-4 name already exists — the weekly DB slice looks applied. Refusing.';
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each_text(v_pins) LOOP
    IF to_regprocedure(k) IS NULL OR md5(pg_get_functiondef(to_regprocedure(k))) <> v THEN
      RAISE EXCEPTION 'PREFLIGHT: % is missing or has drifted (pinned %). Re-audit.', k, v;
    END IF;
  END LOOP;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass AND conname = 'drill_plans_source_chk')
       IS DISTINCT FROM v_src_old THEN
    RAISE EXCEPTION 'PREFLIGHT: drill_plans_source_chk is not the audited text. Re-audit.';
  END IF;
  IF (SELECT string_agg(policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',')
        FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drill_plans') IS DISTINCT FROM v_pol THEN
    RAISE EXCEPTION 'PREFLIGHT: drill_plans policies are not the audited department-scoped SELECT. Re-audit.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.drill_plans'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PREFLIGHT: drill_plans has a trigger the audit did not see. Re-audit.';
  END IF;
  -- The approval CHECK must hold on today's rows, or the ALTER would fail mid-block: say so plainly instead.
  SELECT count(*) INTO v_n FROM public.drill_plans WHERE status = 'approved' AND approved_by IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PREFLIGHT: % approved drill plan(s) have no approver; the approval CHECK cannot be added. Re-audit.', v_n; END IF;

  -- snapshots (new objects excluded by name)
  SELECT md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || '/' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
    INTO v_fn_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND NOT (p.proname = ANY (v_new_fns));
  SELECT md5(string_agg(tablename || '.' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
    INTO v_pol_before FROM pg_policies WHERE schemaname IN ('public', 'storage');
  SELECT md5(string_agg(c.relname || '=' || coalesce(c.relacl::text, '') || '/' || c.relrowsecurity, ',' ORDER BY c.relname))
    INTO v_acl_before FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm') AND c.relname <> 'ai_dept_call_usage';
  SELECT md5(string_agg(conrelid::regclass::text || '.' || conname || '=' || pg_get_constraintdef(oid), ',' ORDER BY conrelid::regclass::text, conname))
    INTO v_con_before FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype::text <> 'n'   -- 'n' = NOT NULL rows (PG18 mock only)
     AND NOT (conrelid = 'public.drill_plans'::regclass AND conname = ANY (v_new_cons)) AND conrelid <> coalesce(to_regclass('public.ai_dept_call_usage'), 0::oid);
  SELECT md5(string_agg(tgrelid::regclass::text || '.' || tgname || '=' || pg_get_triggerdef(oid) || '/' || tgenabled::text, ',' ORDER BY tgrelid::regclass::text, tgname))
    INTO v_trg_before FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
     AND tgname NOT IN ('departments_weekly_drill_draft_guard', 'drill_plans_human_approval');
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;

  -- ---------------------------------------------------------------- 1. the toggle (DA-owned, R3)
  ALTER TABLE public.departments ADD COLUMN weekly_drill_draft_enabled boolean NOT NULL DEFAULT false;
  COMMENT ON COLUMN public.departments.weekly_drill_draft_enabled IS
    'B4C:weekly drill — the department''s opt-in weekly AI drill draft. Written only by set_weekly_drill_draft_enabled (a real Department Admin); client UPDATEs of this column are refused by trigger.';
  EXECUTE $ddl$
CREATE FUNCTION public.tg_departments_weekly_drill_draft_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- B4C:weekly drill — weekly_drill_draft_enabled changes only through set_weekly_drill_draft_enabled (or the SQL editor),
-- never a direct client UPDATE (departments takes direct UPDATEs for its other settings). The probation guard's shape.
begin
  if new.weekly_drill_draft_enabled is distinct from old.weekly_drill_draft_enabled and current_user in ('anon', 'authenticated') then
    raise exception 'Only a Department Admin can turn the weekly AI drill draft on or off.';
  end if;
  return new;
end;
$function$
$ddl$;
  CREATE TRIGGER departments_weekly_drill_draft_guard BEFORE UPDATE OF weekly_drill_draft_enabled ON public.departments
    FOR EACH ROW EXECUTE FUNCTION public.tg_departments_weekly_drill_draft_guard();
  REVOKE EXECUTE ON FUNCTION public.tg_departments_weekly_drill_draft_guard() FROM PUBLIC, anon, authenticated;

  EXECUTE $ddl$
CREATE FUNCTION public.set_weekly_drill_draft_enabled(p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:weekly drill — a Department Admin of the department turns its weekly AI drill draft on or off. A REAL DA only (the
-- set_probation_enabled check, unchanged): the caller's member row in THIS department holds 'Department Admin' and is
-- Active / Probationary — never the Project-Admin support path. Writes only the caller's own department.
declare v_dept uuid := public.my_department_id(); v_on boolean;
begin
  if p_enabled is null then raise exception 'Say on or off.'; end if;
  if v_dept is null or not exists (
       select 1 from public.members x
        where lower(x.email) = lower(auth.email()) and x.department_id = v_dept
          and x.access && array['Department Admin']::text[] and x.status in ('Active', 'Probationary')) then
    raise exception 'Only a Department Admin can turn the weekly AI drill draft on or off.';
  end if;
  update public.departments set weekly_drill_draft_enabled = p_enabled where id = v_dept returning weekly_drill_draft_enabled into v_on;
  if not found then raise exception 'We could not find your department.'; end if;
  return v_on;
end;
$function$
$ddl$;
  REVOKE ALL ON FUNCTION public.set_weekly_drill_draft_enabled(boolean) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.set_weekly_drill_draft_enabled(boolean) TO authenticated;

  -- ---------------------------------------------------------------- 2. provenance: source + weekly_key
  EXECUTE 'ALTER TABLE public.drill_plans DROP CONSTRAINT drill_plans_source_chk';
  ALTER TABLE public.drill_plans ADD CONSTRAINT drill_plans_source_chk CHECK (source = ANY (ARRAY['ai'::text, 'manual'::text, 'library'::text, 'ai_weekly'::text]));
  ALTER TABLE public.drill_plans ADD COLUMN weekly_key text;
  COMMENT ON COLUMN public.drill_plans.weekly_key IS
    'B4C:weekly drill — ISO week (YYYY-Www) of a weekly AI draft; set if and only if source = ai_weekly; one per department per week.';
  ALTER TABLE public.drill_plans ADD CONSTRAINT drill_plans_weekly_key_chk CHECK (
    (source = 'ai_weekly' AND weekly_key IS NOT NULL AND weekly_key ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$')
    OR (source <> 'ai_weekly' AND weekly_key IS NULL));
  CREATE UNIQUE INDEX drill_plans_weekly_key_uniq ON public.drill_plans (department_id, weekly_key) WHERE weekly_key IS NOT NULL;

  -- ---------------------------------------------------------------- 3. the human-approval law
  ALTER TABLE public.drill_plans ADD CONSTRAINT drill_plans_approved_by_chk CHECK (status <> 'approved' OR approved_by IS NOT NULL);
  EXECUTE $ddl$
CREATE FUNCTION public.tg_drill_plans_human_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:weekly drill — "never auto-approves" as a DB law. A plan may become approved (or be born approved, or change its
-- approver while approved) only when the approver IS the calling member. A service-role or SQL-editor session has no
-- member (my_member_id() is NULL), so no cron, script or direct UPDATE can approve — only approve_drill_plan, run by a person.
declare v_me uuid;
begin
  if new.status = 'approved'
     and (tg_op = 'INSERT' or old.status is distinct from 'approved' or new.approved_by is distinct from old.approved_by) then
    v_me := public.my_member_id();
    if v_me is null or new.approved_by is distinct from v_me then
      raise exception 'Only an officer can approve a drill plan, as themselves.';
    end if;
  end if;
  return new;
end;
$function$
$ddl$;
  CREATE TRIGGER drill_plans_human_approval BEFORE INSERT OR UPDATE ON public.drill_plans
    FOR EACH ROW EXECUTE FUNCTION public.tg_drill_plans_human_approval();
  REVOKE EXECUTE ON FUNCTION public.tg_drill_plans_human_approval() FROM PUBLIC, anon, authenticated;

  -- ---------------------------------------------------------------- 4. the cron's write path (service_role only)
  EXECUTE $ddl$
CREATE FUNCTION public.put_weekly_drill_draft(p_department_id uuid, p_week text, p_title text, p_category text, p_duration_min integer, p_audience text, p_content jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:weekly drill — the weekly cron lands ONE AI draft for one department-week. service_role only (EXECUTE + the role check
-- below). Re-checks the toggle at write time (off wins). Always a DRAFT, source ai_weekly, no author (no person wrote it).
-- A second call for the same department-week writes nothing and says so.
declare v_on boolean; v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;
  if p_week is null or p_week !~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$' then raise exception 'The week must look like 2026-W46.'; end if;
  if p_title is null or btrim(p_title) = '' then raise exception 'A drill plan needs a title.'; end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then raise exception 'A drill plan''s content must be a JSON object.'; end if;
  if p_duration_min is not null and (p_duration_min < 1 or p_duration_min > 1440) then raise exception 'The length must be between 1 and 1440 minutes.'; end if;
  select d.weekly_drill_draft_enabled into v_on from public.departments d where d.id = p_department_id;
  if not found then raise exception 'Department not found'; end if;
  if not v_on then return jsonb_build_object('result', 'disabled', 'id', null); end if;
  insert into public.drill_plans (department_id, title, category, duration_min, audience, content, status, source, weekly_key, created_by, updated_by)
  values (p_department_id, btrim(p_title), nullif(btrim(p_category), ''), p_duration_min, nullif(btrim(p_audience), ''), p_content,
          'draft', 'ai_weekly', p_week, null, null)
  on conflict (department_id, weekly_key) where weekly_key is not null do nothing
  returning id into v_id;
  if v_id is null then
    select p.id into v_id from public.drill_plans p where p.department_id = p_department_id and p.weekly_key = p_week;
    return jsonb_build_object('result', 'exists', 'id', v_id);
  end if;
  return jsonb_build_object('result', 'inserted', 'id', v_id);
end;
$function$
$ddl$;
  REVOKE ALL ON FUNCTION public.put_weekly_drill_draft(uuid,text,text,text,integer,text,jsonb) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.put_weekly_drill_draft(uuid,text,text,text,integer,text,jsonb) TO service_role;

  -- ---------------------------------------------------------------- 5. the cron's backstop (WK-1)
  CREATE TABLE public.ai_dept_call_usage (
    department_id uuid        NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    day           date        NOT NULL,
    route         text        NOT NULL CHECK (route IN ('claude')),
    count         integer     NOT NULL DEFAULT 0 CHECK (count >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (department_id, day, route)
  );
  COMMENT ON TABLE public.ai_dept_call_usage IS
    'B4C:weekly drill — per-department/day AI calls made with NO member (the weekly cron). Written only by record_dept_ai_call(); no policies, no client access.';
  ALTER TABLE public.ai_dept_call_usage ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.ai_dept_call_usage FROM PUBLIC, anon, authenticated, service_role;
  EXECUTE $ddl$
CREATE FUNCTION public.record_dept_ai_call(p_department_id uuid, p_route text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:weekly drill — count one memberless AI call (the weekly cron) against the department's daily backstop: the SAME
-- 1,500/day 'claude' ceiling record_ai_call enforces for members, summed over members' calls + these. service_role only.
declare
  v_day   date := (now() at time zone 'America/Chicago')::date;
  v_dcap  constant integer := 1500;
  v_dused integer;
  v_n     integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;
  if p_route is null or p_route <> 'claude' then raise exception 'Unknown AI route.'; end if;
  if not exists (select 1 from public.departments d where d.id = p_department_id) then raise exception 'Department not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_call:' || p_department_id::text || ':' || v_day::text || ':' || p_route, 0));   -- record_ai_call's lock
  select coalesce((select sum(u.count) from public.ai_call_usage u where u.department_id = p_department_id and u.day = v_day and u.route = p_route), 0)
       + coalesce((select c.count from public.ai_dept_call_usage c where c.department_id = p_department_id and c.day = v_day and c.route = p_route), 0)
    into v_dused;
  if v_dused >= v_dcap then
    return jsonb_build_object('allowed', false, 'scope', 'department', 'dept_used', v_dused, 'dept_ceiling', v_dcap);
  end if;
  insert into public.ai_dept_call_usage as c (department_id, day, route, count, updated_at)
  values (p_department_id, v_day, p_route, 1, now())
  on conflict (department_id, day, route) do update set count = c.count + 1, updated_at = now()
  returning c.count into v_n;
  return jsonb_build_object('allowed', true, 'dept_used', v_dused + 1, 'dept_ceiling', v_dcap, 'cron_used', v_n);
end;
$function$
$ddl$;
  REVOKE ALL ON FUNCTION public.record_dept_ai_call(uuid,text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.record_dept_ai_call(uuid,text) TO service_role;

  -- ---------------------------------------------------------------- 6. post-conditions
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass AND conname = 'drill_plans_source_chk')
       IS DISTINCT FROM v_src_new THEN
    RAISE EXCEPTION 'POST: drill_plans_source_chk is not the widened text.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('put_weekly_drill_draft', 'record_dept_ai_call')
     AND p.prosecdef AND 'search_path=public' = ANY (coalesce(p.proconfig, '{}'))
     AND position('auth.role()' in p.prosrc) > 0
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST: expected 2 service-role-only functions (definer, search_path, role check, no anon/authenticated/PUBLIC); found %.', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid = 'public.set_weekly_drill_draft_enabled(boolean)'::regprocedure AND p.prosecdef AND 'search_path=public' = ANY (coalesce(p.proconfig, '{}'))
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST: set_weekly_drill_draft_enabled is not definer + authenticated-only.'; END IF;
  IF has_table_privilege('anon', 'public.ai_dept_call_usage', 'SELECT') OR has_table_privilege('authenticated', 'public.ai_dept_call_usage', 'SELECT')
     OR has_table_privilege('service_role', 'public.ai_dept_call_usage', 'INSERT') OR has_table_privilege('service_role', 'public.ai_dept_call_usage', 'SELECT') THEN
    RAISE EXCEPTION 'POST: ai_dept_call_usage is reachable by a client role.';
  END IF;

  SELECT md5(string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || '/' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
    INTO v_fn_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND NOT (p.proname = ANY (v_new_fns));
  SELECT md5(string_agg(tablename || '.' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
    INTO v_pol_after FROM pg_policies WHERE schemaname IN ('public', 'storage');
  SELECT md5(string_agg(c.relname || '=' || coalesce(c.relacl::text, '') || '/' || c.relrowsecurity, ',' ORDER BY c.relname))
    INTO v_acl_after FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm') AND c.relname <> 'ai_dept_call_usage';
  SELECT md5(string_agg(conrelid::regclass::text || '.' || conname || '=' || pg_get_constraintdef(oid), ',' ORDER BY conrelid::regclass::text, conname))
    INTO v_con_after FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype::text <> 'n'
     AND NOT (conrelid = 'public.drill_plans'::regclass AND conname = ANY (v_new_cons)) AND conrelid <> 'public.ai_dept_call_usage'::regclass;
  SELECT md5(string_agg(tgrelid::regclass::text || '.' || tgname || '=' || pg_get_triggerdef(oid) || '/' || tgenabled::text, ',' ORDER BY tgrelid::regclass::text, tgname))
    INTO v_trg_after FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
     AND tgname NOT IN ('departments_weekly_drill_draft_guard', 'drill_plans_human_approval');
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;

  IF v_fn_after IS DISTINCT FROM v_fn_before THEN RAISE EXCEPTION 'POST: a pre-existing function or its grants changed.'; END IF;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'POST: a policy changed.'; END IF;
  IF v_acl_after IS DISTINCT FROM v_acl_before THEN RAISE EXCEPTION 'POST: a table/view ACL or RLS flag changed.'; END IF;
  IF v_con_after IS DISTINCT FROM v_con_before THEN RAISE EXCEPTION 'POST: a constraint other than the three drill_plans ones changed.'; END IF;
  IF v_trg_after IS DISTINCT FROM v_trg_before THEN RAISE EXCEPTION 'POST: a pre-existing trigger changed.'; END IF;
  IF v_ver_after IS DISTINCT FROM v_ver_before THEN RAISE EXCEPTION 'POST: station_presence.verified count moved (% -> %).', v_ver_before, v_ver_after; END IF;
END
$mig$;

NOTIFY pgrst, 'reload schema';

-- read-only state row
SELECT jsonb_build_object(
  'weekly_fns', (SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY p.proname) FROM pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('set_weekly_drill_draft_enabled', 'put_weekly_drill_draft', 'record_dept_ai_call',
                                                                                  'tg_departments_weekly_drill_draft_guard', 'tg_drill_plans_human_approval')),
  'source_check', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.drill_plans'::regclass AND conname = 'drill_plans_source_chk'),
  'triggers', (SELECT jsonb_agg(tgrelid::regclass::text || '.' || tgname ORDER BY tgname) FROM pg_trigger
                WHERE tgname IN ('departments_weekly_drill_draft_guard', 'drill_plans_human_approval')),
  'departments_on', (SELECT count(*) FROM public.departments WHERE weekly_drill_draft_enabled),
  'plans_by_status_source', (SELECT jsonb_object_agg(s, n) FROM (SELECT status || '/' || source s, count(*) n FROM public.drill_plans GROUP BY 1) z),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
