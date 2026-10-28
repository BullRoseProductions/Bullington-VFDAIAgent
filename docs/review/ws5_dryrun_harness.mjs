// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/ws5_dryrun_harness.mjs
// DRY RUN for sql/ws5_public_rls_DRAFT.sql + sql/ws5_storage_policy_DRAFT.sql and their RETESTs — NOT the live DB.
// Mock: the 56 anon-granted relations by their LIVE names (id, department_id), members / member_active_department /
// member_separation / equipment_manager with the columns the gate functions read, the LIVE bodies of my_department_id,
// my_member_id, is_leader, is_dept_admin, is_equipment_manager (docs/review/ws5_LIVEDEFS.json — no stubs), the 19 {public}
// policies created from their LIVE predicate text (their md5 pins must reproduce), Supabase-style default grants trimmed
// to the live anon map, a sealed extra table anon never had, storage.objects owned by supabase_storage_admin with the
// live S-1 policy + two others. PGlite is PG16: no MAINTAIN (compared out, as in the migration).
// The two privilege-MATRIX md5s span all 93 live objects and cannot reproduce in a mock; the harness substitutes the
// mock's own matrix md5 for those two pins (labelled below). Every other pin is the live value, unchanged.
// Runs: pins -> migration -> state row -> re-run (must refuse) -> RETEST -> drift refusals -> mutations (in-transaction
// proof must roll back) -> post-apply drift (RETEST must catch) -> storage (S-1) the same way -> ROLLBACK round trip
// (apply → rollback = the exact pre-apply catalog; re-apply passes preflight; mutated rollbacks caught). For the rollback the
// captured postgres/public default ACLs are also swapped for the mock's own (same labelled reason as the matrix pins).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/ws5_LIVEDEFS.json"), "utf8"));
const MIG0 = readFileSync(join(root, "sql/ws5_public_rls_DRAFT.sql"), "utf8");
const RET0 = readFileSync(join(root, "sql/ws5_public_rls_RETEST.sql"), "utf8");
const SMIG = readFileSync(join(root, "sql/ws5_storage_policy_DRAFT.sql"), "utf8");
const SRET = readFileSync(join(root, "sql/ws5_storage_policy_RETEST.sql"), "utf8");
const RB0 = readFileSync(join(root, "sql/ws5_public_rls_ROLLBACK.sql"), "utf8");
const SRB = readFileSync(join(root, "sql/ws5_storage_policy_ROLLBACK.sql"), "utf8");
const SEQ = "training_session_audit_seq_seq";
const RELS = Object.keys(L.anon_acl).filter((k) => k !== SEQ);
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", C = "00000000-0000-0000-0000-00000000000c";
const special = new Set(["departments", "members", "members_view", "equipment_manager", "member_separation", "station_presence"]);
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const lit = (s) => `'${s.replace(/'/g, "''")}'`;

const schema = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE supabase_storage_admin NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL,
  access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, email text);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE member_separation (member_id uuid PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE equipment_manager (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, department_id uuid, removed_at timestamptz);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, verified boolean NOT NULL DEFAULT false);
${RELS.filter((r) => !special.has(r)).map((r) => `CREATE TABLE public.${ident(r)} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid);`).join("\n")}
CREATE VIEW public.members_view AS SELECT id, department_id, name, status FROM public.members;
CREATE SEQUENCE public.${SEQ};
CREATE TABLE public.sealed_extra (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid);
REVOKE ALL ON public.sealed_extra, public.member_active_department, public.member_separation FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.equipment_issues FROM anon;
REVOKE INSERT, UPDATE ON public.onboarding_progress FROM anon;
${["my_department_id", "my_member_id", "is_leader", "is_dept_admin", "is_equipment_manager"].map((f) => L.gate_fns[f].def + ";").join("\n")}
-- RLS on every table; the 19 {public} policies from their LIVE text; every other table a dept-scoped read TO authenticated
${[...RELS.filter((r) => r !== "members_view"), "member_active_department", "member_separation", "sealed_extra"].map((r) => `ALTER TABLE public.${ident(r)} ENABLE ROW LEVEL SECURITY;`).join("\n")}
${L.public_policies.map((p) => `CREATE POLICY ${ident(p.name)} ON public.${ident(p.tbl)} AS ${p.permissive} FOR ${p.cmd}${p.qual ? ` USING (${p.qual})` : ""}${p.with_check ? ` WITH CHECK (${p.with_check})` : ""};`).join("\n")}
${RELS.filter((r) => r !== "members_view" && !L.public_policies.some((p) => p.tbl === r)).map((r) => `CREATE POLICY "mock dept read" ON public.${ident(r)} FOR SELECT TO authenticated USING (${r === "departments" ? "id" : "department_id"} = my_department_id());`).join("\n")}
INSERT INTO departments VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)'), ('${C}', 'Charlie (mock, nobody)');
INSERT INTO members (department_id, name, email, access, status) VALUES
  ('${A}', 'A DA', 'da@a.test', '{Department Admin}', 'Active'), ('${A}', 'A FF', 'ff@a.test', '{Member}', 'Active'),
  ('${A}', 'A officer', 'off@a.test', '{Officer}', 'Active'), ('${A}', 'A gone', 'gone@a.test', '{Member}', 'Inactive'),
  ('${B}', 'B DA', 'da@b.test', '{Department Admin}', 'Active'), ('${B}', 'B FF', 'ff@b.test', '{Member}', 'Probationary'), ('${B}', 'B FF2', 'ff2@b.test', '{}', 'Active');
INSERT INTO member_separation SELECT id, department_id FROM members WHERE email = 'gone@a.test';
INSERT INTO equipment_manager (member_id, department_id) SELECT id, department_id FROM members WHERE email = 'off@a.test';
INSERT INTO station_presence (department_id, verified) VALUES ('${A}', true), ('${A}', false), ('${B}', true);
${RELS.filter((r) => !special.has(r)).map((r) => `INSERT INTO public.${ident(r)} (department_id) VALUES ('${A}'), ('${A}'), ('${B}');`).join("\n")}
-- storage (S-1)
CREATE SCHEMA storage;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ select string_to_array(name, '/') $$;
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY ${ident(L.storage_policy.name)} ON storage.objects AS ${L.storage_policy.permissive} FOR ${L.storage_policy.cmd} WITH CHECK (${L.storage_policy.with_check});
CREATE POLICY "mock other read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'station-documents');
CREATE POLICY "mock other delete" ON storage.objects FOR DELETE TO authenticated USING (is_dept_admin());
ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
`;
const first = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const log = (s) => console.log(s);
let unexpected = 0;
const expect = (ok, label) => { log(`${ok ? "  ok " : "  !! "} ${label}`); if (!ok) unexpected++; };
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }
const one = async (db, sql) => (await db.query(sql)).rows[0];
const matrixSql = (role) => `SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type)) m FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = '${role}'::regrole`;
// the two matrix pins → the mock's own (labelled in the header); nothing else is substituted
async function localize(db, sql) {
  const auth = (await one(db, matrixSql("authenticated"))).m, svc = (await one(db, matrixSql("service_role"))).m;
  const n = sql.split(L.auth_matrix_md5).length - 1, m = sql.split(L.service_matrix_md5).length - 1;
  return { sql: sql.split(L.auth_matrix_md5).join(auth).split(L.service_matrix_md5).join(svc), n, m };
}
const runRetest = async (db, sql) => { try { await db.exec(sql); return "RETEST did not raise"; } catch (e) { return report(e); } };
const tail = (r) => r.split("\n").pop();

log("== WS-5 PGlite dry run (" + new Date().toISOString().slice(0, 10) + ") — mock, not the live DB ==\n");
// ------------------------------------------------------------ 1. pins reproduce
{ const db = await fresh();
  const map = (await one(db, `SELECT jsonb_object_agg(x.rel, x.privs) j FROM (SELECT c.relname rel, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) privs
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','S') AND a.grantee = 'anon'::regrole GROUP BY 1) x`)).j;
  const want = Object.fromEntries(Object.entries(L.anon_acl).map(([k, v]) => [k, v.split(",").filter((p) => p !== "MAINTAIN").join(",")]));
  const diff = Object.keys({ ...map, ...want }).filter((k) => map[k] !== want[k]);
  expect(diff.length === 0, `anon grant map: mock = live on all ${Object.keys(want).length} objects (MAINTAIN compared out) ${diff.length ? JSON.stringify(diff) : ""}`);
  const pols = (await db.query(`SELECT p.tablename, p.policyname, md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) m
      FROM pg_policies p WHERE p.schemaname = 'public' AND p.roles = '{public}'`)).rows;
  const miss = L.public_policies.filter((p) => !pols.some((r) => r.tablename === p.tbl && r.policyname === p.name && r.m === p.md5));
  expect(pols.length === 19 && miss.length === 0, `the 19 {public} policies: md5 of the full definition reproduces the LIVE pin for ${19 - miss.length}/19 ${miss.map((p) => p.name).join("; ")}`);
  const s = await one(db, `SELECT md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) m FROM pg_policies p WHERE p.schemaname = 'storage' AND p.policyname = ${lit(L.storage_policy.name)}`);
  expect(s.m === L.storage_policy.md5, "storage policy (S-1): md5 reproduces the LIVE pin");
  const gf = (await db.query(`SELECT proname, md5(pg_get_functiondef(oid)) m FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).rows;
  const gbad = Object.entries(L.gate_fns).filter(([k, v]) => !gf.some((r) => r.proname === k && r.m === v.md5));
  expect(gbad.length === 0, `gate functions: ${5 - gbad.length}/5 bodies md5 = live ${gbad.map(([k]) => k).join(",")}`);
  const loc = await localize(db, MIG0);
  log(`   (labelled substitution: authenticated matrix pin ×${loc.n}, service_role matrix pin ×${loc.m} → the mock's own md5)`);
  await db.close(); }

// ------------------------------------------------------------ 2. apply → state → re-run → RETEST
{ const db = await fresh();
  const MIG = (await localize(db, MIG0)).sql, RET = (await localize(db, RET0)).sql;
  log("\n-- apply (part 1)");
  try { await db.exec(MIG); expect(true, "migration ran; every in-transaction post-condition held"); } catch (e) { expect(false, "migration raised: " + first(e)); }
  const st = (await db.query(MIG.slice(MIG.lastIndexOf("SELECT jsonb_build_object(")))).rows[0].state;
  log("   state: " + JSON.stringify(st));
  expect(st.anon_acl_entries == 0 && st.anon_readable_relations == 0 && st.public_role_policies == 0 && st.flipped_to_authenticated == 19, "state row: anon 0 entries / 0 readable, 0 {public} policies, 19 flipped");
  expect(st.verified_presence == 2, "verified untouched (2 in the mock)");
  const dacl = await one(db, `SELECT string_agg(CASE WHEN defaclnamespace = 0 THEN '(global)' ELSE defaclnamespace::regnamespace::text END || ':' || defaclobjtype::text || '=' || defaclacl::text, '  ' ORDER BY 1) s FROM pg_default_acl`);
  log("   default ACLs now: " + dacl.s);
  await db.exec(`CREATE TABLE public.ws5_probe_t (id int); CREATE SEQUENCE public.ws5_probe_s; CREATE FUNCTION public.ws5_probe_f() RETURNS int LANGUAGE sql AS 'select 1';
                 CREATE SCHEMA other; CREATE FUNCTION other.ws5_probe_g() RETURNS int LANGUAGE sql AS 'select 1';`);
  const probe = await one(db, `SELECT has_table_privilege('anon', 'public.ws5_probe_t', 'SELECT') t, has_sequence_privilege('anon', 'public.ws5_probe_s', 'USAGE') s,
      has_function_privilege('anon', 'public.ws5_probe_f()', 'EXECUTE') f, has_function_privilege('authenticated', 'public.ws5_probe_f()', 'EXECUTE') fa,
      has_table_privilege('authenticated', 'public.ws5_probe_t', 'SELECT') ta, has_function_privilege('anon', 'other.ws5_probe_g()', 'EXECUTE') g,
      (SELECT proacl::text FROM pg_proc WHERE proname = 'is_leader') old_acl`);
  expect(!probe.t && !probe.s && !probe.f && probe.fa && probe.ta && !probe.g, `F-3 forward-fix: a NEW public table / sequence / function grants anon nothing (t ${probe.t} s ${probe.s} f ${probe.f}); authenticated still gets them (t ${probe.ta} f ${probe.fa}); a new function in another schema has no PUBLIC EXECUTE (${probe.g})`);
  log(`   existing function grants untouched (is_leader acl: ${probe.old_acl})`);
  await db.exec(`DROP TABLE public.ws5_probe_t; DROP SEQUENCE public.ws5_probe_s; DROP FUNCTION public.ws5_probe_f(); DROP SCHEMA other CASCADE;`);
  try { await db.exec(MIG); expect(false, "re-run did NOT refuse"); } catch (e) { expect(/looks applied/.test(first(e)), "re-run refused: " + first(e)); }
  log("\n-- RETEST (part 1)");
  const r = await runRetest(db, RET); log(r.split("\n").map((l) => "   " + l).join("\n"));
  expect(/ 0 failed/.test(tail(r)) && !/FAIL/.test(r), "RETEST all green");
  // ---- post-apply drift: the RETEST must catch
  log("\n-- post-apply drift (RETEST must go red)");
  for (const [label, sql, want] of [
    ["anon re-granted SELECT on certs", `GRANT SELECT ON public.certs TO anon`, /FAIL  O1[\s\S]*FAIL  T2/],
    ["a policy put back TO public", `ALTER POLICY "leaders read members base table" ON public.members TO public`, /FAIL  O1[\s\S]*FAIL  O2/],
    ["a flipped predicate edited", `ALTER POLICY "dept reads ai_outputs" ON public.ai_outputs USING (true)`, /FAIL  O2/],
    ["anon default re-added", `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon`, /FAIL  O3/],
    ["authenticated lost SELECT on duties", `REVOKE SELECT ON public.duties FROM authenticated`, /FAIL  O3/],
  ]) {
    await db.exec("BEGIN"); await db.exec(sql);
    const rr = await runRetest(db, RET); await db.exec("ROLLBACK");
    expect(want.test(rr), `${label} → ${rr.split("\n").filter((l) => /FAIL/.test(l))[0]?.trim() || "no FAIL"}  [${tail(rr)}]`);
  }
  // ---- S-1 storage
  log("\n-- storage S-1 (part 2)");
  try { await db.exec(SMIG); expect(true, "storage migration ran; post-conditions held (other storage policies byte-identical)"); } catch (e) { expect(false, "storage migration raised: " + first(e)); }
  log("   state: " + JSON.stringify((await db.query(SMIG.slice(SMIG.lastIndexOf("SELECT jsonb_build_object(")))).rows[0].state));
  try { await db.exec(SMIG); expect(false, "storage re-run did NOT refuse"); } catch (e) { expect(/looks applied/.test(first(e)), "storage re-run refused: " + first(e)); }
  const sr = await runRetest(db, SRET.split(`= ${L.counts.storage_policies}`).join("= 3").split(`count ${L.counts.storage_policies}`).join("count 3"));
  log(sr.split("\n").map((l) => "   " + l).join("\n") + `   (S3 count localized: live ${L.counts.storage_policies} → mock 3)`);
  expect(/0 failed/.test(tail(sr)), "storage RETEST green");
  await db.exec("BEGIN"); await db.exec(`ALTER POLICY ${ident(L.storage_policy.name)} ON storage.objects TO public`);
  const sr2 = await runRetest(db, SRET); await db.exec("ROLLBACK");
  expect(/FAIL  S1/.test(sr2) && /FAIL  S2/.test(sr2), "storage drift (policy back TO public) → RETEST red on S1 + S2");
  await db.close(); }

// ------------------------------------------------------------ 3. preflight refusals on drift
log("\n-- preflight drift (migration must refuse; nothing changes)");
for (const [label, sql, want] of [
  ["anon gained INSERT on equipment_issues", `GRANT INSERT ON public.equipment_issues TO anon`, /anon grant set drifted/],
  ["anon lost a grant on events", `REVOKE DELETE ON public.events FROM anon`, /anon grant set drifted/],
  ["a {public} policy's predicate edited", `ALTER POLICY "authenticated can read duties" ON public.duties USING (true)`, /policy "authenticated can read duties" on duties drifted/],
  ["a {public} policy dropped", `DROP POLICY "leaders can read meetings" ON public.meetings`, /"leaders can read meetings" on meetings drifted \(or is gone\)/],
  ["a 20th {public} policy appeared", `CREATE POLICY "stray" ON public.events FOR SELECT USING (true)`, /exactly 19/],
  ["authenticated's matrix moved", `REVOKE UPDATE ON public.events FROM authenticated`, /authenticated's privilege matrix drifted/],
  ["service_role's matrix moved", `REVOKE DELETE ON public.events FROM service_role`, /service_role's privilege matrix drifted/],
  ["an object not owned by postgres", `CREATE ROLE someone; ALTER TABLE public.sealed_extra OWNER TO someone`, /not owned by postgres/],
]) {
  const db = await fresh(); const MIG = (await localize(db, MIG0)).sql;
  await db.exec(sql);
  const before = (await one(db, `SELECT count(*) n FROM pg_policies WHERE roles = '{public}' AND schemaname = 'public'`)).n;
  let msg = "ran"; try { await db.exec(MIG); } catch (e) { msg = first(e); }
  const after = (await one(db, `SELECT count(*) n FROM pg_policies WHERE roles = '{public}' AND schemaname = 'public'`)).n;
  expect(want.test(msg) && before === after, `${label} → ${msg}`);
  await db.close();
}

// ------------------------------------------------------------ 4. mutations: a wrong migration must roll back in-transaction
log("\n-- mutated migrations (the in-transaction proof must catch and roll back)");
const flipLine = `  ALTER POLICY "dept reads ai_outputs" ON public."ai_outputs" TO authenticated;`;
for (const [label, from, to, want] of [
  ["a flip that also rewrites the predicate", flipLine, `  ALTER POLICY "dept reads ai_outputs" ON public."ai_outputs" TO authenticated USING (true);`, /row counts changed/],
  ["a flip that subtly narrows the predicate", `  ALTER POLICY "leaders can read action_items" ON public."action_items" TO authenticated;`, `  ALTER POLICY "leaders can read action_items" ON public."action_items" TO authenticated USING (is_dept_admin() AND department_id = my_department_id());`, /row counts changed|not the same predicate/],
  ["a flip to the wrong role", flipLine, `  ALTER POLICY "dept reads ai_outputs" ON public."ai_outputs" TO service_role;`, /row counts changed|not the same predicate/],
  ["a forgotten flip", flipLine, "", /\{public\} or \{anon\} policy is left|not the same predicate/],
  ["a forgotten REVOKE", `  REVOKE ALL ON TABLE public."certs" FROM anon;\n`, "", /anon \(or PUBLIC\) still holds/],
  ["a REVOKE that also hits authenticated", `  REVOKE ALL ON TABLE public."duties" FROM anon;`, `  REVOKE ALL ON TABLE public."duties" FROM anon, authenticated;`, /row counts changed|authenticated's privileges changed/],
  ["a stray GRANT to PUBLIC", `  REVOKE ALL ON TABLE public."events" FROM anon;`, `  REVOKE ALL ON TABLE public."events" FROM anon; GRANT SELECT ON TABLE public."events" TO PUBLIC;`, /anon \(or PUBLIC\) still holds/],
  ["the global PUBLIC function default left out", `  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;\n`, "", /default privileges are not as intended/],
  ["a write to station_presence", `  -- ---------------------------------------------------------------- 3. the forward-fix (F-3)`, `  UPDATE public.station_presence SET verified = NOT verified;\n  -- ---------------------------------------------------------------- 3. the forward-fix (F-3)`, /row counts changed|verified presence changed/],
]) {
  const db = await fresh(); const MIG = (await localize(db, MIG0)).sql;
  const parts = MIG.split(from); if (parts.length !== 2) { expect(false, `${label}: mutation anchor found ${parts.length - 1}×`); await db.close(); continue; }
  let msg = "ran"; try { await db.exec(parts.join(to)); } catch (e) { msg = first(e); }
  const still = (await one(db, `SELECT count(*) n FROM pg_policies WHERE roles = '{public}' AND schemaname = 'public'`)).n;
  const anon = (await one(db, `SELECT count(*) n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'anon'::regrole`)).n;
  expect(want.test(msg) && Number(still) === 19 && Number(anon) > 0, `${label} → ${msg.slice(0, 150)}  [rolled back: ${still} {public} policies, ${anon} anon entries remain]`);
  await db.close();
}
// ------------------------------------------------------------ 5. ROLLBACK round trip (insurance scripts)
log("\n-- rollback round trip (apply → rollback must restore the exact pre-apply catalog; then re-apply must pass preflight)");
const DEF_LIVE = JSON.stringify(Object.fromEntries(["r", "S", "f"].map((t) => [t, L.default_acl.find((d) => d.role === "postgres" && d.ns === "public" && d.type === t).acl])));
const snapSql = `SELECT jsonb_build_object(
  'anon', (SELECT jsonb_object_agg(x.rel, x.privs) FROM (SELECT c.relname rel, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) privs FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'anon'::regrole GROUP BY 1) x),
  'pol', (SELECT jsonb_object_agg(schemaname || '.' || tablename || '.' || policyname, md5(cmd || '|' || permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))) FROM pg_policies),
  'auth', (${matrixSql("authenticated")}), 'svc', (${matrixSql("service_role")}),
  'dacl', (SELECT jsonb_object_agg(defaclrole::regrole::text || ':' || defaclnamespace::text || ':' || defaclobjtype::text, (SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(defaclacl) x)) FROM pg_default_acl),
  'fnacl', (SELECT md5(string_agg(oid::text || coalesce(proacl::text, ''), ',' ORDER BY oid)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace)) s`;
async function rbFor(db) {   // the matrix pins (as for the migration) + the captured default ACLs → the mock's own (labelled)
  const def = JSON.stringify(Object.fromEntries((await db.query(`SELECT defaclobjtype::text t, defaclacl::text a FROM pg_default_acl WHERE defaclrole = 'postgres'::regrole AND defaclnamespace = 'public'::regnamespace`)).rows.map((r) => [r.t, r.a])));
  const loc = await localize(db, RB0);
  if (loc.sql.split(DEF_LIVE).length !== 2) throw new Error("rollback: captured defaults literal not found once");
  return loc.sql.split(DEF_LIVE).join(def);
}
{ const db = await fresh();
  const MIG = (await localize(db, MIG0)).sql, RET = (await localize(db, RET0)).sql, RB = await rbFor(db);
  const pre = (await one(db, snapSql)).s;
  try { await db.exec(RB); expect(false, "rollback on an UN-applied database did NOT refuse"); } catch (e) { expect(/not the WS-5 applied state|anon already holds/.test(first(e)), "rollback before apply refused: " + first(e)); }
  await db.exec(MIG); await db.exec(SMIG);
  try { await db.exec(SRB); expect(true, "storage rollback ran; post-conditions held"); } catch (e) { expect(false, "storage rollback raised: " + first(e)); }
  log("   storage state: " + JSON.stringify((await db.query(SRB.slice(SRB.lastIndexOf("SELECT jsonb_build_object(")))).rows[0].state));
  try { await db.exec(RB); expect(true, "part-1 rollback ran; every in-transaction post-condition held"); } catch (e) { expect(false, "part-1 rollback raised: " + first(e)); }
  log("   state: " + JSON.stringify((await db.query(RB.slice(RB.lastIndexOf("SELECT jsonb_build_object(")))).rows[0].state));
  const post = (await one(db, snapSql)).s;
  const keys = Object.keys(pre).filter((k) => JSON.stringify(pre[k]) !== JSON.stringify(post[k]));
  expect(keys.length === 0, `catalog after apply → rollback = before apply (anon map, every policy incl. storage, both matrices, every default ACL, every public function ACL) ${keys.length ? "DIFF: " + keys.join(",") + " " + JSON.stringify(keys.map((k) => [pre[k], post[k]])).slice(0, 600) : ""}`);
  try { await db.exec(RB); expect(false, "second rollback did NOT refuse"); } catch (e) { expect(/anon already holds/.test(first(e)), "second rollback refused: " + first(e)); }
  try { await db.exec(MIG); expect(true, "re-apply after rollback: preflight pins match again, migration ran"); } catch (e) { expect(false, "re-apply raised: " + first(e)); }
  const r = await runRetest(db, RET); expect(/ 0 failed/.test(tail(r)), "RETEST after re-apply: " + tail(r));
  await db.close(); }
for (const [label, from, to, want] of [
  ["a forgotten re-GRANT", `  GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public."certs" TO anon;\n`, "", /not the captured set/],
  ["a re-GRANT wider than captured", `  GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON TABLE public."equipment_issues" TO anon;`, `  GRANT ALL ON TABLE public."equipment_issues" TO anon;`, /not the captured set/],
  ["a policy left TO authenticated", `  ALTER POLICY "dept reads ai_outputs" ON public."ai_outputs" TO public;\n`, "", /not back to its original definition/],
  ["a policy rolled back with a new predicate", `  ALTER POLICY "dept reads ai_outputs" ON public."ai_outputs" TO public;`, `  ALTER POLICY "dept reads ai_outputs" ON public."ai_outputs" TO public USING (true);`, /row counts changed|not back to its original/],
  ["the anon table default not restored", `  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;\n`, "", /public default for r is not the captured set/],
  ["the global PUBLIC function default not restored", `  ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;\n`, "", /global postgres default is left/],
]) {
  const db = await fresh(); const MIG = (await localize(db, MIG0)).sql, RB = await rbFor(db);
  await db.exec(MIG);
  const parts = RB.split(from); if (parts.length !== 2) { expect(false, `${label}: mutation anchor found ${parts.length - 1}×`); await db.close(); continue; }
  let msg = "ran"; try { await db.exec(parts.join(to)); } catch (e) { msg = first(e); }
  const anon = (await one(db, `SELECT count(*) n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'anon'::regrole`)).n;
  expect(want.test(msg) && Number(anon) === 0, `mutated rollback, ${label} → ${msg.slice(0, 130)}  [rolled back: still the applied state, ${anon} anon entries]`);
  await db.close();
}
log(`\n${unexpected === 0 ? "ALL EXPECTED" : unexpected + " UNEXPECTED"}`);
process.exitCode = unexpected ? 1 : 0;
