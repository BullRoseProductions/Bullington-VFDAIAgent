// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_slice6_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes) and checks Training Overhaul Slice 6-UI against the 6-DB RPCs
// (claude/B4C_TrainingOverhaul_Slice6_DB_ReviewRecord.md — built ahead of the 6-DB apply; promoted in the same window):
//   1. Correct… on a LOCKED row (Edit sessions): pre-filled form + roll + required reason -> ONE correct_training_session
//      call with only the changed §2a fields and the roster deltas; a blank reason is refused before the RPC; the RPC's
//      DA_ONLY / MEMBERSHIP_WINDOW / LOCKED_SESSION refusals render inline
//   2. Corrections (N) history (leadership): newest first — who / when / reason / old->new / roster ± / roll count
//   3. Reopen: a required 10+ character reason -> reopen_training_session; never the direct update({done:false})
//   4. Complete -> "On station during the drill (N)" from drill_window_presence, pre-ticked -> plain session_attendance
//      inserts only (no station_presence); Finalize -> finalize_training_session + the R3 "N present · M were on station"
//      line inside the one lock confirm; no client last_iso stamp
//   5. the no-length notice -> "Set length" -> Correct (a logged duration_min correction)
//   6. the role matrix (DA / TO / Officer-not-TO / Board / PA / Member)
//   7. the source: only src/App.jsx; the only new RPCs are the four 6-DB ones; verified unchanged; Notify held back
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

// ---- fixtures: one finalized + attended drill, one open drill with a start time (for Complete), this month
const now = new Date(), Y = now.getFullYear(), M = now.getMonth();
const dDone = Math.max(1, now.getDate() - 3), dOpen = now.getDate();
const pad = (n) => String(n).padStart(2, "0");
const sess = (id, title, extra = {}) => ({ id, title, y: Y, m: M, d: dOpen, done: false, plans: [], attendance: [], signinOpen: false, audience: "everyone",
  planId: null, startTime: "19:00:00", durationMin: 120, countsAttendance: true, isMeeting: false, isOffsite: false, locLabel: "", ...extra });
const SESS = () => [
  sess("sd", "Hose drill", { d: dDone, done: true, attendance: ["m-1", "m-2"], planId: "c1" }),
  sess("so", "Ladder night", { durationMin: null, attendance: ["m-1"] }),
];
const CATS = [{ id: "c1", name: "Hose Ops", cadence: "Monthly", color: "#C0392B", lastISO: null }];
const MEMBERS = [
  { id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-tom", name: "Tom TO", status: "Active", access: ["Member"] },
  { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] }, { id: "m-bea", name: "Bea Board", status: "Active", access: ["Board Member"] },
  { id: "m-pat", name: "Pat PA", status: "Active", access: ["Project Admin"] }, { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] },
  { id: "m-1", name: "Ann One", status: "Active", access: ["Member"] }, { id: "m-2", name: "Ben Two", status: "Active", access: ["Member"] },
  { id: "m-3", name: "Cal Three", status: "Active", access: ["Member"] },
];
const AUDIT = [
  { id: "au2", seq: 2, session_id: "sd", action: "correct", actor_name: "Ada DA", at: now.toISOString(), reason: "Wrong night on the QR sign-in",
    changes: { date: { old: `${Y}-${pad(M + 1)}-24`, new: `${Y}-${pad(M + 1)}-03` }, plan_id: { old: null, new: "c1" } }, roster_added: ["m-2"], roster_removed: [], roster_before: 1, roster_after: 2 },
  { id: "au1", seq: 1, session_id: "sd", action: "finalize", actor_name: "Tom TO", at: now.toISOString(), reason: null,
    changes: { done: { old: false, new: true } }, roster_added: [], roster_removed: [], roster_before: 1, roster_after: 1 },
];
const STATION = [{ member_id: "m-1", member_name: "Ann One", on_roll: true }, { member_id: "m-3", member_name: "Cal Three", on_roll: false }];
globalThis.__sb = {
  calls: [], writes: [], uploads: [], removed: [], fail: {},
  table: (t) => t === "training_session_audit" ? { data: AUDIT.map((a) => ({ ...a })), error: null } : { data: [], error: null },
  answer: (n) => {
    const f = globalThis.__sb.fail[n]; if (f) return { data: null, error: { message: f } };
    if (n === "my_department_id") return { data: "d-1", error: null };
    if (n === "drill_window_presence") return { data: STATION.map((r) => ({ ...r })), error: null };
    if (n === "correct_training_session" || n === "reopen_training_session" || n === "finalize_training_session") return { data: { audit_id: "x" }, error: null };
    return { data: null, error: null };
  },
};
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = (el, v, proto) => act(async () => { Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new win.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
const btn = (root, re) => [...root.querySelectorAll("button")].find((b) => (re instanceof RegExp ? re.test(norm(b.textContent)) : norm(b.textContent) === re));
const textOf = (el) => el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el) : Array.isArray(el) ? el.map(textOf).join(" ") : textOf(el.props?.children);
let host, notes;
async function mount(role, isTrainingOfficer, meId, sessions = SESS()) {
  Object.assign(globalThis.__sb, { calls: [], writes: [], fail: {} }); globalThis.__destructive = []; globalThis.__confirms = []; globalThis.__prompts = []; globalThis.__promptAnswer = null; notes = [];
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: CATS, setPlan: () => {}, loadPlans: () => {}, sessions, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify: (n) => notes.push(n), dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { unmount: () => act(() => r.unmount()) };
}
const row = (id) => document.getElementById(`ts-${id}`);
const rpcs = (n) => globalThis.__sb.calls.filter((c) => c.n === n);
async function editMode() { const b = btn(host, "Edit sessions"); if (b) { await click(b); await tick(); } }

// 1 — Correct: one RPC with exactly the changed fields + roster deltas; a blank reason is refused (no RPC)
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  ok("at rest (not in Edit sessions) a locked row shows no Correct…", !btn(row("sd"), /^Correct…$/));
  await editMode();
  const cb = btn(row("sd"), /^Correct…$/);
  ok("Edit sessions: the finalized + attended row offers Correct… (and no plain Edit pencil)", !!cb && !row("sd").querySelector('button[title="Edit"]'));
  ok("…an attended open row is locked too: Correct…, not Edit", !!btn(row("so"), /^Correct…$/) && !row("so").querySelector('button[title="Edit"]'));
  await click(cb); await tick();
  const panel = row("sd").querySelector('[data-testid="correct-panel"]');
  const title = panel?.querySelector("input:not([type])"), date = panel?.querySelector('input[type="date"]'), len = panel?.querySelector('input[type="number"]');
  ok("the form opens pre-filled (title, date, length) with the roll ticked as recorded",
    title?.value === "Hose drill" && date?.value === `${Y}-${pad(M + 1)}-${pad(dDone)}` && len?.value === "120"
    && [...panel.querySelectorAll('input[type="checkbox"]')].filter((c) => c.checked).length >= 2, JSON.stringify([title?.value, date?.value, len?.value]));
  await setVal(title, "Hose drill (corrected)", win.HTMLInputElement); await setVal(len, "90", win.HTMLInputElement);
  const box = (name) => [...panel.querySelectorAll("label")].find((l) => norm(l.textContent) === name)?.querySelector('input[type="checkbox"]');
  await click(box("Ben Two")); await click(box("Cal Three")); await tick();
  await click(btn(panel, /Save correction/)); await tick();
  ok("a blank reason is refused inline — no RPC", rpcs("correct_training_session").length === 0 && /reason is required/i.test(norm(panel.querySelector('[role="alert"]')?.textContent)));
  await setVal(panel.querySelector('[data-testid="correct-reason"]'), "Wrong length and Ben left before roll", win.HTMLTextAreaElement);
  await click(btn(panel, /Save correction/)); await tick(); await tick();
  const c = rpcs("correct_training_session");
  ok("one correct_training_session call", c.length === 1, JSON.stringify(c));
  ok("p_changes = ONLY what changed (title, duration_min) — the §2a keys", JSON.stringify(c[0]?.args.p_changes) === JSON.stringify({ title: "Hose drill (corrected)", duration_min: 90 }), JSON.stringify(c[0]?.args.p_changes));
  ok("p_add / p_remove = the roster deltas; p_reason trimmed; the session id", JSON.stringify(c[0]?.args.p_add) === '["m-3"]' && JSON.stringify(c[0]?.args.p_remove) === '["m-2"]'
    && c[0]?.args.p_reason === "Wrong length and Ben left before roll" && c[0]?.args.p_session_id === "sd");
  ok("no direct training_sessions / session_attendance write from Correct", !globalThis.__sb.writes.some((w) => w.table === "training_sessions" || w.table === "session_attendance"));
  ok("success closes the panel", !row("sd").querySelector('[data-testid="correct-panel"]') && notes.some((n) => n.kind === "success"));
  unmount(); }

// 1b — the RPC's refusals show inline (DA_ONLY / MEMBERSHIP_WINDOW / LOCKED_SESSION)
for (const [code, msg, re] of [
  ["DA_ONLY", "DA_ONLY: correcting a drill more than 14 days old is for a Department Admin.", /Department Admin only\. correcting a drill more than 14 days old/],
  ["MEMBERSHIP_WINDOW", "MEMBERSHIP_WINDOW: a member recorded at this drill was not on the department roster on that date.", /Not on the roster that day\. a member recorded at this drill/],
  ["LOCKED_SESSION", "LOCKED_SESSION: this session is finalized or has attendance — change it with Correct, which is logged.", /This session is locked\./],
]) {
  const { unmount } = await mount(["Member"], true, "m-tom");
  await editMode(); await click(btn(row("sd"), /^Correct…$/)); await tick();
  const panel = row("sd").querySelector('[data-testid="correct-panel"]');
  await setVal(panel.querySelector('input[type="date"]'), `${Y}-${pad(M + 1)}-01`, win.HTMLInputElement);
  await setVal(panel.querySelector('[data-testid="correct-reason"]'), "Moving it to the night it ran", win.HTMLTextAreaElement);
  globalThis.__sb.fail.correct_training_session = msg;
  await click(btn(panel, /Save correction/)); await tick(); await tick();
  const alert = norm(row("sd").querySelector('[data-testid="correct-panel"] [role="alert"]')?.textContent);
  ok(`${code} is shown inline, in the RPC's words; the panel stays open`, re.test(alert) && !!row("sd").querySelector('[data-testid="correct-panel"]'), alert);
  unmount();
}

// 2 — Corrections (N) history: newest first, who / when / old→new / roster ± / reason; leadership only
{ const { unmount } = await mount(["Board Member"], false, "m-bea");
  const hb = btn(row("sd"), /^Corrections \(\d+\)$/);
  ok("Board (leadership) sees \"Corrections (1)\" — a finalize isn't counted as a correction", !!hb && norm(hb.textContent) === "Corrections (1)", norm(hb?.textContent));
  await click(hb); await tick();
  const h = row("sd").querySelector('[data-testid="corrections-history"]'), t = norm(h?.textContent);
  ok("the history renders newest first: Corrected by Ada DA before Finalized by Tom TO", t.indexOf("Corrected by Ada DA") >= 0 && t.indexOf("Corrected by Ada DA") < t.indexOf("Finalized by Tom TO"), t.slice(0, 160));
  ok("…with the reason, old→new (category by name), the roster + and the roll count",
    /“Wrong night on the QR sign-in”/.test(t) && new RegExp(`Date: ${Y}-${pad(M + 1)}-24 → ${Y}-${pad(M + 1)}-03`).test(t) && /Category: — → Hose Ops/.test(t) && /\+ Ben Two/.test(t) && /Roll 1 → 2/.test(t), t);
  unmount(); }
{ const { unmount } = await mount(["Member"], true, "m-tom");
  ok("a training officer who is a plain Member: no Corrections history (the log is is_leadership-readable only)", !btn(row("sd"), /^Corrections/));
  unmount(); }

// 3 — Reopen: a required reason (10+), then reopen_training_session — never the direct update
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  globalThis.__promptAnswer = null;
  await click(btn(row("sd"), /Reopen/)); await tick();
  ok("Reopen asks for a reason (required) — cancelling does nothing", globalThis.__prompts.length === 1 && globalThis.__prompts[0].required === true && rpcs("reopen_training_session").length === 0);
  globalThis.__promptAnswer = "oops";
  await click(btn(row("sd"), /Reopen/)); await tick();
  ok("a too-short reason is refused before the RPC", rpcs("reopen_training_session").length === 0 && notes.some((n) => /reason is required/i.test(n.title)));
  globalThis.__promptAnswer = "Two members were missed off the roll";
  await click(btn(row("sd"), /Reopen/)); await tick(); await tick();
  const r = rpcs("reopen_training_session");
  ok("reopen_training_session(id, reason) — and no direct update({done:false})", r.length === 1 && r[0].args.p_session_id === "sd" && r[0].args.p_reason === "Two members were missed off the roll"
    && !globalThis.__sb.writes.some((w) => w.table === "training_sessions" && w.op === "update"), JSON.stringify(r));
  unmount(); }

// 4 — Complete → the on-station prefill (pre-ticked) → plain session_attendance inserts; Finalize via the RPC + R3 line
{ const { unmount } = await mount(["Member"], true, "m-tom");
  await click(btn(row("so"), /^Complete$/)); await tick(); await tick();
  ok("Complete fetches drill_window_presence for the drill", rpcs("drill_window_presence").length === 1 && rpcs("drill_window_presence")[0].args.p_session_id === "so");
  const grp = row("so").querySelector('[data-testid="on-station"]');
  const boxes = grp ? [...grp.querySelectorAll("label")].map((l) => ({ name: norm(l.textContent), checked: l.querySelector("input").checked, disabled: l.querySelector("input").disabled })) : [];
  ok("\"On station during the drill (2)\": Cal pre-ticked; Ann shown as already on the roll", /On station during the drill \(2\)/.test(norm(grp?.textContent))
    && boxes.some((b) => b.name.startsWith("Cal Three") && b.checked && !b.disabled) && boxes.some((b) => /Ann One · already on the roll/.test(b.name) && b.disabled), JSON.stringify(boxes));
  await click(btn(grp, /^Mark 1 present$/)); await tick(); await tick();
  const ins = globalThis.__sb.writes.filter((w) => w.op === "insert");
  ok("confirming writes ONE plain session_attendance insert (department, session, member, checked_in_at) — nothing else",
    ins.length === 1 && ins[0].table === "session_attendance" && ins[0].args.member_id === "m-3" && ins[0].args.session_id === "so"
    && JSON.stringify(Object.keys(ins[0].args).sort()) === '["checked_in_at","department_id","member_id","session_id"]', JSON.stringify(ins));
  ok("no station_presence write, ever", !globalThis.__sb.writes.some((w) => w.table === "station_presence"));
  // Finalize: the roll here is still 1 (props don't re-render) vs 2 on station -> the R3 soft line, inside the one confirm
  globalThis.__promptAnswer = "45";
  await click(btn(row("so"), /Finalize & lock attendance/)); await tick(); await tick();
  const conf = globalThis.__confirms.at(-1);
  ok("R3: the lock confirm carries \"1 present · 2 were on station\" (one dialog, not a second nag)", globalThis.__confirms.length === 1 && /1 present · 2 were on station/.test(textOf(conf?.body)), textOf(conf?.body));
  const f = rpcs("finalize_training_session");
  ok("Finalize → finalize_training_session(id, length) — no direct update, no client last_iso stamp", f.length === 1 && f[0].args.p_session_id === "so" && f[0].args.p_duration_min === 45
    && !globalThis.__sb.writes.some((w) => (w.table === "training_sessions" || w.table === "training_plans") && w.op === "update"), JSON.stringify({ f, w: globalThis.__sb.writes }));
  unmount(); }
{ const { unmount } = await mount(["Department Admin"], false, "m-ada", [...SESS(), sess("sz", "Empty drill", { attendance: [] })]);
  await click(btn(row("sz"), /^Complete$/)); await tick(); await tick();
  await click(btn(row("sz"), /Finalize & lock attendance/)); await tick(); await tick();
  const z = globalThis.__confirms[0];
  ok("a zero roll still gets the ONE danger confirm (\"Finalize with an empty roll?\"), now noting the 2 on station", globalThis.__confirms.length === 1 && z?.danger === true
    && z.title === "Finalize with an empty roll?" && /0 present · 2 were on station during the drill/.test(String(z.body)), JSON.stringify(z));
  unmount(); }

// 5 — the no-length notice routes through Correct
{ const { unmount } = await mount(["Department Admin"], false, "m-ada", [...SESS(), sess("sn", "Pump drill", { d: dDone, done: true, durationMin: null, attendance: ["m-1"] })]);
  await click(btn(host, /1 finished drill with no length recorded/)); await tick();
  const sl = btn(host, /^Set length · Pump drill/);
  ok("the no-length notice lists the drill as \"Set length · …\" (an officer)", !!sl);
  await click(sl); await tick(); await tick();
  const panel = row("sn")?.querySelector('[data-testid="correct-panel"]');
  ok("…which opens Correct on that drill, length blank", !!panel && panel.querySelector('input[type="number"]').value === "");
  await setVal(panel.querySelector('input[type="number"]'), "60", win.HTMLInputElement);
  await setVal(panel.querySelector('[data-testid="correct-reason"]'), "Length was never recorded at close", win.HTMLTextAreaElement);
  await click(btn(panel, /Save correction/)); await tick(); await tick();
  const c = rpcs("correct_training_session");
  ok("…and saves as a logged correction: p_changes = { duration_min: 60 } only", c.length === 1 && JSON.stringify(c[0].args.p_changes) === '{"duration_min":60}' && c[0].args.p_session_id === "sn", JSON.stringify(c));
  unmount(); }

// 6 — the role matrix on the new controls
for (const [who, role, isTO, meId, want] of [
  ["Department Admin", ["Department Admin"], false, "m-ada", { correct: true, prefill: true, hist: true }],
  ["training officer (plain Member)", ["Member"], true, "m-tom", { correct: true, prefill: true, hist: false }],
  ["Officer, NOT a training officer", ["Officer"], false, "m-oli", { correct: false, prefill: false, hist: true }],
  ["Board Member", ["Board Member"], false, "m-bea", { correct: false, prefill: false, hist: true }],
  ["Project Admin", ["Project Admin"], false, "m-pat", { correct: false, prefill: false, hist: true }],
  ["Member", ["Member"], false, "m-mo", { correct: false, prefill: false, hist: false }],
]) {
  const { unmount } = await mount(role, isTO, meId);
  await editMode();
  const got = { correct: !!(row("sd") && btn(row("sd"), /^Correct…$/)), prefill: false, hist: !!(row("sd") && btn(row("sd"), /^Corrections/)) };
  const comp = row("so") && btn(row("so"), /^Complete$/);
  if (comp) { await click(comp); await tick(); await tick(); got.prefill = !!row("so").querySelector('[data-testid="on-station"]'); }
  const reads = rpcs("drill_window_presence").length;
  ok(`${who}: Correct… ${want.correct ? "yes" : "no"} · prefill ${want.prefill ? "yes" : "no"} · Corrections history ${want.hist ? "yes" : "no"}`,
    got.correct === want.correct && got.prefill === want.prefill && got.hist === want.hist && (want.prefill || reads === 0), JSON.stringify({ ...got, reads }));
  unmount();
}

// 7 — the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const BASE = "origin/main";
const appAt = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const base = appAt(BASE);
const changed = execSync(`git diff --name-only ${BASE} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("Slice 6-UI changes only src/App.jsx (runtime) vs origin/main", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
const added = [...rpcSet(src)].filter((n) => !rpcSet(base).has(n)).sort();
ok("the only new RPCs are the four 6-DB ones", JSON.stringify(added) === JSON.stringify(["correct_training_session", "drill_window_presence", "finalize_training_session", "reopen_training_session"]), JSON.stringify(added));
ok("the direct finalize / reopen updates and the client last_iso stamp are gone",
  !src.includes('update({ done: true, ...(dur == null ? {} : { duration_min: dur }) })') && !src.includes('.update({ done: false })') && !src.includes('update({ last_iso: iso })'));
ok("no station_presence write anywhere new", (src.match(/from\("station_presence"\)\.(insert|update|upsert|delete)/g) || []).length === (base.match(/from\("station_presence"\)\.(insert|update|upsert|delete)/g) || []).length);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
