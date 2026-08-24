-- =====================================================================
-- MULTI-STATION ADMIN — PHASE 1: the station switcher.
--
-- One login (matched by email) may belong to several departments and choose
-- which one it is acting in. Nothing else changes: no policy is touched, no
-- table is re-scoped. Every RLS policy in this app already funnels through
-- my_department_id(), so changing THAT ONE FUNCTION carries all downstream
-- scoping with it.
--
-- THE RISK, stated plainly. my_department_id() is referenced by 32 files in
-- sql/ and called 59 times from the client. It runs on effectively every query
-- for every user. If it changes behaviour for a SINGLE-department user, every
-- roster, every hours figure and every report in the product changes with it.
--
-- WHAT WAS AND WAS NOT VERIFIED WHEN THIS WAS WRITTEN. The step-4 body was
-- supplied already-rewritten; the original pg_get_functiondef output was never
-- pasted into the change. So "the single-department path is unchanged" is a
-- REVIEWED ASSERTION, not something this file's author compared side by side.
-- The shape (LANGUAGE sql / SECURITY DEFINER / search_path / no volatility
-- keyword) was preserved from what was supplied, and VERIFY check A3 — sign in
-- as an ordinary single-department member and confirm the roster, hours and a
-- report are unchanged — is what actually settles it. Do not skip A3 on the
-- grounds that the SQL "looks right".
--
-- INERT ON DAY ONE, confirmed before writing this: zero emails currently map to
-- more than one department. Nothing in the system takes the new branch until a
-- multi-department user is deliberately created. That is the safest possible
-- way to ship a change with this blast radius, and it is why the VERIFY block
-- below has to MANUFACTURE a two-department user to test the new path at all.
--
-- ORDER MATTERS: the table is created before the functions, because a
-- LANGUAGE sql body validates its references at creation time.
--
-- DEPLOY GATE: apply BEFORE the rebuilt bundle deploys. The client calls
-- my_departments() on load, and PostgREST answers 404 for a function it has not
-- seen. Safe against the current build, which calls none of this.
-- =====================================================================




BEGIN;

-- ---------------------------------------------------------------------
-- 1. member_active_department — which station a multi-station login is
--    currently acting in.
--
-- KEYED BY EMAIL, not member id, on purpose: the whole feature exists because
-- one human has SEVERAL member rows, one per department. Email is the thing
-- that is singular about them, and it is what auth.email() gives us.
--
-- ON DELETE CASCADE: if a department is deleted, a pointer at it is meaningless
-- and must not linger. Losing the row simply drops the user back to their
-- default station, which is the correct outcome — my_department_id() falls back
-- to the deterministic first membership when nothing is selected.
--
-- NOT a preference table. It holds exactly one fact and is read on every scoped
-- query for multi-station users, so it stays one narrow row per person.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.member_active_department (
  email          text PRIMARY KEY,
  department_id  uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.member_active_department IS
  'Which department a multi-station login is currently acting in. Keyed by lower(email) because one person has one member row per department. Read by my_department_id(); written only through set_active_department().';

ALTER TABLE public.member_active_department ENABLE ROW LEVEL SECURITY;

/* OWN ROW ONLY. These policies govern DIRECT client access to the table.
   set_active_department() is SECURITY DEFINER and bypasses them, which is why
   its membership check — not these policies — is the real security boundary for
   writes. The policies stop a signed-in user reading or forging somebody else's
   row through PostgREST.

   No DELETE policy: nothing needs to delete a row. Clearing a selection is done
   by pointing it somewhere else, and a department deletion cascades. */
DROP POLICY IF EXISTS member_active_department_select_own ON public.member_active_department;
CREATE POLICY member_active_department_select_own ON public.member_active_department
  FOR SELECT TO authenticated
  USING (email = lower(auth.email()));

DROP POLICY IF EXISTS member_active_department_insert_own ON public.member_active_department;
CREATE POLICY member_active_department_insert_own ON public.member_active_department
  FOR INSERT TO authenticated
  WITH CHECK (email = lower(auth.email()));

DROP POLICY IF EXISTS member_active_department_update_own ON public.member_active_department;
CREATE POLICY member_active_department_update_own ON public.member_active_department
  FOR UPDATE TO authenticated
  USING (email = lower(auth.email()))
  WITH CHECK (email = lower(auth.email()));

-- Table grants, explicit rather than inherited. anon has no business here at all.
REVOKE ALL ON TABLE public.member_active_department FROM anon, public;
GRANT SELECT, INSERT, UPDATE ON TABLE public.member_active_department TO authenticated;


-- ---------------------------------------------------------------------
-- 2. my_departments() — every department this login belongs to.
--
-- Feeds the switcher list AND is the reference set my_department_id() validates
-- a saved selection against. SECURITY DEFINER because it reads members and
-- departments across department boundaries, which is exactly what RLS forbids
-- for an ordinary caller — and precisely the point of the feature.
--
-- SAFE DESPITE THAT: it takes no parameter. There is nothing to pass to make it
-- return somebody else's departments; it can only ever answer for
-- lower(auth.email()). That is what makes a definer-rights function acceptable
-- here where a p_email parameter would have been a data-leak waiting to happen.
--
-- DISTINCT because a person could hold two member rows in one department (a
-- duplicate, a re-add); the switcher must not show the same station twice.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_departments()
 RETURNS TABLE (department_id uuid, name text, station text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select distinct d.id, d.name, d.station
    from members m
    join departments d on d.id = m.department_id
   where m.email is not null
     and btrim(m.email) <> ''
     and lower(m.email) = lower(auth.email())
   order by d.name;
$function$;


-- ---------------------------------------------------------------------
-- 3. set_active_department() — choose the station to act in.
--
-- THE MEMBERSHIP CHECK IS THE SECURITY BOUNDARY. This function is
-- SECURITY DEFINER, so it writes past the RLS policies above. Without the
-- EXISTS check any signed-in user could point their active department at ANY
-- department in the system and — because my_department_id() feeds every policy
-- — read that department's entire roster, hours and records. The check is not
-- validation, it is the authorisation.
--
-- Email match is lower()ed on both sides: member rows are entered by humans and
-- auth.email() is normalised, so a case difference must not read as "not a
-- member".
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_active_department(p_department_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := lower(auth.email());
begin
  if v_email is null or btrim(v_email) = '' then
    raise exception 'Not signed in';
  end if;

  -- THE boundary. Do not remove, do not weaken to a NULL-tolerant comparison.
  if not exists (
    select 1
      from members
     where email is not null
       and lower(email) = v_email
       and department_id = p_department_id
  ) then
    raise exception 'Not a member of that department';
  end if;

  insert into member_active_department (email, department_id)
  values (v_email, p_department_id)
  on conflict (email) do update
    set department_id = excluded.department_id,
        updated_at    = now();
end;
$function$;


-- ---------------------------------------------------------------------
-- 4. my_department_id() — the one function that carries all downstream scoping.
--
-- SHAPE PRESERVED FROM THE LIVE DEFINITION: LANGUAGE sql, SECURITY DEFINER,
-- search_path=public, and NO volatility keyword — which means VOLATILE, the
-- default. That is deliberate preservation, not an oversight: pg_get_functiondef
-- omits VOLATILE precisely because it is the default, so a live STABLE function
-- would have printed the word. Adding STABLE here would be a CHANGE to the most
-- frequently executed function in the schema, and this migration is not the
-- place to make one. See the note at the end of this file.
--
-- COALESCE, NOT A BRANCH. There is no membership count and no plpgsql: the saved
-- selection is tried first and falls through to the deterministic default when
-- it is absent or no longer valid. A single-department user has no saved row, so
-- arm 1 yields nothing and arm 2 returns exactly what it always did.
--
-- ARM 1 VALIDATES AS IT READS. The EXISTS is not belt-and-braces — it is what
-- makes a stale selection harmless. If someone is removed from the department
-- they had selected, the row still points there; without the EXISTS this would
-- keep scoping them into a department they are no longer a member of, which is
-- the exact failure the membership check in set_active_department() exists to
-- prevent at write time. Here it is enforced again at read time.
--
-- A STALE SELECTION FALLS BACK, it does not raise. Raising would lock the person
-- out of the entire application until somebody cleared a database row by hand.
-- Dropping them to their remaining station is what they would expect.
--
-- ARM 2 IS THE OLD BEHAVIOUR. For a single-department caller the ORDER BY is
-- immaterial — there is one row to pick — so ordering by department_id is both
-- deterministic for the multi-department case and inert for everyone else.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_department_id()
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    -- 1) the saved active station, ONLY if it's still one of the caller's departments
    ( select mad.department_id
        from public.member_active_department mad
       where mad.email = lower(auth.email())
         and exists ( select 1 from public.members m
                       where lower(m.email) = lower(auth.email())
                         and m.department_id = mad.department_id ) ),
    -- 2) else their department, deterministically. Single-dept = byte-identical to the old body.
    ( select m.department_id
        from public.members m
       where lower(m.email) = lower(auth.email())
       order by m.department_id
       limit 1 )
  );
$function$;


-- ---------------------------------------------------------------------
-- 5. Grants. Postgres default-grants EXECUTE to PUBLIC on a new function and
--    anon inherits through PUBLIC, so revoke both and grant authenticated back
--    — same pattern as sql/revoke_anon_execute_sweep.sql. my_department_id() is
--    NOT re-granted here: CREATE OR REPLACE preserves the existing ACL, and
--    touching it would risk changing rights on the most load-bearing function
--    in the schema.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.my_departments()                FROM anon, public;  GRANT EXECUTE ON FUNCTION public.my_departments()                TO authenticated;
REVOKE EXECUTE ON FUNCTION public.set_active_department(uuid)     FROM anon, public;  GRANT EXECUTE ON FUNCTION public.set_active_department(uuid)     TO authenticated;

COMMIT;

-- 6. Without this, PostgREST keeps serving its cached schema and answers 404
--    for my_departments() / set_active_department() on the first client call.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- NOTE ON VOLATILITY — deliberate, and worth revisiting later.
--
-- my_department_id() carries no volatility keyword, which makes it VOLATILE.
-- That is preserved from the supplied definition rather than chosen:
-- pg_get_functiondef prints STABLE when a function is STABLE and omits VOLATILE
-- because it is the default, so the absence indicates the live function is
-- VOLATILE too.
--
-- A VOLATILE function is re-evaluated per row and cannot be inlined, and this
-- one is invoked by nearly every RLS policy on nearly every query. Marking it
-- STABLE would very likely be a real performance win — and it would also be a
-- behavioural change to the single most load-bearing function in the schema,
-- made in the same migration that already changes what it returns. Two changes,
-- one blast radius, no way to tell which caused a regression.
--
-- So: not here. Worth measuring and doing on its own afterwards, with nothing
-- else in flight.
-- =====================================================================


-- =====================================================================
-- VERIFY — run after applying.
--
-- READ THIS FIRST: there are ZERO real multi-department users, so the new path
-- cannot be exercised by anyone currently in the system. Section B MANUFACTURES
-- a two-department user to test it, and section E deletes that user again. Do
-- not skip E.
--
-- ⚠ Use TEST departments for section B. Never add a second member row for a
--   real person at a real department to "try the switcher" — that person's
--   scope would change the moment the row exists.
-- =====================================================================
--
-- ---------- A. THE REGRESSION CHECK — single-department users are unchanged ----------
--
-- -- A1. Nothing takes the new branch yet. Expect 0 rows, same as before the
-- --     migration. If this is non-empty, sections A2/A3 are no longer a
-- --     regression test and you should stop and re-read who is affected.
-- SELECT lower(email) AS email, count(DISTINCT department_id) AS departments
--   FROM public.members
--  WHERE email IS NOT NULL AND btrim(email) <> ''
--  GROUP BY lower(email) HAVING count(DISTINCT department_id) > 1;
--
-- -- A2. Signature and rights of my_department_id() are IDENTICAL to what was
-- --     captured in STEP 0. Compare field by field against that output — a
-- --     changed volatility or a lost search_path is a silent behaviour change.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        pg_get_function_result(oid) AS returns,
--        CASE provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE'
--                         WHEN 'v' THEN 'VOLATILE' END AS volatility,
--        prosecdef AS security_definer,
--        coalesce(array_to_string(proconfig, ','), '(none)') AS config,
--        has_function_privilege('anon', oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace AND proname = 'my_department_id';
--
-- -- A3. THE REAL REGRESSION TEST, and it has to be done as a human: sign in as
-- --     an ordinary single-department member on the DEPLOYED app and confirm
-- --     the roster, station hours and one report show exactly what they showed
-- --     before. my_department_id() reads auth.email(), which is NULL in the SQL
-- --     editor, so no query here can stand in for that.
--
-- ---------- B. Manufacture a two-department test user ----------
--
-- -- B1. Two TEST departments. Skip whichever already exists.
-- --   INSERT INTO public.departments (name, station) VALUES
-- --     ('ZZ Test Station A', 'A'), ('ZZ Test Station B', 'B');
--
-- -- B2. One email, two member rows. Use a real mailbox you control and can
-- --     sign in as — the switcher can only be tested from a live session.
-- --   INSERT INTO public.members (department_id, name, email)
-- --   SELECT id, 'Multi Station Test', 'multistation-test@example.com'
-- --     FROM public.departments WHERE name IN ('ZZ Test Station A','ZZ Test Station B');
--
-- -- B3. Confirm the setup. Expect departments = 2.
-- --   SELECT lower(email), count(DISTINCT department_id) AS departments
-- --     FROM public.members WHERE lower(email) = 'multistation-test@example.com'
-- --    GROUP BY 1;
--
-- ---------- C. The switch itself — run SIGNED IN as the test user ----------
--
-- -- These need auth.email() to be the test user, so run them from the app's
-- -- SQL context or a session authenticated as that user. In the Supabase editor
-- -- auth.email() is NULL and every one of them will return nothing or raise.
-- --
-- -- C1. The switcher list. Expect exactly 2 rows, ordered by name.
-- --   SELECT * FROM public.my_departments();
-- --
-- -- C2. Select A, then confirm scope followed.
-- --   SELECT public.set_active_department('<ZZ Test Station A id>');
-- --   SELECT public.my_department_id();          -- expect A's id
-- --
-- -- C3. Select B, then confirm scope followed.
-- --   SELECT public.set_active_department('<ZZ Test Station B id>');
-- --   SELECT public.my_department_id();          -- expect B's id
-- --
-- -- C4. NO CROSS-DEPARTMENT BLEED. While set to B, every scoped read must show
-- --     ONLY B's rows. This is the check that matters most — a switcher that
-- --     changes the label but not the scope is worse than no switcher.
-- --   SELECT count(*) FROM public.members;        -- expect only B's members
-- --   SELECT count(*) FROM public.documents;      -- expect only B's documents
-- --     …and confirm the roster / station hours / a report on the DEPLOYED app.
--
-- ---------- D. The security boundary ----------
--
-- -- D1. Setting a department the caller is NOT a member of must RAISE
-- --     'Not a member of that department'. The error is the PASS. Run signed in
-- --     as the test user, with the id of any department they are not in.
-- --   BEGIN;
-- --     SELECT public.set_active_department('<some other department id>');
-- --   ROLLBACK;
-- --
-- -- D2. RLS blocks reading somebody else's row. Signed in as the test user,
-- --     this must return ONLY their own row — never another email's.
-- --   SELECT * FROM public.member_active_department;
-- --
-- -- D3. Rights on the two new functions. Expect definer=t, anon=f, auth=t.
-- --   SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
-- --          format('definer=%s anon=%s auth=%s', prosecdef,
-- --                 has_function_privilege('anon', oid, 'EXECUTE'),
-- --                 has_function_privilege('authenticated', oid, 'EXECUTE')) AS rights
-- --     FROM pg_proc
-- --    WHERE pronamespace='public'::regnamespace
-- --      AND proname IN ('my_departments','set_active_department') ORDER BY proname;
-- --
-- -- D4. The membership check is really in the function body. Expect gated=t.
-- --   SELECT proname, (prosrc ILIKE '%Not a member of that department%') AS gated
-- --     FROM pg_proc
-- --    WHERE pronamespace='public'::regnamespace AND proname='set_active_department';
--
-- ---------- E. TEAR DOWN THE TEST USER ----------
--
-- -- Leaving it in place leaves a live multi-department account in production
-- -- and makes check A1 permanently non-empty, so the regression test above
-- -- stops working for the next person who runs it.
-- --   DELETE FROM public.member_active_department WHERE email = 'multistation-test@example.com';
-- --   DELETE FROM public.members WHERE lower(email) = 'multistation-test@example.com';
-- --   DELETE FROM public.departments WHERE name IN ('ZZ Test Station A','ZZ Test Station B');
-- --
-- -- E1. Confirm teardown — both must return 0.
-- --   SELECT count(*) FROM public.members WHERE lower(email)='multistation-test@example.com';
-- --   SELECT count(*) FROM public.departments WHERE name IN ('ZZ Test Station A','ZZ Test Station B');
