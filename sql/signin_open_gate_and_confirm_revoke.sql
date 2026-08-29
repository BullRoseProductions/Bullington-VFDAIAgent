-- =====================================================================
-- SIGN-IN HARDENING + THE QUEUED confirm_on_station REVOKE.
--
-- WHAT THIS IS NOT. It is not a fix for a live exposure — there isn't one.
-- close_signin already sets signin_token = null alongside signin_open = false,
-- and member_check_in rejects a null token before comparing it. A session closed
-- through the app therefore validates nothing. Both halves are already shut.
--
-- WHAT IT IS. Defence in depth on a path that currently trusts the token ALONE.
-- member_check_in gates on: member/dept resolve, session exists, department
-- match, done, token match. It never asks whether the sign-in is OPEN. That is
-- safe only for as long as every writer that closes a sign-in also clears the
-- token — an invariant held today by exactly one function and by nothing else.
--
-- We proved that invariant is fragile on 2026-08-29 by breaking it ourselves:
-- closing two stale sign-ins by direct UPDATE, we set signin_open = false and
-- ROTATED the token rather than nulling it, producing two rows in exactly the
-- shape close_signin never produces — closed, not done, token populated. Under
-- the current gates those rows would accept a check-in from anyone holding the
-- code. Nobody holds it, so nothing happened. Next time it might be a printed
-- QR and a manual fix rather than a generated string nobody has seen.
--
-- So: gate the check-in path on signin_open, and put those two rows back into
-- the state close_signin would have left them in.
--
-- Section 3 is unrelated housekeeping that has been waiting for a migration to
-- ride with rather than being applied as a loose statement.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- Both bodies were captured live before this file was written. These checks
-- fail the apply if either has drifted since, rather than silently overwriting
-- someone else's change. plpgsql bodies are NOT catalog-checked at CREATE time,
-- so a drifted dependency surfaces at runtime, not here — which is exactly why
-- the assertions are explicit.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_exposed integer;
BEGIN
  -- The signature must be the 5-arg form. CREATE OR REPLACE only preserves
  -- grants when the signature is identical; a mismatch here means the REPLACE
  -- below would create a SECOND overload and leave the old one callable.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace
                    AND proname = 'member_check_in'
                    AND pronargs = 5) THEN
    RAISE EXCEPTION 'Precondition failed: member_check_in is not the expected 5-argument function. Found: %',
      (SELECT string_agg(format('%s(%s)', proname, pg_get_function_identity_arguments(oid)), ' | ')
         FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'member_check_in');
  END IF;

  -- Exactly one overload, or ::regproc casts elsewhere become ambiguous.
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace AND proname = 'member_check_in') <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: member_check_in is overloaded. Resolve before replacing.';
  END IF;

  -- The token check this file preserves verbatim. If it has changed, the body
  -- below is stale and must be re-captured.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace AND proname = 'member_check_in'
                    AND prosrc LIKE '%v_session.signin_token IS NULL OR v_session.signin_token <> p_token%') THEN
    RAISE EXCEPTION 'Precondition failed: member_check_in token check is not the captured text. Re-capture pg_get_functiondef before replacing.';
  END IF;

  -- The gate must not already be present — if it is, someone else added it and
  -- this file would be reverting their wording.
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'member_check_in'
                AND prosrc ILIKE '%signin_open%') THEN
    RAISE EXCEPTION 'Precondition failed: member_check_in already references signin_open. Nothing to add.';
  END IF;

  -- close_signin must still be the thing that makes the gate belt-and-braces
  -- rather than load-bearing. If it has stopped nulling the token, that is a
  -- real exposure and wants its own review, not a silent apply.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace AND proname = 'close_signin'
                    AND prosrc ILIKE '%signin_token = null%') THEN
    RAISE EXCEPTION 'Precondition failed: close_signin no longer nulls signin_token. This changes the risk picture — review before applying.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace
                    AND proname = 'confirm_on_station' AND pronargs = 4) THEN
    RAISE EXCEPTION 'Precondition failed: confirm_on_station(uuid, double, double, double) is missing. Section 3 targets it.';
  END IF;

  -- ON THE RECORD: how many rows are in the closed-not-done-with-token shape
  -- right now. Expect 2 — the two we created by hand on 2026-08-29. A larger
  -- number means another writer is producing them and the gate is load-bearing
  -- rather than precautionary.
  SELECT count(*) INTO v_exposed
    FROM public.training_sessions
   WHERE coalesce(signin_open, false) = false
     AND coalesce(done, false) = false
     AND signin_token IS NOT NULL;
  RAISE NOTICE 'Rows currently closed, not done, and still holding a token: %', v_exposed;

  RAISE NOTICE 'Pre-flight OK.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. member_check_in — add the signin_open gate. EVERYTHING ELSE IS VERBATIM.
--
-- CREATE OR REPLACE with the signature UNCHANGED, so the existing ACL is
-- preserved. A DROP + CREATE here would discard grants silently — it did
-- exactly that to dept_shifts_needing_review and geofence_arrive earlier in
-- this same body of work, both caught only by review. There is no reason to
-- drop: the signature is not changing.
--
-- The gate sits next to the `done` check, both being "this session is not
-- accepting attendance right now" conditions, and BEFORE the token comparison
-- so a closed session never has its code tested at all.
--
-- WORDING. This message is read by a member who has just scanned a QR at a
-- training. It has to say what happened and what to do, without implying they
-- did something wrong — the code was valid, the sign-in simply is not open.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_check_in(p_session_id uuid, p_token text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy double precision DEFAULT NULL::double precision)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session  public.training_sessions%ROWTYPE;
  v_member   uuid := public.my_member_id();
  v_dept     uuid := public.my_department_id();
  v_recorded boolean := false;
  v_verified boolean := false;
  v_pinned   boolean := true;   -- fail closed if the department row does not resolve
BEGIN
  IF v_member IS NULL OR v_dept IS NULL THEN
    RAISE EXCEPTION 'We could not match your login to a member record.';
  END IF;

  SELECT * INTO v_session FROM public.training_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That training session was not found.';
  END IF;

  IF v_session.department_id IS DISTINCT FROM v_dept THEN
    RAISE EXCEPTION 'That session is not in your department.';
  END IF;

  IF v_session.done THEN
    RAISE EXCEPTION 'This session is complete — attendance is locked.';
  END IF;

  -- ---- ADDED: the sign-in must be OPEN, not merely hold a matching code ----
  -- Without this, "is this sign-in open?" is answered indirectly, by whether
  -- some other function remembered to clear the token when closing. That is an
  -- invariant maintained by one writer and breakable by any direct UPDATE.
  IF NOT coalesce(v_session.signin_open, false) THEN
    RAISE EXCEPTION 'Sign-in for this session has closed — ask your training officer to reopen it.';
  END IF;
  -- ---- END ADDED ----

  IF v_session.signin_token IS NULL OR v_session.signin_token <> p_token THEN
    RAISE EXCEPTION 'Invalid or expired sign-in code — scan the current QR.';
  END IF;

  INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at)
  VALUES (v_dept, p_session_id, v_member, now())
  ON CONFLICT (session_id, member_id) DO NOTHING;
  v_recorded := FOUND;

  -- ---- CHANGED IN C3: branch on the FLAG, not on whether coordinates exist ----
  IF v_session.is_offsite THEN
    IF v_session.location_lat IS NOT NULL AND v_session.location_lng IS NOT NULL THEN
      v_verified := public.is_at_point(
        v_session.location_lat, v_session.location_lng,
        coalesce(v_session.location_radius_m,
                 (SELECT station_radius_m FROM public.departments WHERE id = v_dept),
                 400),
        p_lat, p_lng, p_accuracy);
    ELSE
      -- Off-site, but nobody has captured where. NEVER fall back to the station:
      -- they are not there. No clock; attendance above still stands.
      v_verified := false;
    END IF;
    v_pinned := true;   -- an off-site session is always "pinned" for gate purposes
  ELSE
    v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);
    SELECT (station_lat IS NOT NULL AND station_lng IS NOT NULL)
      INTO v_pinned
      FROM public.departments
     WHERE id = v_dept;
  END IF;
  -- ---- END CHANGED BLOCK ----

  IF v_verified OR NOT v_pinned THEN
    INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, session_id)
    VALUES (v_dept, v_member, v_verified, 'geo', 'training', p_session_id)
    ON CONFLICT (member_id, session_id) WHERE kind = 'training' AND session_id IS NOT NULL DO NOTHING;
  END IF;

  IF v_recorded THEN RETURN 'recorded'; ELSE RETURN 'already'; END IF;
END;
$function$;

-- STATE THE GRANTS RATHER THAN ASSUMING THEM.
--
-- CREATE OR REPLACE with an unchanged signature preserves the ACL, and the
-- precondition above asserts the signature so that holds. But "the ACL survived"
-- was left as an unstated assumption, and an unstated assumption about grants is
-- exactly what stripped service_role from dept_shifts_needing_review and
-- geofence_arrive earlier in this work — both caught by review, neither by the
-- migration that caused them.
--
-- These are idempotent: re-granting a privilege that is already held is a no-op.
-- They cost nothing and they turn a silent, scan-time outage into something the
-- file guarantees. anon is deliberately NOT granted — see revoke_anon_execute_sweep.
GRANT EXECUTE ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision) TO service_role;


-- ---------------------------------------------------------------------
-- 2. Put the two hand-closed rows back into close_signin's own end state.
--
-- On 2026-08-29 two stale sign-ins were closed by direct UPDATE, rotating the
-- token instead of nulling it. close_signin nulls. Rotating left them closed,
-- not done, and holding a code — the one shape the app never produces.
--
-- Scoped to rows that are ALREADY CLOSED, so this can never clear a token from
-- a sign-in someone is actively using. Not scoped to the two ids, deliberately:
-- if some other row is in this shape, it wants the same correction, and the
-- precondition NOTICE above reports how many were found.
--
-- close_signin itself is NOT modified. It is already correct.
-- ---------------------------------------------------------------------
UPDATE public.training_sessions
   SET signin_token = null
 WHERE coalesce(signin_open, false) = false
   AND signin_token IS NOT NULL;


-- ---------------------------------------------------------------------
-- 3. HOUSEKEEPING — the queued REVOKE, riding with this migration rather than
-- being applied as a loose statement.
--
-- confirm_on_station is called only by geofence_confirm_presence, which resolves
-- the member from my_member_id() and can therefore only ever confirm the
-- caller's own row. service_role bypasses that: holding EXECUTE on the inner
-- function would let a server-side caller confirm presence for ANY shift id,
-- which is the one thing the own-row-only design exists to prevent.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.confirm_on_station(uuid, double precision, double precision, double precision) FROM service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after, separately)
-- =====================================================================
--
-- -- 1. GRANTS SURVIVED THE REPLACE. This is the check that catches the failure
-- --    mode this file was written to avoid. EXPECT anon=f, auth=t, svc=t,
-- --    copies=1, definer=t.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        count(*) OVER (PARTITION BY proname) AS copies,
--        prosecdef AS definer,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  oid, 'EXECUTE') AS svc_exec
--   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'member_check_in';
--
-- -- 2. THE GATE IS PRESENT, and the rest of the body is unchanged.
-- SELECT prosrc ILIKE '%NOT coalesce(v_session.signin_open, false)%'                        AS gate_present,
--        prosrc LIKE  '%v_session.signin_token IS NULL OR v_session.signin_token <> p_token%' AS token_check_intact,
--        prosrc LIKE  '%CHANGED IN C3%'                                                     AS c3_block_intact
--   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'member_check_in';
--
-- -- 3. NO ROW IS CLOSED WITH A LIVE TOKEN. EXPECT 0.
-- SELECT count(*) AS closed_but_holding_a_token
--   FROM public.training_sessions
--  WHERE coalesce(signin_open, false) = false AND signin_token IS NOT NULL;
--
-- -- 4. OPEN SIGN-INS ARE UNTOUCHED — section 2 must not have cleared a live one.
-- --    Every open sign-in should still hold its code.
-- SELECT count(*) FILTER (WHERE signin_token IS NULL) AS open_but_no_token   -- expect 0
--   FROM public.training_sessions WHERE signin_open IS true;
--
-- -- 5. confirm_on_station: service_role EXECUTE is gone, everything else as it was.
-- --    EXPECT anon=f, auth=f, svc=f — the function is reachable ONLY through
-- --    geofence_confirm_presence, which is the whole design.
-- SELECT has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  oid, 'EXECUTE') AS svc_exec
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace AND proname = 'confirm_on_station' AND pronargs = 4;
--
-- -- 6. close_signin UNTOUCHED. Diff against the pre-apply capture.
-- SELECT pg_get_functiondef('public.close_signin'::regproc);
--
-- ---------- SIGNED IN ----------
-- -- 7. A CLOSED SESSION REFUSES A CHECK-IN. As a member, against a session with
-- --    signin_open = false, EXPECT: 'Sign-in for this session has closed — ask
-- --    your training officer to reopen it.' The refusal is the pass.
-- --
-- -- 8. AN OPEN SESSION STILL WORKS. As a member, with the current QR code,
-- --    EXPECT 'recorded' (or 'already' on a second call). This is the
-- --    regression check that matters most: the gate must not break real sign-ins.
-- --
-- -- 9. OFFICER ROSTER MARKING IS UNAFFECTED. toggleAttend writes session_attendance
-- --    directly and never calls this function, so marking a roster on a closed or
-- --    past session must still work. Confirm in the UI, not just in SQL.
