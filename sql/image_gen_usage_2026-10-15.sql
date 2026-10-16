-- =====================================================================
-- IMAGE GENERATOR — per-department monthly safety ceiling.
-- Record: Claude gate review PASS, then applied by hand 2026-10-15. Idempotent. State check on live: rls_on true · 0 policies ·
-- 0 rows · anon_execute false · auth_select false · 157 other policies (unchanged). RETEST on live: 36 passed, 0 failed, 0 skipped.
-- For the reviewing Claude, then Ashlea applies. Test script: sql/image_gen_usage_RETEST.sql (run AFTER, separately).
--
-- WHAT IT IS. A runaway backstop for /api/image (OpenAI gpt-image-1): each department may generate at most
-- SAFETY_CEILING images per calendar month (America/Chicago). NOT a product cap — a ceiling so a bug, a loop or a
-- misused account can't run up an open-ended bill. /api/image calls record_image_generation() with the caller's own
-- session BEFORE it calls OpenAI; allowed:false -> 429; any RPC error -> fail safe (OpenAI is not called).
--
-- WHAT CHANGES — ADDITIVE ONLY:
--   1. NEW table public.image_gen_usage (department_id -> departments ON DELETE CASCADE, period_month date = the
--      first day of the month, count int >= 0, updated_at), PRIMARY KEY (department_id, period_month).
--      RLS ON with NO policies, and every table privilege revoked from anon, authenticated and public: nobody reads or
--      writes it directly — the RPC below is the only door.
--   2. NEW RPC public.record_image_generation(p_tier text) RETURNS jsonb — SECURITY DEFINER:
--        * p_tier must be 'medium' or 'high' (validated; recorded nowhere else — the counter is per image);
--        * the caller must resolve to a member AND a department (my_member_id(), my_department_id()); the row it
--          touches is ALWAYS my_department_id()'s — there is no department argument, so no cross-department write;
--        * ONE atomic statement: INSERT … ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ceiling. Two
--          concurrent calls can't both slip past the ceiling (the row lock serialises them);
--        * returns {allowed, used, ceiling, tier}; when denied, the count is NOT incremented.
--      EXECUTE revoked from anon + public, granted to authenticated.
--   SAFETY_CEILING = 500 per department per month (a constant in the function body; change it with a reviewed
--   CREATE OR REPLACE).
--
-- WHO MAY GENERATE: any signed-in member of the department (the same population /api/image's requireUser admits).
--   FLAG FOR REVIEW: if the generator UI ends up leaders-only, this RPC can add the department-scoped leader test
--   (as session_reg_is_leader / set_fundraiser_shared do) so the ceiling can't be spent by a non-leader calling the
--   endpoint directly. Left open deliberately — Phase A has no UI yet.
--
-- READ SCOPE ELSEWHERE — UNCHANGED. No policy on any other table is created, altered or dropped. The post-condition
-- captures every policy on every other table before/after and proves them identical; proves the new table has RLS on,
-- ZERO policies and no privileges for anon/authenticated; and proves anon can't execute the RPC.
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor. Safe to re-run (idempotent).
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_n int;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'image_gen_usage'$q$;
BEGIN
  -- 0. preconditions
  IF to_regprocedure('public.my_department_id()') IS NULL OR to_regprocedure('public.my_member_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_department_id() / my_member_id() missing.';
  END IF;
  IF to_regprocedure('public.record_image_generation(text)') IS NOT NULL THEN   -- nested: SQL AND doesn't short-circuit
    IF position('B4C:image_gen_usage' in pg_get_functiondef(to_regprocedure('public.record_image_generation(text)'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different record_image_generation() exists — not overwriting it.';
    END IF;
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1. the counter — locked: RLS on, no policies, no privileges
  CREATE TABLE IF NOT EXISTS public.image_gen_usage (
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    period_month  date NOT NULL,                       -- first day of the month, America/Chicago
    count         integer NOT NULL DEFAULT 0 CHECK (count >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (department_id, period_month)
  );
  COMMENT ON TABLE public.image_gen_usage IS
    'B4C:image_gen_usage — per-department monthly image-generation counter (safety ceiling). RPC-only: record_image_generation().';
  ALTER TABLE public.image_gen_usage ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.image_gen_usage FROM anon, authenticated, public;

  -- 2. the only door: check + increment atomically, for the caller's own department
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.record_image_generation(p_tier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:image_gen_usage — department-scoped monthly safety ceiling for /api/image. Never takes a department argument.
declare
  SAFETY_CEILING constant integer := 500;              -- per department per month — a runaway backstop, not a product cap
  v_dept   uuid := public.my_department_id();
  v_period date := date_trunc('month', (now() at time zone 'America/Chicago'))::date;
  v_used   integer;
begin
  if p_tier is null or p_tier not in ('medium', 'high') then
    raise exception 'Image quality must be medium or high';
  end if;
  if v_dept is null or public.my_member_id() is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  insert into public.image_gen_usage as u (department_id, period_month, count, updated_at)
  values (v_dept, v_period, 1, now())
  on conflict (department_id, period_month)
    do update set count = u.count + 1, updated_at = now()
    where u.count < SAFETY_CEILING
  returning u.count into v_used;
  if v_used is null then                               -- the WHERE refused the update: at (or over) the ceiling
    select count into v_used from public.image_gen_usage where department_id = v_dept and period_month = v_period;
    return jsonb_build_object('allowed', false, 'used', v_used, 'ceiling', SAFETY_CEILING, 'tier', p_tier);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used, 'ceiling', SAFETY_CEILING, 'tier', p_tier);
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.record_image_generation(text) FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.record_image_generation(text) TO authenticated;

  -- 3. post-conditions — any failure undoes the whole block
  IF has_function_privilege('anon', 'public.record_image_generation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE record_image_generation. Rolling back.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.image_gen_usage'::regclass) THEN
    RAISE EXCEPTION 'Post-condition failed: RLS is off on image_gen_usage. Rolling back.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'image_gen_usage';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'Post-condition failed: image_gen_usage has % policies (expected none). Rolling back.', v_n;
  END IF;
  IF has_table_privilege('anon', 'public.image_gen_usage', 'SELECT') OR has_table_privilege('anon', 'public.image_gen_usage', 'INSERT')
     OR has_table_privilege('authenticated', 'public.image_gen_usage', 'SELECT') OR has_table_privilege('authenticated', 'public.image_gen_usage', 'INSERT')
     OR has_table_privilege('authenticated', 'public.image_gen_usage', 'UPDATE') OR has_table_privilege('authenticated', 'public.image_gen_usage', 'DELETE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon/authenticated hold a privilege on image_gen_usage. Rolling back.';
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
SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.image_gen_usage'::regclass) AS rls_on,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'image_gen_usage') AS table_policies,
       (SELECT count(*) FROM public.image_gen_usage) AS rows,
       has_function_privilege('anon', 'public.record_image_generation(text)', 'EXECUTE') AS anon_execute,
       has_table_privilege('authenticated', 'public.image_gen_usage', 'SELECT') AS auth_select,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'image_gen_usage') AS other_policies;

-- =====================================================================
-- ROLLBACK (only if needed, separately). /api/image then fails safe (the RPC is gone -> it won't call OpenAI).
-- =====================================================================
-- DO $rb$
-- BEGIN
--   DROP FUNCTION IF EXISTS public.record_image_generation(text);
--   DROP TABLE IF EXISTS public.image_gen_usage;
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
