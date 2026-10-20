-- =====================================================================
-- ONBOARDING ITEM CONFIG — Step 0. READ-ONLY, one result set (SELECTs only; nothing is written).
-- RAN on live 2026-10-19. Findings:
--   onboarding_items: ack_series_id, category, cert_name, clears_to_run, created_at, department_id NOT NULL, hours_source,
--     hours_target, id, is_mentor, kind (= 'manual'), label, phase (= 'onboarding'), sort_order. NO proof/path/file/
--     upload/url column on either table. No requires_doc / approver_* names in use -> the new columns are additive.
--   onboarding_progress: checked_at, checked_by, created_at, department_id NOT NULL, done, id, item_id, member_id.
--     checked_by / checked_at ARE the approved-by / approved-at (set_onboarding_item stamps them) -> no approved_* columns.
--   set_onboarding_item(uuid,uuid,boolean): ONE overload, DEFINER, gate is_canmanage(), returns onboarding_progress,
--     members exec true / anon false, function md5 99e6c6944216fe3811c6bbc365958e75;
--     SELF-SIGN BLOCK md5 43179b88c2683b93d0d227044be7df9f =
--       if p_member_id = v_me then / raise exception 'You can''t sign off your own onboarding — a mentor or officer does.'; / end if;
--   Other onboarding fns: probation_item_states(uuid,uuid) only (DEFINER, read-only, members exec false, md5 0e91cf1d69f03a7b1dcb9234b7284357).
--   action_items: trg_action_item_assigned AFTER INSERT OR UPDATE OF assigned_to WHEN assigned_to IS NOT NULL ->
--     notify_action_item_assigned() (DEFINER, members exec false, md5 55b3058c7977d0e1ce643c77cb4ac5eb): skips unchanged
--     owner / no dept / not open / self (my_member_id()) / is_muted(.., 'tasks'); inserts notifications type
--     'task_assigned', subject_ref = item id, ON CONFLICT (member_id, type, subject_ref) DO NOTHING; never raises.
--   RLS ON all three. onboarding_progress: DA-only INSERT/UPDATE policies (is_dept_admin + dept) — direct DA writes are
--     live; authenticated holds SELECT INSERT UPDATE DELETE. anon holds broad TABLE grants on all three (RLS has no anon
--     policy, so nothing is exposed) — an RLS/grant-normalization item, not this slice.
--   Helpers all department-scoped. Tiers as stored (members.access): Board Member 15, Department Admin 18, Officer 21,
--     Member 110, Project Admin 2. members.role is a free-text title (Chief, FTO, ...) — not a tier.
--   No verifi* column on onboarding_items / onboarding_progress / action_items / members (the locked column is elsewhere).
--   Storage: ONE bucket, station-documents (private). Onboarding rows: IH 42 items / 93 progress, Lipan 14 / 0,
--     North Hood 15 / 28, Demo + Granbury 0 / 0. total_policies 169.
--   1 onboarding_items / onboarding_progress columns (type, null, default) + any proof / path / storage-ish column
--   2 set_onboarding_item: every overload, security, gate, md5 of the full definition, and the SELF-SIGN BLOCK text
--     (the draft must keep it byte-identical — this is the baseline it's compared against)
--   3 every other function that reads / writes onboarding_items or onboarding_progress (name, DEFINER?, md5)
--   4 action_items: columns + every trigger (timing / events / function) + the assignment+notify trigger fn's md5 + body
--   5 policies, RLS state and client grants on onboarding_items / onboarding_progress / action_items
--   6 helpers (is_dept_admin, is_canmanage, is_canmanage_ops, my_member_id, my_department_id) — body, dept-scoped?
--   7 role constants as they live in data: distinct members.role and members.access values (with counts)
--   8 any column named like 'verifi%' on these tables (must stay untouched), storage buckets, total policies
-- =====================================================================
SELECT 1 AS ord, 'col' AS what, table_name || '.' || column_name AS name,
       data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '') AS detail
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('onboarding_items', 'onboarding_progress')
UNION ALL
SELECT 1, 'proof-ish col (should be none on onboarding)', table_name || '.' || column_name, data_type
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('onboarding_items', 'onboarding_progress')
   AND (column_name ILIKE '%proof%' OR column_name ILIKE '%path%' OR column_name ILIKE '%file%' OR column_name ILIKE '%upload%' OR column_name ILIKE '%storage%' OR column_name ILIKE '%url%')
UNION ALL
SELECT 2, 'set_onboarding_item', p.oid::regprocedure::text,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · returns ' || pg_get_function_result(p.oid)
       || ' · gate: ' || concat_ws('+',
            CASE WHEN position('is_canmanage_ops()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_canmanage_ops' END,
            CASE WHEN position('is_canmanage()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_canmanage' END,
            CASE WHEN position('is_dept_admin()' in pg_get_functiondef(p.oid)) > 0 THEN 'is_dept_admin' END)
       || ' · md5 ' || md5(pg_get_functiondef(p.oid))
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
       || ' · anon exec: ' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_onboarding_item'
UNION ALL
SELECT 2, 'self-sign block (md5 ' || md5(coalesce(substring(pg_get_functiondef(p.oid) from '(?s)(if p_member_id = v_me then.*?end if;)'), '')) || ')',
       p.oid::regprocedure::text,
       coalesce(substring(pg_get_functiondef(p.oid) from '(?s)(if p_member_id = v_me then.*?end if;)'), 'NOT FOUND (!)')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_onboarding_item'
UNION ALL
SELECT 2, 'set_onboarding_item full definition', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'set_onboarding_item'
UNION ALL
SELECT 3, 'fn touching onboarding', p.oid::regprocedure::text,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · md5 ' || md5(pg_get_functiondef(p.oid))
       || ' · writes: ' || CASE WHEN pg_get_functiondef(p.oid) ~* '(insert into|update|delete from)\s+(public\.)?onboarding_(items|progress)' THEN 'yes' ELSE 'no' END
       || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname <> 'set_onboarding_item'
   AND (p.prosrc ILIKE '%onboarding_items%' OR p.prosrc ILIKE '%onboarding_progress%')
UNION ALL
SELECT 4, 'action_items col', column_name, data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END || coalesce(' = ' || column_default, '')
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'action_items'
UNION ALL
SELECT 4, 'trigger', c.relname || '.' || t.tgname,
       pg_get_triggerdef(t.oid) || ' · enabled ' || t.tgenabled::text || ' · fn md5 ' || md5(pg_get_functiondef(t.tgfoid))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
 WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname IN ('action_items', 'onboarding_items', 'onboarding_progress')
UNION ALL
SELECT 4, 'action_items trigger fn body', p.oid::regprocedure::text,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || ' · members exec: ' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || E'\n' || pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.oid IN (SELECT t.tgfoid FROM pg_trigger t WHERE t.tgrelid = 'public.action_items'::regclass AND NOT t.tgisinternal)
UNION ALL
SELECT 5, 'policy', tablename || ': ' || policyname || ' [' || cmd || '] ' || roles::text, coalesce(qual, '') || coalesce(' | CHECK ' || with_check, '')
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('onboarding_items', 'onboarding_progress', 'action_items')
UNION ALL
SELECT 5, 'rls', c.relname, 'rls ' || c.relrowsecurity::text || ' · forced ' || c.relforcerowsecurity::text
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('onboarding_items', 'onboarding_progress', 'action_items')
UNION ALL
SELECT 5, 'grant', t || ' -> ' || r, concat_ws(' ',
         CASE WHEN has_table_privilege(r, 'public.' || t, 'SELECT') THEN 'SELECT' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'INSERT') THEN 'INSERT' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'UPDATE') THEN 'UPDATE' END,
         CASE WHEN has_table_privilege(r, 'public.' || t, 'DELETE') THEN 'DELETE' END)
  FROM unnest(array['onboarding_items', 'onboarding_progress', 'action_items']) t CROSS JOIN unnest(array['authenticated', 'anon']) r
UNION ALL
SELECT 6, 'helper', p.proname || '() -> ' || format_type(p.prorettype, NULL),
       CASE WHEN position('my_department_id()' in pg_get_functiondef(p.oid)) > 0 OR p.proname IN ('my_department_id', 'my_member_id')
            THEN 'department-scoped' ELSE 'NOT department-scoped (!)' END
       || ' · ' || regexp_replace(substring(pg_get_functiondef(p.oid) from 'AS \$[a-z]*\$(.*)\$[a-z]*\$'), '\s+', ' ', 'g')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_dept_admin', 'is_canmanage', 'is_canmanage_ops', 'my_member_id', 'my_department_id')
UNION ALL
SELECT 7, 'members.role', coalesce(role, '(null)'), count(*)::text FROM public.members GROUP BY role
UNION ALL
SELECT 7, 'members.access', a, count(*)::text FROM public.members, unnest(coalesce(access, array[]::text[])) a GROUP BY a
UNION ALL
SELECT 8, 'verifi* col (locked)', table_name || '.' || column_name, data_type
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('onboarding_items', 'onboarding_progress', 'action_items', 'members')
   AND column_name ILIKE 'verifi%'
UNION ALL
SELECT 8, 'storage bucket', b.id, 'public ' || b.public::text FROM storage.buckets b
UNION ALL
SELECT 8, 'onboarding rows', d.name, (SELECT count(*) FROM public.onboarding_items i WHERE i.department_id = d.id)::text || ' items · '
       || (SELECT count(*) FROM public.onboarding_progress g JOIN public.onboarding_items i ON i.id = g.item_id WHERE i.department_id = d.id)::text || ' progress rows'
  FROM public.departments d
UNION ALL
SELECT 8, 'policies', 'total', count(*)::text FROM pg_policies WHERE schemaname = 'public'
ORDER BY 1, 2, 3;
