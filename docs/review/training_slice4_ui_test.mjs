// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_slice4_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes) and checks Training Overhaul Slice 4 — one attach control per session, by type (rulings:
// claude/B4C_TrainingOverhaul_Slice4_Step0_ReviewRecord.md):
//   1. the predicate, row by row: everyone training -> "Attach plan" only; leadership / board / everyone + "This is a meeting"
//      -> "Attach agenda" only — never both, never neither (for a role that may attach at all)
//   2. the role matrix on each type — gates unchanged: the plan upload = canManage (DA / training officer); the agenda =
//      canManage || Board; an Officer who isn't a training officer gets neither; a Member never sees the Sessions list
//   3. the meeting chooser: "Pick a saved agenda" (the snapshot modal; DA / TO / Board) + "Upload a file" (the same
//      session_plans upload; DA / TO only, never Board) — the upload writes the same row the plan upload writes
//   4. existing attachments: still listed on both types ("Plan" / "Plans (N)" on a training, "Agenda" / "Agenda (N)" on a
//      meeting) and removable (Edit sessions -> Remove -> confirmDestructive -> session_plans delete) on both
//   5. the Library's drill-plan attach picker lists training sessions only (no leadership / board / flagged meeting)
//   6. the source: only src/App.jsx changed; no new RPC; verified unchanged; Notify crew held back
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
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ts4-")), "app.under-test.mjs");
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

// ---- fixtures: one session of each type, all this month and upcoming
const now = new Date(), Y = now.getFullYear(), M = now.getMonth();
const day = Math.min(28, now.getDate() + 1 > 28 ? now.getDate() : now.getDate() + 1);
const sess = (id, title, extra = {}) => ({ id, title, y: Y, m: M, d: day, done: false, plans: [], attendance: [], signinOpen: false, audience: "everyone", planId: null, ...extra });
const UPLOAD = (sid, n) => ({ id: `${sid}-pl${n}`, title: `${sid} file ${n}.pdf`, storage_path: `d-1/plans/${sid}-${n}.pdf`, ai_text: null, source: "upload", session_id: sid, kind: "file" });
const AGENDA = (sid) => ({ id: `${sid}-ag`, title: "October board agenda", storage_path: null, ai_text: "## Agenda\n- Call to order", source: "ai", session_id: sid, kind: "ai" });
const SESS = [
  sess("tr", "Hose drill", { plans: [UPLOAD("tr", 1)] }),                                   // everyone training, 1 existing plan
  sess("ld", "Officers' meeting", { audience: "leadership" }),
  sess("bd", "Board meeting", { audience: "board", plans: [AGENDA("bd"), UPLOAD("bd", 1)] }),  // board: an agenda + a file (as live)
  sess("em", "All-hands business meeting", { isMeeting: true }),                            // everyone + "This is a meeting"
];
const TYPE = { tr: "training", ld: "meeting", bd: "meeting", em: "meeting" };
const MEMBERS = [{ id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] },
  { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] }, { id: "m-bea", name: "Bea Board", status: "Active", access: ["Board Member"] }];
const DRILL = [{ id: "p1", title: "Hose deployment", category: null, duration_min: 60, audience: null, content: { summary: "s", objectives: [], run_of_show: [], materials: [], safety: [] },
  status: "approved", source: "ai", created_by: "m-ada", created_at: now.toISOString(), approved_by: "m-ada", approved_at: now.toISOString(), updated_by: "m-ada", updated_at: now.toISOString(), attached_sessions: 0 }];
globalThis.__destructive = [];
globalThis.__sb = {
  calls: [], writes: [], uploads: [], removed: [],
  table: () => ({ data: [], error: null }),
  answer: (n) => n === "my_department_id" ? { data: "d-1", error: null } : n === "dept_drill_plans" ? { data: DRILL.map((p) => ({ ...p })), error: null } : { data: null, error: null },
};
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const choose = (sel, v) => act(async () => { Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value").set.call(sel, String(v)); sel.dispatchEvent(new win.Event("change", { bubbles: true })); });
const attachFile = (input, name) => act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [{ name }] }); input.dispatchEvent(new win.Event("change", { bubbles: true })); });
async function mount(role, isTrainingOfficer, meId) {
  Object.assign(globalThis.__sb, { calls: [], writes: [], uploads: [], removed: [] }); globalThis.__destructive = [];
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: [], setPlan: () => {}, loadPlans: () => {}, sessions: SESS, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify: () => {}, dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const row = (id) => document.getElementById(`ts-${id}`);
const hasPlan = (id) => [...row(id).querySelectorAll("label")].some((l) => norm(l.textContent) === "Attach plan");
const agendaBtn = (id) => [...row(id).querySelectorAll("button")].find((b) => norm(b.textContent) === "Attach agenda");
const chooser = (id) => row(id).querySelector('[role="group"][aria-label="Attach agenda"]');
const viewerBtn = (id) => [...row(id).querySelectorAll("button")].find((b) => /^(Plan|Plans \(\d+\)|Agenda|Agenda \(\d+\))$/.test(norm(b.textContent)));

// 1 + 2 + 3 — the predicate table and the role matrix
for (const [who, role, isTO, meId, e] of [
  ["Department Admin", ["Department Admin"], false, "m-ada", { plan: true, agenda: true, upload: true }],
  ["training officer (plain Member)", ["Member"], true, "m-mo", { plan: true, agenda: true, upload: true }],
  ["Officer, NOT a training officer", ["Officer"], false, "m-oli", { plan: false, agenda: false, upload: false }],
  ["Board Member", ["Board Member"], false, "m-bea", { plan: false, agenda: true, upload: false }],
]) {
  const { host, unmount } = await mount(role, isTO, meId);
  const got = {};
  for (const id of Object.keys(TYPE)) {
    const t = TYPE[id], plan = hasPlan(id), agenda = !!agendaBtn(id);
    let upload = null, pick = null;
    if (agenda) { await click(agendaBtn(id)); await tick(); const g = chooser(id); pick = !!g && [...g.querySelectorAll("button")].some((b) => norm(b.textContent) === "Pick a saved agenda");
      upload = !!g && [...g.querySelectorAll("label")].some((l) => norm(l.textContent) === "Upload a file"); await click(agendaBtn(id)); await tick(); }
    got[id] = { plan, agenda, pick, upload };
    const wantPlan = t === "training" && e.plan, wantAgenda = t === "meeting" && e.agenda;
    ok(`${who} · ${id} (${t}): ${wantPlan ? "Attach plan" : wantAgenda ? "Attach agenda" : "no attach control"}${wantAgenda ? ` (Pick a saved agenda${e.upload ? " + Upload a file" : ", no upload"})` : ""}; never both`,
      plan === wantPlan && agenda === wantAgenda && !(plan && agenda) && (!wantAgenda || (pick === true && upload === e.upload)), JSON.stringify(got[id]));
  }
  unmount();
}
{ const { host, unmount } = await mount(["Member"], false, "m-mo");
  ok("Member: the member view — no Sessions list, no attach control of either kind", !row("tr") && !row("bd") && !norm(host.textContent).includes("Attach plan") && !norm(host.textContent).includes("Attach agenda"));
  unmount(); }

// the chooser's two actions (DA, board meeting)
{ const { host, unmount } = await mount(["Department Admin"], false, "m-ada");
  await click(agendaBtn("bd")); await tick();
  await click([...chooser("bd").querySelectorAll("button")].find((b) => norm(b.textContent) === "Pick a saved agenda")); await tick(); await tick();
  ok("Pick a saved agenda -> the snapshot modal (AttachAgendaModal) opens for the board meeting; the chooser closes", norm(host.textContent).includes("Attach agenda") && norm(host.textContent).includes("Board meeting") && !chooser("bd"));
  unmount(); }
{ const { host, unmount } = await mount(["Department Admin"], false, "m-ada");
  await click(agendaBtn("bd")); await tick();
  await attachFile([...chooser("bd").querySelectorAll("label")].find((l) => norm(l.textContent) === "Upload a file").querySelector('input[type="file"]'), "agenda-packet.pdf"); await tick(); await tick();
  const ins = globalThis.__sb.writes.find((w) => w.table === "session_plans" && w.op === "insert");
  ok("Upload a file (meeting) -> the same upload + session_plans row as \"Attach plan\": source upload, storage_path, the meeting's session_id",
    globalThis.__sb.uploads.length === 1 && ins && ins.args.session_id === "bd" && ins.args.source === "upload" && !!ins.args.storage_path && ins.args.title === "agenda-packet.pdf", JSON.stringify(ins?.args));
  unmount(); }
{ const { host, unmount } = await mount(["Department Admin"], false, "m-ada");
  await attachFile([...row("tr").querySelectorAll("label")].find((l) => norm(l.textContent) === "Attach plan").querySelector('input[type="file"]'), "drill-notes.pdf"); await tick(); await tick();
  const ins = globalThis.__sb.writes.find((w) => w.table === "session_plans" && w.op === "insert");
  ok("Attach plan (training) -> unchanged: upload + session_plans { source upload, storage_path, session_id }", ins && ins.args.session_id === "tr" && ins.args.source === "upload" && !!ins.args.storage_path);
  unmount(); }

// 4 existing attachments — listed + removable on both types
// the attachments panel opens one session at a time (openPlans), so each type is checked in its own mount; the detach is the
// "Remove" inside the attachment's own line (the session's delete button shares the title in Edit-sessions mode)
for (const [sid, label, titles, detachTitle] of [["bd", "Agenda (2)", ["October board agenda", "bd file 1.pdf"], "October board agenda"], ["tr", "Plan", ["tr file 1.pdf"], "tr file 1.pdf"]]) {
  const { host, unmount } = await mount(["Department Admin"], false, "m-ada");
  ok(`existing attachments on the ${TYPE[sid]} listed as "${label}"`, norm(viewerBtn(sid).textContent) === label, norm(viewerBtn(sid).textContent));
  await click(viewerBtn(sid)); await tick();
  ok(`…opening it shows every attachment (${titles.length}) of either kind`, titles.every((t) => norm(row(sid).textContent).includes(t)));
  await click([...host.querySelectorAll("button")].find((b) => norm(b.textContent).includes("Edit sessions"))); await tick();
  const line = [...row(sid).querySelectorAll("span")].find((sp) => norm(sp.textContent).startsWith(detachTitle))?.parentElement;
  const rm = line?.querySelector('button[title="Remove"]');
  await click(rm); await tick(); await tick();
  const del = globalThis.__sb.writes.find((w) => w.table === "session_plans" && w.op === "delete");
  ok(`…and removable on the ${TYPE[sid]}: Remove -> confirmDestructive -> session_plans delete`, !!rm && !!del && globalThis.__destructive.length === 1);
  unmount();
}

// 5 the Library picker: training sessions only
{ const { host, unmount } = await mount(["Department Admin"], false, "m-ada");
  await click([...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Training Plans")); await tick(); await tick();
  // the library card ("Hose deployment" + its "Approved" status) — not the "Hose deployment & streams" topic starter
  await click([...host.querySelectorAll("button")].find((b) => norm(b.textContent).startsWith("Hose deploymentApproved"))); await tick();
  await click([...host.querySelectorAll("button")].find((b) => norm(b.textContent) === "Attach to session")); await tick();
  const sel = [...host.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.textContent.startsWith("Choose a session")));
  const ids = sel ? [...sel.options].map((o) => o.value).filter(Boolean) : [];
  ok("Library drill-plan attach picker: training sessions only — no leadership / board / flagged meeting", JSON.stringify(ids) === '["tr"]', JSON.stringify(ids));
  unmount(); }

// 6 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime)", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
ok("no new RPC", [...rpcSet(src)].every((n) => rpcSet(main).has(n)), JSON.stringify([...rpcSet(src)].filter((n) => !rpcSet(main).has(n))));
ok("the type decision is the existing Minutes helper isMeeting(s); the agenda gate is still canManage || isBoard(role)",
  src.includes("const meetingRow = isMeeting(s);") && src.includes("{meetingRow && (canManage || isBoard(role)) && (<>") && src.includes("{!meetingRow && canManage && ("));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(main), `${tok(src)} vs ${tok(main)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
