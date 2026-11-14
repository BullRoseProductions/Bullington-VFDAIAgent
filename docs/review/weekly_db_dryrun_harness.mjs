// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/weekly_db_dryrun_harness.mjs ; echo "exit $?"
// DRY RUN for sql/weekly_drill_db_DRAFT.sql + its RETEST — NOT the live DB.
// Mock = the LIVE capture docs/review/weekly_db_LIVEDEFS.json (2026-11-14): drill_plans' live columns, constraints, indexes and
// policy; departments with the live probation guard; ai_call_usage as live; and all 13 captured functions as their LIVE bodies
// (+ is_training_officer / is_training_manager from Library S1's live capture, 2026-10-27 — pinned too), with Supabase-style
// roles (service_role BYPASSRLS), default grants and an auth.role() / auth.email() that read request.jwt.claims.
// Runs: pins -> migration -> state row -> re-run (must refuse) -> RETEST -> pre-apply drift refusals -> mutations -> post-apply drift.
// Every run reports its exit code: a non-zero exit fails the run, however many PASS lines it printed.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/weekly_db_LIVEDEFS.json"), "utf8"));
const MIG = readFileSync(join(root, "sql/weekly_drill_db_DRAFT.sql"), "utf8");
const RET = readFileSync(join(root, "sql/weekly_drill_db_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const DEFS = { ...L.defs, ...L.defs_from_s1_capture_2026_10_27 };
const order = ["my_department_id()", "my_member_id()", "is_training_officer()", "is_training_manager()", "set_probation_enabled(boolean)",
  "tg_departments_probation_enabled_guard()", "record_ai_call(text)", "dept_drill_plans()", "set_drill_plan(uuid,text,text,integer,text,jsonb,text)",
  "approve_drill_plan(uuid)", "unapprove_drill_plan(uuid)", "delete_drill_plan(uuid)", "attach_drill_plan_to_session(uuid,uuid)",
  "pull_library_drill(uuid)", "library_drill_usage()"];
if (order.length !== Object.keys(DEFS).length) throw new Error("harness: every captured def must be loaded");

const schema = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email(), auth.role() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text NOT NULL, city text, aftercall_enabled boolean NOT NULL DEFAULT false,
  probation_enabled boolean NOT NULL DEFAULT false);
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
CREATE TABLE library_drills (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, title text NOT NULL, track text, level text, duration_min integer,
  audience text, content jsonb NOT NULL DEFAULT '{}', origin text NOT NULL DEFAULT 'seed', credit_name text, origin_department_id uuid,
  state text NOT NULL DEFAULT 'published', content_hash text, published_at timestamptz, published_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE drill_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, title text NOT NULL, category text, duration_min integer,
  audience text, content jsonb NOT NULL, status text NOT NULL DEFAULT 'draft'::text, source text NOT NULL DEFAULT 'ai'::text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), approved_by uuid, approved_at timestamptz, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  library_id uuid,
  CONSTRAINT drill_plans_content_chk CHECK ((jsonb_typeof(content) = 'object'::text)),
  CONSTRAINT drill_plans_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE,
  CONSTRAINT drill_plans_duration_chk CHECK (((duration_min IS NULL) OR (duration_min > 0))),
  CONSTRAINT drill_plans_library_id_fkey FOREIGN KEY (library_id) REFERENCES library_drills(id) ON DELETE SET NULL,
  CONSTRAINT drill_plans_library_source_chk CHECK (((library_id IS NULL) OR (source = 'library'::text))),
  CONSTRAINT drill_plans_source_chk CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text, 'library'::text]))),
  CONSTRAINT drill_plans_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text]))),
  CONSTRAINT drill_plans_title_chk CHECK ((btrim(title) <> ''::text)));
CREATE INDEX drill_plans_dept_status_idx ON drill_plans USING btree (department_id, status);
CREATE INDEX drill_plans_library_idx ON drill_plans USING btree (library_id) WHERE (library_id IS NOT NULL);
CREATE TABLE session_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid REFERENCES training_sessions(id) ON DELETE SET NULL,
  title text, source text CHECK ((source IS NULL) OR (source = ANY (ARRAY['upload'::text, 'ai'::text]))), storage_path text, ai_text text, created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), drill_plan_id uuid REFERENCES drill_plans(id) ON DELETE SET NULL);
CREATE TABLE ai_call_usage (member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE, department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  day date NOT NULL, route text NOT NULL CHECK (route IN ('claude', 'concepts', 'assistant', 'image')), count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (member_id, day, route));
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, verified boolean NOT NULL DEFAULT false);
` + order.map((k) => DEFS[k].def + ";\n").join("") + `
CREATE TRIGGER departments_probation_enabled_guard BEFORE UPDATE OF probation_enabled ON public.departments FOR EACH ROW EXECUTE FUNCTION tg_departments_probation_enabled_guard();
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f); END LOOP; END $$;
REVOKE EXECUTE ON FUNCTION tg_departments_probation_enabled_guard() FROM authenticated;
ALTER TABLE ai_call_usage ENABLE ROW LEVEL SECURITY; REVOKE ALL ON TABLE ai_call_usage FROM PUBLIC, anon, authenticated;
ALTER TABLE drill_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read drill_plans" ON drill_plans FOR SELECT TO authenticated USING (department_id = my_department_id());
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own department" ON departments FOR SELECT TO authenticated USING (id = my_department_id());
CREATE POLICY "admins update own department" ON departments FOR UPDATE TO authenticated USING (id = my_department_id()) WITH CHECK (id = my_department_id());
INSERT INTO departments (id, name) VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)');
INSERT INTO members (department_id, name, email, access) VALUES ('${A}', 'A DA', 'da@a.test', '{Department Admin}'), ('${A}', 'A FF', 'ff@a.test', '{Member}'),
  ('${B}', 'B DA', 'da@b.test', '{Department Admin}'), ('${B}', 'B FF', 'ff@b.test', '{Member}');
INSERT INTO drill_plans (department_id, title, content, status, source, approved_by, approved_at)
  SELECT '${A}', 'Existing approved (mock)', '{}'::jsonb, 'approved', 'manual', m.id, now() FROM members m WHERE m.email = 'da@a.test';
INSERT INTO station_presence (department_id, verified) VALUES ('${A}', true), ('${B}', true);
`;
const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
// Deterministic output: fixture ids are random per run, so every uuid is printed as <uuid> (DRYRUN.txt == this output, byte for byte).
const log = (s) => console.log(String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"));
const redOf = (e) => { const r = report(e); return { fails: r.split("\n").filter((l) => /FAIL/.test(l)), tail: r.split("\n").pop() }; };
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }

// pins: every pin in the migration equals the mock body, which IS the live capture
{ const db = await fresh();
  const pins = Object.fromEntries([...MIG.matchAll(/'(public\.[a-z_]+\([^']*\))',\s+'([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]]));
  let ok = 0; const bad = [];
  for (const [sig, md5] of Object.entries(pins)) {
    const r = await db.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig]);
    const cap = DEFS[sig.replace("public.", "")]?.md5;
    if (r.rows[0].m === md5 && cap === md5) ok++; else bad.push(sig);
  }
  log(`pins: ${ok}/${Object.keys(pins).length} — each equals the live-captured md5 AND the mock body ${bad.length ? JSON.stringify(bad) : ""}`);
  if (bad.length || Object.keys(pins).length !== 14) { log("FAIL pins"); process.exitCode = 1; }
  await db.close(); }

{ const db = await fresh();
  await db.exec(MIG);
  const st = await db.query(MIG.slice(MIG.indexOf("SELECT jsonb_build_object(")));
  log("migration: applied. state row: " + JSON.stringify(st.rows[0].state));
  try { await db.exec(MIG); log("FAIL re-run NOT refused"); process.exitCode = 1; } catch (e) { log("re-run: refused -> " + firstLine(e)); }
  try { await db.exec(RET); log("FAIL RETEST did not end in its report"); process.exitCode = 1; }
  catch (e) { log("RETEST:\n" + report(e)); if (!/ 0 failed \/ 0 skipped/.test(report(e))) process.exitCode = 1; }
  await db.close(); }

for (const [label, sql] of [
  ["approve_drill_plan drifted", `CREATE OR REPLACE FUNCTION public.approve_drill_plan(p_id uuid) RETURNS drill_plans LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ select * from drill_plans where id = p_id $$;`],
  ["record_ai_call drifted", `CREATE OR REPLACE FUNCTION public.record_ai_call(p_route text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$ select '{}'::jsonb $$;`],
  ["source CHECK already widened", `ALTER TABLE drill_plans DROP CONSTRAINT drill_plans_source_chk; ALTER TABLE drill_plans ADD CONSTRAINT drill_plans_source_chk CHECK (source IN ('ai','manual','library','ai_weekly'));`],
  ["drill_plans policy loosened", `ALTER POLICY "members read drill_plans" ON drill_plans USING (true);`],
  ["an unaudited drill_plans trigger", `CREATE FUNCTION public.zz_t() RETURNS trigger LANGUAGE plpgsql AS $$ begin return new; end $$; CREATE TRIGGER zz BEFORE UPDATE ON drill_plans FOR EACH ROW EXECUTE FUNCTION zz_t();`],
  ["an approved plan with no approver", `ALTER TABLE drill_plans DISABLE TRIGGER ALL; INSERT INTO drill_plans (department_id, title, content, status, source) VALUES ('${A}', 'orphan approved', '{}', 'approved', 'ai');`],
  ["a slice-4 name already taken", `ALTER TABLE departments ADD COLUMN weekly_drill_draft_enabled boolean;`],
]) { const db = await fresh(); await db.exec(sql);
  try { await db.exec(MIG); log(`FAIL drift "${label}" NOT refused`); process.exitCode = 1; } catch (e) { log(`drift "${label}": refused -> ${firstLine(e)}`); }
  await db.close(); }

const MUT = [
  ["M1 put callable by authenticated", (s) => s.replace("REVOKE ALL ON FUNCTION public.put_weekly_drill_draft(uuid,text,text,text,integer,text,jsonb) FROM PUBLIC, anon, authenticated;", "REVOKE ALL ON FUNCTION public.put_weekly_drill_draft(uuid,text,text,text,integer,text,jsonb) FROM PUBLIC, anon;")],
  ["M2 put's role check removed", (s) => s.replace("  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;\n  if p_week", "  if false and coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized'; end if;\n  if p_week")],
  ["M3 put ignores the toggle", (s) => s.replace("if not v_on then return jsonb_build_object('result', 'disabled', 'id', null); end if;", "")],
  ["M4 put lands approved-looking (source ai)", (s) => s.replace("'draft', 'ai_weekly', p_week, null, null)", "'draft', 'ai', null, null, null)")],
  ["M5 put records an author", (s) => s.replace("'draft', 'ai_weekly', p_week, null, null)", "'draft', 'ai_weekly', p_week, (select id from members where department_id = p_department_id limit 1), null)")],
  ["M6 put overwrites on conflict", (s) => s.replace("on conflict (department_id, weekly_key) where weekly_key is not null do nothing", "on conflict (department_id, weekly_key) where weekly_key is not null do update set title = excluded.title")],
  ["M7 approval trigger only checks non-null approver", (s) => s.replace("if v_me is null or new.approved_by is distinct from v_me then", "if new.approved_by is null then")],
  ["M8 approval trigger skips INSERT", (s) => s.replace("and (tg_op = 'INSERT' or old.status is distinct from 'approved' or new.approved_by is distinct from old.approved_by)", "and tg_op = 'UPDATE' and (old.status is distinct from 'approved' or new.approved_by is distinct from old.approved_by)")],
  ["M9 approval trigger ignores re-attribution", (s) => s.replace(" or new.approved_by is distinct from old.approved_by) then", ") then")],
  ["M10 approval trigger never created", (s) => s.replace("  CREATE TRIGGER drill_plans_human_approval BEFORE INSERT OR UPDATE ON public.drill_plans\n    FOR EACH ROW EXECUTE FUNCTION public.tg_drill_plans_human_approval();\n", "")],
  ["M11 weekly_key not required for ai_weekly", (s) => s.replace("(source = 'ai_weekly' AND weekly_key IS NOT NULL AND weekly_key ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$')", () => "(source = 'ai_weekly')")],
  ["M12 no unique week per department", (s) => s.replace("  CREATE UNIQUE INDEX drill_plans_weekly_key_uniq ON public.drill_plans (department_id, weekly_key) WHERE weekly_key IS NOT NULL;", "  CREATE INDEX drill_plans_weekly_key_uniq ON public.drill_plans (department_id, weekly_key) WHERE weekly_key IS NOT NULL;")
                                               .replace("on conflict (department_id, weekly_key) where weekly_key is not null do nothing\n  returning id into v_id;", "returning id into v_id;")],
  ["M13 toggle RPC lets any member flip it", (s) => s.replace("and x.access && array['Department Admin']::text[] and x.status in ('Active', 'Probationary')) then\n    raise exception 'Only a Department Admin can turn the weekly", "and x.status in ('Active', 'Probationary')) then\n    raise exception 'Only a Department Admin can turn the weekly")],
  ["M14 toggle guard missing", (s) => s.replace("  CREATE TRIGGER departments_weekly_drill_draft_guard BEFORE UPDATE OF weekly_drill_draft_enabled ON public.departments\n    FOR EACH ROW EXECUTE FUNCTION public.tg_departments_weekly_drill_draft_guard();\n", "")],
  ["M15 toggle defaults ON", (s) => s.replace("ADD COLUMN weekly_drill_draft_enabled boolean NOT NULL DEFAULT false;", "ADD COLUMN weekly_drill_draft_enabled boolean NOT NULL DEFAULT true;")],
  ["M16 backstop ignores members' calls", (s) => s.replace("select coalesce((select sum(u.count) from public.ai_call_usage u where u.department_id = p_department_id and u.day = v_day and u.route = p_route), 0)\n       + ", "select 0 + ")],
  ["M17 backstop callable by authenticated", (s) => s.replace("REVOKE ALL ON FUNCTION public.record_dept_ai_call(uuid,text) FROM PUBLIC, anon, authenticated;", "REVOKE ALL ON FUNCTION public.record_dept_ai_call(uuid,text) FROM PUBLIC, anon;")],
  ["M18 usage table readable by service_role", (s) => s.replace("REVOKE ALL ON TABLE public.ai_dept_call_usage FROM PUBLIC, anon, authenticated, service_role;", "REVOKE ALL ON TABLE public.ai_dept_call_usage FROM PUBLIC, anon, authenticated;")],
  ["M19 a pre-existing function touched", (s) => s.replace("  -- ---------------------------------------------------------------- 6. post-conditions", "  EXECUTE $x$ CREATE OR REPLACE FUNCTION public.dept_drill_plans() RETURNS TABLE(id uuid, title text, category text, duration_min integer, audience text, content jsonb, status text, source text, created_by uuid, created_at timestamp with time zone, approved_by uuid, approved_at timestamp with time zone, updated_by uuid, updated_at timestamp with time zone, attached_sessions integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $b$ select p.id, p.title, p.category, p.duration_min, p.audience, p.content, p.status, p.source, p.created_by, p.created_at, p.approved_by, p.approved_at, p.updated_by, p.updated_at, 0 from public.drill_plans p $b$ $x$;\n  -- ---------------------------------------------------------------- 6. post-conditions")],
  ["M20 approval CHECK dropped", (s) => s.replace("  ALTER TABLE public.drill_plans ADD CONSTRAINT drill_plans_approved_by_chk CHECK (status <> 'approved' OR approved_by IS NOT NULL);\n", "")],
];
log("mutations:");
for (const [label, fn] of MUT) {
  const m = fn(MIG); if (m === MIG) { log(`   ${label}: MUTATION DID NOT APPLY (harness bug)`); process.exitCode = 1; continue; }
  const db = await fresh();
  try { await db.exec(m); } catch (e) { log(`   ${label}: migration REFUSED -> ${firstLine(e)}`); await db.close(); continue; }
  try { await db.exec(RET); log(`   ${label}: !! RETEST did not report`); process.exitCode = 1; }
  catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}

const DRIFT = [
  ["D1 authenticated granted EXECUTE on put later", `GRANT EXECUTE ON FUNCTION public.put_weekly_drill_draft(uuid,text,text,text,integer,text,jsonb) TO authenticated;`],
  ["D2 approval trigger disabled", `ALTER TABLE drill_plans DISABLE TRIGGER drill_plans_human_approval;`],
  ["D3 toggle guard dropped", `DROP TRIGGER departments_weekly_drill_draft_guard ON departments;`],
  ["D4 source CHECK reverted", `ALTER TABLE drill_plans DROP CONSTRAINT drill_plans_source_chk; ALTER TABLE drill_plans ADD CONSTRAINT drill_plans_source_chk CHECK (source IN ('ai','manual','library'));`],
  ["D5 usage table opened to authenticated", `GRANT SELECT ON ai_dept_call_usage TO authenticated;`],
  ["D6 approval CHECK dropped", `ALTER TABLE drill_plans DROP CONSTRAINT drill_plans_approved_by_chk;`],
];
log("post-apply drift (RETEST alone must catch):");
for (const [label, sql] of DRIFT) {
  const db = await fresh(); await db.exec(MIG); await db.exec(sql);
  try { await db.exec(RET); log(`   ${label}: !! RETEST did not report`); process.exitCode = 1; }
  catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}
process.exit(process.exitCode || 0);
