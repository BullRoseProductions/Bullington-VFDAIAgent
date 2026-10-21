-- =====================================================================
-- CERT WRITE-GATE FIX (cert catalog Step 0, F1) — Review PASS 2026-10-21 (c6931d1). Not yet applied.
-- Order: claude/B4C_CertWriteGate_Fix_BuildOrder.md. Off the live Step 0 (2026-10-21, docs/review/cert_catalog_STEP0_OUTPUT.md).
--
-- THE GAP: update_cert(uuid,text,text) and delete_cert(uuid) are SECURITY DEFINER, gate on is_department_admin() — the
-- role-anywhere gate (true for a DA / PA of ANY department) — and then act on `where id = cert_id` with no department
-- term. A Department Admin of one department can rename, re-date or delete another department's cert given its id.
-- Latent (cert ids are uuids; the certs SELECT policies only show ids inside the caller's own department).
--
-- THE FIX — two lines in each function, nothing else:
--   1. the gate:  public.is_department_admin()  ->  public.is_dept_admin()   (department-scoped; md5 c692e44f… pinned)
--   2. the WHERE: `where id = cert_id`  ->  `where id = cert_id and department_id = public.my_department_id()`
-- A cross-department id and a nonexistent id both match 0 rows -> the existing `if not found` raises
-- 'Certification not found' (never reveals that the id exists elsewhere). The name / exp validation — including the
-- lax '^\d{4}-\d{2}$' regex (F2, deferred to the catalog) — the comments, blank lines, error texts, signatures,
-- SECURITY DEFINER, search_path, owner and EXECUTE grants are unchanged. The post-condition proves it: each new body
-- must equal the OLD live body with exactly those two substitutions applied, and match its own md5 pin.
--
-- Single all-or-nothing DO block; refuses on drift (both current md5s pinned, plus both gates) and refuses a second
-- apply. Every other public function's definition and every policy byte-identical; total_policies and the
-- locked-token function count unchanged. The locked verification column is never touched. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  UPD_OLD constant text := '5cd098a11f04d4c80c8ca564ee068302';   -- update_cert, live 2026-10-21
  DEL_OLD constant text := '8d0a006c2ef91ac044a64f23772ef40d';   -- delete_cert, live 2026-10-21
  UPD_NEW constant text := '08ec5f34bf3d897d95bdbeda5ec52ae7';
  DEL_NEW constant text := '5d7693342ca274ea693ec283ac079ca7';
  GATE_OLD constant text := 'public.is_department_admin()';
  GATE_NEW constant text := 'public.is_dept_admin()';
  v_upd_md5 text; v_del_md5 text; v_upd_src text; v_del_src text; v_upd_meta text; v_del_meta text;
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_total_before int; v_tok_before int;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regprocedure('public.update_cert(uuid,text,text)') IS NULL OR to_regprocedure('public.delete_cert(uuid)') IS NULL
     OR to_regprocedure('public.is_dept_admin()') IS NULL OR to_regprocedure('public.is_department_admin()') IS NULL
     OR to_regprocedure('public.my_department_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: a function this fix touches or relies on is missing. Nothing changed.';
  END IF;
  v_upd_md5 := md5(pg_get_functiondef('public.update_cert(uuid,text,text)'::regprocedure));
  v_del_md5 := md5(pg_get_functiondef('public.delete_cert(uuid)'::regprocedure));
  IF v_upd_md5 = UPD_NEW AND v_del_md5 = DEL_NEW THEN
    RAISE EXCEPTION 'Precondition failed: update_cert and delete_cert are already re-gated — already applied. Nothing changed.';
  END IF;
  IF v_upd_md5 <> UPD_OLD THEN
    RAISE EXCEPTION 'Precondition failed: update_cert is not the Step 0 version (md5 % , expected 5cd098a1…). Nothing changed.', v_upd_md5;
  END IF;
  IF v_del_md5 <> DEL_OLD THEN
    RAISE EXCEPTION 'Precondition failed: delete_cert is not the Step 0 version (md5 % , expected 8d0a006c…). Nothing changed.', v_del_md5;
  END IF;
  IF md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) <> 'c692e44f62923d2bf4c1a39a21a87bf7' THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is not the department-scoped Step A version (md5 c692e44f…). Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_department_admin()'::regprocedure)) <> '99570e1790f233594464da32436c8ca7' THEN
    RAISE EXCEPTION 'Precondition failed: is_department_admin() is not the role-anywhere version Step 0 read (md5 99570e17…). Nothing changed.';
  END IF;
  SELECT prosrc INTO v_upd_src FROM pg_proc WHERE oid = 'public.update_cert(uuid,text,text)'::regprocedure;
  SELECT prosrc INTO v_del_src FROM pg_proc WHERE oid = 'public.delete_cert(uuid)'::regprocedure;
  -- each substitution anchor must occur exactly once in the old body
  IF (length(v_upd_src) - length(replace(v_upd_src, GATE_OLD, ''))) / length(GATE_OLD) <> 1
     OR (length(v_upd_src) - length(replace(v_upd_src, '  where id = cert_id;', ''))) / length('  where id = cert_id;') <> 1
     OR (length(v_del_src) - length(replace(v_del_src, GATE_OLD, ''))) / length(GATE_OLD) <> 1
     OR (length(v_del_src) - length(replace(v_del_src, 'delete from public.certs where id = cert_id;', ''))) / length('delete from public.certs where id = cert_id;') <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: an edit anchor does not occur exactly once. Nothing changed.';
  END IF;
  -- owner / definer / config / grants of the two, to prove CREATE OR REPLACE kept them
  SELECT string_agg(p.oid::regprocedure::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
                    || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_upd_meta FROM pg_proc p WHERE p.oid IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure);
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure);
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;

  -- ---------------------------------------------------------------- the change (live bodies; the two edited lines marked)
  CREATE OR REPLACE FUNCTION public.update_cert(cert_id uuid, new_name text, new_exp text)
   RETURNS void
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public'
  AS $function$
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized to edit certifications';
  end if;

  if new_name is null or btrim(new_name) = '' then
    raise exception 'Certification name is required';
  end if;

  -- exp must be null/empty (no expiration) or a valid YYYY-MM string
  if new_exp is not null and btrim(new_exp) <> '' and new_exp !~ '^\d{4}-\d{2}$' then
    raise exception 'Expiration must be YYYY-MM (got: %)', new_exp;
  end if;

  update public.certs
  set name = btrim(new_name),
      exp  = case when new_exp is null or btrim(new_exp) = '' then null else new_exp end
  where id = cert_id and department_id = public.my_department_id();

  if not found then
    raise exception 'Certification not found';
  end if;
end;
$function$;

  CREATE OR REPLACE FUNCTION public.delete_cert(cert_id uuid)
   RETURNS void
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public'
  AS $function$
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized to delete certifications';
  end if;

  delete from public.certs where id = cert_id and department_id = public.my_department_id();

  if not found then
    raise exception 'Certification not found';
  end if;
end;
$function$;

  -- ---------------------------------------------------------------- post-conditions
  -- (1) each new body = the old live body with exactly the two substitutions — the validation is byte-identical
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.update_cert(uuid,text,text)'::regprocedure)
     IS DISTINCT FROM replace(replace(v_upd_src, GATE_OLD, GATE_NEW), '  where id = cert_id;', '  where id = cert_id and department_id = public.my_department_id();') THEN
    RAISE EXCEPTION 'Post-condition failed: update_cert differs from the live body by more than the gate and the department scope.';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.delete_cert(uuid)'::regprocedure)
     IS DISTINCT FROM replace(replace(v_del_src, GATE_OLD, GATE_NEW), 'delete from public.certs where id = cert_id;', 'delete from public.certs where id = cert_id and department_id = public.my_department_id();') THEN
    RAISE EXCEPTION 'Post-condition failed: delete_cert differs from the live body by more than the gate and the department scope.';
  END IF;
  -- (2) the pins, and the three token facts stated directly
  IF md5(pg_get_functiondef('public.update_cert(uuid,text,text)'::regprocedure)) <> UPD_NEW
     OR md5(pg_get_functiondef('public.delete_cert(uuid)'::regprocedure)) <> DEL_NEW THEN
    RAISE EXCEPTION 'Post-condition failed: a re-gated function does not match its reviewed md5.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure)
              AND (position('is_department_admin' in prosrc) > 0 OR position('public.is_dept_admin()' in prosrc) = 0
                   OR position('department_id = public.my_department_id()' in prosrc) = 0)) THEN
    RAISE EXCEPTION 'Post-condition failed: a function still uses the role-anywhere gate or lacks the department scope.';
  END IF;
  -- (3) owner / definer / volatility / search_path / grants kept
  IF (SELECT string_agg(p.oid::regprocedure::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
                        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p WHERE p.oid IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure)) IS DISTINCT FROM v_upd_meta THEN
    RAISE EXCEPTION 'Post-condition failed: owner, SECURITY DEFINER, search_path or EXECUTE grants changed on a re-gated function.';
  END IF;
  -- (4) nothing else moved
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure);
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: another public function changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: the policy count changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: regated 2 · role_anywhere_left 0 · dept_scoped 2 · total_policies 169 · locked_token_fns 17)
SELECT
  (SELECT count(*) FROM pg_proc WHERE oid IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure)
     AND position('public.is_dept_admin()' in prosrc) > 0) AS regated,
  (SELECT count(*) FROM pg_proc WHERE oid IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure)
     AND position('is_department_admin' in prosrc) > 0) AS role_anywhere_left,
  (SELECT count(*) FROM pg_proc WHERE oid IN ('public.update_cert(uuid,text,text)'::regprocedure, 'public.delete_cert(uuid)'::regprocedure)
     AND position('department_id = public.my_department_id()' in prosrc) > 0) AS dept_scoped,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
