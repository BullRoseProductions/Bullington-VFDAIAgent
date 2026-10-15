-- READ-ONLY. Part B (assign minutes to a meeting) is HELD on visibility. This shows the LIVE read rules
-- for the two tables involved, since schema.sql is a stale snapshot. Nothing here writes.
--
-- What the snapshot says (to confirm or correct):
--   ai_outputs   SELECT "dept reads ai_outputs"     USING (department_id = my_department_id())  -- every dept member
--   session_plans SELECT "members read session_plans" USING (department_id = my_department_id()) -- every dept member
-- If both read dept-wide, then minutes being "leaders-only" today is enforced by the app's navigation
-- (the Meetings page is LEADERSHIP-only), not by the database.

-- 1. Live SELECT policies on both tables
SELECT tablename, policyname, cmd, roles, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('ai_outputs', 'session_plans') AND cmd IN ('SELECT', 'ALL')
ORDER BY tablename, policyname;

-- 2. The session_plans.source CHECK (agenda vs minutes question)
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.session_plans'::regclass AND contype = 'c';

-- 3. What is attached to leadership/board meetings today, by source (counts only)
SELECT ts.audience, sp.source, count(*) AS attached
FROM public.session_plans sp
JOIN public.training_sessions ts ON ts.id = sp.session_id
GROUP BY ts.audience, sp.source
ORDER BY ts.audience, sp.source;
