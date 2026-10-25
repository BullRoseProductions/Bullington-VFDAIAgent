// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_officers_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and
// apiBase swapped for in-memory fakes) and checks Training Officers Slice 1 (UI) — the client half of is_training_manager():
//   1. the role matrix through the real Training page: canManageTraining = Department Admin OR training officer —
//      DA yes · Project Admin (only) no · Officer who is NOT a training officer no · plain Member who IS one yes (and gets
//      the management view, not the member view) · plain Member no (member view). Schedule session / the AI planner /
//      the Training Plans builder follow it; the QR sign-in button does NOT (canRunSignin unchanged — an Officer who isn't a
//      training officer still sees it)
//   2. the Training Officers card: shown to DA + PA only; lists officers with who / when; eligible = Active members not
//      already officers, never a Project Admin; Assign -> assign_training_officer(id); Remove -> noirConfirm ->
//      remove_training_officer(id); errors surfaced; the App flag refreshes (onChanged); no direct training_officer writes
//   3. the source: only src/App.jsx; CANMANAGE_OPS_ROLES / SIGNIN_ROLES gone from the training gates; canRunSignin line
//      byte-identical to origin/main; the only new RPCs are assign_ / remove_training_officer; isTrainingOfficer is an
//      active-row lookup like isEqMgr; no hex in the new card; verified count unchanged; Notify absent
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
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "not", "maybeSingle", "single", "insert", "update", "delete", "upsert"]) b[m] = (...a) => { if (["insert", "update", "delete", "upsert"].includes(m)) st.writes.push({ table, m }); return b; };
      b.then = (res, rej) => Promise.resolve(st.table(table)).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async (o) => { globalThis.__confirms.push(o); return true; }; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-toui-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { Training, TrainingOfficersCard };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { Training, TrainingOfficersCard, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- fixtures
const today = new Date();
const SESS = [{ id: "s1", title: "Hose drill", y: today.getFullYear(), m: today.getMonth(), d: today.getDate(), done: false, plans: [], attendance: [], signinOpen: false, audience: "everyone", planId: null }];
const MEMBERS = [{ id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] },
  { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] }, { id: "m-pat", name: "Pat PA", status: "Active", access: ["Project Admin"] },
  { id: "m-ina", name: "Ina Inactive", status: "Inactive", access: ["Member"] }, { id: "m-zed", name: "Zed Member", status: "Active", access: ["Member"] }];
let OFFICERS = [{ id: "to1", member_id: "m-oli", assigned_by_name: "Migration seed (was Officer)", assigned_at: "2026-10-24T12:00:00Z" }];
let answers = {}; let failRead = false;
globalThis.__confirms = [];
globalThis.__sb = {
  calls: [], writes: [],
  table: (t) => (t === "training_officer" ? (failRead ? { data: null, error: { message: "x" } } : { data: OFFICERS.map((o) => ({ ...o })), error: null }) : { data: [], error: null }),
  answer: (n, a) => {
    if (answers[n]) return answers[n](a);
    if (n === "assign_training_officer") { const row = { id: "to" + (OFFICERS.length + 1), member_id: a.p_member_id, assigned_by_name: "Ada DA", assigned_at: new Date().toISOString() }; OFFICERS.push(row); return { data: row, error: null }; }
    if (n === "remove_training_officer") { OFFICERS = OFFICERS.filter((o) => o.member_id !== a.p_member_id); return { data: { id: "x" }, error: null }; }
    return { data: null, error: null };
  },
};
const notes = []; const notify = (x) => notes.push(x);
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => s.replace(/\s+/g, " ").trim();
const text = (h) => norm(h.textContent);
const btn = (h, t) => { const all = [...h.querySelectorAll("button")]; return all.find((b) => norm(b.textContent) === t) || all.find((b) => norm(b.textContent).startsWith(t)); };
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = async (n, v) => act(async () => { Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value").set.call(n, v); n.dispatchEvent(new win.Event("change", { bubbles: true })); });
let changed = 0;
async function mountTraining(role, isTrainingOfficer, meId = "m-mo") {
  globalThis.__sb.calls = []; globalThis.__sb.writes = []; globalThis.__confirms = []; notes.length = 0; changed = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: [], setPlan: () => {}, loadPlans: () => {}, sessions: SESS, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify, dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => { changed += 1; } })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const openPlans = async (h) => { await click([...h.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Training Plans")); await tick(); await tick(); };

// 1 the role matrix
for (const [who, role, isTO, expect] of [
  ["Department Admin", ["Department Admin"], false, { manage: true, view: "leader", card: true, qr: true }],
  ["Project Admin (only)", ["Project Admin"], false, { manage: false, view: "leader", card: true, qr: true }],
  ["Officer, NOT a training officer", ["Officer"], false, { manage: false, view: "leader", card: false, qr: true }],
  ["Officer who IS a training officer (the seed)", ["Officer"], true, { manage: true, view: "leader", card: false, qr: true }],
  ["plain Member who IS a training officer", ["Member"], true, { manage: true, view: "leader", card: false, qr: false }],
  ["plain Member", ["Member"], false, { manage: false, view: "member", card: false, qr: false }],
]) {
  const { host, unmount } = await mountTraining(role, isTO);
  const t = text(host);
  const view = t.includes("Your training calendar") ? "member" : t.includes("Keep training on schedule") ? "leader" : "?";
  // Training Overhaul Slice 2 replaced the hero's "Draft with AI" button (+ inline planner) with a "Draft a plan →" link to the
  // Training Plans tab — the same canPlanAI (= canManageTraining) gate, so the AI entry is checked through the link now.
  const sched = !!btn(host, "Schedule session"), ai = !!btn(host, "Draft a plan →"), card = t.includes("Training officers ·"), qr = !!btn(host, "QR sign-in");
  await openPlans(host);
  const builder = text(host).includes("Draft a training plan with AI");
  ok(`${who}: view ${expect.view}; schedule / AI planner / plans builder ${expect.manage ? "shown" : "hidden"}; officers card ${expect.card ? "shown" : "hidden"}; QR ${expect.qr ? "shown" : "hidden"}`,
    view === expect.view && sched === expect.manage && ai === expect.manage && builder === expect.manage && card === expect.card && qr === expect.qr,
    JSON.stringify({ view, sched, ai, builder, card, qr }));
  unmount();
}

// 2 the card
async function mountCard() {
  globalThis.__sb.calls = []; globalThis.__sb.writes = []; globalThis.__confirms = []; notes.length = 0; changed = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(TrainingOfficersCard, { S, members: MEMBERS, meId: "m-ada", notify, onChanged: () => { changed += 1; } })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
{ const { host, unmount } = await mountCard();
  ok("card: header + count (no cap, no \"of N\") + the current officer", text(host).includes("Training officers · schedule & manage training · 1") && text(host).includes("Oli Officer") && !/of \d/.test(text(host)));
  await click(btn(host, "Manage access")); await tick();
  ok("card: each officer shows who assigned them + when", text(host).includes("Assigned by Migration seed (was Officer)") && text(host).includes("2026"));
  const sel = host.querySelector("select");
  const opts = [...sel.options].map((o) => o.textContent).filter((x) => x !== "Choose a member…");
  ok("card: eligible = Active members not already officers, never a Project Admin", JSON.stringify(opts) === JSON.stringify(["Ada DA", "Mo Member", "Zed Member"]), JSON.stringify(opts));
  await setVal(sel, "m-mo"); await click(btn(host, "Assign")); await tick();
  ok("Assign -> assign_training_officer(member); list reloads; App flag refresh fired", globalThis.__sb.calls.some((c) => c.n === "assign_training_officer" && c.args.p_member_id === "m-mo") && text(host).includes("Mo Member") && text(host).includes("· 2") && changed === 1);
  const rm = [...host.querySelectorAll("button")].filter((b) => norm(b.textContent) === "Remove");
  await click(rm[0]); await tick();
  const cf = globalThis.__confirms.at(-1);
  ok("Remove -> noirConfirm (\"Remove Oli Officer as a training officer?\") -> remove_training_officer(member); their row is gone and they're assignable again", cf && cf.title === "Remove Oli Officer as a training officer?" && cf.danger === true
    && globalThis.__sb.calls.some((c) => c.n === "remove_training_officer" && c.args.p_member_id === "m-oli") && !text(host).includes("Assigned by Migration seed") && [...host.querySelector("select").options].some((o) => o.textContent === "Oli Officer") && changed === 2);
  answers.assign_training_officer = () => ({ data: null, error: { message: "Only a Department Admin can assign training officers." } });
  await setVal(host.querySelector("select"), "m-zed"); await click(btn(host, "Assign")); await tick();
  ok("an RPC refusal is surfaced", notes.some((n) => n.kind === "error" && n.text === "Only a Department Admin can assign training officers."));
  delete answers.assign_training_officer;
  ok("no direct table writes from the card", globalThis.__sb.writes.length === 0, JSON.stringify(globalThis.__sb.writes));
  unmount(); }
{ failRead = true; const { host, unmount } = await mountCard();
  await click(btn(host, "Manage access")); await tick();
  ok("a failed read shows the error + Retry (never an empty \"no officers\")", text(host).includes("Couldn't load the training officers.") && !!btn(host, "Retry") && !text(host).includes("No training officers assigned yet."));
  failRead = false; await click(btn(host, "Retry")); await tick();
  ok("…Retry loads it", !text(host).includes("Couldn't load the training officers.") && text(host).includes("Mo Member"));
  unmount(); }

// 3 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
// Structural fences are PINNED to this slice's own release (2a94baa, a --no-ff merge whose first parent is the main it landed
// on): "vs origin/main" was true only until the next slice merged. Historical = the release vs its parent; ongoing guards
// compare a block this slice owns in today's tree with the release's copy.
const REL = "2a94baa";
const at = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const rel = at(REL), relParent = at(`${REL}^1`);
const changedFiles = execSync(`git diff --name-only ${REL}^1 ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("Training Officers (2a94baa) changed only src/App.jsx (runtime) vs its parent", JSON.stringify(changedFiles) === '["src/App.jsx"]', JSON.stringify(changedFiles));
const fn = (s, name) => { const i = s.indexOf(`function ${name}(`); return s.slice(i, s.indexOf("\nfunction ", i + 10)); };
for (const c of ["TrainingSchedule", "TrainingPlans", "AIDrillPlanner"]) ok(`${c}: no CANMANAGE_OPS_ROLES left`, !fn(src, c).includes("CANMANAGE_OPS_ROLES"));
const sig = (s) => (s.match(/.*const canRunSignin = .*/) || [""])[0];
ok("canRunSignin line untouched by Training Officers (2a94baa vs its parent); here = 2a94baa's (QR gate untouched)", sig(rel) === sig(relParent) && sig(src) === sig(rel) && sig(src).includes("SIGNIN_ROLES"));
ok("canPlanAI + memberView repointed", /const canPlanAI = !!canManageTraining;/.test(src) && /const memberView = !isLeader\(role\) && !isTrainingOfficer;/.test(src));
ok("canManageTraining = Department Admin OR training officer (not PA / not isDeptAdmin)", src.includes('const canManageTraining = hasAny(props.role, ["Department Admin"]) || !!props.isTrainingOfficer;'));
ok("isTrainingOfficer is an active-row lookup like isEqMgr", src.includes('supabase.from("training_officer").select("id").eq("member_id", myMemberId).is("removed_at", null).limit(1)'));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
const added = [...rpcSet(rel)].filter((n) => !rpcSet(relParent).has(n)).sort();
ok("the only new RPCs in Training Officers (2a94baa) vs its parent are assign_ / remove_training_officer", JSON.stringify(added) === '["assign_training_officer","remove_training_officer"]', JSON.stringify(added));
ok("no direct training_officer writes anywhere", !/from\("training_officer"\)\.(insert|update|delete|upsert)/.test(src));
const card = fn(src, "TrainingOfficersCard"); const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
ok("no hex literal in the new card", card.length > 500 && (strip(card).match(/#[0-9A-Fa-f]{3,8}\b/g) || []).length === 0);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged by Training Officers (2a94baa) vs its parent", tok(rel) === tok(relParent), `${tok(rel)} vs ${tok(relParent)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
