// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/b1_plan_collapse_test.mjs
// No network, no DB. Bug B1 — "an approved training plan is stuck expanded". Renders the REAL TrainingPlans (src/App.jsx)
// against an in-memory fake of the drill-plan RPCs and checks:
//   1. the repro: approve the draft awaiting review, then open it — it shows as "Approved plan"; clicking its card again COLLAPSES it (was: stayed
//      open forever — select() only ever set the selection, and "nothing selected" fell through to the first draft)
//   2. the panel's Collapse button collapses it too; collapsing does NOT surface another draft in its place
//   3. it reopens on a click; another card switches to that plan; a plain member (no write rights) can collapse too
//   4. while editing, neither the card nor a Collapse button drops the edit
//   5. approve behaviour unchanged: approve_drill_plan(id) called once, nothing else written; first-open still surfaces the
//      draft awaiting review (the fallback is kept for "nothing chosen yet"), and approving it moves on to the next draft
//      as before. (A click on the card of the plan that is showing now toggles it closed — the card is aria-pressed.)
//   6. fences: only src/App.jsx (+ this test) changed; verified 132 (108 raw); Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "291013e";   // main when this was drafted (industrial-noir-45)
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/", width: 1200, height: 900 });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = {};
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "maybeSingle", "single"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (a) => { st.writes.push({ table, m, a }); return b; };
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-b1-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { TrainingPlans };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx" }));
  } }],
});
const { TrainingPlans, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---------------------------------------------------------------- the fake plan library
const content = { summary: "Advance a charged line.", objectives: ["Advance a charged 1.75 in line"], steps: [{ title: "Size-up", minutes: 10, actions: ["Walk the scene"] }], safety: ["Full PPE and SCBA"] };
const plan = (id, title, status) => ({ id, title, category: "Fire", duration_min: 120, audience: "All", content, status, source: "ai", created_by: "m-ada", created_at: "2026-10-20T12:00:00Z",
  approved_by: status === "approved" ? "m-ada" : null, approved_at: status === "approved" ? "2026-10-21T12:00:00Z" : null, attached_sessions: 0 });
let DB = [];
globalThis.__sb = {
  calls: [], writes: [],
  answer: (n, a) => {
    if (n === "dept_drill_plans") return { data: DB.map((p) => ({ ...p })), error: null };
    if (n === "approve_drill_plan") { const r = DB.find((p) => p.id === a.p_id); Object.assign(r, { status: "approved", approved_by: "m-ada", approved_at: new Date().toISOString() }); return { data: r, error: null }; }
    return { data: null, error: null };
  },
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const S = new Proxy({}, { get: () => ({}) });
let host, rootR;
async function mount(role, manage) {
  globalThis.__sb.calls = []; globalThis.__sb.writes = [];
  if (rootR) await act(async () => rootR.unmount());
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rootR = createRoot(host);
  await act(async () => { rootR.render(React.createElement(TrainingPlans, { S, role, canManageTraining: manage, sessions: [], loadSessions: () => {}, members: [{ id: "m-ada", name: "Ada DA" }],
    notify: () => {}, dept: { name: "Test FD" }, categories: [{ id: "c1", name: "Fire", color: "#B11E2A" }], viewToggle: null, loadPlans: () => {}, onScheduleWithPlan: () => {}, reloadNonce: 0 })); });
  await tick(); await tick();
}
const card = (title) => [...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent).startsWith(title));
const detail = () => { const t = norm(host.textContent); return t.includes("Approved plan") ? "approved" : t.includes("Awaiting review") ? "draft" : null; };
const detailTitle = () => host.querySelector('[style*="font-size: 18px"]')?.textContent || null;
const collapseBtn = () => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Collapse this plan");
const button = (t) => [...host.querySelectorAll("button")].find((b) => norm(b.textContent) === t || norm(b.textContent).startsWith(t));

// ---------------------------------------------------------------- 1 the repro
DB = [plan("p1", "Hose advance", "draft"), plan("p2", "Ladder raise", "draft")];
await mount(["Department Admin"], true);
ok("first open: the draft awaiting review surfaces on its own (fallback kept)", detail() === "draft" && detailTitle() === "Hose advance", `${detail()} · ${detailTitle()}`);
// the tester's flow: approve the draft awaiting review (already showing), THEN open the approved plan to view it
const approve = button("Approve");
if (approve) { await click(approve); await tick(); await tick(); }
ok("approve: approve_drill_plan(p1) once; no table writes", globalThis.__sb.calls.filter((c) => c.n === "approve_drill_plan").length === 1 && globalThis.__sb.calls.find((c) => c.n === "approve_drill_plan").args.p_id === "p1" && globalThis.__sb.writes.length === 0);
ok("…unchanged behaviour: the panel moves on to the next draft awaiting review", detail() === "draft" && detailTitle() === "Ladder raise", `${detail()} · ${detailTitle()}`);
await click(card("Hose advance")); await tick();
ok("open the approved plan: it reads 'Approved plan'", detail() === "approved" && detailTitle() === "Hose advance", `${detail()} · ${detailTitle()}`);
ok("its card is pressed", card("Hose advance")?.getAttribute("aria-pressed") === "true");
await click(card("Hose advance")); await tick();
ok("B1 FIX: clicking the open approved plan's card again COLLAPSES it — no detail at all (not even the other draft)", detail() === null && card("Hose advance")?.getAttribute("aria-pressed") === "false", `${detail()} · ${detailTitle()}`);

// ---------------------------------------------------------------- 2 the Collapse button
await click(card("Hose advance")); await tick();
ok("…reopens on a click", detail() === "approved" && detailTitle() === "Hose advance");
ok("the detail has a visible Collapse control", !!collapseBtn() && norm(collapseBtn().textContent) === "Collapse");
await click(collapseBtn()); await tick();
ok("Collapse collapses the approved plan; the remaining draft does NOT pop up in its place", detail() === null, `${detail()} · ${detailTitle()}`);

// ---------------------------------------------------------------- 3 switching + a plain member
await click(card("Ladder raise")); await tick();
ok("another card opens that plan (a draft here)", detail() === "draft" && detailTitle() === "Ladder raise");
await click(card("Hose advance")); await tick();
ok("…and a different card switches to it (no collapse on switch)", detail() === "approved" && detailTitle() === "Hose advance");
await mount(["Member"], false);
await click(card("Hose advance")); await tick();
const memberSees = detail() === "approved";
await click(collapseBtn()); await tick();
ok("a plain member (read-only) can open and collapse an approved plan", memberSees && detail() === null && !button("Approve") && !button("Edit"));

// ---------------------------------------------------------------- 4 editing is not dropped
await mount(["Department Admin"], true);
await click(card("Hose advance")); await tick();
const edit = button("Edit");
if (edit) { await click(edit); await tick(); }
const editing = !!button("Save changes") || !!button("Cancel");
ok("while editing there is no Collapse button", editing && !collapseBtn());
await click(card("Hose advance")); await tick();
ok("…and clicking the card does not collapse (the edit is kept)", (!!button("Save changes") || !!button("Cancel")) && detailTitle() !== null);

// ---------------------------------------------------------------- 6 fences
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const changed = execSync(`git diff --name-only ${BASE}`, { cwd: root }).toString().trim().split("\n").concat(execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n")).filter(Boolean);
const okFile = (p) => ["src/App.jsx", "docs/review/b1_plan_collapse_test.mjs"].includes(p) || /^claude\/B4C_BugB1_/.test(p);
ok(`only src/App.jsx (+ this test / notes) changed vs ${BASE} — no SQL / API / vercel.json`, changed.every(okFile), JSON.stringify(changed.filter((p) => !okFile(p))));
ok("approve path untouched: approve_drill_plan call text unchanged", src.includes('act("approve", "approve_drill_plan", { p_id: sel.id }, "Plan approved.")'));
ok("verified untouched: App.jsx 132 (108 raw)", (src.match(new RegExp("verifie" + "d", "gi")) || []).length === 132 && (src.match(new RegExp("verifie" + "d", "g")) || []).length === 108);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
await act(async () => rootR.unmount());
process.exit(process.exitCode || 0);
