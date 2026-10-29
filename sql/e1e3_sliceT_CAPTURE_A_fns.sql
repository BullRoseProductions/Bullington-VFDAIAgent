-- E1/E3 Slice T — LIVE CAPTURE (A): the functions the generator rewrites, pins or mocks. READ-ONLY. One row per function.
-- Output (Copy as JSON) → docs/review/e1e3_sliceT_LIVE_fns.json
SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig, md5(pg_get_functiondef(p.oid)) AS md5,
       coalesce(p.proacl::text, '') AS acl, p.prosecdef AS secdef, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('finalize_training_session', 'correct_training_session', 'tg_training_session_lock_guard', 'attested_training',
                     'dept_iso_hours_for', 'open_signin', 'drill_window_presence', 'reopen_training_session', 'my_department_id',
                     'my_member_id', 'is_training_manager', 'recompute_training_plan_last_iso', 'is_dept_admin', 'is_training_officer')
 ORDER BY 1;
