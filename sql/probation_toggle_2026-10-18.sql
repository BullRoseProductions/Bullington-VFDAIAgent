-- =====================================================================
-- PHASE 3.1 #2 — PER-DEPARTMENT PROBATION TOGGLE (DB layer).
-- Record: Claude gate review PASS 2026-10-18 (recorded BEFORE apply).
-- APPLIED by hand 2026-10-18. State check: col true · fn true · anon_exec false · guard true · total_policies 163.
-- ON: Indian Harbor Volunteer Fire Department = 6fbb2d91-62d1-4c4a-997e-ad54c0569974 · Lipan Volunteer Fire Department =
-- a8dbabd1-541d-435e-a8cf-5eebc80f2576 · North Hood County Volunteer Fire Department = 6d51b00a-bdb0-4807-8e45-70bb53d4dcff.
-- OFF: B4C Demo Department · Granbury Fire Station. Test: sql/probation_toggle_RETEST.sql (run AFTER, separately).
-- Builds on sql/probation_2026-10-18.sql (applied, RETEST 56/0/7). Does not change the status RPCs.
--
-- WHAT CHANGES:
--   1. departments + probation_enabled boolean NOT NULL DEFAULT false. New departments start OFF.
--   2. Backfill ON for Indian Harbor, Lipan, North Hood ONLY — matched by name, each must match exactly one row
--      (Demo and Granbury stay OFF). The state check prints the three ids for the record.
--   3. set_probation_enabled(p_enabled) — SECURITY DEFINER; a REAL Department Admin of the caller's own department
--      (their member row there holds 'Department Admin', Active / Probationary — NOT is_dept_admin, so a pure Project
--      Admin can't); writes only departments.id = my_department_id(). Returns the new value.
--   4. GUARD TRIGGER (ADDITION to the brief, needed for item 3 to mean anything): departments ALREADY takes direct
--      client UPDATEs (Settings name/station/city, Brand Kit, week start — RLS-gated, not column-limited), and a
--      single column can't be revoked out of a table-wide UPDATE grant. So departments_probation_enabled_guard refuses
--      any change to probation_enabled made by a client session (current_user anon / authenticated). The definer RPC
--      (runs as the owner) and the SQL editor pass. Every other column's direct-update path is untouched.
--   5. dept_probation_board() returns NO rows when the caller's department has probation off — one guard after the
--      leadership check; the rest of the body is the applied text, unchanged. my_ / member_probation_status are NOT
--      touched (they still back the plain onboarding checklist the UI shows when probation is off).
-- Turning it off deletes nothing: starts, reviews and supervised time stay; the UI hides them; on again = back.
-- UNCHANGED (post-conditions prove it): every policy, the status RPCs, the write RPCs, the onboarding_progress
-- transition-state grant. Never touches the locked verification column.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_n int; v_t text; v_ids uuid[];
  v_status_before text; v_mstatus_before text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'$q$;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'probation_enabled') THEN
    RAISE EXCEPTION 'Precondition failed: departments.probation_enabled already exists — already applied. Nothing changed.';
  END IF;
  IF to_regprocedure('public.dept_probation_board()') IS NULL
     OR position('B4C:probation' in pg_get_functiondef('public.dept_probation_board()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: the probation layer (dept_probation_board) is not applied.';
  END IF;
  IF to_regprocedure('public.set_probation_enabled(boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: set_probation_enabled already exists.';
  END IF;
  FOREACH v_t IN ARRAY array['Indian Harbor%', 'Lipan%', 'North Hood%'] LOOP
    SELECT count(*) INTO v_n FROM public.departments WHERE name ILIKE v_t;
    IF v_n <> 1 THEN RAISE EXCEPTION 'Precondition failed: expected exactly one department matching "%", found %.', v_t, v_n; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.departments WHERE (name ILIKE '%demo%' OR name ILIKE 'Granbury%')
               AND (name ILIKE 'Indian Harbor%' OR name ILIKE 'Lipan%' OR name ILIKE 'North Hood%')) THEN
    RAISE EXCEPTION 'Precondition failed: a backfill name pattern also matches Demo / Granbury.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;
  v_status_before := pg_get_functiondef('public.probation_status(uuid,uuid)'::regprocedure);
  v_mstatus_before := pg_get_functiondef('public.member_probation_status(uuid)'::regprocedure);

  -- ---------------------------------------------------------------- 1-2. the column + backfill
  ALTER TABLE public.departments ADD COLUMN probation_enabled boolean NOT NULL DEFAULT false;
  COMMENT ON COLUMN public.departments.probation_enabled IS
    'B4C:probation — the department''s probation program on/off. Written only by set_probation_enabled (a real Department Admin); client UPDATEs of this column are refused by trigger.';
  UPDATE public.departments SET probation_enabled = true
   WHERE name ILIKE 'Indian Harbor%' OR name ILIKE 'Lipan%' OR name ILIKE 'North Hood%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 3 THEN RAISE EXCEPTION 'Backfill failed: expected 3 departments switched on, got %. Rolling back.', v_n; END IF;

  -- ---------------------------------------------------------------- 4. the guard trigger
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.tg_departments_probation_enabled_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- B4C:probation — probation_enabled changes only through set_probation_enabled (or the SQL editor), never a direct
-- client UPDATE (departments takes direct UPDATEs for its other settings).
begin
  if new.probation_enabled is distinct from old.probation_enabled and current_user in ('anon', 'authenticated') then
    raise exception 'Only a Department Admin can turn the probation program on or off.';
  end if;
  return new;
end;
$function$
$ddl$;
  CREATE TRIGGER departments_probation_enabled_guard BEFORE UPDATE OF probation_enabled ON public.departments
    FOR EACH ROW EXECUTE FUNCTION public.tg_departments_probation_enabled_guard();
  REVOKE EXECUTE ON FUNCTION public.tg_departments_probation_enabled_guard() FROM anon, authenticated, public;

  -- ---------------------------------------------------------------- 3. the write RPC
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_probation_enabled(p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — a Department Admin of the department turns its probation program on or off. A REAL DA only: the
-- caller's member row in THIS department holds 'Department Admin' and is Active / Probationary — never the
-- Project-Admin support path. Writes only the caller's own department. Deletes nothing. Never touches the locked
-- verification column.
declare v_dept uuid := public.my_department_id(); v_on boolean;
begin
  if p_enabled is null then raise exception 'Say on or off.'; end if;
  if v_dept is null or not exists (
       select 1 from public.members x
        where lower(x.email) = lower(auth.email()) and x.department_id = v_dept
          and x.access && array['Department Admin']::text[] and x.status in ('Active', 'Probationary')) then
    raise exception 'Only a Department Admin can turn the probation program on or off.';
  end if;
  update public.departments set probation_enabled = p_enabled where id = v_dept returning probation_enabled into v_on;
  if not found then raise exception 'We could not find your department.'; end if;
  return v_on;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.set_probation_enabled(boolean) FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.set_probation_enabled(boolean) TO authenticated;

  -- ---------------------------------------------------------------- 5. the board: empty when off
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_probation_board()
 RETURNS TABLE(member_id uuid, name text, started_on date, day_n integer, gate_configured boolean, cleared_to_run boolean,
               ready_for_vote boolean, detail jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation — Board / DA / Officer: every probationary member of the department (honest denominator: not
-- Inactive, not former, not a Project Admin) with their gate + ready-for-vote state. Read-only; no push, no job.
#variable_conflict use_column
declare v_dept uuid := public.my_department_id();
begin
  if v_dept is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see the probation board.';
  end if;
  -- the department's probation program is off -> no board (nothing is deleted; on again = back)
  if not coalesce((select d.probation_enabled from public.departments d where d.id = v_dept), false) then
    return;
  end if;
  return query
  select x.id, x.name, (d->>'started_on')::date, (d->>'day_n')::int, (d->'gate'->>'configured')::boolean,
         (d->>'cleared_to_run')::boolean, (d->>'ready_for_vote')::boolean, d
    from (select m.id, m.name, public.probation_status(m.id, v_dept) as d
            from public.members m
           where m.department_id = v_dept and m.status = 'Probationary'
             and not coalesce(m.access && array['Project Admin']::text[], false)
             and not exists (select 1 from public.member_separation s where s.member_id = m.id)) x
   order by 7 desc, 2;
end;
$function$
$ddl$;

  -- ---------------------------------------------------------------- post-conditions (any failure undoes everything)
  IF has_function_privilege('anon', 'public.set_probation_enabled(boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_probation_enabled(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: set_probation_enabled grants are wrong (anon must not, authenticated must).';
  END IF;
  IF has_function_privilege('anon', 'public.dept_probation_board()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.dept_probation_board()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: dept_probation_board grants changed (CREATE OR REPLACE must keep them).';
  END IF;
  IF position('is_dept_admin' in pg_get_functiondef('public.set_probation_enabled(boolean)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'Post-condition failed: set_probation_enabled must not gate on is_dept_admin().';
  END IF;
  IF position('''Department Admin''' in pg_get_functiondef('public.set_probation_enabled(boolean)'::regprocedure)) = 0
     OR position('x.department_id = v_dept' in pg_get_functiondef('public.set_probation_enabled(boolean)'::regprocedure)) = 0
     OR position('where id = v_dept' in pg_get_functiondef('public.set_probation_enabled(boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: set_probation_enabled lost its Department-Admin gate or its own-department scope.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'departments_probation_enabled_guard' AND tgrelid = 'public.departments'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Post-condition failed: the probation_enabled guard trigger is missing or disabled.';
  END IF;
  IF position('probation_enabled' in pg_get_functiondef('public.dept_probation_board()'::regprocedure)) = 0
     OR position('is_canmanage()' in pg_get_functiondef('public.dept_probation_board()'::regprocedure)) = 0
     OR position('member_separation' in pg_get_functiondef('public.dept_probation_board()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: dept_probation_board lost its gate, its denominator, or the off guard.';
  END IF;
  IF pg_get_functiondef('public.probation_status(uuid,uuid)'::regprocedure) IS DISTINCT FROM v_status_before
     OR pg_get_functiondef('public.member_probation_status(uuid)'::regprocedure) IS DISTINCT FROM v_mstatus_before THEN
    RAISE EXCEPTION 'Post-condition failed: a status RPC changed.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.onboarding_progress', 'INSERT') THEN
    RAISE EXCEPTION 'Post-condition failed: the onboarding_progress transition-state grant was removed.';
  END IF;
  SELECT array_agg(id ORDER BY name) INTO v_ids FROM public.departments WHERE probation_enabled;
  IF coalesce(array_length(v_ids, 1), 0) <> 3 THEN RAISE EXCEPTION 'Post-condition failed: % departments on, expected 3.', coalesce(array_length(v_ids, 1), 0); END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: col true · fn true · anon_exec false · guard true · on = the three departments
-- (Indian Harbor, Lipan, North Hood) with their ids · off includes Demo + Granbury · total_policies 163 (unchanged)
SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'probation_enabled') AS col,
       to_regprocedure('public.set_probation_enabled(boolean)') IS NOT NULL AS fn,
       has_function_privilege('anon', 'public.set_probation_enabled(boolean)', 'EXECUTE') AS anon_exec,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'departments_probation_enabled_guard' AND tgenabled = 'O') AS guard,
       (SELECT string_agg(name || ' = ' || id, ' · ' ORDER BY name) FROM public.departments WHERE probation_enabled) AS probation_on,
       (SELECT string_agg(name, ' · ' ORDER BY name) FROM public.departments WHERE NOT probation_enabled) AS probation_off,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately): DROP TRIGGER departments_probation_enabled_guard ON public.departments;
-- DROP FUNCTION public.tg_departments_probation_enabled_guard(), public.set_probation_enabled(boolean);
-- re-create dept_probation_board() from sql/probation_2026-10-18.sql (CREATE OR REPLACE keeps its grants);
-- ALTER TABLE public.departments DROP COLUMN probation_enabled; NOTIFY pgrst, 'reload schema';
