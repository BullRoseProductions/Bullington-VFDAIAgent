// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_slice7_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes; canvas stubbed so SignaturePad draws) and checks Training Overhaul Slice 7-UI against the
// 7-DB RPCs (claude/B4C_TrainingOverhaul_Slice7_UI_BuildOrder.md — a DRAFT; ships in one window, 7-DB first):
//   1. the tombstone: struck-through title + Cancelled pill + reason; no Attendance/Plans/QR/Complete/Attach; Restore…;
//      a greyed "✕" calendar chip; the overdue clock ignores a cancelled session; the Show filter's "Cancelled" bucket
//   2. the member view: tombstoned in Up-next, no Register, no requests/log reads
//   3. Cancel…: only on an upcoming, unattended, unfinalized, not-pending row; reason + signature guarded client-side;
//      the RPC's refusal inline; request_session_change(id, 'cancel', reason, PNG)
//   4. Restore… -> request_session_change(id, 'restore', …)
//   5. "Needs your sign-off": approve (own drawn signature) incl. the EXPIRED return; decline (reason); the initiator
//      sees only Withdraw on their own request
//   6. the Corrections history: cancel rows (asked by / signed off by / status old->new); signatures ON DEMAND only
//   7. the role matrix (DA / plain-Member TO / Officer-not-TO / Board / PA / Member)
//   8. the source: App.jsx + two api read filters; only the five new RPCs; no direct status write; signatures never
//      selected; no station_presence write; verified unchanged; Notify held back
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
      const b = { _t: table, _w: null };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "not", "maybeSingle", "single"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { b._w = { table, op: m, args }; st.writes.push(b._w); return b; };
      b.then = (res, rej) => Promise.resolve(b._w && b._w.op === "insert" ? { data: [b._w.args], error: null } : st.table(table)).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ upload: async (p) => { st.uploads.push(p); return { data: { path: p }, error: null }; }, remove: async (ps) => { st.removed.push(...ps); return { error: null }; }, createSignedUrl: async () => ({ data: null, error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async (o) => { globalThis.__destructive.push(o); return true; }; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async (o) => { globalThis.__confirms.push(o); return true; }; export const noirPrompt = async (o) => { globalThis.__prompts.push(o); return globalThis.__promptAnswer; }; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ts7-")), "app.under-test.mjs");
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

// ---- canvas: happy-dom has no 2D context — stub it so SignaturePad can be drawn on
win.HTMLCanvasElement.prototype.getContext = function () { return { scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {}, set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set strokeStyle(v) {} }; };
win.HTMLCanvasElement.prototype.toDataURL = function () { return "data:image/png;base64,QUJDRA=="; };
const SIG = "data:image/png;base64,QUJDRA==";

// ---- fixtures: this month, so the leader list (calendar-month view) shows them all
const now = new Date(), Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
const pad = (n) => String(n).padStart(2, "0");
const sess = (id, title, extra = {}) => ({ id, title, y: Y, m: M, d: D, done: false, cancelled: false, status: "scheduled", plans: [], attendance: [], signinOpen: false,
  audience: "everyone", planId: null, startTime: "23:30:00", durationMin: 60, countsAttendance: true, isMeeting: false, isOffsite: false, locLabel: "", ...extra });
const SESS = () => [
  sess("sC", "Pump night", { cancelled: true, status: "cancelled", planId: "c1" }),   // cancelled, upcoming
  sess("sU", "Upcoming drill"),                                                         // has a pending cancel (rq-p)
  sess("sX", "Hose evening"),                                                           // cancellable
  sess("sA", "Attended drill", { attendance: ["m-1"] }),                                // attended -> no Cancel
  sess("sD", "Done drill", { done: true, attendance: ["m-1"] }),                        // finalized -> no Cancel
  sess("sP", "Old cancelled", { cancelled: true, status: "cancelled", y: M === 0 ? Y - 1 : Y, m: M === 0 ? 11 : M - 1, d: 3 }),   // past, cancelled
];
const CATS = [{ id: "c1", name: "Hose Ops", cadence: "Monthly", color: "#C0392B", lastISO: null }];
const MEMBERS = [
  { id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-tom", name: "Tom TO", status: "Active", access: ["Member"] },
  { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] }, { id: "m-bea", name: "Bea Board", status: "Active", access: ["Board Member"] },
  { id: "m-pat", name: "Pat PA", status: "Active", access: ["Project Admin"] }, { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] },
  { id: "m-1", name: "Ann One", status: "Active", access: ["Member"] },
];
const REQUESTS = [
  { id: "rq-p", session_id: "sU", kind: "cancel", reason: "Not enough instructors that night", initiator_id: "m-tom", initiator_name: "Tom TO", approver_id: null, approver_name: null, decision_reason: null, state: "pending", created_at: now.toISOString(), decided_at: null },
  { id: "rq-c", session_id: "sC", kind: "cancel", reason: "Storm warning — station closed", initiator_id: "m-tom", initiator_name: "Tom TO", approver_id: "m-ada", approver_name: "Ada DA", decision_reason: null, state: "approved", created_at: now.toISOString(), decided_at: now.toISOString() },
];
const AUDIT = [{ id: "au1", seq: 1, session_id: "sC", action: "cancel", actor_name: "Ada DA", at: now.toISOString(), reason: "Storm warning — station closed",
  changes: { status: { old: "scheduled", new: "cancelled" }, request_id: "rq-c", initiator: { id: "m-tom", name: "Tom TO" } }, roster_added: [], roster_removed: [], roster_before: 0, roster_after: 0 }];
globalThis.__sb = {
  calls: [], writes: [], uploads: [], removed: [], fail: {}, reads: [],
  table: (t) => { globalThis.__sb.reads.push(t); return t === "training_session_requests" ? { data: REQUESTS.map((r) => ({ ...r })), error: null } : t === "training_session_audit" ? { data: AUDIT.map((a) => ({ ...a })), error: null } : { data: [], error: null }; },
  answer: (n) => {
    const f = globalThis.__sb.fail[n]; if (f) return { data: null, error: { message: f } };
    if (n === "my_department_id") return { data: "d-1", error: null };
    if (n === "approve_session_change") return { data: { state: globalThis.__approveState || "approved", request_id: "rq-p" }, error: null };
    if (n === "session_change_signatures") return { data: { request_id: "rq-c", initiator_name: "Tom TO", initiator_signature: SIG, approver_name: "Ada DA", approver_signature: SIG }, error: null };
    if (["request_session_change", "reject_session_change", "withdraw_session_change"].includes(n)) return { data: { state: "pending" }, error: null };
    return { data: null, error: null };
  },
};
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = (el, v, proto) => act(async () => { Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new win.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
const btn = (root, re) => [...(root?.querySelectorAll("button") || [])].find((b) => (re instanceof RegExp ? re.test(norm(b.textContent)) : norm(b.textContent) === re));
const PE = win.PointerEvent || win.MouseEvent;
async function draw(root) { const c = root.querySelector("canvas"); for (const [t, x] of [["pointerdown", 4], ["pointermove", 30], ["pointerup", 30]]) await act(async () => { c.dispatchEvent(new PE(t, { bubbles: true, clientX: x, clientY: 9, pointerId: 1 })); }); }
let host, notes;
async function mount(role, isTrainingOfficer, meId, sessions = SESS()) {
  Object.assign(globalThis.__sb, { calls: [], writes: [], fail: {}, reads: [] }); globalThis.__approveState = null;
  globalThis.__destructive = []; globalThis.__confirms = []; globalThis.__prompts = []; globalThis.__promptAnswer = null; notes = [];
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: CATS, setPlan: () => {}, loadPlans: () => {}, sessions, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify: (n) => notes.push(n), dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { unmount: () => act(() => r.unmount()) };
}
const row = (id) => document.getElementById(`ts-${id}`);
const rpcs = (n) => globalThis.__sb.calls.filter((c) => c.n === n);
async function editMode() { const b = btn(host, "Edit sessions"); if (b) { await click(b); await tick(); } }

// 1 — the tombstone (leader list + calendar), the overdue clock, the Show filter
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  const r = row("sC"), struck = r?.querySelector('span[style*="line-through"]');
  ok("tombstone: a cancelled row's title is struck through + a Cancelled pill + its reason", norm(struck?.textContent) === "Pump night" && !!r.querySelector('[data-testid="cancelled-pill"]')
    && norm(r.querySelector('[data-testid="row-cancel-reason"]')?.textContent) === "Cancelled — Storm warning — station closed", norm(r?.textContent).slice(0, 160));
  ok("tombstone: no Attendance / Plans / QR / Complete / Attach on a cancelled row", !btn(r, /^Attendance/) && !btn(r, /^Plans/) && !btn(r, /QR sign-in/) && !btn(r, /^Complete$/) && !/Attach plan/.test(r.textContent));
  ok("…and a live row keeps them all", !!btn(row("sX"), /^Attendance/) && !!btn(row("sX"), /^Complete$/) && /Attach plan/.test(row("sX").textContent));
  ok("Restore… is offered on an upcoming cancelled row (no pending request)", !!btn(r, /^Restore…$/));
  ok("calendar chip: \"✕ Pump night\" (greyed), not a live chip", /✕ Pump night/.test(host.textContent) && !/✓ Pump night/.test(host.textContent));
  ok("overdue clock: a category whose only upcoming session is cancelled is NOT \"On track\"", !/Hose Ops[\s\S]{0,120}On track/.test(norm(host.textContent)));
  const sel = host.querySelector('select[aria-label="Show"]');
  ok("the Show filter has a \"Cancelled\" bucket", [...sel.options].some((o) => o.value === "cancelled" && norm(o.textContent) === "Cancelled"));
  await setVal(sel, "cancelled", win.HTMLSelectElement); await tick();
  const t = norm(host.textContent);
  ok("…which lists every cancelled session, any month (Pump night + Old cancelled), and no live ones", /Cancelled sessions/.test(t) && !!row("sC") && !!row("sP") && !row("sX") && !row("sD"), t.slice(0, 120));
  unmount(); }

// 2 — the member view: tombstoned in Up-next, no Register, no reason (the requests/log aren't member-readable)
{ const { unmount } = await mount(["Member"], false, "m-mo");
  const up = [...host.querySelectorAll('[data-testid="up-cancelled"]')];
  const struck = [...host.querySelectorAll('span[style*="line-through"]')].map((x) => norm(x.textContent));
  ok("member Up-next: the cancelled drill shows struck through + Cancelled, with no Register", struck.includes("Pump night") && up.length === 1 && /Cancelled\. Nothing to register for\./.test(norm(up[0].textContent)), JSON.stringify(struck));
  ok("…a member makes no requests / log reads (RLS would return nothing)", !globalThis.__sb.reads.includes("training_session_requests") && !globalThis.__sb.reads.includes("training_session_audit"));
  ok("…and never a Cancel / Restore / sign-off control", !btn(host, /^Cancel…$/) && !btn(host, /^Restore…$/) && !host.querySelector('[data-testid="signoff-card"]'));
  unmount(); }

// 3 — the Cancel request flow (a DA)
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  await editMode();
  ok("Cancel… only where it qualifies: on the upcoming, unattended, unfinalized row — not attended / finalized / pending / cancelled",
    !!btn(row("sX"), /^Cancel…$/) && !btn(row("sA"), /^Cancel…$/) && !btn(row("sD"), /^Cancel…$/) && !btn(row("sU"), /^Cancel…$/) && !btn(row("sC"), /^Cancel…$/));
  await click(btn(row("sX"), /^Cancel…$/)); await tick();
  const panel = () => row("sX").querySelector('[data-testid="change-panel"]');
  ok("the panel: required reason + a SignaturePad", !!panel() && !!panel().querySelector('[data-testid="change-reason"]') && !!panel().querySelector("canvas"));
  await click(btn(panel(), /Request cancellation/)); await tick();
  ok("a blank reason is refused before the RPC", rpcs("request_session_change").length === 0 && /reason is required/i.test(norm(panel().querySelector('[role="alert"]')?.textContent)));
  await setVal(panel().querySelector('[data-testid="change-reason"]'), "Storm warning — station closed tonight", win.HTMLTextAreaElement);
  await click(btn(panel(), /Request cancellation/)); await tick();
  ok("no signature drawn -> refused before the RPC", rpcs("request_session_change").length === 0 && /Signature needed/.test(norm(panel().querySelector('[role="alert"]')?.textContent)));
  await draw(panel());
  globalThis.__sb.fail.request_session_change = "PENDING: a sign-off is already waiting on this session.";
  await click(btn(panel(), /Request cancellation/)); await tick(); await tick();
  ok("the RPC's refusal shows inline (PENDING), panel kept open", /Already waiting on a sign-off\. a sign-off is already waiting/.test(norm(panel()?.querySelector('[role="alert"]')?.textContent)) && !!panel());
  globalThis.__sb.fail = {};
  await click(btn(panel(), /Request cancellation/)); await tick(); await tick();
  const c = rpcs("request_session_change").at(-1);
  ok("request_session_change(sX, 'cancel', reason, the drawn PNG)", c && c.args.p_session_id === "sX" && c.args.p_kind === "cancel" && c.args.p_reason === "Storm warning — station closed tonight" && c.args.p_signature === SIG, JSON.stringify(c?.args));
  ok("…says it's waiting on a second sign-off; nothing written directly", notes.some((n) => /waiting on a second sign-off/.test(n.text)) && !globalThis.__sb.writes.some((w) => w.table === "training_sessions"));
  unmount(); }

// 4 — Restore request (a training officer, on the cancelled row)
{ const { unmount } = await mount(["Member"], true, "m-tom");
  await click(btn(row("sC"), /^Restore…$/)); await tick();
  const panel = row("sC").querySelector('[data-testid="change-panel"]');
  await setVal(panel.querySelector('[data-testid="change-reason"]'), "Storm passed — drill is back on", win.HTMLTextAreaElement); await draw(panel);
  await click(btn(panel, /Request restore/)); await tick(); await tick();
  const c = rpcs("request_session_change").at(-1);
  ok("Restore… -> request_session_change(sC, 'restore', …)", c && c.args.p_session_id === "sC" && c.args.p_kind === "restore" && c.args.p_signature === SIG, JSON.stringify(c?.args));
  unmount(); }

// 5 — "Needs your sign-off": approve (incl. expired), decline; the initiator's withdraw
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  const card = () => host.querySelector('[data-testid="signoff-card"]');
  ok("a DA (not the initiator) sees \"Needs your sign-off (1)\": who asked, the session, the reason", /Needs your sign-off \(1\)/.test(norm(card()?.textContent))
    && /Cancel · Upcoming drill/.test(norm(card().textContent)) && /Tom TO asked/.test(norm(card().textContent)) && /Not enough instructors that night/.test(norm(card().textContent)));
  ok("…the pending marker shows on the session row too", /Cancellation pending — waiting on a second sign-off \(Tom TO asked\)/.test(norm(row("sU").querySelector('[data-testid="row-pending"]')?.textContent)));
  await click(btn(card(), /^Approve…$/)); await tick();
  await click(btn(card(), /^Sign off/)); await tick();
  ok("signing off without drawing is refused before the RPC", rpcs("approve_session_change").length === 0 && notes.some((n) => /Signature needed/.test(n.title)));
  await draw(card());
  await click(btn(card(), /^Sign off/)); await tick(); await tick();
  const a = rpcs("approve_session_change");
  ok("approve_session_change(rq-p, the approver's own drawn PNG) -> success", a.length === 1 && a[0].args.p_request_id === "rq-p" && a[0].args.p_signature === SIG && notes.some((n) => /Session cancelled/.test(n.title)), JSON.stringify(a));
  ok("…and it reloads requests + the log afterwards", globalThis.__sb.reads.filter((t) => t === "training_session_requests").length >= 2);
  // expired return
  globalThis.__approveState = "expired"; notes.length = 0;
  await click(btn(card(), /^Approve…$/)); await tick(); await draw(card());
  await click(btn(card(), /^Sign off/)); await tick(); await tick();
  ok("an expired return reads as \"That request expired\" — not a success, not a crash", notes.some((n) => n.title === "That request expired") && !notes.some((n) => n.kind === "success"));
  // decline
  globalThis.__promptAnswer = "no";
  await click(btn(card(), /^Decline…$/)); await tick();
  ok("declining with a too-short reason is refused before the RPC", rpcs("reject_session_change").length === 0);
  globalThis.__promptAnswer = "We found a second instructor";
  await click(btn(card(), /^Decline…$/)); await tick(); await tick();
  const j = rpcs("reject_session_change");
  ok("Decline… -> reject_session_change(rq-p, reason)", j.length === 1 && j[0].args.p_request_id === "rq-p" && j[0].args.p_reason === "We found a second instructor");
  unmount(); }
{ const { unmount } = await mount(["Member"], true, "m-tom");
  const card = host.querySelector('[data-testid="signoff-card"]');
  ok("the initiator sees no approve for their own request (\"Needs your sign-off (0)\") — only \"Your request … Withdraw\"",
    /Needs your sign-off \(0\)/.test(norm(card?.textContent)) && !btn(card, /^Approve…$/) && /Your request — Cancel · Upcoming drill/.test(norm(card.textContent)));
  await click(btn(card, /^Withdraw$/)); await tick(); await tick();
  const w = rpcs("withdraw_session_change");
  ok("Withdraw -> withdraw_session_change(rq-p)", w.length === 1 && w[0].args.p_request_id === "rq-p");
  ok("…the row's pending marker offers the initiator Withdraw as well", !!btn(row("sU").querySelector('[data-testid="row-pending"]'), /^Withdraw$/));
  unmount(); }

// 6 — the Corrections history: cancel rows + signatures on demand only
{ const { unmount } = await mount(["Board Member"], false, "m-bea");
  const hb = btn(row("sC"), /^Corrections \(\d+\)$/);
  ok("Board (leadership) sees \"Corrections (1)\" on the cancelled session", norm(hb?.textContent) === "Corrections (1)");
  await click(hb); await tick();
  const h = row("sC").querySelector('[data-testid="corrections-history"]'), t = norm(h?.textContent);
  ok("the cancel row: \"Cancelled by Ada DA\", the reason, \"Asked by Tom TO · signed off by Ada DA\", Status scheduled → cancelled",
    /Cancelled by Ada DA/.test(t) && /“Storm warning — station closed”/.test(t) && /Asked by Tom TO · signed off by Ada DA/.test(t) && /Status: scheduled → cancelled/.test(t) && !/request_id|Initiator:/.test(t), t);
  ok("signatures are NOT fetched with the list", rpcs("session_change_signatures").length === 0 && !h.querySelector("img"));
  await click(btn(h, /^View signatures$/)); await tick(); await tick();
  const imgs = [...row("sC").querySelectorAll('[data-testid="signatures"] img')];
  ok("\"View signatures\" -> session_change_signatures(rq-c) once -> both drawn signatures", rpcs("session_change_signatures").length === 1 && rpcs("session_change_signatures")[0].args.p_request_id === "rq-c"
    && imgs.length === 2 && imgs.every((i) => i.getAttribute("src") === SIG));
  ok("Board has no Cancel / Restore / sign-off card (not a training manager)", !btn(host, /^Restore…$/) && !host.querySelector('[data-testid="signoff-card"]'));
  unmount(); }

// 7 — the role matrix
for (const [who, role, isTO, meId, want] of [
  ["Department Admin", ["Department Admin"], false, "m-ada", { cancel: true, restore: true, card: true, hist: true, reason: true }],
  ["training officer (plain Member)", ["Member"], true, "m-tom", { cancel: true, restore: true, card: true, hist: false, reason: true }],
  ["Officer, NOT a training officer", ["Officer"], false, "m-oli", { cancel: false, restore: false, card: false, hist: true, reason: true }],
  ["Board Member", ["Board Member"], false, "m-bea", { cancel: false, restore: false, card: false, hist: true, reason: true }],
  ["Project Admin", ["Project Admin"], false, "m-pat", { cancel: false, restore: false, card: false, hist: true, reason: true }],
  ["Member", ["Member"], false, "m-mo", { cancel: false, restore: false, card: false, hist: false, reason: false }],
]) {
  const { unmount } = await mount(role, isTO, meId);
  await editMode();
  const got = { cancel: !!btn(host, /^Cancel…$/), restore: !!btn(host, /^Restore…$/), card: !!host.querySelector('[data-testid="signoff-card"]'),
    hist: !!(row("sC") && btn(row("sC"), /^Corrections/)), reason: /Storm warning — station closed/.test(host.textContent) };
  ok(`${who}: Cancel ${want.cancel ? "yes" : "no"} · Restore ${want.restore ? "yes" : "no"} · sign-off card ${want.card ? "yes" : "no"} · history ${want.hist ? "yes" : "no"} · tombstone reason ${want.reason ? "yes" : "no"}`,
    JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  unmount();
}

// 8 — the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const BASE = "origin/main";
const appAt = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const base = appAt(BASE);
const changed = execSync(`git diff --name-only ${BASE} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
ok("runtime changes: src/App.jsx + the two api read filters only", JSON.stringify(changed) === '["api/assistant.js","api/pulse.js","src/App.jsx"]', JSON.stringify(changed));
const apiDiff = execSync(`git diff ${BASE} -- api`, { cwd: root }).toString().split("\n").filter((l) => /^[+-][^+-]/.test(l));
ok("the api changes are read filters only (.neq status cancelled) — no write path", apiDiff.filter((l) => l.startsWith("+")).every((l) => /neq\("status", "cancelled"\)|^\+\s*\.eq\("done", false\)$/.test(l)) && !apiDiff.some((l) => /insert|update|delete|upsert/i.test(l)), JSON.stringify(apiDiff));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
const added = [...rpcSet(src)].filter((n) => !rpcSet(base).has(n)).sort();
ok("the only new RPCs are the five 7-DB ones", JSON.stringify(added) === JSON.stringify(["approve_session_change", "reject_session_change", "request_session_change", "session_change_signatures", "withdraw_session_change"]), JSON.stringify(added));
// every write on training_sessions (update / insert / upsert, single- or multi-line) — none may carry a status field
const tsWrites = src.split('from("training_sessions")').slice(1).map((x) => x.slice(0, 1200)).filter((x) => /^(\s|\/\/[^\n]*\n)*\.(update|insert|upsert)\(/.test(x));   // comment lines may sit before .update(
const rowsLit = (src.match(/const rows = fresh\.map\(\(iso\) => \(\{[^\n]*/) || [""])[0];   // scheduleRecurring's bulk-insert rows
ok("no direct status write: no training_sessions update/insert/upsert carries status (status moves only via the RPCs)",
  tsWrites.length >= 4 && tsWrites.every((x) => !/\bstatus\s*:/.test(x.slice(0, x.search(/\)\s*[.;]/) + 1 || 1200))) && !/\bstatus\s*:/.test(rowsLit), `${tsWrites.length} writes`);
ok("the signature columns are never selected (only via session_change_signatures)", !/training_session_requests"\)\s*\.select\("[^"]*signature/.test(src));
ok("no new station_presence write", (src.match(/from\("station_presence"\)\.(insert|update|upsert|delete)/g) || []).length === (base.match(/from\("station_presence"\)\.(insert|update|upsert|delete)/g) || []).length);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main (App.jsx)", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
ok("…and in api/assistant.js + api/digest.js", ["api/assistant.js", "api/digest.js"].every((f) => tok(readFileSync(join(root, f), "utf8")) === tok(execSync(`git show ${BASE}:${f}`, { cwd: root }).toString())));
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
