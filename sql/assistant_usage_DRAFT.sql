-- =====================================================================
-- ASK B4C (assistant) — per-department monthly ceiling on assistant turns.
-- DRAFT — for the reviewing Claude, then Ashlea applies. Test script: sql/assistant_usage_RETEST.sql (run AFTER).
--
-- WHAT IT IS. The same shape as image_gen_usage (reviewed PASS, live 2026-10-15), for /api/assistant: each department
-- may run at most SAFETY_CEILING assistant turns per calendar month (America/Chicago). One TURN = one question the
-- member sends (one POST), however many tool calls the model makes to answer it. /api/assistant calls
-- record_assistant_turn() with the caller's own session BEFORE it calls Anthropic; allowed:false -> a friendly
-- "Ask B4C has taken a breather for the month" message; any RPC error -> fail safe (the model is not called).
--
-- WHAT CHANGES — ADDITIVE ONLY:
--   1. NEW table public.assistant_usage (department_id -> departments ON DELETE CASCADE, period_month date, count >= 0,
--      updated_at), PRIMARY KEY (department_id, period_month). RLS ON, NO policies, every privilege revoked from anon,
--      authenticated and public — the RPC is the only door.
--   2. NEW RPC public.record_assistant_turn() RETURNS jsonb — SECURITY DEFINER; no arguments, so it can only ever
--      touch my_department_id()'s row; caller must resolve to a member and a department; ONE atomic
--      INSERT … ON CONFLICT DO UPDATE … WHERE count < ceiling; returns {allowed, used, ceiling}; a denial does not
--      increment. EXECUTE revoked from anon + public, granted to authenticated.
--   SAFETY_CEILING = 500 per department per month (Ashlea to confirm; change with a reviewed CREATE OR REPLACE).
--
-- READ SCOPE ELSEWHERE — UNCHANGED. Post-condition proves every other table's policies identical, the new table has
-- RLS on / zero policies / no privileges, and anon can't execute the RPC.
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor. Safe to re-run (idempotent).
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_n int;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'assistant_usage'$q$;
BEGIN
  -- 0. preconditions
  IF to_regprocedure('public.my_department_id()') IS NULL OR to_regprocedure('public.my_member_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_department_id() / my_member_id() missing.';
  END IF;
  IF to_regprocedure('public.record_assistant_turn()') IS NOT NULL THEN   -- nested: SQL AND doesn't short-circuit
    IF position('B4C:assistant_usage' in pg_get_functiondef(to_regprocedure('public.record_assistant_turn()'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different record_assistant_turn() exists — not overwriting it.';
    END IF;
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1. the counter — locked: RLS on, no policies, no privileges
  CREATE TABLE IF NOT EXISTS public.assistant_usage (
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    period_month  date NOT NULL,                       -- first day of the month, America/Chicago
    count         integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (department_id, period_month)
  );
  COMMENT ON TABLE public.assistant_usage IS
    'B4C:assistant_usage — per-department monthly Ask B4C turn counter (cost ceiling). RPC-only: record_assistant_turn().';
  ALTER TABLE public.assistant_usage ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.assistant_usage FROM anon, authenticated, public;

  -- 2. the only door: check + increment atomically, for the caller's own department
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.record_assistant_turn()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:assistant_usage — department-scoped monthly ceiling on Ask B4C turns (/api/assistant). Never takes a department argument.
declare
  SAFETY_CEILING constant integer := 500;              -- assistant turns per department per month — a cost backstop, raise once real usage is known
  v_dept   uuid := public.my_department_id();
  v_period date := date_trunc('month', (now() at time zone 'America/Chicago'))::date;
  v_used   integer;
begin
  if v_dept is null or public.my_member_id() is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  insert into public.assistant_usage as u (department_id, period_month, count, updated_at)
  values (v_dept, v_period, 1, now())
  on conflict (department_id, period_month)
    do update set count = u.count + 1, updated_at = now()
    where u.count < SAFETY_CEILING
  returning u.count into v_used;
  if v_used is null then                               -- the WHERE refused the update: at (or over) the ceiling
    select count into v_used from public.assistant_usage where department_id = v_dept and period_month = v_period;
    return jsonb_build_object('allowed', false, 'used', v_used, 'ceiling', SAFETY_CEILING);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used, 'ceiling', SAFETY_CEILING);
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.record_assistant_turn() FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.record_assistant_turn() TO authenticated;

  -- 3. post-conditions — any failure undoes the whole block
  IF has_function_privilege('anon', 'public.record_assistant_turn()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE record_assistant_turn. Rolling back.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assistant_usage'::regclass) THEN
    RAISE EXCEPTION 'Post-condition failed: RLS is off on assistant_usage. Rolling back.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'assistant_usage';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: assistant_usage has % policies (expected none). Rolling back.', v_n;
  END IF;
  IF has_table_privilege('anon', 'public.assistant_usage', 'SELECT') OR has_table_privilege('anon', 'public.assistant_usage', 'INSERT')
     OR has_table_privilege('authenticated', 'public.assistant_usage', 'SELECT') OR has_table_privilege('authenticated', 'public.assistant_usage', 'INSERT')
     OR has_table_privilege('authenticated', 'public.assistant_usage', 'UPDATE') OR has_table_privilege('authenticated', 'public.assistant_usage', 'DELETE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon/authenticated hold a privilege on assistant_usage. Rolling back.';
  END IF;
  -- EVERY OTHER TABLE'S RLS UNCHANGED, character for character
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN
    RAISE EXCEPTION 'Post-condition failed: a policy on another table changed. Rolling back.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: rls_on true · 0 policies · rows 0 on a first run · anon_execute false ·
-- auth_select false · other_policies = what you had before (157)
SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.assistant_usage'::regclass) AS rls_on,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'assistant_usage') AS table_policies,
       (SELECT count(*) FROM public.assistant_usage) AS rows,
       has_function_privilege('anon', 'public.record_assistant_turn()', 'EXECUTE') AS anon_execute,
       has_table_privilege('authenticated', 'public.assistant_usage', 'SELECT') AS auth_select,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'assistant_usage') AS other_policies;

-- =====================================================================
-- ROLLBACK (only if needed, separately). /api/assistant then fails safe (the RPC is gone -> it won't call Anthropic).
-- =====================================================================
-- DO $rb$
-- BEGIN
--   DROP FUNCTION IF EXISTS public.record_assistant_turn();
--   DROP TABLE IF EXISTS public.assistant_usage;
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
