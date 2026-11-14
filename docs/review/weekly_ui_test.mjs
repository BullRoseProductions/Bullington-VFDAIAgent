// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/weekly_ui_test.mjs ; echo "exit $?"
// No network, no DB. Weekly Training Content slice 5 — Weekly UI + shared prompt (docs/design/training_content_step0.md §5.1,
// §5.3, §5.4; gate PASS @2a0768c, rulings @4cfe29f; the DB slice is live: "Weekly DB: gate PASS @25979b3", applied 2026-11-14).
// Bundles the REAL src/App.jsx (fakes for supabaseClient, ConfirmDestructive, NoirDialogs, apiBase) and checks:
//   1. shared/drill-prompt.js: DRILL_PLAN_SYSTEM, strList, oneLine, stepToRun and drillPlanToContent are BYTE-IDENTICAL to
//      their definitions in BASE's src/App.jsx; App.jsx no longer defines them (imports them); the inline AIDrillPlanner
//      copy still equals DRILL_PLAN_SYSTEM; parseDrillPlanReply fails closed (fences ok, embedded object ok; array /
//      string / null / garbage → null) and draft() uses it
//   2. the labels: an ai_weekly plan reads "B4C's weekly AI" everywhere (pill, card line, Plans by category, the detail's
//      head, pill and meta) and NEVER a member's name, even if created_by were set; ai / library / manual strings are the
//      exact strings BASE showed
//   3. the switch: a Department Admin sees the "Weekly AI drill draft" card (Off badge) in Settings; turning on asks first
//      (what is sent, approval stated) then calls set_weekly_drill_draft_enabled(true) only; a cancelled confirm writes
//      nothing; turning off calls it with false, no confirm; an error keeps the state and says so; a Project Admin and a
//      plain member never see the card; the screen says the weekly run hasn't started (WEEKLY_DRAFT_RUN_LIVE false)
//   4. the department read selects weekly_drill_draft_enabled
//   5. fences: only src/App.jsx + shared/drill-prompt.js + this test + the build order changed vs BASE; no api/, sql/,
//      vercel.json, native; verified 132/32/14; Notify held; api/_cron.js untouched
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
const BASE = "013eeb8";                  // the Weekly DB record (main 6742304 + the S3 pin + the DB slice's files)
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
      const b = { _t: table, _cols: null };
      b.select = (c) => { b._cols = c; return b; };
      for (const m of ["eq", "neq", "in", "is", "not", "order", "limit", "gte", "lte", "maybeSingle", "single"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { st.writes.push({ table, op: m, args }); return b; };
      b.then = (res, rej) => { st.reads.push({ table, cols: b._cols }); return Promise.resolve({ data: [], error: null }).then(res, rej); };
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
const out = join(mkdtempSync(join(tmpdir(), "b4c-wkui-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { TrainingPlans, SettingsHub, DRILL_PLAN_SYSTEM };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";`, loader: "jsx" }));
  } }],
});
const { TrainingPlans, SettingsHub, DRILL_PLAN_SYSTEM: APP_SYS, createRoot, act, React } = await import(pathToFileURL(out).href);
const SH = await import(pathToFileURL(join(root, "shared/drill-prompt.js")).href);

// ---------------------------------------------------------------- 1. the shared prompt
const baseApp = show(BASE, "src/App.jsx"), curApp = show(REV, "src/App.jsx"), sharedSrc = show(REV, "shared/drill-prompt.js");
const grab = (src, re) => (src.match(re) || [null])[0];
const DEFS = {
  DRILL_PLAN_SYSTEM: /const DRILL_PLAN_SYSTEM = "(?:[^"\\]|\\.)*";/,
  strList: /const strList = \(a\) => [^\n]*;/,
  oneLine: /const oneLine = \(x\) => [^\n]*;/,
  stepToRun: /function stepToRun\(st\) \{[\s\S]*?\n\}/,
  drillPlanToContent: /function drillPlanToContent\(plan\) \{[\s\S]*?\n\}/,
};
for (const [name, re] of Object.entries(DEFS)) {
  const b = grab(baseApp, re), s = grab(sharedSrc, re);
  ok(`1. ${name}: shared/drill-prompt.js is byte-identical to BASE's src/App.jsx`, !!b && b === s, b ? `${b.length} chars` : "missing in BASE");
  ok(`1. ${name}: no longer defined in src/App.jsx (imported)`, !grab(curApp, new RegExp("^" + re.source, "m")));
}
ok("1. App.jsx imports all six from ../shared/drill-prompt.js", /import \{ DRILL_PLAN_SYSTEM, strList, oneLine, stepToRun, drillPlanToContent, parseDrillPlanReply \} from "\.\.\/shared\/drill-prompt\.js";/.test(curApp));
ok("1. the bundled App's DRILL_PLAN_SYSTEM is the shared one", APP_SYS === SH.DRILL_PLAN_SYSTEM && SH.DRILL_PLAN_SYSTEM.length > 900);
{ const m = curApp.match(/function AIDrillPlanner[\s\S]*?\n    const sys = ("(?:[^"\\]|\\.)*");/);
  ok("1. the inline AIDrillPlanner copy still equals DRILL_PLAN_SYSTEM (ai_drafting_sliceB_test's pin holds)", !!m && JSON.parse(m[1]) === SH.DRILL_PLAN_SYSTEM); }
{ const P = SH.parseDrillPlanReply;
  const good = '{"summary":"s","steps":[{"title":"A","minutes":10,"actions":["x"]}]}';
  ok("1. parseDrillPlanReply: plain / fenced / embedded objects parse", P(good)?.summary === "s" && P("```json\n" + good + "\n```")?.summary === "s" && P("Here you go: " + good + " thanks")?.summary === "s");
  ok("1. parseDrillPlanReply fails closed: array / string / null / number / garbage / bad embedded JSON → null",
    [P("[1,2]"), P('"text"'), P("null"), P("42"), P("not json at all"), P("{ broken: }"), P(""), P(undefined)].every((x) => x === null)); }
ok("1. draft() parses with parseDrillPlanReply (no inline JSON.parse of the reply left)", /plan = parseDrillPlanReply\(await callClaude\(DRILL_PLAN_SYSTEM, user\)\);/.test(curApp) && !/const t = \(await callClaude\(DRILL_PLAN_SYSTEM, user\)\)/.test(curApp));

// ---------------------------------------------------------------- render helpers
let PLANS = [], WEEKLY_RPC = null;
globalThis.__sb = { calls: [], writes: [], reads: [], answer: (n, a) => {
  if (n === "dept_drill_plans") return { data: PLANS, error: null };
  if (n === "set_weekly_drill_draft_enabled") return WEEKLY_RPC || { data: a.p_enabled, error: null };
  return { data: null, error: null };
} };
const reset = () => { Object.assign(globalThis.__sb, { calls: [], writes: [], reads: [] }); globalThis.__confirms = []; globalThis.__confirmAnswer = true; globalThis.__notes = []; WEEKLY_RPC = null; };
const notify = (n) => globalThis.__notes.push(n);
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = async (n) => { await act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick(); await tick(); };
const btn = (scope, re) => [...scope.querySelectorAll("button")].find((b) => re.test(norm(b.textContent)));
let host, rootR;
async function render(el) {
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rootR = createRoot(host);
  await act(async () => { rootR.render(el); }); await tick(); await tick(); await tick();
}
const MEMBERS = [{ id: "m1", name: "Pat Officer" }, { id: "m2", name: "Sam Chief" }];
const plan = (id, source, extra = {}) => ({ id, title: `Plan ${id}`, category: "Search", duration_min: 60, audience: null, status: "draft", source,
  content: { summary: "s", objectives: ["o"], run_of_show: [], materials: [], safety: [] }, created_by: "m1", created_at: "2026-11-16T12:00:00Z",
  approved_by: null, approved_at: null, updated_by: null, updated_at: "2026-11-16T12:00:00Z", attached_sessions: 0, ...extra });
const tp = () => React.createElement(TrainingPlans, { S, role: ["Department Admin"], canManageTraining: true, sessions: [], loadSessions: () => {}, members: MEMBERS, notify, dept: { name: "Test Dept" }, categories: [{ id: "c1", name: "Search" }], viewToggle: null, loadPlans: () => {}, onScheduleWithPlan: () => {}, reloadNonce: 0 });

// ---------------------------------------------------------------- 2. labels
// the weekly draft carries created_by "m1" here ON PURPOSE: the label must never show a name even if one were set
reset(); PLANS = [plan("w1", "ai_weekly"), plan("a1", "ai"), plan("l1", "library"), plan("n1", "manual")];
await render(tp());
{ const card = (id) => [...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent).includes(`Plan ${id}`));
  const w = norm(card("w1")?.textContent);
  ok("2. ai_weekly card: pill 'Draft · B4C weekly AI', line 'Drafted by B4C's weekly AI', no member name", w.includes("Draft · B4C weekly AI") && w.includes("Drafted by B4C's weekly AI") && !/Pat Officer|Sam Chief/.test(w), w);
  ok("2. ai / library / manual cards: BASE's exact strings", norm(card("a1")?.textContent).includes("Draft · needs review") && norm(card("a1")?.textContent).includes("AI draft · Pat Officer")
    && norm(card("l1")?.textContent).includes("Draft · from the library") && norm(card("l1")?.textContent).includes("Draft · Pat Officer")
    && norm(card("n1")?.textContent).includes("Draft · Pat Officer") && !/weekly/i.test(norm(card("n1")?.textContent)));
  const byCat = norm(host.querySelector('[data-plan-category="Search"]')?.textContent);
  ok("2. Plans by category: the weekly draft reads 'Weekly AI draft', the others 'Draft'", /Plan w1\s*Weekly AI draft/.test(byCat) && /Plan a1\s*Draft/.test(byCat), byCat);
  if (card("w1")?.getAttribute("aria-pressed") !== "true") await click(card("w1"));   // the first draft opens by default; a click on an open card collapses it
  const detail = norm(host.textContent);
  ok("2. ai_weekly detail: head, pill and meta all say B4C's weekly AI; no name", detail.includes("Drafted by B4C's weekly AI · needs an officer's approval") && detail.includes("Draft · weekly AI")
    && detail.includes("drafted by B4C's weekly AI Nov") && !/drafted by B4C's weekly AI by /.test(detail));
  await click(card("a1"));
  const d2 = norm(host.textContent);
  ok("2. ai detail: BASE's strings (head, pill 'Draft · AI', 'drafted with AI by Pat Officer')", d2.includes("AI-drafted · needs an officer's approval") && d2.includes("Draft · AI") && d2.includes("drafted with AI by Pat Officer")); }
await act(async () => rootR.unmount());

// ---------------------------------------------------------------- 3. the switch
const hub = (role, dept) => React.createElement(SettingsHub, { S, role, brand: {}, setBrand: () => {}, setDept: (f) => { globalThis.__dept = typeof f === "function" ? f(globalThis.__dept) : f; }, dept, requests: [], setRequests: () => {}, members: [], setMembers: () => {}, meId: "m1", notify });
const cardOf = () => [...host.querySelectorAll("div")].find((d) => d.onclick !== null && /^Weekly AI drill draft/.test(norm(d.textContent)));
const hasCard = () => /Weekly AI drill draft/.test(norm(host.textContent));
try { localStorage.clear(); } catch { /* none */ }
for (const [label, role] of [["a Project Admin", ["Project Admin"]], ["a plain member", ["Member"]], ["an Officer", ["Officer"]]]) {
  reset(); await render(hub(role, { name: "T", weekly_drill_draft_enabled: false }));
  ok(`3. ${label} never sees the Weekly AI drill draft card`, !hasCard());
  await act(async () => rootR.unmount());
}
reset(); globalThis.__dept = { name: "T", weekly_drill_draft_enabled: false };
await render(hub(["Department Admin"], globalThis.__dept));
{ const c = (() => { let e = [...host.querySelectorAll("span")].find((x) => norm(x.textContent) === "Weekly AI drill draft"); while (e && !/Open$/.test(norm(e.textContent))) e = e.parentElement; return e; })();
  ok("3. a Department Admin sees the card, with the Off badge and the Step 0 sub-line", hasCard() && /Weekly AI drill draft\s*Off/.test(norm(c?.textContent)) && /Once a week, B4C drafts one seasonal drill plan for your officers to review\. Nothing is used until an officer approves it\./.test(norm(c?.textContent)));
  await click(c);
  const sw = host.querySelector("[data-weekly-drill-switch]");
  ok("3. the card opens the switch screen (OFF), with what it sends and the 'not started yet' note", !!sw && /OFF/.test(norm(sw.textContent)) && /Never names, emails, notes, certs, hours, attendance or addresses\./.test(norm(host.textContent)) && !!host.querySelector("[data-weekly-not-live]"));
  globalThis.__confirmAnswer = false;
  await click(btn(sw, /^Turn on$/));
  ok("3. turning on asks first (sent data + approval stated) — cancelled: nothing written", globalThis.__confirms.length === 1 && /Drafted by B4C's weekly AI/.test(globalThis.__confirms[0].body) && /never used until an officer approves it/.test(globalThis.__confirms[0].body)
    && /Never names/.test(globalThis.__confirms[0].body) && !globalThis.__sb.calls.some((c) => c.n === "set_weekly_drill_draft_enabled"));
  globalThis.__confirmAnswer = true;
  await click(btn(sw, /^Turn on$/));
  const calls = globalThis.__sb.calls.filter((c) => c.n === "set_weekly_drill_draft_enabled");
  ok("3. confirmed → set_weekly_drill_draft_enabled({ p_enabled: true }) only; the department reads on", calls.length === 1 && JSON.stringify(calls[0].args) === '{"p_enabled":true}' && globalThis.__dept.weekly_drill_draft_enabled === true && globalThis.__sb.writes.length === 0); }
await act(async () => rootR.unmount());
reset(); globalThis.__dept = { name: "T", weekly_drill_draft_enabled: true };
try { localStorage.clear(); } catch { /* none */ }
await render(hub(["Department Admin"], globalThis.__dept));
{ const c = (() => { let e = [...host.querySelectorAll("span")].find((x) => norm(x.textContent) === "Weekly AI drill draft"); while (e && !/Open$/.test(norm(e.textContent))) e = e.parentElement; return e; })();
  ok("3. when on, the card has no Off badge", !!c && !/Weekly AI drill draft\s*Off/.test(norm(c.textContent)));
  await click(c);
  const sw = host.querySelector("[data-weekly-drill-switch]");
  WEEKLY_RPC = { data: null, error: { message: "Only a Department Admin can turn the weekly AI drill draft on or off." } };
  await click(btn(sw, /^Turn off$/));
  ok("3. a refused write: no confirm for off, the state stays on, the server's message is shown", globalThis.__confirms.length === 0 && globalThis.__dept.weekly_drill_draft_enabled === true
    && globalThis.__notes.some((n) => n.kind === "error" && /Only a Department Admin/.test(n.text)));
  WEEKLY_RPC = null;
  await click(btn(sw, /^Turn off$/));
  const calls = globalThis.__sb.calls.filter((c) => c.n === "set_weekly_drill_draft_enabled");
  ok("3. turning off → set_weekly_drill_draft_enabled({ p_enabled: false }), no confirm; off", JSON.stringify(calls[calls.length - 1]?.args) === '{"p_enabled":false}' && globalThis.__confirms.length === 0 && globalThis.__dept.weekly_drill_draft_enabled === false); }
await act(async () => rootR.unmount());
ok("3. the route is gated like the card (isDeptAdminOnly) and WEEKLY_DRAFT_RUN_LIVE is false until the cron ships", /if \(view === "weeklydrill" && isDeptAdminOnly\)/.test(curApp) && /const WEEKLY_DRAFT_RUN_LIVE = false;/.test(curApp));

// ---------------------------------------------------------------- 4 + 5. the source
ok("4. the department read selects weekly_drill_draft_enabled", /probation_enabled, weekly_drill_draft_enabled"\)\.eq\("id", id\)\.single\(\)/.test(curApp));
ok("4. the only weekly write is the RPC — no direct departments / drill_plans write of the new columns", (curApp.match(/set_weekly_drill_draft_enabled/g) || []).length >= 1 && !/weekly_drill_draft_enabled:\s*(true|false|!)/.test(curApp.replace(/setDept\?\.\(\(d\) => \(\{ \.\.\.\(d \|\| \{\}\), weekly_drill_draft_enabled: !!data \}\)\)/g, "")) && !/weekly_key/.test(curApp));
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["docs/review/weekly_ui_BUILD_ORDER.md", "docs/review/weekly_ui_test.mjs", "shared/drill-prompt.js", "src/App.jsx"];
ok("5. fence: only src/App.jsx + shared/drill-prompt.js + this test + the build order changed vs BASE", files.every((f) => allowed.includes(f)) && files.includes("src/App.jsx") && files.includes("shared/drill-prompt.js"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("5. fence: no api/, sql/, vercel.json, index.html, native, package changes", ["api", "sql", "vercel.json", "index.html", "ios", "android", "package.json", "package-lock.json"].every(untouched));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("5. verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("5. Notify held: api/notify-session.js absent; api/_cron.js untouched", !existsSync(join(root, "api/notify-session.js")) && untouched("api/_cron.js"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
