-- =====================================================================
-- PHASE 3.1 #3 — QUALIFICATION MATRIX + DRIVER/OPERATOR CHECK-OFFS + DRIVE LOG (DB layer).
-- Record: Claude gate review PASS 2026-10-18 on 0e4cf60 (no SQL changes), recorded BEFORE apply.
-- APPLIED by hand 2026-10-18. State check: tables 2 · rls true · new_policies 2 · fns 6 · anon_exec false ·
-- internal_exec false · types 0 · signoffs 0 · total_policies 165.
-- Decisions #1 / #2 shipped as their defaults (qualification drives also count as probation supervised time;
-- set_qualification_type gated is_dept_admin()). Test: sql/qualifications_RETEST.sql (run AFTER, separately).
-- Brief: Build Order #3 (2026-10-18). Step 0: sql/qualifications_STEP0_CHECK.sql (ran on live 2026-10-18).
--
-- REUSES the probation drive store — supervised_sessions + void_supervised_session — and does NOT change them: a drive
-- toward a qualification is a supervised_sessions row (kind 'drive', apparatus_id = the qualification's apparatus,
-- counts_toward = the qualification type id). Correcting one = the existing void (append-only; voided rows count for
-- nothing). Post-conditions prove supervised_sessions' RPCs and the probation status functions are byte-identical.
--
-- WHAT CHANGES:
--   1. qualification_types — each department's OWN list (no global default set): name, kind ('apparatus_driver' |
--      'apparatus_operator' | 'position'), apparatus_id (required for the two apparatus kinds, null for position; no FK —
--      the RPC checks the department and that the apparatus isn't deleted), threshold_drives (apparatus kinds only,
--      1..1000, guidance — never auto-qualifies), sort_order, active (types are deactivated, never deleted).
--      Unique name per department (case-insensitive).
--   2. member_qualifications — the officer sign-off: one row per member x type. revoked_at IS NULL = Qualified.
--      Revoking stamps revoked_at / revoked_by / revoke_reason and keeps the row; a later re-sign replaces the stamps
--      (LAST sign-off + LAST revoke are kept, not a full history — same as milestones' last-write-wins; flag if a full
--      history is wanted).
--   Both tables: RLS on, SELECT-only grant, ONE read policy each; zero write policies / grants (RPC-only).
--     qualification_types: the whole department reads its list (members see what they're working toward).
--     member_qualifications: own row, or Board / DA / Officer of the department (is_canmanage()).
--
--   RPCs (SECURITY DEFINER, department-scoped, never touch the locked verification column, never is_leader()):
--     set_qualification_type(p_id, name, kind, apparatus, threshold, sort_order, active) — create (p_id NULL) or edit.
--         is_dept_admin() (DA / PA — the same gate as onboarding items; DEFAULT pending Ashlea's decision #2). Kind and
--         apparatus are LOCKED once the type has a sign-off or a drive (create a new type instead) — so a sign-off
--         can never silently change meaning.
--     sign_qualification(member, type, note)       — is_canmanage_ops() (DA / Officer), not self, member + ACTIVE type
--                                                    in the department; refused if already qualified.
--     revoke_qualification(member, type, reason)   — is_canmanage_ops(), not self, reason required; the row stays.
--     log_qualification_drive(member, type, hours, occurred_on, supervisor?, note?)
--                                                  — the EXACT log_supervised_session gates (is_canmanage_ops, not
--                                                    self, supervisor in the department and never the member, hours
--                                                    0 < h <= 24, a real date not in the future) + an ACTIVE apparatus
--                                                    type of the department. Inserts the supervised_sessions row.
--     my_qualifications()                          — the caller's own: every ACTIVE type with status / drives.
--     dept_qualification_matrix()                  — Board / DA / Officer: types x members (honest denominator: not
--                                                    Inactive, not former, not a Project Admin) + per-cell status.
--   Internal (not callable by members): qualification_cells(dept, member) — the one status rule both reads use.
--
-- STATUS (computed at read, never stored): qualified = a non-revoked sign-off; in_progress = no live sign-off but >= 1
--   non-voided drive counting toward it (apparatus kinds); not_started = neither. A type nobody holds still renders
--   (all not_started); no types = an empty matrix ("No qualifications set up yet") — never a false green.
-- DECISION #1 DEFAULT (pending Ashlea): a qualification drive is still supervised time, so it ALSO counts toward a
--   probation hours item whose source is 'supervised' / 'drive' (probation counts every non-voided session). A drive
--   logged from the probation screen (counts_toward 'probation') does NOT count toward a qualification.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_t text; v_n int;
  v_logss_before text; v_void_before text; v_pstatus_before text; v_pitems_before text; v_board_before text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename NOT IN ('qualification_types', 'member_qualifications')$q$;
  NEW_TABLES constant text[] := array['qualification_types', 'member_qualifications'];
  PUBLIC_FNS constant text[] := array['public.set_qualification_type(uuid,text,text,uuid,integer,integer,boolean)',
    'public.sign_qualification(uuid,uuid,text)', 'public.revoke_qualification(uuid,uuid,text)',
    'public.log_qualification_drive(uuid,uuid,numeric,date,uuid,text)', 'public.my_qualifications()', 'public.dept_qualification_matrix()'];
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.qualification_types') IS NOT NULL OR to_regclass('public.member_qualifications') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: a qualifications table already exists — already applied. Nothing changed.';
  END IF;
  FOREACH v_t IN ARRAY array['is_canmanage()', 'is_canmanage_ops()', 'is_dept_admin()'] LOOP
    IF to_regprocedure('public.' || v_t) IS NULL OR position('my_department_id()' in pg_get_functiondef(('public.' || v_t)::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: % is missing or no longer department-scoped.', v_t;
    END IF;
  END LOOP;
  IF to_regclass('public.supervised_sessions') IS NULL OR to_regprocedure('public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.void_supervised_session(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: the probation drive store (supervised_sessions + log/void RPCs) is not applied.';
  END IF;
  FOR v_t IN SELECT x FROM unnest(array['supervised_sessions.counts_toward:text', 'supervised_sessions.voided_at:timestamp with time zone',
      'apparatus.department_id:uuid', 'apparatus.deleted_at:timestamp with time zone', 'apparatus.name:text', 'members.access:ARRAY']) x LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = split_part(split_part(v_t, ':', 1), '.', 1) AND column_name = split_part(split_part(v_t, ':', 1), '.', 2)
                     AND data_type = split_part(v_t, ':', 2)) THEN
      RAISE EXCEPTION 'Precondition failed: column % is missing or not the expected type.', v_t;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.supervised_sessions'::regclass AND conname = 'supervised_sessions_kind_check'
                   AND position('drive' in pg_get_constraintdef(oid)) > 0) THEN
    RAISE EXCEPTION 'Precondition failed: supervised_sessions no longer accepts kind ''drive''.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;
  v_logss_before := pg_get_functiondef('public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text)'::regprocedure);
  v_void_before := pg_get_functiondef('public.void_supervised_session(uuid,text)'::regprocedure);
  v_pstatus_before := pg_get_functiondef('public.probation_status(uuid,uuid)'::regprocedure);
  v_pitems_before := pg_get_functiondef('public.probation_item_states(uuid,uuid)'::regprocedure);
  v_board_before := pg_get_functiondef('public.dept_probation_board()'::regprocedure);

  -- ---------------------------------------------------------------- 1-2. the tables
  CREATE TABLE public.qualification_types (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id    uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    kind             text NOT NULL CHECK (kind IN ('apparatus_driver', 'apparatus_operator', 'position')),
    apparatus_id     uuid,                       -- no FK: apparatus is soft-deleted; the RPC checks dept + not deleted
    threshold_drives integer CHECK (threshold_drives IS NULL OR threshold_drives BETWEEN 1 AND 1000),
    sort_order       integer NOT NULL DEFAULT 0,
    active           boolean NOT NULL DEFAULT true,
    created_by       uuid,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT qualification_types_apparatus_chk CHECK ((kind = 'position') = (apparatus_id IS NULL)),
    CONSTRAINT qualification_types_threshold_chk CHECK (kind <> 'position' OR threshold_drives IS NULL)
  );
  CREATE UNIQUE INDEX qualification_types_dept_name_uq ON public.qualification_types (department_id, lower(btrim(name)));
  CREATE TABLE public.member_qualifications (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id             uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    department_id         uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    qualification_type_id uuid NOT NULL REFERENCES public.qualification_types(id) ON DELETE CASCADE,
    signed_off_by         uuid NOT NULL,
    signed_off_at         timestamptz NOT NULL DEFAULT now(),
    note                  text CHECK (note IS NULL OR length(note) <= 500),
    revoked_at            timestamptz,
    revoked_by            uuid,
    revoke_reason         text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 300),
    CONSTRAINT member_qualifications_revoke_chk CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
    UNIQUE (member_id, qualification_type_id)
  );
  CREATE INDEX member_qualifications_dept_idx ON public.member_qualifications (department_id, qualification_type_id);
  CREATE INDEX supervised_sessions_counts_toward_idx ON public.supervised_sessions (counts_toward) WHERE voided_at IS NULL;
  COMMENT ON TABLE public.qualification_types IS 'B4C:qualifications — each department''s own qualification list. Writes: set_qualification_type only.';
  COMMENT ON TABLE public.member_qualifications IS 'B4C:qualifications — officer sign-offs (revoked_at NULL = qualified; revokes keep the row). Writes: sign_/revoke_qualification only.';

  FOREACH v_t IN ARRAY NEW_TABLES LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, public', v_t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_t);
  END LOOP;
  CREATE POLICY qualification_types_read ON public.qualification_types FOR SELECT TO authenticated
    USING (department_id = public.my_department_id());
  CREATE POLICY member_qualifications_read ON public.member_qualifications FOR SELECT TO authenticated
    USING (department_id = public.my_department_id() AND (member_id = public.my_member_id() OR public.is_canmanage()));

  -- ---------------------------------------------------------------- internal: the one status rule
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.qualification_cells(p_dept uuid, p_member uuid DEFAULT NULL)
 RETURNS TABLE(member_id uuid, type_id uuid, status text, drives integer, signed_off_by_name text, signed_off_at timestamptz,
               note text, revoked_at timestamptz, revoked_by_name text, revoke_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications (internal) — every ACTIVE type of the department x the given member (or the honest roster:
-- not Inactive, not former, not a Project Admin). Read-only.
  with mem as (
    select m.id from public.members m
     where m.department_id = p_dept
       and (case when p_member is not null then m.id = p_member
                 else m.status is distinct from 'Inactive'
                      and not coalesce(m.access && array['Project Admin']::text[], false)
                      and not exists (select 1 from public.member_separation s where s.member_id = m.id) end)
  ),
  ty as (select t.id, t.kind from public.qualification_types t where t.department_id = p_dept and t.active),
  dr as (select ss.member_id, ss.counts_toward, count(*)::int as n from public.supervised_sessions ss
          where ss.department_id = p_dept and ss.voided_at is null and ss.kind = 'drive'
          group by ss.member_id, ss.counts_toward)
  select mem.id, ty.id,
         case when q.id is not null and q.revoked_at is null then 'qualified'
              when coalesce(dr.n, 0) > 0 then 'in_progress'
              else 'not_started' end,
         coalesce(dr.n, 0),
         sb.name, q.signed_off_at, q.note, q.revoked_at, rb.name, q.revoke_reason
    from mem cross join ty
    left join public.member_qualifications q on q.member_id = mem.id and q.qualification_type_id = ty.id and q.department_id = p_dept
    left join dr on dr.member_id = mem.id and dr.counts_toward = ty.id::text
    left join public.members sb on sb.id = q.signed_off_by
    left join public.members rb on rb.id = q.revoked_by;
$function$
$ddl$;

  -- ---------------------------------------------------------------- config (DA / PA)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_qualification_type(p_id uuid, p_name text, p_kind text, p_apparatus_id uuid DEFAULT NULL,
    p_threshold_drives integer DEFAULT NULL, p_sort_order integer DEFAULT 0, p_active boolean DEFAULT true)
 RETURNS public.qualification_types
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications — a Department Admin configures the department's own qualification list (create when p_id is
-- NULL, else edit). Kind + apparatus are locked once the type has a sign-off or a drive. Never touches the locked
-- verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.qualification_types; v_used boolean;
        v_name text := btrim(coalesce(p_name, ''));
begin
  if v_dept is null or not coalesce(public.is_dept_admin(), false) then
    raise exception 'Only a Department Admin can set up qualifications.';
  end if;
  if v_name = '' or length(v_name) > 80 then raise exception 'Give the qualification a name (up to 80 characters).'; end if;
  if p_kind is null or p_kind not in ('apparatus_driver', 'apparatus_operator', 'position') then raise exception 'Unknown qualification kind.'; end if;
  if p_kind = 'position' then
    if p_apparatus_id is not null then raise exception 'A position qualification isn''t tied to an apparatus.'; end if;
    if p_threshold_drives is not null then raise exception 'A drive target only applies to apparatus qualifications.'; end if;
  else
    if p_apparatus_id is null then raise exception 'Pick the apparatus this qualification is for.'; end if;
    -- in the department; and not deleted — unless it's the apparatus the type already has (a type on a since-retired
    -- rig can still be renamed or deactivated)
    if not exists (select 1 from public.apparatus a where a.id = p_apparatus_id and a.department_id = v_dept
                     and (a.deleted_at is null or exists (select 1 from public.qualification_types t
                                                           where t.id = p_id and t.department_id = v_dept and t.apparatus_id = p_apparatus_id))) then
      raise exception 'That apparatus is not in your department.';
    end if;
    if p_threshold_drives is not null and (p_threshold_drives < 1 or p_threshold_drives > 1000) then
      raise exception 'The drive target must be between 1 and 1000.';
    end if;
  end if;
  if exists (select 1 from public.qualification_types t where t.department_id = v_dept and lower(btrim(t.name)) = lower(v_name)
               and t.id is distinct from p_id) then
    raise exception 'Your department already has a qualification with that name.';
  end if;
  if p_id is null then
    insert into public.qualification_types (department_id, name, kind, apparatus_id, threshold_drives, sort_order, active, created_by)
    values (v_dept, v_name, p_kind, p_apparatus_id, p_threshold_drives, coalesce(p_sort_order, 0), coalesce(p_active, true), v_me)
    returning * into v_row;
    return v_row;
  end if;
  select * into v_row from public.qualification_types where id = p_id and department_id = v_dept for update;
  if not found then raise exception 'That qualification is not in your department.'; end if;
  v_used := exists (select 1 from public.member_qualifications q where q.qualification_type_id = p_id)
         or exists (select 1 from public.supervised_sessions ss where ss.counts_toward = p_id::text);
  if v_used and (p_kind is distinct from v_row.kind or p_apparatus_id is distinct from v_row.apparatus_id) then
    raise exception 'This qualification already has sign-offs or drives — its kind and apparatus can''t change. Create a new one instead.';
  end if;
  update public.qualification_types
     set name = v_name, kind = p_kind, apparatus_id = p_apparatus_id, threshold_drives = p_threshold_drives,
         sort_order = coalesce(p_sort_order, sort_order), active = coalesce(p_active, active), updated_at = now()
   where id = p_id returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- sign-off / revoke (DA / Officer, custody)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.sign_qualification(p_member_id uuid, p_qualification_type_id uuid, p_note text DEFAULT NULL)
 RETURNS public.member_qualifications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications — a DA / Officer signs a member of their department off on an active qualification. Never their
-- own (custody). The drive target is guidance — the officer's judgment decides. Never touches the locked verification
-- column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.member_qualifications;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can sign off a qualification.';
  end if;
  if p_member_id = v_me then raise exception 'You can''t sign off your own qualification — another officer does.'; end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if not exists (select 1 from public.qualification_types where id = p_qualification_type_id and department_id = v_dept and active) then
    raise exception 'That qualification is not set up in your department.';
  end if;
  if p_note is not null and length(p_note) > 500 then raise exception 'Keep the note under 500 characters.'; end if;
  select * into v_row from public.member_qualifications where member_id = p_member_id and qualification_type_id = p_qualification_type_id for update;
  if found and v_row.revoked_at is null then raise exception 'They''re already signed off on this qualification.'; end if;
  insert into public.member_qualifications (member_id, department_id, qualification_type_id, signed_off_by, signed_off_at, note)
  values (p_member_id, v_dept, p_qualification_type_id, v_me, now(), nullif(btrim(p_note), ''))
  on conflict (member_id, qualification_type_id) do update
     set signed_off_by = excluded.signed_off_by, signed_off_at = excluded.signed_off_at, note = excluded.note,
         revoked_at = null, revoked_by = null, revoke_reason = null
  returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.revoke_qualification(p_member_id uuid, p_qualification_type_id uuid, p_reason text)
 RETURNS public.member_qualifications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications — a DA / Officer revokes a sign-off with a reason. The row stays (audit). Never their own.
-- Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.member_qualifications;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can revoke a qualification.';
  end if;
  if p_member_id = v_me then raise exception 'You can''t revoke your own qualification — another officer does.'; end if;
  select * into v_row from public.member_qualifications
   where member_id = p_member_id and qualification_type_id = p_qualification_type_id and department_id = v_dept for update;
  if not found or v_row.revoked_at is not null then raise exception 'They aren''t currently signed off on that qualification in your department.'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it''s being revoked.'; end if;
  if length(p_reason) > 300 then raise exception 'Keep the reason under 300 characters.'; end if;
  update public.member_qualifications set revoked_at = now(), revoked_by = v_me, revoke_reason = btrim(p_reason)
   where id = v_row.id returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- a drive toward a qualification (the probation store)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.log_qualification_drive(p_member_id uuid, p_qualification_type_id uuid, p_hours numeric, p_occurred_on date,
    p_supervisor_id uuid DEFAULT NULL, p_note text DEFAULT NULL)
 RETURNS public.supervised_sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications — a DA / Officer logs a supervised drive toward an apparatus qualification. The SAME gates as
-- log_supervised_session; writes the same supervised_sessions row (kind 'drive', the type's apparatus, counts_toward =
-- the type id). Correct it with void_supervised_session. Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
        v_sup uuid := coalesce(p_supervisor_id, public.my_member_id()); v_type public.qualification_types; v_row public.supervised_sessions;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can log supervised time.';
  end if;
  if p_member_id = v_me then raise exception 'You can''t log your own supervised time — an officer does.'; end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if v_sup = p_member_id then raise exception 'A member can''t supervise themself.'; end if;
  if not exists (select 1 from public.members where id = v_sup and department_id = v_dept) then
    raise exception 'The supervisor must be a member of your department.';
  end if;
  select * into v_type from public.qualification_types where id = p_qualification_type_id and department_id = v_dept and active;
  if not found then raise exception 'That qualification is not set up in your department.'; end if;
  if v_type.kind = 'position' or v_type.apparatus_id is null then raise exception 'Drives are logged against an apparatus qualification.'; end if;
  if p_hours is null or p_hours <= 0 or p_hours > 24 then raise exception 'Hours must be more than 0 and at most 24.'; end if;
  if p_occurred_on is null or p_occurred_on < date '2000-01-01' or p_occurred_on > (now() at time zone 'America/Chicago')::date then
    raise exception 'The date must be a real date, and not in the future.';
  end if;
  if p_note is not null and length(p_note) > 500 then raise exception 'Keep the note under 500 characters.'; end if;
  insert into public.supervised_sessions (department_id, member_id, kind, apparatus_id, hours, occurred_on, supervisor_id, counts_toward, note, created_by)
  values (v_dept, p_member_id, 'drive', v_type.apparatus_id, p_hours, p_occurred_on, v_sup, v_type.id::text, nullif(btrim(p_note), ''), v_me)
  returning * into v_row;
  return v_row;
end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- reads
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.my_qualifications()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications — the caller's own qualifications: every active type of their department with status + drives.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
begin
  if v_dept is null or v_me is null then raise exception 'We could not match your login to a department.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('type_id', t.id, 'name', t.name, 'kind', t.kind, 'apparatus_id', t.apparatus_id,
             'apparatus_name', a.name, 'threshold_drives', t.threshold_drives, 'status', c.status, 'drives', c.drives,
             'signed_off_by_name', case when c.status = 'qualified' then c.signed_off_by_name end,
             'signed_off_at', case when c.status = 'qualified' then c.signed_off_at end) order by t.sort_order, t.name)
      from public.qualification_cells(v_dept, v_me) c
      join public.qualification_types t on t.id = c.type_id
      left join public.apparatus a on a.id = t.apparatus_id), '[]'::jsonb);
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_qualification_matrix()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications — Board / DA / Officer: who can do what. types (active, ordered) x members (honest denominator:
-- not Inactive, not former, not a Project Admin) + one cell per pair. Read-only.
declare v_dept uuid := public.my_department_id();
begin
  if v_dept is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see the qualification matrix.';
  end if;
  return jsonb_build_object(
    'types', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'kind', t.kind, 'apparatus_id', t.apparatus_id,
                         'apparatus_name', a.name, 'threshold_drives', t.threshold_drives, 'sort_order', t.sort_order) order by t.sort_order, t.name)
                         from public.qualification_types t left join public.apparatus a on a.id = t.apparatus_id
                        where t.department_id = v_dept and t.active), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object('member_id', m.id, 'name', m.name, 'status', m.status) order by m.name)
                           from public.members m
                          where m.department_id = v_dept and m.status is distinct from 'Inactive'
                            and not coalesce(m.access && array['Project Admin']::text[], false)
                            and not exists (select 1 from public.member_separation s where s.member_id = m.id)), '[]'::jsonb),
    'cells', coalesce((select jsonb_agg(to_jsonb(c)) from public.qualification_cells(v_dept, null) c), '[]'::jsonb));
end;
$function$
$ddl$;

  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_t);
  END LOOP;
  REVOKE EXECUTE ON FUNCTION public.qualification_cells(uuid, uuid) FROM anon, authenticated, public;

  -- ---------------------------------------------------------------- post-conditions (any failure undoes everything)
  FOREACH v_t IN ARRAY NEW_TABLES LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass) THEN RAISE EXCEPTION 'Post-condition failed: RLS off on %.', v_t; END IF;
    IF has_table_privilege('authenticated', 'public.' || v_t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || v_t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'DELETE') OR has_table_privilege('anon', 'public.' || v_t, 'SELECT') THEN
      RAISE EXCEPTION 'Post-condition failed: % has a write grant for authenticated, or anon can read it.', v_t;
    END IF;
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t) <> 1
       OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t AND cmd = 'SELECT' AND position('my_department_id()' in qual) > 0) <> 1 THEN
      RAISE EXCEPTION 'Post-condition failed: % must have exactly one department-scoped SELECT policy and no write policy.', v_t;
    END IF;
  END LOOP;
  IF position('is_canmanage()' in (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_qualifications')) = 0
     OR position('my_member_id()' in (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_qualifications')) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: member_qualifications must be own-row or leadership only.';
  END IF;
  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-condition failed: % grants are wrong (anon must not, authenticated must).', v_t;
    END IF;
    IF position('is_leader()' in pg_get_functiondef(v_t::regprocedure)) > 0 THEN RAISE EXCEPTION 'Post-condition failed: % uses is_leader().', v_t; END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.qualification_cells(uuid,uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.qualification_cells(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: the internal qualification_cells is callable by members.';
  END IF;
  -- custody + gates on every write
  IF position('p_member_id = v_me' in pg_get_functiondef('public.sign_qualification(uuid,uuid,text)'::regprocedure)) = 0
     OR position('p_member_id = v_me' in pg_get_functiondef('public.revoke_qualification(uuid,uuid,text)'::regprocedure)) = 0
     OR position('p_member_id = v_me' in pg_get_functiondef('public.log_qualification_drive(uuid,uuid,numeric,date,uuid,text)'::regprocedure)) = 0
     OR position('v_sup = p_member_id' in pg_get_functiondef('public.log_qualification_drive(uuid,uuid,numeric,date,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: a write RPC lost its not-self (custody) check.';
  END IF;
  IF position('is_canmanage_ops()' in pg_get_functiondef('public.sign_qualification(uuid,uuid,text)'::regprocedure)) = 0
     OR position('is_canmanage_ops()' in pg_get_functiondef('public.revoke_qualification(uuid,uuid,text)'::regprocedure)) = 0
     OR position('is_canmanage_ops()' in pg_get_functiondef('public.log_qualification_drive(uuid,uuid,numeric,date,uuid,text)'::regprocedure)) = 0
     OR position('is_dept_admin()' in pg_get_functiondef('public.set_qualification_type(uuid,text,text,uuid,integer,integer,boolean)'::regprocedure)) = 0
     OR position('is_canmanage()' in pg_get_functiondef('public.dept_qualification_matrix()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: a qualification RPC lost its gate.';
  END IF;
  IF position('voided_at is null' in pg_get_functiondef('public.qualification_cells(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: a voided drive could still count.';
  END IF;
  -- the probation layer this reuses is untouched
  IF pg_get_functiondef('public.log_supervised_session(uuid,text,numeric,date,uuid,uuid,text)'::regprocedure) IS DISTINCT FROM v_logss_before
     OR pg_get_functiondef('public.void_supervised_session(uuid,text)'::regprocedure) IS DISTINCT FROM v_void_before
     OR pg_get_functiondef('public.probation_status(uuid,uuid)'::regprocedure) IS DISTINCT FROM v_pstatus_before
     OR pg_get_functiondef('public.probation_item_states(uuid,uuid)'::regprocedure) IS DISTINCT FROM v_pitems_before
     OR pg_get_functiondef('public.dept_probation_board()'::regprocedure) IS DISTINCT FROM v_board_before THEN
    RAISE EXCEPTION 'Post-condition failed: a probation function changed.';
  END IF;
  IF has_table_privilege('authenticated', 'public.supervised_sessions', 'INSERT') OR has_table_privilege('authenticated', 'public.supervised_sessions', 'UPDATE') THEN
    RAISE EXCEPTION 'Post-condition failed: supervised_sessions gained a client write grant.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT') THEN
    RAISE EXCEPTION 'Post-condition failed: the onboarding_progress transition-state grant was removed.';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a pre-existing policy changed.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: tables 2 · rls true · new_policies 2 · fns 6 · anon_exec false · internal_exec false ·
-- types 0 · signoffs 0 · total_policies 165 (163 + 2)
SELECT (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('public.qualification_types'), to_regclass('public.member_qualifications'))) AS tables,
       (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN (to_regclass('public.qualification_types'), to_regclass('public.member_qualifications'))) AS rls,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('qualification_types', 'member_qualifications')) AS new_policies,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_qualification_type', 'sign_qualification',
          'revoke_qualification', 'log_qualification_drive', 'my_qualifications', 'dept_qualification_matrix')) AS fns,
       has_function_privilege('anon', 'public.dept_qualification_matrix()', 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.qualification_cells(uuid,uuid)', 'EXECUTE') AS internal_exec,
       (SELECT count(*) FROM public.qualification_types) AS types,
       (SELECT count(*) FROM public.member_qualifications) AS signoffs,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately). Drops the qualification lists + sign-offs (export first). Drives toward a
-- qualification stay in supervised_sessions (their counts_toward then points at nothing — harmless).
-- DO $rb$ BEGIN
--   DROP FUNCTION IF EXISTS public.dept_qualification_matrix(), public.my_qualifications(),
--     public.log_qualification_drive(uuid,uuid,numeric,date,uuid,text), public.revoke_qualification(uuid,uuid,text),
--     public.sign_qualification(uuid,uuid,text), public.set_qualification_type(uuid,text,text,uuid,integer,integer,boolean),
--     public.qualification_cells(uuid,uuid);
--   DROP INDEX IF EXISTS public.supervised_sessions_counts_toward_idx;
--   DROP TABLE IF EXISTS public.member_qualifications, public.qualification_types;
-- END $rb$;
-- NOTIFY pgrst, 'reload schema';
