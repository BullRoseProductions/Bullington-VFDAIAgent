// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/ws2_ai_call_usage_dryrun_harness.mjs
// DRY RUN for sql/ws2_ai_call_usage_DRAFT.sql + its RETEST — NOT the live DB. Mock: members / departments /
// member_active_department / station_presence, the two monthly-ceiling tables (assistant_usage, image_gen_usage — the
// pattern), the LIVE bodies of the four pinned functions (docs/review/ws2_LIVEDEFS.json — no stubs), Supabase-style
// default grants (what the migration must revoke on the new table).
// Runs: pins -> migration -> state row -> re-run (must refuse) -> RETEST -> drift refusals -> mutations -> post-apply drift.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/ws2_LIVEDEFS.json"), "utf8"));
const MIG = readFileSync(join(root, "sql/ws2_ai_call_usage_DRAFT.sql"), "utf8");
const RET = readFileSync(join(root, "sql/ws2_ai_call_usage_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const PINNED = ["my_department_id()", "my_member_id()", "record_assistant_turn()", "record_image_generation(text)"];

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
  access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, email text);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, verified boolean NOT NULL DEFAULT false);
CREATE TABLE assistant_usage (department_id uuid NOT NULL, period_month date NOT NULL, count integer NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (department_id, period_month));
CREATE TABLE image_gen_usage (department_id uuid NOT NULL, period_month date NOT NULL, count integer NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (department_id, period_month));
ALTER TABLE assistant_usage ENABLE ROW LEVEL SECURITY; ALTER TABLE image_gen_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON assistant_usage, image_gen_usage FROM anon, authenticated, public;
` + PINNED.map((k) => L.defs[k].def + ";\n").join("") + `
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f); END LOOP; END $$;
INSERT INTO departments VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)');
INSERT INTO members (department_id, name, email, access) VALUES ('${A}', 'A DA', 'da@a.test', '{Department Admin}'), ('${B}', 'B FF', 'ff@b.test', '{Member}');
INSERT INTO station_presence (department_id, verified) VALUES ('${A}', true), ('${B}', true);
INSERT INTO assistant_usage VALUES ('${A}', date_trunc('month', now())::date, 17, now());
`;
const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }
const log = (s) => console.log(s);
const redOf = (e) => { const r = report(e); return { fails: r.split("\n").filter((l) => /FAIL/.test(l)), tail: r.split("\n").pop() }; };

{ const db = await fresh();
  let ok = 0; const bad = [];
  for (const k of PINNED) { const r = await db.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [`public.${k}`]); if (r.rows[0].m === L.defs[k].md5) ok++; else bad.push(k); }
  log(`pins: ${ok}/${PINNED.length} mock bodies md5-equal to the live pins (all live bodies, no stubs) ${bad.length ? JSON.stringify(bad) : ""}`);
  if (bad.length) process.exitCode = 1;
  await db.close(); }

{ const db = await fresh();
  await db.exec(MIG);
  const st = await db.query(MIG.slice(MIG.indexOf("SELECT jsonb_build_object(")));
  log("migration: applied. state row: " + JSON.stringify(st.rows[0].state));
  try { await db.exec(MIG); log("FAIL re-run NOT refused"); process.exitCode = 1; } catch (e) { log("re-run: refused -> " + firstLine(e)); }
  try { await db.exec(RET); log("FAIL RETEST did not end in its report"); } catch (e) { log("RETEST:\n" + report(e)); if (/[1-9]\d* failed/.test(report(e))) process.exitCode = 1; }
  // concurrency sanity for the backstop: 1,499 in the department, two calls in one transaction-free sequence → exactly one allowed
  await db.exec(`INSERT INTO members (department_id, name, email) VALUES ('${A}', 'Busy', 'busy@a.test'), ('${A}', 'Caller', 'caller@a.test');
    INSERT INTO ai_call_usage (member_id, department_id, day, route, count) SELECT id, '${A}', (now() at time zone 'America/Chicago')::date, 'claude', 1499 FROM members WHERE email = 'busy@a.test';`);
  const seq = [];
  for (let i = 0; i < 2; i++) {
    await db.exec(`select set_config('request.jwt.claims', '{"email":"caller@a.test"}', false); set role authenticated;`);
    seq.push((await db.query(`select public.record_ai_call('claude') r`)).rows[0].r);
    await db.exec(`reset role;`);
  }
  log(`backstop at 1,499: two calls → ${seq.map((x) => x.allowed).join(" then ")} (expect true then false, scope ${seq[1].scope})`);
  if (!(seq[0].allowed === true && seq[1].allowed === false && seq[1].scope === "department")) process.exitCode = 1;
  await db.close(); }

for (const [label, sql] of [
  ["my_member_id() drifted", `CREATE OR REPLACE FUNCTION public.my_member_id() RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ select null::uuid $$;`],
  ["record_assistant_turn() drifted", `CREATE OR REPLACE FUNCTION public.record_assistant_turn() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ select '{"allowed":true}'::jsonb $$;`],
  ["ai_call_usage already exists", `CREATE TABLE public.ai_call_usage (x int);`],
]) { const db = await fresh(); await db.exec(sql);
  try { await db.exec(MIG); log(`FAIL drift "${label}" NOT refused`); process.exitCode = 1; } catch (e) { log(`drift "${label}": refused -> ${firstLine(e)}`); }
  await db.close(); }

const MUT = [
  ["M1 table readable by authenticated", (s) => s.replace("REVOKE ALL ON TABLE public.ai_call_usage FROM PUBLIC, anon, authenticated;", "REVOKE ALL ON TABLE public.ai_call_usage FROM PUBLIC, anon; GRANT SELECT ON public.ai_call_usage TO authenticated;")],
  ["M2 anon can execute", (s) => s.replace("REVOKE ALL ON FUNCTION public.record_ai_call(text) FROM PUBLIC, anon;", "REVOKE ALL ON FUNCTION public.record_ai_call(text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.record_ai_call(text) TO anon;")],
  ["M3 no member check", (s) => s.replace("if v_me is null or v_dept is null then\n      raise exception 'We could not match your login to a member record.';\n    end if;", "")],
  ["M4 the member cap never refuses", (s) => s.replace("      where u.count < v_cap\n", "")],
  ["M5 claude cap 1500 not 150", (s) => s.replace("when 'claude' then 150 when", "when 'claude' then 1500 when")],
  ["M6 no department backstop", (s) => s.replace("v_dcap := case p_route when 'claude' then 1500 end;", "v_dcap := null;")],
  ["M7 any route accepted", (s) => s.replace("if p_route is null or p_route not in ('claude', 'concepts', 'assistant', 'image') then\n      raise exception 'Unknown AI route.';\n    end if;", "")],
  ["M8 a policy that opens the table", (s) => s.replace("  REVOKE ALL ON TABLE public.ai_call_usage FROM PUBLIC, anon, authenticated;", "  REVOKE ALL ON TABLE public.ai_call_usage FROM PUBLIC, anon, authenticated;\n  CREATE POLICY \"members read own\" ON public.ai_call_usage FOR SELECT TO authenticated USING (true);")],
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
  ["D1 authenticated granted SELECT later", `GRANT SELECT ON public.ai_call_usage TO authenticated;`],
  ["D2 anon granted EXECUTE later", `GRANT EXECUTE ON FUNCTION public.record_ai_call(text) TO anon;`],
  ["D3 record_assistant_turn replaced later", `CREATE OR REPLACE FUNCTION public.record_assistant_turn() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ select '{"allowed":true}'::jsonb $$;`],
];
log("post-apply drift (RETEST alone must catch):");
for (const [label, sql] of DRIFT) {
  const db = await fresh(); await db.exec(MIG); await db.exec(sql);
  try { await db.exec(RET); } catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}
