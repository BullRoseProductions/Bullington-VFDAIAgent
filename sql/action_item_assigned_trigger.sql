-- =====================================================================
-- INSTANT PING WHEN AN ACTION ITEM IS ASSIGNED.
--
-- NOT YET APPLIED. Writes a notifications row the moment an item is assigned; the row sits at
-- pushed_at NULL until the hourly drain (which arrives with the cron) picks it up. Nothing here
-- sends anything, and nothing changes for a member until pulse is scheduled.
--
-- WHY A TRIGGER AND NOT AN APP CALL. action_items is inserted from two places in App.jsx (5333 and
-- 11020) and updated from more. An app-side ping means remembering every one of them, forever. The
-- trigger is one definition that cannot be bypassed — including by a bulk import or a hand-run
-- UPDATE in the SQL editor, which is precisely when a quiet assignment is most likely to be missed.
--
-- SECURITY DEFINER IS LOAD-BEARING, NOT DECORATION. Read this before changing it:
--
--   * public.notifications has RLS enabled and ONLY a SELECT policy. There is no INSERT policy at
--     all, so `authenticated` cannot write to it under any circumstances.
--   * public.is_muted has EXECUTE revoked from public, anon AND authenticated; only service_role
--     holds it.
--
-- So a SECURITY INVOKER trigger — running as the member who created the item — would fail twice:
-- permission denied on is_muted, then RLS refusal on the insert. Because a trigger error aborts the
-- statement that fired it, the visible symptom would be MEMBERS UNABLE TO CREATE ACTION ITEMS AT
-- ALL. The notification feature would take the task list down with it.
--
-- As SECURITY DEFINER owned by the same role that owns is_muted and notifications (postgres, as
-- verified for attested_training), the function executes is_muted as its owner and bypasses RLS as
-- the table owner. Both problems disappear for the same reason.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_action_item_assigned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_text text;
  v_body text;
BEGIN
  -- ONLY A REAL CHANGE OF OWNER. `UPDATE OF assigned_to` fires whenever the column is named in the
  -- statement, even if the value is identical — a bulk "UPDATE action_items SET assigned_to =
  -- assigned_to" would otherwise ping the whole roster. IS DISTINCT FROM also handles NULLs, which
  -- a plain <> would not.
  IF TG_OP = 'UPDATE' AND NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to THEN
    RETURN NULL;
  END IF;

  -- notifications.department_id is NOT NULL; without this the insert would abort the caller's
  -- statement rather than quietly skipping one notification.
  IF NEW.department_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- DECISION (easily removed): don't ping about an item that is already finished. Assigning a
  -- completed or cancelled item is bookkeeping, and a notification about it is noise.
  IF coalesce(NEW.status, 'open') <> 'open' THEN
    RETURN NULL;
  END IF;

  -- DECISION (easily removed): don't ping someone for assigning a task to themselves — they were
  -- looking at the screen when they did it. my_member_id() reads the JWT, which is unaffected by
  -- SECURITY DEFINER, and returns NULL for a service-role or migration write, so bulk assignment
  -- still notifies normally.
  IF NEW.assigned_to = public.my_member_id() THEN
    RETURN NULL;
  END IF;

  -- Same mute rule pulse applies at write time: a muted family produces NO ROW, so an opted-out
  -- member does not find assignment items waiting in their inbox either. 'tasks' is a literal, so
  -- is_muted's raise-on-unknown-family guard cannot be tripped from here.
  IF public.is_muted(NEW.assigned_to, 'tasks') THEN
    RETURN NULL;
  END IF;

  v_text := coalesce(nullif(btrim(NEW.text), ''), 'A task has been assigned to you.');
  IF length(v_text) > 120 THEN
    v_text := left(v_text, 117) || U&'\2026';          -- ellipsis; a body cut mid-word reads as broken
  END IF;
  v_body := v_text || CASE WHEN NEW.due_date IS NOT NULL
                           THEN ' · due ' || to_char(NEW.due_date, 'Mon DD') ELSE '' END;

  INSERT INTO public.notifications
    (department_id, member_id, type, title, body, subject_ref, severity)
  VALUES
    (NEW.department_id, NEW.assigned_to, 'task_assigned', 'New task assigned',
     v_body, NEW.id::text, 'info')
  -- ONCE PER MEMBER PER ITEM. Consequence worth knowing: if an item goes A -> B -> A, the second
  -- assignment to A is silent, because A was already told about this item. That is the intended
  -- reading of "pinged once per item" and it is what stops a contested item pinging repeatedly.
  ON CONFLICT (member_id, type, subject_ref) DO NOTHING;

  RETURN NULL;                                          -- AFTER trigger: return value is ignored

EXCEPTION WHEN OTHERS THEN
  -- A NOTIFICATION FAILURE MUST NEVER BLOCK THE WORK. Without this, any error here — a deleted
  -- member breaking the FK, a future CHECK on notifications, is_muted being dropped — would abort
  -- the INSERT or UPDATE that fired the trigger, and a member would simply be unable to assign a
  -- task. The warning goes to the Postgres log so a silent failure is still a recorded one.
  RAISE WARNING 'notify_action_item_assigned failed for item %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;

-- Cosmetic but consistent with the project's convention: a direct call raises "trigger functions can
-- only be called as triggers" anyway, and Postgres does not check EXECUTE when firing a trigger.
REVOKE EXECUTE ON FUNCTION public.notify_action_item_assigned() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_action_item_assigned ON public.action_items;
CREATE TRIGGER trg_action_item_assigned
  AFTER INSERT OR UPDATE OF assigned_to ON public.action_items
  FOR EACH ROW
  -- OLD cannot be referenced in a WHEN clause on a trigger that also fires for INSERT, so the
  -- "did it actually change" test lives in the function body above.
  WHEN (NEW.assigned_to IS NOT NULL)
  EXECUTE FUNCTION public.notify_action_item_assigned();

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. PRECONDITION FOR THE WHOLE DESIGN. All three must share an owner, or the DEFINER function
-- --    cannot call is_muted and cannot bypass RLS on notifications.
-- SELECT c.relname AS obj, pg_get_userbyid(c.relowner) AS owner
--   FROM pg_class c WHERE c.oid IN ('public.notifications'::regclass, 'public.action_items'::regclass)
-- UNION ALL
-- SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p
--  WHERE p.pronamespace='public'::regnamespace
--    AND p.proname IN ('is_muted','notify_action_item_assigned');
--
-- -- 2. RLS must be ENABLED but NOT FORCED on notifications. With FORCE, even the owner is subject
-- --    to policies, there is no INSERT policy, and every assignment would silently warn and drop.
-- SELECT relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_FORCED
--   FROM pg_class WHERE oid = 'public.notifications'::regclass;
--    -- expect: t, f
--
-- -- 3. The trigger exists, on the right events, with the WHEN clause.
-- SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--  WHERE tgrelid = 'public.action_items'::regclass AND NOT tgisinternal;
--
-- -- 4. FUNCTIONAL TEST — run as a real member FROM THE APP, not here: the SQL editor runs as
-- --    postgres, so my_member_id() is NULL and the self-assignment skip cannot be exercised.
-- --      * assign an open item to ANOTHER member  -> one notifications row, type task_assigned
-- --      * assign the same item to them again     -> still one row (ON CONFLICT DO NOTHING)
-- --      * reassign to a third member             -> a row for the third member
-- --      * assign an item to YOURSELF              -> no row
-- --      * mute 'tasks' for a member, then assign  -> no row for them
-- --    Check with:
-- --      SELECT member_id, type, title, body, subject_ref, pushed_at, created_at
-- --        FROM public.notifications WHERE type = 'task_assigned' ORDER BY created_at DESC;
-- --    pushed_at MUST be NULL — nothing pushes until the drain runs.
