-- =====================================================================
-- LOCK CLOSED TRAINING SESSIONS FROM DELETION.
--
-- A closed (done = true) session must not be deletable. Reopen and edit are
-- untouched. Not-yet-closed sessions stay deletable so a mistyped calendar entry
-- can still be cleaned up.
--
-- WHY THIS IS THE RIGHT LAYER. The app deletes with
--   supabase.from('training_sessions').delete().eq('id', id)      [App.jsx:11880]
-- — a direct table delete, so RLS governs it. Confirmed there is NO SECURITY
-- DEFINER delete RPC for training_sessions, which would have bypassed the policy
-- and needed the same guard inside the function. The policy is the whole story.
--
-- WHAT THIS ACTUALLY CLOSES. session_attendance's delete policy already refuses
-- when ts.done, so individual roster rows were safe. The open path was deleting
-- the SESSION, which cascades the roster with it — the attendance guard never
-- got a chance to fire. Same protection, one level up.
--
-- IS NOT TRUE, NOT "= false". A legacy row with done = NULL is not closed, and
-- `done = false` would evaluate NULL and refuse the delete, quietly making old
-- junk rows permanent. IS NOT TRUE treats NULL as deletable, which is correct.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Guarded ALTER. ALTER POLICY ... USING REPLACES the whole expression, so if the
-- live policy has gained a condition since it was last read, blindly setting a
-- new one would silently drop that condition and widen access. This refuses
-- unless the live expression is what we think it is, and finds the policy by
-- command rather than by hardcoded name so a rename does not defeat it.
-- ---------------------------------------------------------------------
DO $do$
DECLARE
  v_name text;
  v_qual text;
  v_n    int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';

  IF v_n = 0 THEN
    RAISE EXCEPTION 'No DELETE policy on training_sessions. Nothing was changed — investigate before adding one.';
  END IF;

  -- More than one PERMISSIVE delete policy would OR together, so hardening one
  -- leaves the other wide open. Refuse rather than produce a guard that does nothing.
  IF v_n > 1 THEN
    RAISE EXCEPTION 'training_sessions has % DELETE policies. Permissive policies OR together, so guarding one would not block anything. Nothing was changed.', v_n;
  END IF;

  SELECT polname, pg_get_expr(polqual, polrelid) INTO v_name, v_qual
    FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';

  RAISE NOTICE 'Policy before: % USING %', v_name, v_qual;

  IF v_qual ILIKE '%done%' THEN
    RAISE EXCEPTION 'The DELETE policy already mentions done — it may already be guarded. Live USING is: %. Nothing was changed.', v_qual;
  END IF;

  -- Both original conditions must still be present, or this is not the policy
  -- this migration was written against.
  IF v_qual NOT ILIKE '%my_department_id%' OR v_qual NOT ILIKE '%is_canmanage_ops%' THEN
    RAISE EXCEPTION 'The DELETE policy has drifted from what this migration expects. Live USING is: %. Nothing was changed.', v_qual;
  END IF;

  EXECUTE format(
    'ALTER POLICY %I ON public.training_sessions USING (department_id = public.my_department_id() AND public.is_canmanage_ops() AND done IS NOT TRUE)',
    v_name);

  SELECT pg_get_expr(polqual, polrelid) INTO v_qual
    FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
  RAISE NOTICE 'Policy after:  % USING %', v_name, v_qual;
END
$do$;

COMMIT;


-- =====================================================================
-- VERIFY (run after) — both of these work in the SQL editor.
-- =====================================================================
--
-- -- 1. The guard is in the expression. Expect to see `AND (done IS NOT TRUE)`.
-- SELECT polname, pg_get_expr(polqual, polrelid) AS using_qual
--   FROM pg_policy
--  WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
--
-- -- 2. How many sessions this now protects, and how many stay deletable.
-- --    done IS NULL counts as deletable, deliberately.
-- SELECT coalesce(done::text, 'null') AS done, count(*)
--   FROM public.training_sessions GROUP BY 1 ORDER BY 1;
--
-- -- 3. FUNCTIONAL TEST — must be run FROM THE APP as an ops-manager leader, not
-- --    here: the SQL editor runs as postgres, which owns the table and BYPASSES
-- --    RLS entirely. A delete that succeeds in this editor proves nothing.
-- --      • delete a NOT-done session  -> succeeds
-- --      • delete a DONE session      -> blocked
-- --      • reopen, then delete        -> succeeds (the chosen rule)
