// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_slice5_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes) and checks Training Overhaul Slice 5 — build a session from the Library + Start blank
// (rulings: round-trip flow; a series takes the plan on its FIRST occurrence only; no "Manual" tag):
//   1. "Schedule with this plan" flips to the Schedule and opens its own form pre-filled — title, length, category by name
//      (case-insensitive; no match -> One-off), day = today, audience everyone — with a "With plan: <title> ✕" chip
//   2. a single schedule: the same training_sessions insert (+ .select("id")), then attach_drill_plan_to_session on the new
//      id, a confirmation toast, and back to the Library
//   3. a series: one bulk insert; the plan is attached to the earliest-dated new session ONLY
//   4. a failed attach keeps the session (no delete) and says "attach it from the Library"; ✕ on the chip = a plain schedule
//   5. Start blank -> the plan editor, empty -> set_drill_plan(p_id null, p_source 'manual') -> a draft, no "Manual" tag
//   6. "Describe your goals (focus & notes)" sits right under Topic
//   7. the role matrix: Start blank / Schedule with this plan for DA + training officer only
//   8. the source (pinned to its release, 5546b7d): only src/App.jsx changed; no new RPC; verified unchanged; Notify crew held back
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
      b.then = (res, rej) => Promise.resolve(b._w && b._w.op === "insert" ? st.inserted(table, b._w.args) : st.table(table)).then(res, rej);
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
const out = join(mkdtempSync(join(tmpdir(), "b4c-ts5-")), "app.under-test.mjs");
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
const now = new Date(), Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
const pad = (n) => String(n).padStart(2, "0");
const TODAY_ISO = `${Y}-${pad(M + 1)}-${pad(D)}`;
const CATS = [{ id: "c1", name: "Hose Ops", cadence: "Monthly", color: "#C0392B", starts_on: null }, { id: "c2", name: "EMS", cadence: "Weekly", color: "#2E86C1", starts_on: null }];
const MEMBERS = [{ id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] },
  { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] }, { id: "m-bea", name: "Bea Board", status: "Active", access: ["Board Member"] },
  { id: "m-pat", name: "Pat PA", status: "Active", access: ["Project Admin"] }];
const mkPlan = (id, title, category, duration_min, extra = {}) => ({ id, title, category, duration_min, audience: null, content: { summary: "s", objectives: [], run_of_show: [], materials: [], safety: [] },
  status: "approved", source: "ai", created_by: "m-ada", created_at: now.toISOString(), approved_by: "m-ada", approved_at: now.toISOString(), updated_by: "m-ada", updated_at: now.toISOString(), attached_sessions: 0, ...extra });
let DRILL;
globalThis.__sb = {
  table: () => ({ data: [], error: null }),
  // the fake's insert(...).select(...): echo the rows with fresh ids, in REVERSE order (so "first" must come from the date)
  inserted: (table, args) => {
    const st = globalThis.__sb, rows = (Array.isArray(args) ? args : [args]).map((r) => ({ id: `s-new-${++st.seq}`, ...r }));
    st.made.push(...rows); return { data: [...rows].reverse(), error: null };
  },
  answer: (n, args) => {
    if (n === "my_department_id") return { data: "d-1", error: null };
    if (n === "dept_drill_plans") return { data: DRILL.map((p) => ({ ...p })), error: null };
    if (n === "attach_drill_plan_to_session") return globalThis.__sb.attachFails ? { data: null, error: { message: "permission denied" } } : { data: { id: "sp-1", session_id: args.p_session_id }, error: null };
    if (n === "set_drill_plan") { const p = mkPlan("p-new", args.p_title, args.p_category, args.p_duration_min, { status: "draft", source: args.p_source, approved_by: null, approved_at: null, content: args.p_content }); DRILL.push(p); return { data: { id: p.id }, error: null }; }
    return { data: null, error: null };
  },
};
const reset = () => {
  DRILL = [mkPlan("p1", "Hose deployment", "hose ops", 90), mkPlan("p2", "Mystery drill", "Nonexistent category", null)];
  Object.assign(globalThis.__sb, { calls: [], writes: [], uploads: [], removed: [], made: [], seq: 0, attachFails: false });
  globalThis.__destructive = []; globalThis.__notes = [];
};
reset();
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const type = (el, v) => act(async () => { Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, String(v)); el.dispatchEvent(new win.Event("input", { bubbles: true })); });
let host;
async function mount(role, isTrainingOfficer, meId) {
  reset();
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: CATS, setPlan: () => {}, loadPlans: () => {}, sessions: [], setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify: (n) => globalThis.__notes.push(n), dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { unmount: () => act(() => r.unmount()) };
}
const views = () => [...host.children];
const onPlans = () => views().length > 1 && views()[1].style.display !== "none" && views()[0].style.display === "none";
const onSchedule = () => views()[0].style.display !== "none";
const btn = (root, re) => [...root.querySelectorAll("button")].find((b) => (re instanceof RegExp ? re.test(norm(b.textContent)) : norm(b.textContent) === re));
async function toPlans() { await click([...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Training Plans")); await tick(); await tick(); }
const plansView = () => views()[1];
const card = (title) => [...plansView().querySelectorAll("button")].find((b) => norm(b.textContent).startsWith(title) && /(Not attached|Attached to)/.test(b.textContent));
async function pick(title) { await click(card(title)); await tick(); }
const fieldIn = (root, label) => [...root.querySelectorAll("label")].find((l) => norm(l.querySelector("span")?.textContent) === label);
const form = () => { let n = views()[0].querySelector('input[placeholder="Defaults to the training name"]'); while (n && !(n.querySelector && n.querySelector('input[type="time"]') && n.querySelector("button"))) n = n.parentElement; return n; };
const chip = () => views()[0].querySelector('[data-testid="with-plan-chip"]');
const attaches = () => globalThis.__sb.calls.filter((c) => c.n === "attach_drill_plan_to_session");
const sessInserts = () => globalThis.__sb.writes.filter((w) => w.table === "training_sessions" && w.op === "insert");

// 1 + 2 — prefill, chip, single schedule -> attach -> back to the Library
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  await toPlans(); await pick("Hose deployment");
  const sw = btn(plansView(), "Schedule with this plan");
  ok("DA: a selected Library plan shows \"Schedule with this plan\"", !!sw);
  await click(sw); await tick(); await tick();
  const f = form();
  ok("it flips to the Schedule view and opens the schedule form", onSchedule() && !!f && !!chip());
  ok("prefill: title = the plan's title", f.querySelector('input[placeholder="Defaults to the training name"]').value === "Hose deployment");
  ok("prefill: length = the plan's duration_min", f.querySelector('input[placeholder="e.g. 180"]').value === "90");
  ok("prefill: category matched by name, case-insensitive (\"hose ops\" -> Hose Ops)", fieldIn(f, "Training").querySelector("select").value === "c1", fieldIn(f, "Training").querySelector("select").value);
  ok("prefill: day = today, this month", fieldIn(f, "Day").querySelector("select").value === String(D) && !!btn(f, /^Add to /));
  ok("prefill: audience stays Everyone; repeat off", !!btn(f, "One session") && !btn(f, "Recurring ✓"));
  ok("the chip reads \"With plan: Hose deployment ✕\"", !!chip() && norm(chip().textContent).startsWith("With plan: Hose deployment") && norm(chip().querySelector("button")?.textContent) === "✕", norm(chip()?.textContent));
  await click(btn(f, /^Add to /)); await tick(); await tick();
  const ins = sessInserts();
  ok("Add -> ONE training_sessions insert, as before (today, category c1, title, length, everyone)", ins.length === 1 && !Array.isArray(ins[0].args) && ins[0].args.date === TODAY_ISO && ins[0].args.plan_id === "c1" && ins[0].args.title === "Hose deployment" && ins[0].args.duration_min === 90 && ins[0].args.audience === "everyone", JSON.stringify(ins[0]?.args));
  const at = attaches();
  ok("then attach_drill_plan_to_session(plan p1, the NEW session's id)", at.length === 1 && at[0].args.p_plan_id === "p1" && at[0].args.p_session_id === globalThis.__sb.made[0]?.id, JSON.stringify(at));
  ok("a confirmation toast (success)", globalThis.__notes.some((n) => n.kind === "success" && /Hose deployment/.test(n.text)), JSON.stringify(globalThis.__notes));
  ok("round-trip: back on the Library", onPlans());
  unmount(); }

// no category match -> One-off; chip ✕ -> a plain schedule, no attach, stays on the Schedule
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  await toPlans(); await pick("Mystery drill"); await click(btn(plansView(), "Schedule with this plan")); await tick(); await tick();
  const f = form();
  ok("no category match -> One-off; no duration -> length blank", fieldIn(f, "Training").querySelector("select").value === "0" && f.querySelector('input[placeholder="e.g. 180"]').value === "");
  await click(chip().querySelector("button")); await tick();
  ok("✕ drops the chip", !chip());
  await click(btn(form(), /^Add to /)); await tick(); await tick();
  ok("✕ then Add -> the session is inserted, no attach call, no round-trip", sessInserts().length === 1 && attaches().length === 0 && onSchedule());
  unmount(); }

// 3 — a series: the plan on the FIRST occurrence only
{ const { unmount } = await mount(["Member"], true, "m-mo");   // a training officer
  await toPlans(); await pick("Hose deployment"); await click(btn(plansView(), "Schedule with this plan")); await tick(); await tick();
  await click(btn(form(), "One session")); await tick();
  ok("series: the chip says the plan goes on the first session", /first session of the series/.test(norm(chip()?.textContent)));
  await type(fieldIn(form(), "Occurrences").querySelector("input"), "4"); await tick();
  await click(btn(form(), /^Schedule 4 sessions$/)); await tick(); await tick();
  const ins = sessInserts(), rows = Array.isArray(ins[0]?.args) ? ins[0].args : [];
  ok("series: ONE bulk insert of 4 rows, one series_id", ins.length === 1 && rows.length === 4 && new Set(rows.map((r) => r.series_id)).size === 1, JSON.stringify(rows.map((r) => r.date)));
  const earliest = [...globalThis.__sb.made].sort((a, b) => a.date.localeCompare(b.date))[0];
  const at = attaches();
  ok("series: exactly ONE attach — on the earliest-dated new session (the insert returned them reversed)", at.length === 1 && at[0].args.p_session_id === earliest?.id && at[0].args.p_plan_id === "p1", JSON.stringify({ at, earliest: earliest?.id }));
  ok("series: one toast, success, saying the plan is on the first session", globalThis.__notes.filter((n) => n.kind === "success").length === 1 && /first session/.test(globalThis.__notes.find((n) => n.kind === "success")?.text || ""), JSON.stringify(globalThis.__notes));
  ok("series: round-trip back to the Library", onPlans());
  unmount(); }

// 4 — a failed attach keeps the session
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  await toPlans(); await pick("Hose deployment"); await click(btn(plansView(), "Schedule with this plan")); await tick(); await tick();
  globalThis.__sb.attachFails = true;
  await click(btn(form(), /^Add to /)); await tick(); await tick();
  ok("failed attach: the session was inserted and nothing deletes it", sessInserts().length === 1 && attaches().length === 1 && !globalThis.__sb.writes.some((w) => w.op === "delete"));
  const e = globalThis.__notes.find((n) => n.kind === "error");
  ok("failed attach: the toast says \"Scheduled; the plan couldn't be attached — attach it from the Library\"", !!e && /Scheduled; the plan couldn't be attached — attach it from the Library/.test(e.text) && !globalThis.__notes.some((n) => n.kind === "success"), JSON.stringify(globalThis.__notes));
  ok("failed attach: still back on the Library (where it can be attached)", onPlans());
  unmount(); }

// 5 + 6 — Start blank -> a manual draft; Describe your goals
{ const { unmount } = await mount(["Department Admin"], false, "m-ada");
  await toPlans();
  const pv = plansView();
  const labels = [...pv.querySelectorAll("label > span")].map((x) => norm(x.textContent));
  const ti = labels.indexOf("Topic / drill");
  ok("\"Describe your goals (focus & notes)\" sits right under Topic; the old label is gone", ti >= 0 && labels[ti + 1] === "Describe your goals (focus & notes)" && !labels.includes("Focus & notes (optional)"), JSON.stringify(labels.slice(ti, ti + 3)));
  const sb = btn(pv, "Start blank");
  ok("DA: \"Start blank\" beside Draft with AI", !!sb && !!btn(pv, "Draft with AI"));
  await click(sb); await tick();
  const box = pv.querySelector("#tp-start-blank");
  const ins = box ? [...box.querySelectorAll("input")] : [];
  ok("Start blank opens the plan editor, empty", !!box && ins.length >= 1 && ins.every((i) => i.value === "") && [...box.querySelectorAll("textarea")].every((t) => t.value === ""));
  await type(ins[0], "Ladder throws"); await tick();
  await click(btn(box, "Save draft")); await tick(); await tick();
  const c = globalThis.__sb.calls.find((x) => x.n === "set_drill_plan");
  ok("Save -> set_drill_plan(p_id null, p_source 'manual') — the existing create path", !!c && c.args.p_id === null && c.args.p_source === "manual" && c.args.p_title === "Ladder throws", JSON.stringify(c?.args));
  await tick();
  ok("the new plan opens selected, a draft", !pv.querySelector("#tp-start-blank") && /Ladder throws/.test(norm(pv.textContent)) && !!btn(pv, "Approve plan") && !!btn(pv, "Schedule with this plan"));
  ok("no \"Manual\" tag anywhere", !/\bManual\b/.test(pv.textContent));
  unmount(); }

// 7 — the role matrix on the new entries
for (const [who, role, isTO, meId, want] of [
  ["Department Admin", ["Department Admin"], false, "m-ada", true],
  ["training officer (plain Member)", ["Member"], true, "m-mo", true],
  ["Officer, NOT a training officer", ["Officer"], false, "m-oli", false],
  ["Board Member", ["Board Member"], false, "m-bea", false],
  ["Project Admin", ["Project Admin"], false, "m-pat", false],
  ["Member", ["Member"], false, "m-mo", false],
]) {
  const { unmount } = await mount(role, isTO, meId);
  const tgl = [...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent) === "Training Plans");
  let blank = false, sched = false;
  if (tgl) { await toPlans(); blank = !!btn(plansView(), "Start blank"); const c = card("Hose deployment"); if (c) { await click(c); await tick(); } sched = !!btn(plansView(), "Schedule with this plan"); }
  ok(`${who}: Start blank ${want ? "+" : "and"} Schedule with this plan ${want ? "shown" : "hidden"}`, blank === want && sched === want, JSON.stringify({ blank, sched, toggle: !!tgl }));
  unmount();
}

// 8 — the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
// Structural fences are PINNED to Slice 5's own release (5546b7d, a --no-ff merge whose first parent 38ad62a is the main it
// landed on): "vs origin/main" holds only until the next slice merges. Historical = the release vs its parent.
const REL = "5546b7d";
const appAt = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const rel = appAt(REL), base = appAt(`${REL}^1`);
const changed = execSync(`git diff --name-only ${REL}^1 ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("Slice 5 (5546b7d) changed only src/App.jsx (runtime) vs its parent", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
// an RPC name counts as existing whether called directly (supabase.rpc("x") or through TrainingPlans' act("kind", "x", …)
const rpcSet = (s) => new Set([...(s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)), ...[...s.matchAll(/\bact\("[a-z]+", "([a-z_]+)"/g)].map((m) => m[1])]);
ok("Slice 5 (5546b7d) added no RPC vs its parent", [...rpcSet(rel)].every((n) => rpcSet(base).has(n)), JSON.stringify([...rpcSet(rel)].filter((n) => !rpcSet(base).has(n))));
ok("the writes are the existing paths: the same inserts + .select, attach_drill_plan_to_session, set_drill_plan 'manual'",
  src.includes('}).select("id");') && src.includes('.insert(rows).select("id, date");   // ONE bulk insert') && src.includes('supabase.rpc("attach_drill_plan_to_session", { p_plan_id: wp.id, p_session_id: sessionId })') && src.includes('p_content: v.content, p_source: "manual" }'));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged by Slice 5 (5546b7d) vs its parent", tok(rel) === tok(base), `${tok(rel)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
