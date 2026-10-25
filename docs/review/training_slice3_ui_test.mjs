// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_slice3_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes) and checks Training Overhaul Slice 3 — the leader Sessions "Show" filter (rulings:
// claude/B4C_TrainingOverhaul_Slice3_Step0_ReviewRecord.md):
//   1. default "Calendar month": unchanged — the calendar month's sessions (done AND upcoming), day order, title
//      "Sessions · <Month Year>", Edit sessions available
//   2. each named filter (this month / last month / this year): DONE sessions only, in the period, newest first, grouped
//      under month headers (newest month first), leadership / board events included; title "Completed · …" + count;
//      the calendar keeps showing its month
//   3. custom range: Month + Year From / To, inclusive whole months; Apply disabled (with a note) until From ≤ To; the
//      empty state names the range
//   4. snap-back to "Calendar month" on the calendar's ← / →, the hero's goToNext, and the status strip's Schedule
//   5. the row label is the session's own month (+ the year when it isn't this year) — in the filtered view AND in the
//      default view (the calendar walked back to last December)
//   6. the source: only src/App.jsx changed; no new RPC; the row label no longer reads cur.m; verified unchanged; Notify held
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
      const b = { _t: table };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "not", "maybeSingle", "single"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { st.writes.push({ table, op: m, args }); return b; };
      b.then = (res, rej) => Promise.resolve(st.table(table)).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ts3-")), "app.under-test.mjs");
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

// ---- fixtures, all relative to today (the expected sets are computed from the same rules below, never hard-coded months)
const now = new Date(), Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ym = (k, day) => { const d = new Date(Y, M + k, day); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }; };
const sess = (id, title, when, extra = {}) => ({ id, title, ...when, done: false, plans: [], attendance: [], signinOpen: false, audience: "everyone", planId: null, ...extra });
const done = { done: true, attendance: ["m-ada"] };
const SESS = [
  sess("tm-done-a", "This month done A", ym(0, 1), done), sess("tm-done-b", "This month done B", ym(0, Math.min(D, 2)), done),
  sess("tm-up", "This month upcoming", ym(0, D), { done: false }),                          // today, not done — the hero's next session
  sess("lm-done", "Last month done", ym(-1, 10), done), sess("lm-board", "Last month board meeting", ym(-1, 20), { ...done, audience: "board" }),
  sess("lm-open", "Last month never closed", ym(-1, 15), { done: false }),
  sess("m2-done", "Two months ago done", ym(-2, 8), done),
  sess("py-dec", "Last December done", { y: Y - 1, m: 11, d: 5 }, done),
  sess("nx-up", "Next month upcoming", ym(1, 12), { done: false }),
];
const PLAN = [{ id: "p1", name: "Ladder operations", cadence: "Monthly", color: "#C8323A", lastISO: null }];
const MEMBERS = [{ id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-mo", name: "Mo Member", status: "Active", access: ["Member"] }];
globalThis.__sb = { calls: [], writes: [], table: () => ({ data: [], error: null }), answer: () => ({ data: null, error: null }) };
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const btns = (h, t) => [...h.querySelectorAll("button")].filter((b) => norm(b.textContent) === t || norm(b.textContent).startsWith(t));
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const choose = (sel, v) => act(async () => { Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value").set.call(sel, String(v)); sel.dispatchEvent(new win.Event("change", { bubbles: true })); });
async function mount(sessions = SESS) {
  globalThis.__sb.calls = []; globalThis.__sb.writes = [];
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role: ["Department Admin"], plan: PLAN, setPlan: () => {}, loadPlans: () => {}, sessions, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId: "m-ada", notify: () => {}, dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer: false, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const showSel = (h) => h.querySelector('select[aria-label="Show"]');
// the Sessions card = the card whose head carries the Show select
const card = (h) => showSel(h).closest("div[style]").parentElement.closest("div[style]");
const rowIds = (h) => [...card(h).querySelectorAll('[id^="ts-"]')].map((e) => e.id.slice(3));
// a month header = a div of exactly two spans: "<Month YYYY>" and "<N> completed"
const headers = (h) => [...card(h).querySelectorAll("div")].filter((d) => d.children.length === 2 && [...d.children].every((c) => c.tagName === "SPAN")
  && /^[A-Z][a-z]+ \d{4}$/.test(norm(d.children[0].textContent)) && /^\d+ completed$/.test(norm(d.children[1].textContent))).map((d) => norm(d.children[0].textContent));
const titleOf = (h) => norm(card(h).textContent).slice(0, 80);
const sdate = (s) => new Date(s.y, s.m, s.d);
const expectFor = (lo, hi, capToday) => SESS.filter((s) => s.done && (s.y * 12 + s.m) >= lo && (s.y * 12 + s.m) <= hi && (!capToday || sdate(s) <= now)).sort((a, b) => sdate(b) - sdate(a)).map((s) => s.id);
const T = Y * 12 + M;

// 1 default — the calendar month, unchanged
{ const { host, unmount } = await mount();
  const want = SESS.filter((s) => s.y === Y && s.m === M).sort((a, b) => a.d - b.d).map((s) => s.id);
  ok("default \"Calendar month\": Show = month; the calendar month's sessions, done AND upcoming, day order", showSel(host).value === "month" && JSON.stringify(rowIds(host)) === JSON.stringify(want), JSON.stringify(rowIds(host)));
  ok("default title \"Sessions · <Month Year>\" + Edit sessions", titleOf(host).startsWith(`Sessions · ${MON[M]} ${Y}`) && btns(card(host), "Edit sessions").length === 1, titleOf(host));
  unmount(); }

// 2 the named filters
for (const [val, label, lo, hi, capToday] of [["thisMonth", "this month", T, T, false], ["lastMonth", "last month", T - 1, T - 1, false], ["thisYear", "this year", Y * 12, T, true]]) {
  const { host, unmount } = await mount();
  await choose(showSel(host), val); await tick();
  const want = expectFor(lo, hi, capToday), got = rowIds(host);
  const wantHeads = [...new Set(want.map((id) => { const s = SESS.find((x) => x.id === id); return `${MON[s.m]} ${s.y}`; }))];
  ok(`Completed ${label}: done only, in the period, newest first`, JSON.stringify(got) === JSON.stringify(want) && got.every((id) => SESS.find((s) => s.id === id).done), JSON.stringify(got));
  ok(`Completed ${label}: grouped under month headers, newest month first; title "Completed · ${label}" + count`, JSON.stringify(headers(host)) === JSON.stringify(wantHeads) && titleOf(host).startsWith(`Completed · ${label}${want.length}`),
    JSON.stringify({ heads: headers(host), title: titleOf(host) }));
  if (val === "lastMonth") ok("…a board event is included (as the leader list always has); a never-closed session is not", got.includes("lm-board") && !got.includes("lm-open"));
  ok(`Completed ${label}: the calendar keeps its month; no Edit sessions in a done-only view`, norm(host.textContent).includes(`${MON[M]} ${Y}`) && btns(card(host), "Edit sessions").length === 0);
  unmount();
}
{ const empty = SESS.filter((s) => !(s.done && s.y === Y && s.m === M));
  const { host, unmount } = await mount(empty);
  await choose(showSel(host), "thisMonth"); await tick();
  ok("empty state: \"No completed sessions this month.\"", norm(card(host).textContent).includes("No completed sessions this month.") && rowIds(host).length === 0);
  unmount(); }

// 3 custom range
{ const { host, unmount } = await mount();
  await choose(showSel(host), "custom"); await tick();
  const sel = (l) => card(host).querySelector(`select[aria-label="${l}"]`);
  const apply = () => btns(card(host), "Apply")[0];
  ok("custom: Month + Year From / To pickers inline, nothing listed until Apply", !!sel("From month") && !!sel("From year") && !!sel("To month") && !!sel("To year") && norm(card(host).textContent).includes("Pick a From and To month, then Apply.") && rowIds(host).length === 0);
  await choose(sel("From year"), Y); await choose(sel("From month"), M); await choose(sel("To year"), Y - 1); await choose(sel("To month"), 11); await tick();
  ok("custom: From after To -> Apply disabled + \"From must be on or before To.\"", apply().disabled && norm(card(host).textContent).includes("From must be on or before To."));
  await choose(sel("From year"), Y - 1); await choose(sel("From month"), 11); await tick();
  ok("custom: From = To (one whole month) -> Apply enabled", !apply().disabled);
  await click(apply()); await tick();
  ok("custom Dec – Dec of last year (inclusive whole month): last December's done session, labelled with its year", JSON.stringify(rowIds(host)) === JSON.stringify(["py-dec"]) && titleOf(host).startsWith(`Completed · Dec ${Y - 1} – Dec ${Y - 1}`)
    && norm(card(host).textContent).includes(`DEC ’${String(Y - 1).slice(2)}`) && norm(card(host).textContent).includes(`Dec 5, ${Y - 1}`), titleOf(host));
  await choose(sel("From year"), Y - 1); await choose(sel("From month"), 11); await choose(sel("To year"), Y); await choose(sel("To month"), M); await tick();
  await click(apply()); await tick();
  ok("custom Dec last year – this month (inclusive): every done session in range, newest first", JSON.stringify(rowIds(host)) === JSON.stringify(expectFor((Y - 1) * 12 + 11, T, false)), JSON.stringify(rowIds(host)));
  await choose(sel("From year"), Y - 1); await choose(sel("From month"), 0); await choose(sel("To year"), Y - 1); await choose(sel("To month"), 1); await tick();
  await click(apply()); await tick();
  ok("custom empty state names the range", norm(card(host).textContent).includes(`No completed sessions between Jan ${Y - 1} and Feb ${Y - 1}.`));
  unmount(); }

// 4 snap-back
{ const { host, unmount } = await mount();
  await choose(showSel(host), "thisYear"); await tick();
  await click(host.querySelector('button[aria-label="Next month"]')); await tick();
  const n = ym(1, 1);
  ok("snap-back: the calendar's → returns the list to \"Calendar month\" (next month's sessions)", showSel(host).value === "month" && titleOf(host).startsWith(`Sessions · ${MON[n.m]} ${n.y}`) && rowIds(host).includes("nx-up"), titleOf(host));
  unmount(); }
{ const off = SESS.map((s) => (s.id === "tm-up" ? { ...s, isOffsite: true, locLat: null, locLng: null } : s));
  const { host, unmount } = await mount(off);
  await choose(showSel(host), "lastMonth"); await tick();
  await click(btns(host, "QR sign-in")[0]); await tick();       // hero QR, off-site with no location -> goToNext + the row's panel
  ok("snap-back: the hero's goToNext returns the list to \"Calendar month\" so #ts-<next> exists", showSel(host).value === "month" && rowIds(host).includes("tm-up"));
  unmount(); }
{ const { host, unmount } = await mount();
  await choose(showSel(host), "thisYear"); await tick();
  await click(btns(host, "Schedule").find((b) => norm(b.textContent) === "Schedule" && !b.hasAttribute("aria-pressed"))); await tick();
  ok("snap-back: the status strip's Schedule returns the list to \"Calendar month\"", showSel(host).value === "month" && titleOf(host).startsWith("Sessions · "));
  unmount(); }

// 5 the row label in the DEFAULT view: walk the calendar back to last December
{ const { host, unmount } = await mount();
  for (let k = 0; k < M + 1; k++) { await click(host.querySelector('button[aria-label="Previous month"]')); await tick(); }
  const t = norm(card(host).textContent);
  ok("default view, last December: the row reads its own month + year (DEC ’yy · Dec 5, yyyy)", titleOf(host).startsWith(`Sessions · December ${Y - 1}`) && JSON.stringify(rowIds(host)) === JSON.stringify(["py-dec"]) && t.includes(`DEC ’${String(Y - 1).slice(2)}`) && t.includes(`Dec 5, ${Y - 1}`), titleOf(host));
  unmount(); }
{ const { host, unmount } = await mount();
  const t = norm(card(host).textContent);
  ok("default view, this month: no year on this year's rows", t.includes(`${MON[M].slice(0, 3).toUpperCase()}`) && !t.includes(`, ${Y}`) && !t.includes(`’${String(Y).slice(2)}`));
  unmount(); }

// 6 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime)", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
ok("no new RPC", [...rpcSet(src)].every((n) => rpcSet(main).has(n)), JSON.stringify([...rpcSet(src)].filter((n) => !rpcSet(main).has(n))));
ok("the Sessions row label reads the session's month (no TRAIN_MONTHS[cur.m] in the row)", !src.includes("TRAIN_MONTHS[cur.m].slice(0, 3).toUpperCase()") && !src.includes("{TRAIN_MONTHS[cur.m].slice(0, 3)} {s.d}") && src.includes("{TRAIN_MONTHS[s.m].slice(0, 3)} {s.d}"));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(main), `${tok(src)} vs ${tok(main)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
