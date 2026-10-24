// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/equipment_manager_scope_dryrun_harness.mjs [pin]
// PGlite dry run for sql/equipment_manager_scope_DRAFT.sql + sql/equipment_manager_scope_RETEST.sql. No network, no live DB.
// The base is a mock Supabase rebuilt from LIVE (docs/review/equipment_manager_scope_STEP0_OUTPUT.json + the Step 0 gate
// bodies): is_equipment_manager() as it is today (md5 c4d54ae1 — reproduced byte-identically here), my_member_id /
// my_department_id / is_dept_admin, the 9 manager policies VERBATIM (+ "members read equipment"), the 5 RPCs and the registry's
// own functions + cap trigger. The MULTI-DEPARTMENT PROBE — dual@x is an equipment manager in A and a plain member in B; acting
// in B: is_equipment_manager(), a write of B's equipment, a read of B's custody, the RPC role check — runs BEFORE the fix (must
// leak: that is the bug) and AFTER (must be refused, while still a manager acting in A).
//   pin      — run once with the md5 pin off, write the reviewed md5 into the DRAFT
//   default  — probe before; RETEST before (must fail S0); apply + state; re-run (refused); RETEST after; probe after;
//              then the mutations: each REFUSED by the migration, or (post-conditions stripped) caught by the RETEST / probe.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { execSync } from "child_process";
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const root = fileURLToPath(new URL("../../", import.meta.url));
const MIG_PATH = join(root, "sql/equipment_manager_scope_DRAFT.sql");
let mig = readFileSync(MIG_PATH, "utf8");
const ret = readFileSync(join(root, "sql/equipment_manager_scope_RETEST.sql"), "utf8");
const EQ = JSON.parse(readFileSync(join(root, "docs/review/equipment_manager_scope_STEP0_OUTPUT.json"), "utf8"));
// the shared gates (my_department_id / my_member_id / is_dept_admin) — byte-identical live bodies, from the Training Officers
// Step 0 output on its reviewed branch (origin/feat/training-officers-step0)
const TO = JSON.parse(execSync("git show origin/feat/training-officers-step0:docs/review/training_officers_STEP0_OUTPUT.json", { cwd: root, maxBuffer: 1 << 24 }).toString());
const gate = (k) => TO.gates[k].def + ";";
const fn = (k) => EQ.functions[k].def + ";";
const pol = (p) => `CREATE POLICY "${p.name}" ON public.${p.table} FOR ${p.cmd} TO ${p.roles.replace(/[{}]/g, "")}${p.qual ? ` USING (${p.qual})` : ""}${p.with_check ? ` WITH CHECK (${p.with_check})` : ""};`;
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
CREATE TABLE equipment_manager (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  assigned_by uuid, assigned_by_name text, assigned_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz, removed_by uuid, removed_by_name text);
CREATE TABLE equipment (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, name text, status text DEFAULT 'in_inventory');
CREATE TABLE equipment_type (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, name text);
CREATE TABLE equipment_photos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid);
CREATE TABLE equipment_custody (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, equipment_id uuid, member_id uuid, closed_at timestamptz);
CREATE TABLE equipment_handoff (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, from_member_id uuid, to_member_id uuid);
CREATE TABLE equipment_handoff_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), handoff_id uuid);
CREATE TABLE equipment_issue_batch (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid);
CREATE TABLE equipment_issues (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, resolved_at timestamptz);
${gate("my_department_id()")}
${gate("my_member_id()")}
${gate("is_dept_admin()")}
${EQ.is_equipment_manager.def};
${["equipment_manager_cap()", "assign_equipment_manager(uuid)", "remove_equipment_manager(uuid)", "mark_equipment_lost(uuid)", "recover_equipment(uuid,text,text)",
   "resolve_equipment_issue(uuid,text)", "confirm_equipment_return(uuid,text,text)", "issue_equipment_batch(uuid,uuid[],text,text,uuid,text)"].map(fn).join("\n")}
CREATE TRIGGER equipment_manager_cap_trg BEFORE INSERT ON equipment_manager FOR EACH ROW EXECUTE FUNCTION equipment_manager_cap();
REVOKE EXECUTE ON FUNCTION public.is_equipment_manager(), public.my_department_id(), public.my_member_id(), public.is_dept_admin() FROM PUBLIC, anon;
${["equipment", "equipment_type", "equipment_photos", "equipment_custody", "equipment_handoff", "equipment_handoff_items", "equipment_issue_batch", "equipment_issues", "equipment_manager"].map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join(" ")}
${EQ.policies.map(pol).join("\n")}
CREATE POLICY "members read equipment" ON public.equipment FOR SELECT TO public USING ((department_id = my_department_id()));
CREATE POLICY "members read assignments" ON public.equipment_manager FOR SELECT TO authenticated USING ((department_id = my_department_id()));
CREATE FUNCTION public.lockedtok() RETURNS text LANGUAGE sql AS $$ select 'is verified' $$;
INSERT INTO departments VALUES ('${A}','Indian Harbor Volunteer Fire Department'),('${B}','North Hood County Volunteer Fire Department'),('${G}','Granbury Fire Station');
INSERT INTO members (department_id,email,name,access) VALUES
  ('${A}','ada@a','Ada DA','{Department Admin}'),('${A}','mgr@a','Max Manager','{Member}'),('${A}','mo@a','Mo Member','{Member}'),
  ('${B}','bob@b','Bob DA','{Department Admin}'),('${B}','bim@b','Bim Manager','{Member}'),('${B}','cal@b','Cal Member','{Member}'),
  ('${G}','gil@c','Gil DA','{Department Admin}'),
  ('${A}','dual@x','Dual (manager in A)','{Member}'),('${B}','dual@x','Dual (member in B)','{Member}');
INSERT INTO equipment_manager (department_id, member_id) SELECT department_id, id FROM members WHERE email IN ('mgr@a','bim@b') OR (email = 'dual@x' AND department_id = '${A}');
INSERT INTO equipment (department_id, name) VALUES ('${A}','Helmet A1'),('${A}','Helmet A2'),('${B}','Helmet B1'),('${B}','Helmet B2'),('${B}','Helmet B3');
INSERT INTO equipment_custody (department_id, equipment_id) SELECT department_id, id FROM equipment;
`;
async function base(extra = "") { const d = new PGlite(); await d.exec(mock); if (extra) await d.exec(extra); return d; }
const md = async (d, f) => (await d.query(`select md5(pg_get_functiondef('public.${f}'::regprocedure)) m`)).rows[0].m;
const REFUSED = "Only an equipment manager or department admin can mark an item lost";
// acting as dual@x in a department: the role, a write of that department's equipment, a read of its custody, the RPC role check
async function actAs(d, dept) {
  await d.exec(`INSERT INTO member_active_department (email, department_id) VALUES ('dual@x', '${dept}') ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
    SELECT set_config('request.jwt.claims', '{"email":"dual@x"}', false); SET role authenticated;`);
  const mgr = (await d.query("select public.is_equipment_manager() m")).rows[0].m;
  const wrote = (await d.query(`update equipment set name = name where department_id = '${dept}' returning id`)).rows.length;
  const read = (await d.query(`select count(*)::int n from equipment_custody where department_id = '${dept}'`)).rows[0].n;
  let rpc = "passed the role check"; try { await d.query("select public.mark_equipment_lost(gen_random_uuid())"); } catch (e) { rpc = e.message === REFUSED ? "refused on authority" : "passed the role check"; }
  await d.exec("RESET role;");
  return { mgr, wrote, read, rpc };
}
async function probe(d) {
  const inB = await actAs(d, B), inA = await actAs(d, A);
  const ok = !inB.mgr && inB.wrote === 0 && inB.read === 0 && inB.rpc === "refused on authority" && inA.mgr && inA.wrote === 2 && inA.read === 2 && inA.rpc === "passed the role check";
  return { ok, text: `dual@x acting in B: manager ${inB.mgr} · wrote ${inB.wrote} of B's 3 · read ${inB.read} of B's 3 custody · RPC ${inB.rpc}  |  acting in A: manager ${inA.mgr} · wrote ${inA.wrote}/2 · read ${inA.read}/2 · RPC ${inA.rpc}` };
}
const NOPIN = (s) => s.replace("  IF md5(pg_get_functiondef('public.is_equipment_manager()'::regprocedure)) <> NEW_MD5 THEN\n    RAISE EXCEPTION 'Post-condition failed: is_equipment_manager() does not match its reviewed md5.';\n  END IF;\n", "");

{ const d = await base(); console.log(`is_equipment_manager(): live ${EQ.is_equipment_manager.md5} · here ${await md(d, "is_equipment_manager()")}`);
  for (const k of ["my_member_id()", "my_department_id()"]) console.log(`${k}: live ${TO.gates[k].md5} · here ${await md(d, k)}`);
  for (const k of ["mark_equipment_lost(uuid)", "issue_equipment_batch(uuid,uuid[],text,text,uuid,text)"]) console.log(`${k}: live ${EQ.functions[k].md5} · here ${await md(d, k)}`); }

if (process.argv[2] === "pin") {
  const d = await base(); await d.exec(NOPIN(mig).replace("@@MD5_EQM@@", "x"));
  const m = await md(d, "is_equipment_manager()"); console.log("pin EQM", m); writeFileSync(MIG_PATH, mig.replace("@@MD5_EQM@@", m)); console.log("pinned"); process.exit(0);
}
if (mig.includes("@@MD5_")) throw new Error("unpinned — run with `pin` first");
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).map((l) => l.trim().slice(0, 150)).join(" | ");
const sub = (a, b, s = mig) => { if (!s.includes(a)) throw new Error("anchor missing: " + a.slice(0, 80)); return s.replace(a, () => b); };
const NOPOST = (s) => s.replace(/  -- -{10,} post-conditions[\s\S]*?\nEND\n\$migrate\$;/, "END\n$migrate$;");
const PC = "  -- ---------------------------------------------------------------- post-conditions";

{ const d = await base(); const p = await probe(d);
  console.log(`\nPROBE BEFORE THE FIX (must LEAK — that is the bug): ${p.ok ? "no leak?!" : "LEAKS"} — ${p.text}`);
  try { await d.exec(ret); } catch (e) { console.log("RETEST BEFORE THE FIX (S0 must fail):\n  " + brief(e)); } }
{ const d = await base();
  const res = await d.exec(mig);
  console.log("\nAPPLY — state:", JSON.stringify(res.at(-1).rows));
  try { await d.exec(mig); console.log("re-run: applied twice?!"); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
  console.log("grants after:", (await d.query("select proacl::text a from pg_proc where proname = 'is_equipment_manager'")).rows[0].a);
  try { await d.exec(ret); } catch (e) { console.log("\nRETEST AFTER THE FIX:\n" + show(e)); }
  console.log(`rolled back: members ${(await d.query("select count(*)::int n from members")).rows[0].n} (9), equipment_manager ${(await d.query("select count(*)::int n from equipment_manager")).rows[0].n} (3)`);
  const p = await probe(d); console.log(`\nPROBE AFTER THE FIX: ${p.ok ? "PASS" : "FAIL"} — ${p.text}`); }

console.log("\nmutations (each must be REFUSED by the migration, or caught by the RETEST / the probe):");
const BODY = "       where em.member_id = public.my_member_id()\n         and em.department_id = public.my_department_id()\n         and em.removed_at is null";
const UNSCOPED = "      join public.members m on m.id = em.member_id\n       where lower(m.email) = lower(auth.email())\n         and m.status in ('Active','Probationary')\n         and em.removed_at is null";
const DEPT_ONLY = "      join public.members m on m.id = em.member_id\n       where lower(m.email) = lower(auth.email())\n         and em.department_id = public.my_department_id()\n         and em.removed_at is null";
const MEMBER_ONLY = "       where em.member_id = public.my_member_id()\n         and em.removed_at is null";
const HEAD = "   RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'\n  AS $fn$\n  -- B4C:equipment managers";
for (const [l, m, extra, safe] of [
  ["(a) the body left matching by email in any department (the bug, re-created)", sub(BODY, UNSCOPED)],
  ["(a2) same, post-conditions removed — the RETEST + probe must catch it", NOPOST(sub(BODY, UNSCOPED))],
  ["(b) member-only scope (no department clause)", sub(BODY, MEMBER_ONLY)],
  ["(b2) same, post-conditions removed (department-safe in practice — member rows are per-department; refused by (b) anyway)", NOPOST(sub(BODY, MEMBER_ONLY)), "", true],
  ["(c) department-only scope, still matching by email", sub(BODY, DEPT_ONLY)],
  ["(c2) same, post-conditions removed (also safe in practice; refused by (c) anyway)", NOPOST(sub(BODY, DEPT_ONLY)), "", true],
  ["(d) made VOLATILE", sub(HEAD, HEAD.replace(" STABLE ", " VOLATILE "))],
  ["(e) SECURITY INVOKER", sub(HEAD, HEAD.replace(" SECURITY DEFINER ", " SECURITY INVOKER "))],
  ["(f) anon granted", sub(PC, "  GRANT EXECUTE ON FUNCTION public.is_equipment_manager() TO anon;\n" + PC)],
  ["(g) a collateral function change (mark_equipment_lost)", sub(PC, "  EXECUTE replace(pg_get_functiondef('public.mark_equipment_lost(uuid)'::regprocedure), 'mark an item lost', 'mark an item lost.');\n" + PC)],
  ["(h) a policy changed in the block", sub(PC, "  ALTER POLICY \"members read equipment\" ON public.equipment USING (true);\n" + PC)],
  ["(i) a trigger dropped in the block", sub(PC, "  DROP TRIGGER equipment_manager_cap_trg ON public.equipment_manager;\n" + PC)],
  ["(j) live drift: is_equipment_manager() changed before apply", mig, EQ.is_equipment_manager.def.replace("and em.removed_at is null", "and em.removed_at is null and true") + ";"],
  ["(k) live drift: my_member_id() changed before apply", mig, TO.gates["my_member_id()"].def.replace("limit 1", "limit 2") + ";"],
  ["(l) already applied (the scoped body is already there)", mig, "SELECT 1;"],
]) {
  const db = await base(l.startsWith("(l)") ? "" : extra);
  if (l.startsWith("(l)")) await db.exec(mig);
  try {
    await db.exec(m);
    let line = "migration applied ->";
    try { await db.exec(ret); line += " RETEST raised nothing?!"; } catch (e) { line += " RETEST: " + brief(e); }
    const p = await probe(db); line += `\n     PROBE: ${p.ok ? "PASS" : "FAIL"} — ${p.text}`;
    const caught = / [1-9]\d* failed/.test(line) || /PROBE: FAIL/.test(line);
    console.log(`  ${l}\n     ${line}${caught ? "" : safe ? "   (not caught downstream — department-safe by the per-department member rows; the clean migration refuses this body)" : "   <-- NOT CAUGHT"}`);
  } catch (e) { console.log(`  ${l}\n     REFUSED: ${e.message.split("\n")[0]}`); }
}
