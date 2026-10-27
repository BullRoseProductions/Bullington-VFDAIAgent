// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/ws4b_shared_test.mjs
// No network, no DB. WS-4b "numbers agree" — client + shared/ (claude/B4C_WS4_Metrics_Step0.md; Ashlea's rulings
// A-1..A-4 STRICT, C-1..C-3, D-1..D-3 with D-2 = meetings in attendance %, out of drills; F-2; F-4). Checks:
//   1. shared/apparatus-status.js: the strict buckets (never checked ≠ ready; overdue → needs attention; retired out of
//      every count; no schedule → never overdue), snake_case rows == camelCase rigs, counts sum to the total
//   2. shared/attendance.js is a FAITHFUL LIFT: over 3,000 random fixtures (no cancelled sessions) it returns exactly
//      what the ORIGINAL App.jsx deptAttendance / memberAttendance returned (pasted verbatim below) — rows, the
//      counting sessions, and avg wherever someone is rated
//   3. …plus ONLY the ruled changes: cancelled never counts; avg null ("—") when nobody is rated; drillsHeld drops
//      business meetings while the % keeps them; needsRoll = finalized without a roll; drillsScheduled
//   4. the weekly email's trainingCompliancePct is now the app's rule: the join-date cutoff applies (the September
//      joiner is no longer absent for January), and it equals deptAttendance on the same rows
//   5. ApparatusReadinessBar (rendered off useApparatusReadiness with a mocked read): Ready / Needs attention / Never
//      checked / Out of service match apparatusCounts on the same rigs
//   6. HELPER PINS — every listed call site imports its shared helper and keeps no local copy of the rule
//   7. F-2 / F-4 / A-2 maintenance + equipment wiring; the invariants (verified literal counts 132 · 32 · 14, no
//      station_presence write, Notify held); runtime files changed vs origin/main
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const imp = (p) => import(pathToFileURL(join(root, p)).href);

// ---------------------------------------------------------------- 1. apparatus-status
const { rigStatus, apparatusCounts, checkOverdue } = await imp("shared/apparatus-status.js");
const NOW = Date.parse("2026-10-27T15:00:00Z"), DAY = 86400e3;
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const RIGS = [
  { id: "r1", name: "Engine 1", in_service: true, status: "Pass", last_check_at: ago(2), check_interval_days: 7 },     // ready
  { id: "r2", name: "Engine 2", in_service: true, status: "Pass", last_check_at: ago(20), check_interval_days: 7 },    // OVERDUE → needs attention
  { id: "r3", name: "Brush 3", in_service: true, status: "Pass", last_check_at: null, check_interval_days: 7 },        // never checked (added as "Ready")
  { id: "r4", name: "Tanker 4", in_service: true, status: "Fail", last_check_at: ago(1), check_interval_days: null },  // failed → needs attention
  { id: "r5", name: "Rescue 5", in_service: false, status: "Pass", last_check_at: ago(1), check_interval_days: 7 },   // out of service
  { id: "r6", name: "Utility 6", in_service: null, status: "Pass", last_check_at: ago(400), check_interval_days: null },// no schedule → never overdue → ready (null in_service = in service)
  { id: "r7", name: "Old 7", in_service: true, status: "Pass", last_check_at: ago(1), check_interval_days: 7, deleted_at: ago(30) },   // retired
];
const st = Object.fromEntries(RIGS.map((r) => [r.id, rigStatus(r, { now: NOW })]));
ok("A-1: a rig with no check on file is never_checked, not ready (even with status Pass)", st.r3 === "never_checked");
ok("A-3: a scheduled check past due makes a passed rig needs_attention", st.r2 === "needs_attention" && checkOverdue(RIGS[1], NOW) && !checkOverdue(RIGS[0], NOW));
ok("strict ready = in service ∧ Pass ∧ checked ∧ not overdue (r1, r6); failed → needs_attention; OOS; retired", st.r1 === "ready" && st.r6 === "ready" && st.r4 === "needs_attention" && st.r5 === "out_of_service" && st.r7 === "retired");
ok("overdue boundary: exactly at last + interval is not overdue; 1 ms later is", !checkOverdue({ last_check_at: new Date(NOW - 7 * DAY).toISOString(), check_interval_days: 7 }, NOW) && checkOverdue({ last_check_at: new Date(NOW - 7 * DAY - 1).toISOString(), check_interval_days: 7 }, NOW));
const camel = RIGS.map((r) => ({ id: r.id, status: r.status, inService: r.in_service !== false, lastCheckAt: r.last_check_at, checkIntervalDays: r.check_interval_days, deletedAt: r.deleted_at }));
ok("the App's camelCase rigs read exactly as the email's snake_case rows", camel.every((r, i) => rigStatus(r, { now: NOW }) === rigStatus(RIGS[i], { now: NOW })));
const cnt = apparatusCounts(RIGS, { now: NOW });
ok("A-2: counts are over non-retired rigs and sum to the total (2 ready · 2 attention · 1 never · 1 OOS = 6)",
  cnt.total === 6 && cnt.ready === 2 && cnt.needsAttention === 2 && cnt.neverChecked === 1 && cnt.outOfService === 1 && cnt.ready + cnt.needsAttention + cnt.neverChecked + cnt.outOfService === cnt.total, JSON.stringify(cnt));

// ---------------------------------------------------------------- 2. attendance — a faithful lift
const A = await imp("shared/attendance.js");
const { isLeader } = await imp("shared/roles.js");
// ===== ORIGINAL, verbatim from src/App.jsx @ 734dc71 (deptAttendance :3260, memberAttendance :28165, joinCutoff,
// expectedAfterJoin, isRestrictedEvent, isOptionalEvent, countsTowardRate) — only `countsInStats` became a parameter.
const pad2 = (n) => String(n).padStart(2, "0");
const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const sessDate = (s) => new Date(s.y, s.m, s.d);
const isRestrictedEvent = (s) => s?.audience === "leadership" || s?.audience === "board";
const isOptionalEvent = (s) => s?.countsAttendance === false;
const countsTowardRate = (s) => !isRestrictedEvent(s) && !isOptionalEvent(s);
const joinCutoff = (m) => {
  const d = String(m?.joinedOn || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const y = /^\s*(\d{4})/.exec(String(m?.joined ?? ""));
  return y ? `${y[1]}-01-01` : null;
};
const expectedAfterJoin = (m, s) => { const c = joinCutoff(m); return !c || toISODate(sessDate(s)) >= c; };
function origDeptAttendance(members, sessions, year, range, countsInStats) {
  const inScope = range
    ? (s) => { const iso = toISODate(sessDate(s)); return (!range.from || iso >= range.from) && (!range.to || iso <= range.to); }
    : (s) => s.y === year;
  const doneThisYear = (sessions || []).filter((s) => s.done && inScope(s) && (s.attendance || []).length > 0 && countsTowardRate(s));
  const rows = (members || []).filter(countsInStats).map((m) => {
    const memberLeader = isLeader(m.access);
    const eligible = doneThisYear.filter((s) => expectedAfterJoin(m, s));
    const attended = eligible.filter((s) => (s.attendance || []).includes(m.id)).length;
    const pct = eligible.length ? Math.round((attended / eligible.length) * 100) : null;
    return { id: m.id, name: m.name, role: m.role, status: m.status, attended, eligible: eligible.length, pct, leader: memberLeader };
  });
  const rated = rows.filter((r) => r.pct != null);
  const avg = rated.length ? Math.round(rated.reduce((s, r) => s + r.pct, 0) / rated.length) : 0;
  return { rows, avg, doneThisYear };
}
const origMemberAttendance = (me, sessions, range) => {
  const meLeader = isLeader(me?.access);
  const rec = (sessions || []).filter((s) => { const iso = toISODate(sessDate(s)); return s.done && (s.attendance || []).length > 0 && iso >= range.from && iso <= range.to && !isOptionalEvent(s) && (meLeader || !isRestrictedEvent(s)) && expectedAfterJoin(me, s); });
  if (!rec.length) return null;
  const attended = me ? rec.filter((s) => (s.attendance || []).includes(me.id)).length : 0;
  return { total: rec.length, attended, pct: Math.round((attended / rec.length) * 100) };
};
// ===== end ORIGINAL
let seed = 20261027; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const genWorld = ({ cancelled = false, meetings = false } = {}) => {
  const members = Array.from({ length: 1 + Math.floor(rnd() * 7) }, (_, i) => ({ id: `m${i}`, name: `M${i}`, status: pick(["Active", "Probationary", "Inactive"]),
    access: pick([["Member"], ["Officer"], ["Board Member"], ["Project Admin"], ["Member", "Officer"]]),
    joinedOn: rnd() < 0.4 ? `2026-${pad2(1 + Math.floor(rnd() * 12))}-${pad2(1 + Math.floor(rnd() * 28))}` : null, joined: rnd() < 0.5 ? pick(["2019", "2026", "2025 (spring)", "", null]) : null }));
  const sessions = Array.from({ length: Math.floor(rnd() * 14) }, (_, i) => ({ id: `s${i}`, y: pick([2025, 2026, 2026]), m: Math.floor(rnd() * 12), d: 1 + Math.floor(rnd() * 28),
    done: rnd() < 0.75, audience: pick(["everyone", "everyone", "everyone", "leadership", "board"]), countsAttendance: rnd() < 0.85,
    status: cancelled && rnd() < 0.25 ? "cancelled" : "scheduled", isMeeting: meetings && rnd() < 0.3,
    attendance: members.filter(() => rnd() < 0.55).map((m) => m.id) }));
  return { members, sessions };
};
const counted = (m) => !(m.access || []).includes("Project Admin");
const RANGES = [null, { from: "2026-01-01", to: "2026-12-31" }, { from: "2026-03-15", to: "2026-09-30" }, {}];
let same = 0, diff = [], memSame = 0, memDiff = [];
for (let i = 0; i < 3000; i++) {
  const { members, sessions } = genWorld();
  const range = pick(RANGES);
  const o = origDeptAttendance(members, sessions, 2026, range, counted), n = A.deptAttendance(members, sessions, 2026, range, counted);
  const rated = o.rows.some((r) => r.pct != null);
  const eq = JSON.stringify(o.rows) === JSON.stringify(n.rows) && JSON.stringify(o.doneThisYear) === JSON.stringify(n.doneThisYear) && (rated ? o.avg === n.avg : n.avg === null);
  if (eq) same += 1; else if (diff.length < 2) diff.push({ i, o, n });
  const me = pick(members), mr = { from: "2026-01-01", to: "2026-12-31" };
  if (JSON.stringify(origMemberAttendance(me, sessions, mr)) === JSON.stringify(A.memberAttendance(me, sessions, mr))) memSame += 1; else if (memDiff.length < 1) memDiff.push(i);
}
ok("faithful lift: deptAttendance matches the original on 3,000 random fixtures (rows · counting sessions · avg where rated)", same === 3000, `${same}/3000 ${diff.length ? JSON.stringify(diff[0]).slice(0, 300) : ""}`);
ok("…and where NOBODY is rated the original said 0% and the shared rule says null (C-3) — the only avg change", same === 3000);
ok("faithful lift: memberAttendance matches the original on the same 3,000 fixtures", memSame === 3000, `${memSame}/3000`);

// ---------------------------------------------------------------- 3. only the ruled changes
const mem = [{ id: "a", name: "A", access: ["Member"], joinedOn: "2026-01-01" }, { id: "b", name: "B", access: ["Member"], joinedOn: "2026-01-01" }];
const S = (id, mo, d, extra) => ({ id, y: 2026, m: mo, d, done: true, audience: "everyone", countsAttendance: true, status: "scheduled", isMeeting: false, attendance: ["a"], ...extra });
const W = [S("drill", 2, 5), S("cancelled", 2, 12, { status: "cancelled", attendance: ["a", "b"] }), S("meeting", 2, 19, { isMeeting: true, attendance: ["a", "b"] }),
  S("noroll", 2, 26, { attendance: [] }), S("future", 2, 28, { done: false, attendance: [] }), S("lead", 2, 27, { audience: "leadership" })];
const r = A.deptAttendance(mem, W, 2026, null);
ok("a CANCELLED session never counts (even finalized with a roll)", !r.doneThisYear.some((s) => s.id === "cancelled"));
ok("D-2: a business meeting stays in the attendance % (doneThisYear) but is not a drill held", r.doneThisYear.some((s) => s.id === "meeting") && !r.drillsHeld.some((s) => s.id === "meeting") && r.drillsHeld.map((s) => s.id).join() === "drill");
ok("the % is over drill + meeting: A 2/2 = 100%, B 1/2 = 50% → avg 75%", JSON.stringify(r.rows.map((x) => x.pct)) === "[100,50]" && r.avg === 75, JSON.stringify(r.rows.map((x) => x.pct)));
ok("D-3: a finalized drill with no roll is 'needs roll', never held", r.needsRoll.map((s) => s.id).join() === "noroll" && !r.drillsHeld.some((s) => s.id === "noroll"));
ok("C-3: nobody rated → avg null (\"—\"), not 0", A.deptAttendance(mem, [S("x", 2, 5, { attendance: [], done: false })], 2026, null).avg === null && A.deptAttendance([], W, 2026, null).avg === null);
ok("D-1: drillsScheduled = not cancelled · counts toward the rate · not a meeting · any state (drill, noroll, future)",
  A.drillsScheduled(W, { from: "2026-03-01", to: "2026-03-31" }).map((s) => s.id).sort().join() === "drill,future,noroll");
ok("memberAttendance: a cancelled session never counts", A.memberAttendance(mem[0], [S("c", 2, 5, { status: "cancelled" })], { from: "2026-01-01", to: "2026-12-31" }) === null);
// with cancelled sessions + meetings in the world, the counting set is EXACTLY the original's minus the cancelled ones
let liftOk = 0;
for (let i = 0; i < 1000; i++) {
  const { members, sessions } = genWorld({ cancelled: true, meetings: true });
  const o = origDeptAttendance(members, sessions.filter((s) => s.status !== "cancelled"), 2026, null, counted), n = A.deptAttendance(members, sessions, 2026, null, counted);
  if (JSON.stringify(o.doneThisYear) === JSON.stringify(n.doneThisYear) && JSON.stringify(o.rows) === JSON.stringify(n.rows)
    && JSON.stringify(n.drillsHeld) === JSON.stringify(n.doneThisYear.filter((s) => !s.isMeeting))) liftOk += 1;
}
ok("with cancelled + meetings mixed in: shared = original-without-cancelled, and drillsHeld = that minus meetings (1,000 fixtures)", liftOk === 1000, `${liftOk}/1000`);

// ---------------------------------------------------------------- 4. the email uses the app's rule
const { trainingCompliancePct } = await imp("api/digest.js");
const dbSessions = [{ id: "jan", date: "2026-01-14", done: true, audience: "everyone", counts_toward_attendance: true, is_meeting: false, status: "scheduled" },
  { id: "oct", date: "2026-10-07", done: true, audience: "everyone", counts_toward_attendance: true, is_meeting: false, status: "scheduled" },
  { id: "cx", date: "2026-10-09", done: true, audience: "everyone", counts_toward_attendance: true, is_meeting: false, status: "cancelled" }];
const dbAtt = [{ session_id: "jan", member_id: "vet" }, { session_id: "oct", member_id: "vet" }, { session_id: "oct", member_id: "new" }, { session_id: "cx", member_id: "vet" }];
const dbMembers = [{ id: "vet", access: ["Member"], status: "Active", joined: "2015" }, { id: "new", access: ["Member"], status: "Active", joined: "2026" }];
const joins = new Map([["new", "2026-09-01"]]);
const emailPct = trainingCompliancePct(dbSessions, dbAtt, dbMembers, 2026, joins);
ok("email: the September joiner is not absent for January (join-date cutoff) and the cancelled drill doesn't count → 100%", emailPct === 100, String(emailPct));
ok("email: without a join date it falls back to the `joined` year (Jan 1) — the January drill counts against them → 75%", trainingCompliancePct(dbSessions, dbAtt, dbMembers, 2026, new Map()) === 75);
ok("email: nobody rated → null (\"—\")", trainingCompliancePct([], [], dbMembers, 2026) === null);

// ---------------------------------------------------------------- 5. render: the dashboard apparatus bar
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/", width: 1024, height: 900 });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _cols: null };
      b.select = (c) => { b._cols = c; return b; };
      for (const m of ["eq", "neq", "in", "is", "not", "order", "limit", "gte", "lte", "lt", "gt", "maybeSingle", "single", "or", "range"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { st.writes.push({ table, op: m, args }); return b; };
      b.then = (res, rej) => { st.reads.push({ table, cols: b._cols }); return Promise.resolve({ data: st.table(table), error: null }).then(res, rej); };
      return b;
    }
    export const supabase = { from: q, rpc: () => ({ then: (res) => Promise.resolve({ data: null, error: null }).then(res) }),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
      auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ws4b-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { ApparatusReadinessBar };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { ApparatusReadinessBar, createRoot, act, React } = await import(pathToFileURL(out).href);
// live "now" for the render — rebuild the fixture relative to the real clock (the hook reads Date.now())
const liveAgo = (d) => new Date(Date.now() - d * DAY).toISOString();
const LIVE = RIGS.filter((r) => !r.deleted_at).map((r) => ({ ...r, note: "", type: "Engine", last_check_at: r.last_check_at ? liveAgo((NOW - Date.parse(r.last_check_at)) / DAY) : null }));
globalThis.__sb = { reads: [], writes: [], table: (t) => (t === "apparatus" ? LIVE : []) };
{ document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const root2 = createRoot(host);
  await act(async () => { root2.render(React.createElement(ApparatusReadinessBar)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  const t = host.textContent.replace(/\s+/g, " ");
  const n = (label) => Number((new RegExp(`${label} (\\d+)`).exec(t) || [])[1]);
  const exp = apparatusCounts(LIVE);
  ok("ApparatusReadinessBar: Ready / Needs attention / Never checked / Out of service = apparatusCounts (2 · 2 · 1 · 1)",
    n("Ready") === exp.ready && n("Needs attention") === exp.needsAttention && n("Never checked") === exp.neverChecked && n("Out of service") === exp.outOfService && exp.ready === 2, t.slice(0, 200));
  const rd = globalThis.__sb.reads.find((x) => x.table === "apparatus");
  ok("useApparatusReadiness reads last_check_at + check_interval_days (the strict rule needs both)", !!rd && /last_check_at/.test(rd.cols) && /check_interval_days/.test(rd.cols), rd?.cols);
  ok("rendering wrote nothing", globalThis.__sb.writes.length === 0);
  await act(async () => root2.unmount()); }

// ---------------------------------------------------------------- 6. HELPER PINS
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const dig = readFileSync(join(root, "api/digest.js"), "utf8");
const pulse = readFileSync(join(root, "api/pulse.js"), "utf8");
const rep = readFileSync(join(root, "src/report.js"), "utf8");
const fnBody = (s, head) => { const i = s.indexOf(head); if (i < 0) return ""; const j = s.indexOf("\nfunction ", i + 10); return s.slice(i, j < 0 ? undefined : j); };
ok("PIN App: imports rigStatus + checkOverdue from ../shared/apparatus-status.js", src.includes('import { rigStatus, checkOverdue } from "../shared/apparatus-status.js";'));
ok("PIN App: imports the attendance rule from ../shared/attendance.js", /import \{ isRestrictedEvent, isOptionalEvent, countsTowardRate, expectedAfterJoin, memberAttendance, drillsScheduled,\s*deptAttendance as deptAttendanceShared \} from "\.\.\/shared\/attendance\.js";/.test(src));
ok("PIN App: imports maintStatus (as maintRule) + startOfToday from ../shared/maint-due.js", src.includes('import { maintStatus as maintRule, startOfToday } from "../shared/maint-due.js";'));
ok("PIN App: no local copy of the attendance rule (deptAttendance is the countsInStats wrapper; no memberAttendance / joinCutoff / countsTowardRate body)",
  src.includes("const deptAttendance = (members, sessions, year, range) => deptAttendanceShared(members, sessions, year, range, countsInStats);")
  && !/function deptAttendance\(/.test(src) && !/const memberAttendance = \(/.test(src) && !/const joinCutoff = \(/.test(src) && !/const countsTowardRate = \(/.test(src) && !/const isOptionalEvent = \(/.test(src));
const hook = fnBody(src, "function useApparatusReadiness(");
ok("PIN useApparatusReadiness: buckets from rigStatus; no local Pass test", hook.includes("rigStatus(r, { now })") && !hook.includes('r.status === "Pass"') && !hook.includes('r.status !== "Pass"'));
const appPage = fnBody(src, "function Apparatus({");
ok("PIN Apparatus page: chips + card + detail read rigStatus via rigLook; the card no longer says 'In service' for Pass",
  appPage.includes("const rigLook = (r) => { const s = rigStatus(r);") && appPage.includes("const { tone, text: statusText } = rigLook(r);") && !appPage.includes('ok ? "In service" : "Needs attention"'));
ok("PIN Apparatus page: A-4 scope label for one house of a multi-house department", appPage.includes('data-testid="apparatus-scope"') && appPage.includes("const scopeName = !allMode && activeStationId && (stations || []).length > 1"));
ok("PIN MemberDashboard: 'N scheduled' = drillsScheduled", src.includes("const trainingsThisMonth = drillsScheduled(sess, {"));
ok("PIN maintenance: the app's maintStatus is the shared rule (no local cadence arithmetic)", src.includes("const s = maintRule(row, startOfToday());") && !src.includes("const MAINT_CADENCE_DAYS = {") && !src.includes("interval * 0.8"));
ok("PIN digest: imports apparatusCounts + deptAttendance from shared/", dig.includes('import { apparatusCounts } from "../shared/apparatus-status.js";') && dig.includes('import { deptAttendance } from "../shared/attendance.js";'));
ok("PIN digest: apparatus metric = apparatusCounts; the tile is 'Apparatus ready' = ready/total", dig.includes("const c = apparatusCounts(deptApparatus);") && dig.includes('["Apparatus ready", m.apparatus.total === null ? "&mdash;" : `${esc(m.apparatus.ready)}/${esc(m.apparatus.total)}`]'));
ok("PIN digest: trainingCompliancePct delegates to deptAttendance (no local eligibility copy)", fnBody(dig, "export function trainingCompliancePct(").includes("return deptAttendance(") && !dig.includes('if (s.audience === "leadership" || s.audience === "board") return false;'));
ok("C-2: the email tile reads 'Attendance' (not 'Training' under 'Readiness at a glance'); the PDF 'AVG ATTENDANCE'", dig.includes('["Attendance", dash(m.trainingPct, "%")]') && rep.includes('label: "AVG ATTENDANCE"'));
{ // the member-file ring = mean(cert %, 90-day attendance): titled "Cert & attendance", never "Readiness" (Ashlea's rename)
  const i = src.indexOf("// READY = the mean of cert compliance (current ÷ on file) and 90-day participation");
  const ring = i < 0 ? "" : src.slice(i, i + 4000);
  ok("C-2 rename: the member-file cert+attendance ring is titled 'Cert & attendance', not 'Readiness'",
    ring.includes('<CardHead icon={ShieldAlert} title="Cert & attendance" right={<span>as of today</span>} />') && !ring.includes('title="Readiness"') && !src.includes('<CardHead icon={ShieldAlert} title="Readiness"'), i < 0 ? "ring not found" : ""); }
ok("C-3: the PDF dashes a null attendance %", /k\.avgPart == null \? "(—|\\u2014)"/.test(rep) && rep.includes('pd.avgPart == null ? "attendance not measured"'));
ok("A: the PDF names never checked", rep.includes("${rd.neverChecked ?? 0} never checked") && rep.includes('"Never checked"'));

// ---------------------------------------------------------------- 7. maintenance (F-2, A-2) + equipment (F-4) + invariants
ok("A-2: app, email and daily push all drop a RETIRED rig's maintenance tasks",
  src.includes('.select("id, department_id, rig_id, task, cadence, last_done_at, apparatus(deleted_at)")') && src.includes("setItems(data.filter((r) => !r.apparatus?.deleted_at)")
  && dig.includes("detectMaintenanceFrom((data || []).filter((r) => !r.apparatus?.deleted_at), today)") && pulse.includes("if (r.apparatus?.deleted_at) continue;"));
const { maintStatus: maintRule, startOfToday } = await imp("shared/maint-due.js");
const lbl = (row) => { const s = maintRule(row, startOfToday()); return !s ? "Current" : s.kind === "maint_overdue" ? "Overdue" : "Due soon"; };
const dIso = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
ok("F-2: never done reads Overdue (was 'Due soon'); 10 of 30 days → Current; 20 of 30 → Due soon (14-day window); 31 → Overdue",
  lbl({ department_id: "d", cadence: "Monthly", last_done_at: null }) === "Overdue" && lbl({ department_id: "d", cadence: "Monthly", last_done_at: dIso(10) }) === "Current"
  && lbl({ department_id: "d", cadence: "Monthly", last_done_at: dIso(20) }) === "Due soon" && lbl({ department_id: "d", cadence: "Monthly", last_done_at: dIso(31) }) === "Overdue");
const eqPage = fnBody(src, "function Equipment(");
ok("F-4: Equipment 'need attention' (chip + per category) = units with an OPEN issue, not condition ≠ Serviceable",
  eqPage.includes("const flagged = issuesKnown ? allUnits.filter((u) => issuesByEq.get(u.id) > 0).length : null;") && !eqPage.includes('const flagged = allUnits.filter((u) => u.condition !== "Serviceable").length;')
  && eqPage.includes("attn: issuesKnown ? cr.filter((r) => issuesByEq.get(r.u.id) > 0 && r.g.rank !== 0).length : 0"), eqPage ? "" : "Equipment() not found");
// The DELTA fences are PINNED to WS-4b's own reviewed range (734dc71 = main before it, .. 1319a3e = the code commit
// 747269d + Ashlea's rename; released in industrial-noir-38): "vs origin/main" goes red once the slice is on main.
const BASE = "734dc71", REL = "1319a3e";
const all = execSync(`git diff --name-only ${BASE} ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
const RUNTIME = ["api/digest.js", "api/pulse.js", "shared/apparatus-status.js", "shared/attendance.js", "src/App.jsx", "src/report.js"];
ok("WS-4b (734dc71..1319a3e) runtime files = App.jsx, report.js, digest.js, pulse.js + the two new shared helpers", JSON.stringify(all) === JSON.stringify(RUNTIME), JSON.stringify(all));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token counts unchanged (App.jsx 132 · digest.js 32 · assistant.js 14)", tok(src) === 132 && tok(dig) === 32 && tok(readFileSync(join(root, "api/assistant.js"), "utf8")) === 14, `${tok(src)} · ${tok(dig)}`);
const added = execSync(`git diff ${BASE} ${REL} -- src api shared`, { cwd: root }).toString().split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
ok("WS-4b (734dc71..1319a3e) added no station_presence write (no added line touches it)", !added.some((l) => l.includes("station_presence")));
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
