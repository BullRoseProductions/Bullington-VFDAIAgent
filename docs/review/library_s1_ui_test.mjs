// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/library_s1_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (fakes for supabaseClient, ConfirmDestructive, NoirDialogs,
// apiBase) and checks Training Library slice 1-UI (claude/B4C_TrainingLibrary_S1_DB_ReviewRecord.md, rulings L0/L1/L3):
//   1. libRowToPacket maps a catalog row (D1 content keys) onto the packet shape Library / Packet render
//   2. useLibraryCatalog reads library_drills with EXPLICIT columns (never *, never origin_department_id), the counts-only
//      library_drill_usage, and this department's pulled ids; a failed catalog read keeps the last-known list (err shown)
//   3. Training has three tabs (Schedule | Training Plans | Library); initialView "library" lands on the Library; cards show
//      "Held N times in M departments" and "In your plans"
//   4. Packet: "Add to my plans" only when canAdd; it calls onAdd; once added it reads "In your plans"; empty sections skipped
//   5. Training Plans labels a pulled drill "Draft · from the library"
//   6. the source: SEED + the in-memory Admin publish are gone; nav "library" renders Training on its Library tab; the pull is
//      the RPC only (no direct library_drills / drill_plans write); only src/App.jsx changed; verified unchanged; Notify held
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
const win = new Window({ url: "https://app.test/", width: 1024, height: 900 });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _w: null, _cols: null, _f: [] };
      b.select = (c) => { b._cols = c; return b; };
      for (const m of ["eq", "neq", "in", "is", "order", "limit", "gte", "lte", "maybeSingle", "single"]) b[m] = () => b;
      b.not = (...a) => { b._f.push(["not", ...a]); return b; };
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { b._w = { table, op: m, args }; st.writes.push(b._w); return b; };
      b.then = (res, rej) => { st.reads.push({ table, cols: b._cols, f: b._f }); return Promise.resolve(st.table(table)).then(res, rej); };
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-lib1-")), "app.under-test.mjs");
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
    b.onResolve({ filter: /NoirDialogs(\.jsx)?$/ }, () => ({ path: "nd", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { Training, Packet, libRowToPacket, useLibraryCatalog };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { Training, Packet, libRowToPacket, useLibraryCatalog, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- fixtures: catalog rows in the D1 content shape ----
const FIRE = { id: "L1", code: "FIRE-203", title: "Primary Search & Rescue", track: "Fire", level: "Intermediate", duration_min: 90, audience: null, origin: "seed", credit_name: null, published_at: "2026-10-27T12:00:00Z",
  content: { summary: "Crews conduct a coordinated primary search.", objectives: ["Maintains crew contact"], run_of_show: [{ t: "Briefing & accountability — 15 min", d: "Set crew assignments." }, { t: "Debrief", d: "What went well?" }],
    materials: ["Full PPE / SCBA"], safety: ["Assign a safety officer"], instructor_guide: "Run cold.", scenario: "Reported occupant.", discussion: ["Where did integrity break?"], debrief: ["Who was where?"], evaluation: ["Maintains crew contact", "Communicates air status"], revised: "May 2026" } };
const EMS = { id: "L2", code: "EMS-114", title: "Stroke Recognition (BE-FAST)", track: "EMS", level: "All levels", duration_min: 60, audience: null, origin: "seed", credit_name: null, published_at: "2026-10-27T12:00:00Z",
  content: { summary: "Members identify stroke signs.", objectives: [], run_of_show: [], materials: [], safety: [] } };
let CATALOG, CATALOG_ERR, DRILL;
globalThis.__sb = {
  table: (t) => {
    if (t === "library_drills") return CATALOG_ERR ? { data: null, error: { message: "offline" } } : { data: CATALOG, error: null };
    if (t === "drill_plans") return { data: [{ library_id: "L2" }], error: null };
    return { data: [], error: null };
  },
  answer: (n) => {
    if (n === "library_drill_usage") return { data: [{ library_id: "L1", held: 3, departments: 2 }, { library_id: "L2", held: 1, departments: 1 }], error: null };
    if (n === "dept_drill_plans") return { data: DRILL, error: null };
    if (n === "my_department_id") return { data: "d-1", error: null };
    return { data: null, error: null };
  },
};
const reset = () => { CATALOG = [FIRE, EMS]; CATALOG_ERR = false; DRILL = []; Object.assign(globalThis.__sb, { calls: [], writes: [], reads: [] }); };
reset();
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const btn = (root, re) => [...root.querySelectorAll("button")].find((b) => (re instanceof RegExp ? re.test(norm(b.textContent)) : norm(b.textContent) === re));
let host, rootR;
async function render(el) {
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rootR = createRoot(host);
  await act(async () => { rootR.render(el); }); await tick(); await tick();
}

// ---------------------------------------------------------------- 1. mapping
{ const p = libRowToPacket(FIRE);
  ok("map: objective / time / updated / code / track", p.objective === FIRE.content.summary && p.time === "90 min" && p.updated === "May 2026" && p.code === "FIRE-203" && p.track === "Fire" && p.libraryId === "L1");
  ok("map: run_of_show → steps, minutes parsed from '— N min' (none when absent)", p.steps.length === 2 && p.steps[0].t === "Briefing & accountability" && p.steps[0].m === 15 && p.steps[1].t === "Debrief" && p.steps[1].m === null);
  ok("map: materials → equipment; packet-only keys carried; evaluation kept", p.equipment[0] === "Full PPE / SCBA" && p.instructorGuide === "Run cold." && p.scenario === "Reported occupant." && p.evaluation.length === 2 && p.debrief.length === 1);
  const q = libRowToPacket({ ...EMS, track: "Nonsense", content: { summary: "x", objectives: ["Obj A"] } });
  ok("map: unknown track falls back safely; evaluation falls back to objectives", q.track === "Operations" && q.evaluation[0] === "Obj A" && q.equipment.length === 0); }

// ---------------------------------------------------------------- 2. the catalog hook
let hookOut;
function Probe() { hookOut = useLibraryCatalog(); return null; }
reset();
await render(React.createElement(Probe));
{ const r = globalThis.__sb.reads.find((x) => x.table === "library_drills");
  ok("catalog read lists explicit columns — never * and never origin_department_id", r && r.cols === "id, code, title, track, level, duration_min, audience, content, origin, credit_name, published_at" && !/\*|origin_department_id/.test(r.cols), r?.cols);
  ok("usage via the counts-only RPC; pulled ids from drill_plans.library_id", globalThis.__sb.calls.some((c) => c.n === "library_drill_usage") && globalThis.__sb.reads.some((x) => x.table === "drill_plans" && x.cols === "library_id"));
  ok("hook state: 2 packets, usage map, pulled set", hookOut.items.length === 2 && hookOut.usage.L1?.held === 3 && hookOut.usage.L1?.departments === 2 && hookOut.pulled.has("L2") && hookOut.loaded && !hookOut.err);
  CATALOG_ERR = true; await act(async () => { await hookOut.reload(); }); await tick();
  ok("a failed catalog read keeps the last-known list and flags it (never blank on error)", hookOut.items.length === 2 && hookOut.err === true); }
await act(async () => rootR.unmount());

// ---------------------------------------------------------------- 3. Training — three tabs, Library tab
function Harness({ role, isTrainingOfficer, initialView }) {
  const lib = useLibraryCatalog();
  return React.createElement(Training, { S, role, plan: [], setPlan: () => {}, loadPlans: () => {}, sessions: [], setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: [], meId: "m1", notify: () => {}, dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {},
    initialView, lib, openPacket: (id) => { globalThis.__opened = id; }, onAddLibrary: async () => true, libAddedNonce: 0 });
}
reset();
await render(React.createElement(Harness, { role: ["Member"], isTrainingOfficer: false, initialView: "library" }));
{ const segs = [...host.querySelectorAll("button[aria-pressed]")].map((b) => norm(b.textContent));
  ok("three tabs: Schedule | Training Plans | Library", JSON.stringify(segs.slice(0, 3)) === JSON.stringify(["Schedule", "Training Plans", "Library"]), JSON.stringify(segs));
  const libView = [...host.children].find((c) => c.style.display !== "none" && /Find a packet/.test(c.textContent));
  ok("initialView 'library' lands on the Library (the nav 'Training Library' route)", !!libView);
  const t = norm(libView?.textContent);
  ok("Library shows the catalog drills (from the table, not SEED)", t.includes("Primary Search & Rescue") && t.includes("Stroke Recognition (BE-FAST)"));
  ok("usage: 'Held 3 times in 2 departments' / 'Held 1 time in 1 department'", t.includes("Held 3 times in 2 departments") && t.includes("Held 1 time in 1 department"));
  ok("a drill already in this department's plans reads 'In your plans'", t.includes("In your plans"));
  await click([...libView.querySelectorAll("button")].find((b) => /Stroke Recognition/.test(b.textContent) && !/NEWEST/.test(b.textContent)));
  ok("tapping a card opens its packet (by catalog id)", globalThis.__opened === "L2"); }
await act(async () => rootR.unmount());
reset();
await render(React.createElement(Harness, { role: ["Department Admin"], isTrainingOfficer: false, initialView: undefined }));
{ const visible = () => [...host.children].filter((c) => c.style.display !== "none");
  ok("default view is still the Schedule; the Library mounts on first open", visible().length === 1 && !/Find a packet/.test(visible()[0].textContent) && !globalThis.__sb.calls.some((c) => c.n === "never"));
  await click([...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Library")); await tick();
  ok("switching to the Library tab shows it", visible().some((c) => /Find a packet/.test(c.textContent))); }
await act(async () => rootR.unmount());

// ---------------------------------------------------------------- 4. Packet — Add to my plans
const pk = libRowToPacket(FIRE);
let added = 0;
await render(React.createElement(Packet, { S, packet: pk, dept: {}, notify: () => {}, back: () => {}, usage: { held: 3, departments: 2 }, added: false, canAdd: false, onAdd: async () => { added++; } }));
ok("Packet: no Add button for a non-manager; usage shown", !host.querySelector('[data-testid="lib-add"]') && norm(host.textContent).includes("Held 3 times in 2 departments"));
await act(async () => rootR.unmount());
await render(React.createElement(Packet, { S, packet: pk, dept: {}, notify: () => {}, back: () => {}, usage: null, added: false, canAdd: true, onAdd: async () => { added++; } }));
ok("Packet: a training manager sees 'Add to my plans' + the draft note", !!host.querySelector('[data-testid="lib-add"]') && /draft — an officer approves it/.test(norm(host.textContent)));
await click(host.querySelector('[data-testid="lib-add"]')); await tick();
ok("Packet: Add calls onAdd once", added === 1);
await act(async () => rootR.unmount());
await render(React.createElement(Packet, { S, packet: pk, dept: {}, notify: () => {}, back: () => {}, usage: null, added: true, canAdd: true, onAdd: async () => { added++; } }));
ok("Packet: once pulled it reads 'In your plans' (no second Add)", !!host.querySelector('[data-testid="lib-added"]') && !host.querySelector('[data-testid="lib-add"]'));
await act(async () => rootR.unmount());
await render(React.createElement(Packet, { S, packet: libRowToPacket(EMS), dept: {}, notify: () => {}, back: () => {}, canAdd: false }));
{ const t = norm(host.textContent);
  ok("Packet: empty sections are skipped (no blank cards)", t.includes("Objective") && !t.includes("Required equipment") && !t.includes("Instructor guide") && !t.includes("Scenario / drill setup") && !t.includes("Debrief questions")); }
await act(async () => rootR.unmount());

// ---------------------------------------------------------------- 5. Training Plans label for a pulled drill
reset();
DRILL = [{ id: "p-lib", title: "Primary Search & Rescue", category: null, duration_min: 90, audience: null, content: FIRE.content, status: "draft", source: "library",
  created_by: "m1", created_at: new Date().toISOString(), approved_by: null, approved_at: null, updated_by: "m1", updated_at: new Date().toISOString(), attached_sessions: 0 }];
await render(React.createElement(Harness, { role: ["Department Admin"], isTrainingOfficer: false, initialView: undefined }));
await click([...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Training Plans")); await tick(); await tick();
ok("Training Plans labels the pulled drill 'Draft · from the library'", norm(host.textContent).includes("Draft · from the library"));
await act(async () => rootR.unmount());

// ---------------------------------------------------------------- 6. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const BASE = "origin/main";
const base = execSync(`git show ${BASE}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const changed = execSync(`git diff --name-only ${BASE} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime) vs origin/main", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
ok("the hard-coded SEED catalog and useState(SEED) are gone", !/const SEED = \[/.test(src) && !src.includes("useState(SEED)"));
ok("the in-memory Content Admin publish is gone", !src.includes("Publish to library") && !src.includes("setLibrary("));
ok("nav 'library' renders Training on its Library tab (one library)", src.includes(`(screen === "training" || screen === "library") && <Training key={screen} initialView={screen === "library" ? "library" : "schedule"}`) && !src.includes('screen === "library" && <Library'));
ok("the pull is the RPC only — no direct library_drills / drill_plans write", src.includes('supabase.rpc("pull_library_drill", { p_library_id: libraryId })') && !/from\("library_drills"\)\.(insert|update|upsert|delete)/.test(src) && !/from\("drill_plans"\)\.(insert|update|upsert|delete)/.test(src));
ok("library_drills is never read with select(\"*\")", !/from\("library_drills"\)\.select\("\*"\)/.test(src));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
