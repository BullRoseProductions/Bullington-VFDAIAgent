// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/cert_dates_sliceA_dryrun_harness.mjs [pin]
// PGlite dry run for sql/cert_dates_sliceA_DRAFT.sql + sql/cert_dates_sliceA_RETEST.sql. No network, no live DB.
// The base is a mock Supabase rebuilt from LIVE: the 7 cert functions VERBATIM from docs/review/cert_dates_STEP0_OUTPUT.json
// (their md5s reproduce byte-identically — printed first), valid_exp_ym() exactly as the reviewed cert-expiry migration created
// it (origin/fix/cert-expiry-malformed), the shared gates from the Training Officers Step 0 output, the live certs /
// cert_submissions / cert_types columns, constraints and policies — and, like live, 0 cert types and 0 flags.
//   pin      — run once with the md5 post-checks stripped, write the 8 reviewed md5s into the DRAFT / RETEST
//   default  — the TYPE-GAP probe before / after (a never-expires type with an old date: counted expired by the radar + rollup
//              before, not after); RETEST before (must fail); apply + state; re-run (refused); RETEST after; then the
//              mutations: each REFUSED by the migration, or (post-conditions stripped) caught by the RETEST.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { execSync } from "child_process";
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const root = fileURLToPath(new URL("../../", import.meta.url));
const MIG_PATH = join(root, "sql/cert_dates_sliceA_DRAFT.sql"), RET_PATH = join(root, "sql/cert_dates_sliceA_RETEST.sql");
let mig = readFileSync(MIG_PATH, "utf8"), ret = readFileSync(RET_PATH, "utf8");
const S0 = JSON.parse(readFileSync(join(root, "docs/review/cert_dates_STEP0_OUTPUT.json"), "utf8"));
const TO = JSON.parse(execSync("git show origin/feat/training-officers-step0:docs/review/training_officers_STEP0_OUTPUT.json", { cwd: root, maxBuffer: 1 << 24 }).toString());
const CE = execSync("git show origin/fix/cert-expiry-malformed:sql/cert_expiry_valid_ym_DRAFT.sql", { cwd: root, maxBuffer: 1 << 24 }).toString();
const VALID_EXP_YM = CE.slice(CE.indexOf("  CREATE FUNCTION public.valid_exp_ym"), CE.indexOf("  GRANT EXECUTE ON FUNCTION public.valid_exp_ym(text) TO authenticated, service_role;\n"))
  + "  GRANT EXECUTE ON FUNCTION public.valid_exp_ym(text) TO authenticated, service_role;\n";
const FNS = ["dept_cert_readiness()", "pa_department_radar()", "my_department_rollup()", "expiration_rows(uuid,uuid)", "probation_item_states(uuid,uuid)", "update_cert(uuid,text,text)", "approve_cert_submission(uuid)"];
const KEYS = { "cert_never_expires(boolean,uuid,uuid)": "HELPER", "update_cert(uuid,text,text,boolean,text)": "UPDATE", "dept_cert_readiness()": "READINESS",
  "pa_department_radar()": "RADAR", "my_department_rollup()": "ROLLUP", "expiration_rows(uuid,uuid)": "EXPROWS", "probation_item_states(uuid,uuid)": "PROBATION",
  "approve_cert_submission(uuid)": "APPROVE" };
const A = "00000000-0000-0000-0000-00000000000a", NH = "6d51b00a-bdb0-4807-8e45-70bb53d4dcff", DEMO = "94667450-481c-4f40-a6b6-86e1b364be93";
const pol = (p) => { const [t, name, cmd, roles, qual, wc] = p.split(" | "); return `CREATE POLICY "${name}" ON public.${t} FOR ${cmd} TO ${roles.replace(/[{}]/g, "")}${qual ? ` USING (${qual})` : ""}${wc ? ` WITH CHECK (${wc})` : ""};`; };
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
CREATE TABLE cert_types (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE, name text NOT NULL,
  never_expires boolean NOT NULL DEFAULT false, category text NOT NULL DEFAULT 'certification', created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT cert_types_category_chk CHECK (category = ANY (ARRAY['certification'::text, 'continuing_education'::text])), CONSTRAINT cert_types_name_chk CHECK (btrim(name) <> ''::text));
CREATE UNIQUE INDEX cert_types_dept_name_uq ON cert_types (department_id, lower(btrim(name)));
CREATE TABLE certs (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE, name text NOT NULL, exp text, created_at timestamptz NOT NULL DEFAULT now(), proof_path text,
  cert_type_id uuid REFERENCES cert_types(id) ON DELETE SET NULL);
CREATE TABLE cert_submissions (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, department_id uuid NOT NULL REFERENCES departments(id), member_id uuid NOT NULL REFERENCES members(id),
  name text NOT NULL, exp text, status text NOT NULL DEFAULT 'pending', source text NOT NULL DEFAULT 'manual', note text, proposed_by uuid REFERENCES auth.users(id),
  reviewed_by uuid REFERENCES auth.users(id), reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), proof_path text,
  CONSTRAINT cert_submissions_source_check CHECK (source = ANY (ARRAY['manual'::text, 'ai'::text, 'sfma'::text, 'self'::text])),
  CONSTRAINT cert_submissions_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
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
CREATE TABLE onboarding_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, label text, category text NOT NULL, phase text, kind text, clears_to_run boolean,
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
${VALID_EXP_YM}
${FNS.map((k) => S0.functions[k].def + ";").join("\n")}
REVOKE EXECUTE ON FUNCTION public.expiration_rows(uuid,uuid), public.probation_item_states(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dept_cert_readiness(), public.pa_department_radar(), public.my_department_rollup(), public.update_cert(uuid,text,text),
  public.approve_cert_submission(uuid), public.my_department_id(), public.my_member_id(), public.is_dept_admin(), public.is_project_admin(), public.is_leader() FROM PUBLIC, anon;
ALTER TABLE certs ENABLE ROW LEVEL SECURITY; ALTER TABLE cert_submissions ENABLE ROW LEVEL SECURITY; ALTER TABLE cert_types ENABLE ROW LEVEL SECURITY;
${S0.policies.map(pol).join("\n")}
INSERT INTO departments (id, name) VALUES ('${A}','Indian Harbor Volunteer Fire Department'),('${NH}','North Hood County Volunteer Fire Department'),('${DEMO}','B4C Demo Department');
INSERT INTO members (id, department_id, email, name, access) VALUES
  ('10000000-0000-0000-0000-00000000000a','${A}','ada@a','Ada DA','{Department Admin}'), ('10000000-0000-0000-0000-0000000000a1','${A}','mo@a','Mo Member','{Member}'),
  ('10000000-0000-0000-0000-0000000000b0','${NH}','bob@nh','Bob DA','{Department Admin}'), ('10000000-0000-0000-0000-0000000000b1','${NH}','boater@nh','Boater','{Member}'),
  ('10000000-0000-0000-0000-0000000000d0','${DEMO}','dee@demo','Dee DA','{Department Admin}'), ('10000000-0000-0000-0000-0000000000d1','${DEMO}','dan@demo','Dan Demo','{Member}'),
  (gen_random_uuid(),'${A}','pa@x','Pat Project Admin','{Project Admin}');
INSERT INTO auth.users (id, email) SELECT gen_random_uuid(), email FROM members;
INSERT INTO onboarding_items (department_id, label, category, phase, kind, sort_order) VALUES ('${A}', 'Read the SOPs', 'orientation', 'week 1', 'manual', 1);
INSERT INTO certs (department_id, member_id, name, exp) VALUES
  ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'Boaters Ed Cert', NULL), ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'FF I', '2028-04'),
  ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'CPR', NULL), ('${A}', '10000000-0000-0000-0000-00000000000a', 'EMT', '2025-01'),
  ('${A}', '10000000-0000-0000-0000-0000000000a1', 'FF II', to_char(now() + interval '1 month', 'YYYY-MM')),
  ('${DEMO}', '10000000-0000-0000-0000-0000000000d1', 'Hazmat', '2027-11'), ('${DEMO}', '10000000-0000-0000-0000-0000000000d1', 'Pump Ops', '2026-09');
INSERT INTO cert_submissions (department_id, member_id, name, exp, status, source) VALUES ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'FF I', '2028-04', 'approved', 'self');
`;
async function base(extra = "") { const d = new PGlite(); await d.exec(mock); if (extra) await d.exec(extra); return d; }
const md = async (d, f) => (await d.query(`select md5(pg_get_functiondef('public.${f}'::regprocedure)) m`)).rows[0].m;
const NOPIN = (s) => s.replace(/  -- \[md5-pin\][\s\S]*?  -- \[\/md5-pin\]\n/, "").replace(/@@MD5_[A-Z]+@@/g, "x");

{ const d = await base();
  for (const k of FNS) { const h = await md(d, k); console.log(`${k}: live ${S0.functions[k].md5} · here ${h}${h === S0.functions[k].md5 ? "" : "  <-- MISMATCH"}`); }
  console.log(`valid_exp_ym(text): reviewed 51b8cde1… · here ${(await md(d, "valid_exp_ym(text)")).slice(0, 8)}`); }

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
// replace the first occurrence of `a` after `marker` (for a token that appears in both the radar and the rollup spec)
const subAfter = (marker, a, b, s = mig) => { const i = s.indexOf(marker); const j = s.indexOf(a, i); if (i < 0 || j < 0) throw new Error("anchor missing: " + marker); return s.slice(0, j) + b + s.slice(j + a.length); };
const NOPOST = (s) => s.replace(/  -- -{10,} post-conditions[\s\S]*?\nEND\n\$migrate\$;/, "END\n$migrate$;");
const PC = "  -- ---------------------------------------------------------------- post-conditions\n  -- (1)";
const rowsMd5 = async (d) => (await d.query("select md5(string_agg(c::text, ',' order by c.id)) m from certs c")).rows[0].m;

// THE TYPE GAP, before / after: a never-expires TYPE on a cert with an old date (and a no_expiry cert, after)
const probe = async (d, withFlag) => {
  await d.exec(`INSERT INTO cert_types (id, department_id, name, never_expires) VALUES ('30000000-0000-0000-0000-000000000001', '${NH}', 'Boaters Ed (never expires)', true);
    INSERT INTO certs (department_id, member_id, name, exp, cert_type_id) VALUES ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'Boaters Ed', '2020-01', '30000000-0000-0000-0000-000000000001');`
    + (withFlag ? `INSERT INTO certs (department_id, member_id, name, no_expiry) VALUES ('${NH}', '10000000-0000-0000-0000-0000000000b1', 'Lifeguard', true);` : ""));
  await d.exec(`select set_config('request.jwt.claims', '{"email":"bob@nh"}', false); SET role authenticated;`);
  const r = (await d.query("select expired, no_expiry from dept_cert_readiness()")).rows[0];
  await d.exec(`select set_config('request.jwt.claims', '{"email":"boater@nh"}', false);`);
  const o = (await d.query(`select my_certs_current c, my_certs_expired x from my_department_rollup() where department_id = '${NH}'`)).rows[0];
  await d.exec(`select set_config('request.jwt.claims', '{"email":"pa@x"}', false);`);
  const a = (await d.query(`select expired_certs_count x from pa_department_radar() where department_id = '${NH}'`)).rows[0];
  await d.exec("RESET role;");
  return `North Hood — readiness expired ${r.expired} · no_expiry ${r.no_expiry} | Boater's rollup current ${o.c} · expired ${o.x} | PA radar expired ${a.x}`;
};
{ const d = await base(); console.log("\nTYPE-GAP PROBE BEFORE (the radar + rollup count the never-expires type's old date as EXPIRED):\n  " + await probe(d, false)); }
{ const d = await base(); await d.exec(mig); console.log("TYPE-GAP PROBE AFTER (+ a no_expiry cert): expired 0 everywhere; the type + the flag read no_expiry / current:\n  " + await probe(d, true)); }

{ const d = await base();
  try { await d.exec(ret); console.log("RETEST before raised nothing?!"); } catch (e) { console.log("\nRETEST BEFORE (must fail): " + e.message.split("\n")[0]); } }
{ const d = await base();
  const res = await d.exec(mig); const before = await rowsMd5(d);
  console.log("\nAPPLY — state:", JSON.stringify(res.at(-1).rows));
  try { await d.exec(mig); console.log("re-run: applied twice?!"); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
  console.log("grants: update_cert", (await d.query("select proacl::text a from pg_proc where proname = 'update_cert'")).rows[0].a,
    "· cert_never_expires", (await d.query("select proacl::text a from pg_proc where proname = 'cert_never_expires'")).rows[0].a);
  try { await d.exec(ret); } catch (e) { console.log("\nRETEST AFTER:\n" + show(e)); }
  console.log(`rolled back: certs rows byte-identical ${(await rowsMd5(d)) === before}; cert_types ${(await d.query("select count(*)::int n from cert_types")).rows[0].n} (0); submissions ${(await d.query("select count(*)::int n from cert_submissions")).rows[0].n} (1)`);
  // legacy call through PostgREST-style named args: update_cert(cert_id, new_name, new_exp) resolves to the 5-arg function
  await d.exec(`select set_config('request.jwt.claims', '{"email":"bob@nh"}', false); SET role authenticated;`);
  const id = (await d.query(`select id from certs where name = 'FF I'`)).rows[0]?.id;
  await d.exec("RESET role;");
  await d.exec(`select set_config('request.jwt.claims', '{"email":"bob@nh"}', false); SET role authenticated; select public.update_cert(cert_id => '${id}', new_name => 'FF I', new_exp => '2029-01'); RESET role;`);
  console.log("named 3-arg call (today's client):", JSON.stringify((await d.query(`select exp, no_expiry, achieved_on from certs where id = '${id}'`)).rows[0])); }

console.log("\nmutations (each must be REFUSED, or with post-conditions stripped caught by the RETEST):");
const run = async (label, m, extra = "", pre = null) => {
  const db = await base(extra); if (pre) await db.exec(pre); const b = await rowsMd5(db);
  try {
    await db.exec(m);
    let line = "applied ->";
    try { await db.exec(ret); line += " RETEST raised nothing?!"; } catch (e) { line += " RETEST: " + brief(e); }
    console.log(`  ${label}\n     ${line}${/ [1-9]\d* failed/.test(line) ? "" : "   <-- NOT CAUGHT"}`);
  } catch (e) { const a = await rowsMd5(db); console.log(`  ${label}\n     REFUSED: ${e.message.split("\n")[0].slice(0, 200)}${a === b ? "" : "  <-- ROWS CHANGED"}`); }
};
const RDY = "$t$when c.no_expiry or coalesce(t.never_expires, false) then 'no_expiry'$t$";
const NEL = "           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)\n$t$, 2)), '@@";
const CUR = "           and (public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)\n                or (public.valid_exp_ym(c.exp)";
const FUT = "    if v_ach is not null and v_ach > to_char(now() at time zone 'America/Chicago', 'YYYY-MM') then\n      raise exception 'Achievement date can''t be in the future.';\n    end if;\n";
const APPROVE_ACH = "               then sub.achieved_on end)$t$";
for (const [l, m, extra, pre] of [
  ["(a) readiness: the flag not ORed in", sub(RDY, "$t$when coalesce(t.never_expires, false) then 'no_expiry'$t$")],
  ["(a2) same, post-conditions stripped", NOPOST(sub(RDY, "$t$when coalesce(t.never_expires, false) then 'no_expiry'$t$"))],
  ["(b) radar: the type / flag exclusion missing", subAfter("(4, 'public.pa_department_radar()'", "           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)\n", "")],
  ["(b2) same, post-conditions stripped", NOPOST(subAfter("(4, 'public.pa_department_radar()'", "           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)\n", ""))],
  ["(c) rollup: my_certs_current without never-expires", sub(CUR, "           and (false\n                or (public.valid_exp_ym(c.exp)")],
  ["(c2) same, post-conditions stripped", NOPOST(sub(CUR, "           and (false\n                or (public.valid_exp_ym(c.exp)"))],
  ["(d) CHECK no_expiry -> exp NULL missing", sub("  ALTER TABLE public.certs ADD CONSTRAINT certs_no_expiry_clears_exp CHECK (NOT no_expiry OR exp IS NULL);\n", "")],
  ["(d2) same, post-conditions stripped", NOPOST(sub("  ALTER TABLE public.certs ADD CONSTRAINT certs_no_expiry_clears_exp CHECK (NOT no_expiry OR exp IS NULL);\n", ""))],
  ["(e) CHECK achieved_on missing", sub("  ALTER TABLE public.certs ADD CONSTRAINT certs_achieved_on_valid CHECK (achieved_on IS NULL OR public.valid_exp_ym(achieved_on));\n", "")],
  ["(e2) same, post-conditions stripped", NOPOST(sub("  ALTER TABLE public.certs ADD CONSTRAINT certs_achieved_on_valid CHECK (achieved_on IS NULL OR public.valid_exp_ym(achieved_on));\n", ""))],
  ["(f) update_cert grants not re-applied (anon re-opened by the DROP + CREATE)", sub("  REVOKE ALL ON FUNCTION public.update_cert(uuid, text, text, boolean, text) FROM PUBLIC, anon;\n", "")],
  ["(f2) same, post-conditions stripped", NOPOST(sub("  REVOKE ALL ON FUNCTION public.update_cert(uuid, text, text, boolean, text) FROM PUBLIC, anon;\n", ""))],
  ["(g) update_cert accepts a future achieved_on", sub(FUT, "")],
  ["(g2) same, post-conditions stripped", NOPOST(sub(FUT, ""))],
  ["(h) approve keeps an invalid achieved_on", sub(APPROVE_ACH, "               then sub.achieved_on else sub.achieved_on end)$t$")],
  ["(h2) same, post-conditions stripped", NOPOST(sub(APPROVE_ACH, "               then sub.achieved_on else sub.achieved_on end)$t$"))],
  ["(i) helper ignores the type's department", sub("where t.id = p_cert_type_id and t.department_id = p_department_id", "where t.id = p_cert_type_id")],
  ["(i2) same, post-conditions stripped", NOPOST(sub("where t.id = p_cert_type_id and t.department_id = p_department_id", "where t.id = p_cert_type_id"))],
  ["(j) no_expiry DEFAULT true", sub("ALTER TABLE public.certs ADD COLUMN achieved_on text, ADD COLUMN no_expiry boolean NOT NULL DEFAULT false;", "ALTER TABLE public.certs ADD COLUMN achieved_on text, ADD COLUMN no_expiry boolean NOT NULL DEFAULT true;")],
  ["(k) a collateral function change (is_dept_admin)", sub(PC, "  EXECUTE replace(pg_get_functiondef('public.is_dept_admin()'::regprocedure), 'select exists', 'select true and exists');\n" + PC)],
  ["(l) a policy changed in the block", sub(PC, "  ALTER POLICY \"Leaders read all certs\" ON public.certs USING (true);\n" + PC)],
  ["(m) a trigger dropped in the block", sub(PC, "  DROP TRIGGER members_touch ON public.members;\n" + PC)],
  ["(n) an existing cert changed in the block", sub(PC, "  UPDATE public.certs SET exp = NULL WHERE name = 'FF I';\n" + PC)],
  ["(o) a cert type added in the block", sub(PC, `  INSERT INTO public.cert_types (department_id, name) VALUES ('${A}', 'sneaky');\n` + PC)],
  ["(p) a reader's live output changes (md5 pin stripped, so only the read-identity check stands)",
     NOPIN(subAfter("(4, 'public.pa_department_radar()'", "           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id)\n",
       "           and not public.cert_never_expires(c.no_expiry, c.cert_type_id, c.department_id) and c.exp <> '2025-01'\n")).replace(/@@MD5_[A-Z]+@@/g, "x")],
  ["(q) live drift: probation_item_states changed before apply", mig, S0.functions["probation_item_states(uuid,uuid)"].def.replace("is current", "is current.") + ";"],
  ["(r) live drift: update_cert changed before apply", mig, S0.functions["update_cert(uuid,text,text)"].def.replace("Certification not found", "Certificate not found") + ";"],
  ["(s) already applied", mig, "", mig],
]) await run(l, m, extra, pre);
process.exit(0);
