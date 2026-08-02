-- =====================================================================
-- member_devices — one row per device install that can receive a push.
--
-- The token is the natural key: FCM issues one per app install, it can be
-- reassigned to a different user if someone signs out and another signs in on
-- the same phone, and it rotates on reinstall. So token is UNIQUE and the
-- upsert moves it to whoever registered it last — otherwise a shared station
-- iPad would keep pushing one member's items to the next member holding it.
--
-- Stale tokens are NOT pruned here. FCM reports them as UNREGISTERED at send
-- time; the sender deletes them then (see api/digest.js), which is the only
-- moment we actually learn a token is dead.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.member_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  platform    text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_devices_member_id_idx ON public.member_devices (member_id);

ALTER TABLE public.member_devices ENABLE ROW LEVEL SECURITY;

-- A member sees and manages ONLY their own devices. Nobody — not officers, not
-- DAs — has any business reading another member's device tokens: a token is a
-- send-capability, not a compliance record.
DROP POLICY IF EXISTS member_devices_select_own ON public.member_devices;
CREATE POLICY member_devices_select_own ON public.member_devices
  FOR SELECT TO authenticated
  USING (member_id = public.my_member_id());

DROP POLICY IF EXISTS member_devices_insert_own ON public.member_devices;
CREATE POLICY member_devices_insert_own ON public.member_devices
  FOR INSERT TO authenticated
  WITH CHECK (member_id = public.my_member_id());

DROP POLICY IF EXISTS member_devices_update_own ON public.member_devices;
CREATE POLICY member_devices_update_own ON public.member_devices
  FOR UPDATE TO authenticated
  USING (member_id = public.my_member_id())
  WITH CHECK (member_id = public.my_member_id());

DROP POLICY IF EXISTS member_devices_delete_own ON public.member_devices;
CREATE POLICY member_devices_delete_own ON public.member_devices
  FOR DELETE TO authenticated
  USING (member_id = public.my_member_id());

-- Register/refresh this device for the CALLING member. SECURITY DEFINER so the
-- claim of member_id can't be forged: it is taken from the JWT, never the client.
CREATE OR REPLACE FUNCTION public.register_device(p_token text, p_platform text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member uuid := public.my_member_id();
BEGIN
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'no member for the current user';
  END IF;
  IF p_token IS NULL OR length(trim(p_token)) = 0 THEN
    RAISE EXCEPTION 'token required';
  END IF;
  IF p_platform NOT IN ('ios', 'android', 'web') THEN
    RAISE EXCEPTION 'unsupported platform: %', p_platform;
  END IF;

  INSERT INTO public.member_devices (member_id, token, platform, updated_at)
  VALUES (v_member, trim(p_token), p_platform, now())
  ON CONFLICT (token) DO UPDATE
    SET member_id = EXCLUDED.member_id,     -- device changed hands → follows the new signed-in member
        platform  = EXCLUDED.platform,
        updated_at = now();
END;
$$;

-- Postgres default-grants EXECUTE to PUBLIC, so the REVOKE is mandatory.
REVOKE EXECUTE ON FUNCTION public.register_device(text, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.register_device(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ---- VERIFY ----
-- SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
-- FROM pg_policy WHERE polrelid = 'public.member_devices'::regclass;
-- SELECT proname, proacl FROM pg_proc WHERE proname = 'register_device';
