-- E1/E3 T2 — LIVE CAPTURE (A): the functions the generator pins or mocks. READ-ONLY. One row per function.
-- Output (Copy as JSON) → docs/review/e1e3_T2_LIVE_fns.json
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig, md5(pg_get_functiondef(p.oid)) AS md5,
       coalesce(p.proacl::text, '') AS acl, p.prosecdef AS secdef, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND (p.proname IN ('finalize_training_session', 'correct_training_session', 'tg_training_session_lock_guard', 'attested_training',
                      'dept_iso_hours_for', 'reopen_training_session', 'my_department_id', 'my_member_id', 'is_leader',
                      'is_training_manager', 'is_training_officer', 'is_dept_admin', 'recompute_training_plan_last_iso',
                      'set_session_reaction', 'session_reaction_tally')
        OR p.oid IN (SELECT t.tgfoid FROM pg_trigger t WHERE t.tgrelid = 'public.session_attendance'::regclass AND NOT t.tgisinternal))
 ORDER BY 1;
