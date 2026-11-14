// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/library_s2_ui_test.mjs ; echo "exit $?"
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (fakes for supabaseClient, ConfirmDestructive, NoirDialogs,
// apiBase) and checks Library S2 UI — Weekly Training Content slice 2 (docs/design/training_content_step0.md §2/§3/§6,
// gate PASS @2a0768c, rulings @4cfe29f; DB slice live 2026-11-04 @0235cf2, record b86d5dc):
//   1. the PA curator (Content Admin): reads pa_library_queue + the published catalog; Add → pa_put_library_drill (p_id null,
//      content in the drill_plans + packet keys); a blank title / bad length never reaches the RPC; Edit only on a
//      submitted drill (p_id set); Publish / Publish again → noirConfirm then pa_publish_library_drill; a cancelled confirm
//      writes nothing; published drills have Withdraw (noirConfirm, danger) and no Edit; Preview shows the packet sections;
//      a failed queue read keeps the last-known list; a refused put keeps the form open
//   2. "From B4C" in Training Plans (R5): the newest three from the SAME catalog read, "See the whole library" flips to the
//      Library tab, "Add to my plans" (training managers only) is the existing pull path, a pulled drill reads "In your plans"
//   3. a library draft with no category shows a category picker (writers, drafts only) that saves through set_drill_plan
//      with every other field unchanged; a pull from anywhere re-reads Training Plans and opens that copy
//   4. the source: only src/App.jsx + this test + the build order (+ csp_realtime_wss_test's fence pin) changed vs BASE; curator writes are the four RPCs only (no
//      table write); PA_NAV unchanged; verified 132/32/14; Notify held; api/_cron.js + vercel.json untouched
// Every run reports its exit code: a non-zero exit fails the run, however many PASS lines it printed.
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "37e3527";                  // main when the slice was cut (CSP wss, gate PASS)
const REV = process.env.REV ?? "";       // "" = working tree; pin to the passed sha on promotion
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");
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
  nd: `export const noirConfirm = async (o) => { globalThis.__confirms.push(o); return globalThis.__confirmAnswer; }; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-lib2-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { Training, Admin, useLibraryCatalog };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";`, loader: "jsx" }));
  } }],
});
const { Training, Admin, useLibraryCatalog, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- fixtures ----
const row = (id, title, track, published_at, extra = {}) => ({ id, code: null, title, track, level: "Intermediate", duration_min: 60, audience: null, origin: "b4c", credit_name: null, published_at,
  content: { summary: `${title} summary.`, objectives: ["Obj"], run_of_show: [{ t: "Briefing — 10 min", d: "Assign crews." }], materials: ["SCBA"], safety: ["Safety officer"] }, ...extra });
const P1 = row("L1", "Mayday Operations", "Fire", "2026-11-10T12:00:00Z");
const P2 = row("L2", "Stroke Recognition", "EMS", "2026-11-05T12:00:00Z", { origin: "seed", code: "EMS-114" });
const P3 = row("L3", "Incident Command Basics", "Leadership", "2026-10-30T12:00:00Z", { origin: "seed" });
const P4 = row("L4", "Pump Ops & Drafting", "Operations", "2026-10-27T12:00:00Z", { origin: "seed" });
const Q1 = { ...row("Q1", "Tanker Shuttle", "Operations", null), state: "submitted", created_at: "2026-11-12T12:00:00Z", updated_at: "2026-11-12T12:00:00Z",
  content: { summary: "Move water.", objectives: ["Fill site set up"], run_of_show: [{ t: "Set up — 20 min", d: "Dump tanks." }], materials: ["Porta-tank"], safety: ["Spotters"], instructor_guide: "Keep it moving.", custom_key: "kept" } };
const Q2 = { ...row("Q2", "Old Ladder Drill", "Fire", "2026-10-01T12:00:00Z"), state: "withdrawn", created_at: "2026-10-01T12:00:00Z", updated_at: "2026-11-01T12:00:00Z" };
let CATALOG, QUEUE, QUEUE_ERR, PUT_ERR, DRILL, PULLED;
globalThis.__sb = {
  table: (t) => {
    if (t === "library_drills") return { data: CATALOG, error: null };
    if (t === "drill_plans") return { data: PULLED, error: null };
    return { data: [], error: null };
  },
  answer: (n) => {
    if (n === "pa_library_queue") return QUEUE_ERR ? { data: null, error: { message: "offline" } } : { data: QUEUE, error: null };
    if (n === "pa_put_library_drill") return PUT_ERR ? { data: null, error: { message: "That drill is already in the library." } } : { data: "Q-new", error: null };
    if (n === "library_drill_usage") return { data: [], error: null };
    if (n === "dept_drill_plans") return { data: DRILL, error: null };
    return { data: null, error: null };
  },
};
const reset = () => { CATALOG = [P1, P2, P3, P4]; QUEUE = [Q1, Q2]; QUEUE_ERR = false; PUT_ERR = false; DRILL = []; PULLED = [];
  Object.assign(globalThis.__sb, { calls: [], writes: [], reads: [] }); globalThis.__confirms = []; globalThis.__confirmAnswer = true; globalThis.__notes = []; };
reset();
const S = new Proxy({}, { get: () => ({}) });
const notify = (n) => globalThis.__notes.push(n);
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = async (n) => { await act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick(); await tick(); };
const btn = (scope, re) => [...scope.querySelectorAll("button")].find((b) => (re instanceof RegExp ? re.test(norm(b.textContent)) : norm(b.textContent) === re));
const setVal = (el, v) => act(async () => {
  const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new win.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
});
const fieldBy = (scope, label) => [...scope.querySelectorAll("label")].find((l) => norm(l.querySelector("span")?.textContent).startsWith(label))?.querySelector("input, textarea, select");
const calls = (n) => globalThis.__sb.calls.filter((c) => c.n === n);
let host, rootR;
async function render(el) {
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rootR = createRoot(host);
  await act(async () => { rootR.render(el); }); await tick(); await tick(); await tick();
}

// ---------------------------------------------------------------- 1. the curator
function AdminHarness() { const lib = useLibraryCatalog(); return React.createElement(Admin, { S, feedback: [], lib, notify }); }
await render(React.createElement(AdminHarness));
{ const cur = host.querySelector("[data-library-curator]");
  ok("1. Content Admin mounts the curator; the old 'arrives with the curator queue' placeholder is gone", !!cur && !/arrives with the curator queue|next library slice/.test(norm(host.textContent)));
  ok("1. reads pa_library_queue (no args) + the published catalog", calls("pa_library_queue").length === 1 && globalThis.__sb.reads.some((r) => r.table === "library_drills"));
  const st = (s) => [...cur.querySelectorAll(`[data-state="${s}"]`)].map((d) => norm(d.querySelector("[data-curator-title]")?.textContent));
  ok("1. sections: waiting = the submitted drill, published = the 4 catalog drills, withdrawn = the withdrawn one", JSON.stringify(st("submitted")) === '["Tanker Shuttle"]' && st("published").length === 4 && JSON.stringify(st("withdrawn")) === '["Old Ladder Drill"]', JSON.stringify([st("submitted"), st("published"), st("withdrawn")]));
  const pubRow = cur.querySelector('[data-state="published"]');
  ok("1. a published drill has Withdraw and no Edit / Publish", !!btn(pubRow, /Withdraw/) && !btn(pubRow, /^Edit$/) && !btn(pubRow, /^Publish/));
  ok("1. a withdrawn drill has 'Publish again' and no Edit", !!btn(cur.querySelector('[data-state="withdrawn"]'), /Publish again/) && !btn(cur.querySelector('[data-state="withdrawn"]'), /^Edit$/));
  ok("1. origin labels: B4C-written vs original packet", /Written by B4C/.test(norm(cur.textContent)) && /Original packet/.test(norm(cur.textContent)));
  // preview
  const waitRow = cur.querySelector('[data-state="submitted"]');
  await click(btn(waitRow, "Preview"));
  const pv = norm(cur.querySelector("[data-curator-preview]")?.textContent);
  ok("1. Preview shows the packet sections from libRowToPacket (steps with minutes, guide, safety)", /ObjectiveMove water\./.test(pv) && /Set up \(20 min\) — Dump tanks\./.test(pv) && /Instructor guideKeep it moving\./.test(pv) && /Safety considerationsSpotters/.test(pv) && !/Debrief questions/.test(pv), pv.slice(0, 160));
  // add: blank title never reaches the RPC
  await click(btn(cur, /Add a drill/));
  let form = cur.querySelector("[data-curator-form]");
  ok("1. Add a drill opens an empty form (track defaults to Fire)", !!form && fieldBy(form, "Title").value === "" && fieldBy(form, "Track").value === "Fire");
  await click(btn(form, /Save — don't publish yet/));
  ok("1. a blank title is refused in the form — no RPC", calls("pa_put_library_drill").length === 0 && /Give the drill a title\./.test(norm(form.textContent)));
  await setVal(fieldBy(form, "Title"), "  Primary Search  ");
  await setVal(fieldBy(form, "Length"), "0");
  await click(btn(form, /Save — don't publish yet/));
  ok("1. a length outside 1–1440 is refused in the form — no RPC", calls("pa_put_library_drill").length === 0 && /between 1 and 1440/.test(norm(form.textContent)));
  await setVal(fieldBy(form, "Length"), "90");
  await setVal(fieldBy(form, "Track"), "EMS");
  await setVal(fieldBy(form, "Objective / summary"), "Find them fast.");
  await setVal(fieldBy(form, "Objectives"), "Crew integrity\n\nRadio discipline");
  await setVal(fieldBy(form, "Run of show"), "Briefing — 15 min | Assign\nSearch | Left-hand pattern");
  await setVal(fieldBy(form, "Instructor guide"), "Run it cold first.");
  await setVal(fieldBy(form, "Debrief questions"), "Who was where?");
  const before = calls("pa_library_queue").length;
  await click(btn(form, /Save — don't publish yet/));
  const put = calls("pa_put_library_drill")[0]?.args || {};
  ok("1. Save → pa_put_library_drill: p_id null, trimmed title, track, length, level/audience null when blank", put.p_id === null && put.p_title === "Primary Search" && put.p_track === "EMS" && put.p_duration_min === 90 && put.p_level === null && put.p_audience === null, JSON.stringify({ ...put, p_content: undefined }));
  const c = put.p_content || {};
  ok("1. content: drill_plans keys + packet keys (run of show 't | d', one item per line)", c.summary === "Find them fast." && JSON.stringify(c.objectives) === '["Crew integrity","Radio discipline"]'
    && JSON.stringify(c.run_of_show) === '[{"t":"Briefing — 15 min","d":"Assign"},{"t":"Search","d":"Left-hand pattern"}]' && c.instructor_guide === "Run it cold first." && JSON.stringify(c.debrief) === '["Who was where?"]'
    && Array.isArray(c.materials) && Array.isArray(c.safety) && Array.isArray(c.discussion) && Array.isArray(c.evaluation), JSON.stringify(c));
  ok("1. after a save: the form closes, the queue + catalog re-read, a success note", !cur.querySelector("[data-curator-form]") && calls("pa_library_queue").length === before + 1 && globalThis.__notes.some((n) => n.kind === "success" && /waiting to publish/.test(n.text)));
  // edit a submitted drill: prefilled, p_id set, unknown content keys carried
  await click(btn(cur.querySelector('[data-state="submitted"]'), /^Edit$/));
  form = cur.querySelector("[data-curator-form]");
  ok("1. Edit (submitted only) prefills the form", !!form && fieldBy(form, "Title").value === "Tanker Shuttle" && fieldBy(form, "Run of show").value === "Set up — 20 min | Dump tanks." && fieldBy(form, "Track").value === "Operations");
  await click(btn(form, /Save changes/));
  const put2 = calls("pa_put_library_drill")[1]?.args || {};
  ok("1. Save changes → pa_put_library_drill with p_id = the drill; unknown content keys carried through", put2.p_id === "Q1" && put2.p_content?.custom_key === "kept" && put2.p_content?.instructor_guide === "Keep it moving.");
  // a refused put keeps the form open and says why
  await click(btn(cur.querySelector('[data-state="submitted"]'), /^Edit$/));
  PUT_ERR = true;
  await click(btn(cur.querySelector("[data-curator-form]"), /Save changes/));
  ok("1. a refused put: the form stays open and the server's message is shown", !!cur.querySelector("[data-curator-form]") && globalThis.__notes.some((n) => n.kind === "error" && /already in the library/.test(n.text)));
  PUT_ERR = false;
  await click(btn(cur.querySelector("[data-curator-form]"), "Cancel"));
  // publish: cancelled confirm writes nothing; confirmed → the RPC
  globalThis.__confirmAnswer = false;
  await click(btn(cur.querySelector('[data-state="submitted"]'), /^Publish$/));
  ok("1. Publish asks first (every department) — cancelling writes nothing", globalThis.__confirms.length === 1 && /every department/.test(globalThis.__confirms[0].title) && /can't be edited/.test(globalThis.__confirms[0].body) && calls("pa_publish_library_drill").length === 0);
  globalThis.__confirmAnswer = true;
  await click(btn(cur.querySelector('[data-state="submitted"]'), /^Publish$/));
  ok("1. confirmed → pa_publish_library_drill { p_id }", JSON.stringify(calls("pa_publish_library_drill")[0]?.args) === '{"p_id":"Q1"}');
  await click(btn(cur.querySelector('[data-state="withdrawn"]'), /Publish again/));
  ok("1. Publish again (withdrawn) → pa_publish_library_drill for that drill (S2-1)", JSON.stringify(calls("pa_publish_library_drill")[1]?.args) === '{"p_id":"Q2"}');
  await click(btn(cur.querySelector('[data-state="published"]'), /Withdraw/));
  const wc = globalThis.__confirms[globalThis.__confirms.length - 1];
  ok("1. Withdraw asks first (danger; copies kept) → pa_withdraw_library_drill { p_id: the catalog id }", wc.danger === true && /keep their copy/.test(wc.body) && JSON.stringify(calls("pa_withdraw_library_drill")[0]?.args) === '{"p_id":"L1"}');
  // a failed queue read keeps the last-known list
  QUEUE_ERR = true;
  await click(btn(cur.querySelector('[data-state="submitted"]'), /^Publish$/));
  ok("1. a failed queue re-read keeps the last-known list and says so", cur.querySelectorAll('[data-state="submitted"]').length === 1 && /Couldn't refresh the queue/.test(norm(cur.textContent)));
  ok("1. no table write anywhere in the curator", globalThis.__sb.writes.length === 0, JSON.stringify(globalThis.__sb.writes)); }
await act(async () => rootR.unmount());
reset(); QUEUE_ERR = true;
await render(React.createElement(AdminHarness));
ok("1. a first queue read that fails shows the error + Retry (not an empty 'nothing waiting')", /Couldn't load the queue\./.test(norm(host.textContent)) && !!btn(host, /Retry/) && !/Nothing waiting/.test(norm(host.textContent)));
await act(async () => rootR.unmount());

// ---------------------------------------------------------------- 2 + 3. Training Plans
function Harness({ role, isTrainingOfficer, onAdd, nonce = 0, addedId = null, plan = [] }) {
  const lib = useLibraryCatalog();
  return React.createElement(Training, { S, role, plan, setPlan: () => {}, loadPlans: () => {}, sessions: [], setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: [], meId: "m1", notify, dept: { name: "Test Dept" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {},
    lib, openPacket: (id) => { globalThis.__opened = id; }, onAddLibrary: onAdd || (async () => true), libAddedNonce: nonce, libAddedId: addedId });
}
const toPlans = async () => { await click([...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Training Plans")); await tick(); };
const plansView = () => [...host.children].find((c) => c.style.display !== "none" && /Training Plans/.test(c.textContent) && /Your plan library/.test(c.textContent));
reset();
let addedWith = null;
await render(React.createElement(Harness, { role: ["Department Admin"], isTrainingOfficer: false, onAdd: async (id) => { addedWith = id; return "p-x"; } }));
await toPlans();
{ const fb = plansView()?.querySelector("[data-from-b4c]");
  const titles = fb ? [...fb.querySelectorAll("[data-from-b4c-drill]")].map((d) => d.getAttribute("data-from-b4c-drill")) : [];
  ok("2. From B4C: the newest three, in the catalog's published_at-desc order", JSON.stringify(titles) === '["L1","L2","L3"]', JSON.stringify(titles));
  ok("2. From B4C is the same catalog read (one library_drills read for the whole Training screen)", globalThis.__sb.reads.filter((r) => r.table === "library_drills").length === 1);
  await click(btn(fb.querySelector('[data-from-b4c-drill="L2"]'), /Stroke Recognition/));
  ok("2. tapping a drill opens its packet", globalThis.__opened === "L2");
  await click(btn(fb.querySelector('[data-from-b4c-drill="L1"]'), /Add to my plans/));
  ok("2. Add to my plans (a DA) → the existing pull path with the catalog id", addedWith === "L1");
  await click(fb.querySelector("[data-see-library]"));
  ok("2. 'See the whole library' flips to the Library tab", [...host.children].some((c) => c.style.display !== "none" && /Find a packet/.test(c.textContent))); }
await act(async () => rootR.unmount());
reset();
await render(React.createElement(Harness, { role: ["Member"], isTrainingOfficer: false }));
await toPlans();
{ const fb = plansView()?.querySelector("[data-from-b4c]");
  ok("2. a member sees From B4C but no Add button", !!fb && !btn(fb, /Add to my plans/)); }
await act(async () => rootR.unmount());
reset(); CATALOG = [];
await render(React.createElement(Harness, { role: ["Department Admin"], isTrainingOfficer: false }));
await toPlans();
ok("2. an empty catalog: no From B4C section", !plansView()?.querySelector("[data-from-b4c]"));
await act(async () => rootR.unmount());

const plan = (id, extra = {}) => ({ id, title: `Plan ${id}`, category: null, duration_min: 90, audience: "Mixed crew", content: { summary: "s", objectives: [], run_of_show: [], materials: [], safety: [], instructor_guide: "g" },
  status: "draft", source: "library", library_id: "L1", created_by: "m1", created_at: "2026-11-13T12:00:00Z", approved_by: null, approved_at: null, attached_sessions: 0, ...extra });
reset(); PULLED = [{ library_id: "L1", id: "p-lib", status: "draft", title: "Plan p-lib", duration_min: 90, category: null }];
DRILL = [plan("p-lib")];
await render(React.createElement(Harness, { role: ["Department Admin"], isTrainingOfficer: false, plan: [{ id: "c1", name: "Search & Rescue" }, { id: "c2", name: "EMS" }] }));
await toPlans();
{ const v = plansView();
  const fb = v.querySelector("[data-from-b4c]");
  ok("2. a pulled drill reads 'In your plans · open' (no second Add)", !!btn(fb.querySelector('[data-from-b4c-drill="L1"]'), /In your plans · open/) && !btn(fb.querySelector('[data-from-b4c-drill="L1"]'), /Add to my plans/));
  const pk = v.querySelector("[data-library-category-picker]");
  ok("3. a library draft with no category shows the category picker (the department's categories)", !!pk && [...pk.querySelectorAll("option")].map((o) => o.textContent).join("|") === "Choose a category…|Search & Rescue|EMS");
  ok("3. Save category is disabled until one is picked", btn(pk, /Save category/).disabled === true);
  await setVal(pk.querySelector("select"), "Search & Rescue");
  await click(btn(pk, /Save category/));
  const a = calls("set_drill_plan")[0]?.args || {};
  ok("3. Save category → set_drill_plan with only the category changed", a.p_id === "p-lib" && a.p_category === "Search & Rescue" && a.p_title === "Plan p-lib" && a.p_duration_min === 90 && a.p_audience === "Mixed crew" && a.p_source === "library" && a.p_content?.instructor_guide === "g", JSON.stringify(a)); }
await act(async () => rootR.unmount());
for (const [why, p, role] of [["an approved library plan", plan("p1", { status: "approved" }), ["Department Admin"]], ["a library draft that has a category", plan("p1", { category: "EMS" }), ["Department Admin"]],
  ["an AI draft", plan("p1", { source: "ai", library_id: null }), ["Department Admin"]], ["a member (not a writer)", plan("p1"), ["Member"]]]) {
  reset(); DRILL = [p];
  await render(React.createElement(Harness, { role, isTrainingOfficer: false }));
  await toPlans();
  const v = plansView();
  if (p.status === "approved") await click([...v.querySelectorAll("button[aria-pressed]")].find((b) => /Plan p1/.test(b.textContent)));
  ok(`3. no category picker for ${why}`, /Plan p1/.test(norm(v.textContent)) && !v.querySelector("[data-library-category-picker]"));
  await act(async () => rootR.unmount());
}
// a pull from anywhere (packet / Library / From B4C) re-reads Training Plans and opens that copy
reset(); DRILL = [plan("p-old", { source: "ai", library_id: null, title: "Older AI draft" })];
await render(React.createElement(Harness, { role: ["Department Admin"], isTrainingOfficer: false }));
await toPlans();
DRILL = [plan("p-old", { source: "ai", library_id: null, title: "Older AI draft" }), plan("p-new", { title: "Fresh library copy" })];
await act(async () => { rootR.render(React.createElement(Harness, { role: ["Department Admin"], isTrainingOfficer: false, nonce: 1, addedId: "p-new" })); }); await tick(); await tick(); await tick();
{ const v = plansView();
  const head = norm(v.querySelector("[data-library-category-picker]")?.closest("div[style]")?.parentElement?.textContent || "");
  ok("3. after a pull: Training Plans re-reads and opens the new copy with its category picker", calls("dept_drill_plans").length >= 2 && /Fresh library copy/.test(head) && !!v.querySelector("[data-library-category-picker]")); }
await act(async () => rootR.unmount());

// ---------------------------------------------------------------- 4. the source
const src = show(REV, "src/App.jsx");
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["docs/review/csp_realtime_wss_test.mjs", "docs/review/library_s2_ui_BUILD_ORDER.md", "docs/review/library_s2_ui_test.mjs", "src/App.jsx"];   // + the CSP test's fence pin (cdf1d37..37e3527)
ok("4. fence: only src/App.jsx + this test + the build order + the CSP fence pin changed vs 37e3527", files.every((f) => allowed.includes(f)) && files.includes("src/App.jsx"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("4. fence: no api/, shared/, sql/, vercel.json, index.html, native, package changes", ["api", "shared", "sql", "vercel.json", "index.html", "ios", "android", "package.json", "package-lock.json"].every(untouched));
ok("4. curator writes are the four RPCs; no library_drills / drill_plans table write anywhere", src.includes('supabase.rpc("pa_library_queue")') && ["pa_put_library_drill", "pa_publish_library_drill", "pa_withdraw_library_drill"].every((n) => src.includes(`"${n}", {`))
  && !/from\("library_drills"\)\.(insert|update|upsert|delete)/.test(src)
  && !/from\("library_drills"\)\.(insert|update|upsert|delete)/.test(src) && !/from\("drill_plans"\)\.(insert|update|upsert|delete)/.test(src));
ok("4. library_drills still read with explicit columns only (never *, never origin_department_id)", !/from\("library_drills"\)\.select\("\*"\)/.test(src) && !/origin_department_id"?\s*[,)]/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
ok("4. PA_NAV unchanged (Content Admin was already PA-only)", src.includes('const PA_NAV = ["dashboard", "settings", "admin", "adddept", "department"];') && src.includes('{ key: "admin", label: "Content Admin", Icon: ShieldAlert, roles: ["Project Admin"] }'));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("4. verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("4. Notify held: api/notify-session.js absent; api/_cron.js + vercel.json identical to BASE", !existsSync(join(root, "api/notify-session.js")) && untouched("api/_cron.js") && untouched("vercel.json"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
