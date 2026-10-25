// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_slice2_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes) and checks Training Overhaul Slice 2 — the landing / layout reorg (rulings:
// claude/B4C_TrainingOverhaul_Slice2_Step0_ReviewRecord.md):
//   1. leader render order: hero -> "Draft a plan →" -> overdue banner -> calendar -> Sessions -> attendance trend ->
//      Training Officers card -> category status strip; the "Draft with AI" button + inline planner are gone from the page
//   2. the role matrix (DA / training officer / Officer-not-TO / PA / Board / Member): "Draft a plan →" + "Manage in Training
//      Plans →" + the strip's Schedule buttons follow canManageTraining; the QR button follows canRunSignin (unchanged);
//      category management shows in the Library for writers only; the landing strip is read-only for everyone
//   3. "Draft a plan →" flips the toggle to Training Plans; "Manage in Training Plans →" lands on its categories card
//   4. category management in the Library: add / edit / remove -> the same three training_plans writes (remove behind
//      confirmDestructive), each followed by loadPlans(); the landing strip has no add / edit / remove
//   5. QR: the inline code is 260px; the hero's QR button opens the fullscreen overlay — minting a code with the existing
//      open_signin when none is live, reusing a live one without a second call, and falling back to the row's inline panel
//      for an off-site drill with no location (no RPC); the row's own QR button keeps the inline panel
//   6. member "Up next": this month's remaining sessions with Details open; later months under a collapsed "Later (N)";
//      the 3-item cap applies only to "Later" (+K more on the calendar)
//   7. the source: only src/App.jsx changed; no new RPC; the three training_plans writes now live in TrainingCategoriesCard;
//      AIDrillPlanner still defined but not mounted; canRunSignin unchanged; verified count unchanged; Notify crew absent
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
      const b = { _t: table };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "not", "maybeSingle", "single"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { st.writes.push({ table, op: m, args }); return b; };
      b.then = (res, rej) => Promise.resolve(st.table(table)).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async (o) => { globalThis.__destructive.push(o); return true; }; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ts2-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { Training };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { Training, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- fixtures
const now = new Date();
const at = (monthsAhead, day) => { const d = new Date(now.getFullYear(), now.getMonth() + monthsAhead, day ?? now.getDate()); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }; };
const sess = (id, title, when, extra = {}) => ({ id, title, ...when, done: false, plans: [], attendance: [], signinOpen: false, audience: "everyone", planId: null, ...extra });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BASE_SESS = [
  sess("s1", "Hose drill", at(0)),                                           // today — this month
  sess("s2", "Later drill one", at(1, 10)), sess("s3", "Later drill two", at(2, 10)), sess("s4", "Later drill three", at(3, 10)), sess("s5", "Later drill four", at(4, 10)),
  sess("d1", "Past drill A", at(-1, 5), { done: true, attendance: ["m-ada", "m-mo"] }), sess("d2", "Past drill B", at(-1, 12), { done: true, attendance: ["m-ada"] }),
];
const PLAN = [{ id: "p1", name: "Ladder operations", cadence: "Monthly", color: "#C8323A", lastISO: null }, { id: "p2", name: "Pump ops", cadence: "Quarterly", color: "#3B82F6", lastISO: null }];
const MEMBERS = [{ id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] },
  { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] }, { id: "m-pat", name: "Pat PA", status: "Active", access: ["Project Admin"] },
  { id: "m-bea", name: "Bea Board", status: "Active", access: ["Board Member"] }];
let answers = {};
globalThis.__destructive = [];
globalThis.__sb = {
  calls: [], writes: [],
  table: () => ({ data: [], error: null }),
  answer: (n, a) => answers[n] ? answers[n](a) : n === "open_signin" ? { data: "QR7T5K", error: null } : n === "my_department_id" ? { data: "d-1", error: null } : { data: null, error: null },
};
const notes = []; const notify = (x) => notes.push(x);
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const text = (h) => norm(h.textContent);
const btns = (h, t) => [...h.querySelectorAll("button")].filter((b) => norm(b.textContent) === t || norm(b.textContent).startsWith(t));
const btn = (h, t) => btns(h, t)[0];
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const type = async (input, v) => act(async () => { Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, v); input.dispatchEvent(new win.Event("input", { bubbles: true })); });
let loadPlansN = 0;
async function mountTraining(role, isTrainingOfficer, { sessions = BASE_SESS, meId = "m-mo" } = {}) {
  globalThis.__sb.calls = []; globalThis.__sb.writes = []; globalThis.__destructive = []; notes.length = 0; loadPlansN = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: PLAN, setPlan: () => {}, loadPlans: () => { loadPlansN += 1; }, sessions, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify, dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const toPlans = async (h) => { await click([...h.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Training Plans")); await tick(); await tick(); };
const planned = (n) => globalThis.__sb.calls.filter((c) => c.n === n).length;
const scheduleView = (h) => [...h.children][0].querySelector(":scope > div");   // Training renders the Schedule wrapper first

// 1 leader render order (Department Admin)
{ const { host, unmount } = await mountTraining(["Department Admin"], false, { meId: "m-ada" });
  const t = text(host);
  const cal = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const order = [["hero", t.indexOf("Next training")], ["Draft a plan →", t.indexOf("Draft a plan →")], ["overdue banner", t.indexOf("overdue or never logged")],
    ["calendar", t.indexOf(cal)], ["Sessions", t.indexOf("Sessions ·")], ["attendance trend", t.indexOf("Attendance trend")],
    // the banner's copy now says "see Training categories below" — the strip is the LAST "Training categories"
    ["Training Officers card", t.indexOf("Training officers ·")], ["category strip", t.lastIndexOf("Training categories")]];
  const seq = order.map(([, i]) => i);
  ok("leader order: hero → Draft a plan → → overdue banner → calendar → Sessions → attendance trend → Training Officers card → category strip",
    seq.every((i) => i >= 0) && seq.every((i, k) => k === 0 || i > seq[k - 1]), JSON.stringify(order));
  ok("\"Draft with AI\" button + inline planner gone from the Schedule page", !btn(host, "Draft with AI") && !t.includes("Close planner"));
  ok("the overdue banner points at the category strip", t.includes("see Training categories below and schedule a session"));
  unmount(); }

// 2 the role matrix
for (const [who, role, isTO, meId, e] of [
  ["Department Admin", ["Department Admin"], false, "m-ada", { view: "leader", draft: true, manage: true, sched: true, qr: true, libCats: true }],
  ["training officer (plain Member)", ["Member"], true, "m-mo", { view: "leader", draft: true, manage: true, sched: true, qr: false, libCats: true }],
  ["Officer, NOT a training officer", ["Officer"], false, "m-oli", { view: "leader", draft: false, manage: false, sched: false, qr: true, libCats: false }],
  ["Project Admin", ["Project Admin"], false, "m-pat", { view: "leader", draft: false, manage: false, sched: false, qr: true, libCats: false }],
  ["Board Member", ["Board Member"], false, "m-bea", { view: "leader", draft: false, manage: false, sched: false, qr: false, libCats: false }],
  ["Member", ["Member"], false, "m-mo", { view: "member", draft: false, manage: false, sched: false, qr: false, libCats: false }],
]) {
  const { host, unmount } = await mountTraining(role, isTO, { meId });
  const t = text(host);
  const view = t.includes("Keep training on schedule") ? "leader" : t.includes("Up next for you") ? "member" : "?";
  const draft = !!btn(host, "Draft a plan →"), manage = !!btn(host, "Manage in Training Plans →");
  // the strip's per-category "Schedule" — not the view toggle's "Schedule" segment (aria-pressed)
  const sched = btns(host, "Schedule").some((b) => norm(b.textContent) === "Schedule" && !b.hasAttribute("aria-pressed")), qr = !!btn(host, "QR sign-in");
  const stripRO = !btn(host, "Add a training") && !btn(host, "Edit trainings");
  await toPlans(host);
  const lib = document.getElementById("tp-categories");
  const libCats = !!lib && !!btn(lib, "Add a training");
  ok(`${who}: view ${e.view} · Draft a plan → ${e.draft ? "shown" : "hidden"} · Manage → ${e.manage ? "shown" : "hidden"} · strip Schedule ${e.sched ? "shown" : "hidden"} · QR ${e.qr ? "shown" : "hidden"} · Library categories ${e.libCats ? "shown" : "hidden"} · landing strip read-only`,
    view === e.view && draft === e.draft && manage === e.manage && sched === e.sched && qr === e.qr && libCats === e.libCats && stripRO,
    JSON.stringify({ view, draft, manage, sched, qr, libCats, stripRO }));
  unmount();
}

// 3 the two links flip the toggle
{ const { host, unmount } = await mountTraining(["Department Admin"], false, { meId: "m-ada" });
  await click(btn(host, "Draft a plan →")); await tick(); await tick();
  const seg = [...host.querySelectorAll("button[aria-pressed]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => norm(b.textContent));
  ok("\"Draft a plan →\" flips the toggle to Training Plans (the AI builder is there)", seg.includes("Training Plans") && text(host).includes("Draft a training plan with AI"), JSON.stringify(seg));
  unmount(); }
{ const { host, unmount } = await mountTraining(["Department Admin"], false, { meId: "m-ada" });
  await click(btn(host, "Manage in Training Plans →")); await tick(); await tick();
  ok("\"Manage in Training Plans →\" lands on the Library's Training categories card", !!document.getElementById("tp-categories") && text(document.getElementById("tp-categories")).includes("Ladder operations"));
  unmount(); }

// 4 category management in the Library: the same three training_plans writes
{ const { host, unmount } = await mountTraining(["Department Admin"], false, { meId: "m-ada" });
  await toPlans(host);
  const card = () => document.getElementById("tp-categories");
  await click(btn(card(), "Add a training")); await tick();
  await type([...card().querySelectorAll("label")].find((l) => norm(l.textContent).startsWith("Training")).querySelector("input"), "Vehicle extrication");
  await click(btn(card(), "Add to plan")); await tick(); await tick();
  const ins = globalThis.__sb.writes.find((w) => w.table === "training_plans" && w.op === "insert");
  ok("Library add -> training_plans insert { department_id, name, cadence, color } + loadPlans()", ins && ins.args.department_id === "d-1" && ins.args.name === "Vehicle extrication" && ins.args.cadence === "Monthly" && !!ins.args.color && loadPlansN === 1, JSON.stringify(ins?.args));
  await click(btns(card(), "").find((b) => b.getAttribute("title") === "Edit")); await tick();
  await type([...card().querySelectorAll("label")].find((l) => norm(l.textContent).startsWith("Training")).querySelector("input"), "Ladder ops (renamed)");
  await click(btn(card(), "Save")); await tick(); await tick();
  const upd = globalThis.__sb.writes.find((w) => w.table === "training_plans" && w.op === "update");
  ok("Library edit -> training_plans update { name, cadence, color } (last_iso untouched) + loadPlans()", upd && upd.args.name === "Ladder ops (renamed)" && !("last_iso" in upd.args) && loadPlansN === 2, JSON.stringify(upd?.args));
  await click(btns(card(), "").find((b) => b.getAttribute("title") === "Remove")); await tick(); await tick();
  const del = globalThis.__sb.writes.find((w) => w.table === "training_plans" && w.op === "delete");
  ok("Library remove -> confirmDestructive, then training_plans delete + loadPlans()", globalThis.__destructive.length === 1 && !!del && loadPlansN === 3);
  ok("no other table written by the category card", globalThis.__sb.writes.every((w) => w.table === "training_plans"), JSON.stringify(globalThis.__sb.writes.map((w) => w.table)));
  unmount(); }

// 5 QR
const canvasW = (h) => [...h.querySelectorAll("canvas")].map((c) => c.style.width || c.getAttribute("width"));
{ const { host, unmount } = await mountTraining(["Department Admin"], false, { meId: "m-ada" });
  await click(btn(host, "QR sign-in")); await tick(); await tick();                         // the hero's — first in the DOM
  ok("hero QR (no live code): the existing open_signin mints one and the fullscreen overlay opens", planned("open_signin") === 1 && text(host).includes("Scan to check in") && text(host).includes("QR7T5K"));
  unmount(); }
{ const { host, unmount } = await mountTraining(["Department Admin"], false, { meId: "m-ada" });
  const rowQR = btns(host, "QR sign-in").at(-1);                                              // the Sessions row's — last in the DOM
  await click(rowQR); await tick();
  ok("row QR keeps the inline panel (no overlay, no RPC yet)", !!btn(host, "Open sign-in") && !text(host).includes("Scan to check in") && planned("open_signin") === 0);
  await click(btn(host, "Open sign-in")); await tick(); await tick();
  ok("the inline code is 260px (was 172); the 720px download copy is still there", canvasW(host).includes("260px") && canvasW(host).includes("720px") && !canvasW(host).includes("172px"), JSON.stringify(canvasW(host)));
  await click(btns(host, "QR sign-in")[0]); await tick(); await tick();
  ok("hero QR with a live code: the overlay opens on it — no second open_signin", planned("open_signin") === 1 && text(host).includes("Scan to check in"));
  unmount(); }
{ const off = BASE_SESS.map((x) => (x.id === "s1" ? { ...x, isOffsite: true, locLat: null, locLng: null } : x));
  const { host, unmount } = await mountTraining(["Department Admin"], false, { meId: "m-ada", sessions: off });
  await click(btn(host, "QR sign-in")); await tick(); await tick();
  ok("hero QR, off-site drill with no location: falls back to the row's inline panel (set the location) — no RPC, no overlay", planned("open_signin") === 0 && text(host).includes("Use my location") && !text(host).includes("Scan to check in"));
  unmount(); }

// 6 member Up next
{ const { host, unmount } = await mountTraining(["Member"], false, { meId: "m-mo" });
  const s1Long = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const t = text(host);
  ok("member Up next: this month's session shows with Details open", t.includes("Hose drill") && t.includes(s1Long) && !!btn(host, "Close"));
  ok("member Up next: later months under a collapsed \"Later (4)\" — none of them shown yet", !!btn(host, "Later (4)") && btn(host, "Later (4)").getAttribute("aria-expanded") === "false" && !t.includes("Later drill one"));
  await click(btn(host, "Later (4)")); await tick();
  const t2 = text(host);
  ok("…opening Later shows the next 3 (the cap applies only there) + \"+1 more on the calendar\"", t2.includes("Later drill one") && t2.includes("Later drill two") && t2.includes("Later drill three") && !t2.includes("Later drill four") && t2.includes("+1 more on the calendar"));
  await click(btn(host, "Close")); await tick();
  ok("…a this-month row's Details still close on demand", !text(host).includes(s1Long));
  unmount(); }

// 7 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime)", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
ok("no new RPC", [...rpcSet(src)].every((n) => rpcSet(main).has(n)), JSON.stringify([...rpcSet(src)].filter((n) => !rpcSet(main).has(n))));
const fn = (s, name) => { const i = s.indexOf(`function ${name}(`); return s.slice(i, s.indexOf("\nfunction ", i + 10)); };
const tcc = fn(src, "TrainingCategoriesCard"), tsched = fn(src, "TrainingSchedule");
const writes = (s) => (s.match(/from\("training_plans"\)\.(insert|update|delete)\(/g) || []).length;
ok("the three category writes moved verbatim into TrainingCategoriesCard (none left in TrainingSchedule's category code)",
  ["async function addPlan() {", "async function removePlan(id) {", "async function updatePlan() {"].every((h) => fn(main, "TrainingSchedule").includes(h) && tcc.includes(h) && !tsched.includes(h))
  && writes(tcc) === 3 && writes(src) === writes(main));
ok("AIDrillPlanner still defined (its prompt is the builder's fence) but no longer mounted", src.includes("function AIDrillPlanner(") && !src.includes("<AIDrillPlanner") && !tsched.includes("Draft with AI"));
const sig = (s) => (s.match(/.*const canRunSignin = .*/) || [""])[0];
ok("canRunSignin (the QR gate) unchanged", sig(src) === sig(main) && sig(src).includes("SIGNIN_ROLES"));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(main), `${tok(src)} vs ${tok(main)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
