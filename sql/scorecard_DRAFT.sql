-- =====================================================================
-- PHASE 3.1 #5 — READINESS SCORECARD + ISO PACKET (DB slice).
-- DRAFT — UNREVIEWED. Not applied. Test: sql/scorecard_RETEST.sql (run AFTER, separately).
-- Build order: claude/B4C_Phase3.1_Scorecard_DB_BuildOrder.md (option 3 ruled Oct 19). Step 0: sql/scorecard_STEP0_CHECK.sql.
--
-- HONEST BY DEFAULT: a department with NO requirements reads 'not_set' (never ready, never not-ready). 'ready' only
-- when EVERY required item is satisfied right now; missing / expired / no_date / expiring-soon / unsigned / a requirement
-- that can't be met -> 'not_ready', with the item named. Display-only in v1 (it blocks nothing). Never touches the
-- locked verification column.
--
-- WHAT CHANGES:
--   1. readiness_requirements — the department's standard: kind IN (credential_license, credential_med_card,
--      credential_fit_test, qualification_type, document). NO cert kind (option 3: certs are untyped free text and many
--      never expire — they're listed on the scorecard for visibility but never move the verdict; a department that needs
--      one in the verdict expresses it as a qualification type until the cert catalog exists). ref_id = the
--      qualification_types.id or the document_series.series_id (NULL for the credential kinds — the kind IS the
--      requirement). required boolean (false = kept but not counted). Unique (department, kind, ref_id) NULLS NOT
--      DISTINCT. RLS on, ONE department-scoped SELECT policy, zero write policies / grants.
--   2. set_readiness_requirement(p_kind, p_ref_id, p_required) — is_dept_admin() (DA / PA — defining the standard,
--      like set_qualification_type); a ref_id must name a qualification type / document series of the CALLER's
--      department (a document id is mapped to its series through documents.series_id).
--   3. Reads (SECURITY DEFINER):
--      dept_readiness_requirements()   — the configured standard with labels (department members).
--      member_scorecard(p_member_id)   — own row, or Board / DA / Officer (is_canmanage()) for a member of their department.
--      dept_readiness_packet()         — is_canmanage(): every counted member's verdict + outstanding items + the
--                                        rollups, built from the EXISTING leadership reads (dept_qualification_matrix,
--                                        dept_expirations, dept_read_sign_compliance) so the packet can't disagree with
--                                        those screens. Honest denominator: Active / Probationary, not separated, not PA.
--      Internal (not callable by members): readiness_window(bucket, expires_on), readiness_items(dept, member),
--      readiness_verdict(dept, member).
--
-- REUSE (lockstep with the live screens — nothing re-derived):
--   qualification_type -> qualification_cells(dept, member).status (qualified / in_progress / not_started).
--   credential_*       -> expiration_rows(dept, member) source 'credential' of that kind (the member's best row), then
--                         readiness_window = the SQL mirror of shared/expiry.js (expired / no_date stand; expiry MONTH
--                         within 3 of this month = expiring, else current). Expiring counts as NOT satisfied (order §5).
--   document           -> rs_member_in_audience + the dept_read_sign_compliance rule (current version signed; within
--                         12 months when annual). Outside the audience = not_required (satisfied).
--   certs (visibility) -> expiration_rows source 'cert', bucketed by readiness_window.
--   activity (info)    -> last 12 months: station hours from closed, non-auto-closed shifts (logged time — NOT the ISO
--                         credited figure; that read is gated by the role-anywhere is_leadership()); training sessions
--                         attended; non-voided supervised drives. No calls / incident table exists, so no "calls run".
-- DRY RUN 2026-10-19 (PGlite on the probation + qualifications + expirations mocks, 3 departments): RETEST 20 passed /
-- 0 failed / 1 skipped. §5 mutations + more, each caught: a member through the config gate -> C1 · a member reading
-- another's scorecard -> G1 · a member opening the packet (gate removed) -> G1 (the packet's own message; the reused
-- matrix read would still refuse — defence in depth) · another department's qualification as a ref -> C1 · an
-- unconfigured department scored ready -> N1 · an expired / undated credential counted satisfied -> V1 · a 30-day
-- window instead of the badge's 3 months -> W0 + V1 · a cert kind allowed -> S0 + C1 · satisfied left nullable (the
-- bool_and hole) -> V1 · separated members counted in the packet -> P1 · an unsigned document counted -> V1 · a cert
-- moving the verdict -> V2 · an internal helper left callable -> rolls back · re-run -> refused.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_t text; v_total_before int;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'readiness_requirements'$q$;
  PUBLIC_FNS constant text[] := array['public.set_readiness_requirement(text,uuid,boolean)', 'public.dept_readiness_requirements()',
    'public.member_scorecard(uuid)', 'public.dept_readiness_packet()'];
  INTERNAL_FNS constant text[] := array['public.readiness_window(text,date)', 'public.readiness_items(uuid,uuid)', 'public.readiness_verdict(uuid,uuid)'];
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.readiness_requirements') IS NOT NULL OR to_regprocedure('public.member_scorecard(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: readiness_requirements / member_scorecard already exists — already applied. Nothing changed.';
  END IF;
  FOREACH v_t IN ARRAY array['is_canmanage()', 'is_dept_admin()'] LOOP
    IF to_regprocedure('public.' || v_t) IS NULL OR position('my_department_id()' in pg_get_functiondef(('public.' || v_t)::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: % is missing or no longer department-scoped.', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY array['public.my_member_id()', 'public.my_department_id()', 'public.qualification_cells(uuid,uuid)',
      'public.expiration_rows(uuid,uuid)', 'public.rs_member_in_audience(uuid,text[])', 'public.dept_qualification_matrix()',
      'public.dept_expirations()', 'public.dept_read_sign_compliance()'] LOOP
    IF to_regprocedure(v_t) IS NULL THEN RAISE EXCEPTION 'Precondition failed: % is missing — apply #1 / #3 / #4 first.', v_t; END IF;
  END LOOP;
  FOR v_t IN SELECT x FROM unnest(array['qualification_types.id:uuid', 'qualification_types.active:boolean', 'document_series.series_id:uuid',
      'document_series.requires_ack:boolean', 'document_series.current_version:integer', 'document_series.required_roles:ARRAY',
      'document_series.annual_resign:boolean', 'documents.series_id:uuid', 'document_acknowledgments.version:integer',
      'station_presence.checked_in_at:timestamp with time zone', 'station_presence.checked_out_at:timestamp with time zone',
      'station_presence.auto_closed:boolean', 'session_attendance.session_id:uuid', 'training_sessions.date:date',
      'supervised_sessions.voided_at:timestamp with time zone', 'member_separation.member_id:uuid']) x LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = split_part(split_part(v_t, ':', 1), '.', 1) AND column_name = split_part(split_part(v_t, ':', 1), '.', 2)
                     AND data_type = split_part(v_t, ':', 2)) THEN
      RAISE EXCEPTION 'Precondition failed: column % is missing or not the expected type.', v_t;
    END IF;
  END LOOP;
  EXECUTE pol_sql INTO v_pol_before;
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';

  -- ---------------------------------------------------------------- 1. the table
  CREATE TABLE public.readiness_requirements (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document')),
    ref_id        uuid,
    required      boolean NOT NULL DEFAULT true,
    created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT readiness_requirements_ref_chk CHECK ((kind LIKE 'credential\_%') = (ref_id IS NULL))
  );
  CREATE UNIQUE INDEX readiness_requirements_uq ON public.readiness_requirements (department_id, kind, ref_id) NULLS NOT DISTINCT;
  COMMENT ON TABLE public.readiness_requirements IS 'B4C:scorecard — the department''s readiness standard. Writes: set_readiness_requirement only. No cert kind (v1).';
  ALTER TABLE public.readiness_requirements ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.readiness_requirements FROM anon, authenticated, public;
  GRANT SELECT ON public.readiness_requirements TO authenticated;
  CREATE POLICY readiness_requirements_read ON public.readiness_requirements FOR SELECT TO authenticated
    USING (department_id = public.my_department_id());

  -- ---------------------------------------------------------------- internal: the shared window (SQL mirror of shared/expiry.js)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.readiness_window(p_bucket text, p_expires date)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard (internal) — shared/expiry.js expiryBucket() in SQL: expired / no_date stand; otherwise the expiry MONTH
-- within EXPIRING_MONTHS (3) of this month (America/Chicago) = 'soon', else 'current'. Keep in lockstep with
-- shared/expiry.js + certStatus() (the RETEST checks every month -2..+8).
  select case
    when p_bucket in ('expired', 'no_date') then p_bucket
    when p_expires is null then 'no_date'
    when (extract(year from p_expires)::int * 12 + extract(month from p_expires)::int)
         - (extract(year from (now() at time zone 'America/Chicago'))::int * 12 + extract(month from (now() at time zone 'America/Chicago'))::int) <= 3
      then 'soon'
    else 'current' end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- internal: one member's required items
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.readiness_items(p_dept uuid, p_member uuid)
 RETURNS TABLE(requirement_id uuid, kind text, ref_id uuid, label text, satisfied boolean, status text, expires_on date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard (internal) — every REQUIRED item of the department for one member, each resolved through the existing
-- read for its kind. Read-only.
  with td as (select (now() at time zone 'America/Chicago')::date as d),
  req as (select r.* from public.readiness_requirements r where r.department_id = p_dept and r.required),
  quals as (select c.type_id, c.status from public.qualification_cells(p_dept, p_member) c),
  creds as (select e.kind, e.expires_on, public.readiness_window(e.bucket, e.expires_on) as w
              from public.expiration_rows(p_dept, p_member) e where e.source = 'credential'),
  best_cred as (   -- per kind, the member's best: current > soon > no_date > expired, then the latest date
    select distinct on (c.kind) c.kind, c.expires_on, c.w
      from creds c
     order by c.kind, case c.w when 'current' then 0 when 'soon' then 1 when 'no_date' then 2 else 3 end, c.expires_on desc nulls last)
  select r.id, r.kind, r.ref_id,
         case when r.kind = 'qualification_type' then coalesce(qt.name, 'Qualification (removed)')
              when r.kind = 'document' then coalesce(ds.title, 'Document (removed)')
              when r.kind = 'credential_license' then 'Driver''s license'
              when r.kind = 'credential_med_card' then 'Med card'
              else 'Fit test' end,
         -- satisfied — NEVER null (bool_and ignores nulls: an unknown must read unsatisfied, not drop out of the verdict)
         coalesce(case when r.kind = 'qualification_type' then coalesce(qt.active, false) and q.status = 'qualified'
              when r.kind = 'document' then ds.series_id is not null and ds.requires_ack and ds.current_version > 0
                                            and (not public.rs_member_in_audience(p_member, ds.required_roles) or ack.ok)
              else bc.w = 'current' end, false),
         -- status
         case when r.kind = 'qualification_type' then
                case when qt.id is null or not qt.active then 'not_configured'
                     when q.status = 'qualified' then 'qualified'
                     when q.status = 'in_progress' then 'in_progress' else 'missing' end
              when r.kind = 'document' then
                case when ds.series_id is null or not ds.requires_ack or ds.current_version = 0 then 'not_configured'
                     when not public.rs_member_in_audience(p_member, ds.required_roles) then 'not_required'
                     when ack.ok then 'signed' else 'unsigned' end
              else case when bc.kind is null then 'missing' when bc.w = 'soon' then 'expiring' else bc.w end end,
         case when r.kind like 'credential\_%' then bc.expires_on end
    from req r cross join td
    left join public.qualification_types qt on r.kind = 'qualification_type' and qt.id = r.ref_id and qt.department_id = p_dept
    left join quals q on r.kind = 'qualification_type' and q.type_id = r.ref_id
    left join public.document_series ds on r.kind = 'document' and ds.series_id = r.ref_id and ds.department_id = p_dept
    left join lateral (select exists (select 1 from public.document_acknowledgments k
                                        where k.member_id = p_member and k.series_id = ds.series_id and k.version = ds.current_version
                                          and (not ds.annual_resign or (k.signed_at at time zone 'America/Chicago')::date + interval '12 months' > td.d)) as ok
                        where r.kind = 'document') ack on true
    left join best_cred bc on r.kind like 'credential\_%' and bc.kind = substr(r.kind, 12)
   order by case when r.kind = 'qualification_type' then 0 when r.kind like 'credential\_%' then 1 else 2 end, 4;
$function$
$ddl$;

  -- ---------------------------------------------------------------- internal: the verdict document
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.readiness_verdict(p_dept uuid, p_member uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard (internal) — the verdict + items + certs (visibility only) + activity (information only). Read-only.
  with it as (select * from public.readiness_items(p_dept, p_member)),
  td as (select (now() at time zone 'America/Chicago')::date as d)
  select jsonb_build_object(
    'member_id', m.id, 'name', m.name, 'status', m.status,
    'state', case when (select count(*) from it) = 0 then 'not_set'
                  when (select bool_and(it.satisfied) from it) then 'ready' else 'not_ready' end,
    'required', (select count(*) from it),
    'satisfied', (select count(*) from it where it.satisfied),
    'items', coalesce((select jsonb_agg(to_jsonb(it)) from it), '[]'::jsonb),
    'outstanding', coalesce((select jsonb_agg(it.label || ' — ' || replace(it.status, '_', ' ')) from it where not it.satisfied), '[]'::jsonb),
    'certs', coalesce((select jsonb_agg(jsonb_build_object('label', e.label, 'expires_on', e.expires_on,
                                                           'status', public.readiness_window(e.bucket, e.expires_on)) order by e.expires_on nulls first)
                         from public.expiration_rows(p_dept, p_member) e where e.source = 'cert'), '[]'::jsonb),
    'activity', jsonb_build_object(
      'window', 'last 12 months',
      'station_hours', coalesce((select round(sum(extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 1)
                                   from public.station_presence sp
                                  where sp.member_id = p_member and sp.department_id = p_dept and sp.checked_out_at is not null
                                    and not coalesce(sp.auto_closed, false) and sp.checked_in_at >= now() - interval '12 months'), 0),
      'trainings', (select count(distinct a.session_id) from public.session_attendance a
                      join public.training_sessions t on t.id = a.session_id and t.department_id = p_dept
                     where a.member_id = p_member and t.date <= td.d and t.date > td.d - interval '12 months'),
      'drives', (select count(*) from public.supervised_sessions ss
                  where ss.member_id = p_member and ss.department_id = p_dept and ss.kind = 'drive' and ss.voided_at is null
                    and ss.occurred_on > td.d - interval '12 months')))
    from public.members m cross join td
   where m.id = p_member and m.department_id = p_dept;
$function$
$ddl$;

  -- ---------------------------------------------------------------- the write
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_readiness_requirement(p_kind text, p_ref_id uuid DEFAULT NULL, p_required boolean DEFAULT true)
 RETURNS public.readiness_requirements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard — a Department Admin (or PA) sets the department's readiness standard: add / keep (required) or drop
-- from the count (required = false). Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_ref uuid := p_ref_id; v_row public.readiness_requirements;
begin
  if v_dept is null or not coalesce(public.is_dept_admin(), false) then
    raise exception 'Only a Department Admin can set the readiness standard.';
  end if;
  if p_kind is null or p_kind not in ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document') then
    raise exception 'Unknown requirement type.';
  end if;
  if p_kind like 'credential\_%' then
    if v_ref is not null then raise exception 'A credential requirement is the credential type itself — no item to pick.'; end if;
  elsif p_kind = 'qualification_type' then
    if v_ref is null or not exists (select 1 from public.qualification_types where id = v_ref and department_id = v_dept) then
      raise exception 'That qualification is not set up in your department.';
    end if;
  else   -- document: a series id, or any document row of it (mapped through documents.series_id)
    if v_ref is not null and not exists (select 1 from public.document_series where series_id = v_ref and department_id = v_dept) then
      select d.series_id into v_ref from public.documents d where d.id = p_ref_id and d.department_id = v_dept;
    end if;
    if v_ref is null or not exists (select 1 from public.document_series where series_id = v_ref and department_id = v_dept) then
      raise exception 'That document is not in your department.';
    end if;
  end if;
  insert into public.readiness_requirements (department_id, kind, ref_id, required, created_by, updated_by)
  values (v_dept, p_kind, v_ref, coalesce(p_required, true), v_me, v_me)
  on conflict (department_id, kind, ref_id) do update set required = excluded.required, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- reads
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_readiness_requirements()
 RETURNS TABLE(id uuid, kind text, ref_id uuid, label text, required boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard — the department's configured standard, labelled. Read-only.
#variable_conflict use_column
declare v_dept uuid := public.my_department_id();
begin
  if v_dept is null then raise exception 'We could not match your login to a department.'; end if;
  return query
  select r.id, r.kind, r.ref_id,
         case when r.kind = 'qualification_type' then coalesce(qt.name, 'Qualification (removed)') || case when qt.active is false then ' (inactive)' else '' end
              when r.kind = 'document' then coalesce(ds.title, 'Document (removed)') || case when ds.series_id is not null and not ds.requires_ack then ' (no longer requires a signature)' else '' end
              when r.kind = 'credential_license' then 'Driver''s license'
              when r.kind = 'credential_med_card' then 'Med card' else 'Fit test' end,
         r.required
    from public.readiness_requirements r
    left join public.qualification_types qt on r.kind = 'qualification_type' and qt.id = r.ref_id
    left join public.document_series ds on r.kind = 'document' and ds.series_id = r.ref_id
   where r.department_id = v_dept
   order by case when r.kind = 'qualification_type' then 0 when r.kind like 'credential\_%' then 1 else 2 end, 4;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.member_scorecard(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard — one member's readiness: themself, or (Board / DA / Officer) a member of their department. Read-only;
-- display-only in v1.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
begin
  if v_dept is null or v_me is null then raise exception 'We could not match your login to a department.'; end if;
  if p_member_id is distinct from v_me and not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see another member''s scorecard.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  return public.readiness_verdict(v_dept, p_member_id);
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_readiness_packet()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard — the ISO / audit packet's data, for Board / DA / Officer. Every counted member's verdict + the rollups,
-- built from the existing leadership reads (so the packet matches those screens). Read-only; the UI prints it.
declare v_dept uuid := public.my_department_id(); v_members jsonb; v_reqs jsonb; v_mx jsonb; v_exp jsonb; v_ack jsonb;
begin
  if v_dept is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can open the readiness packet.';
  end if;
  select coalesce(jsonb_agg(public.readiness_verdict(v_dept, m.id) order by m.name), '[]'::jsonb) into v_members
    from public.members m
   where m.department_id = v_dept and m.status in ('Active', 'Probationary')
     and not coalesce(m.access && array['Project Admin']::text[], false)
     and not exists (select 1 from public.member_separation s where s.member_id = m.id);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_reqs from public.dept_readiness_requirements() r where r.required;
  v_mx := public.dept_qualification_matrix();
  select jsonb_build_object(
           'expired', count(*) filter (where w = 'expired'), 'no_date', count(*) filter (where w = 'no_date'),
           'expiring', count(*) filter (where w = 'soon'), 'current', count(*) filter (where w = 'current'))
    into v_exp
    from (select public.readiness_window(e.bucket, e.expires_on) as w from public.dept_expirations() e) z;
  select coalesce(jsonb_agg(jsonb_build_object('title', c.title, 'version', c.version, 'current', c.current_count, 'audience', c.audience,
                                               'outstanding', jsonb_array_length(c.outstanding)) order by c.title), '[]'::jsonb)
    into v_ack from public.dept_read_sign_compliance() c;
  return jsonb_build_object(
    'generated_at', now(),
    'department', (select d.name from public.departments d where d.id = v_dept),
    'requirements', v_reqs,
    'standard_set', jsonb_array_length(v_reqs) > 0,
    'members', v_members,
    'readiness', jsonb_build_object(
       'counted', jsonb_array_length(v_members),
       'ready', (select count(*) from jsonb_array_elements(v_members) x where x->>'state' = 'ready'),
       'not_ready', (select count(*) from jsonb_array_elements(v_members) x where x->>'state' = 'not_ready'),
       'not_set', (select count(*) from jsonb_array_elements(v_members) x where x->>'state' = 'not_set')),
    'qualifications', coalesce((select jsonb_agg(jsonb_build_object('name', t->>'name',
          'qualified', (select count(*) from jsonb_array_elements(v_mx->'cells') c where c->>'type_id' = t->>'id' and c->>'status' = 'qualified'),
          'in_progress', (select count(*) from jsonb_array_elements(v_mx->'cells') c where c->>'type_id' = t->>'id' and c->>'status' = 'in_progress'),
          'not_started', (select count(*) from jsonb_array_elements(v_mx->'cells') c where c->>'type_id' = t->>'id' and c->>'status' = 'not_started')))
        from jsonb_array_elements(v_mx->'types') t), '[]'::jsonb),
    'expirations', v_exp,
    'acknowledgments', v_ack);
end;
$function$
$ddl$;

  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_t);
  END LOOP;
  FOREACH v_t IN ARRAY INTERNAL_FNS LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, public', v_t);
  END LOOP;

  -- ---------------------------------------------------------------- post-conditions (any failure undoes everything)
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.readiness_requirements'::regclass) THEN RAISE EXCEPTION 'Post-condition failed: RLS off.'; END IF;
  IF has_table_privilege('authenticated', 'public.readiness_requirements', 'INSERT') OR has_table_privilege('authenticated', 'public.readiness_requirements', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.readiness_requirements', 'DELETE') OR has_table_privilege('anon', 'public.readiness_requirements', 'SELECT') THEN
    RAISE EXCEPTION 'Post-condition failed: readiness_requirements has a client write grant, or anon can read it.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'readiness_requirements') <> 1
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'readiness_requirements' AND cmd = 'SELECT' AND position('my_department_id()' in qual) > 0) <> 1 THEN
    RAISE EXCEPTION 'Post-condition failed: exactly one department-scoped SELECT policy, no write policy.';
  END IF;
  IF position('cert''' in (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname = 'readiness_requirements_kind_check')) > 0 THEN
    RAISE EXCEPTION 'Post-condition failed: a cert requirement kind exists (option 3: none in v1).';
  END IF;
  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-condition failed: % grants are wrong (anon must not, authenticated must).', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY PUBLIC_FNS || INTERNAL_FNS LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_t::regprocedure) THEN RAISE EXCEPTION 'Post-condition failed: % is not SECURITY DEFINER.', v_t; END IF;
    IF position('is_leader' in pg_get_functiondef(v_t::regprocedure)) > 0 THEN RAISE EXCEPTION 'Post-condition failed: % uses a role-anywhere leader gate.', v_t; END IF;
    IF position(('verifie' || 'd') in pg_get_functiondef(v_t::regprocedure)) > 0 THEN RAISE EXCEPTION 'Post-condition failed: % references the locked verification column.', v_t; END IF;
  END LOOP;
  FOREACH v_t IN ARRAY INTERNAL_FNS LOOP
    IF has_function_privilege('authenticated', v_t, 'EXECUTE') OR has_function_privilege('anon', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-condition failed: the internal % is callable by members.', v_t;
    END IF;
  END LOOP;
  IF position('is_dept_admin()' in pg_get_functiondef('public.set_readiness_requirement(text,uuid,boolean)'::regprocedure)) = 0
     OR position('is_canmanage()' in pg_get_functiondef('public.member_scorecard(uuid)'::regprocedure)) = 0
     OR position('my_member_id()' in pg_get_functiondef('public.member_scorecard(uuid)'::regprocedure)) = 0
     OR position('is_canmanage()' in pg_get_functiondef('public.dept_readiness_packet()'::regprocedure)) = 0
     OR position('member_separation' in pg_get_functiondef('public.dept_readiness_packet()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: a scorecard RPC lost its gate or its honest denominator.';
  END IF;
  IF position('qualification_cells' in pg_get_functiondef('public.readiness_items(uuid,uuid)'::regprocedure)) = 0
     OR position('expiration_rows' in pg_get_functiondef('public.readiness_items(uuid,uuid)'::regprocedure)) = 0
     OR position('rs_member_in_audience' in pg_get_functiondef('public.readiness_items(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: readiness_items no longer reuses the qualification / expiration / Read & Sign logic.';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a pre-existing policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before + 1 THEN RAISE EXCEPTION 'Post-condition failed: expected exactly 1 new policy.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: table true · rls true · policies_on_table 1 · fns 4 · all_definer true · anon_exec false ·
-- internal_exec false · requirements 0 · total_policies 169 (168 + 1)
SELECT to_regclass('public.readiness_requirements') IS NOT NULL AS "table",
       (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.readiness_requirements')) AS rls,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'readiness_requirements') AS policies_on_table,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_readiness_requirement', 'dept_readiness_requirements', 'member_scorecard', 'dept_readiness_packet')) AS fns,
       (SELECT bool_and(prosecdef) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_readiness_requirement', 'dept_readiness_requirements',
          'member_scorecard', 'dept_readiness_packet', 'readiness_window', 'readiness_items', 'readiness_verdict')) AS all_definer,
       has_function_privilege('anon', 'public.member_scorecard(uuid)', 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.readiness_verdict(uuid,uuid)', 'EXECUTE') AS internal_exec,
       (SELECT count(*) FROM public.readiness_requirements) AS requirements,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately):
-- DO $rb$ BEGIN
--   DROP FUNCTION IF EXISTS public.dept_readiness_packet(), public.member_scorecard(uuid), public.dept_readiness_requirements(),
--     public.set_readiness_requirement(text,uuid,boolean), public.readiness_verdict(uuid,uuid), public.readiness_items(uuid,uuid),
--     public.readiness_window(text,date);
--   DROP TABLE IF EXISTS public.readiness_requirements;
-- END $rb$;
-- NOTIFY pgrst, 'reload schema';
