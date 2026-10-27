// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/ws4c_members_test.mjs
// No network, no DB. WS-4c "numbers agree" — the headcount (B-1..B-4) + onboarding (E-1/E-2). claude/B4C_WS4c_Draft.md.
//   1. shared/members.js: isCountedMember = listed ∧ Active/Probationary ∧ not separated (Inactive out, Probationary in,
//      PA / owner / test / demo out, separated out); a MASKED status / separation (NULL, non-leaders) never excludes;
//      headcount() puts Inactive alongside, never inside
//   2. HELPER PINS — the one copy of the id list + the predicates live in shared/members.js; App.jsx and api/digest.js
//      import them and keep no copy; every listed count site reads them: dashboard Members tile, Roster chips, BoardStats
//      hero, the roster breakdown bar, the Attendance Report (via deptAttendance), the email's attendance %
//   3. RosterMembers (rendered): the Members chip = the headcount (a separated Active member, an Inactive member and a
//      Project Admin are out; "+ 1 inactive"); the list still shows the separated member (listed ≠ counted)
//   4. deptAttendance (the App's wrapper): a separated Active member is out of the rows and the average (C-1 via B-4)
//   5. E-1 — OnboardingCardPlain (rendered): open items = the server's computed status, not the raw ticks (a ticked auto
//      item the server says is unsatisfied stays OPEN); E-2 — "Awaiting sign-off" = the signoff queue's rows (pins)
//   6. invariants: verified literal counts 132 · 32 · 14; no station_presence line added; Notify held; runtime files
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));

// ---------------------------------------------------------------- 1. shared/members.js
const M = await import(pathToFileURL(join(root, "shared/members.js")).href);
const P = (id, status, extra = {}) => ({ id, name: id, status, access: ["Member"], ...extra });
const OWNER = "0ad3dc98-5af3-4ae5-8c04-f7902e0cf7c4", TEST = "02c4a728-9d58-4e58-89b4-4f277aad2272", DEMO = "fc4a1a0f-f885-4ca9-baf9-ce47eb47448f";
ok("B-1/B-2: Active and Probationary count; Inactive does not", M.isCountedMember(P("a", "Active")) && M.isCountedMember(P("p", "Probationary")) && !M.isCountedMember(P("i", "Inactive")));
ok("B-3: Project Admin, owner, test and demo are out of the count AND the list", [P("pa", "Active", { access: ["Project Admin"] }), P(OWNER, "Active"), P(TEST, "Active"), P(DEMO, "Active", { access: ["Board Member"] })]
  .every((m) => !M.isCountedMember(m) && !M.isListedMember(m)));
ok("B-4: a separated Active member is listed but not counted", M.isListedMember(P("s", "Active", { separated: true })) && !M.isCountedMember(P("s", "Active", { separated: true })));
ok("masked fields (NULL — a non-leader's view) never exclude: status null / separated null still count", M.isCountedMember(P("x", null, { separated: null })) && M.isCountedMember(P("y", "Active", { separated: undefined })));
const roster = [P("a1", "Active"), P("a2", "Active"), P("p1", "Probationary"), P("i1", "Inactive"), P("s1", "Active", { separated: true }), P("pa", "Active", { access: ["Project Admin"] }), P(OWNER, "Active")];
const hc = M.headcount(roster);
ok("headcount: 3 counted (2 active + 1 probationary) · 1 inactive alongside · 1 separated · 5 listed", hc.counted === 3 && hc.active === 2 && hc.probationary === 1 && hc.inactive === 1 && hc.separated === 1 && hc.listed === 5, JSON.stringify(hc));

// ---------------------------------------------------------------- bundle the real App.jsx
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
      for (const m of ["eq", "neq", "in", "is", "not", "order", "limit", "gte", "lte", "lt", "gt", "maybeSingle", "single", "or", "range"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { st.writes.push({ table, op: m, args }); return b; };
      b.then = (res, rej) => Promise.resolve({ data: st.table(table), error: null }).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push(n); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
      auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ws4c-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { RosterMembers, OnboardingCardPlain, deptAttendance };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { RosterMembers, OnboardingCardPlain, deptAttendance, createRoot, act, React } = await import(pathToFileURL(out).href);
const S = new Proxy({}, { get: () => ({}) });
const norm = (s) => s.replace(/\s+/g, " ").trim();
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount(Comp, props) {
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Comp, props)); });
  await tick(); await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
globalThis.__sb = { calls: [], writes: [], table: () => [], answer: () => ({ data: null, error: null }) };

// ---------------------------------------------------------------- 3. RosterMembers, rendered
{ const person = (id, name, status, extra = {}) => ({ id, name, status, access: ["Member"], role: "Firefighter", certs: [], joined: "2020", email: `${id}@x.test`, ...extra });
  const members = [person("a1", "Avery Active", "Active"), person("a2", "Blair Active", "Active"), person("p1", "Casey Prob", "Probationary"),
    person("i1", "Drew Inactive", "Inactive"), person("s1", "Emery Separated", "Active", { separated: true }), person("pa", "Pat Admin", "Active", { access: ["Project Admin"] })];
  const { host, unmount } = await mount(RosterMembers, { S, role: ["Department Admin"], members, setMembers: () => {}, onOpen: () => {}, notify: () => {}, dept: { id: "d1", name: "Indian Harbor" }, sessions: [], bandEl: null });
  const t = norm(host.textContent);
  const chip = (t.match(/Members\s?(\d+)\s?(\d+) active · (\d+) probationary · \+ (\d+) inactive/) || []);
  ok("Roster: the Members chip = the headcount (3: 2 active + 1 probationary) · '+ 1 inactive' alongside", chip[1] === "3" && chip[2] === "2" && chip[3] === "1" && chip[4] === "1", JSON.stringify(chip.slice(0, 5)) + " " + (t.match(/Members.{0,80}/)?.[0] || ""));
  ok("Roster: the separated member is still LISTED (listed ≠ counted); the Project Admin is not", t.includes("Emery Separated") && !t.includes("Pat Admin"));
  await unmount(); }

// ---------------------------------------------------------------- 4. deptAttendance (App's wrapper) — B-4 flows into C-1
{ const now = new Date(); const y = now.getFullYear();
  const sess = (id, att) => ({ id, y, m: 0, d: 10, done: true, audience: "everyone", countsAttendance: true, status: "scheduled", isMeeting: false, attendance: att });
  const mem = [{ id: "a", name: "A", status: "Active", access: ["Member"] }, { id: "s", name: "S", status: "Active", access: ["Member"], separated: true }, { id: "i", name: "I", status: "Inactive", access: ["Member"] }];
  const r = deptAttendance(mem, [sess("x", ["a"]), sess("y", ["a", "s", "i"])], y, null);
  ok("C-1 via B-4: a separated Active member and an Inactive member are out of the attendance rows and the average", JSON.stringify(r.rows.map((x) => x.id)) === '["a"]' && r.avg === 100, JSON.stringify(r.rows.map((x) => [x.id, x.pct])));
}

// ---------------------------------------------------------------- 5. E-1: the member card reads the computed status
{ const ITEMS = [{ id: "i1", category: "Getting started", label: "Read the SOP binder", is_mentor: false, sort_order: 1 },
    { id: "i2", category: "Getting started", label: "CPR card on file", is_mentor: false, sort_order: 2 },
    { id: "i3", category: "Getting started", label: "Ride-along x2", is_mentor: false, sort_order: 3 }];
  const PROG = [{ item_id: "i1", done: true, checked_by: "o1", checked_at: "2026-10-01T00:00:00Z" }, { item_id: "i2", done: true, checked_by: "o1", checked_at: "2026-10-01T00:00:00Z" }];   // i2 TICKED
  const STATUS = { status: "Probationary", items: [{ item_id: "i1", label: "Read the SOP binder", satisfied: true }, { item_id: "i2", label: "CPR card on file", satisfied: false }, { item_id: "i3", label: "Ride-along x2", satisfied: false }] };
  globalThis.__sb = { calls: [], writes: [], table: (t) => (t === "onboarding_items" ? ITEMS : t === "onboarding_progress" ? PROG : []),
    answer: (n) => (n === "my_probation_status" ? { data: STATUS, error: null } : { data: null, error: null }) };
  const { host, unmount } = await mount(OnboardingCardPlain, { S, me: { id: "me", status: "Probationary" }, go: () => {}, dept: { probation_enabled: false } });
  const t = norm(host.textContent);
  ok("E-1: the card asks the server (my_probation_status) even with probation OFF", globalThis.__sb.calls.includes("my_probation_status"));
  ok("E-1: open items = the computed set — the TICKED but unsatisfied 'CPR card on file' stays open (raw ticks said 2 of 3)", t.includes("1 of 3 complete") && /NEXT UP.*CPR card on file/.test(t), t.slice(0, 220));
  await unmount(); }

// ---------------------------------------------------------------- 2. HELPER PINS + E-2 + invariants
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const dig = readFileSync(join(root, "api/digest.js"), "utf8");
const IDS = [OWNER, TEST, DEMO];
ok("PIN: the owner/test/demo ids live ONLY in shared/members.js (not App.jsx, not digest.js)", IDS.every((id) => !src.includes(id) && !dig.includes(id)) && IDS.every((id) => readFileSync(join(root, "shared/members.js"), "utf8").includes(id)));
ok("PIN App: imports isListedMember + isCountedMember + headcount from ../shared/members.js; no countsInStats / STATS_EXCLUDED_IDS of its own",
  src.includes('import { isListedMember, isCountedMember, headcount } from "../shared/members.js";') && !/const countsInStats\s*=/.test(src) && !/const STATS_EXCLUDED_IDS\s*=/.test(src) && !/countsInStats\(/.test(src) && !src.includes("filter(countsInStats)"));
ok("PIN digest: imports isListedMember + isCountedMember; no countsInStats / id list of its own",
  dig.includes('import { isListedMember, isCountedMember } from "../shared/members.js";') && !/const countsInStats\s*=/.test(dig) && !/const STATS_EXCLUDED_IDS\s*=/.test(dig) && !/countsInStats\(/.test(dig));
const SITES = [
  ["dashboard Members tile (DeptHealthCharts)", "const hc = headcount(members);\n  const total = hc.counted, nActive = hc.active, nProb = hc.probationary, nInactive = hc.inactive;"],
  ["Roster chips", 'chip(Users, "Members", String(hc.counted), `${nActive} active · ${nProb} probationary · + ${hc.inactive} inactive`)'],
  ["BoardStats hero", '<HeroTile n={String(hc.counted)} label="Members" sub={`${hc.active} active · ${hc.probationary} probationary · + ${hc.inactive} inactive`} />'],
  ["roster breakdown bar", "const active = hc.active, prob = hc.probationary, inactive = hc.inactive, separated = hc.separated,"],
  ["Attendance Report + every attendance screen (deptAttendance)", "const deptAttendance = (members, sessions, year, range) => deptAttendanceShared(members, sessions, year, range, isCountedMember);"],
  ["Training headcount", "const totalMembers = headcount(members).counted;"],
];
for (const [label, needle] of SITES) ok(`PIN count site — ${label} reads shared/members.js`, src.includes(needle));
ok("PIN count site — the email's attendance % is over isCountedMember (with the separation flag)", dig.includes("const counted = listed.filter((m) => isCountedMember({ ...m, separated: mi.separatedIds.has(m.id) }));"));
ok("B-4 plumbing: the app maps members_view.separated; the email reads member_separation(member_id) only — never terminated_on",
  src.includes("separated: m.separated ?? null,") && dig.includes('sb.from("member_separation").select("member_id")') && !/select\([^)]*terminated_on/.test(dig) && !/select\([^)]*terminated_on/.test(src));
ok("E-2: 'Awaiting sign-off' = the signoff queue's rows (onCount), not the open manual items",
  src.includes("onCount={setQueueN}") && src.includes("const awaiting = queueN;") && src.includes("setErr(false); setRows(data); if (onCount) onCount(data.length);") && !src.includes("o.p.openSignable"));
ok("E-1: the admin overview reads the computed board with probation OFF too; the raw onboarding_progress overview read is gone",
  src.includes("if (probOn || !canSign) return;") && src.includes('supabase.rpc("dept_probation_board").then(({ data, error }) => {\n      if (!alive) return;\n      if (error || !Array.isArray(data)) { setBoardErr(true); return; }')
  && !src.includes('supabase.from("onboarding_progress").select("member_id, item_id, done").in("member_id"'));
ok("B-4: the onboarding overview population drops separated members (= dept_probation_board's)", src.includes('const probMembers = candidates.filter((m) => m.status === "Probationary" && m.separated !== true);'));
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = execSync("git ls-files --others --exclude-standard -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const all = [...new Set([...changed, ...untracked])].sort();
ok("runtime files changed vs origin/main = App.jsx, digest.js, shared/attendance.js (comment) + the new shared/members.js", JSON.stringify(all) === JSON.stringify(["api/digest.js", "shared/attendance.js", "shared/members.js", "src/App.jsx"]), JSON.stringify(all));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token counts unchanged (App.jsx 132 · digest.js 32 · assistant.js 14)", tok(src) === 132 && tok(dig) === 32 && tok(readFileSync(join(root, "api/assistant.js"), "utf8")) === 14, `${tok(src)} · ${tok(dig)}`);
const added = execSync("git diff origin/main -- src api shared", { cwd: root }).toString().split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
ok("no station_presence line added", !added.some((l) => l.includes("station_presence")));
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
