-- =====================================================================
-- SLICE 1 — geo-verified training scan, materialized into station_presence.
--
-- RUN ONLY AFTER sql/slice0_training_ledger_safety.sql IS LIVE. Slice 0 adds the
-- partial unique index this file's ON CONFLICT targets, and stops a standby
-- check-out from closing the training rows this file starts creating.
--
-- DEPLOY ORDER: this SQL first, THEN the client build. A new client sending 5
-- args to the old 2-arg member_check_in gets no match; SQL-first works for both
-- old and new clients (an old 2-arg call resolves via the DEFAULTs and simply
-- writes an unverified training row).
--
-- VERIFIED AGAINST THE LIVE DATABASE before saving:
--   • station_check_in already has 5 args (p_lat, p_lng, p_accuracy, p_kind text,
--     p_session_id uuid) and nargs=1 — so CREATE OR REPLACE below matches the
--     existing signature and creates NO overload. This was the PGRST203 risk.
--   • haversine tokens are byte-identical to the live body:
--       line 21  if v_lat is not null and v_lng is not null and p_lat is not null and …
--       line 22  v_dist := 6371000 * 2 * asin(sqrt(
--       line 24  + cos(radians(v_lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - v_lng) / 2), 2)));
--       line 25  v_verified := (v_dist <= coalesce(v_radius, 150))
--       line 26  and (p_accuracy is null or p_accuracy <= coalesce(v_radius, 150));
--   • station_presence.checked_in_at DEFAULT now() NOT NULL — so omitting it from
--     the inserts is correct, matching the live standby insert (line 29).
--   • source DEFAULT 'geo'::text, no CHECK constraint on source → 'geo' accepted.
--   • kind CHECK = ARRAY['training','standby','incident'] → 'training' allowed,
--     and matches station_check_in's own p_kind validation.
-- =====================================================================

BEGIN;

-- 1. Shared geo-verification helper, lifted verbatim from station_check_in's check.
CREATE OR REPLACE FUNCTION public.is_at_station(
  p_dept uuid, p_lat double precision, p_lng double precision, p_accuracy double precision
) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_lat double precision; v_lng double precision; v_radius integer;
  v_dist double precision;
  v_verified boolean := false;
begin
  select station_lat, station_lng, station_radius_m into v_lat, v_lng, v_radius
    from public.departments where id = p_dept;
  if v_lat is not null and v_lng is not null and p_lat is not null and p_lng is not null then
    v_dist := 6371000 * 2 * asin(sqrt(
      power(sin(radians(p_lat - v_lat) / 2), 2)
      + cos(radians(v_lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - v_lng) / 2), 2)));
    v_verified := (v_dist <= coalesce(v_radius, 150))
                  and (p_accuracy is null or p_accuracy <= coalesce(v_radius, 150));
  end if;
  return v_verified;
end;
$function$;

-- keep the helper internal (only the SECURITY DEFINER RPCs call it; never exposed via the API)
REVOKE ALL ON FUNCTION public.is_at_station(uuid, double precision, double precision, double precision)
  FROM public, anon, authenticated;

-- 2. station_check_in refactored to call the helper — same signature, behaviour-preserving.
CREATE OR REPLACE FUNCTION public.station_check_in(p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_accuracy double precision DEFAULT NULL::double precision, p_kind text DEFAULT 'standby'::text, p_session_id uuid DEFAULT NULL::uuid)
 RETURNS station_presence
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_member uuid := public.my_member_id();
  v_dept   uuid := public.my_department_id();
  v_verified boolean := false;
  v_row public.station_presence;
begin
  if v_member is null or v_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  if p_kind not in ('training','standby','incident') then
    raise exception 'Invalid session type.';
  end if;
  select * into v_row from public.station_presence
    where member_id = v_member and checked_out_at is null
    order by checked_in_at desc limit 1;
  if found then return v_row; end if;
  v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);
  insert into public.station_presence (department_id, member_id, verified, source, kind, session_id)
  values (v_dept, v_member, v_verified, 'geo', p_kind, p_session_id)
  returning * into v_row;
  return v_row;
end;
$function$;

-- 3. member_check_in: drop the 2-arg, create the single 5-arg (geo-verify + write the training presence row).
DROP FUNCTION public.member_check_in(uuid, text);

CREATE FUNCTION public.member_check_in(
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

  INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, session_id)
  VALUES (v_dept, v_member, public.is_at_station(v_dept, p_lat, p_lng, p_accuracy), 'geo', 'training', p_session_id)
  ON CONFLICT (member_id, session_id) WHERE kind = 'training' AND session_id IS NOT NULL DO NOTHING;

  IF v_recorded THEN RETURN 'recorded'; ELSE RETURN 'already'; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.member_check_in(uuid, text, double precision, double precision, double precision)
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ---- VERIFY (run after) ----
-- -- exactly ONE member_check_in, with 5 args:
-- SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc WHERE proname='member_check_in' AND pronamespace='public'::regnamespace;
-- -- anon must have nothing; authenticated must have EXECUTE:
-- SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p WHERE p.proname='member_check_in' AND p.pronamespace='public'::regnamespace;
-- -- helper stays internal (all three false):
-- SELECT has_function_privilege('anon', p.oid, 'EXECUTE'),
--        has_function_privilege('authenticated', p.oid, 'EXECUTE')
--   FROM pg_proc p WHERE p.proname='is_at_station' AND p.pronamespace='public'::regnamespace;
-- -- station_check_in still single-signature (no overload created):
-- SELECT count(*) FROM pg_proc WHERE proname='station_check_in' AND pronamespace='public'::regnamespace;
