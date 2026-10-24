// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/ai_drafting_sliceA_dryrun_harness.mjs [pin]
// PGlite dry run for sql/ai_drafting_sliceA_DRAFT.sql + sql/ai_drafting_sliceA_RETEST.sql. No network, no live DB.
// The base is a mock Supabase (anon / authenticated roles, auth.email() from request.jwt.claims, Supabase's default grants)
// carrying the LIVE gate bodies (Step 0, 2026-10-24: is_canmanage_ops / my_department_id / my_member_id / is_canmanage /
// is_dept_admin — byte-identical, so their md5 pins are exercised for real) and session_plans in its live shape (columns,
// source CHECK, session FK, its four live policies, RLS on). Then:
//   pin      — run once with the new-RPC md5 pin off, write the six md5s into the DRAFT (run once, before review)
//   default  — the RETEST before the migration (must fail: nothing there), apply + state check, a re-run (refused),
//              the RETEST after (the report), then the mutation battery: each mutation must be REFUSED by the
//              migration's pre/post-conditions, or — with the post-conditions stripped — caught by the RETEST.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const root = fileURLToPath(new URL("../../", import.meta.url));
const MIG_PATH = join(root, "sql/ai_drafting_sliceA_DRAFT.sql");
let mig = readFileSync(MIG_PATH, "utf8");
const ret = readFileSync(join(root, "sql/ai_drafting_sliceA_RETEST.sql"), "utf8");
const GATES = JSON.parse(readFileSync(join(root, "docs/review/ai_drafting_sliceA_STEP0_gates.json"), "utf8"));

const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", G = "00000000-0000-0000-0000-00000000000c";
const mock = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active');
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE training_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid REFERENCES departments(id) ON DELETE CASCADE, title text, date date);
CREATE TABLE session_plans (id uuid NOT NULL DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid, title text, source text, storage_path text, ai_text text, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_plans_pkey PRIMARY KEY (id),
  CONSTRAINT session_plans_session_id_fkey FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE SET NULL,
  CONSTRAINT session_plans_source_check CHECK (((source IS NULL) OR (source = ANY (ARRAY['upload'::text, 'ai'::text])))));
${["my_department_id()", "my_member_id()", "is_canmanage()", "is_canmanage_ops()", "is_dept_admin()"].map((f) => GATES[f].def + ";").join("\n")}
REVOKE EXECUTE ON FUNCTION public.is_canmanage_ops(), public.my_department_id(), public.my_member_id(), public.is_canmanage(), public.is_dept_admin() FROM PUBLIC, anon;
ALTER TABLE session_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "canmanage delete session_plans" ON session_plans FOR DELETE TO authenticated USING (((department_id = my_department_id()) AND is_canmanage_ops()));
CREATE POLICY "canmanage insert session_plans" ON session_plans FOR INSERT TO authenticated WITH CHECK (((department_id = my_department_id()) AND is_canmanage()));
CREATE POLICY "canmanage update session_plans" ON session_plans FOR UPDATE TO authenticated USING (((department_id = my_department_id()) AND is_canmanage_ops())) WITH CHECK (((department_id = my_department_id()) AND is_canmanage_ops()));
CREATE POLICY "members read session_plans" ON session_plans FOR SELECT TO authenticated USING ((department_id = my_department_id()));
CREATE FUNCTION public.lockedtok() RETURNS text LANGUAGE sql AS $$ select 'is verified' $$;
INSERT INTO departments VALUES ('${A}','Indian Harbor Volunteer Fire Department'),('${B}','North Hood County Volunteer Fire Department'),('${G}','Granbury Fire Station');
INSERT INTO members (department_id,email,name,access) VALUES
  ('${A}','ada@a','Ada DA','{Department Admin}'),('${A}','oli@a','Oli Officer','{Officer}'),('${A}','m@a','Mo Member','{Member}'),('${A}','bea@a','Bea Board','{Board Member}'),
  ('${B}','bob@b','Bob DA','{Department Admin}'),('${B}','cal@b','Cal Member','{Member}'),
  ('${G}','gil@c','Gil DA','{Department Admin}');
INSERT INTO training_sessions (department_id, title, date) VALUES ('${A}','Hose drill','2026-10-20'),('${B}','Pump ops','2026-10-21');
INSERT INTO session_plans (department_id, session_id, title, source, ai_text, created_by)
  SELECT department_id, id, title || ' plan', 'ai', '## Quick Run Sheet\n- existing', 'Someone' FROM training_sessions;
INSERT INTO session_plans (department_id, title, source, storage_path, created_by) VALUES ('${A}','Uploaded.pdf','upload','x/y.pdf','Someone');
`;
async function base(extra = "") { const d = new PGlite(); await d.exec(mock); if (extra) await d.exec(extra); return d; }
const md = async (d, f) => (await d.query(`select md5(pg_get_functiondef('public.${f}'::regprocedure)) m`)).rows[0].m;
const KEYS = { SET: "set_drill_plan(uuid,text,text,integer,text,jsonb,text)", APPROVE: "approve_drill_plan(uuid)", UNAPPROVE: "unapprove_drill_plan(uuid)",
               DELETE: "delete_drill_plan(uuid)", LIST: "dept_drill_plans()", ATTACH: "attach_drill_plan_to_session(uuid,uuid)" };
const PIN = "    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> NEW ->> f THEN\n      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', f;\n    END IF;\n";
const NOPIN = (s) => s.replace(PIN, "");

// the live gate md5s must reproduce under PGlite, or the precondition pins would be testing nothing
{ const d = await base(); for (const [f, g] of Object.entries(GATES)) console.log(`gate ${f}: live ${g.md5} · here ${await md(d, f)} ${g.md5 === await md(d, f) ? "(identical)" : "(DIFFERENT)"}`); }

if (process.argv[2] === "pin") {
  const d = await base(); await d.exec(NOPIN(mig).replace(/@@MD5_[A-Z]+@@/g, "x"));
  for (const [k, f] of Object.entries(KEYS)) { const m = await md(d, f); console.log("pin", k, m); mig = mig.replace(`@@MD5_${k}@@`, m); }
  writeFileSync(MIG_PATH, mig); console.log("pinned"); process.exit(0);
}
if (mig.includes("@@MD5_")) throw new Error("unpinned — run with `pin` first");
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).join(" | ");
const sub = (a, b, s = mig) => { if (!s.includes(a)) throw new Error("anchor missing: " + a.slice(0, 80)); return s.replace(a, () => b); };
const NOPOST = (s) => s.replace(/  -- -{10,} post-conditions[\s\S]*?\nEND\n\$migrate\$;/, "END\n$migrate$;");
const PC = "  -- ---------------------------------------------------------------- post-conditions";

{ const d = await base(); try { await d.exec(ret); console.log("\nPRE-MIGRATION RETEST: no error?!"); } catch (e) { console.log("\nPRE-MIGRATION RETEST (must fail — nothing there yet):\n  " + e.message.split("\n")[0]); } }
{ const d = await base();
  const res = await d.exec(mig);
  console.log("\nAPPLY — state:", JSON.stringify(res.at(-1).rows));
  try { await d.exec(mig); console.log("re-run: applied twice?!"); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
  const before = (await d.query("select count(*)::int n, string_agg(id::text || coalesce(ai_text,'') || coalesce(drill_plan_id::text,'-'), ',' order by id) s from session_plans")).rows[0];
  try { await d.exec(ret); } catch (e) { console.log("\nRETEST AFTER THE MIGRATION:\n" + show(e)); }
  const after = (await d.query("select count(*)::int n, string_agg(id::text || coalesce(ai_text,'') || coalesce(drill_plan_id::text,'-'), ',' order by id) s from session_plans")).rows[0];
  console.log(`rolled back: session_plans ${before.n} -> ${after.n} rows, ${before.s === after.s ? "identical" : "CHANGED"}; drill_plans rows ${(await d.query("select count(*)::int n from drill_plans")).rows[0].n}`); }

console.log("\nmutations (each must be REFUSED by the migration, or caught by the RETEST):");
const WRITE_POL = "  CREATE POLICY \"members write drill_plans\" ON public.drill_plans FOR INSERT TO authenticated WITH CHECK (true);\n";
const EDIT_SCOPE = "       where id = p_id and department_id = v_dept\n      returning * into v_row;";
const SESS_SCOPE = "    if not exists (select 1 from public.training_sessions where id = p_session_id and department_id = v_dept) then";
const GATE_SET = "    if v_dept is null or not coalesce(public.is_canmanage_ops(), false) then\n      raise exception 'Only a Department Admin or Officer can manage drill plans.';";
const GRANT = "                            public.attach_drill_plan_to_session(uuid, uuid) TO authenticated;";
const CONTENT_CHK = " CONSTRAINT drill_plans_content_chk CHECK (jsonb_typeof(content) = 'object')";
const CONTENT_RPC = "    if p_content is null or jsonb_typeof(p_content) <> 'object' then raise exception 'A drill plan''s content must be a JSON object.'; end if;\n";
const FK = "    CONSTRAINT session_plans_drill_plan_id_fkey REFERENCES public.drill_plans(id) ON DELETE SET NULL;";
const DEDUPE = "    if exists (select 1 from public.session_plans where session_id = p_session_id and drill_plan_id = p_plan_id) then\n      raise exception 'That plan is already attached to this session.';\n    end if;\n";
const UNAPP = "    update public.drill_plans set status = 'draft', approved_by = null, approved_at = null";
const LIST_SCOPE = "   where p.department_id = public.my_department_id()\n";
for (const [l, m, extra] of [
  ["(a) a write policy slipped onto drill_plans", sub(PC, WRITE_POL + PC)],
  ["(a2) same, post-conditions removed", NOPOST(sub(PC, WRITE_POL + PC))],
  ["(b) set_drill_plan's edit not department-scoped", sub(EDIT_SCOPE, "       where id = p_id\n      returning * into v_row;")],
  ["(b2) same, post-conditions removed", NOPOST(sub(EDIT_SCOPE, "       where id = p_id\n      returning * into v_row;"))],
  ["(c) set_drill_plan gated on is_canmanage() (Board too) instead of is_canmanage_ops()", sub(GATE_SET, GATE_SET.replace("is_canmanage_ops()", "is_canmanage()"))],
  ["(c2) same, post-conditions removed", NOPOST(sub(GATE_SET, GATE_SET.replace("is_canmanage_ops()", "is_canmanage()")))],
  ["(d) an RPC left executable by anon", sub(GRANT, GRANT.replace("TO authenticated;", "TO authenticated, anon;"))],
  ["(d2) same, post-conditions removed", NOPOST(sub(GRANT, GRANT.replace("TO authenticated;", "TO authenticated, anon;")))],
  ["(e) the content-is-an-object CHECK dropped", sub(CONTENT_CHK, "")],
  ["(e2) CHECK + the RPC's object check dropped, post-conditions removed", NOPOST(sub(CONTENT_RPC, "", sub(CONTENT_CHK, "")))],
  ["(f) attach doesn't check the session's department", sub(SESS_SCOPE, "    if not exists (select 1 from public.training_sessions where id = p_session_id) then")],
  ["(f2) same, post-conditions removed", NOPOST(sub(SESS_SCOPE, "    if not exists (select 1 from public.training_sessions where id = p_session_id) then"))],
  ["(g) the link cascades (delete takes the session plans with it)", sub(FK, FK.replace("SET NULL", "CASCADE"))],
  ["(g2) same, post-conditions removed", NOPOST(sub(FK, FK.replace("SET NULL", "CASCADE")))],
  ["(h) attach dedupe removed, post-conditions removed", NOPOST(sub(DEDUPE, ""))],
  ["(i) unapprove leaves approved_by / approved_at, post-conditions removed", NOPOST(sub(UNAPP, "    update public.drill_plans set status = 'draft'"))],
  ["(j) dept_drill_plans not department-scoped, post-conditions removed", NOPOST(sub(LIST_SCOPE, ""))],
  ["(k) an existing session_plans policy changed in the block", sub(PC, "  ALTER POLICY \"members read session_plans\" ON public.session_plans USING (true);\n" + PC)],
  ["(l) a collateral change to an existing function", sub(PC, "  EXECUTE replace(pg_get_functiondef('public.is_canmanage()'::regprocedure), '''Officer''', '''Officer'',''Member''');\n" + PC)],
  ["(m) an index slipped onto session_plans", sub(PC, "  CREATE INDEX session_plans_drill_plan_idx ON public.session_plans (drill_plan_id);\n" + PC)],
  ["(n) live drift: is_canmanage_ops() widened to Board", mig, GATES["is_canmanage_ops()"].def.replace("array['Department Admin','Officer']", "array['Department Admin','Officer','Board Member']") + ";"],
  ["(o) live drift: session_plans source CHECK widened", mig, "ALTER TABLE session_plans DROP CONSTRAINT session_plans_source_check; ALTER TABLE session_plans ADD CONSTRAINT session_plans_source_check CHECK (source IS NULL OR source IN ('upload','ai','library'));"],
  ["(p) already applied (drill_plans exists)", mig, "CREATE TABLE public.drill_plans (id uuid PRIMARY KEY);"],
]) {
  const db = await base(extra);
  try { await db.exec(m); try { await db.exec(ret); console.log(`  ${l}\n     NOT CAUGHT — migration applied and the RETEST raised nothing?!`); } catch (e) { const b = brief(e); console.log(`  ${l}\n     migration applied -> RETEST: ${b}${/ 0 failed/.test(b) ? "   <-- NOT CAUGHT" : ""}`); } }
  catch (e) { console.log(`  ${l}\n     REFUSED: ${e.message.split("\n")[0]}`); }
}
