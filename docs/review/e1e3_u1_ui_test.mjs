// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/e1e3_u1_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes) and drives the real Training screen for E1/E3 Slice U1 (training time UI; Slices T + R live):
//   1. the close-out's "Actual time": Start pre-filled from the schedule, the live preview math (incl. past midnight, noon, <1 h)
//   2. finalize WITH times → finalize_training_session({p_session_id, p_actual_start, p_actual_end, p_setup_min}) — exactly
//      that argument set (PostgREST picks the overload by it), the length never sent; past midnight sent as-is
//   3. the friendly client-side checks (both or neither, end ≠ start, setup 0–600, setup needs times) — nothing sent, no dialog;
//      T2: a plan-scheduled drill (an estimate as its length) finalizes with times straight through
//   4. the fallback — the existing length-only path, the old {p_session_id, p_duration_min} shape (prompt / typed / recorded)
//   5. the past session: Estimated (the plan) · Actual window + length · Setup; a length-only session unchanged
//   6. Correct: the three fields + preview; the DB's "length comes from the times" refusal in plain words; client checks;
//      clearing both times; a length-only correction unchanged; the corrections log names the new fields
//   7. E1 relabel; fences: only src/App.jsx, no new RPC name, verified 132/108, Notify held
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
const out = join(mkdtempSync(join(tmpdir(), "b4c-ts6-")), "app.under-test.mjs");
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


// ---- fixtures (this month): open drills to finalize, finalized drills to view / correct
const now = new Date(), Y = now.getFullYear(), M = now.getMonth();
const dDone = Math.max(1, now.getDate() - 3), dOpen = now.getDate();
const sess = (id, title, extra = {}) => ({ id, title, y: Y, m: M, d: dOpen, done: false, plans: [], attendance: ["m-1"], signinOpen: false, audience: "everyone",
  planId: null, startTime: "19:00:00", durationMin: null, actualStart: null, actualEnd: null, setupMin: null, countsAttendance: true, isMeeting: false, isOffsite: false, locLabel: "", ...extra });
const PLAN_TEXT = "## Quick Run Sheet\n\nTotal time: 120 min\n\n**1. Size-up**\n- Walk the scene\n\n## Hose advance — Drill Plan";
const DT = () => sess("dt", "Hose advance", { d: dDone, done: true, durationMin: 206, actualStart: "19:00:00", actualEnd: "22:26:00", setupMin: 20, attendance: ["m-1", "m-2"],
  plans: [{ id: "p1", kind: "ai", title: "Hose advance", ai_text: PLAN_TEXT, source: "drill_plan", session_id: "dt" }] });
const DM = () => sess("dm", "Night ops", { d: dDone, done: true, durationMin: 210, startTime: "22:00:00", actualStart: "22:00:00", actualEnd: "01:30:00" });
const DL = () => sess("dl", "Pump drill", { d: dDone, done: true, durationMin: 120 });
const CATS = [{ id: "c1", name: "Hose Ops", cadence: "Monthly", color: "#C0392B", lastISO: null }];
const MEMBERS = [{ id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] },
  { id: "m-1", name: "Ann One", status: "Active", access: ["Member"] }, { id: "m-2", name: "Ben Two", status: "Active", access: ["Member"] }];
const AUDIT = [{ id: "au1", seq: 1, session_id: "dt", action: "correct", actor_name: "Ada DA", at: now.toISOString(), reason: "The drill ran long that night",
  changes: { actual_end: { old: "22:26:00", new: "23:00:00" }, duration_min: { old: 206, new: 240 } }, roster_added: [], roster_removed: [], roster_before: 2, roster_after: 2 }];
globalThis.__sb = {
  calls: [], writes: [], uploads: [], removed: [], fail: {},
  table: (t) => t === "training_session_audit" ? { data: AUDIT.map((a) => ({ ...a })), error: null } : { data: [], error: null },
  answer: (n) => {
    const f = globalThis.__sb.fail[n]; if (f) return { data: null, error: { message: f } };
    if (n === "my_department_id") return { data: "d-1", error: null };
    if (n === "drill_window_presence") return { data: [], error: null };
    if (n === "correct_training_session" || n === "reopen_training_session" || n === "finalize_training_session") return { data: { audit_id: "x" }, error: null };
    return { data: null, error: null };
  },
};
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = (el, v, proto = win.HTMLInputElement) => act(async () => { Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new win.Event("input", { bubbles: true })); });
const btn = (root, re) => [...root.querySelectorAll("button")].find((b) => (re instanceof RegExp ? re.test(norm(b.textContent)) : norm(b.textContent) === re));
const textOf = (el) => el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el) : Array.isArray(el) ? el.map(textOf).join(" ") : textOf(el.props?.children);
let host, notes;
async function mount(sessions) {
  Object.assign(globalThis.__sb, { calls: [], writes: [], fail: {} }); globalThis.__destructive = []; globalThis.__confirms = []; globalThis.__prompts = []; globalThis.__promptAnswer = null; notes = [];
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role: ["Department Admin"], plan: CATS, setPlan: () => {}, loadPlans: () => {}, sessions, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId: "m-ada", notify: (n) => notes.push(n), dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer: false, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { unmount: () => act(() => r.unmount()) };
}
const row = (id) => document.getElementById(`ts-${id}`);
const q = (id, t) => row(id)?.querySelector(`[data-testid="${t}"]`);
const rpcs = (n) => globalThis.__sb.calls.filter((c) => c.n === n);
async function closeout(id) { await click(btn(row(id), /^Complete$/)); await tick(); await tick(); }
async function finalize(id) { await click(btn(row(id), /Finalize & lock attendance/)); await tick(); await tick(); }
const keys = (o) => JSON.stringify(Object.keys(o || {}).sort());

// 1 — the close-out's Actual time: Start pre-filled from the schedule, the live preview math (incl. past midnight)
{ const { unmount } = await mount([sess("st", "Hose drill")]);
  await closeout("st");
  ok("Complete shows \"Actual time\": Start pre-filled with the scheduled 19:00, End blank, Setup optional, \"I only know the length\"",
    !!q("st", "actual-time") && q("st", "act-start")?.value === "19:00" && q("st", "act-end")?.value === "" && !!q("st", "act-setup") && !!btn(row("st"), "I only know the length"));
  ok("…preview waits for both times", norm(q("st", "act-preview")?.textContent) === "Enter when it actually started and ended.");
  await setVal(q("st", "act-end"), "22:26");
  ok("preview 19:00–22:26 → \"7:00–10:26 PM · 3h 26m\"", norm(q("st", "act-preview")?.textContent) === "7:00–10:26 PM · 3h 26m", norm(q("st", "act-preview")?.textContent));
  await setVal(q("st", "act-start"), "22:00"); await setVal(q("st", "act-end"), "01:30");
  ok("PAST MIDNIGHT: 22:00–01:30 → \"10:00 PM–1:30 AM (next day) · 3h 30m\"", norm(q("st", "act-preview")?.textContent) === "10:00 PM–1:30 AM (next day) · 3h 30m", norm(q("st", "act-preview")?.textContent));
  await setVal(q("st", "act-start"), "11:15"); await setVal(q("st", "act-end"), "13:00");
  ok("across noon: 11:15–13:00 → \"11:15 AM–1:00 PM · 1h 45m\"", norm(q("st", "act-preview")?.textContent) === "11:15 AM–1:00 PM · 1h 45m", norm(q("st", "act-preview")?.textContent));
  await setVal(q("st", "act-start"), "18:00"); await setVal(q("st", "act-end"), "18:45");
  ok("under an hour: 18:00–18:45 → \"6:00–6:45 PM · 45m\"", norm(q("st", "act-preview")?.textContent) === "6:00–6:45 PM · 45m", norm(q("st", "act-preview")?.textContent));
  ok("nothing is written while typing", globalThis.__sb.calls.filter((c) => c.n !== "drill_window_presence").length === 0 && globalThis.__sb.writes.length === 0, JSON.stringify(globalThis.__sb.calls));
  unmount(); }

// 2 — finalize WITH times → the times overload, exactly its four named arguments; the length is not sent (the DB derives it)
{ const { unmount } = await mount([sess("st", "Hose drill")]);
  await closeout("st");
  await setVal(q("st", "act-end"), "22:26"); await setVal(q("st", "act-setup"), "20");
  await finalize("st");
  const conf = globalThis.__confirms.at(-1), body = norm(textOf(conf?.body)), f = rpcs("finalize_training_session");
  ok("the ONE lock confirm shows Length 3h 26m and the window + setup", globalThis.__confirms.length === 1 && /3h 26m/.test(body) && /7:00–10:26 PM · setup 20 min/.test(body), body.slice(0, 200));
  ok("finalize_training_session({p_session_id, p_actual_start, p_actual_end, p_setup_min}) — the times overload's exact argument set (no p_duration_min)",
    f.length === 1 && keys(f[0].args) === '["p_actual_end","p_actual_start","p_session_id","p_setup_min"]'
    && f[0].args.p_session_id === "st" && f[0].args.p_actual_start === "19:00" && f[0].args.p_actual_end === "22:26" && f[0].args.p_setup_min === 20, JSON.stringify(f));
  ok("…and no length prompt (the times give the length)", globalThis.__prompts.length === 0);
  unmount(); }
{ const { unmount } = await mount([sess("sm", "Night ops", { startTime: "22:00:00" })]);
  await closeout("sm"); await setVal(q("sm", "act-end"), "01:30"); await finalize("sm");
  const f = rpcs("finalize_training_session"), body = norm(textOf(globalThis.__confirms.at(-1)?.body));
  ok("past midnight finalize: 22:00 → 01:30 sent as-is, setup null; confirm reads 3h 30m (next day)",
    f.length === 1 && f[0].args.p_actual_start === "22:00" && f[0].args.p_actual_end === "01:30" && f[0].args.p_setup_min === null && keys(f[0].args) === '["p_actual_end","p_actual_start","p_session_id","p_setup_min"]'
    && /3h 30m/.test(body) && /10:00 PM–1:30 AM \(next day\)/.test(body), JSON.stringify(f) + " " + body.slice(0, 120));
  unmount(); }

// 3 — friendly client-side checks (what the DB enforces): nothing is sent, no dialog opens
for (const [what, fill, re] of [
  ["end = start", { end: "19:00" }, /The end has to be different from the start/],
  ["one time missing (start cleared)", { start: "", end: "21:00" }, /Give both times/],
  ["setup 700", { end: "21:00", setup: "700" }, /Setup is whole minutes, 0–600/],
  ["setup 2.5", { end: "21:00", setup: "2.5" }, /Setup is whole minutes, 0–600/],
  ["setup without an end (Start is pre-filled)", { setup: "15" }, /Give both times/],
  ["setup with both times cleared", { start: "", setup: "15" }, /Give the start and end\. Setup is recorded with the actual times/],
]) {
  const { unmount } = await mount([sess("st", "Hose drill")]);
  await closeout("st");
  if ("start" in fill) await setVal(q("st", "act-start"), fill.start);
  if ("end" in fill) await setVal(q("st", "act-end"), fill.end);
  if ("setup" in fill) await setVal(q("st", "act-setup"), fill.setup);
  await finalize("st");
  ok(`refused before the call — ${what}: an inline line, no confirm, no RPC`, re.test(norm(q("st", "act-err")?.textContent)) && globalThis.__confirms.length === 0 && rpcs("finalize_training_session").length === 0, norm(q("st", "act-err")?.textContent));
  unmount();
}
// T2 — a plan-scheduled drill carries the plan's ESTIMATE as its length (120); finalize-with-times goes straight through and the
// span replaces it server-side (finalize_training_session logs duration_min 120 → 206). No client pre-catch any more.
{ const { unmount } = await mount([sess("sr", "Ladders", { durationMin: 120 })]);
  await closeout("sr"); await setVal(q("sr", "act-end"), "22:26"); await finalize("sr");
  const f = rpcs("finalize_training_session"), body = norm(textOf(globalThis.__confirms.at(-1)?.body));
  ok("T2: a plan-scheduled drill (estimate 120) finalized 19:00–22:26 goes STRAIGHT THROUGH — the times overload, no inline refusal, no prompt",
    f.length === 1 && keys(f[0].args) === '["p_actual_end","p_actual_start","p_session_id","p_setup_min"]' && f[0].args.p_actual_start === "19:00" && f[0].args.p_actual_end === "22:26"
    && !q("sr", "act-err") && globalThis.__prompts.length === 0, JSON.stringify(f));
  ok("…the lock confirm shows the actual length (3h 26m) and says it replaces the 2 hrs set before it ran", /Length 3h 26m/.test(body) && /replaces the 2 hrs set before it ran/.test(body), body.slice(0, 200));
  ok("…and the client no longer carries the \"already has a length\" pre-catch", !readFileSync(join(root, "src/App.jsx"), "utf8").includes("This drill already has a length"));
  unmount(); }
{ const { unmount } = await mount([sess("sr", "Ladders", { durationMin: 120 })]);
  await closeout("sr"); await setVal(q("sr", "act-end"), "21:00"); await finalize("sr");
  ok("times that match the estimate: no \"replaces\" note", rpcs("finalize_training_session").length === 1 && !/replaces/.test(norm(textOf(globalThis.__confirms.at(-1)?.body))));
  unmount(); }

// 4 — the fallback: the existing length-only path, the old {p_session_id, p_duration_min} shape
{ const { unmount } = await mount([sess("sl", "Pump drill")]);
  await closeout("sl"); globalThis.__promptAnswer = "45"; await finalize("sl");
  const f = rpcs("finalize_training_session");
  ok("nothing typed (Start is only the pre-filled schedule): exactly today's path — the length prompt, then {p_session_id, p_duration_min: 45}",
    globalThis.__prompts.length === 1 && /How long was/.test(globalThis.__prompts[0].title) && f.length === 1 && keys(f[0].args) === '["p_duration_min","p_session_id"]' && f[0].args.p_duration_min === 45, JSON.stringify(f));
  unmount(); }
{ const { unmount } = await mount([sess("sl", "Pump drill")]);
  await closeout("sl"); await click(btn(row("sl"), "I only know the length")); await tick();
  ok("\"I only know the length\" swaps the times for a minutes box (and a way back)", !!q("sl", "act-len") && !q("sl", "act-start") && !!btn(row("sl"), "Enter the start and end instead"));
  await setVal(q("sl", "act-len"), "90"); await finalize("sl");
  const f = rpcs("finalize_training_session");
  ok("…a length typed there → {p_session_id, p_duration_min: 90}, no prompt", f.length === 1 && keys(f[0].args) === '["p_duration_min","p_session_id"]' && f[0].args.p_duration_min === 90 && globalThis.__prompts.length === 0, JSON.stringify(f));
  unmount(); }
{ const { unmount } = await mount([sess("sl", "Pump drill")]);
  await closeout("sl"); await click(btn(row("sl"), "I only know the length")); await tick();
  await setVal(q("sl", "act-len"), "0"); await finalize("sl");
  ok("…a bad length there is a friendly line, nothing sent", /Enter whole minutes, 1–1440/.test(norm(q("sl", "act-err")?.textContent)) && rpcs("finalize_training_session").length === 0);
  unmount(); }
{ const { unmount } = await mount([sess("sr", "Ladders", { durationMin: 120 })]);
  await closeout("sr"); await click(btn(row("sr"), "I only know the length")); await tick();
  ok("…on a drill with a recorded length it just says so", /Length 2 hrs is already recorded/.test(norm(q("sr", "act-len-recorded")?.textContent)) && !q("sr", "act-len"));
  await finalize("sr");
  const f = rpcs("finalize_training_session");
  ok("…and finalizes exactly as before: {p_session_id, p_duration_min: null}, no prompt", f.length === 1 && keys(f[0].args) === '["p_duration_min","p_session_id"]' && f[0].args.p_duration_min === null && globalThis.__prompts.length === 0, JSON.stringify(f));
  unmount(); }

// 5 — the past session: Estimated (the plan) · Actual window + length · Setup, side by side; length-only unchanged
{ const { unmount } = await mount([DT(), DM(), DL()]);
  await click(btn(row("dt"), /^Attendance/)); await tick();
  ok("a finalized drill with times: Estimated ~2 hrs (the attached plan) · Actual 7:00–10:26 PM · 3h 26m · Setup 20 min",
    norm(q("dt", "sum-estimated")?.textContent) === "Estimated ~2 hrs" && norm(q("dt", "sum-actual")?.textContent) === "Actual 7:00–10:26 PM · 3h 26m" && norm(q("dt", "sum-setup")?.textContent) === "Setup 20 min",
    [q("dt", "sum-estimated"), q("dt", "sum-actual"), q("dt", "sum-setup")].map((e) => norm(e?.textContent)).join(" | "));
  ok("…and no Actual-time inputs on a finalized drill", !q("dt", "actual-time"));
  await click(btn(row("dm"), /^Attendance/)); await tick();
  ok("past midnight, no plan, no setup: \"Actual 10:00 PM–1:30 AM (next day) · 3h 30m\" alone", norm(q("dm", "sum-actual")?.textContent) === "Actual 10:00 PM–1:30 AM (next day) · 3h 30m" && !q("dm", "sum-estimated") && !q("dm", "sum-setup"),
    norm(q("dm", "sum-actual")?.textContent));
  await click(btn(row("dl"), /^Attendance/)); await tick();
  const t = norm(row("dl").textContent);
  ok("NO REGRESSION — a length-only drill shows exactly what it showed: \"Length 2.0 hrs\", nothing new", /Length 2\.0 hrs/.test(t) && !q("dl", "sum-actual") && !q("dl", "sum-estimated") && !q("dl", "sum-setup") && !q("dl", "actual-time"), t.slice(0, 160));
  unmount(); }

// 6 — Correct: the three fields, the live preview, the DB's "length comes from the times" refusal in plain words
async function openCorrect(id) {
  const eb = btn(host, "Edit sessions"); if (eb) { await click(eb); await tick(); }
  await click(btn(row(id), /^Correct…$/)); await tick();
  return row(id).querySelector('[data-testid="correct-panel"]');
}
const reason = async (p, v = "The drill ran long that night") => setVal(p.querySelector('[data-testid="correct-reason"]'), v, win.HTMLTextAreaElement);
const save = async (p) => { await click(btn(p, /Save correction/)); await tick(); await tick(); };
{ const { unmount } = await mount([DT()]);
  const p = await openCorrect("dt");
  ok("Correct opens with Actual start 19:00 · Actual end 22:26 · Setup 20 and the preview", q("dt", "corr-act-start")?.value === "19:00" && q("dt", "corr-act-end")?.value === "22:26" && q("dt", "corr-setup")?.value === "20"
    && norm(q("dt", "corr-act-preview")?.textContent) === "7:00–10:26 PM · 3h 26m — the length follows the times");
  await setVal(q("dt", "corr-act-end"), "23:00"); await reason(p); await save(p);
  const c = rpcs("correct_training_session");
  ok("changing the end → p_changes = { actual_end: \"23:00\" } only (the DB recomputes the length)", c.length === 1 && JSON.stringify(c[0].args.p_changes) === '{"actual_end":"23:00"}', JSON.stringify(c));
  unmount(); }
{ const { unmount } = await mount([DT()]);
  const p = await openCorrect("dt");
  const len = [...p.querySelectorAll('input[type="number"]')].find((i) => i.value === "206");
  await setVal(len, "100"); await reason(p);
  Object.assign(globalThis.__sb.fail, { correct_training_session: "BAD_VALUE: the length comes from the actual start and end (206 minutes) — change the times instead." });
  await save(p);
  const err = norm(p.querySelector('[role="alert"]')?.textContent);
  ok("a length typed over the times: the DB refuses (BAD_VALUE) and the panel says it plainly — the length comes from the times, 3h 26m, change the start or end",
    rpcs("correct_training_session").length === 1 && /^The length comes from the actual times\./.test(err) && /3h 26m/.test(err) && /change the start or end/.test(err) && !/BAD_VALUE/.test(err), err);
  unmount(); }
{ const { unmount } = await mount([DT()]);
  const p = await openCorrect("dt");
  await setVal(q("dt", "corr-act-end"), "19:00"); await reason(p); await save(p);
  ok("Correct with end = start: a friendly line, no RPC", /The end has to be different from the start/.test(norm(p.querySelector('[role="alert"]')?.textContent)) && rpcs("correct_training_session").length === 0);
  await setVal(q("dt", "corr-act-end"), "22:26"); await setVal(q("dt", "corr-setup"), "601"); await save(p);
  ok("Correct with setup 601: a friendly line, no RPC", /Setup is whole minutes, 0–600/.test(norm(p.querySelector('[role="alert"]')?.textContent)) && rpcs("correct_training_session").length === 0);
  await setVal(q("dt", "corr-setup"), "20"); await setVal(q("dt", "corr-act-start"), ""); await save(p);
  ok("Correct with one time cleared: \"Give both times\", no RPC", /Give both times/.test(norm(p.querySelector('[role="alert"]')?.textContent)) && rpcs("correct_training_session").length === 0);
  await setVal(q("dt", "corr-act-end"), ""); await save(p);
  const c = rpcs("correct_training_session");
  ok("clearing BOTH times → { actual_start: null, actual_end: null } (a length-only session; the length is kept by the DB)", c.length === 1 && JSON.stringify(c[0].args.p_changes) === '{"actual_start":null,"actual_end":null}', JSON.stringify(c));
  unmount(); }
{ const { unmount } = await mount([DL()]);
  const p = await openCorrect("dl");
  ok("Correct on a length-only drill: the time fields are blank", q("dl", "corr-act-start")?.value === "" && q("dl", "corr-act-end")?.value === "" && q("dl", "corr-setup")?.value === "" && !q("dl", "corr-act-preview"));
  const len = [...p.querySelectorAll('input[type="number"]')].find((i) => i.value === "120");
  await setVal(len, "90"); await reason(p); await save(p);
  const c = rpcs("correct_training_session");
  ok("NO REGRESSION — a length-only correction still sends { duration_min: 90 } alone", c.length === 1 && JSON.stringify(c[0].args.p_changes) === '{"duration_min":90}', JSON.stringify(c));
  unmount(); }
{ const { unmount } = await mount([DT()]);
  const eb = btn(host, "Edit sessions"); if (eb) { await click(eb); await tick(); }
  await click(btn(row("dt"), /^Corrections/)); await tick();
  const h = norm(row("dt").querySelector('[data-testid="corrections-history"]')?.textContent);
  ok("the corrections log names the new fields as clock times: \"Actual end: 10:26 PM → 11:00 PM\"", /Actual end: 10:26 PM → 11:00 PM/.test(h) && /Length \(min\): 206 → 240/.test(h), h.slice(0, 200));
  unmount(); }

// 7 — E1 relabel + the source fences
// Structural fences PINNED to U1's reviewed range (released as industrial-noir-50): base 1fc6059 .. reviewed d80c41c —
// "vs the base" / "the current file" would go red once later work lands. The screen checks above run on the current code.
const BASE = "1fc6059", REV = "d80c41c";
const appAt = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const src = appAt(REV), base = appAt(BASE);
ok("E1: the plan's duration is labelled \"Estimated length\" (builder + editor) — the same field, same RPC argument", src.includes('field("Estimated length", <select style={FS.input} value={form.duration}') && src.includes('lbl("Estimated length (minutes)")}<input style={FS.input} inputMode="numeric" value={f.duration}')
  && !src.includes('lbl("Duration (minutes)")') && !src.includes('field("Duration", '));
const changed = execSync(`git diff --name-only ${BASE} ${REV} -- src api shared sql vercel.json package.json`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok(`client only: in the reviewed range ${BASE}..${REV} the only runtime change is src/App.jsx — no SQL / API / vercel.json`, JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
ok("no new RPC name — both finalize shapes call the existing finalize_training_session", [...rpcSet(src)].filter((n) => !rpcSet(base).has(n)).length === 0
  && src.includes('{ p_session_id: s.id, p_actual_start: act.start, p_actual_end: act.end, p_setup_min: act.setup }') && src.includes('{ p_session_id: s.id, p_duration_min: s.durationMin == null ? dur : null }'));
const tok = (s, flags) => (s.match(new RegExp("verifie" + "d", flags)) || []).length;
ok(`verified untouched at ${REV}: App.jsx 132 (108 raw), same as the base`, tok(src, "gi") === 132 && tok(src, "g") === 108 && tok(base, "gi") === 132, `${tok(src, "gi")}/${tok(src, "g")}`);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
