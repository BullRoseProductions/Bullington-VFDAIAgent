-- =====================================================================
-- SLICE 7C-2 (Part B) — disarm the ad-hoc off-site RPC.
--
-- The "Working off-site?" button is gone from the client. That removes the UI
-- caller, NOT the API: offsite_check_in is still GRANT EXECUTE ... TO
-- authenticated, so any signed-in member could still hit it directly and land a
-- row in the approval queue. This makes "nothing calls it" ENFORCED rather than
-- assumed.
--
-- REVOKE, NOT DROP. The function, kind='offsite', the approval queue and the
-- off-site columns all stay. Dropping them would be a bigger change with more
-- risk and no benefit — and if an ad-hoc path is ever wanted again, restoring
-- it is one GRANT rather than a rebuild.
--
-- SIGNATURE IS DISCOVERED, NOT ASSUMED. I could not read pg_proc first — the
-- Supabase session was expired — so rather than hard-code
-- (text, double precision, double precision, double precision) and hope, this
-- looks the signature up at run time and REFUSES if it finds anything other
-- than exactly one overload. Same discipline as the B1 constraint-name lookup.
-- =====================================================================

BEGIN;

DO $$
DECLARE
  v_n    int;
  v_args text;
BEGIN
  ------------------------------------------------------------------
  -- offsite_check_in — must exist, must be unambiguous.
  ------------------------------------------------------------------
  SELECT count(*) INTO v_n
    FROM pg_proc
   WHERE proname = 'offsite_check_in' AND pronamespace = 'public'::regnamespace;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'offsite_check_in does not exist — expected it from B3. Stop and inspect.';
  ELSIF v_n > 1 THEN
    RAISE EXCEPTION 'Found % overloads of offsite_check_in — ambiguous, refusing to guess which to revoke. Inspect pg_proc.', v_n;
  END IF;

  SELECT pg_get_function_identity_arguments(oid) INTO v_args
    FROM pg_proc
   WHERE proname = 'offsite_check_in' AND pronamespace = 'public'::regnamespace;

  EXECUTE format('REVOKE EXECUTE ON FUNCTION public.offsite_check_in(%s) FROM authenticated', v_args);
  RAISE NOTICE 'Revoked EXECUTE on offsite_check_in(%) from authenticated.', v_args;

  ------------------------------------------------------------------
  -- offsite_check_out — may never have been built. B2 widened
  -- station_check_out to kind IN ('standby','offsite'), which made a separate
  -- off-site check-out unnecessary, so B3 deliberately did not create one.
  -- Handle both worlds without assuming either.
  ------------------------------------------------------------------
  SELECT count(*) INTO v_n
    FROM pg_proc
   WHERE proname = 'offsite_check_out' AND pronamespace = 'public'::regnamespace;

  IF v_n = 0 THEN
    RAISE NOTICE 'offsite_check_out does not exist — never built (B2 widened station_check_out instead). Nothing to revoke.';
  ELSIF v_n > 1 THEN
    RAISE EXCEPTION 'Found % overloads of offsite_check_out — ambiguous, refusing to guess. Inspect pg_proc.', v_n;
  ELSE
    SELECT pg_get_function_identity_arguments(oid) INTO v_args
      FROM pg_proc
     WHERE proname = 'offsite_check_out' AND pronamespace = 'public'::regnamespace;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.offsite_check_out(%s) FROM authenticated', v_args);
    RAISE NOTICE 'Revoked EXECUTE on offsite_check_out(%) from authenticated.', v_args;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. offsite_check_in STILL EXISTS and is now callable by nobody.
-- --    Expect: exists=t, anon=f, auth=f, public=f.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        format('anon=%s auth=%s public=%s',
--               has_function_privilege('anon',          oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE'),
--               has_function_privilege('public',        oid, 'EXECUTE')) AS grants
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('offsite_check_in','offsite_check_out')
--  ORDER BY proname;
-- -- offsite_check_out returning no row is correct — it was never built.
--
-- -- 2. The things that must NOT have changed. station_check_out still closes
-- --    off-site rows, and the approval path is still reachable by leadership.
-- --    Expect auth=t on all three.
-- SELECT proname,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_can
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('station_check_out','approve_offsite','reject_offsite','dept_shifts_needing_review')
--  ORDER BY proname;
--
-- -- 3. station_check_out still carries the widened filter (B2 intact):
-- SELECT prosrc ILIKE '%kind in (''standby'',''offsite'')%' AS still_widened
--   FROM pg_proc WHERE proname='station_check_out' AND pronamespace='public'::regnamespace;
--
-- -- 4. No off-site rows were created before the button came out. If this is
-- --    non-zero, those rows are real and still need deciding in the queue —
-- --    the revoke does not orphan them, approve_offsite/reject_offsite still work.
-- SELECT count(*) AS offsite_rows,
--        count(*) FILTER (WHERE approved_at IS NULL) AS still_pending
--   FROM public.station_presence WHERE kind = 'offsite';
