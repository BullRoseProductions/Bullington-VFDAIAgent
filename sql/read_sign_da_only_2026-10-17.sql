-- =====================================================================
-- READ & SIGN — required reading is set by a DEPARTMENT ADMIN only (not Officers).
-- APPLIED by hand 2026-10-17 (no review PASS recorded before apply — send for the record). State check: both functions
-- da_only true · uses_canmanage_ops false · dept_check true · anon false · total_policies 160 (unchanged).
-- RETEST on live: 54 passed, 0 failed, 2 skipped — O1 (Officer refused config + publish) PASS in IH, Lipan, North Hood.
-- Test: sql/read_sign_RETEST.sql (updated: O1 proves an Officer is refused config + publish; the DA path still works).
--
-- WHAT CHANGES — two CREATE OR REPLACE, nothing else:
--   set_document_ack_config, publish_document_version: the role check is_canmanage_ops() (DA + Officer) becomes
--   is_dept_admin(); the document's own department_id = my_department_id() check is kept exactly. Refusal text becomes
--   "Only a Department Admin of this department can …".
--   NOTE: live is_dept_admin() = members.access && {Project Admin, Department Admin}, department-scoped, status
--   Active/Probationary — so a Project Admin who is a member of that department also passes (the same gate as
--   soft-delete / replace on documents). Flagged for review; no stricter check was written.
-- UNCHANGED: acknowledge_document, my_read_sign_queue, dept_read_sign_compliance (Board/DA/Officer still see "X of Y"),
--   every table, policy and grant (CREATE OR REPLACE keeps each function's ACL; re-asserted below anyway).
-- GUARDED: refuses unless both live bodies are the B4C:read_sign versions still using is_canmanage_ops(), and unless
--   is_dept_admin() is department-scoped. POST: neither body mentions is_canmanage_ops; both use is_dept_admin(); anon
--   can't execute; every policy byte-identical.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_t text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'$q$;
BEGIN
  FOREACH v_t IN ARRAY array['public.set_document_ack_config(uuid,boolean,text[],boolean)', 'public.publish_document_version(uuid)'] LOOP
    IF to_regprocedure(v_t) IS NULL THEN RAISE EXCEPTION 'Precondition failed: % missing (apply read_sign first).', v_t; END IF;
    IF position('B4C:read_sign' in pg_get_functiondef(to_regprocedure(v_t))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: % is not the B4C:read_sign version — not overwriting it.', v_t;
    END IF;
    IF position('is_canmanage_ops()' in pg_get_functiondef(to_regprocedure(v_t))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: % no longer uses is_canmanage_ops() — already changed, or drifted. Nothing changed.', v_t;
    END IF;
  END LOOP;
  IF position('my_department_id()' in pg_get_functiondef('public.is_dept_admin()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is not department-scoped — do not build on it.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_document_ack_config(p_document_id uuid, p_requires boolean, p_required_roles text[], p_annual boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — Department Admin of the document's department (is_dept_admin(): DA/PA, department-scoped). Officers can't.
declare d public.documents%rowtype; v_me uuid := public.my_member_id(); v_roles text[]; v_bad text; v_ver int;
begin
  select * into d from public.documents where id = p_document_id;
  if not found or d.department_id is distinct from public.my_department_id() or not public.is_dept_admin() then
    raise exception 'Only a Department Admin of this department can change this.';
  end if;
  v_roles := case when p_required_roles is null or cardinality(p_required_roles) = 0 then null else p_required_roles end;
  select r into v_bad from unnest(coalesce(v_roles, '{}')) r
   where r not in ('Member', 'Officer', 'Board Member', 'Department Admin') limit 1;
  if v_bad is not null then raise exception 'Unknown role: %', v_bad; end if;
  insert into public.document_series (series_id, department_id, requires_ack, required_roles, annual_resign, title)
  values (d.series_id, d.department_id, coalesce(p_requires, false), v_roles, coalesce(p_annual, false), d.name)
  on conflict (series_id) do update set requires_ack = excluded.requires_ack, required_roles = excluded.required_roles,
                                        annual_resign = excluded.annual_resign, updated_at = now();
  select current_version into v_ver from public.document_series where series_id = d.series_id;
  if coalesce(p_requires, false) and v_ver = 0 then
    v_ver := public.rs_publish(d.series_id, d.department_id, v_me);   -- first time on: there must be a version to sign
  end if;
  return jsonb_build_object('series_id', d.series_id, 'requires_ack', coalesce(p_requires, false), 'current_version', v_ver);
end;
$function$
$ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.publish_document_version(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — the deliberate "everyone re-signs" action. Department Admin of the department (is_dept_admin()). Officers can't.
declare d public.documents%rowtype; s public.document_series%rowtype; v_ver int;
begin
  select * into d from public.documents where id = p_document_id;
  if not found or d.department_id is distinct from public.my_department_id() or not public.is_dept_admin() then
    raise exception 'Only a Department Admin of this department can publish.';
  end if;
  select * into s from public.document_series where series_id = d.series_id for update;
  if not found or not s.requires_ack then raise exception 'Turn on "requires acknowledgment" before publishing a version.'; end if;
  v_ver := public.rs_publish(d.series_id, d.department_id, public.my_member_id());
  return jsonb_build_object('series_id', d.series_id, 'current_version', v_ver);
end;
$function$
$ddl$;
  FOREACH v_t IN ARRAY array['public.set_document_ack_config(uuid,boolean,text[],boolean)', 'public.publish_document_version(uuid)'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_t);
    IF position('is_canmanage_ops' in pg_get_functiondef(to_regprocedure(v_t))) > 0
       OR position('is_dept_admin()' in pg_get_functiondef(to_regprocedure(v_t))) = 0
       OR position('d.department_id is distinct from public.my_department_id()' in pg_get_functiondef(to_regprocedure(v_t))) = 0 THEN
      RAISE EXCEPTION 'Post-condition failed: % is not the intended DA-only, department-checked body. Rolling back.', v_t;
    END IF;
    IF has_function_privilege('anon', v_t, 'EXECUTE') THEN RAISE EXCEPTION 'Post-condition failed: anon can execute %.', v_t; END IF;
  END LOOP;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed. Rolling back.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect both rows: da_only true · uses_canmanage_ops false · dept_check true · anon false;
-- total_policies unchanged (160)
SELECT p.proname,
       position('is_dept_admin()' in pg_get_functiondef(p.oid)) > 0 AS da_only,
       position('is_canmanage_ops' in pg_get_functiondef(p.oid)) > 0 AS uses_canmanage_ops,
       position('d.department_id is distinct from public.my_department_id()' in pg_get_functiondef(p.oid)) > 0 AS dept_check,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('set_document_ack_config', 'publish_document_version')
 ORDER BY 1;

-- ROLLBACK (only if needed): re-apply the two bodies from sql/read_sign_2026-10-17.sql §5 (is_canmanage_ops()).
