// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/library_s1_dryrun_harness.mjs
// DRY RUN for sql/library_s1_catalog_DRAFT.sql + its RETEST — NOT the live DB. Mock: the live columns of drill_plans,
// session_plans, training_sessions, session_attendance, training_officer, members (+ the CHECKs this touches), the LIVE
// drill_plans policy, and ALL 10 pinned functions as their LIVE bodies (docs/review/library_s1_LIVEDEFS.json — no stubs),
// Supabase-style default grants (what the migration must revoke on the new table).
// Runs: pins -> migration -> state row -> re-run (must refuse) -> RETEST -> drift refusals -> mutations -> post-apply
// drift (the RETEST alone must catch each).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/library_s1_LIVEDEFS.json"), "utf8"));
const MIG = readFileSync(join(root, "sql/library_s1_catalog_DRAFT.sql"), "utf8");
const RET = readFileSync(join(root, "sql/library_s1_catalog_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const order = ["my_department_id()", "my_member_id()", "is_training_officer()", "is_training_manager()", "dept_drill_plans()",
  "set_drill_plan(uuid,text,text,integer,text,jsonb,text)", "approve_drill_plan(uuid)", "unapprove_drill_plan(uuid)", "delete_drill_plan(uuid)",
  "attach_drill_plan_to_session(uuid,uuid)"];

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
CREATE TABLE training_officer (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, assigned_by uuid,
  assigned_by_name text, assigned_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz, removed_by uuid, removed_by_name text);
CREATE TABLE training_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL);
CREATE TABLE training_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES training_plans(id) ON DELETE SET NULL, title text NOT NULL, date date NOT NULL, done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), audience text NOT NULL DEFAULT 'everyone', start_time time, duration_min smallint,
  is_meeting boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')));
CREATE TABLE session_attendance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE, checked_in_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (session_id, member_id));
CREATE TABLE drill_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, title text NOT NULL, category text, duration_min integer,
  audience text, content jsonb NOT NULL, status text NOT NULL DEFAULT 'draft'::text, source text NOT NULL DEFAULT 'ai'::text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), approved_by uuid, approved_at timestamptz, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drill_plans_content_chk CHECK ((jsonb_typeof(content) = 'object'::text)),
  CONSTRAINT drill_plans_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE,
  CONSTRAINT drill_plans_duration_chk CHECK (((duration_min IS NULL) OR (duration_min > 0))),
  CONSTRAINT drill_plans_source_chk CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text]))),
  CONSTRAINT drill_plans_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text]))),
  CONSTRAINT drill_plans_title_chk CHECK ((btrim(title) <> ''::text)));
CREATE TABLE session_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid REFERENCES training_sessions(id) ON DELETE SET NULL,
  title text, source text CHECK ((source IS NULL) OR (source = ANY (ARRAY['upload'::text, 'ai'::text]))), storage_path text, ai_text text, created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), drill_plan_id uuid REFERENCES drill_plans(id) ON DELETE SET NULL);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, verified boolean NOT NULL DEFAULT false);
` + order.map((k) => L.defs[k].def + ";\n").join("") + `
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f); END LOOP; END $$;
ALTER TABLE drill_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read drill_plans" ON drill_plans FOR SELECT TO authenticated USING (department_id = my_department_id());
INSERT INTO departments VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)');
INSERT INTO members (department_id, name, email, access) VALUES ('${A}', 'A DA', 'da@a.test', '{Department Admin}'), ('${B}', 'B FF', 'ff@b.test', '{Member}');
INSERT INTO station_presence (department_id, verified) VALUES ('${A}', true), ('${B}', true);
`;
const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—|leader =/.test(l)).join("\n");
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }
const log = (s) => console.log(s);
const redOf = (e) => { const r = report(e); return { fails: r.split("\n").filter((l) => /FAIL/.test(l)), tail: r.split("\n").pop() }; };

{ const db = await fresh();
  const pins = Object.fromEntries([...MIG.matchAll(/'(public\.[a-z_]+\([^']*\))',\s+'([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]]));
  let ok = 0; const bad = [];
  for (const [sig, md5] of Object.entries(pins)) { const r = await db.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig]); if (r.rows[0].m === md5) ok++; else bad.push(sig); }
  log(`pins: ${ok}/${Object.keys(pins).length} mock bodies md5-equal to the live pins (all live bodies, no stubs) ${bad.length ? JSON.stringify(bad) : ""}`);
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
  ["is_training_manager() drifted", `CREATE OR REPLACE FUNCTION public.is_training_manager() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select true $$;`],
  ["drill_plans gained a write policy", `CREATE POLICY "anyone writes" ON drill_plans FOR INSERT TO authenticated WITH CHECK (true);`],
  ["source CHECK already widened", `ALTER TABLE drill_plans DROP CONSTRAINT drill_plans_source_chk; ALTER TABLE drill_plans ADD CONSTRAINT drill_plans_source_chk CHECK (source IN ('ai','manual','library'));`],
]) { const db = await fresh(); await db.exec(sql);
  try { await db.exec(MIG); log(`FAIL drift "${label}" NOT refused`); process.exitCode = 1; } catch (e) { log(`drift "${label}": refused -> ${firstLine(e)}`); }
  await db.close(); }

const MUT = [
  ["M1 catalog readable by anon", (s) => s.replace("REVOKE ALL ON TABLE public.library_drills FROM PUBLIC, anon, authenticated", "REVOKE ALL ON TABLE public.library_drills FROM PUBLIC, authenticated")],
  ["M2 origin_department_id selectable", (s) => s.replace("GRANT SELECT (id, code, title, track, level, duration_min, audience, content, origin, credit_name,", "GRANT SELECT (id, code, title, track, level, duration_min, audience, content, origin, origin_department_id, credit_name,")],
  ["M3 unpublished drills readable", (s) => s.replace(`FOR SELECT TO authenticated USING (state = 'published') $p$;`, `FOR SELECT TO authenticated USING (true) $p$;`)],
  ["M4 pull open to every member", (s) => s.replace("IF v_dept IS NULL OR v_me IS NULL OR NOT coalesce(public.is_training_manager(), false) THEN", "IF v_dept IS NULL OR v_me IS NULL THEN")],
  ["M5 pull lands approved (skips the officer)", (s) => s.replace("l.content, 'draft', 'library'", "l.content, 'approved', 'library'")],
  ["M6 pull allows duplicates", (s) => s.replace("IF FOUND THEN RAISE EXCEPTION 'ALREADY_PULLED: that drill is already in your plans.'; END IF;", "")],
  ["M7 pull of unpublished drills", (s) => s.replace("WHERE id = p_library_id AND state = 'published';", "WHERE id = p_library_id;")],
  ["M8 usage counts unattended sessions", (s) => s.replace("AND EXISTS (SELECT 1 FROM public.session_attendance a WHERE a.session_id = s.id)", "")],
  ["M9 usage for anyone (no member check)", (s) => s.replace("WHERE public.my_member_id() IS NOT NULL\n         AND l.state", "WHERE true\n         AND l.state")],
  ["M10 a pre-existing function touched", (s) => s.replace("  -- ---------------------------------------------------------------- 5. post-conditions", "  EXECUTE $x$ CREATE OR REPLACE FUNCTION public.is_training_officer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $b$ select true $b$ $x$;\n  -- ---------------------------------------------------------------- 5. post-conditions")],
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
  ["D1 anon granted SELECT later", `GRANT SELECT ON public.library_drills TO anon;`],
  ["D2 policy loosened to every row", `ALTER POLICY "published library drills" ON public.library_drills USING (true);`],
  ["D3 a seed packet withdrawn", `UPDATE public.library_drills SET state = 'withdrawn' WHERE code = 'EMS-203';`],
  ["D4 source CHECK reverted (no 'library')", `ALTER TABLE public.drill_plans DROP CONSTRAINT drill_plans_library_source_chk; ALTER TABLE public.drill_plans DROP CONSTRAINT drill_plans_source_chk; ALTER TABLE public.drill_plans ADD CONSTRAINT drill_plans_source_chk CHECK (source IN ('ai','manual','library','x'));`],
];
log("post-apply drift (RETEST alone must catch):");
for (const [label, sql] of DRIFT) {
  const db = await fresh(); await db.exec(MIG); await db.exec(sql);
  try { await db.exec(RET); } catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}
