-- =====================================================================
-- EXTEND THE DELETE LOCK: closed sessions OR any session with attendance.
--
-- Follows lock_closed_training_sessions.sql, which locked done = true. The
-- catalog then showed 12 closed sessions (11 with attendance) locked, and one
-- NOT-closed session that already had attendance still fully deletable. "Not yet
-- closed" was standing in for "empty scratch entry", and that row is where the
-- two come apart: somebody had checked in, nobody had finalized.
--
-- It also removes an inconsistency already visible in the UI — `locked` guards
-- the Edit button on attendance?.length > 0, so that session could not be edited
-- but could be deleted outright, roster and all.
--
-- NEW RULE, matching the Edit guard: deletable only while not closed AND nobody
-- has checked in.
--
-- ONE THING TO KNOW ABOUT THE INLINE EXISTS (owner's chosen form).
-- A policy USING expression is evaluated as the CALLING user, so this subquery
-- reads session_attendance through that table's own SELECT policy. Today that is
-- permissive for authenticated, so a leader sees their department's rows and the
-- guard works. But the dependency is real and worth writing down: if
-- session_attendance's SELECT policy were ever narrowed so a deleting role could
-- not see those rows, the subquery would find nothing, NOT EXISTS would return
-- TRUE, and the delete would be ALLOWED. This guard fails OPEN, not closed.
--
-- Verify query 4 below reads that policy so the assumption is checkable rather
-- than remembered. Re-run it if session_attendance's RLS is ever touched — the
-- text of THIS policy will still look correct on the day it stops working.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Guarded ALTER. ALTER POLICY replaces the WHOLE expression, so refuse unless
-- what is live is exactly what this was written against.
-- ---------------------------------------------------------------------
DO $do$
DECLARE v_name text; v_qual text; v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one DELETE policy on training_sessions, found %. Permissive policies OR together, so guarding one would block nothing. Nothing was changed.', v_n;
  END IF;

  SELECT polname, pg_get_expr(polqual, polrelid) INTO v_name, v_qual
    FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
  RAISE NOTICE 'Policy before: %', v_qual;

  IF v_qual ILIKE '%session_attendance%' THEN
    RAISE EXCEPTION 'The policy already references session_attendance — this migration has run. Live USING is: %. Nothing was changed.', v_qual;
  END IF;

  -- The previous migration must be in place, or this is not the expression this
  -- one extends and the result would not be the rule anybody agreed to.
  IF v_qual NOT ILIKE '%done%' THEN
    RAISE EXCEPTION 'The DELETE policy has no done guard — apply lock_closed_training_sessions.sql first. Live USING is: %. Nothing was changed.', v_qual;
  END IF;
  IF v_qual NOT ILIKE '%my_department_id%' OR v_qual NOT ILIKE '%is_canmanage_ops%' THEN
    RAISE EXCEPTION 'The DELETE policy has drifted. Live USING is: %. Nothing was changed.', v_qual;
  END IF;

  EXECUTE format(
    'ALTER POLICY %I ON public.training_sessions USING ('
      || 'department_id = public.my_department_id() '
      || 'AND public.is_canmanage_ops() '
      || 'AND done IS NOT TRUE '
      || 'AND NOT EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = training_sessions.id))',
    v_name);

  SELECT pg_get_expr(polqual, polrelid) INTO v_qual
    FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
  RAISE NOTICE 'Policy after:  %', v_qual;
END
$do$;

COMMIT;


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. The expression now carries BOTH guards, and there is still exactly one
-- --    DELETE policy.
-- SELECT polname, pg_get_expr(polqual, polrelid) AS using_qual, count(*) OVER () AS delete_policies
--   FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
--
-- -- 2. THE ONE ROW THAT MOTIVATED THIS. Expect it here, and undeletable from the
-- --    app afterwards.
-- SELECT ts.id, ts.date, ts.title, ts.done, count(sa.member_id) AS attendees
--   FROM public.training_sessions ts
--   JOIN public.session_attendance sa ON sa.session_id = ts.id
--  WHERE ts.done IS NOT TRUE
--  GROUP BY ts.id, ts.date, ts.title, ts.done;
--
-- -- 3. What remains deletable: not closed AND no attendance.
-- SELECT count(*) AS still_deletable
--   FROM public.training_sessions ts
--  WHERE ts.done IS NOT TRUE
--    AND NOT EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id);
--
-- -- 4. THE ASSUMPTION THIS GUARD RESTS ON. The subquery above runs as the calling
-- --    user, so a leader must be able to SELECT the attendance rows or the guard
-- --    silently stops blocking. Expect a permissive SELECT policy covering
-- --    authenticated. RE-RUN THIS IF session_attendance's RLS IS EVER CHANGED —
-- --    the delete policy will still read correctly on the day it stops working.
-- SELECT polname,
--        CASE polcmd WHEN 'r' THEN 'SELECT' WHEN '*' THEN 'ALL' ELSE polcmd::text END AS cmd,
--        polpermissive                                   AS permissive,
--        coalesce(array_to_string(ARRAY(
--          SELECT rolname FROM pg_roles WHERE oid = ANY(polroles)), ','), 'PUBLIC') AS roles,
--        pg_get_expr(polqual, polrelid)                  AS using_qual
--   FROM pg_policy
--  WHERE polrelid = 'public.session_attendance'::regclass
--    AND polcmd IN ('r','*')
--  ORDER BY polname;
--
-- -- 5. FUNCTIONAL TEST — FROM THE APP, as an ops-manager leader. The SQL editor
-- --    runs as postgres and bypasses RLS entirely.
-- --      • empty, not-closed session   -> Remove shows, delete succeeds
-- --      • not-closed WITH attendance  -> Remove hidden, delete refused
-- --      • closed session              -> Remove hidden, Reopen offered
