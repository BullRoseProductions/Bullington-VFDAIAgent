-- =====================================================================
-- ai_outputs.session_id — ASSIGN MINUTES TO A MEETING. DRAFT v2 — NOT APPLIED. For review.
-- v2 (2026-10-15): one DO block. v1 failed in the Supabase editor (temp table gone between statements).
-- Test script: sql/ai_outputs_session_id_RETEST.sql (run AFTER this, separately).
--
-- WHY. Part B of the Meetings batch: link a saved minutes record to the leadership/board meeting it
-- records. The agenda path (session_plans + "View plan") was ruled out: every member's Training
-- calendar loads all sessions with their attached plan text, so minutes routed there would reach
-- members. This keeps the link ON the minutes row, which is only ever shown on the leaders-only
-- Meetings page. Assigning = organisation + the meeting link, nothing more.
--
-- WHAT CHANGES:
--   1. ai_outputs gains ONE nullable column, session_id uuid -> training_sessions(id) ON DELETE SET NULL
--      (deleting a meeting un-assigns its minutes; the minutes themselves are never touched).
--   2. CHECK: only a 'minutes' row can carry a session_id.
--   3. A guard trigger (BEFORE INSERT, or UPDATE OF session_id): the meeting must exist, be in the SAME
--      department as the minutes row, and be a leadership or board session. Applies to every write
--      path, so the RPC is not the only fence.
--   4. RPC assign_minutes_to_session(p_output_id, p_session_id) — p_session_id NULL un-assigns. Sets
--      session_id ONLY: ai_text, current_text, edited_by and edited_at are untouched, so assigning does
--      not stamp "edited by" on the record. (A plain client .update() could not do that: the UPDATE
--      policy's WITH CHECK requires edited_by = my_member_id().)
--   5. A partial index on session_id.
--
-- READ SCOPE — UNCHANGED. No policy on ai_outputs or any other table is created, altered or dropped.
-- Who can read minutes is exactly what it is today. A post-condition below captures every ai_outputs
-- policy before the change and proves the set is identical after it (any difference undoes the block).
--
-- WRITE PERMISSION (the gate) — the RPC, all in one place:
--   * Caller must be a leader IN THEIR OWN DEPARTMENT: a members row matching auth.email() with
--     department_id = my_department_id() and access && {Board Member, Department Admin, Officer}.
--     That is is_canmanage()'s live role set — the same people who can save minutes today — but
--     scoped to the department. is_canmanage() itself is NOT department-scoped (it checks for the role
--     anywhere), which is the trap is_department_admin() caused on 2026-10-13; it is not used here.
--   * The minutes row must exist, be in my_department_id(), not be soft-deleted, and be feature='minutes'.
--   * The meeting checks are the trigger's (one rule, not two).
--   * SECURITY DEFINER, search_path public. EXECUTE revoked from anon + public, granted to authenticated.
--   Permission checks: 1 role check + 1 department check on the row (+ the trigger's department and
--   audience checks on the meeting). Reads: ai_outputs (1 row), members (caller), training_sessions
--   (1 row, in the trigger). No new table.
--
-- DRY RUN 2026-10-15 — NOT the live DB. Run against PGlite (Postgres 16 in WASM) with a mock of the relevant
-- pieces copied from schema.sql: departments, members, training_sessions(audience), ai_outputs + its three
-- policies, the deleted_at guard trigger, my_department_id / my_member_id / is_canmanage / is_canmanage_ops /
-- is_dept_admin, roles anon + authenticated, auth.email() from request.jwt.claims. Two departments seeded.
--   * migration: OK, and OK again (idempotent); state check = uuid nullable, CHECK, trigger, anon false, 3 policies
--   * RETEST: 16 passed, 0 failed, 1 skipped (one mock dept had no agenda)
--   * mutation checks: without the guard trigger the RETEST FAILS C, D, G; a widened read policy inside
--     the migration and an open anon grant each trip a post-condition and roll back; the minutes-only
--     CHECK refuses an agenda row; deleting a meeting un-assigns its minutes (ON DELETE SET NULL).
--   * v2 (single DO block): same results, plus — run over a half-applied v1 state (column + CHECK + index
--     present, no trigger/RPC) it completes cleanly and RETEST passes 16/0/1; a block that fails a
--     post-condition leaves NOTHING behind (state check all false afterwards).
-- The live run is still the real test — the live policies / helper bodies may differ from the snapshot.
-- BEFORE RUNNING — compare the live role set, and stop if it differs from the list above:
--   SELECT pg_get_functiondef('public.is_canmanage()'::regprocedure);
-- =====================================================================
-- ONE STATEMENT. The whole migration is a single DO block, so it is all-or-nothing in any SQL editor —
-- any failure (a precondition, a post-condition, an error mid-way) undoes every step. v1 used
-- BEGIN/COMMIT around separate statements plus a temp table; the Supabase editor ran the statements
-- without that transaction, so the temp table was gone before the check that read it.
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s', policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_outputs'$q$;
BEGIN
  -- 0. preconditions + the ai_outputs policies as they are now (compared at the end)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'audience') THEN
    RAISE EXCEPTION 'Precondition failed: training_sessions.audience does not exist.';
  END IF;
  IF to_regprocedure('public.my_department_id()') IS NULL OR to_regprocedure('public.my_member_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_department_id() / my_member_id() missing.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1. the column
  ALTER TABLE public.ai_outputs
    ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.training_sessions(id) ON DELETE SET NULL;

  -- 2. only minutes can be assigned
  ALTER TABLE public.ai_outputs DROP CONSTRAINT IF EXISTS ai_outputs_session_id_minutes_only;
  ALTER TABLE public.ai_outputs
    ADD CONSTRAINT ai_outputs_session_id_minutes_only CHECK (session_id IS NULL OR feature = 'minutes');

  -- 3. the meeting must be a leadership/board session in the same department — on every write path
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.guard_ai_outputs_session_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid; v_aud text;
begin
  if new.session_id is null then
    return new;                                   -- un-assigning is always allowed
  end if;
  select department_id, audience into v_dept, v_aud from public.training_sessions where id = new.session_id;
  if not found or v_dept is distinct from new.department_id then
    raise exception 'That meeting is not in this department';
  end if;
  if v_aud is null or v_aud not in ('leadership', 'board') then
    raise exception 'Only a leadership or board meeting can hold minutes';
  end if;
  return new;
end;
$function$
$ddl$;

  DROP TRIGGER IF EXISTS trg_guard_ai_outputs_session_id ON public.ai_outputs;
  CREATE TRIGGER trg_guard_ai_outputs_session_id BEFORE INSERT OR UPDATE OF session_id ON public.ai_outputs
    FOR EACH ROW EXECUTE FUNCTION public.guard_ai_outputs_session_id();

  -- 4. the assign / un-assign RPC
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.assign_minutes_to_session(p_output_id uuid, p_session_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_my_dept uuid := public.my_department_id();
  v_row public.ai_outputs;
begin
  if v_my_dept is null or not exists (
       select 1 from public.members m
        where lower(m.email) = lower(auth.email())
          and m.department_id = v_my_dept
          and m.access && array['Board Member', 'Department Admin', 'Officer']::text[]) then
    raise exception 'Only leaders can assign minutes to a meeting';
  end if;
  select * into v_row from public.ai_outputs where id = p_output_id;
  if not found then
    raise exception 'Minutes not found';
  end if;
  if v_row.department_id <> v_my_dept then
    raise exception 'Not in your department';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'These minutes are deleted';
  end if;
  if v_row.feature <> 'minutes' then
    raise exception 'Only minutes can be assigned to a meeting';
  end if;
  update public.ai_outputs set session_id = p_session_id where id = p_output_id;   -- the trigger checks the meeting
  return p_session_id;
end;
$function$
$ddl$;

  -- 5. index
  CREATE INDEX IF NOT EXISTS ai_outputs_session_id_idx ON public.ai_outputs (session_id) WHERE session_id IS NOT NULL;

  -- 6. grants
  REVOKE EXECUTE ON FUNCTION public.assign_minutes_to_session(uuid, uuid) FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.assign_minutes_to_session(uuid, uuid) TO authenticated;
  REVOKE EXECUTE ON FUNCTION public.guard_ai_outputs_session_id() FROM anon, public;

  -- 7. post-conditions — any failure undoes the whole block
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ai_outputs' AND column_name = 'session_id' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'Post-condition failed: ai_outputs.session_id missing or NOT NULL. Rolling back.';
  END IF;
  IF has_function_privilege('anon', 'public.assign_minutes_to_session(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE assign_minutes_to_session. Rolling back.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_ai_outputs_session_id' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Post-condition failed: guard trigger missing. Rolling back.';
  END IF;
  -- READ SCOPE UNCHANGED: the ai_outputs policy set is identical, character for character
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN
    RAISE EXCEPTION 'Post-condition failed: ai_outputs policies changed. Rolling back.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: session_id uuid YES · the CHECK · the trigger · anon_can_execute = false
SELECT (SELECT data_type || ' nullable=' || is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ai_outputs' AND column_name = 'session_id') AS session_id_column,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ai_outputs_session_id_minutes_only') AS minutes_only_check,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_guard_ai_outputs_session_id' AND NOT tgisinternal) AS guard_trigger,
       has_function_privilege('anon', 'public.assign_minutes_to_session(uuid, uuid)', 'EXECUTE') AS anon_can_execute,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_outputs') AS ai_outputs_policy_count;

-- =====================================================================
-- ROLLBACK (only if needed, separately). Un-assigns everything; the minutes themselves are untouched.
-- =====================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.assign_minutes_to_session(uuid, uuid);
-- DROP TRIGGER IF EXISTS trg_guard_ai_outputs_session_id ON public.ai_outputs;
-- DROP FUNCTION IF EXISTS public.guard_ai_outputs_session_id();
-- ALTER TABLE public.ai_outputs DROP CONSTRAINT IF EXISTS ai_outputs_session_id_minutes_only;
-- DROP INDEX IF EXISTS public.ai_outputs_session_id_idx;
-- ALTER TABLE public.ai_outputs DROP COLUMN IF EXISTS session_id;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
