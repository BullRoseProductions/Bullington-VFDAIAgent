// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/spotlight_responder_test.mjs
// No network, no DB. The roster's Crew Spotlight "Most sessions · 90 days" card (triage 2026-11-15: a real 11–11 tie shown
// as one name, picked by the roster's load order; and board meetings counted that the rate drops). Rulings:
//   (1) the card counts with the rate's session rule (shared/attendance.js deptAttendance → topAttender)
//   (2) a two-way tie shows both surnames, "N each"; three or more show the leader by most recent attendance + "+N tied";
//       deterministic, and a roster shuffle must not change it (binding)
// Sections:
//   1. the tie fixture (the triage's shape: 12 sessions, A and B 11 each, A's unique session the latest) — helper + card
//   2. the board-meeting fixture: board / leadership / optional / cancelled / no-roll sessions never count
//   3. three-way tie → leader by most recent attendance + "+2 tied"; single leader; nobody; join-date cutoff
//   4. SHUFFLE (binding): 300 roster + session permutations, helper output and rendered card text identical every time
//   5. mutations: each rule removed from a copy of the helper / the card must turn a check red
//   6. fences: only src/App.jsx, shared/attendance.js, this test changed vs origin/main 49954b3; verified 132/32/14;
//      Notify held; api/_cron.js untouched; the other two spotlight cards unchanged
// Fixture dates are relative to today (inside the rolling 90-day window, never a fixed day of the month).
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = process.env.BASE ?? "49954b3";   // origin/main when this slice was built
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/", width: 1200, height: 900 });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    function q() { const b = {}; for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "maybeSingle", "single", "insert", "update", "delete", "upsert"]) b[m] = () => b;
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej); return b; }
    export const supabase = { from: q, rpc: () => ({ then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej) }),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
async function bundle(appSource) {
  const out = join(mkdtempSync(join(tmpdir(), "b4c-spot-")), "app.under-test.mjs");
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
      b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
      b.onLoad({ filter: /src[\\/]App\.jsx$/ }, () => ({ contents: appSource + `\nexport { RosterMembers, baseStyles };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
    } }],
  });
  return import(pathToFileURL(out).href);
}
const APP_SRC = readFileSync(join(root, "src/App.jsx"), "utf8");
const app = await bundle(APP_SRC);
const { topAttender } = await import(pathToFileURL(join(root, "shared/attendance.js")).href);

// ---------------------------------------------------------------- fixtures (placeholder names only)
const dayAgo = (n) => { const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - n); return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() }; };
let sid = 0;
const sess = (ago, attendance, extra = {}) => ({ id: `s${++sid}`, ...dayAgo(ago), done: true, status: "scheduled", audience: "everyone", countsAttendance: true, isMeeting: false, attendance, ...extra });
const mem = (id, name, extra = {}) => ({ id, name, role: "Firefighter", access: ["Member"], status: "Active", joined: "2015", certs: [], phone: "—", email: `${id}@example.test`, ...extra });
const A = mem("m-a", "Alex Able"), B = mem("m-b", "Blair Baker"), C = mem("m-c", "Casey Cole"), D = mem("m-d", "Drew Dunn"), E = mem("m-e", "Emery Ellis");
const range90 = () => { const iso = (o) => `${o.y}-${String(o.m + 1).padStart(2, "0")}-${String(o.d).padStart(2, "0")}`; return { from: iso(dayAgo(90)), to: iso(dayAgo(0)) }; };

// 1. the triage's shape: 12 sessions; A misses the oldest (B alone there), B misses the newest (A alone) → 11–11, A's last = newest.
const ages = [80, 80, 79, 66, 59, 52, 43, 38, 36, 29, 22, 10];
const TIE = ages.map((ago, i) => sess(ago, i === 0 ? [B.id, C.id] : i === ages.length - 1 ? [A.id, C.id] : [A.id, B.id, ...(i % 2 ? [C.id] : [])]));
const TIE_ROSTER = [B, C, A, D];   // B FIRST — the old card's pick() kept the first in array order

// 2. board meetings etc.: E 12 regular + 2 board; D 12 regular. Under the old card E was sole leader at 14.
const reg = Array.from({ length: 12 }, (_, i) => sess(70 - i * 5, [D.id, E.id]));
const BOARD = [...reg,
  sess(65, [E.id], { audience: "board" }), sess(33, [E.id], { audience: "board" }),
  sess(31, [E.id], { audience: "leadership" }), sess(30, [E.id], { countsAttendance: false }),
  sess(28, [E.id], { status: "cancelled" }), sess(27, [E.id], { done: false }), sess(120, [E.id, E.id])];

// ---------------------------------------------------------------- render helper
const { RosterMembers, baseStyles, createRoot, act, React } = app;
const S = baseStyles();
const host = document.createElement("div"); document.body.appendChild(host);
let rootR = null;
async function card(members, sessions, mod = app) {
  if (rootR) await act(async () => rootR.unmount());
  rootR = mod.createRoot(host);
  await mod.act(async () => rootR.render(mod.React.createElement(mod.RosterMembers, { S: mod.baseStyles(), role: ["Department Admin"], members, setMembers: () => {}, onOpen: () => {}, notify: () => {}, dept: { name: "Test" }, sessions, bandEl: null })));
  const label = [...host.querySelectorAll("span")].find((e) => e.textContent === "▲ TOP RESPONDER");
  return label ? label.parentElement.textContent.replace(/\s+/g, " ").trim() : null;
}

// ---------------------------------------------------------------- 1 the tie
const t1 = topAttender(TIE_ROSTER, TIE, range90());
ok("1a helper: two-way tie at 11 (A and B), nobody hidden", t1?.n === 11 && t1.tied.length === 2 && t1.tied.map((t) => t.id).sort().join() === "m-a,m-b", JSON.stringify(t1));
ok("1b helper: A first — most recent counted attendance (the newest session), not roster order (B was first)", t1?.tied[0].id === "m-a" && t1.tied[0].lastISO > t1.tied[1].lastISO);
const c1 = await card(TIE_ROSTER, TIE);
ok("1c card: both surnames \"Able · Baker\", 11, \"sessions each\", \"Tied for most\"", /Able · Baker/.test(c1) && /11 ?sessions each/.test(c1) && /Tied for most/.test(c1), c1);
ok("1d card: neither full name alone (the old card showed only the first in roster order)", !/Blair Baker/.test(c1) && !/Alex Able/.test(c1));

// ---------------------------------------------------------------- 2 board meetings and the rest
const t2 = topAttender([E, D], BOARD, range90());
ok("2a helper: board / leadership / optional / cancelled / unfinalized / outside-window never count → D and E tie at 12", t2?.n === 12 && t2.tied.length === 2, JSON.stringify(t2));
const oldRule = (roster, sessions) => { const s90 = new Date(); s90.setDate(s90.getDate() - 90); const done = sessions.filter((x) => x.done && new Date(x.y, x.m, x.d) >= s90);
  return roster.map((m) => [m.id, done.filter((x) => (x.attendance || []).includes(m.id)).length]); };
ok("2b differential: the OLD card's rule counted E at 17 here (the inflation this slice removes)", JSON.stringify(oldRule([E], BOARD)) === JSON.stringify([["m-e", 17]]), JSON.stringify(oldRule([E], BOARD)));
const c2 = await card([E, D], BOARD);
ok("2c card: shows the 12–12 tie, not E at 14+", /Dunn · Ellis|Ellis · Dunn/.test(c2) && /12/.test(c2) && !/1[3-9]/.test(c2), c2);
const t2b = topAttender([E, D], [...reg, sess(5, [E.id])], range90());
ok("2d helper: one more REGULAR session does make E the sole leader at 13", t2b?.n === 13 && t2b.tied.length === 1 && t2b.tied[0].id === "m-e");

// ---------------------------------------------------------------- 3 three-way, single, nobody, join cutoff
const THREE = [sess(60, [A.id, B.id, C.id]), sess(40, [A.id, B.id, C.id]), sess(20, [B.id]), sess(19, [C.id]), sess(18, [A.id]), sess(17, [D.id])];
const t3 = topAttender([A, B, C, D], THREE, range90());
ok("3a helper: three-way tie at 3, ordered A (newest), C, B", t3?.n === 3 && t3.tied.map((t) => t.id).join() === "m-a,m-c,m-b", JSON.stringify(t3?.tied.map((t) => t.id)));
const c3 = await card([C, B, D, A], THREE);
ok("3b card: three or more → the leader's full name + \"+2 tied\", \"sessions attended\"", /Alex Able/.test(c3) && /\+2 tied/.test(c3) && /sessions attended/.test(c3) && !/each/.test(c3), c3);
const c3b = await card([A, B, D], [...THREE, sess(3, [B.id])]);
ok("3c card: a sole leader shows their name and rank, no tie text", /Blair Baker/.test(c3b) && /Firefighter/.test(c3b) && !/tied|Tied|each/.test(c3b), c3b);
const c3c = await card([A, B], [sess(10, [], {}), sess(200, [A.id])]);
ok("3d card: nobody attended in the window → \"Not enough data yet\"", /Not enough data yet/.test(c3c), c3c);
const late = mem("m-l", "Lee Late", { joinedOn: (() => { const r = range90(); return r.to; })() });
const t3e = topAttender([late, D], [sess(30, [late.id, D.id]), sess(20, [late.id, D.id]), sess(10, [D.id])], range90());
ok("3e helper: a session before a member's join date is not theirs (the rate's join cutoff) → D sole leader", t3e?.tied.length === 1 && t3e.tied[0].id === "m-d" && t3e.n === 3);
const inactive = mem("m-i", "Ira Idle", { status: "Inactive" });
const c3f = await card([inactive, A], [sess(10, [inactive.id, A.id]), sess(9, [inactive.id])]);
ok("3f card: an Inactive member is never the top responder (who is shown is unchanged)", /Alex Able/.test(c3f) && !/Idle/.test(c3f), c3f);

// ---------------------------------------------------------------- 4 SHUFFLE (binding)
let seed = 20261115; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fixtures = [["tie", [A, B, C, D], TIE], ["board", [D, E], BOARD], ["three", [A, B, C, D], THREE]];
let helperSame = true, helperRuns = 0;
for (const [, roster, sessions] of fixtures) {
  const want = JSON.stringify(topAttender(roster, sessions, range90()));
  for (let i = 0; i < 100; i++) { helperRuns++; if (JSON.stringify(topAttender(shuffle(roster), shuffle(sessions), range90())) !== want) helperSame = false; }
}
ok(`4a helper: ${helperRuns} roster + session shuffles, output identical every time`, helperSame && helperRuns === 300);
let cardSame = true, cardRuns = 0;
for (const [, roster, sessions] of fixtures) {
  const want = await card(roster, sessions);
  for (let i = 0; i < 10; i++) { cardRuns++; if ((await card(shuffle(roster), shuffle(sessions))) !== want) cardSame = false; }
}
ok(`4b card: ${cardRuns} shuffled renders, card text identical every time`, cardSame);
const sameName = [mem("m-z", "Sam Same"), mem("m-y", "Sam Same")];
const tSame = [sess(10, ["m-z", "m-y"])];
ok("4c helper: same count, same last date, same name → id breaks it (fully deterministic)", [0, 1, 2, 3].every(() => topAttender(shuffle(sameName), tSame, range90()).tied[0].id === "m-y"));

// ---------------------------------------------------------------- 5 mutations
const ATT = readFileSync(join(root, "shared/attendance.js"), "utf8");
const dir = mkdtempSync(join(tmpdir(), "b4c-spot-mut-"));
writeFileSync(join(dir, "roles.js"), readFileSync(join(root, "shared/roles.js"), "utf8"));
let mi = 0;
async function helperWith(from, to) {
  if (!ATT.includes(from)) return null;
  const f = join(dir, `attendance.m${++mi}.js`); writeFileSync(f, ATT.replace(from, to));
  return (await import(pathToFileURL(f).href)).topAttender;
}
const caught = async (name, from, to, check) => { const h = await helperWith(from, to); ok(`5 mutation caught: ${name}`, h !== null && !check(h), h === null ? "(mutation text not found)" : ""); };
const tieOK = (h) => { const r = h(shuffle(TIE_ROSTER), TIE, range90()); return r?.n === 11 && r.tied.length === 2 && r.tied[0].id === "m-a"; };
const boardOK = (h) => { const r = h([E, D], BOARD, range90()); return r?.n === 12 && r.tied.length === 2; };
const shuffleOK = (h) => { const w = JSON.stringify(h([A, B, C, D], THREE, range90())); return [1, 2, 3, 4, 5, 6].every(() => JSON.stringify(h(shuffle([A, B, C, D]), shuffle(THREE), range90())) === w); };
await caught("no countsTowardRate in the rule (board meetings count)", "const live = (s) => s.done && !isCancelled(s) && inScope(s) && countsTowardRate(s);", "const live = (s) => s.done && !isCancelled(s) && inScope(s);", boardOK);
await caught("cancelled sessions count", "s.done && !isCancelled(s) && inScope(s)", "s.done && inScope(s)", boardOK);
await caught("ties collapsed to the first in array order", "const tied = rows.filter((r) => r.attended === n)", "const tied = rows.filter((r) => r.attended === n).slice(0, 1)", tieOK);
await caught("no sort (roster order decides)", ".sort((a, b) => cmp(b.lastISO, a.lastISO) || cmp(String(a.name || \"\"), String(b.name || \"\")) || cmp(String(a.id), String(b.id)));", ";", shuffleOK);
await caught("oldest-first tie-break", "cmp(b.lastISO, a.lastISO)", "cmp(a.lastISO, b.lastISO)", tieOK);
const appCaught = async (name, from, to, check) => {
  if (!APP_SRC.includes(from)) { ok(`5 mutation caught: ${name}`, false, "(mutation text not found)"); return; }
  const m = await bundle(APP_SRC.replace(from, to));
  const text = await card(TIE_ROSTER, TIE, m);
  ok(`5 mutation caught: ${name}`, !check(text), text);
  await m.act(async () => rootR.unmount()); rootR = null;
};
const cardTieOK = (t) => /Able · Baker/.test(t) && /11/.test(t) && /sessions each/.test(t);
await appCaught("card back on the old rule (first in roster order)", "const resp = top ? { m: activeRoster.find((m) => m.id === top.tied[0].id), v: top.n, tied: top.tied } : null;",
  "const resp = top ? { m: activeRoster.find((m) => m.id === top.tied[0].id), v: top.n, tied: top.tied.slice(0, 1) } : null;", cardTieOK);
await appCaught("two-way tie shows one name", "resp.tied.length === 2 ? resp.tied.map((t) => surname(t.name)).join(\" · \") : resp.m.name", "resp.m.name", cardTieOK);
await appCaught("\"each\" dropped from a two-way tie", "resp && resp.tied.length === 2 ? \"sessions each\" : \"sessions attended\"", "\"sessions attended\"", cardTieOK);

// ---------------------------------------------------------------- 6 fences
const changed = [...new Set([
  ...execSync(`git diff --name-only ${BASE}`, { cwd: root }).toString().trim().split("\n"),
  ...execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n"),
].filter(Boolean))];
const allowed = ["src/App.jsx", "shared/attendance.js", "docs/review/spotlight_responder_test.mjs"];
ok(`6a only ${allowed.join(", ")} changed vs ${BASE} — no SQL / API / vercel.json`, changed.every((p) => allowed.includes(p)), JSON.stringify(changed.filter((p) => !allowed.includes(p))));
const tok = (p) => (readFileSync(join(root, p), "utf8").match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("6b verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("6c Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
ok("6d api/_cron.js untouched", execSync(`git diff --name-only ${BASE} -- api/_cron.js`, { cwd: root }).toString().trim() === "");
ok("6e the other two spotlight cards are unchanged (milestone + cert leader lines)", APP_SRC.includes('{spot("vet", "★ MILESTONE", "Service milestone", vet, vet ? vet.v : null, vet && vet.v === 1 ? "year of service" : "years of service", true)}')
  && APP_SRC.includes("const lead = pick(activeRoster, (m) => { const c = compliance(m); return c == null || c < CERT_LEADER_FLOOR ? null : c * 1000 + (m.certs || []).length; });"));
if (rootR) await act(async () => rootR.unmount());
process.exit(process.exitCode || 0);
