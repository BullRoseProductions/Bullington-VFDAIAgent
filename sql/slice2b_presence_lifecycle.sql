-- =====================================================================
-- SLICE 2b — presence-row lifecycle hardening. Two changes, one transaction.
--
-- RUN ONLY AFTER slice0 / slice1 / slice2 ARE LIVE.
--
--   (1) "Unverified = no clock" — member_check_in stops creating a training
--       presence row when we cannot vouch for the member's location.
--   (2) Close-on-delete — deleting a session closes its open training rows
--       BEFORE the FK nulls session_id, so a delete can never strand a row open.
--
-- NO CLIENT CHANGE. Signatures, argument order, defaults and return values are
-- all unchanged; the client keeps calling member_check_in exactly as it does
-- today and keeps getting 'recorded' / 'already'.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. member_check_in — gate the presence row on verification.
--
-- CREATE OR REPLACE, not DROP + CREATE: the argument types are identical to the
-- live 5-arg function, so this replaces the body in place. No second overload is
-- created, so the PGRST203 ambiguity that would break check-in outright cannot
-- occur. Everything outside the marked block is byte-identical to slice1.
--
-- THE RULE, by case:
--   • verified at a pinned station  → row created, verified = true   (on the clock)
--   • station not pinned            → row created, verified = false  (allow-but-flag:
--       the department cannot verify ANYONE until they pin a station, so we must
--       not block them — the row is flagged unverified and ISO can exclude it)
--   • pinned station, not verified  → NO row (off-site, or GPS denied/inaccurate).
--       They are still signed in for attendance; they are simply not on the clock.
--
-- session_attendance is inserted in EVERY case, unchanged, and the
-- 'recorded'/'already' return still reflects only that insert — sign-in and
-- time-credit are deliberately separate outcomes.
--
-- v_pinned DEFAULTS TO TRUE so that if the departments row somehow does not
-- resolve, we fall to the strict branch (no row) rather than silently minting an
-- unverified clock entry. Fail closed, not open.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_check_in(
  p_session_id uuid, p_token text,
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_accuracy double precision DEFAULT NULL::double precision
) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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

  IF v_session.signin_token IS NULL OR v_session.signin_token <> p_token THEN
    RAISE EXCEPTION 'Invalid or expired sign-in code — scan the current QR.';
  END IF;

  INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at)
  VALUES (v_dept, p_session_id, v_member, now())
  ON CONFLICT (session_id, member_id) DO NOTHING;
  v_recorded := FOUND;

  -- ---- CHANGED IN 2b: the presence row is now conditional ----
  v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);

  SELECT (station_lat IS NOT NULL AND station_lng IS NOT NULL)
    INTO v_pinned
    FROM public.departments
   WHERE id = v_dept;

  IF v_verified OR NOT v_pinned THEN
    INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, session_id)
    VALUES (v_dept, v_member, v_verified, 'geo', 'training', p_session_id)
    ON CONFLICT (member_id, session_id) WHERE kind = 'training' AND session_id IS NOT NULL DO NOTHING;
  END IF;
  -- ---- END CHANGED BLOCK ----

  IF v_recorded THEN RETURN 'recorded'; ELSE RETURN 'already'; END IF;
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so these are belt-and-braces —
-- they restate slice1's grants so the file is safe to run on its own.
REVOKE ALL ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision)
  TO authenticated;


-- ---------------------------------------------------------------------
-- 2. Close-on-delete — BEFORE DELETE on training_sessions.
--
-- station_presence_session_id_fkey is ON DELETE SET NULL (confdeltype = 'n'), so
-- deleting a session nulls session_id on its presence rows. An OPEN training row
-- that loses its session_id can never be closed afterwards: the finalize trigger
-- keys on session_id, and the session it pointed at no longer exists. It would
-- sit open forever, crediting nothing and cluttering "who's on station now".
--
-- BEFORE DELETE is load-bearing — it must run while session_id still points at
-- OLD.id. An AFTER DELETE trigger would fire after the FK action had already
-- nulled the column, and would match nothing.
--
-- "Close and keep": the hours survive as closed rows. They lose the session link
-- (SET NULL), so provenance is gone but the credited time is not silently
-- destroyed along with the session.
--
-- RETURN OLD is required. A BEFORE DELETE trigger that returns NULL CANCELS the
-- delete — sessions must stay deletable.
--
-- SECURITY DEFINER for the same reason as the finalize trigger: station_presence
-- has RLS and the deleting officer has no UPDATE grant over other members' rows,
-- so as invoker this would silently update 0 rows.
--
-- Idempotent via `checked_out_at IS NULL` — already-closed rows keep their
-- original stop time and are never re-stamped.
--
-- The partial index added in slice2 (station_presence_open_training_by_session)
-- serves this UPDATE too — same WHERE shape, keyed on session_id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_training_presence_on_session_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.station_presence
     set checked_out_at = now()
   where session_id = old.id
     and kind = 'training'
     and checked_out_at is null;
  return old;   -- BEFORE DELETE: returning NULL would cancel the delete
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.close_training_presence_on_session_delete() FROM anon, public;

DROP TRIGGER IF EXISTS trg_close_training_presence_on_session_delete ON public.training_sessions;
CREATE TRIGGER trg_close_training_presence_on_session_delete
  BEFORE DELETE ON public.training_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.close_training_presence_on_session_delete();

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
-- -- 1. Still exactly ONE member_check_in, still 5 args (no overload created):
-- SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc WHERE proname = 'member_check_in' AND pronamespace = 'public'::regnamespace;
--
-- -- 2. Grants survived the replace — anon false, authenticated true:
-- SELECT has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p WHERE p.proname = 'member_check_in' AND p.pronamespace = 'public'::regnamespace;
--
-- -- 3. BOTH triggers present on training_sessions (finalize + delete):
-- SELECT tgname, pg_get_triggerdef(oid)
--   FROM pg_trigger
--  WHERE tgrelid = 'public.training_sessions'::regclass AND NOT tgisinternal
--  ORDER BY tgname;
--
-- -- 4. The delete trigger's function is SECURITY DEFINER (prosecdef = true):
-- SELECT proname, prosecdef, proconfig
--   FROM pg_proc
--  WHERE proname = 'close_training_presence_on_session_delete'
--    AND pronamespace = 'public'::regnamespace;
--
-- -- 5. Is this department pinned? Decides which branch a scan takes.
-- --    Both non-null → strict (unverified scans get NO presence row).
-- --    Either null   → allow-but-flag (rows created with verified = false).
-- SELECT id, name, station_lat, station_lng, station_radius_m
--   FROM public.departments;
--
-- -- 6. After a scan: attendance should ALWAYS have a row; presence only when
-- --    verified (or the station is unpinned). Compare the two counts.
-- SELECT (SELECT count(*) FROM public.session_attendance WHERE session_id = '<session-uuid>') AS signed_in,
--        (SELECT count(*) FROM public.station_presence
--          WHERE session_id = '<session-uuid>' AND kind = 'training')                          AS on_the_clock;
--
-- -- 7. No open training row may outlive its session. Expect 0 rows, always.
-- SELECT sp.id, sp.member_id, sp.session_id, sp.checked_in_at
--   FROM public.station_presence sp
--  WHERE sp.kind = 'training'
--    AND sp.checked_out_at IS NULL
--    AND (sp.session_id IS NULL
--         OR NOT EXISTS (SELECT 1 FROM public.training_sessions ts WHERE ts.id = sp.session_id));
