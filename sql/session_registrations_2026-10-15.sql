-- =====================================================================
-- session_registrations — "Register" (plan-to-attend heads-up).
-- Record: applied by hand 2026-10-15. Idempotent. State check on live: RLS on · the two SELECT policies · 0 rows ·
-- anon_select false · anon_execute false · auth_insert false · 155 policies on other tables (unchanged by design).
-- RETEST on live 2026-10-15: 33 passed, 0 failed, 6 skipped.
-- Test script: sql/session_registrations_RETEST.sql (run AFTER this, separately).
--
-- WHAT IT IS. A member's PLAN for an upcoming training — Coming / Maybe / Not coming — so whoever runs it gets
-- a headcount heads-up. A PLAN IS NOT ATTENDANCE. This table is NEVER read by, joined into, or written from
-- anything attendance: session_attendance, the attendance rate, countsTowardRate, rollFor, the expected roster,
-- check-in, finalize. It is read only by the Register UI (a member's own row) and the leader summary.
--
-- WHAT CHANGES — ADDITIVE ONLY:
--   1. NEW table public.session_registrations (id, session_id -> training_sessions ON DELETE CASCADE,
--      member_id -> members ON DELETE CASCADE, department_id, status in coming|maybe|not_coming, created_at,
--      updated_at), UNIQUE (session_id, member_id) — one answer per person per session.
--   2. NEW helper public.session_reg_is_leader() — the caller is a leader IN THEIR OWN department:
--      a members row for auth.email() with department_id = my_department_id() and access &&
--      {Project Admin, Department Admin, Board Member, Officer} (the client's LEADERSHIP set). Department-scoped
--      on purpose — NOT is_canmanage() / is_department_admin(), which check the role anywhere (the cert-leak
--      lesson of 2026-10-13).
--   3. RLS on the new table, TWO SELECT policies, NO write policies:
--        * a member reads their OWN rows (member_id = my_member_id());
--        * a leader reads every row in THEIR department (department_id = my_department_id() AND leader).
--      No INSERT / UPDATE / DELETE policy, and those privileges are revoked: the only write is the RPC.
--   4. NEW RPC public.set_my_session_registration(p_session_id, p_status) — SECURITY DEFINER:
--        * p_status must be coming | maybe | not_coming;
--        * the session must exist and be in my_department_id();
--        * the session must not be finalized (done = true -> refused: changeable only until it's locked);
--        * the caller must be eligible for the session's AUDIENCE — mirrors the client's rollFor:
--            board -> Board Member; leadership -> the LEADERSHIP set; everyone -> any member of the department;
--        * upserts ONLY the caller's own row (member_id = my_member_id()) — no member argument exists.
--      Returns the stored status. EXECUTE revoked from anon + public, granted to authenticated.
--
-- READ SCOPE ELSEWHERE — UNCHANGED. No policy on any OTHER table is created, altered or dropped. A
-- post-condition captures every policy on every table except the new one before the change and proves the set
-- identical after; it also proves the new table has exactly the two SELECT policies and that anon can't read it
-- or run the RPC, and authenticated can't write the table directly.
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor. Safe to re-run (idempotent).
-- BEFORE RUNNING: nothing to compare — this adds new objects only. If a function named
-- session_reg_is_leader or set_my_session_registration already exists and is NOT this file's, the
-- precondition stops the run rather than overwrite it.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_new_pols text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'session_registrations'$q$;
BEGIN
  -- 0. preconditions
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'audience')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'done') THEN
    RAISE EXCEPTION 'Precondition failed: training_sessions.audience / done missing.';
  END IF;
  IF to_regprocedure('public.my_department_id()') IS NULL OR to_regprocedure('public.my_member_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_department_id() / my_member_id() missing.';
  END IF;
  -- nested, not AND: SQL doesn't short-circuit, and pg_get_functiondef on a missing function errors
  IF to_regprocedure('public.session_reg_is_leader()') IS NOT NULL THEN
    IF position('B4C:session_registrations' in pg_get_functiondef(to_regprocedure('public.session_reg_is_leader()'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different session_reg_is_leader() already exists — not overwriting it.';
    END IF;
  END IF;
  IF to_regprocedure('public.set_my_session_registration(uuid, text)') IS NOT NULL THEN
    IF position('B4C:session_registrations' in pg_get_functiondef(to_regprocedure('public.set_my_session_registration(uuid, text)'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different set_my_session_registration() already exists — not overwriting it.';
    END IF;
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1. the table
  CREATE TABLE IF NOT EXISTS public.session_registrations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    uuid NOT NULL REFERENCES public.training_sessions(id) ON DELETE CASCADE,
    member_id     uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    department_id uuid NOT NULL,
    status        text NOT NULL CHECK (status IN ('coming', 'maybe', 'not_coming')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT session_registrations_one_per_member UNIQUE (session_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS session_registrations_dept_session_idx ON public.session_registrations (department_id, session_id);
  COMMENT ON TABLE public.session_registrations IS
    'B4C:session_registrations — a member''s PLAN to attend (coming/maybe/not_coming). NOT attendance: never read or written by any attendance path.';

  -- 2. the department-scoped leader test (used by the leader SELECT policy)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.session_reg_is_leader()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- B4C:session_registrations — leader IN THE CALLER'S OWN department (not "a leader anywhere")
  select exists (
    select 1 from public.members m
     where lower(m.email) = lower(auth.email())
       and m.department_id = public.my_department_id()
       and m.access && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[]
  );
$function$
$ddl$;

  -- 3. RLS: read own; leaders read their department; no write policies
  ALTER TABLE public.session_registrations ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "own session registrations" ON public.session_registrations;
  CREATE POLICY "own session registrations" ON public.session_registrations FOR SELECT TO authenticated
    USING (member_id = public.my_member_id());
  DROP POLICY IF EXISTS "leaders read dept session registrations" ON public.session_registrations;
  CREATE POLICY "leaders read dept session registrations" ON public.session_registrations FOR SELECT TO authenticated
    USING (department_id = public.my_department_id() AND public.session_reg_is_leader());
  REVOKE ALL ON public.session_registrations FROM anon, public;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.session_registrations FROM authenticated;
  GRANT SELECT ON public.session_registrations TO authenticated;

  -- 4. the only write: the caller's own plan, for an eligible, open session in their department
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_my_session_registration(p_session_id uuid, p_status text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:session_registrations — self-only, department-scoped, audience-eligible. Never touches attendance.
declare
  v_me uuid := public.my_member_id();
  v_my_dept uuid := public.my_department_id();
  v_access text[];
  v_sess record;
begin
  if p_status is null or p_status not in ('coming', 'maybe', 'not_coming') then
    raise exception 'Choose Coming, Maybe, or Not coming';
  end if;
  if v_me is null or v_my_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  select department_id, audience, done into v_sess from public.training_sessions where id = p_session_id;
  if not found or v_sess.department_id is distinct from v_my_dept then
    raise exception 'Not in your department';
  end if;
  if coalesce(v_sess.done, false) then
    raise exception 'This session is closed';
  end if;
  select access into v_access from public.members where id = v_me and department_id = v_my_dept;
  if not found then
    raise exception 'Not in your department';
  end if;
  -- audience eligibility — the client's rollFor, server-side
  if v_sess.audience = 'board' and not (coalesce(v_access, '{}') && array['Board Member']::text[]) then
    raise exception 'Not eligible for this session';
  end if;
  if v_sess.audience = 'leadership' and not (coalesce(v_access, '{}') && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[]) then
    raise exception 'Not eligible for this session';
  end if;
  insert into public.session_registrations (session_id, member_id, department_id, status)
  values (p_session_id, v_me, v_my_dept, p_status)
  on conflict (session_id, member_id) do update set status = excluded.status, updated_at = now();
  return p_status;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.set_my_session_registration(uuid, text) FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.set_my_session_registration(uuid, text) TO authenticated;
  REVOKE EXECUTE ON FUNCTION public.session_reg_is_leader() FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.session_reg_is_leader() TO authenticated;

  -- 5. post-conditions — any failure undoes the whole block
  IF has_function_privilege('anon', 'public.set_my_session_registration(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE set_my_session_registration. Rolling back.';
  END IF;
  IF has_table_privilege('anon', 'public.session_registrations', 'SELECT') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can SELECT session_registrations. Rolling back.';
  END IF;
  IF has_table_privilege('authenticated', 'public.session_registrations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.session_registrations', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.session_registrations', 'DELETE') THEN
    RAISE EXCEPTION 'Post-condition failed: authenticated can write session_registrations directly. Rolling back.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.session_registrations'::regclass) THEN
    RAISE EXCEPTION 'Post-condition failed: RLS is off on session_registrations. Rolling back.';
  END IF;
  SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) INTO v_new_pols
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'session_registrations';
  IF v_new_pols IS DISTINCT FROM 'leaders read dept session registrations:SELECT,own session registrations:SELECT' THEN
    RAISE EXCEPTION 'Post-condition failed: session_registrations policies are % (expected the two SELECT policies). Rolling back.', v_new_pols;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.session_registrations'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Post-condition failed: a trigger is attached to session_registrations. Rolling back.';
  END IF;
  -- EVERY OTHER TABLE'S RLS UNCHANGED, character for character
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN
    RAISE EXCEPTION 'Post-condition failed: a policy on another table changed. Rolling back.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: rls_on true · the two SELECT policies · 0 rows on a first run ·
-- anon_select false · anon_execute false · auth_insert false · other_policies = the count you had before
SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.session_registrations'::regclass) AS rls_on,
       (SELECT string_agg(policyname || ':' || cmd, ', ' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'session_registrations') AS new_table_policies,
       (SELECT count(*) FROM public.session_registrations) AS rows,
       has_table_privilege('anon', 'public.session_registrations', 'SELECT') AS anon_select,
       has_function_privilege('anon', 'public.set_my_session_registration(uuid, text)', 'EXECUTE') AS anon_execute,
       has_table_privilege('authenticated', 'public.session_registrations', 'INSERT') AS auth_insert,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'session_registrations') AS other_policies;

-- =====================================================================
-- ROLLBACK (only if needed, separately). Drops the plans; touches nothing else.
-- =====================================================================
-- DO $rb$
-- BEGIN
--   DROP FUNCTION IF EXISTS public.set_my_session_registration(uuid, text);
--   DROP TABLE IF EXISTS public.session_registrations;
--   DROP FUNCTION IF EXISTS public.session_reg_is_leader();
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
