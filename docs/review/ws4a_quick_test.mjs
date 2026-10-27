// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/ws4a_quick_test.mjs
// No network, no DB. WS-4a "numbers agree" — the quick client slice (claude/B4C_WS4_Metrics_Step0.md; rulings G-1, G-2,
// H-1 HIGH bar, A-2 in the email). Bundles the REAL src/App.jsx with esbuild (fakes as the other review tests) and checks:
//   1. shared/shift-span.js: in = out → "voided"; 0 < out−in < 1 min → "under_minute"; open; unreadable → falls back
//   2. HELPER PIN: App.jsx imports shiftSpan + shiftHoursText from ../shared/shift-span.js, and every listed shift-row site
//      (StationHoursReport day detail + shift log; StationHours recent + full list) prints its hours through
//      shiftHoursText — no raw `h1(…hours)` left in a shift row
//   3. StationHours (rendered): a voided shift reads "Voided" (times struck through), a 20-second one "< 1 min", a real
//      one its hours — and the hours themselves are the server's, untouched
//   4. the two close forms refuse end ≤ start / end > now INLINE (no RPC sent), mirroring close_open_shift /
//      resolve_auto_closed_shift and checkOut
//   5. RosterMembers (rendered): "✦ CERT LEADER" (renamed), nobody under 75% current is highlighted, 75%+ is
//   6. RosterAttendance (rendered): "Showing up strong" never lists a 0% member or anyone on "Needs a nudge"
//   7. api/digest.js reads apparatus with deleted_at IS NULL (retired rigs out of the email's in-service count)
//   8. the source: only src/App.jsx + api/digest.js + shared/shift-span.js changed; verified literal counts unchanged
//      (App.jsx 132 · digest.js 32 · assistant.js 14); no station_presence write added; Notify held
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

// ---------------------------------------------------------------- 1. the helper
const { shiftSpan, shiftHoursText } = await import(pathToFileURL(join(root, "shared/shift-span.js")).href);
const IN = "2026-10-20T04:47:00.000Z";
ok("in = out → voided (void_auto_closed_shift's zero-length record)", shiftSpan(IN, IN) === "voided" && shiftSpan(IN, "2026-10-20T04:47:00+00:00") === "voided");
ok("20 s and 59.9 s → under_minute; exactly 60 s → timed", shiftSpan(IN, "2026-10-20T04:47:20Z") === "under_minute" && shiftSpan(IN, "2026-10-20T04:47:59.900Z") === "under_minute" && shiftSpan(IN, "2026-10-20T04:48:00Z") === "timed");
ok("no out-time → open; out before in → timed (never mislabelled); garbage → timed", shiftSpan(IN, null) === "open" && shiftSpan(IN, "2026-10-20T04:40:00Z") === "timed" && shiftSpan("nope", IN) === "timed");
ok("shiftHoursText: Voided · < 1 min · otherwise the caller's text unchanged",
  shiftHoursText(IN, IN, "0.0 h") === "Voided" && shiftHoursText(IN, "2026-10-20T04:47:20Z", "0.0 h") === "< 1 min" && shiftHoursText(IN, "2026-10-20T07:17:00Z", "2.5 h") === "2.5 h" && shiftHoursText(IN, null, "x") === "x");

// ---------------------------------------------------------------- bundle the real App.jsx
const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _w: null, _cols: null };
      b.select = (c) => { b._cols = c; return b; };
      for (const m of ["eq", "neq", "in", "is", "not", "order", "limit", "gte", "lte", "lt", "gt", "maybeSingle", "single", "or", "range"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { b._w = { table, op: m, args }; st.writes.push(b._w); return b; };
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
      auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ws4a-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { StationHours, RosterMembers, RosterAttendance };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { StationHours, RosterMembers, RosterAttendance, createRoot, act, React } = await import(pathToFileURL(out).href);

const S = new Proxy({}, { get: () => ({}) });
const notes = []; const notify = (x) => notes.push(x);
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => s.replace(/\s+/g, " ").trim();
async function mount(Comp, props) {
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Comp, props)); });
  await tick(); await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}

// ---------------------------------------------------------------- 3. StationHours, rendered
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const VOID_AT = iso(3 * 86400e3), SHORT_AT = iso(2 * 86400e3), REAL_AT = iso(1 * 86400e3);
const MY_SHIFTS = [
  { checked_in_at: REAL_AT, checked_out_at: new Date(Date.parse(REAL_AT) + 2.5 * 3600e3).toISOString(), hours: 2.5, kind: "standby", verified: true, station_name: "Station 1" },
  { checked_in_at: SHORT_AT, checked_out_at: new Date(Date.parse(SHORT_AT) + 20e3).toISOString(), hours: 0.01, kind: "standby", verified: true, station_name: "Station 1" },
  { checked_in_at: VOID_AT, checked_out_at: VOID_AT, hours: 0, kind: "standby", verified: false, station_name: "Station 1" },
];
globalThis.__sb = { calls: [], writes: [], answer: (n) => n === "my_station_shifts" ? { data: MY_SHIFTS, error: null } : { data: null, error: null } };
{ const { host, unmount } = await mount(StationHours, { S, dept: { id: "d1", name: "Indian Harbor" }, notify });
  const t = norm(host.textContent);
  ok("StationHours: the voided shift reads 'Voided', not '0.0 h'", t.includes("Voided") && !/\b0\.0 h\b/.test(t), t.match(/.{0,40}Voided.{0,20}/)?.[0] || t.slice(0, 200));
  ok("StationHours: the 20-second shift reads '< 1 min'", t.includes("< 1 min"));
  ok("StationHours: a real shift still reads the server's hours (2.5 h)", t.includes("2.5 h"));
  const struck = [...host.querySelectorAll("div")].filter((d) => d.style.textDecoration === "line-through" && d.children.length === 0);
  ok("StationHours: only the voided shift's times are struck through (one per list it appears in)", struck.length >= 1 && struck.length <= 2, String(struck.length));
  ok("StationHours: rendering wrote nothing", globalThis.__sb.writes.length === 0);
  await unmount(); }

// ---------------------------------------------------------------- 5. RosterMembers, rendered
const cert = (exp) => ({ name: "C", exp, neverExpires: false });
const person = (id, name, certs, status = "Active") => ({ id, name, status, access: ["Member"], role: "Firefighter", certs, joined: "2020", email: `${id}@x.test` });
const rosterProps = (members) => ({ S, role: ["Department Admin"], members, setMembers: () => {}, onOpen: () => {}, notify, dept: { id: "d1", name: "Indian Harbor" }, sessions: [], bandEl: null });
{ // best is 67% current (2 of 3) and another at 0% — both under the 75% bar: nobody highlighted
  const members = [person("a", "Avery Low", [cert("2035-01"), cert("2035-01"), cert("2020-01")]), person("b", "Blake Zero", [cert("2020-01")])];
  const { host, unmount } = await mount(RosterMembers, rosterProps(members));
  const t = norm(host.textContent);
  ok("Roster: the spotlight is renamed '✦ CERT LEADER' (no 'READINESS LEADER')", t.includes("CERT LEADER") && !t.includes("READINESS LEADER"));
  ok("Roster: nobody under 75% current is highlighted — 'No one at 75%+ yet'", t.includes("No one at 75%+ yet") && !/CERT LEADER.{0,60}(Avery Low|Blake Zero)/.test(t), t.match(/CERT LEADER.{0,80}/)?.[0]);
  await unmount(); }
{ // exactly 75% (3 of 4) qualifies; the 100% member wins
  const members = [person("a", "Avery Three", [cert("2035-01"), cert("2035-01"), cert("2035-01"), cert("2020-01")]), person("c", "Casey Full", [cert("2035-01"), cert("2035-01")])];
  const { host, unmount } = await mount(RosterMembers, rosterProps(members));
  ok("Roster: at 75%+ the highest is highlighted (Casey Full, 100%)", /CERT LEADER.{0,80}Casey Full/.test(norm(host.textContent)), norm(host.textContent).match(/CERT LEADER.{0,80}/)?.[0]);
  await unmount(); }
{ const members = [person("a", "Avery Three", [cert("2035-01"), cert("2035-01"), cert("2035-01"), cert("2020-01")])];
  const { host, unmount } = await mount(RosterMembers, rosterProps(members));
  ok("Roster: exactly 75% current qualifies (the bar is ≥ 75)", /CERT LEADER.{0,80}Avery Three/.test(norm(host.textContent)));
  await unmount(); }

// ---------------------------------------------------------------- 6. RosterAttendance, rendered
{ // 4 counting drills in the last 90 days: Ava 4/4 (100%), Ben 2/4 (50%), Cam 0/4 (0%), Dee 3/4 (75%)
  const d = (daysAgo) => { const x = new Date(); x.setDate(x.getDate() - daysAgo); return { y: x.getFullYear(), m: x.getMonth(), d: x.getDate() }; };
  const sess = (id, daysAgo, attendance) => ({ id, ...d(daysAgo), done: true, audience: "everyone", attendance, title: `Drill ${id}` });
  const members = [person("ava", "Ava Hundred", []), person("ben", "Ben Fifty", []), person("cam", "Cam Zero", []), person("dee", "Dee Seventyfive", [])];
  const sessions = [sess("s1", 10, ["ava", "ben", "dee"]), sess("s2", 20, ["ava", "ben", "dee"]), sess("s3", 30, ["ava", "dee"]), sess("s4", 40, ["ava"])];
  const { host, unmount } = await mount(RosterAttendance, { S, members, sessions, plan: [] });
  // the CARD = the largest element whose text starts with its heading and doesn't run into the other card
  const card = (head, other) => [...host.querySelectorAll("*")].map((n) => norm(n.textContent))
    .filter((t) => t.startsWith(head) && !t.includes(other)).sort((a, b) => b.length - a.length)[0] || "";
  const strong = card("Showing up strong", "Needs a nudge");
  const nudge = card("Needs a nudge", "Showing up strong");
  ok("RosterAttendance: the nudge list holds the 0% and 50% members", nudge.includes("Cam Zero") && nudge.includes("Ben Fifty"), nudge.slice(0, 160));
  ok("RosterAttendance: 'Showing up strong' never lists the 0% member", strong.length > 0 && !strong.includes("Cam Zero"), strong.slice(0, 160));
  ok("RosterAttendance: 'Showing up strong' never lists someone also under 'Needs a nudge'", !strong.includes("Ben Fifty"), strong.slice(0, 160));
  ok("RosterAttendance: the strong members are still there (Ava 100%, Dee 75%)", strong.includes("Ava Hundred") && strong.includes("Dee Seventyfive"));
  await unmount(); }

// ---------------------------------------------------------------- 2 · 4 · 7 · 8. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const dig = readFileSync(join(root, "api/digest.js"), "utf8");
const body = (s, name) => { const i = s.indexOf(`function ${name}(`); if (i < 0) return ""; let j = s.indexOf("\nfunction ", i + 10); const k = s.indexOf("\n  async function ", i + 10); return s.slice(i, j); };
const fnIn = (s, name) => { const i = s.indexOf(`async function ${name}(`); if (i < 0) return ""; const j = s.indexOf("\n  }\n", i); return s.slice(i, j); };
ok("PIN: App.jsx imports shiftSpan + shiftHoursText from ../shared/shift-span.js", /import \{ shiftSpan, shiftHoursText \} from "\.\.\/shared\/shift-span\.js";/.test(src));
const report = body(src, "StationHoursReport"), mine = body(src, "StationHours");
const SITES = [
  ["StationHoursReport · day detail", report, "shiftHoursText(x.checked_in_at, x.checked_out_at, `${h1(x.hours)} h`)"],
  ["StationHoursReport · shift log", report, "shiftHoursText(s.checked_in_at, s.checked_out_at, h1(s.hours))"],
  ["StationHours · recent shifts", mine, "shiftHoursText(s.checked_in_at, s.checked_out_at, `${h1n(s.hours)} h`)} · {s.kind"],
  ["StationHours · full list", mine, "shiftHoursText(s.checked_in_at, s.checked_out_at, `${h1n(s.hours)} h`)}</span>"],
];
for (const [label, b, needle] of SITES) ok(`PIN: ${label} prints its hours through shiftHoursText`, b.includes(needle));
ok("PIN: no shift row prints raw hours any more ({h1(x.hours)} h · {h1(s.hours)}</td> · {h1n(s.hours)} h)",
  !/(?<!\$)\{h1\(x\.hours\)\} h/.test(report) && !report.includes(">{h1(s.hours)}</td>") && !/(?<!\$)\{h1n\(s\.hours\)\} h/.test(mine));   // (?<!\$): the `${…} h` inside shiftHoursText is the allowed form
const RULE = "if (when <= new Date(r.checked_in_at) || when > new Date()) {";
const cos = fnIn(report, "closeOpenShift"), co = fnIn(report, "confirmOut");
ok("closeOpenShift checks end > start and ≤ now BEFORE closeShiftAt (inline, no RPC)", cos.includes(RULE) && cos.indexOf(RULE) < cos.indexOf("closeShiftAt("));
ok("confirmOut checks end > start and ≤ now BEFORE resolve_auto_closed_shift", co.includes(RULE) && co.indexOf(RULE) < co.indexOf('rpc("resolve_auto_closed_shift"'));
ok("checkOut's rule is the one mirrored (unchanged)", fnIn(report, "checkOut").includes("if (when <= inAt || when > new Date())"));
ok("digest: apparatus read filters retired rigs (deleted_at IS NULL)", dig.includes('sb.from("apparatus").select("department_id, in_service").is("deleted_at", null)'));
// The DELTA fences are PINNED to WS-4a's own code commit (cc719d6, parent dfd9866; released in industrial-noir-37):
// "vs origin/main" goes red once the slice is on main. The structural guards above still read today's tree.
const REL = "cc719d6";
const BASE = `${REL}^1`;
const all = execSync(`git diff --name-only ${BASE} ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
ok("WS-4a (cc719d6) changed only src/App.jsx, api/digest.js and shared/shift-span.js (runtime) vs its parent", JSON.stringify(all) === JSON.stringify(["api/digest.js", "shared/shift-span.js", "src/App.jsx"]), JSON.stringify(all));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token counts unchanged (App.jsx 132 · digest.js 32 · assistant.js 14)", tok(src) === 132 && tok(dig) === 32 && tok(readFileSync(join(root, "api/assistant.js"), "utf8")) === 14, `${tok(src)} · ${tok(dig)}`);
const added = execSync(`git diff ${BASE} ${REL} -- src api`, { cwd: root }).toString().split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
ok("WS-4a (cc719d6) added no station_presence write (or read)",!added.some((l) => l.includes("station_presence")));
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
