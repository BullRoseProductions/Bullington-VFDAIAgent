// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_nolength_onetap_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (fakes for supabaseClient, ConfirmDestructive, NoirDialogs,
// apiBase) and checks the one-tap length fix on the "finished drills with no length recorded" card
// (claude/B4C_NoLengthCard_OneTapFix_BuildOrder.md):
//   1. a training manager: each listed drill = title · date · N present + a minutes box + Save; empty / 0 / 1441 / a fraction
//      refused inline before any RPC; Save = ONE correct_training_session({duration_min:N}, [], [], the fixed reason);
//      the drill leaves the list; an RPC refusal shows inline on that row only
//   2. the role matrix: inputs for DA + training officer only; Officer-not-TO / Board / PA see the read-only list; a Member
//      never sees the card (member view)
//   3. the source: only src/App.jsx; no new RPC; no direct duration_min update; verified unchanged; Notify held back
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
const out = join(mkdtempSync(join(tmpdir(), "b4c-tnl-")), "app.under-test.mjs");
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

// ---- fixtures: two finished, attended drills with no length (+ one with a length, + a board one — never listed)
const now = new Date(), Y = now.getFullYear(), M = now.getMonth();
const d0 = Math.max(1, now.getDate() - 2);
const sess = (id, title, extra = {}) => ({ id, title, y: Y, m: M, d: d0, done: true, cancelled: false, status: "scheduled", plans: [], attendance: ["m-1", "m-2"],
  signinOpen: false, audience: "everyone", planId: null, startTime: "19:00:00", durationMin: null, countsAttendance: true, isMeeting: false, isOffsite: false, locLabel: "", ...extra });
const SESS = () => [sess("sN1", "Pump drill"), sess("sN2", "Ladder drill"), sess("sL", "Timed drill", { durationMin: 90 }), sess("sB", "Board meeting", { audience: "board" })];
const MEMBERS = [
  { id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-tom", name: "Tom TO", status: "Active", access: ["Member"] },
  { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] }, { id: "m-bea", name: "Bea Board", status: "Active", access: ["Board Member"] },
  { id: "m-pat", name: "Pat PA", status: "Active", access: ["Project Admin"] }, { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] },
  { id: "m-1", name: "Ann One", status: "Active", access: ["Member"] }, { id: "m-2", name: "Ben Two", status: "Active", access: ["Member"] },
];
const REASON = "Session length recorded after the drill.";
globalThis.__sb = {
  calls: [], writes: [], uploads: [], removed: [], fail: {},
  table: () => ({ data: [], error: null }),
  answer: (n) => { const f = globalThis.__sb.fail[n]; if (f) return { data: null, error: { message: f } }; return n === "my_department_id" ? { data: "d-1", error: null } : { data: { audit_id: "x" }, error: null }; },
};
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = (el, v) => act(async () => { Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new win.Event("input", { bubbles: true })); });
const btn = (root, re) => [...(root?.querySelectorAll("button") || [])].find((b) => (re instanceof RegExp ? re.test(norm(b.textContent)) : norm(b.textContent) === re));
let host, notes;
async function mount(role, isTrainingOfficer, meId) {
  Object.assign(globalThis.__sb, { calls: [], writes: [], fail: {} }); globalThis.__destructive = []; globalThis.__confirms = []; globalThis.__prompts = []; globalThis.__promptAnswer = null; notes = [];
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: [], setPlan: () => {}, loadPlans: () => {}, sessions: SESS(), setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify: (n) => notes.push(n), dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { unmount: () => act(() => r.unmount()) };
}
const head = () => btn(host, /finished drills? with no length recorded/);
const rows = () => [...host.querySelectorAll('[data-testid="nolen-row"]')];
const rowOf = (t) => rows().find((r) => norm(r.textContent).startsWith(t));
const rpcs = () => globalThis.__sb.calls.filter((c) => c.n === "correct_training_session");

// 1 — a DA: inline rows; validation; the exact RPC; error inline; the fixed drill leaves the list
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  ok("the card lists the 2 finished, attended, no-length drills (not the timed one, not the board meeting)", /^2 finished drills with no length recorded/.test(norm(head()?.textContent)), norm(head()?.textContent));
  await click(head()); await tick();
  ok("expanded: each drill is a row — title · date · N present + a minutes box + Save", rows().length === 2 && !!rowOf("Pump drill")?.querySelector('input[type="number"]') && !!btn(rowOf("Pump drill"), "Save")
    && /Pump drill · .* · 2 present/.test(norm(rowOf("Pump drill").textContent)));
  ok("the old \"Set length · …\" detour into Correct is gone", !btn(host, /^Set length/));
  for (const [label, v] of [["empty", ""], ["0", "0"], ["1441", "1441"], ["a fraction", "12.5"]]) {
    await setVal(rowOf("Pump drill").querySelector("input"), v); await click(btn(rowOf("Pump drill"), "Save")); await tick();
    ok(`${label} -> refused inline, before any RPC`, rpcs().length === 0 && /Check the length\. Enter whole minutes, 1–1440\./.test(norm(rowOf("Pump drill").querySelector('[role="alert"]')?.textContent)));
  }
  await setVal(rowOf("Pump drill").querySelector("input"), "60"); await click(btn(rowOf("Pump drill"), "Save")); await tick(); await tick();
  const c = rpcs();
  ok("Save -> ONE correct_training_session: duration_min only, empty roster deltas, the fixed reason (nothing typed)",
    c.length === 1 && c[0].args.p_session_id === "sN1" && JSON.stringify(c[0].args.p_changes) === '{"duration_min":60}'
    && JSON.stringify(c[0].args.p_add) === "[]" && JSON.stringify(c[0].args.p_remove) === "[]" && c[0].args.p_reason === REASON && REASON.length >= 10, JSON.stringify(c[0]?.args));
  ok("the fixed drill leaves the list; the other stays; the header recounts", !rowOf("Pump drill") && !!rowOf("Ladder drill") && /^1 finished drill with no length recorded/.test(norm(head()?.textContent)));
  ok("…with a success note, and no direct table write", notes.some((n) => n.kind === "success" && /Pump drill.{0,2} — 60 min/.test(n.text)) && !globalThis.__sb.writes.some((w) => w.table === "training_sessions"));
  globalThis.__sb.fail.correct_training_session = "DA_ONLY: correcting a drill more than 14 days old is for a Department Admin.";
  await setVal(rowOf("Ladder drill").querySelector("input"), "45"); await click(btn(rowOf("Ladder drill"), "Save")); await tick(); await tick();
  ok("an RPC refusal shows inline on that row, in the RPC's words; the drill stays listed", /Department Admin only\. correcting a drill more than 14 days old/.test(norm(rowOf("Ladder drill")?.querySelector('[role="alert"]')?.textContent)) && !!rowOf("Ladder drill"));
  unmount(); }

// 2 — the role matrix: inputs for training managers only
for (const [who, role, isTO, meId, want] of [
  ["Department Admin", ["Department Admin"], false, "m-ada", { card: true, inputs: true }],
  ["training officer (plain Member)", ["Member"], true, "m-tom", { card: true, inputs: true }],
  ["Officer, NOT a training officer", ["Officer"], false, "m-oli", { card: true, inputs: false }],
  ["Board Member", ["Board Member"], false, "m-bea", { card: true, inputs: false }],
  ["Project Admin", ["Project Admin"], false, "m-pat", { card: true, inputs: false }],
  ["Member", ["Member"], false, "m-mo", { card: false, inputs: false }],
]) {
  const { unmount } = await mount(role, isTO, meId);
  if (head()) { await click(head()); await tick(); }
  const got = { card: !!head(), inputs: rows().length > 0 && !!host.querySelector('[data-testid="nolen-row"] input') };
  const txt = norm(host.textContent);
  ok(`${who}: card ${want.card ? "shown" : "not shown"} · inputs ${want.inputs ? "yes" : "no"}${want.card && !want.inputs ? " (read-only list)" : ""}`,
    JSON.stringify(got) === JSON.stringify(want) && (!want.card || want.inputs || /Pump drill · .* · 2 present/.test(txt)), JSON.stringify(got));
  unmount();
}

// 3 — the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const BASE = "origin/main";
const appAt = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const base = appAt(BASE);
const changed = execSync(`git diff --name-only ${BASE} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime) vs origin/main", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
ok("no new RPC — the only call is the existing correct_training_session", [...rpcSet(src)].every((n) => rpcSet(base).has(n)) && rpcSet(base).has("correct_training_session"));
const durWrites = (s) => (s.match(/\.update\(\{[^}]*duration_min/g) || []).length;
ok("no new direct duration_min update", durWrites(src) === durWrites(base), `${durWrites(src)} vs ${durWrites(base)}`);
ok("no new station_presence write", (src.match(/from\("station_presence"\)\.(insert|update|upsert|delete)/g) || []).length === (base.match(/from\("station_presence"\)\.(insert|update|upsert|delete)/g) || []).length);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
