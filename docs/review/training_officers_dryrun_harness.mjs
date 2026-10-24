// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/training_officers_dryrun_harness.mjs [pin]
// PGlite dry run for sql/training_officers_DRAFT.sql + sql/training_officers_RETEST.sql. No network, no live DB.
// The base is a mock Supabase (anon / authenticated roles, auth.email() from request.jwt.claims, Supabase's default grants)
// rebuilt from LIVE (docs/review/training_officers_STEP0_OUTPUT.json): the gate bodies (is_canmanage_ops / is_canmanage /
// is_dept_admin / my_department_id / my_member_id / is_equipment_manager), the training tables' 19 live policies verbatim,
// the two membership-window triggers, the four QR sign-in functions, and Slice A (drill_plans + its six RPCs) by running
// the reviewed Slice A migration itself — so every md5 / policy pin in the DRAFT is exercised for real. Plus one
// NON-training is_canmanage_ops() user (an apparatus policy) that must come through untouched.
//   pin      — run once with the new-function md5 pins off, write the nine md5s into the DRAFT
//   default  — the RETEST before (must fail), apply + state, re-run (refused), the RETEST after (the report), the
//              multi-department probe, then the mutations: each REFUSED by the migration, or (post-conditions stripped)
//              caught by the RETEST / the probe.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const root = fileURLToPath(new URL("../../", import.meta.url));
const MIG_PATH = join(root, "sql/training_officers_DRAFT.sql");
let mig = readFileSync(MIG_PATH, "utf8");
const ret = readFileSync(join(root, "sql/training_officers_RETEST.sql"), "utf8");
const S0 = JSON.parse(readFileSync(join(root, "docs/review/training_officers_STEP0_OUTPUT.json"), "utf8"));
const sliceA = execSync("git show origin/feat/ai-drafting-sliceA-db:sql/ai_drafting_sliceA_DRAFT.sql", { cwd: root, maxBuffer: 1 << 24 }).toString();

const fdef = (k) => (S0.gates[k] || S0.training_fns[k] || S0.eq_fns[k]).def + ";";
const pol = (line) => { const [t, n, cmd, roles, ...rest] = line.split(" | "); const q = rest[0], wc = rest.slice(1).join(" | ");
  return `CREATE POLICY "${n}" ON public.${t} FOR ${cmd} TO ${roles.replace(/[{}]/g, "")}${q ? ` USING (${q})` : ""}${wc ? ` WITH CHECK (${wc})` : ""};`; };
const tablePolicies = (tables) => S0.training_policies.filter((l) => tables.includes(l.split(" | ")[0])).map(pol).join("\n");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", G = "00000000-0000-0000-0000-00000000000c";
const mock = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text, station_radius_m int DEFAULT 150);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active');
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE training_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, name text, cadence text, color text);
CREATE TABLE training_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid REFERENCES departments(id) ON DELETE CASCADE, plan_id uuid, title text, date date, done boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), signin_token text, signin_open boolean DEFAULT false, series_id uuid, audience text DEFAULT 'everyone', start_time time, counts_toward_attendance boolean DEFAULT true,
  location_lat double precision, location_lng double precision, location_radius_m integer, location_label text, is_offsite boolean DEFAULT false, duration_min smallint, is_meeting boolean DEFAULT false);
CREATE TABLE session_attendance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, session_id uuid, member_id uuid, checked_in_at timestamptz);
CREATE TABLE session_plans (id uuid NOT NULL DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid, title text, source text, storage_path text, ai_text text, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_plans_pkey PRIMARY KEY (id), CONSTRAINT session_plans_session_id_fkey FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE SET NULL,
  CONSTRAINT session_plans_source_check CHECK (((source IS NULL) OR (source = ANY (ARRAY['upload'::text, 'ai'::text])))));
CREATE TABLE equipment_manager (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, removed_at timestamptz);
CREATE TABLE apparatus (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, name text);
${["my_department_id()", "my_member_id()", "is_canmanage()", "is_canmanage_ops()", "is_dept_admin()"].map(fdef).join("\n")}
${fdef("is_equipment_manager()")}
CREATE FUNCTION public.membership_window_allows(p_member uuid, p_date date) RETURNS boolean LANGUAGE sql STABLE AS $$ select true $$;
${fdef("tg_session_attendance_membership_window()")}
${fdef("tg_training_session_date_membership_window()")}
CREATE TRIGGER session_attendance_membership_window BEFORE INSERT OR UPDATE ON session_attendance FOR EACH ROW EXECUTE FUNCTION tg_session_attendance_membership_window();
CREATE TRIGGER training_session_date_membership_window BEFORE UPDATE ON training_sessions FOR EACH ROW EXECUTE FUNCTION tg_training_session_date_membership_window();
${fdef("open_signin(uuid)")}
${fdef("close_signin(uuid)")}
${fdef("current_signin_token(uuid)")}
${fdef("set_session_location(uuid,double precision,double precision,integer,text)")}
REVOKE EXECUTE ON FUNCTION public.is_canmanage_ops(), public.is_canmanage(), public.is_dept_admin(), public.my_department_id(), public.my_member_id(), public.is_equipment_manager() FROM PUBLIC, anon;
ALTER TABLE training_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE training_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attendance ENABLE ROW LEVEL SECURITY; ALTER TABLE session_plans ENABLE ROW LEVEL SECURITY; ALTER TABLE apparatus ENABLE ROW LEVEL SECURITY;
${tablePolicies(["training_sessions", "training_plans", "session_attendance", "session_plans"])}
CREATE POLICY "leaders add apparatus" ON public.apparatus FOR INSERT TO authenticated WITH CHECK (((department_id = my_department_id()) AND is_canmanage_ops()));
CREATE FUNCTION public.lockedtok() RETURNS text LANGUAGE sql AS $$ select 'is verified' $$;
INSERT INTO departments (id, name) VALUES ('${A}','Indian Harbor Volunteer Fire Department'),('${B}','North Hood County Volunteer Fire Department'),('${G}','Granbury Fire Station');
INSERT INTO members (department_id,email,name,access) VALUES
  ('${A}','ada@a','Ada DA','{Department Admin}'),('${A}','oli@a','Oli Officer','{Officer}'),('${A}','mo@a','Mo Member','{Member}'),('${A}','pat@a','Pat PA','{Project Admin}'),
  ('${A}','dao@a','Dee DA+Officer','{Department Admin,Officer}'),
  ('${B}','bob@b','Bob DA','{Department Admin}'),('${B}','ocy@b','Ocy Officer','{Officer}'),('${B}','cal@b','Cal Member','{Member}'),
  ('${G}','gil@c','Gil DA','{Department Admin}'),
  ('${A}','dual@x','Dual (Officer in A)','{Officer}'),('${B}','dual@x','Dual (member in B)','{Member}');
`;
async function base(extra = "") { const d = new PGlite(); await d.exec(mock); await d.exec(sliceA); if (extra) await d.exec(extra); return d; }
const md = async (d, f) => (await d.query(`select md5(pg_get_functiondef('public.${f}'::regprocedure)) m`)).rows[0].m;
const KEYS = { SET: "set_drill_plan(uuid,text,text,integer,text,jsonb,text)", APPROVE: "approve_drill_plan(uuid)", UNAPPROVE: "unapprove_drill_plan(uuid)", DELETE: "delete_drill_plan(uuid)",
  ATTACH: "attach_drill_plan_to_session(uuid,uuid)", ISTO: "is_training_officer()", ISTM: "is_training_manager()", ASSIGN: "assign_training_officer(uuid)", REMOVE: "remove_training_officer(uuid)" };
const NOPIN = (s) => s.replace("    IF md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> NEWFNS ->> f THEN\n      RAISE EXCEPTION 'Post-condition failed: % does not match its reviewed md5.', f;\n    END IF;\n", "")
  .replace("       OR md5(pg_get_functiondef(('public.' || f)::regprocedure)) <> FNS -> f ->> 1 THEN", "       THEN");

// the live md5s must reproduce under PGlite, or the pins test nothing
{ const d = await base(); for (const k of ["is_canmanage_ops()", "is_dept_admin()", "my_department_id()", "my_member_id()"]) console.log(`gate ${k}: live ${S0.gates[k].md5} · here ${await md(d, k)}`);
  console.log(`gate is_equipment_manager(): live ${S0.eq_fns["is_equipment_manager()"].md5} · here ${await md(d, "is_equipment_manager()")}`);
  for (const k of ["open_signin(uuid)", "set_drill_plan(uuid,text,text,integer,text,jsonb,text)"]) console.log(`fn ${k}: live ${S0.training_fns[k].md5} · here ${await md(d, k)}`); }

if (process.argv[2] === "pin") {
  const d = await base(); await d.exec(NOPIN(mig).replace(/@@MD5_[A-Z]+@@/g, "x"));
  for (const [k, f] of Object.entries(KEYS)) { const m = await md(d, f); console.log("pin", k, m); mig = mig.replace(`@@MD5_${k}@@`, m); }
  writeFileSync(MIG_PATH, mig); console.log("pinned"); process.exit(0);
}
if (mig.includes("@@MD5_")) throw new Error("unpinned — run with `pin` first");
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).map((l) => l.trim().slice(0, 150)).join(" | ");
const sub = (a, b, s = mig) => { if (!s.includes(a)) throw new Error("anchor missing: " + a.slice(0, 80)); return s.replace(a, () => b); };
const NOPOST = (s) => s.replace(/  -- -{10,} post-conditions[\s\S]*?\nEND\n\$migrate\$;/, "END\n$migrate$;");
const PC = "  -- ---------------------------------------------------------------- post-conditions";
// the multi-department probe: dual@x is an Officer (seeded) in A and a plain member in B — acting in B they must NOT manage training
async function probe(d) {
  const q = async (dept) => { await d.exec(`INSERT INTO member_active_department (email, department_id) VALUES ('dual@x', '${dept}') ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
    SELECT set_config('request.jwt.claims', '{"email":"dual@x"}', false); SET role authenticated;`);
    const r = (await d.query("select public.is_training_officer() o, public.is_training_manager() m")).rows[0]; await d.exec("RESET role;"); return r; };
  const inA = await q(A), inB = await q(B);
  return { ok: inA.o && inA.m && !inB.o && !inB.m, text: `dual@x acting in A: officer ${inA.o} manager ${inA.m} · acting in B: officer ${inB.o} manager ${inB.m}` };
}

{ const d = await base(); try { await d.exec(ret); console.log("\nPRE-MIGRATION RETEST: no error?!"); } catch (e) { console.log("\nPRE-MIGRATION RETEST (must fail — nothing there yet):\n  " + e.message.split("\n")[0]); } }
{ const d = await base();
  const res = await d.exec(mig);
  console.log("\nAPPLY — state:", JSON.stringify(res.at(-1).rows));
  try { await d.exec(mig); console.log("re-run: applied twice?!"); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
  console.log("is_canmanage_ops() after:", await md(d, "is_canmanage_ops()"), "· apparatus policy still:", (await d.query("select with_check from pg_policies where policyname='leaders add apparatus'")).rows[0].with_check);
  for (const t of ["training_sessions", "session_attendance"]) console.log(`  repointed ${t}:`, (await d.query(`select policyname, coalesce(qual,'') || ' / ' || coalesce(with_check,'') x from pg_policies where tablename='${t}' and (coalesce(qual,'')||coalesce(with_check,'')) like '%is_training_manager%'`)).rows.map((r) => `${r.policyname}: ${r.x.replace(/\s+/g, " ")}`).join(" || "));
  const before = (await d.query("select count(*)::int n from training_sessions")).rows[0].n;
  try { await d.exec(ret); } catch (e) { console.log("\nRETEST AFTER THE MIGRATION:\n" + show(e)); }
  console.log(`rolled back: training_sessions ${before} -> ${(await d.query("select count(*)::int n from training_sessions")).rows[0].n}; training_officer rows ${(await d.query("select count(*)::int n from training_officer")).rows[0].n} (the seed)`);
  const p = await probe(d); console.log(`\nMULTI-DEPARTMENT PROBE: ${p.ok ? "PASS" : "FAIL"} — ${p.text}`); }

console.log("\nmutations (each must be REFUSED by the migration, or caught by the RETEST / the probe):");
const ISTO_BODY = "       where t.member_id = public.my_member_id()\n         and t.department_id = public.my_department_id()\n         and t.removed_at is null";
const ISTM_DA = "         and m.access && array['Department Admin']::text[]\n    ) or public.is_training_officer();";
const ASSIGN_GATE = "      raise exception 'Only a Department Admin can assign training officers.';";
const ASSIGN_TARGET = "     where id = p_member_id and department_id = v_actor.department_id and status in ('Active','Probationary');";
const SEED_WHERE = "   WHERE m.status IN ('Active', 'Probationary') AND m.access && array['Officer']::text[] AND NOT m.access && array['Department Admin']::text[];\n\n  -- ---------------------------------------------------------------- post-conditions";
const POLLOOP = "    IF r.cmd = 'INSERT' THEN\n      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', r.n, r.t, replace(r.with_check, GATE_OLD, GATE_NEW));";
const REMOVE_UPD = "    update public.training_officer\n       set removed_at = now(), removed_by = v_actor.id, removed_by_name = v_actor.name\n     where id = v_row.id\n    returning * into v_row;";
const FNSWAP = "    EXECUTE v_def;   -- CREATE OR REPLACE from the live body: grants, definer and search_path are kept";
for (const [l, m, extra, wantProbe] of [
  ["(a) is_canmanage_ops() itself changed in the block", sub(PC, "  EXECUTE replace(pg_get_functiondef('public.is_canmanage_ops()'::regprocedure), '''Officer''', '''Officer'',''Board Member''');\n" + PC)],
  ["(b) a 14th object repointed (the NON-training apparatus policy)", sub(PC, "  ALTER POLICY \"leaders add apparatus\" ON public.apparatus WITH CHECK (((department_id = my_department_id()) AND is_training_manager()));\n" + PC)],
  ["(c) a non-training function changed (open_signin's gate widened)", sub(PC, "  EXECUTE replace(pg_get_functiondef('public.open_signin(uuid)'::regprocedure), '''Project Admin''', '''Project Admin'',''Member''');\n" + PC)],
  ["(d) is_training_officer() not department-scoped (the equipment shape)", sub(ISTO_BODY, "       where t.member_id in (select id from public.members where lower(email) = lower(auth.email()))\n         and t.removed_at is null")],
  ["(d2) same, post-conditions removed — the probe must catch it", NOPOST(sub(ISTO_BODY, "       where t.member_id in (select id from public.members where lower(email) = lower(auth.email()))\n         and t.removed_at is null")), "", true],
  ["(e) is_training_manager() admits Project Admin (is_dept_admin shape)", sub(ISTM_DA, "         and m.access && array['Department Admin','Project Admin']::text[]\n    ) or public.is_training_officer();")],
  ["(e2) same, post-conditions removed", NOPOST(sub(ISTM_DA, "         and m.access && array['Department Admin','Project Admin']::text[]\n    ) or public.is_training_officer();"))],
  ["(f) assign gated on is_canmanage_ops() (Officers appoint, PA can't)", sub("    if not coalesce(public.is_dept_admin(), false) then\n" + ASSIGN_GATE, "    if not coalesce(public.is_canmanage_ops(), false) then\n" + ASSIGN_GATE)],
  ["(f2) same, post-conditions removed", NOPOST(sub("    if not coalesce(public.is_dept_admin(), false) then\n" + ASSIGN_GATE, "    if not coalesce(public.is_canmanage_ops(), false) then\n" + ASSIGN_GATE))],
  ["(g) assign accepts a member of another department", sub(ASSIGN_TARGET, "     where id = p_member_id and status in ('Active','Probationary');")],
  ["(g2) same, post-conditions removed", NOPOST(sub(ASSIGN_TARGET, "     where id = p_member_id and status in ('Active','Probationary');"))],
  ["(h) one of the 8 policies not repointed (roster insert left on is_canmanage_ops)", sub(POLLOOP, POLLOOP.replace("IF r.cmd = 'INSERT' THEN", "IF r.cmd = 'INSERT' AND r.t = 'session_attendance' THEN NULL;\n    ELSIF r.cmd = 'INSERT' THEN"))],
  ["(h2) same, post-conditions removed", NOPOST(sub(POLLOOP, POLLOOP.replace("IF r.cmd = 'INSERT' THEN", "IF r.cmd = 'INSERT' AND r.t = 'session_attendance' THEN NULL;\n    ELSIF r.cmd = 'INSERT' THEN")))],
  ["(i) the drill-plan functions not repointed", sub(FNSWAP, "    NULL;")],
  ["(i2) same, post-conditions removed", NOPOST(sub(FNSWAP, "    NULL;"))],
  ["(j) the seed skipped", sub(SEED_WHERE, "   WHERE false;\n\n  -- ---------------------------------------------------------------- post-conditions")],
  ["(j2) same, post-conditions removed", NOPOST(sub(SEED_WHERE, "   WHERE false;\n\n  -- ---------------------------------------------------------------- post-conditions"))],
  ["(k) the seed includes Department Admins", sub(SEED_WHERE, "   WHERE m.status IN ('Active', 'Probationary') AND m.access && array['Officer']::text[];\n\n  -- ---------------------------------------------------------------- post-conditions")],
  ["(l) a write policy slipped onto training_officer", sub(PC, "  CREATE POLICY \"members write training officers\" ON public.training_officer FOR INSERT TO authenticated WITH CHECK (true);\n" + PC)],
  ["(l2) same, post-conditions removed", NOPOST(sub(PC, "  CREATE POLICY \"members write training officers\" ON public.training_officer FOR INSERT TO authenticated WITH CHECK (true);\n" + PC))],
  ["(m) remove hard-deletes (no history), post-conditions removed", NOPOST(sub(REMOVE_UPD, "    delete from public.training_officer where id = v_row.id;"))],
  ["(n) the one-active-per-member guard missing", sub("  CREATE UNIQUE INDEX training_officer_one_active_per_member ON public.training_officer (department_id, member_id) WHERE removed_at IS NULL;\n", "")],
  ["(o) an anon grant left on a gate function", sub("                            public.assign_training_officer(uuid), public.remove_training_officer(uuid) TO authenticated;", "                            public.assign_training_officer(uuid), public.remove_training_officer(uuid) TO authenticated, anon;")],
  ["(p) live drift: is_canmanage_ops() widened before apply", mig, S0.gates["is_canmanage_ops()"].def.replace("array['Department Admin','Officer']", "array['Department Admin','Officer','Board Member']") + ";"],
  ["(q) live drift: a training policy changed before apply", mig, "ALTER POLICY \"leaders update training_plans\" ON public.training_plans USING (((department_id = my_department_id()) AND is_canmanage()));"],
  ["(r) live drift: a drill-plan function changed before apply", mig, "SELECT 1;" + S0.training_fns["approve_drill_plan(uuid)"].def.replace("Self-approval allowed", "Self approval allowed") + ";"],
  ["(s) a training-table trigger dropped in the block", sub(PC, "  DROP TRIGGER session_attendance_membership_window ON public.session_attendance;\n" + PC)],
  ["(t) already applied (training_officer exists)", mig, "CREATE TABLE public.training_officer (id uuid PRIMARY KEY);"],
]) {
  const db = await base(extra);
  try {
    await db.exec(m);
    let line = "migration applied ->";
    try { await db.exec(ret); line += " RETEST raised nothing?!"; } catch (e) { line += " RETEST: " + brief(e); }
    if (wantProbe) { const p = await probe(db); line += `\n     PROBE: ${p.ok ? "PASS" : "FAIL"} — ${p.text}`; }
    const caught = / [1-9]\d* failed/.test(line) || /PROBE: FAIL/.test(line);
    console.log(`  ${l}\n     ${line}${caught ? "" : "   <-- NOT CAUGHT"}`);
  } catch (e) { console.log(`  ${l}\n     REFUSED: ${e.message.split("\n")[0]}`); }
}
