-- =====================================================================
-- NOTIFICATION PREFERENCES — slice 1. INERT.
--
-- Nothing reads this yet. api/pulse.js (slice 2) is flag-gated off and sends
-- nothing; enforcement lands in slice 5. Applying this changes no behaviour.
--
-- ABSENCE MEANS ON. There is deliberately no seeding and no backfill: a member
-- with no row for a family is opted IN. Only an explicit enabled = false opts
-- out. The alternative — a row per member per family — turns every new
-- notification family into a data migration forever, and leaves a window where
-- a member created between the migration and the next backfill silently
-- receives nothing.
--
-- WHY FAMILIES AND NOT TYPES. Muting is a blunt instrument by design: a member
-- who does not want event reminders does not want event_24h but not event_1h.
-- Per-type rows would be finer than anyone's actual preference and would couple
-- this table to type names, which are already load-bearing elsewhere (the
-- inbox derives its icon from type.split("_")[0]).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.notification_prefs (
  member_id  uuid    NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  family     text    NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, family),

  -- CHECK, not a lookup table, because the set is small and changes only when a
  -- notification family is designed. It stops a typo becoming a stored row that
  -- silently corresponds to nothing. Note this protects WRITES only — the
  -- send-path fail-open is handled inside is_muted() below, which is the more
  -- dangerous direction and needs its own guard.
  CONSTRAINT notification_prefs_family_check
    CHECK (family IN ('certs', 'gear', 'maint', 'events', 'tasks'))
);

COMMENT ON TABLE public.notification_prefs IS
  'Per-member notification opt-outs. NO ROW = OPTED IN. Only enabled=false mutes.';

ALTER TABLE public.notification_prefs ENABLE ROW LEVEL SECURITY;

-- A member owns their own preferences and nobody else's. No leader override and
-- no department-wide read: an officer has no business knowing who muted what,
-- and a chief who could see it would eventually want to change it.
DROP POLICY IF EXISTS notification_prefs_select_own ON public.notification_prefs;
CREATE POLICY notification_prefs_select_own ON public.notification_prefs
  FOR SELECT TO authenticated
  USING (member_id = public.my_member_id());

-- INSERT and UPDATE are separate policies because an upsert needs both, and
-- UPDATE needs USING as well as WITH CHECK — USING decides which rows you may
-- target, WITH CHECK decides what you may leave behind. Without USING, a member
-- could aim an UPDATE at another member's row; without WITH CHECK, they could
-- reassign their own row to someone else's member_id.
DROP POLICY IF EXISTS notification_prefs_insert_own ON public.notification_prefs;
CREATE POLICY notification_prefs_insert_own ON public.notification_prefs
  FOR INSERT TO authenticated
  WITH CHECK (member_id = public.my_member_id());

DROP POLICY IF EXISTS notification_prefs_update_own ON public.notification_prefs;
CREATE POLICY notification_prefs_update_own ON public.notification_prefs
  FOR UPDATE TO authenticated
  USING (member_id = public.my_member_id())
  WITH CHECK (member_id = public.my_member_id());

-- No DELETE policy, deliberately. Deleting a row means "opted in", which is
-- also what enabled = true means, so DELETE would be a second way to say the
-- same thing with different audit consequences (updated_at survives an update
-- and vanishes with a delete). One representation of a preference.

-- ---------------------------------------------------------------------
-- is_muted — the send-path check.
--
-- SECURITY DEFINER because the caller is the pulse endpoint running as
-- service_role over every department; it must get the same answer regardless of
-- whose session is in play.
--
-- IT RAISES ON AN UNKNOWN FAMILY, and that is the important line in this file.
-- A typo'd family would otherwise find no row and return false — "not muted" —
-- so a member's opt-out would be silently ignored and they would keep receiving
-- what they asked to stop receiving. That failure is invisible: nothing errors,
-- nothing logs, the member simply is not believed. Raising turns it into a
-- loud failure during slice 5's testing instead of a quiet one in production.
-- The CHECK constraint above cannot catch this, because the bad value never
-- reaches the table.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_muted(p_member uuid, p_family text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_family IS NULL OR p_family NOT IN ('certs','gear','maint','events','tasks') THEN
    RAISE EXCEPTION 'is_muted: unknown notification family %. A typo here would silently ignore a member''s opt-out.', coalesce(p_family, '<null>');
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.notification_prefs
     WHERE member_id = p_member
       AND family    = p_family
       AND enabled   = false
  );
END;
$function$;

-- Postgres default-grants EXECUTE to PUBLIC, so the REVOKE is mandatory.
-- service_role is the only intended caller: the pulse endpoint. authenticated is
-- NOT granted — a member reads their own prefs straight from the table under
-- RLS, so nothing in the app needs this, and granting it would hand any signed-in
-- member a way to probe whether an arbitrary member_id has muted a family.
REVOKE EXECUTE ON FUNCTION public.is_muted(uuid, text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_muted(uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only.
-- =====================================================================
--
-- -- 1. Table + constraint shape.
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'public.notification_prefs'::regclass ORDER BY conname;
--
-- -- 2. RLS on, and exactly the three policies (no DELETE).
-- SELECT relrowsecurity AS rls_enabled FROM pg_class
--  WHERE oid = 'public.notification_prefs'::regclass;
-- SELECT polname, polcmd, polroles::regrole[] AS roles,
--        pg_get_expr(polqual, polrelid)      AS using_qual,
--        pg_get_expr(polwithcheck, polrelid) AS with_check
--   FROM pg_policy WHERE polrelid = 'public.notification_prefs'::regclass ORDER BY polcmd;
--    -- roles must be {authenticated} on all three, NOT {-} (which is PUBLIC).
--
-- -- 3. Grants. Expect anon=f, authenticated=f, service_role=t.
-- SELECT has_function_privilege('anon',          'public.is_muted(uuid,text)'::regprocedure, 'EXECUTE') AS anon,
--        has_function_privilege('authenticated', 'public.is_muted(uuid,text)'::regprocedure, 'EXECUTE') AS auth,
--        has_function_privilege('service_role',  'public.is_muted(uuid,text)'::regprocedure, 'EXECUTE') AS svc;
--
-- -- 4. DEFAULT IS OPTED IN. With no rows at all, every member must read as
-- --    not-muted for every family. Expect all false.
-- SELECT f AS family, public.is_muted((SELECT id FROM public.members LIMIT 1), f) AS muted
--   FROM unnest(ARRAY['certs','gear','maint','events','tasks']) f;
--
-- -- 5. THE FAIL-LOUD GUARD. Both of these must RAISE, not return false.
-- --    An error here is the PASS.
-- --      SELECT public.is_muted((SELECT id FROM public.members LIMIT 1), 'evnts');   -- typo
-- --      SELECT public.is_muted((SELECT id FROM public.members LIMIT 1), NULL);
--
-- -- 6. Round-trip one opt-out, then put it back. Substitute a real member id.
-- --      INSERT INTO public.notification_prefs (member_id, family, enabled)
-- --      VALUES ('<member-id>', 'events', false)
-- --      ON CONFLICT (member_id, family) DO UPDATE SET enabled = excluded.enabled, updated_at = now();
-- --      SELECT public.is_muted('<member-id>', 'events');   -- expect TRUE
-- --      DELETE FROM public.notification_prefs WHERE member_id = '<member-id>' AND family = 'events';
-- --      SELECT public.is_muted('<member-id>', 'events');   -- expect FALSE again
