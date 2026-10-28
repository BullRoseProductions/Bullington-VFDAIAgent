// node docs/review/ws5_build.mjs
// GENERATES the WS-5 SQL + the change list from the LIVE capture (docs/review/ws5_LIVEDEFS.json, read 2026-10-28):
//   sql/ws5_public_rls_DRAFT.sql      revoke anon (56 relations + 1 sequence) · 19 {public} policies → authenticated · defaults
//   sql/ws5_public_rls_RETEST.sql     rolled-back SENTINEL, every department
//   sql/ws5_storage_policy_DRAFT.sql  S-1: the one {public} storage policy → authenticated (its own apply path)
//   sql/ws5_storage_policy_RETEST.sql
//   sql/ws5_public_rls_ROLLBACK.sql   + sql/ws5_storage_policy_ROLLBACK.sql — insurance, from the same capture
//   docs/review/ws5_CHANGE_LIST.md    every relation, grant and policy that changes
// Rulings: claude/B4C_WS5_RLS_Step0.md (F-1, F-2, F-3, S-1 all yes).
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const L = JSON.parse(readFileSync(join(root, "docs/review/ws5_LIVEDEFS.json"), "utf8"));
const SEQ = "training_session_audit_seq_seq";
const noMaintain = (s) => s.split(",").filter((p) => p !== "MAINTAIN").join(",");
const ANON = Object.fromEntries(Object.entries(L.anon_acl).map(([k, v]) => [k, noMaintain(v)]));   // PG17's MAINTAIN compared out (PGlite lacks it); REVOKE ALL removes it anyway
const RELS = Object.keys(ANON).filter((k) => k !== SEQ).sort();
const POL = L.public_policies;
const q = (s) => s.replace(/'/g, "''");
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
if (RELS.length !== 56 || POL.length !== 19 || !ANON[SEQ]) throw new Error(`capture drifted from the Step 0: ${RELS.length} relations, ${POL.length} policies, seq ${!!ANON[SEQ]}`);
if (Object.keys(L.owners).join() !== "postgres") throw new Error("a public object is not owned by postgres");

const anonMapSql = `
    SELECT coalesce(jsonb_object_agg(x.rel, x.privs), '{}'::jsonb) FROM (
      SELECT c.relname AS rel, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS privs
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 'anon'::regrole
         AND a.privilege_type <> 'MAINTAIN'
       GROUP BY c.relname) x`;
const matrixSql = (role) => `
    SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type))
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = '${role}'::regrole`;
const polMd5 = (role) => `md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))`;
const pinPol = POL.map((p) => `      ('${q(p.tbl)}', '${q(p.name)}', '${p.md5}', '${p.pred_md5}')`).join(",\n");
const personaSql = (who) => who === "DA"
  ? `SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1`
  : `SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status = 'Active' AND NOT (coalesce(m.access, '{}') && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[])
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1`;
// Row counts of every relation AS a real Department Admin and a real member, per department → one jsonb.
const countsBlock = (into) => `
    ${into} := '{}'::jsonb;
    FOR d IN SELECT id FROM public.departments ORDER BY id LOOP
      FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
        IF v_who = 'DA' THEN ${personaSql("DA")} INTO v_email; ELSE ${personaSql("member")} INTO v_email; END IF;
        IF v_email IS NULL THEN ${into} := ${into} || jsonb_build_object(d::text || '|' || v_who, 'no such member'); CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        FOREACH v_rel IN ARRAY c_rels LOOP
          BEGIN EXECUTE format('SELECT count(*)::text FROM public.%I', v_rel) INTO v_val;
          EXCEPTION WHEN OTHERS THEN v_val := 'E:' || SQLSTATE; END;
          ${into} := ${into} || jsonb_build_object(d::text || '|' || v_who || '|' || v_rel, v_val);
        END LOOP;
        EXECUTE 'RESET ROLE';
      END LOOP;
    END LOOP;
    PERFORM set_config('request.jwt.claims', '', true);`;
const relArray = `ARRAY[${RELS.map((r) => `'${r}'`).join(", ")}]`;

const mig = `-- =====================================================================
-- WS-5 (part 1 of 2) — RLS first-layer normalization, public schema. DRAFT for gate review — NOT APPLIED.
-- GENERATED by docs/review/ws5_build.mjs from the live capture (docs/review/ws5_LIVEDEFS.json, 2026-10-28). The exact
-- change list: docs/review/ws5_CHANGE_LIST.md. Rulings: claude/B4C_WS5_RLS_Step0.md (F-1/F-2/F-3/S-1 yes).
--
-- WHAT IT DOES — FOUR THINGS:
--   1. REVOKE ALL FROM anon on the 56 public relations anon holds privileges on, and on ${SEQ}. Today every one of
--      those reads returns nothing to anon (RLS on with no policy reaching anon, or a policy anon can't evaluate).
--   2. The 19 policies with roles {public} → TO authenticated, by ALTER POLICY … TO — which changes ONLY the roles; the
--      USING / WITH CHECK expressions are not re-entered, so they cannot change (proven below, byte for byte).
--   3. Forward-fix (F-3): ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE … FROM anon on TABLES,
--      SEQUENCES, FUNCTIONS; and ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC.
--      The PUBLIC one is GLOBAL by necessity — Postgres only lets a per-schema default REVOKE undo a per-schema GRANT, and
--      PUBLIC's EXECUTE is the built-in global default. Forward-only: no existing function's grants are touched. New
--      functions postgres creates (any schema) start with EXECUTE for their owner + the per-schema grantees
--      (authenticated, service_role in public), not PUBLIC.
--   4. Nothing else: no table, column, function body, predicate, or authenticated / service_role grant changes.
--
-- PREFLIGHT refuses on drift: the exact anon grant set (56 relations + the sequence, privilege by privilege, MAINTAIN
-- compared out — PG17-only, removed by REVOKE ALL regardless), each of the 19 policies by md5 of its full definition,
-- authenticated's and service_role's privilege matrices by md5, every public object owned by postgres; refuses if applied.
-- IN-TRANSACTION PROOF (any miss rolls everything back):
--   · ROW COUNTS: every one of the 56 relations, read AS a real Department Admin and a real member of EVERY department
--     (authenticated, their JWT claim), BEFORE and AFTER — byte-identical (errors included). This is the property.
--   · the 19 policies now roles {authenticated}, their USING / WITH CHECK md5 identical to the pins; no {public} policy left
--   · anon holds NO ACL entry on any public relation or sequence; anon is refused on all 56 (42501)
--   · authenticated's and service_role's privilege matrices identical; policy count 181, function count 228
--   · the default ACLs: postgres/public grant anon nothing; postgres's global function default has no PUBLIC entry
--   · verified untouched
-- Dry run: docs/review/ws5_DRYRUN.txt. RETEST (separately, after): sql/ws5_public_rls_RETEST.sql.
-- =====================================================================
DO $migrate$
DECLARE
  c_rels constant text[] := ${relArray};
  c_anon constant jsonb := '${q(JSON.stringify(ANON))}';
  c_auth_md5 constant text := '${L.auth_matrix_md5}';
  c_svc_md5 constant text := '${L.service_matrix_md5}';
  d uuid; v_who text; v_email text; v_rel text; v_val text; v_n bigint; v_t text; r record;
  v_before jsonb; v_after jsonb; v_pol_before bigint; v_fn_before bigint; v_ver_before bigint; v_ver_after bigint;
BEGIN
  -- ---------------------------------------------------------------- 0. preflight
  EXECUTE $q$${anonMapSql}$q$ INTO v_before;
  IF v_before = '{}'::jsonb AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND roles = '{public}'::name[]) THEN
    RAISE EXCEPTION 'PREFLIGHT: anon holds nothing and no {public} policy is left — WS-5 looks applied. Refusing.';
  END IF;
  IF v_before IS DISTINCT FROM c_anon THEN
    RAISE EXCEPTION 'PREFLIGHT: the anon grant set drifted from the Step 0 capture. Re-read it before applying. Refusing.';
  END IF;
  FOR r IN SELECT * FROM (VALUES
${pinPol}) v(tbl, name, md5, pred) LOOP
    SELECT ${polMd5()} INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = r.name;
    IF v_t IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'PREFLIGHT: policy "%" on % drifted (or is gone). Refusing.', r.name, r.tbl; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND roles = '{public}'::name[]) <> 19 THEN
    RAISE EXCEPTION 'PREFLIGHT: expected exactly 19 {public} policies. Refusing.';
  END IF;
  EXECUTE $q$${matrixSql("authenticated")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_auth_md5 THEN RAISE EXCEPTION 'PREFLIGHT: authenticated''s privilege matrix drifted. Refusing.'; END IF;
  EXECUTE $q$${matrixSql("service_role")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_svc_md5 THEN RAISE EXCEPTION 'PREFLIGHT: service_role''s privilege matrix drifted. Refusing.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND pg_get_userbyid(c.relowner) <> 'postgres') THEN
    RAISE EXCEPTION 'PREFLIGHT: a public object is not owned by postgres — the default-privileges fix would not cover it. Refusing.';
  END IF;
  SELECT count(*) INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;

  -- the BEFORE row counts, as real members (see the header)
${countsBlock("v_before")}

  -- ---------------------------------------------------------------- 1. anon loses its grants (56 relations + the sequence)
${RELS.map((r) => `  REVOKE ALL ON TABLE public.${ident(r)} FROM anon;`).join("\n")}
  REVOKE ALL ON SEQUENCE public.${ident(SEQ)} FROM anon;

  -- ---------------------------------------------------------------- 2. the 19 {public} policies → authenticated (roles only)
${POL.map((p) => `  ALTER POLICY ${ident(p.name)} ON public.${ident(p.tbl)} TO authenticated;`).join("\n")}

  -- ---------------------------------------------------------------- 3. the forward-fix (F-3)
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

  -- ---------------------------------------------------------------- 4. post-conditions (in-transaction)
${countsBlock("v_after")}
  IF v_after IS DISTINCT FROM v_before THEN
    SELECT string_agg(k || ' ' || (v_before->>k) || '->' || coalesce(v_after->>k, '?'), '; ') INTO v_t
      FROM (SELECT k FROM jsonb_object_keys(v_before) k WHERE (v_before->>k) IS DISTINCT FROM (v_after->>k) LIMIT 5) z;
    RAISE EXCEPTION 'Post-condition failed: a real member''s or DA''s row counts changed: %. Rolling back.', v_t;
  END IF;
  FOR r IN SELECT * FROM (VALUES
${pinPol}) v(tbl, name, md5, pred) LOOP
    SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) || '|' || p.roles::text INTO v_t
      FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = r.name;
    IF v_t IS DISTINCT FROM r.pred || '|{authenticated}' THEN
      RAISE EXCEPTION 'Post-condition failed: policy "%" on % is not the same predicate TO authenticated (%). Rolling back.', r.name, r.tbl, v_t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND roles && '{public,anon}'::name[]) THEN
    RAISE EXCEPTION 'Post-condition failed: a {public} or {anon} policy is left in public. Rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee IN ('anon'::regrole::oid, 0::oid)) THEN
    RAISE EXCEPTION 'Post-condition failed: anon (or PUBLIC) still holds an ACL entry on a public relation. Rolling back.';
  END IF;
  -- anon is refused on every one of the 56
  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  v_n := 0;
  FOREACH v_rel IN ARRAY c_rels LOOP
    BEGIN EXECUTE format('SELECT count(*) FROM public.%I', v_rel); v_n := v_n + 1;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  EXECUTE 'RESET ROLE';
  IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: anon could still read % relations. Rolling back.', v_n; END IF;
  EXECUTE $q$${matrixSql("authenticated")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_auth_md5 THEN RAISE EXCEPTION 'Post-condition failed: authenticated''s privileges changed. Rolling back.'; END IF;
  EXECUTE $q$${matrixSql("service_role")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_svc_md5 THEN RAISE EXCEPTION 'Post-condition failed: service_role''s privileges changed. Rolling back.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
              WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND a.grantee = 'anon'::regrole)
     OR NOT EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f')
     OR EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                 WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f' AND a.grantee = 0) THEN
    RAISE EXCEPTION 'Post-condition failed: the default privileges are not as intended. Rolling back.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_pol_before
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f') <> v_fn_before THEN
    RAISE EXCEPTION 'Post-condition failed: the policy or function count changed. Rolling back.';
  END IF;
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed (% -> %). Rolling back.', v_ver_before, v_ver_after; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'anon_acl_entries',        (SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 'anon'::regrole),
  'anon_readable_relations', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm') AND has_table_privilege('anon', c.oid, 'SELECT')),
  'public_role_policies',    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND roles && '{public,anon}'::name[]),
  'flipped_to_authenticated', (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.roles = '{authenticated}'::name[] AND (p.tablename, p.policyname) IN (VALUES ${POL.map((p) => `('${q(p.tbl)}', '${q(p.name)}')`).join(", ")})),
  'auth_matrix_md5',         (${matrixSql("authenticated").trim()}),
  'default_acl_postgres',    (SELECT jsonb_object_agg(CASE WHEN d.defaclnamespace = 0 THEN '(global)' ELSE d.defaclnamespace::regnamespace::text END || ':' || d.defaclobjtype::text, d.defaclacl::text) FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)),
  'total_policies',          (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count',                (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence',       (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;
writeFileSync(join(root, "sql/ws5_public_rls_DRAFT.sql"), mig);

// ---------------------------------------------------------------- RETEST (public)
const ret = `-- =====================================================================
-- RETEST for ws5_public_rls (WS-5 part 1). READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Per department, the whole check lives in a sub-block ending in RAISE 'SENTINEL' (rolled back). NOTHING CHANGES.
-- Once:
--   O1 anon holds no ACL entry on any public relation / sequence; no {public} or {anon} policy is left in public
--   O2 the 19 policies are TO authenticated with their USING / WITH CHECK md5 identical to the pins
--   O3 authenticated's and service_role's privilege matrices = the pins; the default ACLs grant anon nothing; postgres's
--      global function default has no PUBLIC entry
-- Per department (a REAL Department Admin and a REAL member, as authenticated):
--   T1 every one of the 56 relations returns the SAME row count (errors included) as with the 19 policies temporarily
--      put back TO public inside the rolled-back block — the roles change moves nothing for a real member or DA
--   T2 anon is refused (42501) on all 56
--   T3 station_presence byte-identical; verified unchanged
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_ok boolean; v_t text; r record;
  c_rels constant text[] := ${relArray};
  d uuid; dn text; v_who text; v_email text; v_rel text; v_val text; v_n bigint; v_now jsonb; v_then jsonb;
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
                  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee IN ('anon'::regrole::oid, 0::oid))
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND roles && '{public,anon}'::name[]) THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 anon holds nothing on any public relation or sequence; no {public}/{anon} policy left' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 anon still holds a grant, or a {public}/{anon} policy is left' || chr(10); END IF;

  v_ok := true;
  FOR r IN SELECT * FROM (VALUES
${pinPol}) v(tbl, name, md5, pred) LOOP
    SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) || '|' || p.roles::text INTO v_t
      FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = r.name;
    IF v_t IS DISTINCT FROM r.pred || '|{authenticated}' THEN v_ok := false; END IF;
  END LOOP;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 the 19 policies: TO authenticated, predicates byte-identical to the pins' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 a flipped policy''s role or predicate is not as pinned' || chr(10); END IF;

  IF (${matrixSql("authenticated").trim()}) = '${L.auth_matrix_md5}' AND (${matrixSql("service_role").trim()}) = '${L.service_matrix_md5}'
     AND NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND a.grantee = 'anon'::regrole)
     AND EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f')
     AND NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f' AND a.grantee = 0) THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 authenticated / service_role privileges = the pins; defaults grant anon nothing; no PUBLIC function default' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 a privilege matrix or a default ACL is not as intended' || chr(10); END IF;

  FOR d, dn IN SELECT id, name FROM public.departments ORDER BY name LOOP
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      -- T1: counts now, then with the 19 policies put back TO public (rolled back with the block)
      v_now := '{}'::jsonb; v_then := '{}'::jsonb;
      FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
        IF v_who = 'DA' THEN ${personaSql("DA")} INTO v_email; ELSE ${personaSql("member")} INTO v_email; END IF;
        IF v_email IS NULL THEN rpt := rpt || format('   (no real %s in this department — skipped)%s', v_who, chr(10)); CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        FOREACH v_rel IN ARRAY c_rels LOOP
          BEGIN EXECUTE format('SELECT count(*)::text FROM public.%I', v_rel) INTO v_val; EXCEPTION WHEN OTHERS THEN v_val := 'E:' || SQLSTATE; END;
          v_now := v_now || jsonb_build_object(v_who || '|' || v_rel, v_val);
        END LOOP;
        EXECUTE 'RESET ROLE';
      END LOOP;
${POL.map((p) => `      ALTER POLICY ${ident(p.name)} ON public.${ident(p.tbl)} TO public;`).join("\n")}
      FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
        IF v_who = 'DA' THEN ${personaSql("DA")} INTO v_email; ELSE ${personaSql("member")} INTO v_email; END IF;
        IF v_email IS NULL THEN CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        FOREACH v_rel IN ARRAY c_rels LOOP
          BEGIN EXECUTE format('SELECT count(*)::text FROM public.%I', v_rel) INTO v_val; EXCEPTION WHEN OTHERS THEN v_val := 'E:' || SQLSTATE; END;
          v_then := v_then || jsonb_build_object(v_who || '|' || v_rel, v_val);
        END LOOP;
        EXECUTE 'RESET ROLE';
      END LOOP;
      SELECT count(*) INTO v_n FROM jsonb_object_keys(v_now) k WHERE (v_now->>k) <> '0' AND (v_now->>k) NOT LIKE 'E:%';
      IF v_now = v_then AND v_now <> '{}'::jsonb THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 %s relation reads as a real DA + member: identical with the policies TO authenticated or TO public (%s non-empty)%s', (SELECT count(*) FROM jsonb_object_keys(v_now)), v_n, chr(10));
      ELSIF v_now = '{}'::jsonb THEN v_skip := v_skip + 1; rpt := rpt || '   SKIP  T1 no real DA or member to read as' || chr(10);
      ELSE v_fail := v_fail + 1;
        SELECT string_agg(k || ' ' || (v_then->>k) || '->' || (v_now->>k), '; ') INTO v_t FROM (SELECT k FROM jsonb_object_keys(v_now) k WHERE (v_now->>k) IS DISTINCT FROM (v_then->>k) LIMIT 4) z;
        rpt := rpt || format('   FAIL  T1 reads differ: %s%s', v_t, chr(10)); END IF;
      -- T2: anon refused on all 56
      PERFORM set_config('request.jwt.claims', '', true);
      EXECUTE 'SET LOCAL ROLE anon';
      v_n := 0;
      FOREACH v_rel IN ARRAY c_rels LOOP
        BEGIN EXECUTE format('SELECT count(*) FROM public.%I', v_rel); v_n := v_n + 1; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      END LOOP;
      EXECUTE 'RESET ROLE';
      IF v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T2 anon refused on all 56 relations' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 anon could read %s relations%s', v_n, chr(10)); END IF;
      -- T3
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 station_presence byte-identical; verified %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  T3 station_presence / verified changed' || chr(10); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
`;
writeFileSync(join(root, "sql/ws5_public_rls_RETEST.sql"), ret);

// ---------------------------------------------------------------- S-1: the storage policy (part 2 of 2)
const S = L.storage_policy;
const stoMd5 = `md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))`;
const sto = `-- =====================================================================
-- WS-5 (part 2 of 2) — S-1: the one {public} STORAGE policy → TO authenticated. DRAFT — NOT APPLIED. GENERATED.
-- storage.objects is owned by ${S.table_owner}. Memory (storage-policies-via-sql-editor): the SQL editor's postgres CAN
-- alter storage.objects policies here (WS-3 did, 2026-10-27). If it is refused ("must be owner"), change NOTHING and
-- apply the same single change in the Supabase dashboard (Storage → Policies → "${S.name}" → roles: authenticated).
-- ALTER POLICY … TO changes only the roles; the WITH CHECK is not re-entered. Nothing else in storage changes — the other
-- storage policies are proven byte-identical in the same transaction.
-- =====================================================================
DO $migrate$
DECLARE v_t text; v_others_before text; v_others_after text; v_n bigint;
BEGIN
  SELECT ${stoMd5} INTO v_t FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = '${q(S.name)}';
  IF v_t IS NULL THEN RAISE EXCEPTION 'PREFLIGHT: storage policy "${q(S.name)}" not found. Refusing.'; END IF;
  IF (SELECT roles::text FROM pg_policies WHERE schemaname = 'storage' AND policyname = '${q(S.name)}') = '{authenticated}' THEN
    RAISE EXCEPTION 'PREFLIGHT: already TO authenticated — S-1 looks applied. Refusing.';
  END IF;
  IF v_t IS DISTINCT FROM '${S.md5}' THEN RAISE EXCEPTION 'PREFLIGHT: storage policy "${q(S.name)}" drifted. Refusing.'; END IF;
  SELECT md5(string_agg(${stoMd5}, ',' ORDER BY p.policyname)) INTO v_others_before FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> '${q(S.name)}';
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'storage';

  ALTER POLICY ${ident(S.name)} ON storage.objects TO authenticated;

  IF (SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) || '|' || p.roles::text FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname = '${q(S.name)}')
     IS DISTINCT FROM md5(coalesce(${S.qual === null ? "NULL::text" : `'${q(S.qual)}'`}, '') || '|' || coalesce(${S.with_check === null ? "NULL::text" : `'${q(S.with_check)}'`}, '')) || '|{authenticated}' THEN
    RAISE EXCEPTION 'Post-condition failed: the storage policy is not the same predicate TO authenticated. Rolling back.';
  END IF;
  SELECT md5(string_agg(${stoMd5}, ',' ORDER BY p.policyname)) INTO v_others_after FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> '${q(S.name)}';
  IF v_others_after IS DISTINCT FROM v_others_before OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') <> v_n THEN
    RAISE EXCEPTION 'Post-condition failed: another storage policy changed. Rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND roles && '{public,anon}'::name[]) THEN
    RAISE EXCEPTION 'Post-condition failed: a {public}/{anon} storage policy is left. Rolling back.';
  END IF;
END
$migrate$;

SELECT jsonb_build_object(
  'policy', (SELECT p.policyname || ' ' || p.cmd || ' ' || p.roles::text FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname = '${q(S.name)}'),
  'storage_public_or_anon_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND roles && '{public,anon}'::name[]),
  'storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage')
) AS state;
`;
writeFileSync(join(root, "sql/ws5_storage_policy_DRAFT.sql"), sto);
const S_PRED = createHash("md5").update((S.qual || "") + "|" + (S.with_check || "")).digest("hex");
const stoRet = `-- =====================================================================
-- RETEST for ws5_storage_policy (WS-5 part 2, S-1). READ-ONLY — catalog checks inside a block ending in RAISE (nothing
-- changes; no row is written to storage.objects — its triggers are the platform's). GENERATED with the migration.
--   S1 "${S.name}" is ${S.cmd} TO {authenticated}, its WITH CHECK md5 = the pin (${S_PRED.slice(0, 8)}…)
--   S2 no storage policy is TO {public} or {anon}
--   S3 storage still has ${L.counts.storage_policies} policies
-- The behavioral proof is the smoke pass: a real DA uploads an equipment photo in a separate browser.
-- =====================================================================
DO $retest$
DECLARE rpt text := ''; v_pass int := 0; v_fail int := 0; v_t text;
BEGIN
  SELECT p.cmd || '|' || p.roles::text || '|' || md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_t
    FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = '${q(S.name)}';
  IF v_t = '${S.cmd}|{authenticated}|${S_PRED}' THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S1 the policy is TO authenticated, WITH CHECK identical to the pin' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S1 the policy is %s%s', coalesce(v_t, 'missing'), chr(10)); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND roles && '{public,anon}'::name[]) THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S2 no {public}/{anon} storage policy' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S2 a {public}/{anon} storage policy is left' || chr(10); END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') = ${L.counts.storage_policies} THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S3 storage policy count ${L.counts.storage_policies}' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S3 the storage policy count changed' || chr(10); END IF;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, 0 skipped', v_pass, v_fail);
END
$retest$;
`;
writeFileSync(join(root, "sql/ws5_storage_policy_RETEST.sql"), stoRet);

// ---------------------------------------------------------------- ROLLBACK (insurance; not expected to be needed)
const anonMapFull = anonMapSql.replace("\n         AND a.privilege_type <> 'MAINTAIN'", "");
if (anonMapFull === anonMapSql) throw new Error("anonMapFull: MAINTAIN filter not found");
const DEF = Object.fromEntries(["r", "S", "f"].map((t) => [t, L.default_acl.find((d) => d.role === "postgres" && d.ns === "public" && d.type === t).acl]));
if (L.default_acl.some((d) => d.role === "postgres" && d.ns === "(global)")) throw new Error("capture had a global postgres default — rollback would need it");
const aclSet = (expr) => `(SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(${expr}) x)`;
const rb = `-- =====================================================================
-- ROLLBACK for ws5_public_rls (WS-5 part 1). INSURANCE — NOT EXPECTED TO BE NEEDED. Run only on an explicit call.
-- GENERATED by docs/review/ws5_build.mjs from the SAME live capture (docs/review/ws5_LIVEDEFS.json, 2026-10-28). Puts back
-- exactly what part 1 took away, and nothing else:
--   · anon's grants on the 56 relations + ${SEQ}, privilege by privilege as captured (MAINTAIN granted on PG17)
--   · the 19 policies → TO public (roles only; predicates never re-entered)
--   · postgres's public-schema defaults for anon on TABLES / SEQUENCES / FUNCTIONS, and the global PUBLIC function EXECUTE
-- PREFLIGHT refuses unless the database is in the WS-5 applied state (anon holds nothing; the 19 TO authenticated with the
-- pinned predicates; the authenticated / service_role matrices = the pins).
-- IN-TRANSACTION PROOF: the real-DA / real-member row counts, every department, identical before and after; the anon map =
-- the capture; each of the 19 policies' FULL md5 = its original pin; the defaults set-equal to the capture with no global
-- postgres entry; matrices, policy and function counts, verified unchanged.
-- Part 2 (S-1) has its own: sql/ws5_storage_policy_ROLLBACK.sql — roll that back first if both are needed.
-- =====================================================================
DO $rollback$
DECLARE
  c_rels constant text[] := ${relArray};
  c_anon constant jsonb := '${q(JSON.stringify(ANON))}';
  c_anon_full constant jsonb := '${q(JSON.stringify(L.anon_acl))}';
  c_defaults constant jsonb := '${q(JSON.stringify(DEF))}';
  c_auth_md5 constant text := '${L.auth_matrix_md5}';
  c_svc_md5 constant text := '${L.service_matrix_md5}';
  v_pg17 constant boolean := current_setting('server_version_num')::int >= 170000;
  d uuid; v_who text; v_email text; v_rel text; v_val text; v_t text; r record;
  v_before jsonb; v_after jsonb; v_pol_before bigint; v_fn_before bigint; v_ver_before bigint; v_ver_after bigint;
BEGIN
  -- ---------------------------------------------------------------- 0. preflight: must be the applied state
  EXECUTE $q$${anonMapFull}$q$ INTO v_before;
  IF v_before IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'PREFLIGHT: anon already holds grants on public relations — not the WS-5 applied state (rolled back already?). Refusing.';
  END IF;
  FOR r IN SELECT * FROM (VALUES
${pinPol}) v(tbl, name, md5, pred) LOOP
    SELECT md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) || '|' || p.roles::text INTO v_t
      FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = r.name;
    IF v_t IS DISTINCT FROM r.pred || '|{authenticated}' THEN
      RAISE EXCEPTION 'PREFLIGHT: policy "%" on % is not the WS-5 applied state (%). Refusing.', r.name, r.tbl, coalesce(v_t, 'missing');
    END IF;
  END LOOP;
  EXECUTE $q$${matrixSql("authenticated")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_auth_md5 THEN RAISE EXCEPTION 'PREFLIGHT: authenticated''s privilege matrix drifted. Refusing.'; END IF;
  EXECUTE $q$${matrixSql("service_role")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_svc_md5 THEN RAISE EXCEPTION 'PREFLIGHT: service_role''s privilege matrix drifted. Refusing.'; END IF;
  SELECT count(*) INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
${countsBlock("v_before")}

  -- ---------------------------------------------------------------- 1. anon's grants back, as captured
${RELS.map((r) => `  GRANT ${ANON[r].split(",").join(", ")} ON TABLE public.${ident(r)} TO anon;`).join("\n")}
  GRANT ${ANON[SEQ].split(",").join(", ")} ON SEQUENCE public.${ident(SEQ)} TO anon;
  IF v_pg17 THEN
${RELS.filter((r) => L.anon_acl[r].split(",").includes("MAINTAIN")).map((r) => `    EXECUTE 'GRANT MAINTAIN ON TABLE public.${ident(r)} TO anon';`).join("\n")}
  END IF;

  -- ---------------------------------------------------------------- 2. the 19 policies → TO public (roles only)
${POL.map((p) => `  ALTER POLICY ${ident(p.name)} ON public.${ident(p.tbl)} TO public;`).join("\n")}

  -- ---------------------------------------------------------------- 3. the defaults, as captured
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

  -- ---------------------------------------------------------------- 4. post-conditions (in-transaction)
${countsBlock("v_after")}
  IF v_after IS DISTINCT FROM v_before THEN
    SELECT string_agg(k || ' ' || (v_before->>k) || '->' || coalesce(v_after->>k, '?'), '; ') INTO v_t
      FROM (SELECT k FROM jsonb_object_keys(v_before) k WHERE (v_before->>k) IS DISTINCT FROM (v_after->>k) LIMIT 5) z;
    RAISE EXCEPTION 'Post-condition failed: a real member''s or DA''s row counts changed: %. Rolling back.', v_t;
  END IF;
  IF v_pg17 THEN
    EXECUTE $q$${anonMapFull}$q$ INTO v_after;
    IF v_after IS DISTINCT FROM c_anon_full THEN RAISE EXCEPTION 'Post-condition failed: anon''s grants are not the captured set. Rolling back.'; END IF;
  ELSE
    EXECUTE $q$${anonMapSql}$q$ INTO v_after;
    IF v_after IS DISTINCT FROM c_anon THEN RAISE EXCEPTION 'Post-condition failed: anon''s grants are not the captured set. Rolling back.'; END IF;
  END IF;
  FOR r IN SELECT * FROM (VALUES
${pinPol}) v(tbl, name, md5, pred) LOOP
    SELECT ${polMd5()} INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = r.tbl AND p.policyname = r.name;
    IF v_t IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'Post-condition failed: policy "%" on % is not back to its original definition. Rolling back.', r.name, r.tbl; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND roles = '{public}'::name[]) <> 19 THEN
    RAISE EXCEPTION 'Post-condition failed: expected exactly 19 {public} policies. Rolling back.';
  END IF;
  EXECUTE $q$${matrixSql("authenticated")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_auth_md5 THEN RAISE EXCEPTION 'Post-condition failed: authenticated''s privileges changed. Rolling back.'; END IF;
  EXECUTE $q$${matrixSql("service_role")}$q$ INTO v_t;
  IF v_t IS DISTINCT FROM c_svc_md5 THEN RAISE EXCEPTION 'Post-condition failed: service_role''s privileges changed. Rolling back.'; END IF;
  FOR r IN SELECT k AS t, c_defaults->>k AS acl FROM jsonb_object_keys(c_defaults) k LOOP
    IF ${aclSet("(SELECT d.defaclacl FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype::text = r.t)")}
       IS DISTINCT FROM ${aclSet("r.acl::aclitem[]")} THEN
      RAISE EXCEPTION 'Post-condition failed: postgres''s public default for % is not the captured set. Rolling back.', r.t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 0) THEN
    RAISE EXCEPTION 'Post-condition failed: a global postgres default is left (the capture had none). Rolling back.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_pol_before
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f') <> v_fn_before THEN
    RAISE EXCEPTION 'Post-condition failed: the policy or function count changed. Rolling back.';
  END IF;
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed (% -> %). Rolling back.', v_ver_before, v_ver_after; END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';

SELECT jsonb_build_object(
  'anon_acl_entries',     (SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = 'anon'::regrole),
  'public_role_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND roles = '{public}'::name[]),
  'default_acl_postgres', (SELECT jsonb_object_agg(CASE WHEN d.defaclnamespace = 0 THEN '(global)' ELSE d.defaclnamespace::regnamespace::text END || ':' || d.defaclobjtype::text, d.defaclacl::text) FROM pg_default_acl d WHERE d.defaclrole = 'postgres'::regrole AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)),
  'total_policies',       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count',             (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence',    (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;
writeFileSync(join(root, "sql/ws5_public_rls_ROLLBACK.sql"), rb);
const stoRb = `-- =====================================================================
-- ROLLBACK for ws5_storage_policy (WS-5 part 2, S-1). INSURANCE — run only on an explicit call. GENERATED.
-- Puts "${S.name}" back TO public (roles only). Refuses unless it is TO authenticated with the pinned WITH CHECK.
-- Post: its full definition md5 = the original pin (${S.md5.slice(0, 8)}…); the other storage policies byte-identical.
-- Same apply path as part 2: SQL editor, or the dashboard (that policy → roles: public) if refused.
-- =====================================================================
DO $rollback$
DECLARE v_t text; v_others_before text; v_others_after text; v_n bigint;
BEGIN
  SELECT p.roles::text || '|' || md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) INTO v_t
    FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = '${q(S.name)}';
  IF v_t IS DISTINCT FROM '{authenticated}|${S_PRED}' THEN RAISE EXCEPTION 'PREFLIGHT: the storage policy is not the S-1 applied state (%). Refusing.', coalesce(v_t, 'missing'); END IF;
  SELECT md5(string_agg(${stoMd5}, ',' ORDER BY p.policyname)) INTO v_others_before FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> '${q(S.name)}';
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'storage';

  ALTER POLICY ${ident(S.name)} ON storage.objects TO public;

  SELECT ${stoMd5} INTO v_t FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = '${q(S.name)}';
  IF v_t IS DISTINCT FROM '${S.md5}' THEN RAISE EXCEPTION 'Post-condition failed: the storage policy is not back to its original definition. Rolling back.'; END IF;
  SELECT md5(string_agg(${stoMd5}, ',' ORDER BY p.policyname)) INTO v_others_after FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname <> '${q(S.name)}';
  IF v_others_after IS DISTINCT FROM v_others_before OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage') <> v_n THEN
    RAISE EXCEPTION 'Post-condition failed: another storage policy changed. Rolling back.';
  END IF;
END
$rollback$;

SELECT jsonb_build_object(
  'policy', (SELECT p.policyname || ' ' || p.cmd || ' ' || p.roles::text FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname = '${q(S.name)}'),
  'storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage')
) AS state;
`;
writeFileSync(join(root, "sql/ws5_storage_policy_ROLLBACK.sql"), stoRb);

// ---------------------------------------------------------------- the change list
const cl = [`# WS-5 — the exact change list (generated from the live capture, 2026-10-28)\n`,
  `## Part 1 · \`sql/ws5_public_rls_DRAFT.sql\`\n`,
  `### Anon loses every privilege on ${RELS.length} relations + 1 sequence (REVOKE ALL … FROM anon)\n`,
  `| relation | anon held (MAINTAIN also, on PG17) |`, `|---|---|`,
  ...RELS.map((r) => `| \`${r}\` | ${ANON[r]} |`), `| \`${SEQ}\` (sequence) | ${ANON[SEQ]} |`,
  `\n**${Object.values(L.anon_acl).reduce((n, v) => n + v.split(",").length, 0)} ACL privilege entries** in all (live, MAINTAIN included). authenticated's and service_role's privileges: **unchanged** (pinned md5 \`${L.auth_matrix_md5.slice(0, 8)}…\` / \`${L.service_matrix_md5.slice(0, 8)}…\`).\n`,
  `### The 19 {public} policies → TO authenticated (ALTER POLICY … TO — the predicate is not re-entered)\n`,
  `| table | policy | cmd | USING | WITH CHECK |`, `|---|---|---|---|---|`,
  ...POL.map((p) => `| \`${p.tbl}\` | ${p.name} | ${p.cmd} | \`${(p.qual || "").replace(/\|/g, "\\|")}\` | ${p.with_check ? "`" + p.with_check.replace(/\|/g, "\\|") + "`" : "—"} |`),
  `\n### Default privileges (F-3, forward-only)\n`,
  "- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon` — new tables stop granting anon",
  "- `… IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon`",
  "- `… IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon`",
  "- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — **global** (Postgres can't revoke PUBLIC's built-in default per schema); affects only functions postgres creates from now on, in any schema. Existing function grants are not touched.",
  "- Not changed: the `supabase_admin` defaults (the platform's), and postgres's defaults in the `storage` schema (out of scope; noted).",
  `\n## Part 2 · \`sql/ws5_storage_policy_DRAFT.sql\` (S-1)\n`,
  `| table | policy | cmd | roles | WITH CHECK |`, `|---|---|---|---|---|`,
  `| \`storage.objects\` | ${S.name} | ${S.cmd} | ${S.roles} → {authenticated} | \`${(S.with_check || S.qual || "").replace(/\|/g, "\\|")}\` |`,
  `\nstorage.objects is owned by \`${S.table_owner}\`; the SQL editor altered storage policies for WS-3. Fallback: the dashboard (same single change).\n`];
writeFileSync(join(root, "docs/review/ws5_CHANGE_LIST.md"), cl.join("\n"));
console.log(`wrote sql/ws5_public_rls_DRAFT.sql · _RETEST.sql · sql/ws5_storage_policy_DRAFT.sql · _RETEST.sql · both _ROLLBACK.sql · docs/review/ws5_CHANGE_LIST.md (${RELS.length} relations, ${POL.length} policies)`);
