-- =====================================================================
-- training_sessions.is_meeting + the minutes guard accepts flagged meetings. DRAFT — NOT APPLIED. For review.
-- Migration 2 of "assign minutes to a meeting". Builds on sql/ai_outputs_session_id_2026-10-15.sql (applied).
-- Test script: sql/training_sessions_is_meeting_RETEST.sql (run AFTER this, separately).
--
-- WHY. Business meetings are on the calendar as EVERYONE sessions (the whole department attends), so the
-- guard from migration 1 — leadership/board audience only — refuses their minutes. A meeting is a
-- different question from who attends, so it gets its own flag instead of a new audience. The audience,
-- and everything that reads it (attendance eligibility, the attendance rate, rosters, board
-- accountability), is untouched.
--
-- WHAT CHANGES — TWO THINGS, NOTHING ELSE:
--   1. training_sessions gains is_meeting boolean NOT NULL DEFAULT false. Every existing session reads
--      false, so nothing is a meeting until a leader ticks "This is a meeting" on it.
--   2. guard_ai_outputs_session_id() (the BEFORE INSERT / UPDATE OF session_id trigger on ai_outputs) is
--      replaced with one rule change: the session may hold minutes if its audience is leadership/board
--      (exactly as now) OR it is flagged is_meeting. The same-department check is unchanged, character
--      for character. The refusal message becomes 'Only a meeting can hold minutes'.
--      CREATE OR REPLACE keeps the function's grants and the trigger binding; the REVOKE is re-asserted.
--
-- NOT CHANGED: no policy on any table is created, altered or dropped. assign_minutes_to_session() is not
-- touched. Who can read minutes or sessions is exactly what it is today. A post-condition captures every
-- policy on ai_outputs AND training_sessions before the change and proves both sets identical after it.
--
-- KNOWN, BY DESIGN: un-ticking "This is a meeting" later does NOT detach minutes already assigned to that
-- session (the trigger fires on ai_outputs writes only). The link stays; it simply can't be re-made.
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor (the lesson from migration 1).
-- Safe to re-run (idempotent).
--
-- DRY RUN — see the RETEST header for the PGlite results.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('ai_outputs', 'training_sessions')$q$;
BEGIN
  -- 0. preconditions — migration 1 must be live
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ai_outputs' AND column_name = 'session_id') THEN
    RAISE EXCEPTION 'Precondition failed: ai_outputs.session_id does not exist (apply ai_outputs_session_id_2026-10-15.sql first).';
  END IF;
  IF to_regprocedure('public.guard_ai_outputs_session_id()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_ai_outputs_session_id' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Precondition failed: the minutes guard trigger / function is missing.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1. the flag
  ALTER TABLE public.training_sessions ADD COLUMN IF NOT EXISTS is_meeting boolean NOT NULL DEFAULT false;

  -- 2. the guard: leadership/board (unchanged) OR flagged as a meeting
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.guard_ai_outputs_session_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid; v_aud text; v_ismtg boolean;
begin
  if new.session_id is null then
    return new;                                   -- un-assigning is always allowed
  end if;
  select department_id, audience, is_meeting into v_dept, v_aud, v_ismtg from public.training_sessions where id = new.session_id;
  if not found or v_dept is distinct from new.department_id then
    raise exception 'That meeting is not in this department';
  end if;
  -- a meeting = a leadership/board session (as before) OR a session a leader flagged "This is a meeting"
  if not (coalesce(v_aud in ('leadership', 'board'), false) or coalesce(v_ismtg, false)) then
    raise exception 'Only a meeting can hold minutes';
  end if;
  return new;
end;
$function$
$ddl$;

  REVOKE EXECUTE ON FUNCTION public.guard_ai_outputs_session_id() FROM anon, public;

  -- 3. post-conditions — any failure undoes the whole block
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'is_meeting'
                    AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false') THEN
    RAISE EXCEPTION 'Post-condition failed: training_sessions.is_meeting is not boolean NOT NULL DEFAULT false. Rolling back.';
  END IF;
  IF position('v_ismtg' in pg_get_functiondef('public.guard_ai_outputs_session_id()'::regprocedure)) = 0
     OR position('That meeting is not in this department' in pg_get_functiondef('public.guard_ai_outputs_session_id()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: guard function body is not the new rule. Rolling back.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_ai_outputs_session_id' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Post-condition failed: guard trigger missing. Rolling back.';
  END IF;
  IF has_function_privilege('anon', 'public.assign_minutes_to_session(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE assign_minutes_to_session. Rolling back.';
  END IF;
  -- READ SCOPE UNCHANGED: every policy on ai_outputs and training_sessions identical, character for character
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN
    RAISE EXCEPTION 'Post-condition failed: ai_outputs / training_sessions policies changed. Rolling back.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: boolean NOT NULL default false · flagged_sessions 0 on a first run ·
-- guard_has_new_rule true · guard_trigger 1 · anon_can_execute false · policy counts as before (ai_outputs 4)
SELECT (SELECT data_type || ' nullable=' || is_nullable || ' default=' || column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'is_meeting') AS is_meeting_column,
       (SELECT count(*) FROM public.training_sessions WHERE is_meeting) AS flagged_sessions,
       position('v_ismtg' in pg_get_functiondef('public.guard_ai_outputs_session_id()'::regprocedure)) > 0 AS guard_has_new_rule,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_guard_ai_outputs_session_id' AND NOT tgisinternal) AS guard_trigger,
       has_function_privilege('anon', 'public.assign_minutes_to_session(uuid, uuid)', 'EXECUTE') AS anon_can_execute,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_outputs') AS ai_outputs_policies,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_sessions') AS training_sessions_policies;

-- =====================================================================
-- ROLLBACK (only if needed, separately) — restores migration 1's guard rule, then drops the flag.
-- Minutes already assigned to a flagged EVERYONE session stay linked (un-assign them first if wanted).
-- =====================================================================
-- DO $rb$
-- BEGIN
--   EXECUTE $ddl$
-- CREATE OR REPLACE FUNCTION public.guard_ai_outputs_session_id()
--  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
-- AS $function$
-- declare v_dept uuid; v_aud text;
-- begin
--   if new.session_id is null then return new; end if;
--   select department_id, audience into v_dept, v_aud from public.training_sessions where id = new.session_id;
--   if not found or v_dept is distinct from new.department_id then raise exception 'That meeting is not in this department'; end if;
--   if v_aud is null or v_aud not in ('leadership', 'board') then raise exception 'Only a leadership or board meeting can hold minutes'; end if;
--   return new;
-- end;
-- $function$
-- $ddl$;
--   ALTER TABLE public.training_sessions DROP COLUMN IF EXISTS is_meeting;
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
