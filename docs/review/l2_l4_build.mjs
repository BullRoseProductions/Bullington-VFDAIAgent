// node docs/review/l2_l4_build.mjs           — write the files
// node docs/review/l2_l4_build.mjs --check   — regenerate in memory; exit 1 unless every file on disk is byte-identical
// GENERATES the L-2 and L-4 SQL + the change list from the LIVE capture (docs/review/l2_l4_LIVEDEFS.json, read 2026-10-28
// with sql/l2_l4_CAPTURE.sql). No policy name, predicate, function body or pin is hand-typed: every one comes from the capture.
//   sql/l2_departments_scope_DRAFT.sql    + _RETEST.sql + _ROLLBACK.sql   (L-2: departments SELECT → own department)
//   sql/l4_role_helpers_scope_DRAFT.sql   + _RETEST.sql + _ROLLBACK.sql   (L-4: is_leadership / is_department_admin / is_announcer)
//   docs/review/l2_l4_CHANGE_LIST.md
// Rulings: claude/B4C_L2_L4_Step0.md (D-1 own department only · D-2 dept-scope in place · D-3 two migrations).
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const L = JSON.parse(readFileSync(join(root, "docs/review/l2_l4_LIVEDEFS.json"), "utf8"));
const q = (s) => s.replace(/'/g, "''");
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const out = {};

// ---------------------------------------------------------------- the capture must still say what the Step 0 said
const SEL = L.departments.policies.find((p) => p.cmd === "SELECT");
const UPD = L.departments.policies.find((p) => p.cmd === "UPDATE");
const must = (cond, why) => { if (!cond) throw new Error(`capture drifted from the Step 0: ${why}`); };
must(L.departments.policies.length === 2 && SEL && UPD, "departments should carry exactly one SELECT + one UPDATE policy");
must(SEL.qual === "true" && SEL.roles === "{authenticated}" && SEL.permissive === "PERMISSIVE", "the SELECT policy is no longer TO authenticated USING (true)");
must(L.departments.rls === true && L.departments.force === false && L.departments.owner === "postgres", "departments RLS / FORCE / owner changed");
must(L.counts.multi_dept_emails === 0, "someone now has member rows in more than one department");
must(L.matrices.exec.anon === null, "anon can EXECUTE a public function again");
const F = L.fns;
const body = (name) => { const m = /AS \$function\$([\s\S]*)\$function\$\s*$/.exec(F[name].def); must(m, `${name}: cannot find its body`); return m[1]; };
const header = (name) => F[name].def.slice(0, F[name].def.indexOf("AS $function$"));
for (const n of ["is_leadership", "is_department_admin", "is_announcer", "is_leader", "is_dept_admin"]) {
  must(F[n].secdef === true && F[n].volatile === "s" && F[n].config === "{search_path=public}" && F[n].args === "", `${n} is not STABLE SECURITY DEFINER search_path=public ()`);
  must(F[n].acl === "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", `${n}'s ACL changed`);
}
must(/members\.department_id = public\.my_department_id\(\)/.test(body("is_equipment_manager") + body("is_leader") + body("is_dept_admin"))
  && /em\.department_id = public\.my_department_id\(\)/.test(body("is_equipment_manager")), "is_equipment_manager / is_leader / is_dept_admin are no longer department-scoped");

// The scoped twins: is_leadership with a department check IS is_leader (same roles, same status filter); is_department_admin
// with one IS is_dept_admin. Prove that from the live text rather than assert it.
const roles = (n) => /array\[([^\]]*)\]/.exec(body(n))[1].split(",").map((s) => s.trim()).sort().join(",");
const status = (n) => /status in \(([^)]*)\)/.exec(body(n))[1];
must(roles("is_leadership") === roles("is_leader") && status("is_leadership") === status("is_leader"), "is_leadership and is_leader no longer differ only by the department check");
must(roles("is_department_admin") === roles("is_dept_admin") && status("is_department_admin") === status("is_dept_admin"), "is_department_admin and is_dept_admin no longer differ only by the department check");
const strip = (s) => s.replace(/\s+/g, " ").replace(/public\./g, "").replace(/array\[[^\]]*\]/, "ROLES").trim();
must(strip(body("is_leader")).replace(" and members.department_id = my_department_id()", "") === strip(body("is_leadership")), "is_leader is not is_leadership + the department line");
must(strip(body("is_dept_admin")).replace(" and members.department_id = my_department_id()", "") === strip(body("is_department_admin")), "is_dept_admin is not is_department_admin + the department line");

// ---------------------------------------------------------------- L-4: the three new bodies
const ANN_STATUS = "      and status in ('Active','Probationary')\n";
must(body("is_announcer").split(ANN_STATUS).length === 2, "is_announcer's status line is not where the generator expects it");
const NEW = {
  is_leadership: "\n  -- L-4: the department-scoped leadership gate. Same roles + status as before, now only in the caller's own department\n  -- (my_department_id()); that is exactly is_leader(), so it delegates — one definition, no drift. Callers unchanged.\n  select public.is_leader();\n",
  is_department_admin: "\n  -- L-4: the department-scoped admin gate (Department Admin or Project Admin, in the caller's own department). That is\n  -- exactly is_dept_admin(), so it delegates — one definition, no drift. Callers unchanged.\n  select public.is_dept_admin();\n",
  is_announcer: body("is_announcer").replace(ANN_STATUS, ANN_STATUS + "      and department_id = public.my_department_id()   -- L-4: the role counts only in the caller's own department\n"),
};
const H4 = ["is_leadership", "is_department_admin", "is_announcer"];
const newDef = (n) => `${header(n)}AS $function$${NEW[n]}$function$`;
// unchanged helpers the new bodies stand on (preflight pins them; a drift there would change what the delegation means)
const PIN_KEEP = ["is_leader", "is_dept_admin", "my_department_id", "my_member_id", "is_equipment_manager", "is_project_admin"];

// ---------------------------------------------------------------- shared SQL pieces
const RELS = L.rels;
const relArray = `ARRAY[${RELS.map((r) => `'${r}'`).join(", ")}]`;
const polMd5 = `md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))`;
const matrixSql = (role) => `(SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type))
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = '${role}'::regrole)`;
const execSql = (role) => `(SELECT md5(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text))
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND has_function_privilege('${role}', p.oid, 'EXECUTE'))`;
const fnMd5 = (name) => `(SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '${name}' AND p.prokind = 'f')`;
const fnRow = (name) => `(SELECT p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '${name}' AND p.prokind = 'f')`;
const FNROW = "true|s|{search_path=public}|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}";
const prosrc = (name) => `(SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '${name}' AND p.prokind = 'f')`;
// md5 of every public policy / every other public function, so "nothing else moved" is checked whole
const allPolMd5 = (except) => `(SELECT md5(string_agg(${polMd5}, ',' ORDER BY p.tablename, p.policyname)) FROM pg_policies p WHERE p.schemaname = 'public'${except ? ` AND NOT (p.tablename = 'departments' AND p.policyname = '${q(except)}')` : ""})`;
const allFnMd5 = (except) => `(SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'${except.length ? ` AND p.proname NOT IN (${except.map((n) => `'${n}'`).join(", ")})` : ""})`;
const personaSql = (who) => who === "DA"
  ? `SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary') AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1`
  : `SELECT lower(m.email) FROM public.members m WHERE m.department_id = d AND m.status = 'Active' AND NOT (coalesce(m.access, '{}') && array['Project Admin', 'Department Admin', 'Board Member', 'Officer']::text[])
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
          AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1`;
// Row counts of every relation authenticated may read, AS a real DA and a real member of every department → one jsonb.
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
const diffSql = (a, b) => `SELECT string_agg(k || ' ' || coalesce(${a}->>k, '?') || '->' || coalesce(${b}->>k, '?'), '; ') INTO v_t
      FROM (SELECT k FROM jsonb_object_keys(${a} || ${b}) k WHERE (${a}->>k) IS DISTINCT FROM (${b}->>k) LIMIT 5) z;`;
const declCommon = `c_rels constant text[] := ${relArray};
  d uuid; v_who text; v_email text; v_rel text; v_val text; v_t text; v_n bigint; r record;
  v_before jsonb; v_after jsonb; v_pol_n bigint; v_fn_n bigint; v_ver bigint;`;
const commonPre = (label) => `  IF ${matrixSql("authenticated")} IS DISTINCT FROM '${L.matrices.auth_tables}'
     OR ${matrixSql("service_role")} IS DISTINCT FROM '${L.matrices.service_tables}' THEN
    RAISE EXCEPTION 'PREFLIGHT (${label}): authenticated''s or service_role''s table privileges drifted from the capture. Refusing.';
  END IF;
  IF ${execSql("authenticated")} IS DISTINCT FROM '${L.matrices.exec.authenticated}'
     OR ${execSql("service_role")} IS DISTINCT FROM '${L.matrices.exec.service_role}'
     OR ${execSql("anon")} IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT (${label}): the function EXECUTE matrices drifted from the capture (or anon can execute a public function). Refusing.';
  END IF;
  IF (SELECT count(*) FROM public.members WHERE email IS NOT NULL) > 0
     AND EXISTS (SELECT 1 FROM public.members WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(DISTINCT department_id) > 1) THEN
    RAISE EXCEPTION 'PREFLIGHT (${label}): someone now has member rows in more than one department — the "no live behaviour change" premise no longer holds. Re-run the Step 0. Refusing.';
  END IF;
  SELECT count(*) INTO v_pol_n FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  SELECT count(*) INTO v_ver FROM public.station_presence WHERE verified;`;
const commonPost = `  IF ${matrixSql("authenticated")} IS DISTINCT FROM '${L.matrices.auth_tables}'
     OR ${matrixSql("service_role")} IS DISTINCT FROM '${L.matrices.service_tables}'
     OR ${execSql("authenticated")} IS DISTINCT FROM '${L.matrices.exec.authenticated}'
     OR ${execSql("service_role")} IS DISTINCT FROM '${L.matrices.exec.service_role}'
     OR ${execSql("anon")} IS NOT NULL THEN
    RAISE EXCEPTION 'Post-condition failed: a table privilege or EXECUTE matrix changed. Rolling back.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_pol_n
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f') <> v_fn_n THEN
    RAISE EXCEPTION 'Post-condition failed: the policy or function count changed. Rolling back.';
  END IF;
  IF (SELECT count(*) FROM public.station_presence WHERE verified) <> v_ver THEN
    RAISE EXCEPTION 'Post-condition failed: verified presence changed. Rolling back.';
  END IF;`;
const STRANGER = "l2-l4-stranger@invalid.test";

// ================================================================ L-2 MIGRATION
const NEWQUAL_SQL = "id = public.my_department_id()";
out["sql/l2_departments_scope_DRAFT.sql"] = `-- =====================================================================
-- SECURITY L-2 — departments reads scoped to the caller's own department. DRAFT for gate review — NOT APPLIED.
-- GENERATED by docs/review/l2_l4_build.mjs from the live capture (docs/review/l2_l4_LIVEDEFS.json, ${L.read_at}). Rulings:
-- claude/B4C_L2_L4_Step0.md (D-1 own department only). Change list: docs/review/l2_l4_CHANGE_LIST.md.
--
-- WHAT IT DOES — ONE THING:
--   ALTER POLICY "${SEL.name}" ON public.departments USING (${NEWQUAL_SQL});
--   Was USING (true): any signed-in user (a self-registered stranger included) read all ${L.counts.departments} rows — station coordinates,
--   geofence, disabled_modules, branding. Roles ({authenticated}), command (SELECT) and PERMISSIVE are not re-entered.
--   Not touched: the UPDATE policy, any grant, any function. anon already holds no grant here (WS-5).
--   Why nothing breaks (Step 0, live): every client read is the caller's own row; ${L.counts.departments}-row readers in SQL are SECURITY
--   DEFINER functions owned by postgres, the table owner — RLS does not apply to them (FORCE is off; checked below);
--   no view or other policy reads departments; nobody has member rows in two departments.
--
-- PREFLIGHT refuses on drift: both departments policies by md5 of their full definition; RLS on / FORCE off / owner
-- postgres; my_department_id() by md5; authenticated + service_role table matrices and the EXECUTE matrices by md5;
-- nobody in two departments; refuses if already applied.
-- IN-TRANSACTION PROOF (any miss → RAISE → everything rolls back):
--   · ROW COUNTS: all ${RELS.length} relations authenticated may read, AS a real Department Admin and a real member of EVERY
--     department, BEFORE and AFTER. Every relation byte-identical (errors included) EXCEPT departments, which must go
--     from all ${L.counts.departments} rows to exactly 1 — and that one row is the person's own department.
--   · a signed-in stranger (no member row): departments ${L.counts.departments} → 0
--   · the SELECT policy is now exactly USING (id = my_department_id()), still SELECT / PERMISSIVE / {authenticated};
--     the UPDATE policy byte-identical; every OTHER public policy and every public function byte-identical (md5 of all)
--   · matrices unchanged; policy count ${L.counts.policies}, function count ${L.counts.fns}; verified unchanged
-- Dry run: docs/review/l2_l4_DRYRUN.txt. RETEST (separately, after): sql/l2_departments_scope_RETEST.sql.
-- =====================================================================
DO $migrate$
DECLARE
  ${declCommon}
  v_other_pol text; v_other_fn text; v_n_dept bigint; v_own uuid;
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);   -- policy expressions deparse unqualified, as captured
  -- ---------------------------------------------------------------- 0. preflight
  IF (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'departments' AND policyname = '${q(SEL.name)}') = '(id = my_department_id())' THEN
    RAISE EXCEPTION 'PREFLIGHT: "${q(SEL.name)}" already reads USING (id = my_department_id()) — L-2 looks applied. Refusing.';
  END IF;
  FOR r IN SELECT * FROM (VALUES ('${q(SEL.name)}', '${SEL.md5}'), ('${q(UPD.name)}', '${UPD.md5}')) v(name, md5) LOOP
    SELECT ${polMd5} INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = r.name;
    IF v_t IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'PREFLIGHT: departments policy "%" drifted (or is gone). Refusing.', r.name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'departments') <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT: departments should carry exactly 2 policies. Refusing.';
  END IF;
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity AND pg_get_userbyid(relowner) = 'postgres' FROM pg_class WHERE oid = 'public.departments'::regclass) THEN
    RAISE EXCEPTION 'PREFLIGHT: departments must be RLS on, FORCE off, owned by postgres (so DEFINER readers bypass it). Refusing.';
  END IF;
  IF ${fnMd5("my_department_id")} IS DISTINCT FROM '${F.my_department_id.md5}' THEN
    RAISE EXCEPTION 'PREFLIGHT: my_department_id() drifted from the capture. Refusing.';
  END IF;
${commonPre("L-2")}
  v_other_pol := ${allPolMd5(SEL.name)};
  v_other_fn := ${allFnMd5([])};
  SELECT count(*) INTO v_n_dept FROM public.departments;

  -- the BEFORE row counts, as real people (see the header)
${countsBlock("v_before")}
  PERFORM set_config('request.jwt.claims', json_build_object('email', '${STRANGER}')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.departments;
  EXECUTE 'RESET ROLE';
  IF v_n <> v_n_dept THEN RAISE EXCEPTION 'PREFLIGHT: a signed-in stranger should read all % departments today, read %. Refusing.', v_n_dept, v_n; END IF;

  -- ---------------------------------------------------------------- 1. the change
  ALTER POLICY ${ident(SEL.name)} ON public.departments USING (${NEWQUAL_SQL});

  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)
${countsBlock("v_after")}
  FOR v_t IN SELECT k FROM jsonb_object_keys(v_before) k LOOP
    IF v_t LIKE '%|departments' THEN
      IF (v_before->>v_t) <> v_n_dept::text OR (v_after->>v_t) <> '1' THEN
        RAISE EXCEPTION 'Post-condition failed: % should read departments % -> 1, read % -> %. Rolling back.', v_t, v_n_dept, v_before->>v_t, v_after->>v_t;
      END IF;
    ELSIF (v_before->>v_t) IS DISTINCT FROM (v_after->>v_t) THEN
      RAISE EXCEPTION 'Post-condition failed: % changed % -> % (only departments may move). Rolling back.', v_t, v_before->>v_t, v_after->>v_t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_object_keys(v_after)) <> (SELECT count(*) FROM jsonb_object_keys(v_before)) THEN
    RAISE EXCEPTION 'Post-condition failed: the set of people read before and after differs. Rolling back.';
  END IF;
  -- the one row each real person still sees is their own department
  FOR d IN SELECT id FROM public.departments ORDER BY id LOOP
    FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
      IF v_who = 'DA' THEN ${personaSql("DA")} INTO v_email; ELSE ${personaSql("member")} INTO v_email; END IF;
      CONTINUE WHEN v_email IS NULL;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT id INTO v_own FROM public.departments;
      EXECUTE 'RESET ROLE';
      IF v_own IS DISTINCT FROM d THEN RAISE EXCEPTION 'Post-condition failed: a % of % sees department %, not their own. Rolling back.', v_who, d, v_own; END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('email', '${STRANGER}')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.departments;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: a signed-in stranger still reads % departments. Rolling back.', v_n; END IF;
  SELECT p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '') INTO v_t
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(SEL.name)}';
  IF v_t IS DISTINCT FROM 'SELECT|PERMISSIVE|{authenticated}|(id = my_department_id())|' THEN
    RAISE EXCEPTION 'Post-condition failed: the SELECT policy is not exactly SELECT / PERMISSIVE / authenticated / (id = my_department_id()): %. Rolling back.', v_t;
  END IF;
  SELECT ${polMd5} INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(UPD.name)}';
  IF v_t IS DISTINCT FROM '${UPD.md5}' THEN RAISE EXCEPTION 'Post-condition failed: the UPDATE policy changed. Rolling back.'; END IF;
  IF ${allPolMd5(SEL.name)} IS DISTINCT FROM v_other_pol THEN RAISE EXCEPTION 'Post-condition failed: another public policy changed. Rolling back.'; END IF;
  IF ${allFnMd5([])} IS DISTINCT FROM v_other_fn THEN RAISE EXCEPTION 'Post-condition failed: a public function changed. Rolling back.'; END IF;
${commonPost}
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'departments_select', (SELECT p.cmd || ' ' || p.roles::text || ' USING ' || p.qual FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(SEL.name)}'),
  'departments_update_md5', (SELECT ${polMd5} FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(UPD.name)}'),
  'total_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;

// ================================================================ L-2 RETEST
out["sql/l2_departments_scope_RETEST.sql"] = `-- =====================================================================
-- RETEST for l2_departments_scope. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Per department, the checks run inside a sub-block ending in RAISE 'SENTINEL' (rolled back). NOTHING CHANGES.
-- The final RAISE is the report — the "ERROR" IS the report.
-- Once:
--   O1 the SELECT policy is exactly SELECT / PERMISSIVE / {authenticated} / (id = my_department_id()); the UPDATE policy = its pin
--   O2 a signed-in stranger (no member row) reads 0 departments; anon is refused or reads 0
-- Per department (a REAL Department Admin and a REAL member, as authenticated):
--   T1 each reads exactly 1 departments row, and it is their own
--   T2 the brand / settings read the app makes (select … where id = my_department_id()) still returns their row
--   T3 the DA's no-op UPDATE of their own row touches 1 row; the member's touches 0 (the UPDATE policy, unchanged)
--   T4 the same person, the policy put back to USING (true) inside the rolled-back block, reads all departments again —
--      the policy (and only the policy) is what scopes the read
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_t text; v_n bigint; v_all bigint;
  d uuid; dn text; v_who text; v_email text; v_own uuid; v_ok boolean;
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  SELECT count(*) INTO v_all FROM public.departments;
  SELECT p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '') INTO v_t
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(SEL.name)}';
  IF v_t = 'SELECT|PERMISSIVE|{authenticated}|(id = my_department_id())|'
     AND (SELECT ${polMd5} FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(UPD.name)}') = '${UPD.md5}' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 SELECT policy = (id = my_department_id()) TO authenticated; UPDATE policy = its pin' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 departments policies not as intended: ' || coalesce(v_t, '(missing)') || chr(10); END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('email', '${STRANGER}')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_n FROM public.departments;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := v_n = 0;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    SELECT count(*) INTO v_n FROM public.departments;
    EXECUTE 'RESET ROLE';
    v_ok := v_ok AND v_n = 0;
  EXCEPTION WHEN insufficient_privilege THEN EXECUTE 'RESET ROLE';
  END;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  O2 a signed-in stranger reads 0 of %s departments; anon refused / 0%s', v_all, chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 a stranger or anon can still read departments' || chr(10); END IF;

  FOR d, dn IN SELECT id, name FROM public.departments ORDER BY name LOOP
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      FOR v_who IN SELECT unnest(ARRAY['DA', 'member']) LOOP
        IF v_who = 'DA' THEN ${personaSql("DA")} INTO v_email; ELSE ${personaSql("member")} INTO v_email; END IF;
        IF v_email IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  no real %s in this department%s', v_who, chr(10)); CONTINUE; END IF;
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*), max(id::text)::uuid INTO v_n, v_own FROM public.departments;
        EXECUTE 'RESET ROLE';
        IF v_n = 1 AND v_own = d THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T1 %s reads exactly 1 department: their own%s', v_who, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T1 %s reads %s departments (own: %s)%s', v_who, v_n, v_own = d, chr(10)); END IF;
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*) INTO v_n FROM public.departments WHERE id = public.my_department_id();
        EXECUTE 'RESET ROLE';
        IF v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T2 %s: the app''s own-department read returns their row%s', v_who, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T2 %s: the own-department read returned %s rows%s', v_who, v_n, chr(10)); END IF;
        EXECUTE 'SET LOCAL ROLE authenticated';
        UPDATE public.departments SET name = name WHERE id = d;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        EXECUTE 'RESET ROLE';
        IF v_n = (CASE WHEN v_who = 'DA' THEN 1 ELSE 0 END) THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 %s: no-op UPDATE of own department touches %s row(s), as before%s', v_who, v_n, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 %s: no-op UPDATE touched %s rows%s', v_who, v_n, chr(10)); END IF;
      END LOOP;
      -- T4: the policy back to USING (true) inside the rollback → the same DA reads every department again
      ${personaSql("DA")} INTO v_email;
      IF v_email IS NOT NULL THEN
        ALTER POLICY ${ident(SEL.name)} ON public.departments USING (true);
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*) INTO v_n FROM public.departments;
        EXECUTE 'RESET ROLE';
        IF v_n = v_all THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T4 with USING (true) put back (rolled back) the DA reads all %s — the policy is what scopes it%s', v_all, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 with USING (true) put back the DA reads %s of %s%s', v_n, v_all, chr(10)); END IF;
      END IF;
      PERFORM set_config('request.jwt.claims', '', true);
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
`;

// ================================================================ L-2 ROLLBACK
out["sql/l2_departments_scope_ROLLBACK.sql"] = `-- =====================================================================
-- ROLLBACK for l2_departments_scope — insurance, GENERATED from the same capture. Puts the SELECT policy back to the exact
-- captured predicate (USING (true)). Refuses unless the policy is in the applied state; proves it is back to its pin.
-- =====================================================================
DO $rollback$
DECLARE v_t text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  SELECT p.qual INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(SEL.name)}';
  IF v_t IS DISTINCT FROM '(id = my_department_id())' THEN RAISE EXCEPTION 'ROLLBACK: "${q(SEL.name)}" is not in the L-2 applied state (%). Refusing.', v_t; END IF;
  ALTER POLICY ${ident(SEL.name)} ON public.departments USING (${SEL.qual});
  SELECT ${polMd5} INTO v_t FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'departments' AND p.policyname = '${q(SEL.name)}';
  IF v_t IS DISTINCT FROM '${SEL.md5}' THEN RAISE EXCEPTION 'ROLLBACK post-condition: the policy is not back to its captured md5. Rolling back.'; END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
`;

// ================================================================ L-4 MIGRATION
const answersBlock = (into) => `
    ${into} := '{}'::jsonb;
    FOR v_email IN SELECT DISTINCT lower(email) FROM public.members WHERE email IS NOT NULL AND btrim(email) <> '' ORDER BY 1 LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      v_t := public.is_leadership()::text || ',' || public.is_department_admin()::text || ',' || public.is_announcer()::text;
      EXECUTE 'RESET ROLE';
      ${into} := ${into} || jsonb_build_object(left(md5(v_email), 12), v_t);   -- keyed by a hash: no email ever reaches an error text
    END LOOP;
    PERFORM set_config('request.jwt.claims', '', true);`;
out["sql/l4_role_helpers_scope_DRAFT.sql"] = `-- =====================================================================
-- SECURITY L-4 — the role-anywhere helpers become department-scoped. DRAFT for gate review — NOT APPLIED.
-- GENERATED by docs/review/l2_l4_build.mjs from the live capture (docs/review/l2_l4_LIVEDEFS.json, ${L.read_at}). Rulings:
-- claude/B4C_L2_L4_Step0.md (D-2 dept-scope in place). Change list: docs/review/l2_l4_CHANGE_LIST.md.
--
-- WHAT IT DOES — re-creates three functions (CREATE OR REPLACE: same signature, STABLE SECURITY DEFINER,
-- search_path=public; the ACL is kept by construction and checked below). Only the body changes:
--   is_leadership()        role-anywhere {PA, DA, Board Member, Officer} → select public.is_leader()
--                          (is_leader IS that predicate + "in my_department_id()" — proven from the live text by the generator)
--   is_department_admin()  role-anywhere {DA, PA} → select public.is_dept_admin()   (same: is_dept_admin is its scoped twin)
--   is_announcer()         role-anywhere {DA, PA, Officer} → the same body + "and department_id = public.my_department_id()"
-- Callers (3 + 1 policies, 9 functions — Step 0) are not touched; every one already scopes its ROWS to my_department_id();
-- this scopes the ROLE, so a role held in department A no longer counts while acting in department B.
-- Not touched: is_equipment_manager() (already dept-scoped 2026-10-24, md5 ${F.is_equipment_manager.md5.slice(0, 8)} — pinned here, unchanged),
-- is_project_admin() (PA is the cross-department platform role by design — pinned, unchanged), any policy, any grant.
--
-- PREFLIGHT refuses on drift: the three bodies by md5; is_leader / is_dept_admin / my_department_id / my_member_id /
-- is_equipment_manager / is_project_admin by md5; table + EXECUTE matrices by md5; nobody in two departments; refuses if applied.
-- IN-TRANSACTION PROOF (any miss → RAISE → everything rolls back):
--   · HELPER ANSWERS: for EVERY member email, as authenticated, (is_leadership, is_department_admin, is_announcer) BEFORE
--     and AFTER — byte-identical. With nobody in two departments this is the "no live behaviour change" property itself.
--   · ROW COUNTS: all ${RELS.length} relations as a real DA and a real member of EVERY department — byte-identical
--   · the three bodies are exactly the generated text; STABLE / DEFINER / search_path / ACL unchanged
--   · every OTHER public function and every public policy byte-identical (md5 of all); matrices; counts; verified
-- The multi-department case (the thing this fixes) is proven by the RETEST (synthesized inside a rollback) and the dry run.
-- =====================================================================
DO $migrate$
DECLARE
  ${declCommon}
  v_ans_before jsonb; v_ans_after jsonb; v_pols text; v_others text;
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  -- ---------------------------------------------------------------- 0. preflight
  IF ${prosrc("is_leadership")} LIKE '%is_leader()%' AND ${prosrc("is_department_admin")} LIKE '%is_dept_admin()%' THEN
    RAISE EXCEPTION 'PREFLIGHT: is_leadership / is_department_admin already delegate — L-4 looks applied. Refusing.';
  END IF;
  FOR r IN SELECT * FROM (VALUES
${[...H4, ...PIN_KEEP].map((n) => `      ('${n}', '${F[n].md5}')`).join(",\n")}) v(name, md5) LOOP
    IF ${fnMd5("x").replace("p.proname = 'x'", "p.proname = r.name")} IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'PREFLIGHT: %() drifted from the capture (or is gone). Refusing.', r.name;
    END IF;
  END LOOP;
${commonPre("L-4")}
  v_pols := ${allPolMd5(null)};
  v_others := ${allFnMd5(H4)};
${answersBlock("v_ans_before")}
${countsBlock("v_before")}

  -- ---------------------------------------------------------------- 1. the three bodies
${H4.map((n) => `${newDef(n)};`).join("\n\n")}   -- (verbatim, not indented: the body text IS the definition — the post-condition compares it exactly)

  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)
${answersBlock("v_ans_after")}
  IF v_ans_after IS DISTINCT FROM v_ans_before THEN
    ${diffSql("v_ans_before", "v_ans_after")}
    RAISE EXCEPTION 'Post-condition failed: a member''s helper answer changed (member-hash leadership,admin,announcer): %. Rolling back.', v_t;
  END IF;
${countsBlock("v_after")}
  IF v_after IS DISTINCT FROM v_before THEN
    ${diffSql("v_before", "v_after")}
    RAISE EXCEPTION 'Post-condition failed: a real member''s or DA''s row counts changed: %. Rolling back.', v_t;
  END IF;
  FOR r IN SELECT * FROM (VALUES
${H4.map((n) => `      ('${n}', '${q(NEW[n])}')`).join(",\n")}) v(name, src) LOOP
    IF ${prosrc("x").replace("p.proname = 'x'", "p.proname = r.name")} IS DISTINCT FROM r.src
       OR ${fnRow("x").replace("p.proname = 'x'", "p.proname = r.name")} IS DISTINCT FROM '${FNROW}' THEN
      RAISE EXCEPTION 'Post-condition failed: %() is not exactly the generated body, or its STABLE / DEFINER / search_path / ACL changed. Rolling back.', r.name;
    END IF;
  END LOOP;
  IF ${allPolMd5(null)} IS DISTINCT FROM v_pols THEN RAISE EXCEPTION 'Post-condition failed: a public policy changed. Rolling back.'; END IF;
  IF ${allFnMd5(H4)} IS DISTINCT FROM v_others THEN RAISE EXCEPTION 'Post-condition failed: a public function other than the three changed. Rolling back.'; END IF;
${commonPost}
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
${H4.map((n) => `  '${n}', jsonb_build_object('md5', ${fnMd5(n)}, 'row', ${fnRow(n)})`).join(",\n")},
  'is_equipment_manager_md5', ${fnMd5("is_equipment_manager")},
  'total_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;

// ================================================================ L-4 RETEST
out["sql/l4_role_helpers_scope_RETEST.sql"] = `-- =====================================================================
-- RETEST for l4_role_helpers_scope. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Per department, the checks run inside a sub-block ending in RAISE 'SENTINEL' (rolled back). NOTHING CHANGES.
-- The final RAISE is the report — the "ERROR" IS the report.
-- Once:
--   S0 the three bodies are the generated text; STABLE / DEFINER / search_path / ACL as captured; is_equipment_manager and
--      is_project_admin unchanged
-- Per department (a REAL Department Admin; a REAL Officer / Board Member if there is one; a REAL plain member):
--   H1 at home: each person's three answers = what their own access list says against each helper's role set (a DA:
--      all true · an Officer: leadership + announcer · a Board Member: leadership only · a member: none) — the same
--      answers the migration proved unchanged for everyone.
--   X1 THE FIX: the DA given a plain member row in ANOTHER department (synthesized inside the rollback) and switched
--      there (member_active_department): all three false; the leadership-gated RPC dept_on_station_now() refuses
--      ("Not authorized"); training_session_audit reads 0 — then switched back home: all three true again.
--      (If the synthetic row can't be inserted — a members constraint / trigger — X1 is SKIPPED with the reason; the
--      PGlite dry run is then the proof.)
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_t text; v_n bigint; v_ok boolean;
  d uuid; dn text; v_da text; v_off text; v_mem text; v_other uuid; v_mid uuid; v_refused boolean; v_acc text[];
BEGIN
  PERFORM set_config('search_path', 'public, pg_catalog', true);
  v_ok := true;
${H4.map((n) => `  v_ok := v_ok AND ${prosrc(n)} = '${q(NEW[n])}' AND ${fnRow(n)} = '${FNROW}';`).join("\n")}
  v_ok := v_ok AND ${fnMd5("is_equipment_manager")} = '${F.is_equipment_manager.md5}' AND ${fnMd5("is_project_admin")} = '${F.is_project_admin.md5}';
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 the three helpers are the generated department-scoped bodies; attributes + ACL as captured; is_equipment_manager / is_project_admin unchanged' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S0 a helper body / attribute / ACL is not as intended' || chr(10); END IF;

  FOR d, dn IN SELECT id, name FROM public.departments ORDER BY name LOOP
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      ${personaSql("DA")} INTO v_da;
      ${personaSql("member")} INTO v_mem;
      SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary')
         AND m.access && array['Officer', 'Board Member']::text[] AND NOT (m.access && array['Department Admin', 'Project Admin']::text[])
         AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      -- H1
      FOR v_t, v_n IN SELECT * FROM (VALUES ('DA', 1), ('officer', 2), ('member', 3)) z LOOP
        CONTINUE WHEN (v_n = 1 AND v_da IS NULL) OR (v_n = 2 AND v_off IS NULL) OR (v_n = 3 AND v_mem IS NULL);
        SELECT coalesce(m.access, '{}') INTO v_acc FROM public.members m WHERE lower(m.email) = CASE v_n WHEN 1 THEN v_da WHEN 2 THEN v_off ELSE v_mem END AND m.department_id = d;
        PERFORM set_config('request.jwt.claims', json_build_object('email', CASE v_n WHEN 1 THEN v_da WHEN 2 THEN v_off ELSE v_mem END)::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        v_ok := (public.is_leadership(), public.is_department_admin(), public.is_announcer())
              = (v_acc && ${/array\[[^\]]*\]/.exec(body("is_leader"))[0]}::text[], v_acc && ${/array\[[^\]]*\]/.exec(body("is_dept_admin"))[0]}::text[], v_acc && ${/array\[[^\]]*\]/.exec(body("is_announcer"))[0]}::text[]);
        EXECUTE 'RESET ROLE';
        IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  H1 %s at home: leadership / admin / announcer as their role says%s', v_t, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  H1 %s at home: wrong helper answer%s', v_t, chr(10)); END IF;
      END LOOP;
      IF v_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || '   SKIP  X1 no real Department Admin here' || chr(10);
      ELSE
        SELECT id INTO v_other FROM public.departments WHERE id <> d ORDER BY id LIMIT 1;
        BEGIN
          INSERT INTO public.members (department_id, email, name, access, status) VALUES (v_other, v_da, 'L-4 RETEST second department', '{Member}', 'Active') RETURNING id INTO v_mid;
          INSERT INTO public.member_active_department (email, department_id) VALUES (v_da, v_other) ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
          PERFORM set_config('request.jwt.claims', json_build_object('email', v_da)::text, true);
          EXECUTE 'SET LOCAL ROLE authenticated';
          v_ok := public.my_department_id() = v_other AND NOT public.is_leadership() AND NOT public.is_department_admin() AND NOT public.is_announcer();
          v_refused := false;
          BEGIN PERFORM * FROM public.dept_on_station_now(); EXCEPTION WHEN OTHERS THEN v_refused := SQLERRM ILIKE '%not authorized%'; END;
          SELECT count(*) INTO v_n FROM public.training_session_audit;
          EXECUTE 'RESET ROLE';
          IF v_ok AND v_refused AND v_n = 0 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  X1 the DA acting in another department (plain member there): all three helpers false, dept_on_station_now refused, training_session_audit 0' || chr(10);
          ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  X1 acting elsewhere: helpers-false %s, refused %s, audit rows %s%s', v_ok, v_refused, v_n, chr(10)); END IF;
          UPDATE public.member_active_department SET department_id = d WHERE email = v_da;
          EXECUTE 'SET LOCAL ROLE authenticated';
          v_ok := public.my_department_id() = d AND public.is_leadership() AND public.is_department_admin() AND public.is_announcer();
          EXECUTE 'RESET ROLE';
          IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  X1 back home: all three true again' || chr(10);
          ELSE v_fail := v_fail + 1; rpt := rpt || '   FAIL  X1 back home: a helper is still false' || chr(10); END IF;
        EXCEPTION WHEN OTHERS THEN
          EXECUTE 'RESET ROLE';
          v_skip := v_skip + 1; rpt := rpt || format('   SKIP  X1 could not synthesize the second membership: %s%s', SQLERRM, chr(10));
        END;
      END IF;
      PERFORM set_config('request.jwt.claims', '', true);
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
`;

// ================================================================ L-4 ROLLBACK
out["sql/l4_role_helpers_scope_ROLLBACK.sql"] = `-- =====================================================================
-- ROLLBACK for l4_role_helpers_scope — insurance, GENERATED from the same capture: the three functions re-created from
-- their exact captured definitions. Refuses unless all three are in the applied state; proves each is back to its md5.
-- =====================================================================
DO $rollback$
DECLARE r record;
BEGIN
  IF NOT (${H4.map((n) => `${prosrc(n)} = '${q(NEW[n])}'`).join("\n          AND ")}) THEN
    RAISE EXCEPTION 'ROLLBACK: the three helpers are not in the L-4 applied state. Refusing.';
  END IF;
${H4.map((n) => `${F[n].def};`).join("\n\n")}

  FOR r IN SELECT * FROM (VALUES
${H4.map((n) => `      ('${n}', '${F[n].md5}')`).join(",\n")}) v(name, md5) LOOP
    IF ${fnMd5("x").replace("p.proname = 'x'", "p.proname = r.name")} IS DISTINCT FROM r.md5 OR ${fnRow("x").replace("p.proname = 'x'", "p.proname = r.name")} IS DISTINCT FROM '${FNROW}' THEN
      RAISE EXCEPTION 'ROLLBACK post-condition: %() is not back to its captured definition / ACL. Rolling back.', r.name;
    END IF;
  END LOOP;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
`;

// ================================================================ change list
out["docs/review/l2_l4_CHANGE_LIST.md"] = `# L-2 / L-4 — change list (GENERATED by docs/review/l2_l4_build.mjs from docs/review/l2_l4_LIVEDEFS.json, ${L.read_at})

## L-2 · \`sql/l2_departments_scope_DRAFT.sql\`
| object | before (live) | after |
|---|---|---|
| policy \`${SEL.name}\` on \`departments\` | SELECT · PERMISSIVE · {authenticated} · \`USING (${SEL.qual})\` · md5 \`${SEL.md5}\` | SELECT · PERMISSIVE · {authenticated} · \`USING (id = my_department_id())\` |
| policy \`${UPD.name}\` | UPDATE · \`${UPD.qual}\` | unchanged (md5 \`${UPD.md5}\` pinned) |

Nothing else. RLS on / FORCE off / owner postgres (pinned) — the ${L.counts.departments}-row SQL readers are SECURITY DEFINER owned by the table owner, so they keep reading every row.

## L-4 · \`sql/l4_role_helpers_scope_DRAFT.sql\`
| function | before (live md5) | before: role check | after (body) |
|---|---|---|---|
${H4.map((n) => `| \`${n}()\` | \`${F[n].md5}\` | \`${/array\[[^\]]*\]/.exec(body(n))[0]}\`, any department | ${n === "is_announcer" ? "same body + `and department_id = public.my_department_id()`" : `\`${NEW[n].trim().split("\n").pop().trim()}\``} |`).join("\n")}

Signature, STABLE, SECURITY DEFINER, \`search_path=public\` and the ACL (\`${FNROW.split("|")[3]}\`) unchanged (CREATE OR REPLACE; checked).

**Pinned, unchanged:**
${PIN_KEEP.map((n) => `- \`${n}()\` · md5 \`${F[n].md5}\``).join("\n")}

**Callers, unchanged:**
- \`is_leadership()\`: 2 policies and 9 functions.
- \`is_department_admin()\`: 1 policy.
- \`is_announcer()\`: 1 policy (\`announcements\` INSERT).
- The full list is in \`claude/B4C_L2_L4_Step0.md\` and \`docs/review/l2_l4_ANNOUNCER_OUTPUT.json\`.

**Role-helper sweep (live)** — every public \`is_*()\` that reads \`members.access\`:
${L.role_helper_sweep.map((s) => `- \`${s.name}()\` · ${s.dept_scoped ? "dept-scoped" : H4.includes(s.name) ? "**role-anywhere → scoped by this migration**" : s.name === "is_project_admin" ? "role-anywhere **by design** (PA is the cross-department role; not changed)" : "**role-anywhere — not covered!**"}`).join("\n")}
`;

// ---------------------------------------------------------------- write or check
const check = process.argv.includes("--check");
let bad = 0;
for (const [p, s] of Object.entries(out)) {
  if (check) {
    let cur = null; try { cur = readFileSync(join(root, p), "utf8"); } catch { /* missing */ }
    if (cur !== s) { console.log(`DIFFERS ${p}`); bad++; } else console.log(`same    ${p}`);
  } else { writeFileSync(join(root, p), s); console.log(`wrote   ${p} (${s.length} bytes)`); }
}
if (check && bad) process.exit(1);
