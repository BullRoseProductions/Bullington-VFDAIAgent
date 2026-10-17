-- =====================================================================
-- PHASE 3.1 #2 (Onboarding -> Cleared-to-Run + Probation) — Step 0. READ-ONLY, one result set.
-- RAN on live 2026-10-17. Findings: set_onboarding_item self-sign block LIVE (gate is_canmanage()). Transition state
-- intact: authenticated holds INSERT/UPDATE on onboarding_progress; DA-only policies (is_dept_admin + dept). Done rows
-- WITHOUT a checked_by stamp: IH 89 of 93, North Hood 27 of 28 (direct DA ticks). members UPDATE = is_dept_admin + dept
-- (only a DA can flip status); members INSERT/DELETE = is_leader() with no department term. No probation date: members
-- has created_at/joined(text)/status only; joined_date (member_private) covers IH 2 of 7 probationary, NH 2 of 2.
-- IH has 42 items incl. a "Probationary Period" category; Lipan 14, NH 15. apparatus exists; probation_milestones /
-- supervised_sessions names free. certs: name/exp/proof_path (no type column).
-- =====================================================================
SELECT 1 AS ord, 'col' AS what, table_name || '.' || column_name AS name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '') AS detail
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('onboarding_items', 'onboarding_progress')
UNION ALL
SELECT 2, 'members col', column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'members' AND (column_name ILIKE '%creat%' OR column_name ILIKE '%status%' OR column_name ILIKE '%join%' OR column_name ILIKE '%start%' OR column_name ILIKE '%prob%')
UNION ALL
SELECT 3, 'policy', tablename || ': ' || policyname || ' [' || cmd || '] ' || roles::text, coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('onboarding_items', 'onboarding_progress', 'members', 'member_private')
UNION ALL
SELECT 4, 'grant', t || ' -> authenticated', concat_ws(' ',
         CASE WHEN has_table_privilege('authenticated', 'public.' || t, 'SELECT') THEN 'SELECT' END,
         CASE WHEN has_table_privilege('authenticated', 'public.' || t, 'INSERT') THEN 'INSERT' END,
         CASE WHEN has_table_privilege('authenticated', 'public.' || t, 'UPDATE') THEN 'UPDATE' END,
         CASE WHEN has_table_privilege('authenticated', 'public.' || t, 'DELETE') THEN 'DELETE' END)
  FROM unnest(array['onboarding_items', 'onboarding_progress', 'members']) t
UNION ALL
SELECT 5, 'set_onboarding_item', pg_get_function_identity_arguments(p.oid),
       CASE WHEN position('sign off your own onboarding' in pg_get_functiondef(p.oid)) > 0 THEN 'SELF-SIGN BLOCK: live' ELSE 'SELF-SIGN BLOCK: NOT live' END
       || ' · gate ' || CASE WHEN position('is_canmanage()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_canmanage()' ELSE '?' END
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_onboarding_item'
UNION ALL
SELECT 6, 'members trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.members'::regclass AND NOT tgisinternal
UNION ALL
SELECT 7, 'status fn', p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND (p.proname ILIKE '%status%' OR p.proname ILIKE '%probation%' OR p.proname ILIKE '%activate%')
UNION ALL
SELECT 8, 'probationary members', d.name,
       count(*)::text || ' probationary · ' || count(mp.joined_date)::text || ' with a joined_date · oldest ' || coalesce(min(mp.joined_date)::text, '—') || ' · newest ' || coalesce(max(mp.joined_date)::text, '—')
  FROM public.members m JOIN public.departments d ON d.id = m.department_id LEFT JOIN public.member_private mp ON mp.member_id = m.id
 WHERE m.status = 'Probationary' GROUP BY d.name
UNION ALL
SELECT 9, 'onboarding items', d.name, count(i.id)::text || ' items · categories: ' || string_agg(DISTINCT i.category, ', ')
  FROM public.onboarding_items i JOIN public.departments d ON d.id = i.department_id GROUP BY d.name
UNION ALL
SELECT 10, 'progress rows', d.name, count(p.*)::text || ' rows · ' || count(p.*) FILTER (WHERE p.done)::text || ' done · ' || count(p.*) FILTER (WHERE p.done AND p.checked_by IS NULL)::text || ' done without a stamp'
  FROM public.onboarding_progress p JOIN public.departments d ON d.id = p.department_id GROUP BY d.name
UNION ALL
SELECT 11, 'table exists', t, (to_regclass('public.' || t) IS NOT NULL)::text
  FROM unnest(array['probation_milestones', 'supervised_sessions', 'apparatus', 'member_separation', 'document_series', 'certs', 'session_attendance', 'station_presence']) t
UNION ALL
SELECT 12, 'certs col', column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'certs'
UNION ALL
SELECT 13, 'celebrations view', 'definition', regexp_replace(pg_get_viewdef('public.celebrations'::regclass), '\s+', ' ', 'g')
ORDER BY 1, 3;
