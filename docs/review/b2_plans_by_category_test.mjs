// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/b2_plans_by_category_test.mjs
// No network, no DB. Bug B2 (option a) — a category lists its plans in Training Plans. Renders the REAL TrainingPlans
// (src/App.jsx) against an in-memory fake of the drill-plan RPCs and checks:
//   1. create a plan in "Vehicle Extrication" (Start blank -> set_drill_plan with p_category) — it immediately lists under
//      "Vehicle Extrication" in the new "Plans by category" section, with its count; a plan with no category isn't grouped
//   2. clicking the category sets the library's EXISTING category filter (the select below) and clears the search, so the
//      library shows exactly that category's plans; clicking it again shows all
//   3. clicking a plan title there opens that plan (the detail panel) with the filter set to its category
//   4. distinct from the "Training categories" requirements card: that card still shows name + cadence only (no plan
//      titles), and the section says so; a read-only member sees the section too
//   5. no new read: the only RPCs are dept_drill_plans + set_drill_plan; fences: only src/App.jsx (+ this test / notes)
//      changed; verified 132 (108 raw); Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "2ea5a38";   // main when this was drafted (industrial-noir-47)
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
const out = join(mkdtempSync(join(tmpdir(), "b4c-b2-")), "app.under-test.mjs");
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
    if (n === "set_drill_plan" && !a.p_id) { const r = { ...plan(`p${DB.length + 1}`, a.p_title, "draft"), category: a.p_category, source: a.p_source }; DB.push(r); return { data: r, error: null }; }
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
    notify: () => {}, dept: { name: "Test FD" }, categories: [{ id: "c1", name: "Fire", color: "#B11E2A", cadence: "Monthly" }, { id: "c2", name: "Vehicle Extrication", color: "#0E6B62", cadence: "One-off" }], viewToggle: null, loadPlans: () => {}, onScheduleWithPlan: () => {}, reloadNonce: 0 })); });
  await tick(); await tick();
}
const card = (title) => [...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent).startsWith(title));
const detail = () => { const t = norm(host.textContent); return t.includes("Approved plan") ? "approved" : t.includes("Awaiting review") ? "draft" : null; };
const detailTitle = () => host.querySelector('[style*="font-size: 18px"]')?.textContent || null;
const collapseBtn = () => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Collapse this plan");
const button = (t) => [...host.querySelectorAll("button")].find((b) => norm(b.textContent) === t || norm(b.textContent).startsWith(t));

const setVal = async (n, v) => act(async () => { const proto = n.tagName === "SELECT" ? win.HTMLSelectElement.prototype : n.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(n, v); n.dispatchEvent(new win.Event(n.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
const section = () => { const h = [...host.querySelectorAll("div")].find((d) => norm(d.textContent).startsWith("Plans by category") && d.children.length >= 2 && d.querySelector("[data-plan-category]")); return h || null; };
const group = (c) => host.querySelector(`[data-plan-category="${c}"]`);
const groupTitles = (c) => [...(group(c)?.querySelectorAll("button") || [])].slice(1).map((b) => norm(b.firstChild?.textContent));
const libCards = () => [...host.querySelectorAll("button[aria-pressed]")].filter((b) => !b.closest("[data-plan-category]")).map((b) => norm(b.querySelector("span + span")?.textContent));
const filterSel = () => host.querySelector('select[aria-label="Filter by category"]');
const search = () => host.querySelector('input[aria-label="Search plans"]');

// ---------------------------------------------------------------- 1 create a plan in a category
DB = [plan("p1", "Hose advance", "approved"), { ...plan("p2", "Radio check", "approved"), category: null }];
await mount(["Department Admin"], true);
ok("before: the section groups the existing plans by their own category (Fire: Hose advance); an uncategorised plan is not grouped",
  !!section() && JSON.stringify(groupTitles("Fire")) === '["Hose advance"]' && !group("Vehicle Extrication") && !host.querySelector('[data-plan-category=""]'), JSON.stringify(groupTitles("Fire")));
await click(button("Start blank")); await tick();
const form = host.querySelector("#tp-start-blank");
await setVal(form.querySelector("input"), "Extrication with Holmatro reps");
const catSel = [...form.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "Vehicle Extrication"));
await setVal(catSel, "Vehicle Extrication");
await click([...form.querySelectorAll("button")].find((b) => /Save/.test(norm(b.textContent)))); await tick(); await tick();
const sent = globalThis.__sb.calls.find((c) => c.n === "set_drill_plan")?.args;
ok("create: set_drill_plan(p_id null, p_category 'Vehicle Extrication')", sent && sent.p_id === null && sent.p_category === "Vehicle Extrication", JSON.stringify(sent && { p_id: sent.p_id, p_category: sent.p_category }));
ok("B2 FIX: the new plan lists under 'Vehicle Extrication' right away (1 plan)", JSON.stringify(groupTitles("Vehicle Extrication")) === '["Extrication with Holmatro reps"]' && /1 plan\b/.test(norm(group("Vehicle Extrication")?.querySelector("button")?.textContent)), JSON.stringify(groupTitles("Vehicle Extrication")));
ok("…and Fire still lists only its own plan", JSON.stringify(groupTitles("Fire")) === '["Hose advance"]');

// ---------------------------------------------------------------- 2 the category drives the existing filter
await setVal(search(), "zzz"); await tick();
const head = group("Vehicle Extrication").querySelector("button");
await click(head); await tick();
ok("clicking the category sets the library's existing filter to it and clears the search", filterSel().value === "Vehicle Extrication" && search().value === "" && head.getAttribute("aria-pressed") === "true", `${filterSel().value} · "${search().value}"`);
ok("…the library below lists exactly that category's plans", JSON.stringify(libCards()) === '["Extrication with Holmatro reps"]', JSON.stringify(libCards()));
await click(group("Vehicle Extrication").querySelector("button")); await tick();
ok("clicking it again shows all plans", filterSel().value === "" && libCards().length === 3, JSON.stringify(libCards()));

// ---------------------------------------------------------------- 3 open a plan from its category
const fireTitle = [...group("Fire").querySelectorAll("button")][1];
await click(fireTitle); await tick();
ok("clicking a plan title opens it (detail panel) with the filter set to its category", detailTitle() === "Hose advance" && filterSel().value === "Fire", `${detailTitle()} · ${filterSel().value}`);

// ---------------------------------------------------------------- 4 distinct from the requirements card
const t = norm(host.textContent); const i = t.lastIndexOf("Training categories");   // the requirements card (the section's own label mentions it first)
const reqCard = t.slice(i, i + 400);
ok("the 'Training categories' requirements card is unchanged in kind: name + cadence, no plan titles", i > 0 && reqCard.includes("Vehicle Extrication") && reqCard.includes("One-off") && !reqCard.includes("Extrication with Holmatro reps") && !reqCard.includes("Hose advance"), reqCard.slice(0, 160));
ok("the section labels itself as the plans' own category, pointing at the recurring Training categories below", norm(section()?.textContent).includes("Each plan's own category — the recurring Training categories are below"));
await mount(["Member"], false);
ok("a read-only member sees Plans by category too", !!group("Vehicle Extrication") && JSON.stringify(groupTitles("Vehicle Extrication")) === '["Extrication with Holmatro reps"]');

// ---------------------------------------------------------------- 5 no new read + fences
ok("no new read: the screen's RPCs are dept_drill_plans (+ set_drill_plan on create) only", globalThis.__sb.calls.every((c) => ["dept_drill_plans", "set_drill_plan"].includes(c.n)), JSON.stringify([...new Set(globalThis.__sb.calls.map((c) => c.n))]));
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const changed = execSync(`git diff --name-only ${BASE}`, { cwd: root }).toString().trim().split("\n").concat(execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n")).filter(Boolean);
const okFile = (p) => ["src/App.jsx", "docs/review/b2_plans_by_category_test.mjs"].includes(p) || /^claude\/B4C_BugB2_/.test(p);
ok(`only src/App.jsx (+ this test / notes) changed vs ${BASE} — no SQL / API / vercel.json`, changed.every(okFile), JSON.stringify(changed.filter((p) => !okFile(p))));
ok("grouped from plans[].category (the cats set), no new query in the section", src.includes("{plans && cats.length > 0 && (") && src.includes("const inCat = list.filter((p) => p.category === c);"));
ok("verified untouched: App.jsx 132 (108 raw)", (src.match(new RegExp("verifie" + "d", "gi")) || []).length === 132 && (src.match(new RegExp("verifie" + "d", "g")) || []).length === 108);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
await act(async () => rootR.unmount());
process.exit(process.exitCode || 0);
