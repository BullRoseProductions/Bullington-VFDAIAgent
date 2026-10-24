-- =====================================================================
-- APPLIED on live 2026-10-24 — this file as reviewed at f27c525, byte-for-byte (sha256 c3243382…); state row:
-- columns_ok · checks_ok · helper_ok · grants_ok true · update_cert_args 5 · update_cert_old_gone true · no_expiry_sites
-- readiness 1 · expiration_rows 1 · rollup 5 · radar 2 · probation 1 · update_cert_md5 88ae9180 · helper_md5 7c4083b5 ·
-- existing_defaults 0 · certs_total 179 · total_policies 173 · locked_token_fns 17.
-- CERT DATES — SLICE A (DB): certs.achieved_on + certs.no_expiry (Review PASS).
-- Concept claude/B4C_CertDates_AchievedOn_NoExpiry_Concept.md · Step 0 PASS claude/B4C_CertDates_SliceA_Step0_ReviewRecord.md
-- (audit claude/B4C_CertDates_SliceA_Step0.md, live evidence docs/review/cert_dates_STEP0_OUTPUT.json — 179 certs, 0 cert
-- types, 0 malformed, 173 policies, 17 locked-token functions; the 7 functions below = the post-malformed-fix md5s).
--
-- THE CHANGE
--   1. COLUMNS
--        certs.achieved_on text NULL            — the month the cert was earned, 'YYYY-MM' (display-only; no reader reads it)
--        certs.no_expiry  boolean NOT NULL DEFAULT false — "doesn't expire", set on the cert itself
--        CHECK certs_achieved_on_valid    (achieved_on IS NULL OR valid_exp_ym(achieved_on))
--        CHECK certs_no_expiry_clears_exp (NOT no_expiry OR exp IS NULL)   — a no-expiry cert has no expiry date, so every
--              consumer that doesn't know the flag yet (stale client, api/digest.js, the assistant) reads it as "no date",
--              never expired
--        cert_submissions.achieved_on / .no_expiry — the same two, NO CHECKs: a proposal carries what was typed and
--              approve_cert_submission clears what's invalid (Ashlea's clear-don't-refuse rule); a CHECK there would refuse
--              the member's own submission instead. The two INSERT policies don't restrict columns — no policy change.
--   2. public.cert_never_expires(no_expiry, cert_type_id, department_id) — THE effective rule, the SQL twin of the client's
--        enrichCerts (Slice B): the cert's own flag OR its same-department type's never_expires. STABLE, invoker, reads
--        cert_types. Used by the radar + rollup (below).
--   3. READERS — effective never-expires = cert.no_expiry OR type.never_expires, in all five. The flag is ORed INTO the one
--      boolean that decides never-expires today, so a cert with the flag AND a never-expires type counts once.
--        dept_cert_readiness()            1  when coalesce(t.never_expires, false)  -> when c.no_expiry or coalesce(t.never_expires, false)
--        expiration_rows(uuid,uuid)       1  the nx flag's exists(): join -> left join (type's department in the ON), + c.no_expiry
--        probation_item_states(uuid,uuid) 1  and (coalesce(t.never_expires, false) -> and (c.no_expiry or coalesce(t.never_expires, false)
--        pa_department_radar()            2  expiring / expired counts gain  and not cert_never_expires(...)   (D2 — new)
--        my_department_rollup()           5  dept expiring / expired + my expiring / expired gain  and not cert_never_expires(...);
--                                            my_certs_current = cert_never_expires(...) OR (valid month AND > 3 months out)  (D2 — new)
--      D2 closes the latent gap where the radar / rollup counted a never-expires-TYPE cert with an old date as expired. Live
--      today there are 0 types and 0 flags, so NO reader output moves (post-condition (5) proves it on the live data).
--   4. WRITERS
--        update_cert — one function, two new OPTIONAL args (D3-a): update_cert(cert_id, new_name, new_exp,
--          new_no_expiry boolean DEFAULT NULL, new_achieved_on text DEFAULT NULL). NULL = leave unchanged, so today's 3-arg
--          calls (the live client, any stale native build) resolve to it and behave as before. A signature change is a
--          DROP + CREATE: the old body is md5-pinned, the new one reviewed in full, grants re-applied and asserted equal to
--          the old grants (authenticated + service_role, no anon / PUBLIC).
--          no_expiry true -> exp cleared · a non-blank exp -> no_expiry false (a date means "expires") · achieved_on: NULL =
--          unchanged, '' = clear; refused if not a real month, IN THE FUTURE, or AFTER THE EXPIRY (D1).
--        approve_cert_submission — copies both; exp cleared when the proposal says "doesn't expire"; an achieved_on that's not
--          a real month / in the future / after the expiry is CLEARED, not refused.
-- NOT touched: every other function, every policy, every trigger, every existing row's values (new columns at their defaults),
-- cert_types. verified never touched.
--
-- Single all-or-nothing DO block. Preconditions: the 7 live md5s, each swap's exact occurrence count, the 4 columns absent.
-- Post-conditions: columns + constraints exactly as designed; the helper's shape / grants / rule; each re-pointed body EXACTLY
-- its live pre-image with its swaps (and its reviewed md5); update_cert's reviewed md5 + grants equal to before; every other
-- function (md5 + grants), every policy and every trigger byte-identical; function count +1; total_policies + locked-token
-- unchanged; every existing certs / cert_submissions row unchanged (old columns byte-identical, new ones at their defaults);
-- AND the five readers' outputs on the live data byte-identical before / after. State check.
-- =====================================================================
DO $migrate$
DECLARE
  v_spec jsonb; s jsonb; w jsonb; v_def text; v_new text; v_pre jsonb := '{}'; v_meta jsonb := '{}';
  v_fns_before text; v_fns_after text; v_pol_before text; v_pol_after text; v_trg_before text; v_trg_after text;
  v_total_before int; v_tok_before int; v_nfn_before int; v_acl_ref text; v_upd_acl text;
  v_certs_before text; v_subs_before text; v_types_before text; v_cols_before jsonb; v_cons_before text; v_reads_before text; v_reads_after text;
  v_claims text; r record;
  HELPER_MD5 constant text := '7c4083b586e650313b0009ed73d93764';
  UPDATE_MD5 constant text := '88ae91805aff031e3debdb51a8b89eb9';
  NE constant text := 'public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)';
BEGIN
  -- the five readers + approve: live md5 · [old, new, occurrences] swaps · the reviewed md5 after
  SELECT jsonb_agg(jsonb_build_object('fn', fn, 'pre', pre, 'swaps', swaps, 'post', post) ORDER BY ord) INTO v_spec FROM (VALUES
    (1, 'public.dept_cert_readiness()', '6a55033101e75f1a9c088aaa8bf3e861', jsonb_build_array(jsonb_build_array(
        $t$when coalesce(t.never_expires, false) then 'no_expiry'$t$,
        $t$when c.no_expiry or coalesce(t.never_expires, false) then 'no_expiry'$t$, 1)), 'a719cc34405ff25661c34a243fa35891'),
    (2, 'public.expiration_rows(uuid,uuid)', '4ccf41b4f5d87c1d45ada59a2b91686f', jsonb_build_array(jsonb_build_array(
        $t$exists (select 1 from public.certs c join public.cert_types t on t.id = c.cert_type_id
                                                              where c.id = r.item_id and t.department_id = p_dept and t.never_expires)$t$,
        $t$exists (select 1 from public.certs c left join public.cert_types t on t.id = c.cert_type_id and t.department_id = p_dept
                                                              where c.id = r.item_id and (c.no_expiry or coalesce(t.never_expires, false)))$t$, 1)), '326ed08e0eea1d9c01703d965d4876a1'),
    (3, 'public.probation_item_states(uuid,uuid)', '677b005d7543c35d5c926ca9798e67d6', jsonb_build_array(jsonb_build_array(
        $t$and (coalesce(t.never_expires, false)   -- cert catalog: a never-expires type is current$t$,
        $t$and (c.no_expiry or coalesce(t.never_expires, false)   -- cert catalog: a never-expires type (or a no-expiry cert) is current$t$, 1)), 'ab5eebbcdc06fd7d0610c7ccf42d7a64'),
    (4, 'public.pa_department_radar()', '5093693f4b8941f22a4b4a47263ee1ec', jsonb_build_array(jsonb_build_array(
        $t$where c.department_id = d.id and public.valid_exp_ym(c.exp)
$t$,
        $t$where c.department_id = d.id and public.valid_exp_ym(c.exp)
           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)
$t$, 2)), 'eb835b33d5dc8dae514b1d74af3de3c4'),
    (5, 'public.my_department_rollup()', '7b12e359bf7af9343565435658253a23', NULL, NULL),   -- placeholder row, replaced below
    (6, 'public.approve_cert_submission(uuid)', '01c1c75c16f24b3fd6209808955f5bd0', jsonb_build_array(jsonb_build_array(
        $t$  insert into public.certs (id, department_id, member_id, name, exp, proof_path, created_at)
  values (gen_random_uuid(), sub.department_id, sub.member_id, sub.name, case when public.valid_exp_ym(sub.exp) then sub.exp end, sub.proof_path, now())$t$,
        $t$  insert into public.certs (id, department_id, member_id, name, exp, proof_path, created_at, no_expiry, achieved_on)
  values (gen_random_uuid(), sub.department_id, sub.member_id, sub.name,
          case when not coalesce(sub.no_expiry, false) and public.valid_exp_ym(sub.exp) then sub.exp end, sub.proof_path, now(),
          coalesce(sub.no_expiry, false),
          -- the month it was earned: a real month, not in the future, not after the expiry — else CLEARED (clear, don't refuse)
          case when public.valid_exp_ym(sub.achieved_on)
                and sub.achieved_on <= to_char(now() at time zone 'America/Chicago', 'YYYY-MM')
                and (coalesce(sub.no_expiry, false) or not public.valid_exp_ym(sub.exp) or sub.achieved_on <= sub.exp)
               then sub.achieved_on end)$t$, 1)), '768ae48c585469956f8048cdb6959a42')
  ) v(ord, fn, pre, swaps, post);
  -- my_department_rollup(): the two department counts (as the radar) + the caller's three
  v_spec := jsonb_set(v_spec, '{4}', jsonb_build_object('fn', 'public.my_department_rollup()', 'pre', 'f46794ccdcd94451ff71f1fa404acefe', 'post', 'cd368f0fca832bbb0e804c939a7a9d10',
    'swaps', jsonb_build_array(
      jsonb_build_array($t$where c.department_id = d.id and public.valid_exp_ym(c.exp)
$t$, $t$where c.department_id = d.id and public.valid_exp_ym(c.exp)
           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)
$t$, 2),
      jsonb_build_array($t$and c.member_id = me.my_mid
           and public.valid_exp_ym(c.exp)
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) > 3)::int as my_certs_current,$t$,
        $t$and c.member_id = me.my_mid
           and (public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)
                or (public.valid_exp_ym(c.exp)
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) > 3)))::int as my_certs_current,$t$, 1),
      jsonb_build_array($t$and c.member_id = me.my_mid
           and public.valid_exp_ym(c.exp)
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) between 0 and 3)::int as my_certs_expiring,$t$,
        $t$and c.member_id = me.my_mid
           and public.valid_exp_ym(c.exp)
           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) between 0 and 3)::int as my_certs_expiring,$t$, 1),
      jsonb_build_array($t$and c.member_id = me.my_mid
           and public.valid_exp_ym(c.exp)
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) < 0)::int as my_certs_expired,$t$,
        $t$and c.member_id = me.my_mid
           and public.valid_exp_ym(c.exp)
           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) < 0)::int as my_certs_expired,$t$, 1))));

  -- ---------------------------------------------------------------- preconditions
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass)
              AND attname IN ('achieved_on', 'no_expiry') AND NOT attisdropped)
     OR to_regprocedure('public.cert_never_expires(boolean,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: achieved_on / no_expiry / cert_never_expires() already exist — already applied. Nothing changed.';
  END IF;
  IF to_regprocedure('public.valid_exp_ym(text)') IS NULL OR md5(pg_get_functiondef('public.valid_exp_ym(text)'::regprocedure)) <> '51b8cde1acf4a8e5db26a81dc65bee68' THEN
    RAISE EXCEPTION 'Precondition failed: valid_exp_ym() is not the reviewed helper (51b8cde1…). Nothing changed.';
  END IF;
  IF to_regprocedure('public.update_cert(uuid,text,text)') IS NULL
     OR md5(pg_get_functiondef('public.update_cert(uuid,text,text)'::regprocedure)) <> '232cd2f1b6aaf51ec2ec7bf9560f7870' THEN
    RAISE EXCEPTION 'Precondition failed: update_cert(uuid,text,text) drifted from the reviewed live body (md5 232cd2f1…). Nothing changed.';
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    IF to_regprocedure(s ->> 'fn') IS NULL THEN RAISE EXCEPTION 'Precondition failed: % is missing. Nothing changed.', s ->> 'fn'; END IF;
    v_def := pg_get_functiondef((s ->> 'fn')::regprocedure);
    IF md5(v_def) <> s ->> 'pre' THEN
      RAISE EXCEPTION 'Precondition failed: % drifted from the reviewed live body (md5 %…). Nothing changed.', s ->> 'fn', left(s ->> 'pre', 8);
    END IF;
    FOR w IN SELECT * FROM jsonb_array_elements(s -> 'swaps') LOOP
      IF (length(v_def) - length(replace(v_def, w ->> 0, ''))) / length(w ->> 0) <> (w ->> 2)::int THEN
        RAISE EXCEPTION 'Precondition failed: a validity site in % does not occur exactly % time(s). Nothing changed.', s ->> 'fn', w ->> 2;
      END IF;
    END LOOP;
    v_pre := v_pre || jsonb_build_object(s ->> 'fn', v_def);
    v_meta := v_meta || jsonb_build_object(s ->> 'fn', (
      SELECT p.prorettype::regtype::text || '|' || pg_get_function_identity_arguments(p.oid) || '|' || l.lanname || '|' || p.provolatile::text || '|'
             || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|'
             || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), '') || '|' || p.proowner::regrole::text
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = (s ->> 'fn')::regprocedure));
  END LOOP;

  -- ---------------------------------------------------------------- snapshots
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT (e ->> 'fn')::regprocedure::oid FROM jsonb_array_elements(v_spec) e) AND p.oid <> 'public.update_cert(uuid,text,text)'::regprocedure;
  SELECT count(*) INTO v_nfn_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p');
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT string_agg(c.relname || '.' || t.tgname || '|' || t.tgfoid::regprocedure::text || '|' || t.tgenabled::text, E'\n' ORDER BY c.relname, t.tgname)
    INTO v_trg_before FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace;
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;
  SELECT md5(coalesce(string_agg(to_jsonb(c)::text, E'\n' ORDER BY c.id), '')) INTO v_certs_before FROM public.certs c;
  SELECT md5(coalesce(string_agg(to_jsonb(s2)::text, E'\n' ORDER BY s2.id), '')) INTO v_subs_before FROM public.cert_submissions s2;
  SELECT md5(coalesce(string_agg(to_jsonb(ct)::text, E'\n' ORDER BY ct.id), '')) INTO v_types_before FROM public.cert_types ct;
  SELECT jsonb_object_agg(c.relname, (SELECT jsonb_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                                                       || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum)
                                      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                     WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
    INTO v_cols_before FROM pg_class c WHERE c.oid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass);
  SELECT string_agg(conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid), E'\n' ORDER BY conrelid::regclass::text, conname)
    INTO v_cons_before FROM pg_constraint WHERE conrelid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass);
  SELECT string_agg(a::text, ',' ORDER BY a::text) INTO v_acl_ref FROM pg_proc p, unnest(p.proacl) a WHERE p.oid = 'public.dept_cert_readiness()'::regprocedure;
  SELECT string_agg(a::text, ',' ORDER BY a::text) INTO v_upd_acl FROM pg_proc p, unnest(p.proacl) a WHERE p.oid = 'public.update_cert(uuid,text,text)'::regprocedure;

  -- the five readers' outputs on the live data — every department's roster (expiration_rows), every member's probation items,
  -- each department's readiness + rollup as its Department Admin, the radar as a Project Admin
  v_claims := current_setting('request.jwt.claims', true);
  v_reads_before := (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.departments d CROSS JOIN LATERAL public.expiration_rows(d.id, NULL) x)
    || (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.members m CROSS JOIN LATERAL public.probation_item_states(m.id, m.department_id) x);
  FOR r IN SELECT DISTINCT ON (m.department_id) lower(m.email) AS email FROM public.members m
            WHERE m.access && array['Department Admin']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
              AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.department_id, m.id LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', r.email)::text, true);
    v_reads_before := v_reads_before || (SELECT md5(coalesce(string_agg(x::text, ','), '')) FROM public.dept_cert_readiness() x)
                                     || (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.my_department_rollup() x);
  END LOOP;
  FOR r IN SELECT lower(m.email) AS email FROM public.members m WHERE m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
            AND m.email IS NOT NULL ORDER BY m.id LIMIT 1 LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', r.email)::text, true);
    v_reads_before := v_reads_before || (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.pa_department_radar() x);
  END LOOP;
  PERFORM set_config('request.jwt.claims', coalesce(v_claims, ''), true);

  -- ---------------------------------------------------------------- the change
  -- 1 columns + the two rules
  ALTER TABLE public.certs ADD COLUMN achieved_on text, ADD COLUMN no_expiry boolean NOT NULL DEFAULT false;
  ALTER TABLE public.certs ADD CONSTRAINT certs_achieved_on_valid CHECK (achieved_on IS NULL OR public.valid_exp_ym(achieved_on));
  ALTER TABLE public.certs ADD CONSTRAINT certs_no_expiry_clears_exp CHECK (NOT no_expiry OR exp IS NULL);
  ALTER TABLE public.cert_submissions ADD COLUMN achieved_on text, ADD COLUMN no_expiry boolean NOT NULL DEFAULT false;

  -- 2 the effective never-expires rule
  CREATE FUNCTION public.cert_never_expires(p_no_expiry boolean, p_cert_type_id uuid, p_department_id uuid)
   RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public'
  AS $fn$
  -- B4C:cert dates — does this cert never expire? Its own "doesn't expire" flag OR its catalog type (same department) never
  -- expires. The SQL twin of the client's enrichCerts neverExpires. NULLs -> false.
    select coalesce(p_no_expiry, false)
        or coalesce((select t.never_expires from public.cert_types t where t.id = p_cert_type_id and t.department_id = p_department_id), false)
  $fn$;
  REVOKE ALL ON FUNCTION public.cert_never_expires(boolean, uuid, uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.cert_never_expires(boolean, uuid, uuid) TO authenticated, service_role;

  -- 3 the five readers + approve: each from its live body with its swaps
  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    v_new := v_pre ->> (s ->> 'fn');
    FOR w IN SELECT * FROM jsonb_array_elements(s -> 'swaps') LOOP v_new := replace(v_new, w ->> 0, w ->> 1); END LOOP;
    EXECUTE v_new;   -- CREATE OR REPLACE from the live body: grants, definer, search_path kept
  END LOOP;

  -- 4 update_cert: the new signature (two optional args) — DROP + CREATE, grants re-applied
  DROP FUNCTION public.update_cert(uuid, text, text);
  CREATE FUNCTION public.update_cert(cert_id uuid, new_name text, new_exp text, new_no_expiry boolean DEFAULT NULL, new_achieved_on text DEFAULT NULL)
   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
  AS $fn$
  -- B4C:cert dates — edit a cert. new_no_expiry / new_achieved_on are optional: NULL leaves them as they are, so the 3-arg call
  -- (update_cert(cert_id, new_name, new_exp)) behaves exactly as before. "Doesn't expire" clears the expiry; a date means
  -- "expires". The achievement month must be a real month, not in the future, and not after the expiry.
  declare
    v_cur public.certs;
    v_exp text := case when new_exp is null or btrim(new_exp) = '' then null else new_exp end;
    v_no_expiry boolean;
    v_ach text;
  begin
    if not public.is_dept_admin() then
      raise exception 'Not authorized to edit certifications';
    end if;

    if new_name is null or btrim(new_name) = '' then
      raise exception 'Certification name is required';
    end if;

    -- exp must be null/empty (no expiration) or a real month
    if v_exp is not null and not public.valid_exp_ym(v_exp) then
      raise exception 'Expiration must be a real month as YYYY-MM (e.g. 2027-06).';
    end if;
    if new_achieved_on is not null and btrim(new_achieved_on) <> '' and not public.valid_exp_ym(new_achieved_on) then
      raise exception 'Achievement date must be a real month as YYYY-MM (e.g. 2024-03).';
    end if;

    select * into v_cur from public.certs where id = cert_id and department_id = public.my_department_id();
    if not found then
      raise exception 'Certification not found';
    end if;

    v_no_expiry := case when new_no_expiry is not null then new_no_expiry
                        when v_exp is not null then false            -- a date means "expires"
                        else v_cur.no_expiry end;
    if v_no_expiry then v_exp := null; end if;                       -- "doesn't expire" has no expiry date
    v_ach := case when new_achieved_on is null then v_cur.achieved_on
                  when btrim(new_achieved_on) = '' then null
                  else new_achieved_on end;
    if v_ach is not null and v_ach > to_char(now() at time zone 'America/Chicago', 'YYYY-MM') then
      raise exception 'Achievement date can''t be in the future.';
    end if;
    if v_ach is not null and v_exp is not null and v_ach > v_exp then
      raise exception 'Achievement date can''t be after the expiration.';
    end if;

    update public.certs
    set name        = btrim(new_name),
        exp         = v_exp,
        no_expiry   = v_no_expiry,
        achieved_on = v_ach
    where id = cert_id and department_id = public.my_department_id();
  end;
  $fn$;
  REVOKE ALL ON FUNCTION public.update_cert(uuid, text, text, boolean, text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.update_cert(uuid, text, text, boolean, text) TO authenticated, service_role;

  -- ---------------------------------------------------------------- post-conditions
  -- (1) the columns and constraints, exactly
  IF (SELECT jsonb_object_agg(c.relname, (SELECT jsonb_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                                                           || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') ORDER BY a.attnum)
                                          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
        FROM pg_class c WHERE c.oid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass))
     IS DISTINCT FROM jsonb_build_object(
       'certs', (v_cols_before -> 'certs') || '["achieved_on:text", "no_expiry:boolean NOT NULL DEFAULT false"]'::jsonb,
       'cert_submissions', (v_cols_before -> 'cert_submissions') || '["achieved_on:text", "no_expiry:boolean NOT NULL DEFAULT false"]'::jsonb) THEN
    RAISE EXCEPTION 'Post-condition failed: the certs / cert_submissions columns are not exactly the old ones + achieved_on text + no_expiry boolean NOT NULL DEFAULT false.';
  END IF;
  IF (SELECT string_agg(conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid), E'\n' ORDER BY conrelid::regclass::text, conname)
        FROM pg_constraint WHERE conrelid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass))
     IS DISTINCT FROM (SELECT string_agg(x, E'\n' ORDER BY x) FROM (
        SELECT unnest(string_to_array(v_cons_before, E'\n')) AS x
        UNION ALL SELECT 'certs certs_achieved_on_valid CHECK (((achieved_on IS NULL) OR valid_exp_ym(achieved_on)))'
        UNION ALL SELECT 'certs certs_no_expiry_clears_exp CHECK (((NOT no_expiry) OR (exp IS NULL)))') y) THEN
    RAISE EXCEPTION 'Post-condition failed: the certs / cert_submissions constraints are not exactly the old ones + the two CHECKs.';
  END IF;
  -- (2) the helper: shape, grants, the rule
  IF (SELECT p.prorettype = 'boolean'::regtype AND l.lanname = 'sql' AND p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig = array['search_path=public']
        FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.cert_never_expires(boolean,uuid,uuid)'::regprocedure) IS NOT TRUE
     OR (SELECT string_agg(a::text, ',' ORDER BY a::text) FROM pg_proc p, unnest(p.proacl) a WHERE p.oid = 'public.cert_never_expires(boolean,uuid,uuid)'::regprocedure) IS DISTINCT FROM v_acl_ref
     OR has_function_privilege('anon', 'public.cert_never_expires(boolean,uuid,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: cert_never_expires() shape (sql / STABLE / invoker / search_path public) or grants (authenticated + service_role, no anon).';
  END IF;
  IF public.cert_never_expires(true, NULL, NULL) IS NOT TRUE OR public.cert_never_expires(false, NULL, NULL) IS NOT FALSE
     OR public.cert_never_expires(NULL, NULL, NULL) IS NOT FALSE OR public.cert_never_expires(false, gen_random_uuid(), gen_random_uuid()) IS NOT FALSE THEN
    RAISE EXCEPTION 'Post-condition failed: cert_never_expires() does not follow the rule (flag OR same-department type; NULL -> false).';
  END IF;
  -- [md5-pin] (the dry-run harness strips this block once, to read the reviewed md5s it then writes in)
  IF md5(pg_get_functiondef('public.cert_never_expires(boolean,uuid,uuid)'::regprocedure)) <> HELPER_MD5 THEN
    RAISE EXCEPTION 'Post-condition failed: cert_never_expires() does not match its reviewed md5.';
  END IF;
  IF md5(pg_get_functiondef('public.update_cert(uuid,text,text,boolean,text)'::regprocedure)) <> UPDATE_MD5 THEN
    RAISE EXCEPTION 'Post-condition failed: update_cert() does not match its reviewed md5.';
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    IF md5(pg_get_functiondef((s ->> 'fn')::regprocedure)) <> s ->> 'post' THEN
      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', s ->> 'fn';
    END IF;
  END LOOP;
  -- [/md5-pin]
  -- (3) the six: EXACTLY the live pre-image with its swaps; identity / grants / definer / search_path kept. update_cert: the old
  --     signature gone, the new one definer + search_path public + the old grants
  FOR s IN SELECT * FROM jsonb_array_elements(v_spec) LOOP
    v_new := v_pre ->> (s ->> 'fn');
    FOR w IN SELECT * FROM jsonb_array_elements(s -> 'swaps') LOOP v_new := replace(v_new, w ->> 0, w ->> 1); END LOOP;
    IF pg_get_functiondef((s ->> 'fn')::regprocedure) IS DISTINCT FROM v_new THEN
      RAISE EXCEPTION 'Post-condition failed: % is not exactly its live body with its swaps.', s ->> 'fn';
    END IF;
    IF (SELECT p.prorettype::regtype::text || '|' || pg_get_function_identity_arguments(p.oid) || '|' || l.lanname || '|' || p.provolatile::text || '|'
               || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|'
               || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), '') || '|' || p.proowner::regrole::text
          FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = (s ->> 'fn')::regprocedure) IS DISTINCT FROM v_meta ->> (s ->> 'fn') THEN
      RAISE EXCEPTION 'Post-condition failed: %''s return type / arguments / language / volatility / definer / search_path / grants / owner changed.', s ->> 'fn';
    END IF;
  END LOOP;
  IF to_regprocedure('public.update_cert(uuid,text,text)') IS NOT NULL
     OR (SELECT p.prosecdef AND p.proconfig = array['search_path=public'] AND p.prorettype = 'void'::regtype
           AND (SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a) IS NOT DISTINCT FROM v_upd_acl
           FROM pg_proc p WHERE p.oid = 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure) IS NOT TRUE
     OR has_function_privilege('anon', 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: update_cert — the old 3-arg signature remains, or the new one is not definer / search_path public / the old grants (authenticated + service_role, no anon).';
  END IF;
  -- (4) nothing else moved
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
     AND p.oid NOT IN (SELECT (e ->> 'fn')::regprocedure::oid FROM jsonb_array_elements(v_spec) e)
     AND p.oid NOT IN ('public.update_cert(uuid,text,text,boolean,text)'::regprocedure, 'public.cert_never_expires(boolean,uuid,uuid)'::regprocedure);
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: another function (or its grants) changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')) <> v_nfn_before + 1 THEN
    RAISE EXCEPTION 'Post-condition failed: the function count is not exactly +1 (cert_never_expires; update_cert replaced 1-for-1).';
  END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed.'; END IF;
  SELECT string_agg(c.relname || '.' || t.tgname || '|' || t.tgfoid::regprocedure::text || '|' || t.tgenabled::text, E'\n' ORDER BY c.relname, t.tgname)
    INTO v_trg_after FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace;
  IF v_trg_after IS DISTINCT FROM v_trg_before THEN RAISE EXCEPTION 'Post-condition failed: a trigger changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: total_policies changed.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
  -- (5) every existing row unchanged (the new columns at their defaults), and the five readers read the live data identically
  IF (SELECT md5(coalesce(string_agg((to_jsonb(c) - 'achieved_on' - 'no_expiry')::text, E'\n' ORDER BY c.id), '')) FROM public.certs c) IS DISTINCT FROM v_certs_before
     OR EXISTS (SELECT 1 FROM public.certs WHERE no_expiry OR achieved_on IS NOT NULL)
     OR (SELECT md5(coalesce(string_agg((to_jsonb(s2) - 'achieved_on' - 'no_expiry')::text, E'\n' ORDER BY s2.id), '')) FROM public.cert_submissions s2) IS DISTINCT FROM v_subs_before
     OR EXISTS (SELECT 1 FROM public.cert_submissions WHERE no_expiry OR achieved_on IS NOT NULL)
     OR (SELECT md5(coalesce(string_agg(to_jsonb(ct)::text, E'\n' ORDER BY ct.id), '')) FROM public.cert_types ct) IS DISTINCT FROM v_types_before THEN
    RAISE EXCEPTION 'Post-condition failed: an existing certs / cert_submissions / cert_types row changed (or a new column is not at its default).';
  END IF;
  v_reads_after := (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.departments d CROSS JOIN LATERAL public.expiration_rows(d.id, NULL) x)
    || (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.members m CROSS JOIN LATERAL public.probation_item_states(m.id, m.department_id) x);
  FOR r IN SELECT DISTINCT ON (m.department_id) lower(m.email) AS email FROM public.members m
            WHERE m.access && array['Department Admin']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
              AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.department_id, m.id LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', r.email)::text, true);
    v_reads_after := v_reads_after || (SELECT md5(coalesce(string_agg(x::text, ','), '')) FROM public.dept_cert_readiness() x)
                                   || (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.my_department_rollup() x);
  END LOOP;
  FOR r IN SELECT lower(m.email) AS email FROM public.members m WHERE m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
            AND m.email IS NOT NULL ORDER BY m.id LIMIT 1 LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('email', r.email)::text, true);
    v_reads_after := v_reads_after || (SELECT md5(coalesce(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM public.pa_department_radar() x);
  END LOOP;
  PERFORM set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  IF v_reads_after IS DISTINCT FROM v_reads_before THEN
    RAISE EXCEPTION 'Post-condition failed: a reader''s output on the live data changed (expected none: 0 no_expiry certs, 0 cert types).';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: columns_ok true · checks_ok true · helper_ok true · update_cert_args 5 · update_cert_old_gone true ·
--   grants_ok true · no_expiry_sites (readiness 1 · expiration_rows 1 · probation 1 · radar 2 · rollup 5) · existing_defaults 0 ·
--   certs_total 179 · total_policies 173 · locked_token_fns 17)
SELECT
  (SELECT count(*) = 4 FROM pg_attribute WHERE attrelid IN ('public.certs'::regclass, 'public.cert_submissions'::regclass)
     AND attname IN ('achieved_on', 'no_expiry') AND NOT attisdropped) AS columns_ok,
  (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.certs'::regclass AND conname IN ('certs_achieved_on_valid', 'certs_no_expiry_clears_exp')) AS checks_ok,
  public.cert_never_expires(true, NULL, NULL) AND NOT public.cert_never_expires(false, NULL, NULL) AS helper_ok,
  (SELECT pronargs FROM pg_proc WHERE oid = 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure) AS update_cert_args,
  to_regprocedure('public.update_cert(uuid,text,text)') IS NULL AS update_cert_old_gone,
  has_function_privilege('authenticated', 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.update_cert(uuid,text,text,boolean,text)'::regprocedure, 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.cert_never_expires(boolean,uuid,uuid)'::regprocedure, 'EXECUTE') AS grants_ok,
  (SELECT string_agg(f || ' ' || ((length(d) - length(replace(d, n, ''))) / length(n)), ' · ' ORDER BY f)
     FROM (SELECT f, pg_get_functiondef(('public.' || f)::regprocedure) d,
                  CASE WHEN f IN ('pa_department_radar()', 'my_department_rollup()') THEN 'public.cert_never_expires(c.no_expiry' ELSE 'c.no_expiry or coalesce(t.never_expires' END n
             FROM unnest(array['dept_cert_readiness()', 'expiration_rows(uuid,uuid)', 'probation_item_states(uuid,uuid)', 'pa_department_radar()', 'my_department_rollup()']) f) x) AS no_expiry_sites,
  left(md5(pg_get_functiondef('public.update_cert(uuid,text,text,boolean,text)'::regprocedure)), 8) AS update_cert_md5,
  left(md5(pg_get_functiondef('public.cert_never_expires(boolean,uuid,uuid)'::regprocedure)), 8) AS helper_md5,
  (SELECT count(*) FROM public.certs WHERE no_expiry OR achieved_on IS NOT NULL) AS existing_defaults,
  (SELECT count(*) FROM public.certs) AS certs_total,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
