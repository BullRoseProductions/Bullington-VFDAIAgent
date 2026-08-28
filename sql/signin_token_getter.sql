-- =====================================================================
-- QR SIGN-IN — LET THE OFFICER'S PAGE RE-DISPLAY THE LIVE CODE.
--
-- THE BUG. open_signin() persists the code in training_sessions.signin_token and
-- returns it, and member_check_in() validates against that same column. But the
-- client kept the returned code ONLY in React state:
--
--     const [signinTokens, setSigninTokens] = useState({});   // this browser, this open
--
-- and the session list never selected signin_token. So after a reload, a tab
-- switch, or a phone sleeping, signinOpen is still true while the code is gone
-- from memory — and checkinURL() builds "?checkin=<id>&t=" with an EMPTY token.
-- The QR still renders and looks perfectly normal. Every scan of it fails the
-- `signin_token <> p_token` check.
--
-- That is why North Hood recorded 3 QR sign-ins in 60 days while marking ~120
-- attendance rows by hand: the code on screen could not match.
--
-- NOTHING IS BROKEN SERVER-SIDE. The valid token is sitting in the row the whole
-- time. This adds the one thing missing: a way for the officer's page to read it
-- back. No new column, no new state, no change to how codes are made or checked.
--
-- WHY NOT JUST SELECT THE COLUMN IN THE CLIENT. training_sessions is readable by
-- every member of the department, so adding signin_token to that select would
-- hand the code to anyone who opens the network tab — exactly what "a member must
-- not be able to fetch the code without scanning" forbids. A SECURITY DEFINER
-- function with the officer gate is the only shape that reads it back without
-- widening who can see it.
--
-- THIS FILE ADDS ONE READ-ONLY FUNCTION. It rotates nothing, writes nothing, and
-- touches neither open_signin nor close_signin nor member_check_in.
--
-- DEPLOY GATE: apply BEFORE the client deploys — the officer's page calls
-- current_signin_token by name.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- The gate below is COPIED from the live open_signin. These assert that the
-- thing being copied is really what is running, so a drifted gate fails here
-- rather than silently producing two functions that disagree about who may see
-- a sign-in code.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='open_signin') THEN
    RAISE EXCEPTION 'Precondition failed: open_signin() is missing. This file copies its gate.';
  END IF;

  -- The exact role check this file reproduces.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='open_signin'
                    AND prosrc LIKE '%access && array[''Department Admin'',''Officer'',''Project Admin'']%') THEN
    RAISE EXCEPTION 'Precondition failed: open_signin() does not carry the expected DA/Officer/PA access check. Re-capture pg_get_functiondef before copying its gate.';
  END IF;

  -- The department scope this file reproduces.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='open_signin'
                    AND prosrc ILIKE '%department_id is distinct from public.my_department_id()%') THEN
    RAISE EXCEPTION 'Precondition failed: open_signin() does not carry the expected department scope check.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='training_sessions'
                    AND column_name IN ('signin_token')) THEN
    RAISE EXCEPTION 'Precondition failed: training_sessions.signin_token is missing.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='training_sessions'
                    AND column_name = 'signin_open') THEN
    RAISE EXCEPTION 'Precondition failed: training_sessions.signin_open is missing. The getter returns null unless it is true.';
  END IF;

  RAISE NOTICE 'Pre-flight OK — open_signin present with the expected gate; both columns exist.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. current_signin_token() — read back the live code. READ ONLY.
--
-- THE GATE IS COPIED VERBATIM FROM open_signin, both the role check and the
-- department scope, character for character including the exception messages.
-- That is deliberate and is the whole security argument of this file: "who may
-- DISPLAY the code" must be the same set as "who may OPEN it", and the only way
-- to guarantee two functions agree is for the text to be identical. Refactoring
-- the shared gate into a helper would be tidier and would also be the change
-- that lets them drift the day someone edits one caller.
--
-- The messages are kept identical for the same reason: if they differed, the
-- next person diffing these two bodies would see a discrepancy and be tempted to
-- "fix" one of them. They read correctly here anyway — displaying the live code
-- IS part of running the sign-in.
--
-- NULL UNLESS signin_open. A closed sign-in has no live code to show. Returning
-- the stale column value would let a QR be re-displayed for a session whose
-- sign-in an officer had deliberately ended — and member_check_in would then
-- accept it, because it only compares the token. So the open flag is checked
-- HERE rather than relied upon downstream.
--
-- WHAT THIS DOES NOT DO: it does not rotate. open_signin mints a new code on
-- every call, which is correct for "give me a fresh code" and catastrophic for
-- "re-show the one on screen" — an officer reloading the page would invalidate a
-- code a member is mid-scan on. That distinction is the reason this function
-- exists as a separate read rather than as another call to open_signin.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_signin_token(p_session_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session public.training_sessions%rowtype;
begin
  -- ---- gate copied verbatim from open_signin ----
  if not exists (
    select 1 from public.members
    where lower(email) = lower(auth.email())
      and access && array['Department Admin','Officer','Project Admin']::text[]
  ) then
    raise exception 'You are not allowed to open a sign-in for this session.';
  end if;

  select * into v_session from public.training_sessions where id = p_session_id;
  if not found or v_session.department_id is distinct from public.my_department_id() then
    raise exception 'That training session was not found in your department.';
  end if;
  -- ---- end copied gate ----

  -- No live sign-in, no code. Not an error: the officer's page asks for every
  -- session it is showing, and most of them are legitimately closed.
  if not coalesce(v_session.signin_open, false) then
    return null;
  end if;

  return v_session.signin_token;
end;
$function$;

REVOKE ALL    ON FUNCTION public.current_signin_token(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.current_signin_token(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_signin_token(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. Shape and grants. EXPECT definer=t, volatility 's' (STABLE — it writes
-- --    nothing), anon=f, auth=t, svc=t, copies=1.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        count(*) OVER (PARTITION BY proname) AS copies,
--        prosecdef AS definer, provolatile AS vol,
--        has_function_privilege('anon',          oid,'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid,'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  oid,'EXECUTE') AS svc_exec
--   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='current_signin_token';
--
-- -- 2. THE GATE IS BYTE-IDENTICAL TO open_signin's. This is the check that keeps
-- --    "who may display" from drifting from "who may open". EXPECT both true.
-- SELECT
--   (SELECT prosrc LIKE '%access && array[''Department Admin'',''Officer'',''Project Admin'']%'
--      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='current_signin_token') AS same_role_check,
--   (SELECT prosrc ILIKE '%department_id is distinct from public.my_department_id()%'
--      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='current_signin_token') AS same_dept_check;
--
-- -- 3. IT WRITES NOTHING. EXPECT rotates=f (no update, no open_signin call).
-- SELECT (prosrc ILIKE '%update %' OR prosrc ILIKE '%open_signin%') AS rotates
--   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='current_signin_token';
--
-- -- 4. open_signin / close_signin / member_check_in ARE UNTOUCHED. Diff each
-- --    against its pre-apply capture.
-- SELECT pg_get_functiondef('public.open_signin'::regproc);
-- SELECT pg_get_functiondef('public.close_signin'::regproc);
-- SELECT pg_get_functiondef('public.member_check_in'::regproc);
--
-- ---------- SIGNED IN ----------
-- -- 5. AS A PLAIN MEMBER (no DA/Officer/PA access): calling it must RAISE
-- --    'You are not allowed to open a sign-in for this session.' That refusal is
-- --    the pass — it proves the code cannot be fetched without scanning.
-- --      SELECT public.current_signin_token('<a session id>');
-- --
-- -- 6. AS AN OFFICER on a session with sign-in OPEN: returns the 6-char code, and
-- --    it EQUALS the column. EXPECT match = true.
-- --      SELECT public.current_signin_token(ts.id) = ts.signin_token AS match
-- --        FROM public.training_sessions ts WHERE ts.id = '<that session id>';
-- --
-- -- 7. AS AN OFFICER on a session with sign-in CLOSED: returns NULL, not the
-- --    stale token.
-- --
-- -- 8. IT DID NOT ROTATE. Call it twice and compare — EXPECT the same string,
-- --    and the column unchanged.
-- --      SELECT public.current_signin_token('<id>'), public.current_signin_token('<id>');
