// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/ws4c_members_view_dryrun_harness.mjs
// DRY RUN for sql/ws4c_members_view_separated_DRAFT.sql + its RETEST — NOT the live DB. Mock: members (the live columns
// members_view reads), member_active_department, member_separation (sealed as live: RLS on, no policies, no grants),
// station_presence, the LIVE bodies of is_leader() / my_department_id() (docs/review/ws4c_LIVEDEFS.json — no stubs), and
// members_view built from its LIVE definition text with the live options and Supabase-style grants. dept_readiness_packet
// is a labelled STUB that implements ONLY the server's counted predicate (sql/scorecard_2026-10-19.sql:343–345), so T5's
// comparison path runs here; live, T5 compares against the real packet.
// Runs: pins (incl. the view md5 reproducing) -> migration -> state row -> re-run (must refuse) -> RETEST -> drift
// refusals -> mutations (the migration must refuse, or the RETEST must catch) -> post-apply drift (the RETEST must catch).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/ws4c_LIVEDEFS.json"), "utf8"));
const MIG = readFileSync(join(root, "sql/ws4c_members_view_separated_DRAFT.sql"), "utf8");
const RET = readFileSync(join(root, "sql/ws4c_members_view_separated_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";

const schema = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL,
  role text, access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, phone text, joined text, participation integer,
  created_at timestamptz DEFAULT now(), email text, mentor_id uuid);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE member_separation (member_id uuid PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, department_id uuid NOT NULL REFERENCES departments(id),
  terminated_on date NOT NULL, set_by_member uuid, set_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE member_separation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON member_separation FROM anon, authenticated, public;
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, verified boolean NOT NULL DEFAULT false);
${L.defs["my_department_id()"].def};
${L.defs["is_leader()"].def};
CREATE VIEW public.members_view WITH (security_invoker = false) AS ${L.members_view.def}
-- STUB (labelled): only the server's counted predicate from dept_readiness_packet (scorecard_2026-10-19.sql:343–345)
CREATE FUNCTION public.dept_readiness_packet() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select jsonb_build_object('readiness', jsonb_build_object('counted', count(*))) from public.members m
   where m.department_id = public.my_department_id() and m.status in ('Active', 'Probationary')
     and not coalesce(m.access && array['Project Admin']::text[], false)
     and not exists (select 1 from public.member_separation s where s.member_id = m.id) $$;
INSERT INTO departments VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)');
INSERT INTO members (department_id, name, email, access, status) VALUES
  ('${A}', 'A DA', 'da@a.test', '{Department Admin}', 'Active'), ('${A}', 'A FF', 'ff@a.test', '{Member}', 'Active'),
  ('${A}', 'A gone', 'gone@a.test', '{Member}', 'Inactive'), ('${B}', 'B FF', 'ff@b.test', '{Member}', 'Active');
INSERT INTO member_separation (member_id, department_id, terminated_on) SELECT id, department_id, '2026-09-30' FROM members WHERE email = 'gone@a.test';
INSERT INTO station_presence (department_id, verified) VALUES ('${A}', true), ('${B}', true);
`;
const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—|leader =/.test(l)).join("\n");
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }
const log = (s) => console.log(s);
const redOf = (e) => { const r = report(e); return { fails: r.split("\n").filter((l) => /FAIL/.test(l)), tail: r.split("\n").pop() }; };

{ const db = await fresh();
  const q = async (sql) => (await db.query(sql)).rows[0];
  const v = await q(`select md5(pg_get_viewdef('public.members_view'::regclass, true)) m, (select relacl::text from pg_class where oid = 'public.members_view'::regclass) acl,
    (select coalesce(array_to_string(reloptions, ','), '') || '|' || pg_get_userbyid(relowner) from pg_class where oid = 'public.members_view'::regclass) opts`);
  const fl = await q(`select md5(pg_get_functiondef('public.is_leader()'::regprocedure)) il, md5(pg_get_functiondef('public.my_department_id()'::regprocedure)) md`);
  const pins = [
    ["members_view definition", v.m, L.members_view.md5], ["is_leader()", fl.il, L.defs["is_leader()"].md5], ["my_department_id()", fl.md, L.defs["my_department_id()"].md5],
    // PGlite has no MAINTAIN privilege (PG17's `m`); the live ACL is the same grants + m. Compared with `m` stripped.
    ["members_view ACL (live minus PG17's MAINTAIN 'm')", v.acl, L.members_view.acl.replace(/m\//g, "/")],
  ];
  const bad = pins.filter(([, got, want]) => got !== want);
  log(`pins: ${pins.length - bad.length}/${pins.length} mock = live (view md5 reproduces from the live text; function bodies; ACL) ${bad.length ? JSON.stringify(bad) : ""}`);
  log(`   view options|owner in the mock: ${v.opts}  (live: ${L.members_view.options.join(",")}|${L.members_view.owner})`);
  if (bad.length) process.exitCode = 1;
  await db.close(); }

{ const db = await fresh();
  await db.exec(MIG);
  const st = await db.query(MIG.slice(MIG.indexOf("SELECT jsonb_build_object(")));
  log("migration: applied. state row: " + JSON.stringify(st.rows[0].state));
  try { await db.exec(MIG); log("FAIL re-run NOT refused"); process.exitCode = 1; } catch (e) { log("re-run: refused -> " + firstLine(e)); }
  try { await db.exec(RET); log("FAIL RETEST did not end in its report"); } catch (e) { log("RETEST:\n" + report(e)); if (/[1-9]\d* failed/.test(report(e))) process.exitCode = 1; }
  await db.close(); }

for (const [label, sql] of [
  ["members_view drifted (a column changed)", `CREATE OR REPLACE VIEW public.members_view WITH (security_invoker = false) AS ${L.members_view.def.replace("    phone,", "    upper(phone) AS phone,")}`],
  ["is_leader() drifted", `CREATE OR REPLACE FUNCTION public.is_leader() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select true $$;`],
  ["member_separation unsealed (authenticated SELECT)", `GRANT SELECT ON public.member_separation TO authenticated;`],
  ["member_separation gained a policy", `CREATE POLICY "leaders read" ON public.member_separation FOR SELECT TO authenticated USING (true);`],
  ["view switched to security_invoker", `ALTER VIEW public.members_view SET (security_invoker = true);`],
]) { const db = await fresh(); await db.exec(sql);
  try { await db.exec(MIG); log(`FAIL drift "${label}" NOT refused`); process.exitCode = 1; } catch (e) { log(`drift "${label}": refused -> ${firstLine(e)}`); }
  await db.close(); }

const SEP = `        CASE
            WHEN is_leader() THEN (EXISTS ( SELECT 1
               FROM member_separation s
              WHERE s.member_id = members.id))
            ELSE NULL::boolean
        END AS separated`;
const MUT = [
  ["M1 separated not masked for non-leaders", (s) => s.replace(SEP, `    (EXISTS ( SELECT 1 FROM member_separation s WHERE s.member_id = members.id)) AS separated`)],
  ["M2 future-dated separation not counted (drifts from the server rule)", (s) => s.replace("WHERE s.member_id = members.id))\n            ELSE NULL::boolean", "WHERE s.member_id = members.id AND s.terminated_on < CURRENT_DATE))\n            ELSE NULL::boolean")],
  ["M3 status unmasked on the way through", (s) => s.replace("        CASE\n            WHEN is_leader() THEN status\n            ELSE NULL::text\n        END AS status,", "    status,")],
  ["M4 terminated_on exposed", (s) => s.replace("        END AS separated\n   FROM members", "        END AS separated,\n    (SELECT s.terminated_on FROM member_separation s WHERE s.member_id = members.id) AS terminated_on\n   FROM members")],
  ["M5 anon grant revoked by the migration", (s) => s.replace("  -- ---------------------------------------------------------------- 2. post-conditions", "  EXECUTE 'REVOKE ALL ON public.members_view FROM anon';\n  -- ---------------------------------------------------------------- 2. post-conditions")],
  ["M6 department scope dropped", (s) => s.replace("   FROM members\n  WHERE department_id = my_department_id()\n  $view$", "   FROM members\n  $view$")],
];
log("mutations:");
for (const [label, fn] of MUT) {
  const m = fn(MIG); if (m === MIG) { log(`   ${label}: MUTATION DID NOT APPLY (harness bug)`); process.exitCode = 1; continue; }
  const db = await fresh();
  try { await db.exec(m); } catch (e) { log(`   ${label}: migration REFUSED -> ${firstLine(e)}`); await db.close(); continue; }
  try { await db.exec(RET); } catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}

const DRIFT = [
  ["D1 anon's grant revoked later", `REVOKE ALL ON public.members_view FROM anon;`],
  ["D2 member_separation readable later", `GRANT SELECT ON public.member_separation TO authenticated;`],
  ["D3 the view replaced unmasked later", `CREATE OR REPLACE VIEW public.members_view WITH (security_invoker = false) AS ${L.members_view.def.replace(/;\s*$/, "").replace("    mentor_id\n   FROM members", "    mentor_id,\n    (EXISTS (SELECT 1 FROM member_separation s WHERE s.member_id = members.id)) AS separated\n   FROM members")};`],
  ["D4 the view later stops counting a FUTURE-dated separation", `CREATE OR REPLACE VIEW public.members_view WITH (security_invoker = false) AS ${L.members_view.def.replace(/;\s*$/, "").replace("    mentor_id\n   FROM members", "    mentor_id,\n        CASE WHEN is_leader() THEN (EXISTS (SELECT 1 FROM member_separation s WHERE s.member_id = members.id AND s.terminated_on < CURRENT_DATE)) ELSE NULL::boolean END AS separated\n   FROM members")};`],
];
log("post-apply drift (RETEST alone must catch):");
for (const [label, sql] of DRIFT) {
  const db = await fresh(); await db.exec(MIG); await db.exec(sql);
  try { await db.exec(RET); } catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}
