// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/l2_l4_dryrun_harness.mjs
// DRY RUN for sql/l2_departments_scope_* and sql/l4_role_helpers_scope_* (DRAFT, RETEST, ROLLBACK) — NOT the live DB.
// Mock: every one of the 85 relations authenticated may read, by its LIVE name; departments with its two LIVE policies
// (text from docs/review/l2_l4_LIVEDEFS.json — their md5 pins must reproduce); announcements with its live SELECT + INSERT
// shapes; training_session_audit with the live is_leadership() policy; the LIVE bodies of my_department_id, my_member_id,
// is_leader, is_dept_admin, is_leadership, is_department_admin, is_announcer, is_equipment_manager, is_project_admin (their
// md5 pins must reproduce); dept_on_station_now() as an is_leadership()-gated DEFINER RPC (the RETEST's probe).
// The table-privilege and EXECUTE matrix md5s span the 93 live objects / 228 live functions and cannot reproduce in a mock;
// the harness substitutes the mock's own values for those five pins (labelled below). Every other pin is the live value.
// Runs, per migration, each on a fresh database: pins reproduce → migration → state row → re-run refuses → RETEST →
// ROLLBACK round trip → drift refusals → mutations (the in-transaction proof must roll back) → post-apply drift (RETEST catches).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/l2_l4_LIVEDEFS.json"), "utf8"));
const rd = (p) => readFileSync(join(root, p), "utf8");
const SQL = {
  l2: rd("sql/l2_departments_scope_DRAFT.sql"), l2r: rd("sql/l2_departments_scope_RETEST.sql"), l2b: rd("sql/l2_departments_scope_ROLLBACK.sql"),
  l4: rd("sql/l4_role_helpers_scope_DRAFT.sql"), l4r: rd("sql/l4_role_helpers_scope_RETEST.sql"), l4b: rd("sql/l4_role_helpers_scope_ROLLBACK.sql"),
};
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); cond ? pass++ : fail++; };
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", C = "00000000-0000-0000-0000-00000000000c";
const special = new Set(["departments", "members", "member_active_department", "equipment_manager", "station_presence", "announcements", "training_session_audit"]);
const SEL = L.departments.policies.find((p) => p.cmd === "SELECT"), UPD = L.departments.policies.find((p) => p.cmd === "UPDATE");
const FN = ["my_department_id", "my_member_id", "is_project_admin", "is_dept_admin", "is_leader", "is_leadership", "is_department_admin", "is_announcer", "is_equipment_manager"];

const schema = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL,
  access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, email text);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE member_separation (member_id uuid PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE equipment_manager (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, department_id uuid, removed_at timestamptz);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, verified boolean NOT NULL DEFAULT false);
CREATE TABLE announcements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, audience text DEFAULT 'everyone', expires_on date, author_id uuid);
CREATE TABLE training_session_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid);
${L.rels.filter((r) => !special.has(r)).map((r) => `CREATE TABLE public.${ident(r)} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid);`).join("\n")}
${FN.map((f) => L.fns[f].def + ";").join("\n")}
CREATE FUNCTION public.dept_on_station_now() RETURNS TABLE (member_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN IF NOT public.is_leadership() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  RETURN QUERY SELECT sp.id FROM public.station_presence sp WHERE sp.department_id = public.my_department_id(); END $$;
REVOKE ALL ON public.member_separation FROM authenticated, service_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;   -- live: anon executes nothing in public (a per-schema default REVOKE can't remove PUBLIC's global EXECUTE)
${["departments", "members", "member_active_department", "member_separation", "equipment_manager", "station_presence", "announcements", "training_session_audit", ...L.rels.filter((r) => !special.has(r))].map((r) => `ALTER TABLE public.${ident(r)} ENABLE ROW LEVEL SECURITY;`).join("\n")}
SET search_path = public, pg_catalog;
CREATE POLICY ${ident(SEL.name)} ON public.departments AS ${SEL.permissive} FOR SELECT TO authenticated USING (${SEL.qual});
CREATE POLICY ${ident(UPD.name)} ON public.departments AS ${UPD.permissive} FOR UPDATE TO authenticated USING (${UPD.qual}) WITH CHECK (${UPD.with_check});
CREATE POLICY "read announcements for my audience" ON public.announcements FOR SELECT TO authenticated
  USING ((department_id = my_department_id()) AND ((audience = 'everyone'::text) OR is_leader()) AND ((expires_on IS NULL) OR (expires_on >= CURRENT_DATE) OR is_department_admin() OR (author_id = my_member_id())));
CREATE POLICY "announcers insert announcements" ON public.announcements FOR INSERT TO authenticated
  WITH CHECK ((department_id = my_department_id()) AND (author_id = my_member_id()) AND is_announcer());
CREATE POLICY "leadership reads training_session_audit" ON public.training_session_audit FOR SELECT TO authenticated USING ((department_id = my_department_id()) AND is_leadership());
${["members", "member_active_department", "equipment_manager", "station_presence", ...L.rels.filter((r) => !special.has(r))].map((r) => `CREATE POLICY "mock dept read" ON public.${ident(r)} FOR SELECT TO authenticated USING (${r === "member_active_department" ? "email = lower(auth.email())" : "department_id = my_department_id()"});`).join("\n")}
INSERT INTO departments VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)'), ('${C}', 'Charlie (mock, nobody)');
INSERT INTO members (department_id, name, email, access, status) VALUES
  ('${A}', 'A DA', 'da@a.test', '{Department Admin}', 'Active'), ('${A}', 'A FF', 'ff@a.test', '{Member}', 'Active'),
  ('${A}', 'A officer', 'off@a.test', '{Officer}', 'Active'), ('${A}', 'A gone', 'gone@a.test', '{Member}', 'Inactive'),
  ('${B}', 'B DA', 'da@b.test', '{Department Admin}', 'Active'), ('${B}', 'B FF', 'ff@b.test', '{Member}', 'Probationary'), ('${B}', 'B FF2', 'ff2@b.test', '{}', 'Active'),
  ('${B}', 'B board', 'board@b.test', '{Board Member}', 'Active');
INSERT INTO member_separation SELECT id, department_id FROM members WHERE email = 'gone@a.test';
INSERT INTO equipment_manager (member_id, department_id) SELECT id, department_id FROM members WHERE email = 'off@a.test';
INSERT INTO station_presence (department_id, verified) VALUES ('${A}', true), ('${A}', false), ('${B}', true);
INSERT INTO announcements (department_id, audience) VALUES ('${A}', 'everyone'), ('${A}', 'leaders'), ('${B}', 'everyone');
INSERT INTO training_session_audit (department_id) VALUES ('${A}'), ('${A}'), ('${B}');
${L.rels.filter((r) => !special.has(r)).map((r) => `INSERT INTO public.${ident(r)} (department_id) VALUES ('${A}'), ('${A}'), ('${B}');`).join("\n")}
RESET search_path;
`;

// The five matrix pins can't reproduce in a mock: swap the live values for the mock's own (labelled in the header).
const mtx = (role) => `SELECT md5(string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type)) AS v FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND a.grantee = '${role}'::regrole`;
const exe = (role) => `SELECT md5(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text)) AS v FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND has_function_privilege('${role}', p.oid, 'EXECUTE')`;
let SUB = null;
async function fresh() {
  const db = new PGlite();
  await db.exec(schema);
  const v = async (s) => (await db.query(s)).rows[0].v;
  if (!SUB) SUB = [[L.matrices.auth_tables, await v(mtx("authenticated"))], [L.matrices.service_tables, await v(mtx("service_role"))],
                   [L.matrices.exec.authenticated, await v(exe("authenticated"))], [L.matrices.exec.service_role, await v(exe("service_role"))]];
  return db;
}
const sub = (s) => SUB.reduce((a, [live, mock]) => a.split(live).join(mock), s);
async function run(db, sql) { try { const r = await db.exec(sub(sql)); return { ok: true, rows: r.at(-1)?.rows }; } catch (e) { return { ok: false, msg: String(e.message || e) }; } }
const report = async (db, sql) => { const r = await run(db, sql); return r.ok ? "(no report raised)" : r.msg; };
const counts = (rep) => { const m = /(\d+) passed, (\d+) failed, (\d+) skipped/.exec(rep); return m ? { p: +m[1], f: +m[2], s: +m[3] } : null; };
const val = async (db, s) => Object.values((await db.query(s)).rows[0] || {})[0];
const pinOf = (name) => `SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = '${name}'`;
const polPin = (name) => `SELECT md5(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')) FROM pg_policies p WHERE p.tablename = 'departments' AND p.policyname = '${name.replace(/'/g, "''")}'`;
async function asq(db, email, sql) { await db.exec("BEGIN"); await db.query(`SELECT set_config('request.jwt.claims', '{"email":"${email}"}', true)`); await db.exec("SET LOCAL ROLE authenticated"); try { return Object.values((await db.query(sql)).rows[0])[0]; } finally { await db.exec("ROLLBACK"); } }

// ================================================================ pins reproduce
{
  const db = await fresh();
  ok("pins reproduce in the mock: both departments policies (md5 over the full definition)", (await val(db, polPin(SEL.name))) === SEL.md5 && (await val(db, polPin(UPD.name))) === UPD.md5);
  const drift = [];
  for (const f of FN) if ((await val(db, pinOf(f))) !== L.fns[f].md5) drift.push(f);
  ok(`pins reproduce in the mock: all ${FN.length} helper functions (md5 of pg_get_functiondef, created from the LIVE text)`, drift.length === 0, drift.join(","));
}

// ================================================================ L-2
console.log("\n— L-2 departments scope");
{
  const db = await fresh();
  ok("before: a DA reads all 3 mock departments; a stranger reads all 3 (the finding)", (await asq(db, "da@a.test", "SELECT count(*)::int FROM departments")) === 3 && (await asq(db, "nobody@x.test", "SELECT count(*)::int FROM departments")) === 3);
  const r = await run(db, SQL.l2);
  ok("L-2 migration applies (preflight + in-transaction proof pass) and returns its state row", r.ok, r.msg || JSON.stringify(r.rows?.[0]?.state));
  ok("after: DA of Alpha reads 1 department (Alpha); member of Bravo reads 1 (Bravo); stranger 0",
    (await asq(db, "da@a.test", "SELECT string_agg(name, ',') FROM departments")) === "Alpha (mock)" && (await asq(db, "ff@b.test", "SELECT string_agg(name, ',') FROM departments")) === "Bravo (mock)" && (await asq(db, "nobody@x.test", "SELECT count(*)::int FROM departments")) === 0);
  ok("after: every other relation unchanged for a DA (certs 2 rows for Alpha's DA, as before)", (await asq(db, "da@a.test", "SELECT count(*)::int FROM certs")) === 2);
  const re = await run(db, SQL.l2);
  ok("re-run refuses (already applied), changes nothing", !re.ok && /looks applied/.test(re.msg), re.msg?.slice(0, 100));
  const rep = await report(db, SQL.l2r), c = counts(rep);
  console.log(rep);
  ok("RETEST: 0 failed (O1 O2 + per department T1 T2 T3 T4; Charlie has nobody → skips)", c && c.f === 0 && c.p >= 10, rep.replace(/\n/g, " | ").slice(0, 400));
  const rb = await run(db, SQL.l2b);
  ok("ROLLBACK: puts USING (true) back and proves the captured md5", rb.ok && (await val(db, polPin(SEL.name))) === SEL.md5, rb.msg);
  ok("ROLLBACK refuses a second time (not in the applied state)", !(await run(db, SQL.l2b)).ok);
  ok("re-apply after rollback passes preflight again", (await run(db, SQL.l2)).ok);
  const rep2 = await report(db, SQL.l2r);
  await db.exec(`SET search_path = public, pg_catalog; ALTER POLICY ${ident(SEL.name)} ON public.departments USING (true); RESET search_path;`);
  const rep3 = await report(db, SQL.l2r), c3 = counts(rep3);
  ok("post-apply drift (policy quietly put back to USING (true)) → RETEST FAILs", c3 && c3.f > 0 && counts(rep2).f === 0, rep3.replace(/\n/g, " | ").slice(0, 200));
}
// drift refusals
const l2Refuse = [
  ["the SELECT policy drifted (another predicate)", `SET search_path = public, pg_catalog; ALTER POLICY ${ident(SEL.name)} ON public.departments USING (name IS NOT NULL); RESET search_path;`, /drifted/],
  ["the UPDATE policy drifted", `SET search_path = public, pg_catalog; ALTER POLICY ${ident(UPD.name)} ON public.departments USING (is_dept_admin()); RESET search_path;`, /drifted/],
  ["a third departments policy appeared", `CREATE POLICY "extra" ON public.departments FOR SELECT TO authenticated USING (false);`, /exactly 2 policies/],
  ["FORCE ROW LEVEL SECURITY turned on", `ALTER TABLE public.departments FORCE ROW LEVEL SECURITY;`, /FORCE off/],
  ["my_department_id() drifted", L.fns.my_department_id.def.replace("limit 1", "limit 2") + ";", /my_department_id\(\) drifted/],
  ["someone has member rows in two departments", `INSERT INTO members (department_id, name, email, access) VALUES ('${B}', 'A DA twin', 'da@a.test', '{Member}');`, /more than one department/],
  ["authenticated lost a grant (matrix drift)", `REVOKE SELECT ON public.certs FROM authenticated;`, /table privileges drifted/],
];
for (const [what, pre, re] of l2Refuse) {
  const db = await fresh(); await db.exec(pre); const r = await run(db, SQL.l2);
  ok(`L-2 preflight refuses: ${what}`, !r.ok && re.test(r.msg) && (await val(db, polPin(SEL.name))) !== "x", r.msg?.slice(0, 110));
}
// mutations: the migration's own change is wrong → the in-transaction proof must roll it back
const ALTER = `1. the change\n  ALTER POLICY "${SEL.name}" ON public.departments USING (id = public.my_department_id());`;   // anchored on the code line, not the header comment
const l2Mut = [
  ["the new predicate still lets everyone read (id = my_department_id() OR true)", (s) => s.replace(ALTER, ALTER.replace("my_department_id())", "my_department_id() OR true)")), /should read departments/],
  ["the new predicate is too narrow (false)", (s) => s.replace(ALTER, ALTER.replace("(id = public.my_department_id())", "(false)")), /should read departments/],
  ["a stranger-shaped hole (id = my_department_id() OR auth.email() LIKE '%invalid%')", (s) => s.replace(ALTER, ALTER.replace("my_department_id())", "my_department_id() OR auth.email() LIKE '%invalid%')")), /stranger still reads/],
  ["it also loosens another table's policy", (s) => s.replace(ALTER, ALTER + `\n  ALTER POLICY "mock dept read" ON public.certs USING (true);`), /certs changed|another public policy/],
  ["it also edits the UPDATE policy", (s) => s.replace(ALTER, ALTER + `\n  ALTER POLICY "${UPD.name}" ON public.departments USING (is_dept_admin());`), /UPDATE policy changed/],
  ["it also revokes a grant", (s) => s.replace(ALTER, ALTER + `\n  REVOKE SELECT ON public.events FROM service_role;`), /privilege or EXECUTE matrix/],
  ["it also replaces a function", (s) => s.replace(ALTER, ALTER + `\n  CREATE OR REPLACE FUNCTION public.dept_on_station_now() RETURNS TABLE (member_id uuid) LANGUAGE sql AS $f$ select null::uuid $f$;`), /a public function changed/],
];
for (const [what, mut, re] of l2Mut) {
  const db = await fresh(); const m = mut(SQL.l2);
  if (m === SQL.l2) { ok(`L-2 mutation applies: ${what}`, false, "mutation did not change the SQL"); continue; }
  const r = await run(db, m);
  ok(`L-2 proof catches + rolls back: ${what}`, !r.ok && re.test(r.msg) && (await val(db, polPin(SEL.name))) === SEL.md5, r.msg?.slice(0, 120));
}

// ================================================================ L-4
console.log("\n— L-4 role helpers scope");
{
  const db = await fresh();
  const pre = await report(db, SQL.l4r), cp = counts(pre);
  ok("RETEST on the UNMIGRATED database fails S0 and X1 (it has teeth: the DA acting in another department is still a leader)", cp && cp.f >= 2 && /FAIL  X1/.test(pre) && /FAIL  S0/.test(pre), pre.replace(/\n/g, " | ").slice(0, 300));
  const r = await run(db, SQL.l4);
  ok("L-4 migration applies (preflight + in-transaction proof pass) and returns its state row", r.ok, r.msg || "");
  const re = await run(db, SQL.l4);
  ok("re-run refuses (already applied)", !re.ok && /looks applied/.test(re.msg), re.msg?.slice(0, 100));
  const rep = await report(db, SQL.l4r), c = counts(rep);
  console.log(rep);
  ok("RETEST: 0 failed — S0, H1 (DA / officer / member at home), X1 (synthesized second department: all three false, RPC refused, audit 0; home again: true)",
    c && c.f === 0 && /PASS  X1 the DA acting in another department/.test(rep) && /PASS  X1 back home/.test(rep), rep.replace(/\n/g, " | ").slice(0, 600));
  ok("RETEST rolled everything back (no synthetic member row left, member_active_department empty)", (await val(db, "SELECT count(*)::int FROM members")) === 8 && (await val(db, "SELECT count(*)::int FROM member_active_department")) === 0);
  const rb = await run(db, SQL.l4b);
  const back = []; for (const f of ["is_leadership", "is_department_admin", "is_announcer"]) if ((await val(db, pinOf(f))) !== L.fns[f].md5) back.push(f);
  ok("ROLLBACK: all three back to their captured md5 + ACL", rb.ok && back.length === 0, rb.msg || back.join(","));
  ok("ROLLBACK refuses a second time", !(await run(db, SQL.l4b)).ok);
  ok("re-apply after rollback passes", (await run(db, SQL.l4)).ok);
  await db.exec(L.fns.is_announcer.def + ";");
  const rep3 = await report(db, SQL.l4r), c3 = counts(rep3);
  ok("post-apply drift (is_announcer quietly put back role-anywhere) → RETEST FAILs (S0 and X1)", c3 && c3.f >= 2, rep3.replace(/\n/g, " | ").slice(0, 200));
}
{ // the synthesized multi-department case, directly: before vs after
  const db = await fresh();
  const twin = `INSERT INTO members (department_id, name, email, access) VALUES ('${B}', 'A officer in B', 'off@a.test', '{Member}'); INSERT INTO member_active_department VALUES ('off@a.test', '${B}');`;
  await db.exec("BEGIN"); await db.exec(twin);
  const before = await val(db, `SELECT set_config('request.jwt.claims', '{"email":"off@a.test"}', true) || (SELECT is_leadership()::text || is_announcer()::text)`);
  await db.exec("ROLLBACK");
  await run(db, SQL.l4);
  await db.exec("BEGIN"); await db.exec(twin);
  const after = await val(db, `SELECT set_config('request.jwt.claims', '{"email":"off@a.test"}', true) || (SELECT is_leadership()::text || is_announcer()::text)`);
  await db.exec("ROLLBACK");
  ok("THE FIX, directly: an Officer of Alpha acting in Bravo (member there) — before: leadership+announcer true; after: both false",
    before.endsWith("truetrue") && after.endsWith("falsefalse"), `${before.slice(-9)} → ${after.slice(-10)}`);
}
const l4Refuse = [
  ["is_leadership() drifted", L.fns.is_leadership.def.replace("'Officer'", "'Officer','Chief'") + ";", /is_leadership\(\) drifted/],
  ["is_leader() (what it will delegate to) drifted", L.fns.is_leader.def.replace("'Officer'", "'Officer','Chief'") + ";", /is_leader\(\) drifted/],
  ["is_equipment_manager() drifted", L.fns.is_equipment_manager.def.replace("em.removed_at is null", "true") + ";", /is_equipment_manager\(\) drifted/],
  ["someone has member rows in two departments", `INSERT INTO members (department_id, name, email, access) VALUES ('${B}', 'officer twin', 'off@a.test', '{Member}');`, /more than one department/],
  ["anon can execute a public function", `GRANT EXECUTE ON FUNCTION public.is_leader() TO anon;`, /EXECUTE matrices drifted/],
];
for (const [what, pre, re] of l4Refuse) {
  const db = await fresh(); await db.exec(pre); const r = await run(db, SQL.l4);
  ok(`L-4 preflight refuses: ${what}`, !r.ok && re.test(r.msg), r.msg?.slice(0, 110));
}
const LEAD = "  select public.is_leader();\n";
const l4Mut = [
  ["is_leadership becomes `select true` (wider than before)", (s) => s.replace(LEAD, "  select true;\n"), /helper answer changed/],
  ["is_leadership becomes is_dept_admin (narrower: Officers / Board lose it)", (s) => s.replace(LEAD, "  select public.is_dept_admin();\n"), /helper answer changed/],
  ["is_announcer loses Officer", (s) => s.replace("and access && array['Department Admin','Project Admin','Officer']::text[]\n  );\n$function$;", "and access && array['Department Admin','Project Admin']::text[]\n  );\n$function$;"), /helper answer changed/],
  ["it also revokes EXECUTE on a helper from authenticated", (s) => s.replace("  -- ---------------------------------------------------------------- 2. post-conditions", "  REVOKE EXECUTE ON FUNCTION public.is_leadership() FROM authenticated;\n  -- ---------------------------------------------------------------- 2. post-conditions"), /permission denied|helper answer changed|ACL changed|EXECUTE matrix/],
  ["it also loosens a policy", (s) => s.replace("  -- ---------------------------------------------------------------- 2. post-conditions", `  ALTER POLICY "mock dept read" ON public.events USING (true);\n  -- ---------------------------------------------------------------- 2. post-conditions`), /row counts changed|a public policy changed/],
  ["it also replaces another function", (s) => s.replace("  -- ---------------------------------------------------------------- 2. post-conditions", "  CREATE OR REPLACE FUNCTION public.dept_on_station_now() RETURNS TABLE (member_id uuid) LANGUAGE sql AS $f$ select null::uuid $f$;\n  -- ---------------------------------------------------------------- 2. post-conditions"), /other than the three changed/],
  ["it makes a helper VOLATILE", (s) => s.replace("  -- ---------------------------------------------------------------- 2. post-conditions", "  ALTER FUNCTION public.is_announcer() VOLATILE;\n  -- ---------------------------------------------------------------- 2. post-conditions"), /not exactly the generated body/],
];
for (const [what, mut, re] of l4Mut) {
  const db = await fresh(); const m = mut(SQL.l4);
  if (m === SQL.l4) { ok(`L-4 mutation applies: ${what}`, false, "mutation did not change the SQL"); continue; }
  const r = await run(db, m);
  const intact = []; for (const f of ["is_leadership", "is_department_admin", "is_announcer"]) if ((await val(db, pinOf(f))) !== L.fns[f].md5) intact.push(f);
  ok(`L-4 proof catches + rolls back: ${what}`, !r.ok && re.test(r.msg) && intact.length === 0, r.msg?.slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
