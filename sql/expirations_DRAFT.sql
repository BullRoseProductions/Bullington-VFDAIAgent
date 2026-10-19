-- =====================================================================
-- PHASE 3.1 #4 — EXPIRATIONS (DB slice): member credentials + turnout gear lifecycle + apparatus annual tests, and one
-- ranked expirations read that UNIONs them with the EXISTING certs.
-- Record: Claude gate review PASS 2026-10-18 on a0c8ac2 (recorded BEFORE apply). Not yet applied. Call-outs ruled:
-- undated -> no_date everywhere (keep); gear/apparatus dept-wide vs credentials own-or-leadership (accepted); the 30-day
-- 'soon' vs the 3-month cert badge -> the UI aligns off days_until; fixed result vocabulary (agreed). Test: sql/expirations_RETEST.sql (run AFTER, separately).
-- Build order: claude/B4C_Phase3.1_Expirations_BuildOrder.md (decisions Oct 19). Step 0: sql/expirations_STEP0_CHECK.sql.
--
-- THE GUARDRAIL (non-negotiable): dates, class and pass/fail status ONLY. member_credentials has a short `label` and an
-- optional short `cls` — NO number / scan / document / file / image / notes column, and a post-condition fails this
-- migration if one ever appears. label and cls also REFUSE any run of 5+ digits (CHECK + RPC), so a license or card
-- number can't be typed in as "class" either. Never touches the locked verification column.
--
-- WHAT CHANGES:
--   1. member_credentials (license | med_card | fit_test | other; label, cls, issued_on, expires_on — real dates)
--   2. gear_items (NFPA 1851: in_service_on -> 10-year life, annual inspection; member_id NULLABLE = pool gear;
--      retired_at = soft-retire)
--   3. apparatus_tests (pump | ladder | hose | other; tested_on, next_due_on, result pass | fail | pass_with_repairs;
--      FK -> apparatus)
--   All three: RLS on, SELECT-only grant, ONE read policy, zero write policies / grants; department_id NOT NULL; audit cols.
--     member_credentials: own row, or Board / DA / Officer of the department (is_canmanage()) — they're about a person.
--     gear_items, apparatus_tests: the department (like apparatus itself).
--   Writes — SECURITY DEFINER, is_canmanage_ops() (DA / Officer) + everything checked against the CALLER's department
--   (the member, the gear row, the apparatus — which must not be deleted). A plain member is refused every one:
--     set_member_credential(p_id, member, kind, label, cls, issued_on, expires_on)  · delete_member_credential(p_id)
--     set_gear_item(p_id, member?, label, in_service_on, last_inspected_on, next_inspection_on) · retire_gear_item(p_id)
--     log_gear_inspection(p_id, inspected_on)  — last_inspected_on = it, next_inspection_on = it + 1 year
--     set_apparatus_test(p_id, apparatus, test_type, tested_on, next_due_on, result) · delete_apparatus_test(p_id)
--     Deletes are HARD deletes — the app's convention for admin records of this kind (delete_cert). No trail required.
--   Reads:
--     dept_expirations()  — Board / DA / Officer (is_canmanage()); the dashboard.
--     my_expirations()    — the caller's own (their certs, credentials, assigned gear).
--   Internal (not callable by members): expiration_rows(dept, member).
--
-- THE RANKED READ (computed, America/Chicago):
--   sources: certs (ONLY — never cert_submissions: a pending submission isn't a credential yet) · member_credentials ·
--   gear_items (expiry = the NEARER of next_inspection_on and in_service_on + 10 years) · apparatus_tests (next_due_on).
--   certs.exp 'YYYY-MM' -> the LAST DAY of that month (good through month-end). Blank / malformed exp -> no_date.
--   Any other row with no date at all -> no_date too (an undated item is a gap to fix, never "current").
--   bucket: expired (< today) · no_date · soon (0..30 days) · current. Ranked expired -> no_date -> soon -> current, then
--   soonest first. Honest denominator: rows of Inactive / separated (member_separation) / Project Admin members are left
--   out (same as the probation + qualification reads); retired gear and deleted apparatus are left out.
-- DRY RUN 2026-10-18 (PGlite; §6 seed: two departments, DA + Officer + two members each, a rig, a 'YYYY-MM' cert, a
-- blank-exp cert, a PENDING cert_submissions row, a separated member): RETEST 17 passed / 0 failed / 1 skipped. Mutations,
-- each caught: (a) a member through a write gate -> W1 · (b) a credential for another department's member -> W3 · (c) a
-- test on a deleted rig: write -> W3, read -> D1 · (d) a kind off the check set -> W3 · (e) cert_submissions unioned in ->
-- the post-condition rolls back; with it removed -> D1 · (f) a notes / license_number column -> the guardrail
-- post-condition rolls back · number-as-class guard removed -> W3 · Inactive counted -> D2 · 'YYYY-MM' -> the 1st -> D1 ·
-- undated read as current -> D1 · the 10-year gear rule dropped -> D1 · a write RPC left INVOKER -> rolls back · re-run -> refused.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_t text; v_n int; v_total_before int;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename NOT IN ('member_credentials', 'gear_items', 'apparatus_tests')$q$;
  NEW_TABLES constant text[] := array['member_credentials', 'gear_items', 'apparatus_tests'];
  PUBLIC_FNS constant text[] := array[
    'public.set_member_credential(uuid,uuid,text,text,text,date,date)', 'public.delete_member_credential(uuid)',
    'public.set_gear_item(uuid,uuid,text,date,date,date)', 'public.retire_gear_item(uuid)', 'public.log_gear_inspection(uuid,date)',
    'public.set_apparatus_test(uuid,uuid,text,date,date,text)', 'public.delete_apparatus_test(uuid)',
    'public.dept_expirations()', 'public.my_expirations()'];
  WRITE_FNS constant text[] := array[
    'public.set_member_credential(uuid,uuid,text,text,text,date,date)', 'public.delete_member_credential(uuid)',
    'public.set_gear_item(uuid,uuid,text,date,date,date)', 'public.retire_gear_item(uuid)', 'public.log_gear_inspection(uuid,date)',
    'public.set_apparatus_test(uuid,uuid,text,date,date,text)', 'public.delete_apparatus_test(uuid)'];
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.member_credentials') IS NOT NULL OR to_regclass('public.gear_items') IS NOT NULL OR to_regclass('public.apparatus_tests') IS NOT NULL
     OR to_regprocedure('public.dept_expirations()') IS NOT NULL OR to_regprocedure('public.my_expirations()') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: an expirations table or read already exists — already applied. Nothing changed.';
  END IF;
  FOREACH v_t IN ARRAY array['is_canmanage()', 'is_canmanage_ops()'] LOOP
    IF to_regprocedure('public.' || v_t) IS NULL OR position('my_department_id()' in pg_get_functiondef(('public.' || v_t)::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: % is missing or no longer department-scoped.', v_t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.my_member_id()') IS NULL OR to_regprocedure('public.my_department_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_member_id() / my_department_id() missing.';
  END IF;
  FOR v_t IN SELECT x FROM unnest(array['certs.exp:text', 'certs.name:text', 'certs.member_id:uuid', 'certs.department_id:uuid',
      'apparatus.id:uuid', 'apparatus.department_id:uuid', 'apparatus.deleted_at:timestamp with time zone', 'apparatus.name:text',
      'members.status:text', 'members.access:ARRAY', 'member_separation.member_id:uuid']) x LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = split_part(split_part(v_t, ':', 1), '.', 1) AND column_name = split_part(split_part(v_t, ':', 1), '.', 2)
                     AND data_type = split_part(v_t, ':', 2)) THEN
      RAISE EXCEPTION 'Precondition failed: column % is missing or not the expected type.', v_t;
    END IF;
  END LOOP;
  EXECUTE pol_sql INTO v_pol_before;
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';

  -- ---------------------------------------------------------------- 1-3. the tables
  CREATE TABLE public.member_credentials (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    member_id     uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('license', 'med_card', 'fit_test', 'other')),
    label         text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80 AND label !~ '\d{5,}'),
    cls           text CHECK (cls IS NULL OR (length(btrim(cls)) BETWEEN 1 AND 40 AND cls !~ '\d{5,}')),   -- class ONLY, never a number
    issued_on     date,
    expires_on    date,
    created_by    uuid, created_at timestamptz NOT NULL DEFAULT now(),
    updated_by    uuid, updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT member_credentials_dates_chk CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
  );
  CREATE TABLE public.gear_items (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id      uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    member_id          uuid REFERENCES public.members(id) ON DELETE SET NULL,   -- NULL = pool / unassigned gear
    label              text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
    in_service_on      date,                                                   -- -> the 10-year retire date (NFPA 1851)
    last_inspected_on  date,
    next_inspection_on date,
    retired_at         timestamptz,                                            -- soft-retire
    created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.apparatus_tests (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    apparatus_id  uuid NOT NULL REFERENCES public.apparatus(id) ON DELETE CASCADE,
    test_type     text NOT NULL CHECK (test_type IN ('pump', 'ladder', 'hose', 'other')),
    tested_on     date NOT NULL,
    next_due_on   date,
    result        text NOT NULL CHECK (result IN ('pass', 'fail', 'pass_with_repairs')),   -- a status, never free text
    created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT apparatus_tests_dates_chk CHECK (next_due_on IS NULL OR next_due_on >= tested_on)
  );
  CREATE INDEX member_credentials_member_idx ON public.member_credentials (department_id, member_id);
  CREATE INDEX gear_items_dept_idx ON public.gear_items (department_id) WHERE retired_at IS NULL;
  CREATE INDEX apparatus_tests_app_idx ON public.apparatus_tests (department_id, apparatus_id);
  COMMENT ON TABLE public.member_credentials IS 'B4C:expirations — dates + class ONLY (never a number / scan / medical detail). Writes: set_ / delete_member_credential.';
  COMMENT ON TABLE public.gear_items IS 'B4C:expirations — turnout gear lifecycle (10-yr life + annual inspection). Writes: set_gear_item / retire_gear_item / log_gear_inspection.';
  COMMENT ON TABLE public.apparatus_tests IS 'B4C:expirations — annual pump / ladder / hose tests. Writes: set_ / delete_apparatus_test.';

  FOREACH v_t IN ARRAY NEW_TABLES LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, public', v_t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_t);
  END LOOP;
  CREATE POLICY member_credentials_read ON public.member_credentials FOR SELECT TO authenticated
    USING (department_id = public.my_department_id() AND (member_id = public.my_member_id() OR public.is_canmanage()));
  CREATE POLICY gear_items_read ON public.gear_items FOR SELECT TO authenticated USING (department_id = public.my_department_id());
  CREATE POLICY apparatus_tests_read ON public.apparatus_tests FOR SELECT TO authenticated USING (department_id = public.my_department_id());

  -- ---------------------------------------------------------------- internal: the one ranked read
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.expiration_rows(p_dept uuid, p_member uuid DEFAULT NULL)
 RETURNS TABLE(scope text, source text, item_id uuid, member_id uuid, apparatus_id uuid, subject text, kind text, label text,
               cls text, expires_on date, days_until integer, bucket text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations (internal) — certs (approved ONLY; never the pending-submission queue) + member_credentials + gear_items + apparatus_tests,
-- one row each, bucketed + ranked. p_member NULL = the department (honest roster); else that member's own rows.
  with td as (select (now() at time zone 'America/Chicago')::date as d),
  people as (
    select m.id, m.name from public.members m
     where m.department_id = p_dept
       and (case when p_member is not null then m.id = p_member
                 else m.status is distinct from 'Inactive'
                      and not coalesce(m.access && array['Project Admin']::text[], false)
                      and not exists (select 1 from public.member_separation s where s.member_id = m.id) end)
  ),
  raw as (
    -- legacy certs: 'YYYY-MM' -> the last day of that month; anything else -> no date
    select 'member'::text as scope, 'cert'::text as source, c.id as item_id, c.member_id, null::uuid as apparatus_id, p.name as subject,
           'cert'::text as kind, c.name as label, null::text as cls,
           case when c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                then (date_trunc('month', to_date(c.exp || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date end as expires_on
      from public.certs c join people p on p.id = c.member_id
     where c.department_id = p_dept
    union all
    select 'member', 'credential', mc.id, mc.member_id, null, p.name, mc.kind, mc.label, mc.cls, mc.expires_on
      from public.member_credentials mc join people p on p.id = mc.member_id
     where mc.department_id = p_dept
    union all
    select 'gear', 'gear', g.id, g.member_id, null, coalesce(p.name, 'Pool gear'), 'gear', g.label, null,
           nullif(least(coalesce(g.next_inspection_on, 'infinity'::date),
                        coalesce((g.in_service_on + interval '10 years')::date, 'infinity'::date)), 'infinity'::date)
      from public.gear_items g left join people p on p.id = g.member_id
     where g.department_id = p_dept and g.retired_at is null
       and (case when p_member is not null then g.member_id = p_member
                 else g.member_id is null or p.id is not null end)
    union all
    select 'apparatus', 'apparatus_test', t.id, null, t.apparatus_id, a.name, t.test_type, t.test_type || ' test', null, t.next_due_on
      from public.apparatus_tests t join public.apparatus a on a.id = t.apparatus_id and a.department_id = p_dept and a.deleted_at is null
     where t.department_id = p_dept and p_member is null
  )
  select r.scope, r.source, r.item_id, r.member_id, r.apparatus_id, r.subject, r.kind, r.label, r.cls, r.expires_on,
         case when r.expires_on is null then null else (r.expires_on - td.d) end,
         case when r.expires_on is null then 'no_date'
              when r.expires_on < td.d then 'expired'
              when r.expires_on - td.d <= 30 then 'soon'
              else 'current' end
    from raw r cross join td
   order by case when r.expires_on is null then 1 when r.expires_on < td.d then 0 when r.expires_on - td.d <= 30 then 2 else 3 end,
            r.expires_on nulls last, r.subject, r.label;
$function$
$ddl$;

  -- ---------------------------------------------------------------- writes (DA / Officer, the caller's department)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_member_credential(p_id uuid, p_member_id uuid, p_kind text, p_label text, p_cls text DEFAULT NULL,
    p_issued_on date DEFAULT NULL, p_expires_on date DEFAULT NULL)
 RETURNS public.member_credentials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — a DA / Officer records a credential's DATES and CLASS for a member of their department. Never a
-- number, scan or medical detail. Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.member_credentials;
        v_label text := btrim(coalesce(p_label, '')); v_cls text := nullif(btrim(coalesce(p_cls, '')), '');
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can record credentials.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if p_kind is null or p_kind not in ('license', 'med_card', 'fit_test', 'other') then raise exception 'Unknown credential type.'; end if;
  if v_label = '' or length(v_label) > 80 then raise exception 'Name the credential (up to 80 characters).'; end if;
  if v_cls is not null and length(v_cls) > 40 then raise exception 'Keep the class short (up to 40 characters).'; end if;
  if v_label ~ '\d{5,}' or coalesce(v_cls, '') ~ '\d{5,}' then
    raise exception 'Record the class and dates only — never a license or card number.';
  end if;
  if p_issued_on is not null and p_expires_on is not null and p_expires_on < p_issued_on then raise exception 'It can''t expire before it was issued.'; end if;
  if p_id is null then
    insert into public.member_credentials (department_id, member_id, kind, label, cls, issued_on, expires_on, created_by, updated_by)
    values (v_dept, p_member_id, p_kind, v_label, v_cls, p_issued_on, p_expires_on, v_me, v_me) returning * into v_row;
    return v_row;
  end if;
  update public.member_credentials
     set member_id = p_member_id, kind = p_kind, label = v_label, cls = v_cls, issued_on = p_issued_on, expires_on = p_expires_on,
         updated_by = v_me, updated_at = now()
   where id = p_id and department_id = v_dept returning * into v_row;
  if not found then raise exception 'That credential is not in your department.'; end if;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.delete_member_credential(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — a DA / Officer removes a credential record of their department (hard delete, like delete_cert).
declare v_dept uuid := public.my_department_id();
begin
  if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can remove credentials.';
  end if;
  delete from public.member_credentials where id = p_id and department_id = v_dept;
  if not found then raise exception 'That credential is not in your department.'; end if;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_gear_item(p_id uuid, p_member_id uuid, p_label text, p_in_service_on date DEFAULT NULL,
    p_last_inspected_on date DEFAULT NULL, p_next_inspection_on date DEFAULT NULL)
 RETURNS public.gear_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — a DA / Officer records a piece of turnout gear (member NULL = pool gear). Never touches the locked
-- verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.gear_items;
        v_label text := btrim(coalesce(p_label, '')); v_today date := (now() at time zone 'America/Chicago')::date;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can record gear.';
  end if;
  if p_member_id is not null and not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if v_label = '' or length(v_label) > 80 then raise exception 'Name the gear (up to 80 characters).'; end if;
  if p_in_service_on is not null and p_in_service_on > v_today then raise exception 'The in-service date can''t be in the future.'; end if;
  if p_last_inspected_on is not null and p_last_inspected_on > v_today then raise exception 'The inspection date can''t be in the future.'; end if;
  if p_id is null then
    insert into public.gear_items (department_id, member_id, label, in_service_on, last_inspected_on, next_inspection_on, created_by, updated_by)
    values (v_dept, p_member_id, v_label, p_in_service_on, p_last_inspected_on, p_next_inspection_on, v_me, v_me) returning * into v_row;
    return v_row;
  end if;
  update public.gear_items
     set member_id = p_member_id, label = v_label, in_service_on = p_in_service_on, last_inspected_on = p_last_inspected_on,
         next_inspection_on = p_next_inspection_on, updated_by = v_me, updated_at = now()
   where id = p_id and department_id = v_dept and retired_at is null returning * into v_row;
  if not found then raise exception 'That gear is not in your department (or it''s retired).'; end if;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.retire_gear_item(p_id uuid)
 RETURNS public.gear_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — a DA / Officer retires a piece of gear (soft: retired_at). It drops off the expirations list.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.gear_items;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can retire gear.';
  end if;
  update public.gear_items set retired_at = now(), updated_by = v_me, updated_at = now()
   where id = p_id and department_id = v_dept and retired_at is null returning * into v_row;
  if not found then raise exception 'That gear is not in your department (or it''s already retired).'; end if;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.log_gear_inspection(p_id uuid, p_inspected_on date)
 RETURNS public.gear_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — a DA / Officer logs the annual inspection: last_inspected_on = it, next_inspection_on = it + 1 year.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.gear_items;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can log a gear inspection.';
  end if;
  if p_inspected_on is null or p_inspected_on > (now() at time zone 'America/Chicago')::date then
    raise exception 'The inspection date must be a real date, and not in the future.';
  end if;
  update public.gear_items
     set last_inspected_on = p_inspected_on, next_inspection_on = (p_inspected_on + interval '1 year')::date, updated_by = v_me, updated_at = now()
   where id = p_id and department_id = v_dept and retired_at is null returning * into v_row;
  if not found then raise exception 'That gear is not in your department (or it''s retired).'; end if;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_apparatus_test(p_id uuid, p_apparatus_id uuid, p_test_type text, p_tested_on date,
    p_next_due_on date DEFAULT NULL, p_result text DEFAULT 'pass')
 RETURNS public.apparatus_tests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — a DA / Officer records an annual pump / ladder / hose test for a rig of their department (not a
-- deleted one). Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_row public.apparatus_tests;
begin
  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can record apparatus tests.';
  end if;
  if not exists (select 1 from public.apparatus where id = p_apparatus_id and department_id = v_dept and deleted_at is null) then
    raise exception 'That apparatus is not in your department (or it''s retired).';
  end if;
  if p_test_type is null or p_test_type not in ('pump', 'ladder', 'hose', 'other') then raise exception 'Unknown test type.'; end if;
  if p_result is null or p_result not in ('pass', 'fail', 'pass_with_repairs') then raise exception 'The result is pass, fail or pass with repairs.'; end if;
  if p_tested_on is null or p_tested_on > (now() at time zone 'America/Chicago')::date then
    raise exception 'The test date must be a real date, and not in the future.';
  end if;
  if p_next_due_on is not null and p_next_due_on < p_tested_on then raise exception 'The next test can''t be due before this one.'; end if;
  if p_id is null then
    insert into public.apparatus_tests (department_id, apparatus_id, test_type, tested_on, next_due_on, result, created_by, updated_by)
    values (v_dept, p_apparatus_id, p_test_type, p_tested_on, p_next_due_on, p_result, v_me, v_me) returning * into v_row;
    return v_row;
  end if;
  update public.apparatus_tests
     set apparatus_id = p_apparatus_id, test_type = p_test_type, tested_on = p_tested_on, next_due_on = p_next_due_on, result = p_result,
         updated_by = v_me, updated_at = now()
   where id = p_id and department_id = v_dept returning * into v_row;
  if not found then raise exception 'That test is not in your department.'; end if;
  return v_row;
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.delete_apparatus_test(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — a DA / Officer removes an apparatus test record of their department (hard delete).
declare v_dept uuid := public.my_department_id();
begin
  if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then
    raise exception 'Only a Department Admin or Officer can remove apparatus tests.';
  end if;
  delete from public.apparatus_tests where id = p_id and department_id = v_dept;
  if not found then raise exception 'That test is not in your department.'; end if;
end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- reads
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_expirations()
 RETURNS TABLE(scope text, source text, item_id uuid, member_id uuid, apparatus_id uuid, subject text, kind text, label text,
               cls text, expires_on date, days_until integer, bucket text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — Board / DA / Officer: everything in the department that expires, ranked. Read-only.
declare v_dept uuid := public.my_department_id();
begin
  if v_dept is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see the expirations dashboard.';
  end if;
  return query select * from public.expiration_rows(v_dept, null);
end;
$function$
$ddl$;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.my_expirations()
 RETURNS TABLE(scope text, source text, item_id uuid, member_id uuid, apparatus_id uuid, subject text, kind text, label text,
               cls text, expires_on date, days_until integer, bucket text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — the caller's own: their certs, credentials and assigned gear, ranked. Read-only.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
begin
  if v_dept is null or v_me is null then raise exception 'We could not match your login to a department.'; end if;
  return query select * from public.expiration_rows(v_dept, v_me);
end;
$function$
$ddl$;

  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_t);
  END LOOP;
  REVOKE EXECUTE ON FUNCTION public.expiration_rows(uuid, uuid) FROM anon, authenticated, public;

  -- ---------------------------------------------------------------- post-conditions (any failure undoes everything)
  -- THE GUARDRAIL: no column on member_credentials that could hold a number, a scan or free text
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'member_credentials'
     AND column_name ~* '(number|num$|_no$|scan|document|doc$|file|image|photo|note|attach|upload|medical|diagnos)';
  IF v_n > 0 THEN RAISE EXCEPTION 'Post-condition failed (guardrail): member_credentials has a number / scan / document / notes-style column. Dates + class ONLY. Rolling back.'; END IF;
  IF (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_credentials')
     IS DISTINCT FROM array['cls', 'created_at', 'created_by', 'department_id', 'expires_on', 'id', 'issued_on', 'kind', 'label', 'member_id', 'updated_at', 'updated_by'] THEN
    RAISE EXCEPTION 'Post-condition failed (guardrail): member_credentials columns are not exactly the approved set. Rolling back.';
  END IF;
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
  IF position('is_canmanage()' in (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_credentials')) = 0
     OR position('my_member_id()' in (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_credentials')) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: member_credentials must be own-row or leadership only.';
  END IF;
  FOREACH v_t IN ARRAY PUBLIC_FNS LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_t, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-condition failed: % grants are wrong (anon must not, authenticated must).', v_t;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_t::regprocedure) THEN RAISE EXCEPTION 'Post-condition failed: % is not SECURITY DEFINER.', v_t; END IF;
    IF position('is_leader()' in pg_get_functiondef(v_t::regprocedure)) > 0 THEN RAISE EXCEPTION 'Post-condition failed: % uses is_leader().', v_t; END IF;
  END LOOP;
  FOREACH v_t IN ARRAY WRITE_FNS LOOP
    IF position('is_canmanage_ops()' in pg_get_functiondef(v_t::regprocedure)) = 0 OR position('v_dept' in pg_get_functiondef(v_t::regprocedure)) = 0 THEN
      RAISE EXCEPTION 'Post-condition failed: % lost its DA / Officer gate or its department scope.', v_t;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.expiration_rows(uuid,uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.expiration_rows(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: the internal expiration_rows is callable by members.';
  END IF;
  IF position('cert_submissions' in pg_get_functiondef('public.expiration_rows(uuid,uuid)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'Post-condition failed: the expirations read references cert_submissions (it must UNION certs only).';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a pre-existing policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before + 3 THEN
    RAISE EXCEPTION 'Post-condition failed: expected exactly 3 new policies.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: tables 3 · rls true · new_policies 3 · fns 9 · all_definer true · anon_exec false ·
-- internal_exec false · guardrail_cols 0 · total_policies 168 (165 + 3)
SELECT (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('public.member_credentials'), to_regclass('public.gear_items'), to_regclass('public.apparatus_tests'))) AS tables,
       (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN (to_regclass('public.member_credentials'), to_regclass('public.gear_items'), to_regclass('public.apparatus_tests'))) AS rls,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('member_credentials', 'gear_items', 'apparatus_tests')) AS new_policies,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_member_credential', 'delete_member_credential',
          'set_gear_item', 'retire_gear_item', 'log_gear_inspection', 'set_apparatus_test', 'delete_apparatus_test', 'dept_expirations', 'my_expirations')) AS fns,
       (SELECT bool_and(prosecdef) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_member_credential', 'delete_member_credential',
          'set_gear_item', 'retire_gear_item', 'log_gear_inspection', 'set_apparatus_test', 'delete_apparatus_test', 'dept_expirations', 'my_expirations', 'expiration_rows')) AS all_definer,
       has_function_privilege('anon', 'public.dept_expirations()', 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.expiration_rows(uuid,uuid)', 'EXECUTE') AS internal_exec,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_credentials'
          AND column_name ~* '(number|num$|_no$|scan|document|doc$|file|image|photo|note|attach|upload|medical|diagnos)') AS guardrail_cols,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately). Drops the three tables (export first):
-- DO $rb$ BEGIN
--   DROP FUNCTION IF EXISTS public.my_expirations(), public.dept_expirations(), public.delete_apparatus_test(uuid),
--     public.set_apparatus_test(uuid,uuid,text,date,date,text), public.log_gear_inspection(uuid,date), public.retire_gear_item(uuid),
--     public.set_gear_item(uuid,uuid,text,date,date,date), public.delete_member_credential(uuid),
--     public.set_member_credential(uuid,uuid,text,text,text,date,date), public.expiration_rows(uuid,uuid);
--   DROP TABLE IF EXISTS public.apparatus_tests, public.gear_items, public.member_credentials;
-- END $rb$;
-- NOTIFY pgrst, 'reload schema';
