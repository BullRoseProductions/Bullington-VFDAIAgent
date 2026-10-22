-- =====================================================================
-- CERT CATALOG — SLICE B (a cert type can gate readiness) — DRAFT, NOT REVIEWED, NOT APPLIED.
-- Order: claude/B4C_CertCatalog_DB_BuildOrder.md (Slice B). Slice A is live (cert_types, certs.cert_type_id, no_expiry).
--
-- THE CHANGE — a new readiness requirement kind 'cert_type' (ref_id = a cert_types id of the department):
--   readiness_requirements_kind_check   + 'cert_type'. readiness_requirements_ref_chk is unchanged — a non-credential
--                                       kind already requires a ref_id; readiness_requirements_uq covers it.
--   set_readiness_requirement           + 'cert_type' in the kind list, and a branch: the ref must be a cert type of the
--                                       caller's department ('That cert type is not set up in your department.').
--   readiness_items                     explicit cert_type branches in the label, satisfied, status, expires_on and
--                                       order-by CASE chains (Step 0b F5 — without them the kind falls through to
--                                       "Fit test" judged against best_cred = NULL and reads "missing"). Per required
--                                       type, the member's BEST cert of it (via expiration_rows + readiness_window, so
--                                       Slice A's no_expiry is honoured): satisfied when no_expiry / current / soon.
--                                       Status uses the words the scorecard already renders (RD_STATUS):
--                                       current (incl. no_expiry) · expiring · no_date · expired · missing ·
--                                       not_configured (the type was deleted). Label = the type's name.
--   dept_readiness_requirements         NOT named in the build order, but it has the same label fall-through
--                                       (else 'Fit test') and feeds the configurator AND dept_readiness_packet's
--                                       requirement list — so it gets the same explicit cert_type label + order.
-- member_scorecard / readiness_verdict / dept_readiness_packet call these, so the kind propagates; the verdict's
-- 'certs' visibility list is unchanged. The honest default holds: no_date / expired never satisfies, an unknown is
-- never satisfied (readiness_items' outer coalesce(..., false) is kept).
--
-- Single all-or-nothing DO block; refuses on drift (the three functions' live md5s and the kind CHECK pinned verbatim;
-- the Slice A objects must exist) and refuses a second apply (the CHECK must not already allow cert_type). Each
-- function = its live body with exactly the listed edits, at its reviewed md5; owner / definer / config / grants kept;
-- every OTHER function and every policy byte-identical; total_policies and the locked-token count unchanged. The
-- locked verification column is never touched. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  OLD constant jsonb := '{"set_readiness_requirement(text,uuid,boolean)":"5ac03cd738f3897b0eb0ae7a6768670e","readiness_items(uuid,uuid)":"2a0bca8bdd97be68b26daaa6a22106f5",
                          "dept_readiness_requirements()":"cbda990103f6f77011ae6e83b2375b29"}';
  NEW constant jsonb := '{"set_readiness_requirement(text,uuid,boolean)":"6fefa4af7e0db73ec2321bc829be6a85","readiness_items(uuid,uuid)":"7690790c5b21d29aa72ff249592fd65f",
                          "dept_readiness_requirements()":"2aa9061d6eec9fe28bd9c149f239aa18"}';
  KIND_OLD constant text := 'CHECK ((kind = ANY (ARRAY[''credential_license''::text, ''credential_med_card''::text, ''credential_fit_test''::text, ''qualification_type''::text, ''document''::text])))';
  KIND_NEW constant text := 'CHECK ((kind = ANY (ARRAY[''credential_license''::text, ''credential_med_card''::text, ''credential_fit_test''::text, ''qualification_type''::text, ''document''::text, ''cert_type''::text])))';
  e record; f text; n int; v_def text; v_src text; v_got text;
  v_defs jsonb := '{}'; v_exp_src jsonb := '{}'; v_meta_before text; v_meta_after text; v_con_before text; v_con_after text;
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_total_before int; v_tok_before int;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  IF to_regclass('public.cert_types') IS NULL OR to_regprocedure('public.assign_cert_type(uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'certs' AND column_name = 'cert_type_id') THEN
    RAISE EXCEPTION 'Precondition failed: Slice A (cert_types, certs.cert_type_id, the cert-type RPCs) is not live. Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.readiness_window(text,date)'::regprocedure)) <> 'f3d7788e1ee66a039d46b7e960d1a480'
     OR md5(pg_get_functiondef('public.expiration_rows(uuid,uuid)'::regprocedure)) <> '27645093a86b7a67dfb04a21d0fca536' THEN
    RAISE EXCEPTION 'Precondition failed: readiness_window / expiration_rows are not the Slice A versions (no_expiry). Nothing changed.';
  END IF;
  IF md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) <> 'c692e44f62923d2bf4c1a39a21a87bf7' THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is not the department-scoped Step A version (md5 c692e44f…). Nothing changed.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_got FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname = 'readiness_requirements_kind_check';
  IF v_got = KIND_NEW THEN RAISE EXCEPTION 'Precondition failed: readiness_requirements_kind_check already allows cert_type — already applied. Nothing changed.'; END IF;
  IF v_got IS DISTINCT FROM KIND_OLD THEN RAISE EXCEPTION 'Precondition failed: readiness_requirements_kind_check is not the Step 0 shape (found %). Nothing changed.', v_got; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'readiness_requirements_uq'
                  AND indexdef = 'CREATE UNIQUE INDEX readiness_requirements_uq ON public.readiness_requirements USING btree (department_id, kind, ref_id) NULLS NOT DISTINCT') THEN
    RAISE EXCEPTION 'Precondition failed: readiness_requirements_uq is not the Step 0b index. Nothing changed.';
  END IF;
  FOR f IN SELECT jsonb_object_keys(OLD) LOOP
    IF to_regprocedure('public.' || f) IS NULL THEN RAISE EXCEPTION 'Precondition failed: public.% is missing. Nothing changed.', f; END IF;
    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> OLD ->> f THEN
      RAISE EXCEPTION 'Precondition failed: public.% is not the live version this was written against (md5 %, expected %). Nothing changed.', f, md5(pg_get_functiondef(('public.' || f)::regprocedure)), OLD ->> f;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------- the edits (fn, old fragment, new fragment) — each must anchor exactly once
  CREATE TEMP TABLE _sliceB_edits (ord int, fn text, old_frag text, new_frag text) ON COMMIT DROP;
  INSERT INTO _sliceB_edits VALUES
  -- set_readiness_requirement: the kind list + a cert_type branch
  (1, 'set_readiness_requirement(text,uuid,boolean)',
   $o$  if p_kind is null or p_kind not in ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document') then$o$,
   $n$  if p_kind is null or p_kind not in ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document', 'cert_type') then$n$),
  (2, 'set_readiness_requirement(text,uuid,boolean)',
   $o$  else   -- document: a series id, or any document row of it (mapped through documents.series_id)$o$,
   $n$  elsif p_kind = 'cert_type' then   -- cert catalog (Slice B): a cert type of this department
    if v_ref is null or not exists (select 1 from public.cert_types where id = v_ref and department_id = v_dept) then
      raise exception 'That cert type is not set up in your department.';
    end if;
  else   -- document: a series id, or any document row of it (mapped through documents.series_id)$n$),
  -- readiness_items: the member's best cert per type, then explicit branches in every CASE chain
  (3, 'readiness_items(uuid,uuid)',
   $o$     order by c.kind, case c.w when 'current' then 0 when 'soon' then 1 when 'no_date' then 2 else 3 end, c.expires_on desc nulls last)
  select r.id, r.kind, r.ref_id,$o$,
   $n$     order by c.kind, case c.w when 'current' then 0 when 'soon' then 1 when 'no_date' then 2 else 3 end, c.expires_on desc nulls last),
  ctype as (   -- cert catalog (Slice B): per cert type, the member's best cert of it — no_expiry / current > soon > no_date > expired
    select distinct on (c.cert_type_id) c.cert_type_id, x.expires_on, x.w
      from public.certs c
      join (select e.item_id, e.expires_on, public.readiness_window(e.bucket, e.expires_on) as w
              from public.expiration_rows(p_dept, p_member) e where e.source = 'cert') x on x.item_id = c.id
     where c.member_id = p_member and c.department_id = p_dept and c.cert_type_id is not null
     order by c.cert_type_id, case x.w when 'no_expiry' then 0 when 'current' then 0 when 'soon' then 1 when 'no_date' then 2 else 3 end, x.expires_on desc nulls last)
  select r.id, r.kind, r.ref_id,$n$),
  (4, 'readiness_items(uuid,uuid)',
   $o$              when r.kind = 'credential_license' then 'Driver''s license'$o$,
   $n$              when r.kind = 'cert_type' then coalesce(cty.name, 'Cert type (removed)')
              when r.kind = 'credential_license' then 'Driver''s license'$n$),
  (5, 'readiness_items(uuid,uuid)',
   $o$              else bc.w in ('current', 'soon') end, false),$o$,
   $n$              when r.kind = 'cert_type' then cty.id is not null and cb.w in ('no_expiry', 'current', 'soon')
              else bc.w in ('current', 'soon') end, false),$n$),
  (6, 'readiness_items(uuid,uuid)',
   $o$              else case when bc.kind is null then 'missing' when bc.w = 'soon' then 'expiring' else bc.w end end,$o$,
   $n$              when r.kind = 'cert_type' then
                case when cty.id is null then 'not_configured' when cb.cert_type_id is null then 'missing'
                     when cb.w = 'soon' then 'expiring' when cb.w = 'no_expiry' then 'current' else cb.w end
              else case when bc.kind is null then 'missing' when bc.w = 'soon' then 'expiring' else bc.w end end,$n$),
  (7, 'readiness_items(uuid,uuid)',
   $o$         case when r.kind like 'credential\_%' then bc.expires_on end$o$,
   $n$         case when r.kind like 'credential\_%' then bc.expires_on when r.kind = 'cert_type' then cb.expires_on end$n$),
  (8, 'readiness_items(uuid,uuid)',
   $o$    left join best_cred bc on r.kind like 'credential\_%' and bc.kind = substr(r.kind, 12)$o$,
   $n$    left join best_cred bc on r.kind like 'credential\_%' and bc.kind = substr(r.kind, 12)
    left join public.cert_types cty on r.kind = 'cert_type' and cty.id = r.ref_id and cty.department_id = p_dept
    left join ctype cb on r.kind = 'cert_type' and cb.cert_type_id = r.ref_id$n$),
  (9, 'readiness_items(uuid,uuid)',
   $o$   order by case when r.kind = 'qualification_type' then 0 when r.kind like 'credential\_%' then 1 else 2 end, 4;$o$,
   $n$   order by case when r.kind = 'qualification_type' then 0 when r.kind like 'credential\_%' or r.kind = 'cert_type' then 1 else 2 end, 4;$n$),
  -- dept_readiness_requirements: the same label fall-through + order
  (10, 'dept_readiness_requirements()',
   $o$              when r.kind = 'credential_med_card' then 'Med card' else 'Fit test' end,$o$,
   $n$              when r.kind = 'credential_med_card' then 'Med card'
              when r.kind = 'cert_type' then coalesce(cty.name, 'Cert type (removed)')
              else 'Fit test' end,$n$),
  (11, 'dept_readiness_requirements()',
   $o$    left join public.document_series ds on r.kind = 'document' and ds.series_id = r.ref_id$o$,
   $n$    left join public.document_series ds on r.kind = 'document' and ds.series_id = r.ref_id
    left join public.cert_types cty on r.kind = 'cert_type' and cty.id = r.ref_id and cty.department_id = v_dept$n$),
  (12, 'dept_readiness_requirements()',
   $o$   order by case when r.kind = 'qualification_type' then 0 when r.kind like 'credential\_%' then 1 else 2 end, 4;$o$,
   $n$   order by case when r.kind = 'qualification_type' then 0 when r.kind like 'credential\_%' or r.kind = 'cert_type' then 1 else 2 end, 4;$n$);

  FOR f IN SELECT DISTINCT fn FROM _sliceB_edits LOOP
    v_def := pg_get_functiondef(('public.' || f)::regprocedure);
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = ('public.' || f)::regprocedure;
    FOR e IN SELECT * FROM _sliceB_edits WHERE fn = f ORDER BY ord LOOP
      n := (length(v_src) - length(replace(v_src, e.old_frag, ''))) / length(e.old_frag);
      IF n <> 1 OR (length(v_def) - length(replace(v_def, e.old_frag, ''))) / length(e.old_frag) <> 1 THEN
        RAISE EXCEPTION 'Precondition failed: edit % (%) anchors % times in the live body, not once. Nothing changed.', e.ord, f, n;
      END IF;
      v_def := replace(v_def, e.old_frag, e.new_frag);
      v_src := replace(v_src, e.old_frag, e.new_frag);
    END LOOP;
    v_defs := v_defs || jsonb_build_object(f, v_def);
    v_exp_src := v_exp_src || jsonb_build_object(f, v_src);
  END LOOP;

  -- snapshots
  SELECT string_agg(p.oid::regprocedure::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
                    || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(p.proacl::text, '') || '|' || pg_get_function_result(p.oid), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_meta_before FROM pg_proc p WHERE p.oid IN (SELECT ('public.' || k)::regprocedure::oid FROM jsonb_object_keys(OLD) k);
  SELECT string_agg(conname || '|' || pg_get_constraintdef(oid), E'\n' ORDER BY conname) INTO v_con_before
    FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname <> 'readiness_requirements_kind_check';
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT ('public.' || k)::regprocedure::oid FROM jsonb_object_keys(OLD) k);
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;

  -- ---------------------------------------------------------------- the change
  ALTER TABLE public.readiness_requirements DROP CONSTRAINT readiness_requirements_kind_check;
  ALTER TABLE public.readiness_requirements ADD CONSTRAINT readiness_requirements_kind_check
    CHECK (kind IN ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document', 'cert_type'));
  EXECUTE v_defs ->> 'set_readiness_requirement(text,uuid,boolean)';
  EXECUTE v_defs ->> 'readiness_items(uuid,uuid)';
  EXECUTE v_defs ->> 'dept_readiness_requirements()';

  -- ---------------------------------------------------------------- post-conditions
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname = 'readiness_requirements_kind_check') IS DISTINCT FROM KIND_NEW THEN
    RAISE EXCEPTION 'Post-condition failed: readiness_requirements_kind_check is not the six-kind list.';
  END IF;
  SELECT string_agg(conname || '|' || pg_get_constraintdef(oid), E'\n' ORDER BY conname) INTO v_con_after
    FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname <> 'readiness_requirements_kind_check';
  IF v_con_after IS DISTINCT FROM v_con_before THEN RAISE EXCEPTION 'Post-condition failed: another readiness_requirements constraint changed (ref_chk must be untouched).'; END IF;
  FOR f IN SELECT jsonb_object_keys(OLD) LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = ('public.' || f)::regprocedure) IS DISTINCT FROM v_exp_src ->> f THEN
      RAISE EXCEPTION 'Post-condition failed: % differs from its live body by more than the listed edits.', f;
    END IF;
    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> NEW ->> f THEN
      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', f;
    END IF;
  END LOOP;
  SELECT string_agg(p.oid::regprocedure::text || '|' || p.proowner::regrole::text || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|'
                    || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(p.proacl::text, '') || '|' || pg_get_function_result(p.oid), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_meta_after FROM pg_proc p WHERE p.oid IN (SELECT ('public.' || k)::regprocedure::oid FROM jsonb_object_keys(OLD) k);
  IF v_meta_after IS DISTINCT FROM v_meta_before THEN RAISE EXCEPTION 'Post-condition failed: owner / definer / volatility / search_path / grants / return shape changed on a touched function.'; END IF;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT ('public.' || k)::regprocedure::oid FROM jsonb_object_keys(OLD) k);
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: another public function changed.'; END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: the policy count changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.readiness_requirements WHERE kind = 'cert_type') THEN
    RAISE EXCEPTION 'Post-condition failed: a cert_type requirement exists already (none should).';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: kind_check_has_cert_type true · cert_type_reqs 0 · fns_ok true · total_policies 170 · locked_token_fns 17)
SELECT
  (SELECT pg_get_constraintdef(oid) LIKE '%''cert_type''::text%' FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname = 'readiness_requirements_kind_check') AS kind_check_has_cert_type,
  (SELECT count(*) FROM public.readiness_requirements WHERE kind = 'cert_type') AS cert_type_reqs,
  (md5(pg_get_functiondef('public.set_readiness_requirement(text,uuid,boolean)'::regprocedure)) = '6fefa4af7e0db73ec2321bc829be6a85'
   AND md5(pg_get_functiondef('public.readiness_items(uuid,uuid)'::regprocedure)) = '7690790c5b21d29aa72ff249592fd65f'
   AND md5(pg_get_functiondef('public.dept_readiness_requirements()'::regprocedure)) = '2aa9061d6eec9fe28bd9c149f239aa18') AS fns_ok,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
