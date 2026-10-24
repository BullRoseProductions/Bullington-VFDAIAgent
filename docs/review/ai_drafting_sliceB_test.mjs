// HAPPY_DOM_DIR=<dir with happy-dom> PGLITE_DIR=<dir with @electric-sql/pglite> node docs/review/ai_drafting_sliceB_test.mjs
// No network, no live DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive and apiBase swapped
// for in-memory fakes) and checks AI Drafting Slice B — the Training page's "Training Plans" view:
//   1. the builder REUSES the inline planner's generation: DRILL_PLAN_SYSTEM is byte-identical to AIDrillPlanner's system
//      prompt, and the draft request sends exactly it (no new prompt / model)
//   2. §1 content mapping: drillPlanToContent(plan) gives exactly the five drill_plans.content keys, run_of_show
//      { t: title + " — N min", d: actions joined "; " (or the old prose detail) }; evaluationChecklist etc. not carried
//   3. THE ROUND TRIP: the UI's mapped content -> the live Slice A SQL in PGlite (set_drill_plan -> attach_drill_plan_to_session)
//      -> the session_plans.ai_text it writes -> the REAL AiPlanViewer: Quick run sheet + Full plan both render the plan;
//      the headings sit in the same order the inline planner's serializeDrillPlan writes
//   4. the UI flows against an in-memory fake of the six RPCs: the toggle; members read (no write controls); DA / Officer
//      draft -> set_drill_plan(null, …, mapped content, 'ai'); approve / back to draft; edit keeps source; attach + "View as
//      attached" opens the real viewer; delete through confirmDestructive with the keep-the-copy copy; RPC errors surfaced;
//      a failed library read shows Retry, not an empty library; Board / Project Admin get no write controls
//   5. the source: only src/App.jsx; AIDrillPlanner byte-identical to origin/main; the only new RPCs are the six Slice A
//      ones; no direct drill_plans / session_plans writes added; no hex in the new block; verified count unchanged; Notify absent
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "maybeSingle", "single", "insert", "update", "delete", "upsert"]) b[m] = (...a) => { if (["insert", "update", "delete", "upsert"].includes(m)) st.writes.push({ table, m }); return b; };
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `
    export const confirmDestructive = async (o) => { globalThis.__confirmed.push(o); return globalThis.__confirmAnswer !== false; };
    export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => true;
    export const DestructiveConfirmHost = () => null;`,
  api: `
    export const isNative = () => false; export const apiUrl = (p) => p;
    export async function authedFetch(path, init) { globalThis.__ai.push({ path, body: JSON.parse(init.body) }); const t = globalThis.__aiReply();
      return { ok: true, status: 200, text: async () => JSON.stringify({ text: t }) }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-slb-")), "app.under-test.mjs");
await build({
  entryPoints: [join(root, "src/App.jsx")], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onResolve({ filter: /ConfirmDestructive(\.jsx)?$/ }, () => ({ path: "cd", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { DRILL_PLAN_SYSTEM, drillPlanToContent, serializeDrillPlan, TrainingPlans, Training, AiPlanViewer };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const A = await import(pathToFileURL(out).href);
const { DRILL_PLAN_SYSTEM, drillPlanToContent, serializeDrillPlan, TrainingPlans, Training, AiPlanViewer, createRoot, act, React } = A;

const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();

// ---- the generator-shaped plan the inline planner's prompt returns
const GEN = {
  summary: "Advance a charged line to the seat of the fire.", durationMin: 90,
  objectives: ["Advance a charged 1.75 in line", "Call for water and confirm flow"],
  equipment: ["1.75 in line", "Engine 1"], safetyNotes: ["Full PPE and SCBA", "Assigned safety officer"],
  steps: [{ title: "Size-up", minutes: 10, actions: ["Walk the scene", "Assign crews"] },
          { title: "Advance", minutes: 60, actions: ["Flake the line", "Open the bale"] },
          { title: "Debrief", detail: "Talk it through as a crew" }],
  talkingPoints: ["Why we flake"], debriefQuestions: ["What slowed us?"], evaluationChecklist: ["Line charged in 60 s"],
};

// 1 generation reuse
const plannerSys = (() => { const m = src.match(/function AIDrillPlanner[\s\S]*?\n    const sys = ("(?:[^"\\]|\\.)*");/); return m ? JSON.parse(m[1]) : null; })();
ok("DRILL_PLAN_SYSTEM is byte-identical to the inline planner's system prompt", plannerSys && DRILL_PLAN_SYSTEM === plannerSys, `${DRILL_PLAN_SYSTEM?.length} chars`);

// 2 §1 mapping
const C = drillPlanToContent(GEN);
ok("content has exactly the five documented keys", JSON.stringify(Object.keys(C)) === '["summary","objectives","run_of_show","materials","safety"]', JSON.stringify(Object.keys(C)));
ok("§1 mapping: summary / objectives / materials (equipment) / safety (safetyNotes)", C.summary === GEN.summary && JSON.stringify(C.objectives) === JSON.stringify(GEN.objectives)
  && JSON.stringify(C.materials) === JSON.stringify(GEN.equipment) && JSON.stringify(C.safety) === JSON.stringify(GEN.safetyNotes));
ok("§1 run_of_show: t = title + \" — N min\", d = actions joined \"; \", prose detail as fallback, no minutes -> no suffix",
  JSON.stringify(C.run_of_show) === JSON.stringify([{ t: "Size-up — 10 min", d: "Walk the scene; Assign crews" }, { t: "Advance — 60 min", d: "Flake the line; Open the bale" }, { t: "Debrief", d: "Talk it through as a crew" }]), JSON.stringify(C.run_of_show));
const C0 = drillPlanToContent({ summary: 5, objectives: "not an array", steps: null });
ok("a malformed generation still yields the five keys, arrays as arrays (the SQL serializer skips non-arrays)", C0.summary === "" && Array.isArray(C0.objectives) && C0.objectives.length === 0 && Array.isArray(C0.run_of_show) && Array.isArray(C0.materials) && Array.isArray(C0.safety));

// 3 THE ROUND TRIP through the live Slice A SQL
const SA = "origin/feat/ai-drafting-sliceA-db";
const mig = execSync(`git show ${SA}:sql/ai_drafting_sliceA_DRAFT.sql`, { cwd: root, maxBuffer: 1 << 24 }).toString();
const GATES = JSON.parse(execSync(`git show ${SA}:docs/review/ai_drafting_sliceA_STEP0_gates.json`, { cwd: root }).toString());
const D = "00000000-0000-0000-0000-00000000000a";
const pg = new PGlite();
await pg.exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active');
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE training_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid REFERENCES departments(id) ON DELETE CASCADE, title text, date date);
CREATE TABLE session_plans (id uuid NOT NULL DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid, title text, source text, storage_path text, ai_text text, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_plans_pkey PRIMARY KEY (id), CONSTRAINT session_plans_session_id_fkey FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE SET NULL,
  CONSTRAINT session_plans_source_check CHECK (((source IS NULL) OR (source = ANY (ARRAY['upload'::text, 'ai'::text])))));
${["my_department_id()", "my_member_id()", "is_canmanage()", "is_canmanage_ops()", "is_dept_admin()"].map((f) => GATES[f].def + ";").join("\n")}
ALTER TABLE session_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read session_plans" ON session_plans FOR SELECT TO authenticated USING ((department_id = my_department_id()));
INSERT INTO departments VALUES ('${D}', 'Indian Harbor');
INSERT INTO members (department_id, email, name, access) VALUES ('${D}', 'oli@a', 'Oli Officer', '{Officer}');
INSERT INTO training_sessions (department_id, title, date) VALUES ('${D}', 'Hose drill', '2026-11-02');`);
await pg.exec(mig);
await pg.exec(`SELECT set_config('request.jwt.claims', '{"email":"oli@a"}', false); SET role authenticated;`);
const planId = (await pg.query("select (public.set_drill_plan(null, $1, 'Fire', $2, 'Mixed crew · 8 members', $3::jsonb, 'ai')).id as id", ["Hose advance", GEN.durationMin, JSON.stringify(C)])).rows[0].id;
const sessId = (await pg.query("select id from training_sessions limit 1")).rows[0].id;
const att = (await pg.query("select (r).* from (select public.attach_drill_plan_to_session($1, $2) r) x", [planId, sessId])).rows[0];
const txt = att.ai_text;
ok("round trip: attach wrote source 'ai', the plan title, drill_plan_id and the caller's name", att.source === "ai" && att.title === "Hose advance" && att.drill_plan_id === planId && att.created_by === "Oli Officer");
const expectLines = ["## Quick Run Sheet", "Total time: 90 min", "**1. Size-up — 10 min**", "- Walk the scene; Assign crews", "**2. Advance — 60 min**", "**3. Debrief**", "- Talk it through as a crew",
  "**Safety first:**", "- Full PPE and SCBA", "## Hose advance — Drill Plan", "Advance a charged line to the seat of the fire.", "Duration: 90 minutes", "## Objectives", "- Advance a charged 1.75 in line", "## Safety notes", "## Equipment", "- 1.75 in line"];
let lastAt = -1, order = true; for (const l of expectLines) { const at = txt.indexOf(l, lastAt + 1); if (at < 0 || at < lastAt) { order = false; console.log("   missing / out of order:", l); } lastAt = Math.max(lastAt, at); }
ok("round trip: the attached ai_text carries the mapped plan, in order (run sheet, then the full plan)", txt.startsWith("## Quick Run Sheet") && order);
const heads = (t) => (t.match(/^## .*$/gm) || []).map((h) => h.replace(/— Drill Plan$/, "— Drill Plan").replace(/^## .* — Drill Plan$/, "## <title> — Drill Plan"));
const inl = heads(serializeDrillPlan(GEN, "Hose advance")), ours = heads(txt);
ok("round trip: the headings are a subsequence of the inline planner's serializeDrillPlan headings (same layout the viewer splits on)", ours.every((h, i) => inl.indexOf(h) >= 0 && (i === 0 || inl.indexOf(h) > inl.indexOf(ours[i - 1]))), `${JSON.stringify(ours)} vs ${JSON.stringify(inl)}`);
// the REAL viewer
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => s.replace(/\s+/g, " ").trim();
const S = new Proxy({}, { get: () => ({}) });
{ document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(AiPlanViewer, { S, plan: { ...att, kind: "ai" }, onClose: () => {}, dept: { name: "Indian Harbor" }, notify: () => {} })); }); await tick();
  const t1 = norm(host.textContent);
  const btns = [...host.querySelectorAll("button")];
  ok("viewer: offers the Quick run sheet / Full plan tabs (the run sheet is non-empty)", btns.some((b) => norm(b.textContent) === "Quick run sheet") && btns.some((b) => norm(b.textContent) === "Full plan"));
  ok("viewer, Quick run sheet: the steps (title — minutes, joined actions) + safety, and not the objectives",
    t1.includes("Size-up — 10 min") && t1.includes("Walk the scene; Assign crews") && t1.includes("Talk it through as a crew") && t1.includes("Full PPE and SCBA") && !t1.includes("Advance a charged 1.75 in line"), t1.slice(0, 300));
  await act(async () => { btns.find((b) => norm(b.textContent) === "Full plan").dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick();
  const t2 = norm(host.textContent);
  ok("viewer, Full plan: title heading, summary, objectives, safety notes, equipment", t2.includes("Hose advance — Drill Plan") && t2.includes("Advance a charged line to the seat of the fire.")
    && t2.includes("Advance a charged 1.75 in line") && t2.includes("Assigned safety officer") && t2.includes("Engine 1"), t2.slice(0, 300));
  await act(() => r.unmount()); }

// 4 UI flows — an in-memory fake of the six RPCs
const ME = { ada: "m-ada", oli: "m-oli" };
let DB = [];
let fail = {};
const nowIso = () => new Date().toISOString();
globalThis.__sb = {
  calls: [], writes: [],
  answer: (n, a) => {
    if (fail[n]) return { data: null, error: { message: fail[n] } };
    if (n === "dept_drill_plans") return { data: DB.map((p) => ({ ...p })), error: null };
    if (n === "set_drill_plan") {
      if (!a.p_id) { const row = { id: `p${DB.length + 1}`, title: a.p_title, category: a.p_category, duration_min: a.p_duration_min, audience: a.p_audience, content: a.p_content, status: "draft", source: a.p_source, created_by: ME.ada, created_at: nowIso(), approved_by: null, approved_at: null, updated_by: ME.ada, updated_at: nowIso(), attached_sessions: 0 }; DB.push(row); return { data: row, error: null }; }
      const row = DB.find((p) => p.id === a.p_id); Object.assign(row, { title: a.p_title, category: a.p_category, duration_min: a.p_duration_min, audience: a.p_audience, content: a.p_content }); return { data: row, error: null };
    }
    if (n === "approve_drill_plan") { const row = DB.find((p) => p.id === a.p_id); Object.assign(row, { status: "approved", approved_by: ME.ada, approved_at: nowIso() }); return { data: row, error: null }; }
    if (n === "unapprove_drill_plan") { const row = DB.find((p) => p.id === a.p_id); Object.assign(row, { status: "draft", approved_by: null, approved_at: null }); return { data: row, error: null }; }
    if (n === "delete_drill_plan") { DB = DB.filter((p) => p.id !== a.p_id); return { data: null, error: null }; }
    if (n === "attach_drill_plan_to_session") { const row = DB.find((p) => p.id === a.p_plan_id); row.attached_sessions += 1; return { data: { id: "sp1", session_id: a.p_session_id, title: row.title, source: "ai", ai_text: txt, drill_plan_id: row.id }, error: null }; }
    return { data: null, error: null };
  },
};
globalThis.__confirmed = []; globalThis.__ai = []; globalThis.__aiReply = () => JSON.stringify(GEN);
const notes = []; const notify = (x) => notes.push(x);
const SESS = [{ id: "s1", title: "Hose drill", y: 2026, m: 10, d: 2, done: false }, { id: "s0", title: "Old drill", y: 2026, m: 0, d: 5, done: true }];
const CATS = [{ id: "c1", name: "Fire", color: "CAT_COLOR_TOKEN" }, { id: "c2", name: "EMS", color: "CAT2" }];
const MEMBERS = [{ id: ME.ada, name: "Ada DA" }, { id: ME.oli, name: "Oli Officer" }];
async function mount(role, el) {
  globalThis.__sb.calls = []; globalThis.__sb.writes = []; globalThis.__confirmed = []; globalThis.__ai = []; notes.length = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(el || React.createElement(TrainingPlans, { S, role, sessions: SESS, loadSessions: () => {}, members: MEMBERS, notify, dept: { name: "Indian Harbor" }, categories: CATS, viewToggle: null })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const btn = (host, t) => { const all = [...host.querySelectorAll("button")]; return all.find((b) => norm(b.textContent) === t) || all.find((b) => norm(b.textContent).startsWith(t)); };
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = async (n, v) => act(async () => {
  const proto = n.tagName === "SELECT" ? win.HTMLSelectElement.prototype : n.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(n, v); n.dispatchEvent(new win.Event(n.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
});
const rpcs = () => globalThis.__sb.calls.filter((c) => c.n !== "dept_drill_plans");

// the toggle (the real Training wrapper; the Schedule view stays mounted underneath)
{ const { host, unmount } = await mount(null, React.createElement(Training, { S, role: ["Member"], plan: CATS, setPlan: () => {}, loadPlans: () => {}, sessions: SESS, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false, members: MEMBERS, meId: ME.ada, notify, dept: { name: "Indian Harbor" }, addFeedback: () => {} }));
  const tog = () => [...host.querySelectorAll("button[aria-pressed]")].filter((b) => ["Schedule", "Training Plans"].includes(norm(b.textContent)));
  ok("Training page: a Schedule | Training Plans toggle, Schedule on by default; the library isn't fetched until Plans opens",
    tog().length === 2 && tog()[0].getAttribute("aria-pressed") === "true" && !globalThis.__sb.calls.some((c) => c.n === "dept_drill_plans"));
  await click(tog()[1]); await tick();
  ok("…Training Plans opens the Plans view (dept_drill_plans read) and keeps the toggle", norm(host.textContent).includes("Your plan library") && globalThis.__sb.calls.some((c) => c.n === "dept_drill_plans") && tog().length >= 2);
  unmount(); }

// a member reads, no write controls
DB = [{ id: "p0", title: "RIT / Mayday", category: "Fire", duration_min: 120, audience: "Mixed crew", content: drillPlanToContent(GEN), status: "approved", source: "ai", created_by: ME.oli, created_at: nowIso(), approved_by: ME.oli, approved_at: nowIso(), updated_by: ME.oli, updated_at: nowIso(), attached_sessions: 3 }];
{ const { host, unmount } = await mount(["Member"]);
  const t = norm(host.textContent);
  ok("member: reads the library card (status, meta, author, attached count) — no builder, no write actions",
    t.includes("RIT / Mayday") && t.includes("Approved") && t.includes("Fire · 2 objectives · 2 hrs") && t.includes("Approved by Oli Officer") && t.includes("Attached to 3 sessions")
    && !t.includes("Draft a training plan with AI") && !btn(host, "Edit") && !btn(host, "Attach to session") && !btn(host, "Delete") && !btn(host, "Back to draft"));
  ok("member: nothing auto-featured when no plan awaits review", !t.includes("Approved plan") && !t.includes("Awaiting review"));
  await click([...host.querySelectorAll("button")].find((b) => norm(b.textContent).startsWith("RIT / Mayday"))); await tick();
  const tc = norm(host.textContent);
  ok("member: opening a card shows the plan (objectives / run of show / materials / safety), still read-only", tc.includes("Approved plan") && tc.includes("Run of show") && tc.includes("Size-up — 10 min") && tc.includes("Walk the scene; Assign crews") && tc.includes("Engine 1") && tc.includes("Assigned safety officer") && !btn(host, "Edit") && !btn(host, "Delete"));
  unmount(); }
for (const [who, role] of [["Board Member", ["Board Member"]], ["Project Admin", ["Project Admin"]]]) {
  const { host, unmount } = await mount(role);
  ok(`${who}: no builder and no write actions (CANMANAGE_OPS_ROLES, not is_dept_admin)`, !norm(host.textContent).includes("Draft a training plan with AI") && !btn(host, "Edit") && !btn(host, "Delete"));
  unmount();
}
// DA drafts -> approves -> edits -> attaches -> views -> unapproves -> deletes
DB = [];
{ const { host, unmount } = await mount(["Department Admin"]);
  ok("DA: the builder (form + seeds + approve note); empty library says so", norm(host.textContent).includes("Draft a training plan with AI") && norm(host.textContent).includes("Tanker shuttle / rural water") && norm(host.textContent).includes("AI drafts the plan — a qualified officer reviews and approves it before it's used. Always verify against your SOGs.") && norm(host.textContent).includes("No plans in the library yet."));
  await click(btn(host, "Draft plan")); await tick();
  ok("draft without a topic is refused locally (no AI call, no RPC)", norm(host.textContent).includes("Give it a topic or drill to plan.") && globalThis.__ai.length === 0 && rpcs().length === 0);
  await click(btn(host, "Hose deployment & streams"));
  const sels = host.querySelectorAll("select");
  await setVal(sels[1], "90"); await setVal(sels[2], "Fire");
  await setVal(host.querySelector('input[placeholder="8"]'), "8");
  await click(btn(host, "Draft plan")); await tick(); await tick();
  const ai = globalThis.__ai[0];
  ok("draft -> /api/claude with DRILL_PLAN_SYSTEM verbatim; the user message carries the form", ai && ai.path === "/api/claude" && ai.body.system === DRILL_PLAN_SYSTEM && ai.body.user.includes("Topic: Hose deployment & streams") && ai.body.user.includes("Time: 90 minutes") && ai.body.user.includes("Category: Fire") && ai.body.user.includes("Members expected: 8"));
  const set = globalThis.__sb.calls.find((c) => c.n === "set_drill_plan");
  ok("…then set_drill_plan(null, topic, category, durationMin, audience, drillPlanToContent(plan), 'ai')", set && set.args.p_id === null && set.args.p_title === "Hose deployment & streams" && set.args.p_category === "Fire" && set.args.p_duration_min === 90
    && set.args.p_audience === "Mixed crew · 8 members" && set.args.p_source === "ai" && JSON.stringify(set.args.p_content) === JSON.stringify(drillPlanToContent(GEN)), JSON.stringify(set?.args).slice(0, 200));
  let t = norm(host.textContent);
  ok("…the draft lands in the library and is featured as Awaiting review (Draft · AI)", t.includes("Awaiting review") && t.includes("Draft · needs review") && t.includes("Draft · AI") && t.includes("AI-drafted · needs an officer's approval") && notes.some((x) => x.kind === "success"));
  await click(btn(host, "Approve plan")); await tick();
  ok("Approve -> approve_drill_plan(id); shows Approved + approver", rpcs().some((c) => c.n === "approve_drill_plan" && c.args.p_id === "p1") && norm(host.textContent).includes("Approved by Ada DA"));
  await click(btn(host, "Edit")); await tick();
  await setVal([...host.querySelectorAll("input")].find((i) => i.value === "Hose deployment & streams"), "Hose deployment v2");
  await click(btn(host, "Save changes")); await tick();
  const ed = rpcs().filter((c) => c.n === "set_drill_plan").at(-1);
  ok("Edit -> set_drill_plan(id, …) keeping source and the content's keys; status stays approved", ed.args.p_id === "p1" && ed.args.p_title === "Hose deployment v2" && ed.args.p_source === "ai"
    && JSON.stringify(Object.keys(ed.args.p_content)) === '["summary","objectives","run_of_show","materials","safety"]' && JSON.stringify(ed.args.p_content.run_of_show) === JSON.stringify(drillPlanToContent(GEN).run_of_show) && DB[0].status === "approved");
  await click(btn(host, "Attach to session")); await tick();
  const sessSel = [...host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "s1"));
  ok("Attach: the picker lists upcoming sessions only (not done ones)", sessSel && ![...sessSel.options].some((o) => o.value === "s0"));
  await setVal(sessSel, "s1"); await click(btn(host, "Attach")); await tick();
  ok("Attach -> attach_drill_plan_to_session(plan, session); the card says Attached to 1 session", rpcs().some((c) => c.n === "attach_drill_plan_to_session" && c.args.p_plan_id === "p1" && c.args.p_session_id === "s1") && norm(host.textContent).includes("Attached to 1 session"));
  await click(btn(host, "View as attached")); await tick();
  ok("View as attached -> the REAL plan viewer with the attached text", norm(host.textContent).includes("Quick run sheet") && norm(host.textContent).includes("Walk the scene; Assign crews"));
  fail.attach_drill_plan_to_session = "That plan is already attached to this session.";
  await click(btn(host, "Attach to session")); await tick();
  await setVal([...host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "s1")), "s1"); await click(btn(host, "Attach")); await tick();
  ok("an RPC refusal is surfaced (already attached)", notes.some((x) => x.kind === "error" && x.text === "That plan is already attached to this session."));
  delete fail.attach_drill_plan_to_session;
  await click(btn(host, "Back to draft")); await tick();
  ok("Back to draft -> unapprove_drill_plan(id)", rpcs().some((c) => c.n === "unapprove_drill_plan" && c.args.p_id === "p1") && norm(host.textContent).includes("Awaiting review"));
  await click(btn(host, "Delete")); await tick();
  const cf = globalThis.__confirmed.at(-1);
  ok("Delete -> confirmDestructive (says attached sessions keep their copy) -> delete_drill_plan(id)", cf && cf.noun === "drill plan" && /keep their copy/.test(cf.impact) && rpcs().some((c) => c.n === "delete_drill_plan" && c.args.p_id === "p1") && DB.length === 0);
  ok("no direct table writes anywhere in the flow", globalThis.__sb.writes.length === 0, JSON.stringify(globalThis.__sb.writes));
  unmount(); }
// an Officer writes too; a failed read keeps a Retry, not an empty library
DB = [{ ...DB[0], id: "p9", title: "X", category: null, content: { summary: "" }, status: "draft", source: "manual", created_by: ME.oli, created_at: nowIso(), attached_sessions: 0, approved_by: null, approved_at: null, duration_min: null, audience: null }].filter((x) => x.title);
{ const { host, unmount } = await mount(["Officer"]);
  ok("Officer (not DA): builder + Approve / Edit / Delete shown", norm(host.textContent).includes("Draft a training plan with AI") && !!btn(host, "Approve plan") && !!btn(host, "Edit") && !!btn(host, "Delete"));
  ok("a content with only some keys still renders (\"None listed.\")", norm(host.textContent).includes("None listed.") && norm(host.textContent).includes("No steps listed."));
  unmount(); }
fail.dept_drill_plans = "Load failed";
{ const { host, unmount } = await mount(["Member"]);
  ok("a failed library read shows the error + Retry (not \"No plans\")", norm(host.textContent).includes("Load failed") && !!btn(host, "Retry") && !norm(host.textContent).includes("No plans in the library yet."));
  delete fail.dept_drill_plans;
  await click(btn(host, "Retry")); await tick();
  ok("…Retry loads it", norm(host.textContent).includes("Your plan library") && !norm(host.textContent).includes("Load failed"));
  unmount(); }

// 5 the source
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime)", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const fn = (s, name) => { const i = s.indexOf(`function ${name}(`); return s.slice(i, s.indexOf("\nfunction ", i + 10)); };
ok("AIDrillPlanner (the inline Draft with AI planner) byte-identical to origin/main", fn(src, "AIDrillPlanner") === fn(main, "AIDrillPlanner") && fn(src, "AIDrillPlanner").length > 1000);
ok("serializeDrillPlan + AiPlanViewer byte-identical to origin/main", fn(src, "serializeDrillPlan") === fn(main, "serializeDrillPlan") && fn(src, "AiPlanViewer") === fn(main, "AiPlanViewer"));
const rpcSet = (s) => new Set([...(s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)), ...[...s.matchAll(/\bact\("[a-z]+", "([a-z_]+)"/g)].map((m) => m[1])]);
const added = [...rpcSet(src)].filter((n) => !rpcSet(main).has(n)).sort();
ok("the only new RPCs are the six Slice A ones", JSON.stringify(added) === JSON.stringify(["approve_drill_plan", "attach_drill_plan_to_session", "delete_drill_plan", "dept_drill_plans", "set_drill_plan", "unapprove_drill_plan"]), JSON.stringify(added));
const block = src.slice(src.indexOf("/* ---------------- TRAINING PLANS (AI Drafting Slice B)"), src.indexOf("function TrainingSchedule("));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
ok("no direct drill_plans / session_plans writes in the new block", !/from\("(drill_plans|session_plans)"\)/.test(block));
ok("no hex literal in the new block (FIRE / FS tokens)", (strip(block).replace(DRILL_PLAN_SYSTEM, "").match(/#[0-9A-Fa-f]{3,8}\b/g) || []).length === 0);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(main), `${tok(src)} vs ${tok(main)}`);
ok("Notify crew held back: no api/notify-session.js, 0 NotifyCrewModal", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
