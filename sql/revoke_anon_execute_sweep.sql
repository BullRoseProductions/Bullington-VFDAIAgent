-- =====================================================================
-- ANON-GRANT SWEEP: revoke the stray default EXECUTE-to-anon/PUBLIC from
-- every SECURITY DEFINER function that still carried it (33 functions).
--
-- WHY the pattern is "REVOKE FROM anon, public" + "GRANT TO authenticated":
--   These functions were granted EXECUTE to PUBLIC (the "=X/postgres" ACL
--   entry) AND explicitly to anon. Revoking FROM anon alone would NOT help
--   (anon still inherits via PUBLIC); revoking FROM public alone could strip
--   authenticated too. So we revoke BOTH, then GRANT authenticated back so
--   logged-in users (and the RLS engine, which runs helpers as authenticated)
--   keep working. service_role keeps its explicit grant (untouched).
--
-- Confirmed safe (read-only code audit): login uses only supabase.auth, the
-- QR sign-in runs authenticated (member_check_in is behind the session gate),
-- and nothing queries a public table as anon. Idempotent. Run VERIFY after.
-- =====================================================================

-- ---- RLS helper functions (executed by the RLS engine as `authenticated`) ----
REVOKE EXECUTE ON FUNCTION public.is_announcer()        FROM anon, public;  GRANT EXECUTE ON FUNCTION public.is_announcer()        TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_canmanage()        FROM anon, public;  GRANT EXECUTE ON FUNCTION public.is_canmanage()        TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_canmanage_ops()    FROM anon, public;  GRANT EXECUTE ON FUNCTION public.is_canmanage_ops()    TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_department_admin() FROM anon, public;  GRANT EXECUTE ON FUNCTION public.is_department_admin() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_dept_admin()       FROM anon, public;  GRANT EXECUTE ON FUNCTION public.is_dept_admin()       TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_leader()           FROM anon, public;  GRANT EXECUTE ON FUNCTION public.is_leader()           TO authenticated;
REVOKE EXECUTE ON FUNCTION public.is_project_admin()    FROM anon, public;  GRANT EXECUTE ON FUNCTION public.is_project_admin()    TO authenticated;
REVOKE EXECUTE ON FUNCTION public.my_department_id()    FROM anon, public;  GRANT EXECUTE ON FUNCTION public.my_department_id()    TO authenticated;
REVOKE EXECUTE ON FUNCTION public.my_member_id()        FROM anon, public;  GRANT EXECUTE ON FUNCTION public.my_member_id()        TO authenticated;

-- ---- Client RPCs (all called only from the authenticated app) ----
REVOKE EXECUTE ON FUNCTION public.approve_cert_submission(uuid)                       FROM anon, public;  GRANT EXECUTE ON FUNCTION public.approve_cert_submission(uuid)                       TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reject_cert_submission(uuid, text)                  FROM anon, public;  GRANT EXECUTE ON FUNCTION public.reject_cert_submission(uuid, text)                  TO authenticated;
REVOKE EXECUTE ON FUNCTION public.update_cert(uuid, text, text)                       FROM anon, public;  GRANT EXECUTE ON FUNCTION public.update_cert(uuid, text, text)                       TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_cert(uuid)                                   FROM anon, public;  GRANT EXECUTE ON FUNCTION public.delete_cert(uuid)                                   TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_duty(text, text, text, uuid, date)           FROM anon, public;  GRANT EXECUTE ON FUNCTION public.create_duty(text, text, text, uuid, date)           TO authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_duty(uuid, uuid[])                         FROM anon, public;  GRANT EXECUTE ON FUNCTION public.complete_duty(uuid, uuid[])                         TO authenticated;
REVOKE EXECUTE ON FUNCTION public.uncomplete_duty(uuid)                               FROM anon, public;  GRANT EXECUTE ON FUNCTION public.uncomplete_duty(uuid)                               TO authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_action_item(uuid)                          FROM anon, public;  GRANT EXECUTE ON FUNCTION public.complete_action_item(uuid)                          TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reopen_action_item(uuid)                            FROM anon, public;  GRANT EXECUTE ON FUNCTION public.reopen_action_item(uuid)                            TO authenticated;
REVOKE EXECUTE ON FUNCTION public.cancel_action_item(uuid, text)                      FROM anon, public;  GRANT EXECUTE ON FUNCTION public.cancel_action_item(uuid, text)                      TO authenticated;
REVOKE EXECUTE ON FUNCTION public.open_signin(uuid)                                   FROM anon, public;  GRANT EXECUTE ON FUNCTION public.open_signin(uuid)                                   TO authenticated;
REVOKE EXECUTE ON FUNCTION public.close_signin(uuid)                                  FROM anon, public;  GRANT EXECUTE ON FUNCTION public.close_signin(uuid)                                  TO authenticated;
REVOKE EXECUTE ON FUNCTION public.member_check_in(uuid, text)                         FROM anon, public;  GRANT EXECUTE ON FUNCTION public.member_check_in(uuid, text)                         TO authenticated;
REVOKE EXECUTE ON FUNCTION public.soft_delete_ai_output(uuid)                         FROM anon, public;  GRANT EXECUTE ON FUNCTION public.soft_delete_ai_output(uuid)                         TO authenticated;
REVOKE EXECUTE ON FUNCTION public.soft_delete_document(uuid)                          FROM anon, public;  GRANT EXECUTE ON FUNCTION public.soft_delete_document(uuid)                          TO authenticated;
REVOKE EXECUTE ON FUNCTION public.restore_document(uuid)                              FROM anon, public;  GRANT EXECUTE ON FUNCTION public.restore_document(uuid)                              TO authenticated;
REVOKE EXECUTE ON FUNCTION public.replace_document(uuid, uuid)                        FROM anon, public;  GRANT EXECUTE ON FUNCTION public.replace_document(uuid, uuid)                        TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_create_department(text, text, text, text, text) FROM anon, public;  GRANT EXECUTE ON FUNCTION public.pa_create_department(text, text, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_department_radar()                              FROM anon, public;  GRANT EXECUTE ON FUNCTION public.pa_department_radar()                              TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_members_missing_email(uuid)                      FROM anon, public;  GRANT EXECUTE ON FUNCTION public.pa_members_missing_email(uuid)                      TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_set_member_email(uuid, text)                     FROM anon, public;  GRANT EXECUTE ON FUNCTION public.pa_set_member_email(uuid, text)                     TO authenticated;

-- ---- Trigger functions: fire as triggers regardless of EXECUTE; revoke anon/public
--      for hygiene (a direct call errors anyway). No GRANT needed. ----
REVOKE EXECUTE ON FUNCTION public.guard_ai_outputs_deleted_at()  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.guard_documents_archived_at()  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.guard_documents_deleted_at()   FROM anon, public;

-- =====================================================================
-- VERIFY (run separately): every SECURITY DEFINER function in public should
-- now show anon_exec = false. authenticated stays true for the RPCs/helpers.
-- =====================================================================
-- select p.proname,
--        pg_get_function_identity_arguments(p.oid) as args,
--        has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
-- order by has_function_privilege('anon', p.oid, 'EXECUTE') desc, p.proname;
--   expect: anon_exec = false for ALL rows (0 true). auth_exec = true for the
--   RPCs and RLS helpers (guard_* triggers may show either -- they fire regardless).
