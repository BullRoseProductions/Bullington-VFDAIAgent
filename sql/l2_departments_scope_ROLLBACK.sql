-- =====================================================================
-- ROLLBACK for l2_departments_scope — insurance, GENERATED from the same capture. Puts the SELECT policy back to the exact
-- captured predicate (USING (true)). Refuses unless the policy is in the applied state; proves it is back to its pin.
-- =====================================================================
DO $rollback$
DECLARE v_t text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  SELECT p.qual INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = 'signed in can read departments';
  IF v_t IS DISTINCT FROM '(id = my_department_id())' THEN RAISE EXCEPTION 'ROLLBACK: "signed in can read departments" is not in the L-2 applied state (%). Refusing.', v_t; END IF;
  ALTER POLICY "signed in can read departments" ON public.departments USING (true);
  SELECT md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = 'signed in can read departments';
  IF v_t IS DISTINCT FROM 'cfd5b3a357ce1cac61482b5c6064cf26' THEN RAISE EXCEPTION 'ROLLBACK post-condition: the policy is not back to its captured md5. Rolling back.'; END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
