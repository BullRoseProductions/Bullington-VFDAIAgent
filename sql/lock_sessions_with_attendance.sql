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
-- WHY A FUNCTION AND NOT AN INLINE EXISTS -- THIS IS THE IMPORTANT PART.
-- A policy USING expression is evaluated as the CALLING user, so an inline
--     NOT EXISTS (SELECT 1 FROM session_attendance sa WHERE sa.session_id = id)
-- is itself filtered by session_attendance's own SELECT policy. If that policy
-- ever narrows — or a role simply cannot read those rows — the subquery finds
-- nothing, NOT EXISTS returns TRUE, and the delete is ALLOWED. The guard would
-- fail OPEN, silently, in exactly the direction that destroys data, and nothing
-- about the policy text would look wrong.
--
-- session_has_attendance is SECURITY DEFINER, so it sees the rows regardless of
-- who is asking and the answer cannot be changed by RLS drift elsewhere. This is
-- a guard about data existing, not about who may look at it.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The helper.
--
-- SCOPED TO THE CALLER'S DEPARTMENT on purpose. Definer rights mean it could
-- answer for any session in any department, and "does this uuid have attendance"
-- is a small leak but a needless one. Scoping costs nothing: the policy's other
-- clause already requires department_id = my_department_id(), so a foreign
-- session is refused on that clause whatever this returns.
--
-- EXECUTE stays with authenticated, unlike attested_training. It has to: the
-- policy is evaluated as the calling user, so revoking it would make every
-- delete raise permission-denied instead of applying the rule.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.session_has_attendance(p_session uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.session_attendance sa
      JOIN public.training_sessions ts ON ts.id = sa.session_id
     WHERE sa.session_id = p_session
       AND ts.department_id = public.my_department_id()
  );
$function$;

REVOKE ALL ON FUNCTION public.session_has_attendance(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.session_has_attendance(uuid) TO authenticated;

-- ---------------------------------------------------------------------
-- 2. Guarded ALTER. Same reasoning as the previous migration: ALTER POLICY
-- replaces the WHOLE expression, so refuse unless what is live is exactly what
-- this was written against.
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

  IF v_qual ILIKE '%session_has_attendance%' THEN
    RAISE EXCEPTION 'The policy already calls session_has_attendance — this migration has run. Live USING is: %. Nothing was changed.', v_qual;
  END IF;

  -- The previous migration must be in place, or the expression is not what this
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
      || 'AND NOT public.session_has_attendance(id))',
    v_name);

  SELECT pg_get_expr(polqual, polrelid) INTO v_qual
    FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
  RAISE NOTICE 'Policy after:  %', v_qual;
END
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. The expression now carries BOTH guards.
-- SELECT polname, pg_get_expr(polqual, polrelid) AS using_qual, count(*) OVER () AS delete_policies
--   FROM pg_policy WHERE polrelid = 'public.training_sessions'::regclass AND polcmd = 'd';
--
-- -- 2. THE ONE ROW THAT MOTIVATED THIS. Expect it to appear here and to be
-- --    undeletable from the app afterwards.
-- SELECT ts.id, ts.date, ts.title, ts.done, count(sa.member_id) AS attendees
--   FROM public.training_sessions ts
--   JOIN public.session_attendance sa ON sa.session_id = ts.id
--  WHERE ts.done IS NOT TRUE
--  GROUP BY ts.id, ts.date, ts.title, ts.done;
--
-- -- 3. What remains deletable: not closed AND no attendance. This is the set a
-- --    leader can still clean up.
-- SELECT count(*) AS still_deletable
--   FROM public.training_sessions ts
--  WHERE ts.done IS NOT TRUE
--    AND NOT EXISTS (SELECT 1 FROM public.session_attendance sa WHERE sa.session_id = ts.id);
--
-- -- 4. The helper is scoped and reachable. As postgres my_department_id() is NULL,
-- --    so this returns FALSE for everything — that is the scoping working, not a
-- --    failure. The real test is from the app.
-- SELECT has_function_privilege('authenticated','public.session_has_attendance(uuid)'::regprocedure,'EXECUTE') AS auth,
--        has_function_privilege('anon','public.session_has_attendance(uuid)'::regprocedure,'EXECUTE')          AS anon;
--
-- -- 5. FUNCTIONAL TEST — FROM THE APP, as an ops-manager leader. The SQL editor
-- --    runs as postgres and bypasses RLS entirely.
-- --      • empty, not-closed session        -> Remove shows, delete succeeds
-- --      • not-closed WITH attendance       -> Remove hidden, delete refused
-- --      • closed session                   -> Remove hidden, Reopen offered
