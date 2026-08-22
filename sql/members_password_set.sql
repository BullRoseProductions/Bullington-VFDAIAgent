-- =====================================================================
-- FORCED SET-PASSWORD GATE — the detector and its backfill.
--
-- NOT YET APPLIED. Adds a flag, backfills it, and exposes two RPCs. No behaviour changes until
-- the client gate ships alongside it.
--
-- WHY A FLAG AND NOT auth.users.encrypted_password. The obvious detector does not work: Supabase
-- populates encrypted_password for magic-link users too, so all 39 auth users already have one and
-- the column cannot tell a password the member CHOSE from a placeholder the platform generated.
-- Measured before designing this — that check is the reason the design changed.
--
-- SO THE FLAG MEANS ONE THING ONLY: "this member has set a password through our own screen." It is
-- written by mark_password_set(), which the set-password screen calls after updateUser() succeeds —
-- including on the Forgot-password path, so a recovery user is never gated afterwards.
--
-- SCOPE: this is an ONBOARDING/UX gate, not a server-side security boundary. A member could call
-- mark_password_set() directly and skip the screen — and would gain nothing by it, since the result
-- is an account with no password that they cannot sign back into. The threat model is empty; the
-- point is that invited members leave with a password they can actually use.
-- =====================================================================

BEGIN;

-- DEFAULT false is what gates everyone onboarded from here forward: neither creation path names
-- this column (the roster does insert(newRow); pa_create_department builds the row server-side), so
-- every new member row starts at false and meets the gate on first sign-in.
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS password_set boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.members.password_set IS
  'TRUE once the member has set a password through the app''s own set-password screen. NOT a claim that auth.users has a credential — Supabase populates encrypted_password for magic-link users too, which is why this flag exists.';

/* BACKFILL — exempt only members who have ACTUALLY SIGNED IN.

   Not a blanket UPDATE ... SET true. The goal is "disrupt nobody who is currently using the app",
   and a blanket update would also exempt every roster entry that has never logged in — so a member
   created last month and invited next week would sail past the gate and keep the very gap this
   closes. Confirmed against live data before running: 34 exempt (the current users), 12 not (pending
   invitees, who SHOULD be gated).

   Matched on email because that is what the invite is sent to. A member with no matching auth user,
   or one who has never signed in, keeps false. */
UPDATE public.members m
   SET password_set = true
 WHERE EXISTS (
   SELECT 1 FROM auth.users u
    WHERE lower(u.email) = lower(m.email)
      AND u.last_sign_in_at IS NOT NULL
 );

/* READ — the gate's detector.

   COALESCE TO TRUE is deliberate: no member row means no profile, and someone in that state has
   bigger problems than this gate. Returning false would strand them on a screen they cannot leave,
   because the sign-out control lives inside the app they cannot reach. Fail open. */
CREATE OR REPLACE FUNCTION public.has_password()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(
    (SELECT m.password_set FROM public.members m WHERE m.id = public.my_member_id()),
    true
  );
$function$;

/* WRITE — only ever sets TRUE, only ever for the caller.

   NO PARAMETER, on purpose. A mark_password_set(uuid) would let any signed-in member flip the flag
   for somebody else, which would silently exempt that person from ever being asked for a password.
   Without a parameter there is nothing to aim. */
CREATE OR REPLACE FUNCTION public.mark_password_set()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid := public.my_member_id();
BEGIN
  IF v_id IS NULL THEN
    RETURN false;                       -- no member row: nothing to mark, and the read fails open anyway
  END IF;
  UPDATE public.members SET password_set = true WHERE id = v_id;
  RETURN true;
END;
$function$;

-- Postgres default-grants EXECUTE to PUBLIC, so the REVOKEs are mandatory, not decoration.
REVOKE EXECUTE ON FUNCTION public.has_password()      FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.mark_password_set() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.has_password()      TO authenticated;
GRANT  EXECUTE ON FUNCTION public.mark_password_set() TO authenticated;

COMMIT;

-- Without this, PostgREST keeps serving a cached schema with no password_set and no has_password,
-- and every gate check 404s — which fails OPEN and would look like the gate simply not working.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. THE BACKFILL SPLIT. Expect exempt 34 / gated 12, matching the pre-flight count.
-- --    If exempt is 0 the email match failed and NOBODY is exempt — every current user would be
-- --    gated on next load. Check this before letting anyone sign in.
-- SELECT count(*) FILTER (WHERE password_set)     AS exempt,
--        count(*) FILTER (WHERE NOT password_set) AS will_be_gated,
--        count(*)                                 AS members_total
--   FROM public.members;
--
-- -- 2. Who is still gated — sanity-check that these really are pending invitees.
-- SELECT m.name, m.email, m.status,
--        (SELECT u.last_sign_in_at FROM auth.users u WHERE lower(u.email) = lower(m.email)) AS last_sign_in
--   FROM public.members m WHERE NOT m.password_set ORDER BY m.name;
--
-- -- 3. Column shape: NOT NULL, default false — this is what gates future invitees.
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='members' AND column_name='password_set';
--
-- -- 4. Grants. Expect anon=f, authenticated=t on both.
-- SELECT proname,
--        has_function_privilege('anon', oid, 'EXECUTE')          AS anon,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth,
--        prosecdef AS definer, pg_get_userbyid(proowner) AS owner
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('has_password','mark_password_set') ORDER BY proname;
--
-- -- 5. As postgres in this editor my_member_id() is NULL, so has_password() must return TRUE —
-- --    that IS the fail-open path working. It proves nothing about a real member; step 6 does.
-- SELECT public.has_password() AS should_be_true_here;
--
-- -- 6. FUNCTIONAL TEST — from the app, in this order. The first one is the regression that matters:
-- --      * existing member signs in with email + password  -> lands in the app, NO gate
-- --      * pending invitee opens their magic link          -> gate appears
-- --      * sets a password                                 -> enters the app
-- --      * signs out, signs back in with that password     -> no gate (the flag flipped)
-- --      * Forgot-password on a gated account (password_set = false)  -> recovery screen, sets a
-- --        password, and lands IN THE APP — NOT the firstTime gate. This one is easy to get wrong:
-- --        the gate's check is keyed on the user id, which does not change when the recovery flag
-- --        clears, so a cached "false" would re-gate them the instant recovery finished.
-- --      * reload while gated                              -> still gated (live check, not a flag in the client)
