// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/cert_expiry_valid_ym_dryrun_harness.mjs [pin]
// HAPPY_DOM_DIR=<dir with happy-dom installed> (for the real client certStatus, bundled from src/App.jsx)
// PGlite dry run for sql/cert_expiry_valid_ym_DRAFT.sql (the helper + 7 functions + the 7-row data cleanup, one block) +
// sql/cert_expiry_valid_ym_RETEST.sql. No network, no live DB. The base is a mock Supabase rebuilt from LIVE: the 7 cert functions VERBATIM from
// docs/review/cert_expiry_malformed_STEP0_OUTPUT.json (their md5s reproduce byte-identically — printed first), the shared gates
// from the Training Officers Step 0 output (origin/feat/training-officers-step0), the live certs policies, and the 7 malformed
// rows under their real ids / departments (STEP0B cleanup_targets) next to well-formed certs.
//   pin      — run once with the md5 post-checks stripped, write the 8 reviewed md5s into the DRAFT / RETEST
//   default  — client <-> SQL: the validator on 30 inputs, then STATUS — the real client certStatus() vs dept_cert_readiness()
//              and expiration_rows() per cert, plain and with a never-expires type; probe of the reported bug before / after;
//              RETEST before (must fail); apply + state; re-run (refused); RETEST after; then the mutations: each REFUSED by
//              the migration, or (post-conditions stripped) caught by the RETEST.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { execSync } from "child_process";
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const root = fileURLToPath(new URL("../../", import.meta.url));
const MIG_PATH = join(root, "sql/cert_expiry_valid_ym_DRAFT.sql"), RET_PATH = join(root, "sql/cert_expiry_valid_ym_RETEST.sql");
let mig = readFileSync(MIG_PATH, "utf8"), ret = readFileSync(RET_PATH, "utf8");
const S0 = JSON.parse(readFileSync(join(root, "docs/review/cert_expiry_malformed_STEP0_OUTPUT.json"), "utf8"));
const S0B = JSON.parse(readFileSync(join(root, "docs/review/cert_expiry_malformed_STEP0B_OUTPUT.json"), "utf8"));
const TO = JSON.parse(execSync("git show origin/feat/training-officers-step0:docs/review/training_officers_STEP0_OUTPUT.json", { cwd: root, maxBuffer: 1 << 24 }).toString());
const { validExpYM } = await import(pathToFileURL(join(root, "shared/expiry.js")).href);
const FNS = ["dept_cert_readiness()", "pa_department_radar()", "my_department_rollup()", "expiration_rows(uuid,uuid)", "probation_item_states(uuid,uuid)", "update_cert(uuid,text,text)", "approve_cert_submission(uuid)"];
const KEYS = { "valid_exp_ym(text)": "HELPER", "dept_cert_readiness()": "READINESS", "pa_department_radar()": "RADAR", "my_department_rollup()": "ROLLUP",
  "expiration_rows(uuid,uuid)": "EXPROWS", "probation_item_states(uuid,uuid)": "PROBATION", "update_cert(uuid,text,text)": "UPDATE", "approve_cert_submission(uuid)": "APPROVE" };
const A = "00000000-0000-0000-0000-00000000000a";                      // Indian Harbor (stand-in)
const Z = "00000000-0000-0000-0000-00000000000f", ZNX = "20000000-0000-0000-0000-00000000000f";   // an empty department for the per-cert status check
const NH = "6d51b00a-bdb0-4807-8e45-70bb53d4dcff", DEMO = "94667450-481c-4f40-a6b6-86e1b364be93";   // the real ids (the cleanup pins them)
const T = S0B.cleanup_targets;
const mock = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select ((nullif(current_setting('request.jwt.claims', true), '')::json)->>'sub')::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated; GRANT SELECT ON auth.users TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text, station text, city text, tagline text, voice text, primary_color text, accent_color text);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active',
  created_at timestamptz DEFAULT now(), mentor_id uuid);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE cert_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, name text, never_expires boolean DEFAULT false);
CREATE TABLE certs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, member_id uuid, name text, exp text, created_at timestamptz DEFAULT now(),
  proof_path text, cert_type_id uuid);
CREATE TABLE cert_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, member_id uuid, name text, exp text, status text DEFAULT 'pending',
  source text, note text, proposed_by uuid, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz DEFAULT now(), proof_path text);
CREATE TABLE session_attendance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, member_id uuid, department_id uuid, checked_in_at timestamptz);
CREATE TABLE duty_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, done_at timestamptz, done_by uuid);
CREATE TABLE action_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, created_at timestamptz, completed_by uuid, completed_at timestamptz, status text);
CREATE TABLE documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, created_at timestamptz, deleted_at timestamptz, archived_at timestamptz, content_text text);
CREATE TABLE announcements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, created_at timestamptz);
CREATE TABLE training_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, created_at timestamptz, date date, title text, done boolean,
  counts_toward_attendance boolean, audience text);
CREATE TABLE apparatus (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, name text, deleted_at timestamptz);
CREATE TABLE duties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, done boolean, due_date date, assigned_to uuid);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, checked_in_at timestamptz, checked_out_at timestamptz);
CREATE TABLE funding_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, date date, title text);
CREATE TABLE recruitment_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, date date, title text);
CREATE TABLE content_calendar (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, date date, caption text);
CREATE TABLE member_separation (member_id uuid PRIMARY KEY);
CREATE TABLE member_credentials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, department_id uuid, kind text, label text, cls text, expires_on date);
CREATE TABLE gear_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, department_id uuid, label text, next_inspection_on date, in_service_on date, retired_at timestamptz);
CREATE TABLE apparatus_tests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), apparatus_id uuid, department_id uuid, test_type text, next_due_on date);
CREATE TABLE onboarding_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, label text, category text, phase text, kind text, clears_to_run boolean,
  sort_order int, is_mentor boolean DEFAULT false, hours_target numeric, hours_source text, cert_name text, approver_kind text, approver_member_id uuid,
  approver_role text, requires_doc boolean DEFAULT false, ack_series_id uuid);
CREATE TABLE member_probation (member_id uuid PRIMARY KEY, started_on date);
CREATE TABLE onboarding_progress (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, item_id uuid, done boolean, checked_by uuid, checked_at timestamptz, ready_at timestamptz);
CREATE TABLE document_series (series_id uuid PRIMARY KEY, department_id uuid, requires_ack boolean, current_version int, required_roles text[], annual_resign boolean);
CREATE TABLE document_acknowledgments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, series_id uuid, version int, signed_at timestamptz);
CREATE TABLE supervised_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, department_id uuid, voided_at timestamptz, hours numeric, kind text);
${TO.gates["my_department_id()"].def};
${TO.gates["my_member_id()"].def};
${TO.gates["is_dept_admin()"].def};
CREATE FUNCTION public.is_project_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  select exists (select 1 from public.members where lower(email) = lower(auth.email()) and status in ('Active','Probationary') and access && array['Project Admin']::text[]) $f$;
CREATE FUNCTION public.is_leader() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  select exists (select 1 from public.members where lower(email) = lower(auth.email()) and department_id = public.my_department_id()
                  and access && array['Project Admin','Department Admin','Board Member','Officer']::text[]) $f$;
CREATE FUNCTION public.rs_member_in_audience(p_member uuid, p_roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $f$ select true $f$;
CREATE FUNCTION public.lockedtok() RETURNS text LANGUAGE sql AS $f$ select 'is verified' $f$;
CREATE FUNCTION public.touch_member() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
CREATE TRIGGER members_touch BEFORE UPDATE ON members FOR EACH ROW EXECUTE FUNCTION touch_member();
${FNS.map((k) => S0.readers[k].def + ";").join("\n")}
REVOKE EXECUTE ON FUNCTION public.expiration_rows(uuid,uuid), public.probation_item_states(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dept_cert_readiness(), public.pa_department_radar(), public.my_department_rollup(), public.update_cert(uuid,text,text),
  public.approve_cert_submission(uuid), public.my_department_id(), public.my_member_id(), public.is_dept_admin(), public.is_project_admin(), public.is_leader() FROM PUBLIC, anon;
ALTER TABLE certs ENABLE ROW LEVEL SECURITY; ALTER TABLE cert_submissions ENABLE ROW LEVEL SECURITY;
${S0B.certs_policies.map((p) => { const [name, cmd, qual, wc] = p.split(" | "); const t = /submission/.test(name) ? "cert_submissions" : "certs";
  return `CREATE POLICY "${name}" ON public.${t} FOR ${cmd} TO public${qual ? ` USING (${qual})` : ""}${wc ? ` WITH CHECK (${wc})` : ""};`; }).join("\n")}
INSERT INTO departments (id, name) VALUES ('${A}','Indian Harbor Volunteer Fire Department'),('${NH}','North Hood County Volunteer Fire Department'),('${DEMO}','B4C Demo Department'),
  ('${Z}','Zulu (status probe)');
INSERT INTO cert_types (id, department_id, name, never_expires) VALUES ('${ZNX}', '${Z}', 'Boaters Ed (never expires)', true);
INSERT INTO members (id, department_id, email, name, access) VALUES
  ('10000000-0000-0000-0000-00000000000a','${A}','ada@a','Ada DA','{Department Admin}'), (gen_random_uuid(),'${A}','mo@a','Mo Member','{Member}'),
  ('10000000-0000-0000-0000-0000000000b0','${NH}','bob@nh','Bob DA','{Department Admin}'), ('10000000-0000-0000-0000-0000000000b1','${NH}','boater@nh','Boater','{Member}'),
  ('10000000-0000-0000-0000-0000000000d0','${DEMO}','dee@demo','Dee DA','{Department Admin}'), ('10000000-0000-0000-0000-0000000000d1','${DEMO}','dan@demo','Dan Demo','{Member}'),
  (gen_random_uuid(),'${A}','pa@x','Pat Project Admin','{Project Admin}'), ('10000000-0000-0000-0000-0000000000f0','${Z}','zed@z','Zed DA','{Department Admin}');
INSERT INTO auth.users (id, email) SELECT gen_random_uuid(), email FROM members;
INSERT INTO certs (id, department_id, member_id, name, exp) VALUES
${T.map((t) => `  ('${t.id}', '${t.dept_id}', '${t.dept_id === NH ? "10000000-0000-0000-0000-0000000000b1" : "10000000-0000-0000-0000-0000000000d1"}', 'cert ${t.exp}', '${t.exp}')`).join(",\n")},
  (gen_random_uuid(), '${NH}', '10000000-0000-0000-0000-0000000000b1', 'FF I', '2028-04'), (gen_random_uuid(), '${NH}', '10000000-0000-0000-0000-0000000000b1', 'CPR', NULL),
  (gen_random_uuid(), '${A}', '10000000-0000-0000-0000-00000000000a', 'EMT', '2025-01'), (gen_random_uuid(), '${DEMO}', '10000000-0000-0000-0000-0000000000d1', 'Hazmat', '2027-11');
`;
async function base(extra = "") { const d = new PGlite(); await d.exec(mock); if (extra) await d.exec(extra); return d; }
const md = async (d, f) => (await d.query(`select md5(pg_get_functiondef('public.${f}'::regprocedure)) m`)).rows[0].m;
const NOPIN = (s) => s.replace(/  -- \[md5-pin\][\s\S]*?  -- \[\/md5-pin\]\n/, "").replace(/@@MD5_[A-Z]+@@/g, "x");

{ const d = await base();
  for (const k of FNS) { const h = await md(d, k); console.log(`${k}: live ${S0.readers[k].md5} · here ${h}${h === S0.readers[k].md5 ? "" : "  <-- MISMATCH"}`); } }

if (process.argv[2] === "pin") {
  const d = await base(); await d.exec(NOPIN(mig));
  const pins = {}; for (const k of Object.keys(KEYS)) pins[KEYS[k]] = await md(d, k);
  const fill = (s) => s.replace(/@@MD5_([A-Z]+)@@/g, (_, k) => pins[k]);
  writeFileSync(MIG_PATH, fill(mig)); writeFileSync(RET_PATH, fill(ret));
  console.log("pinned", JSON.stringify(pins)); process.exit(0);
}
if ([mig, ret].some((s) => s.includes("@@MD5_"))) throw new Error("unpinned — run with `pin` first");
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).map((l) => l.trim().slice(0, 170)).join(" | ");
const sub = (a, b, s = mig) => { if (s.split(a).length !== 2) throw new Error("anchor not unique / missing: " + a.slice(0, 90)); return s.replace(a, () => b); };
const NOPOST = (s) => s.replace(/  -- -{10,} post-conditions[\s\S]*?\nEND\n\$migrate\$;/, "END\n$migrate$;");
const PC = "  -- ---------------------------------------------------------------- post-conditions\n  -- (1)";
const certsMd5 = async (d) => (await d.query("select md5(string_agg(c::text, ',' order by c.id)) m, count(*)::int n from certs c")).rows[0];

// client <-> SQL: the same answer for every input
{ const d = await base(); await d.exec(mig);
  const inputs = ["2027-06", "1900-01", "2026-12", "9999-12", "2000-10", "0000-00", "0000-01", "2026-00", "2026-13", "1899-12", "1899-06", "2026-09-15", "2026-1",
    "26-06", "TBD", " 2027-06", "2027-06 ", "", "２０２７-06", "٢٠٢٧-06", "2027-6", "2027-060", "20270-06", "2027_06", "2027-06\n", "1900-00", "1900-12", "1000-05", "2099-11", null];
  const sql = (await d.query("select v, public.valid_exp_ym(v) ok from unnest($1::text[]) v", [inputs])).rows;
  const diff = sql.filter((r) => r.ok !== validExpYM(r.v));
  console.log(`\nCLIENT <-> SQL (validExpYM vs valid_exp_ym, ${inputs.length} inputs incl. NULL, full-width and Arabic-Indic digits): ${diff.length === 0 ? "AGREE on all" : "DISAGREE: " + JSON.stringify(diff)}`); }

// client <-> SQL STATUS, per cert: the real certStatus() (src/App.jsx, bundled) vs dept_cert_readiness() (its SQL twin — same
// month window) and expiration_rows(), one cert at a time in an empty department, plain and with a never-expires type
{ const { build } = await import("esbuild");
  const hdReq = (await import("module")).createRequire(join(process.env.HAPPY_DOM_DIR, "package.json"));
  const { Window } = hdReq("happy-dom"); const win = new Window({ url: "https://app.test/" });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
    try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only */ } }
  const out = join(process.env.HAPPY_DOM_DIR, "cert-status.under-test.mjs");
  await build({ entryPoints: [join(root, "src/App.jsx")], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
    banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
    loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
    define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
    plugins: [{ name: "fakes", setup(b) {
      b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
      b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
      b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + "\nexport { certStatus };\n", loader: "jsx", resolveDir: join(root, "src") }));
    } }] });
  const { certStatus } = await import(pathToFileURL(out).href);
  const d = await base(); await d.exec(mig);
  const now = new Date(), ym = (k) => { const x = new Date(now.getFullYear(), now.getMonth() + k, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; };
  const vals = [null, "", "2026-09-15", "0000-00", "0000-01", "2026-00", "2026-13", "1899-12", "TBD", ym(-3), ym(-1), ym(0), ym(1), ym(3), ym(4), ym(24)];
  const LABEL = { "NO DATE": "no_date", EXPIRED: "expired", EXPIRING: "expiring", CURRENT: "current", "NO EXPIRY": "no_expiry" };
  const rows = [], bad = [];
  for (const nx of [false, true]) for (const v of vals) {
    const id = (await d.query(`insert into certs (department_id, member_id, name, exp, cert_type_id) values ('${Z}', '10000000-0000-0000-0000-0000000000f0', 'probe', $1, $2) returning id`, [v, nx ? ZNX : null])).rows[0].id;
    await d.exec(`select set_config('request.jwt.claims', '{"email":"zed@z"}', false); SET role authenticated;`);
    const r = (await d.query("select * from dept_cert_readiness()")).rows[0];
    await d.exec("RESET role;");
    const sqlB = ["current", "expiring", "expired", "no_date", "no_expiry"].filter((k) => r[k] === 1).join("+");
    const er = (await d.query(`select bucket from expiration_rows('${Z}', '10000000-0000-0000-0000-0000000000f0') where item_id = '${id}'`)).rows[0].bucket;
    await d.query(`delete from certs where id = '${id}'`);
    const cli = LABEL[certStatus(v, nx).label];
    // expiration_rows has day-precision buckets (soon / current); the client/readiness dimension it must share is no_date / expired / no_expiry
    const erOk = ["no_date", "expired", "no_expiry"].includes(cli) ? er === cli : ["soon", "current"].includes(er);
    rows.push(`${nx ? "never-expires " : ""}${v === null ? "NULL" : JSON.stringify(v)}: client ${cli} · readiness ${sqlB} · expiration_rows ${er}`);
    if (cli !== sqlB || !erOk) bad.push(rows.at(-1));
  }
  console.log(`\nCLIENT <-> SQL STATUS (real certStatus vs dept_cert_readiness + expiration_rows, ${rows.length} certs): ${bad.length === 0 ? "AGREE on all" : "DISAGREE on " + bad.length}`);
  for (const l of rows) console.log("  " + l + (bad.includes(l) ? "   <-- DISAGREE" : ""));
  await win.happyDOM?.abort?.(); }

{ const d = await base();
  try { await d.exec(ret); console.log("RETEST before the fix raised nothing?!"); } catch (e) { console.log("\nRETEST BEFORE THE FIX (must fail): " + e.message.split("\n")[0]); } }
// the reported bug, directly: North Hood's live '0000-00' row (the Boaters Ed Cert) through the readers, before and after
const probe = async (d) => {
  await d.exec(`select set_config('request.jwt.claims', '{"email":"bob@nh"}', false); SET role authenticated;`);
  const r = (await d.query("select expired, no_date from dept_cert_readiness()")).rows[0];
  const o = (await d.query(`select expired_certs_count x from my_department_rollup() where department_id = '${NH}'`)).rows[0];
  await d.exec("RESET role;");
  const b = (await d.query(`select bucket from expiration_rows('${NH}', '10000000-0000-0000-0000-0000000000b1') where item_id = '8599898a-0a71-4664-82ae-6e97ede8e7fe'`)).rows[0];
  const y = (await d.query(`insert into certs (department_id, member_id, name, exp) values ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'y0', '0000-01') returning id`)).rows[0].id;
  const yb = (await d.query(`select bucket from expiration_rows('${NH}', '10000000-0000-0000-0000-0000000000b1') where item_id = '${y}'`)).rows[0];
  await d.query(`delete from certs where id = '${y}'`);
  return `North Hood readiness expired ${r.expired} · no_date ${r.no_date} · rollup expired ${o.x} · expiration_rows '0000-00' ${b.bucket} · '0000-01' ${yb.bucket}`;
};
{ const d = await base(); console.log("PROBE BEFORE (the bug):", await probe(d)); await d.exec(mig); console.log("PROBE AFTER:           ", await probe(d)); }
{ const d = await base();
  const res = await d.exec(mig); const before = await certsMd5(d);
  console.log("\nAPPLY — state:", JSON.stringify(res.at(-1).rows));
  try { await d.exec(mig); console.log("re-run: applied twice?!"); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
  console.log("helper grants:", (await d.query("select proacl::text a from pg_proc where proname = 'valid_exp_ym'")).rows[0].a,
    "· plan:", (await d.query("explain (verbose, costs off) select count(*) from certs c where valid_exp_ym(c.exp)")).rows.map((r) => r["QUERY PLAN"].trim()).join(" / "));
  try { await d.exec(ret); } catch (e) { console.log("\nRETEST AFTER THE FIX:\n" + show(e)); }
  const after = await certsMd5(d);
  console.log(`rolled back: certs ${after.n} (${before.n}), rows byte-identical ${after.m === before.m}; submissions ${(await d.query("select count(*)::int n from cert_submissions")).rows[0].n} (0); onboarding_items ${(await d.query("select count(*)::int n from onboarding_items")).rows[0].n} (0)`);

  await d.exec(`select set_config('request.jwt.claims', '{"email":"dee@demo"}', false); SET role authenticated;`);
  console.log("Demo dept_cert_readiness() as its DA after the cleanup:", JSON.stringify((await d.query("select * from dept_cert_readiness()")).rows[0]));
  await d.exec("RESET role;"); }

console.log("\nmutations — code migration (each must be REFUSED, or with post-conditions stripped caught by the RETEST):");
const RX = "'^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$', false)";
const HEAD = "   RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE\n  AS $fn$\n  -- B4C:cert expiry";
const READY_NEW = "$t$not public.valid_exp_ym(c.exp)$t$, 1,";
const UPD_NEW = "raise exception 'Expiration must be a real month as YYYY-MM (e.g. 2027-06).';$t$, 1,";
const APP_NEW = "$t$sub.name, case when public.valid_exp_ym(sub.exp) then sub.exp end, sub.proof_path$t$";
const run = async (label, m, extra = "", pre = null) => {
  const db = await base(extra); if (pre) await db.exec(pre);
  try {
    await db.exec(m);
    let line = "applied ->";
    try { await db.exec(ret); line += " RETEST raised nothing?!"; } catch (e) { line += " RETEST: " + brief(e); }
    console.log(`  ${label}\n     ${line}${/ [1-9]\d* failed/.test(line) ? "" : "   <-- NOT CAUGHT"}`);
  } catch (e) { console.log(`  ${label}\n     REFUSED: ${e.message.split("\n")[0].slice(0, 200)}`); }
};
for (const [l, m, extra, pre] of [
  ["(a) helper without the year bound ('0000-01' valid)", sub("p_exp OPERATOR(pg_catalog.~) " + RX, "p_exp OPERATOR(pg_catalog.~) '^[0-9]{4}-(0[1-9]|1[0-2])$', false)")],
  ["(a2) same, post-conditions stripped", NOPOST(sub("p_exp OPERATOR(pg_catalog.~) " + RX, "p_exp OPERATOR(pg_catalog.~) '^[0-9]{4}-(0[1-9]|1[0-2])$', false)"))],
  ["(b) helper without the coalesce (NULL -> NULL)", sub("select coalesce(p_exp OPERATOR(pg_catalog.~) " + RX, "select p_exp OPERATOR(pg_catalog.~) '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$'")],
  ["(b2) same, post-conditions stripped", NOPOST(sub("select coalesce(p_exp OPERATOR(pg_catalog.~) " + RX, "select p_exp OPERATOR(pg_catalog.~) '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$'"))],
  ["(c) helper given SET search_path (no longer inlined, COST 100)", sub(HEAD, HEAD.replace("PARALLEL SAFE", "PARALLEL SAFE SET search_path TO 'public'"))],
  ["(c2) same, post-conditions stripped", NOPOST(sub(HEAD, HEAD.replace("PARALLEL SAFE", "PARALLEL SAFE SET search_path TO 'public'")))],
  ["(d) helper SECURITY DEFINER", sub(HEAD, HEAD.replace("PARALLEL SAFE", "PARALLEL SAFE SECURITY DEFINER"))],
  ["(e) anon granted the helper", sub(PC, "  GRANT EXECUTE ON FUNCTION public.valid_exp_ym(text) TO anon;\n" + PC)],
  ["(f) readiness swapped to a month-only test (no year bound) — md5 pin", sub(READY_NEW, "$t$c.exp !~ '^\\d{4}-(0[1-9]|1[0-2])$'$t$, 1,")],
  ["(f2) same, post-conditions stripped", NOPOST(sub(READY_NEW, "$t$c.exp !~ '^\\d{4}-(0[1-9]|1[0-2])$'$t$, 1,"))],
  ["(g) update_cert keeps the old message", sub(UPD_NEW, "raise exception 'Expiration must be YYYY-MM (got: %)', new_exp;$t$, 1,")],
  ["(g2) same, post-conditions stripped", NOPOST(sub(UPD_NEW, "raise exception 'Expiration must be YYYY-MM (got: %)', new_exp;$t$, 1,"))],
  ["(h) approve still copies sub.exp verbatim", sub(APP_NEW, "$t$sub.name, sub.exp, sub.proof_path$t$")],
  ["(h2) same, post-conditions stripped", NOPOST(sub(APP_NEW, "$t$sub.name, sub.exp, sub.proof_path$t$"))],
  ["(i) an extra edit to a repointed body in the block", sub(PC, "  EXECUTE replace(pg_get_functiondef('public.dept_cert_readiness()'::regprocedure), 'then ''no_date''', 'then ''no date''');\n" + PC)],
  ["(j) a collateral function change (is_dept_admin)", sub(PC, "  EXECUTE replace(pg_get_functiondef('public.is_dept_admin()'::regprocedure), 'select exists', 'select true and exists');\n" + PC)],
  ["(k) a policy changed in the block", sub(PC, "  ALTER POLICY \"Leaders read all certs\" ON public.certs USING (true);\n" + PC)],
  ["(l) a trigger dropped in the block", sub(PC, "  DROP TRIGGER members_touch ON public.members;\n" + PC)],
  ["(m) a cert outside the 7 changed in the block", sub(PC, "  UPDATE public.certs SET exp = NULL WHERE name = 'FF I';\n" + PC)],
  ["(n) live drift: pa_department_radar() changed before apply", mig, S0.readers["pa_department_radar()"].def.replace("'Not authorized'", "'Not authorised'") + ";"],
  ["(o) live drift: my_department_rollup() lost one of its 5 sites", mig, S0.readers["my_department_rollup()"].def.replace("and c.exp ~ '^\\d{4}-\\d{2}$'\n           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)\n             - (extract(year from now())::int*12 + extract(month from now())::int) > 3",
     () => "and c.exp ~ '^\\d{4}-(0[1-9]|1[0-2])$'\n           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)\n             - (extract(year from now())::int*12 + extract(month from now())::int) > 3") + ";"],
  ["(p) already applied", mig, "", mig],
]) await run(l, m, extra, pre);

console.log("\nmutations — the data cleanup inside the migration (each must be REFUSED, certs untouched):");
const runC = async (label, m, extra = "") => {
  const db = await base(extra); const b = await certsMd5(db);
  try { await db.exec(m); console.log(`  ${label}\n     applied?!  <-- NOT CAUGHT`); }
  catch (e) { const a = await certsMd5(db); console.log(`  ${label}\n     REFUSED: ${e.message.split("\n")[0].slice(0, 200)}${a.m === b.m ? " (certs untouched)" : "  <-- ROWS CHANGED"}`); }
};
const DEMO_SCOPE = "     AND c.id IN (SELECT (e ->> 'id')::uuid FROM jsonb_array_elements(v_t) e WHERE (e ->> 'dept')::uuid = DEMO)\n";
for (const [l, m, extra] of [
  ["(c1) a target drifted live (North Hood's row now '0000-01')", mig, "UPDATE certs SET exp = '0000-01' WHERE id = '8599898a-0a71-4664-82ae-6e97ede8e7fe';"],
  ["(c2) a target moved department", mig, `UPDATE certs SET department_id = '${A}' WHERE id = 'd19a5449-c5e4-47f5-9a91-74bb71894b4d';`],
  ["(c3) a target already hand-fixed (Demo's 2026-09-15 now 2026-09)", mig, "UPDATE certs SET exp = '2026-09' WHERE id = 'd19a5449-c5e4-47f5-9a91-74bb71894b4d';"],
  ["(c4) the Demo UPDATE without its id scope (an 8th full-date Demo row exists)", sub(DEMO_SCOPE, ""), `INSERT INTO certs (department_id, member_id, name, exp) VALUES ('${DEMO}', '10000000-0000-0000-0000-0000000000d1', 'other', '2029-02-02');`],
  ["(c5) North Hood set to '' instead of NULL", sub("UPDATE public.certs c SET exp = NULL", "UPDATE public.certs c SET exp = ''")],
  ["(c6) another column changed on a target", sub("UPDATE public.certs c SET exp = left(c.exp, 7)", "UPDATE public.certs c SET exp = left(c.exp, 7), name = c.name || ' '")],
  ["(c7) a cert_submissions row changed in the block", sub(PC, "  UPDATE public.cert_submissions SET exp = NULL;\n" + PC), `INSERT INTO cert_submissions (department_id, member_id, name, exp, status) VALUES ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'old', '0000-00', 'approved');`],
]) await runC(l, m, extra);

process.exit(0);   // happy-dom (the client certStatus bundle) keeps the event loop alive
