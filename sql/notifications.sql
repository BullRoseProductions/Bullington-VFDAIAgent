-- =====================================================================
-- notifications — STORED, not computed.
--
-- The digest already derives what needs attention on every run. Storing the
-- result buys two things a derived list cannot: per-member read/unread state,
-- and a durable "we told them, on this date" record — which is the whole point
-- when the underlying item is a lapsed certification.
--
-- DE-DUPE: one row per (member_id, type, subject_ref). The daily cycle re-runs
-- detection from scratch, so without this every run would restack the same
-- expiring cert. The digest inserts with ON CONFLICT DO NOTHING.
--
-- Consequence worth knowing: once a member has been notified about a subject,
-- they are never notified about it again — including after they read and
-- dismiss it, and including if it gets worse (expiring → expired). `type`
-- carries the severity tier, so an item crossing into a worse tier produces a
-- DIFFERENT type and therefore a new notification. Items that merely persist
-- do not re-nag.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id  uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  type           text NOT NULL,          -- 'cert_expiring' | 'cert_expired' | 'gear_retiring' | 'gear_retire' | 'maint_due' | 'maint_overdue'
  title          text NOT NULL,
  body           text,
  subject_ref    text,                   -- stable identity of the thing being flagged (cert id, equipment id, task id)
  severity       text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz
);

-- The de-dupe key. NULLS NOT DISTINCT so two rows with a null subject_ref and the
-- same type still collide rather than both landing (default Postgres treats nulls
-- as distinct, which would silently defeat the whole mechanism).
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
  ON public.notifications (member_id, type, subject_ref) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS notifications_member_unread_idx
  ON public.notifications (member_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_dept_idx
  ON public.notifications (department_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- READ SCOPE, per the locked access model: a member reads their own; a leader
-- (officer/DA) also reads department-wide. is_leader() is the same helper the
-- rest of the app's leader-scoped policies use, so this can't drift from them.
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications
  FOR SELECT TO authenticated
  USING (
    member_id = public.my_member_id()
    OR (public.is_leader() AND department_id = public.my_department_id())
  );

-- No INSERT/UPDATE/DELETE policies: writes are the digest's job (service role,
-- which bypasses RLS). Marking read goes through the RPC below so a client can
-- only ever touch read_at, never rewrite a notification's text after the fact —
-- that text is the audit trail.

CREATE OR REPLACE FUNCTION public.mark_notification_read(p_id uuid)
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
  -- Own rows only. A leader can SEE department-wide notifications but must not be
  -- able to mark another member's item read on their behalf.
  UPDATE public.notifications
     SET read_at = COALESCE(read_at, now())
   WHERE id = p_id AND member_id = v_member;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member uuid := public.my_member_id();
  v_count  integer;
BEGIN
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'no member for the current user';
  END IF;
  UPDATE public.notifications
     SET read_at = now()
   WHERE member_id = v_member AND read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_notification_read(uuid)    FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.mark_notification_read(uuid)    TO authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_all_notifications_read()   FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.mark_all_notifications_read()   TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ---- VERIFY ----
-- SELECT polname, polcmd, pg_get_expr(polqual, polrelid) FROM pg_policy
-- WHERE polrelid = 'public.notifications'::regclass;
-- SELECT proname, proacl FROM pg_proc
-- WHERE proname IN ('mark_notification_read','mark_all_notifications_read');
