-- =====================================================================
-- Widen session_plans INSERT to include Board (so Board can attach an
-- agenda to their leadership event). Idempotent — recreates the policy to
-- allow is_canmanage() = Board Member / Department Admin / Officer.
--
-- NOTE: schema.sql already shows this policy allowing 'Board Member', so the
-- live DB may already permit Board. Running this GUARANTEES it and normalizes
-- to is_canmanage() (which uses the live 'Officer' role, not 'Training Officer').
-- =====================================================================

DROP POLICY IF EXISTS "canmanage insert session_plans" ON public.session_plans;
CREATE POLICY "canmanage insert session_plans" ON public.session_plans
  FOR INSERT TO authenticated
  WITH CHECK (department_id = my_department_id() AND is_canmanage());

-- =====================================================================
-- VERIFICATION (run separately)
-- =====================================================================
-- -- 1. The INSERT policy now uses is_canmanage() (Board/DA/Officer):
-- select policyname, cmd, with_check
-- from pg_policies
-- where tablename = 'session_plans' and cmd = 'INSERT';
--
-- -- 2. is_canmanage() includes Board Member (confirm the gate set):
-- select pg_get_functiondef('public.is_canmanage()'::regprocedure);
--   -- expect: members.access && array['Board Member','Department Admin','Officer']
