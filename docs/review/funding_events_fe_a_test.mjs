// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/funding_events_fe_a_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for
// in-memory fakes), mounts the Funding hub in happy-dom and checks FE-A
// (claude/B4C_FundingEvents_Redesign_Step0_ReviewRecord.md — FE1, FE1.n, FE2 top-level kind):
//   1. the hub: the events calendar sits under the stat chips and above the Funds / Fundraisers / Donation tracker cards
//      (canManage layout); "Funding calendar ›" is now "All fundraisers ›"; kicker FUNDING & EVENTS
//   2. who sees it: everyone who reaches Funding — DA / Officer get Add, Board + Project Admin see it read-only;
//      the Project Admin keeps the tile layout with the calendar above it
//   3. the Fundraisers sub-view no longer mounts a calendar; its back button says Funding & Events; back = calendar again
//   4. the type picker: Add opens tiles, no form and no default kind; Change type returns to the tiles; Cancel closes
//   5. the source: one <EventsCalendar mount, inside Funding (not Fundraisers); nav label renamed, key unchanged;
//      only src/App.jsx changed; no new table / RPC / write; verified unchanged; Notify held back
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
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---- the fakes: every query-builder method chains, so any reader on the hub / Fundraisers resolves ----
const MOCKS = {
  supabase: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    const result = (v) => ({ then: (res, rej) => Promise.resolve(v).then(res, rej) });
    function q(table) {
      const b = { _t: table, _op: "select" };
      const chain = new Proxy(b, { get(t, k) {
        if (k === "then") return (res, rej) => { st.calls.push({ table, op: t._op, row: t._row }); return Promise.resolve(st.answer(t)).then(res, rej); };
        if (k === "insert" || k === "update" || k === "upsert") return (row) => { t._op = k; t._row = row; return chain; };
        if (k === "delete") return () => { t._op = "delete"; return chain; };
        if (k in t) return t[k];
        return () => chain;
      } });
      return chain;
    }
    export const supabase = { from: q, rpc: (n) => result({ data: n === "my_department_id" ? "dept-1" : null, error: null }),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  confirm: `
    export const confirmDestructive = async () => true;
    export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => !!globalThis.__canDeleteShared;
    export const DestructiveConfirmHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-fea-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: a.path === "sb" ? MOCKS.supabase : MOCKS.confirm, loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { Funding };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { Funding, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- data: this month, so the calendar opens on it ----
const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const FUND = [{ id: "f1", date: `${ym}-08`, title: "Pancake breakfast", color: "#CC9E52", notes: null, start_time: null, end_time: null, location_label: null, fundraiser_id: null }];
const RECR = [{ id: "r1", date: `${ym}-15`, title: "Open house", color: "#2FA869", notes: null, start_time: null, end_time: null, location_label: null }];
globalThis.__sb = { calls: [], answer: (b) => {
  if (b._op !== "select") return { data: [{ id: "x" }], error: null };
  if (b._t === "funding_events") return { data: FUND, error: null };
  if (b._t === "recruitment_events") return { data: RECR, error: null };
  return { data: [], error: null };
} };
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount(role, canDeleteShared) {
  globalThis.__canDeleteShared = canDeleteShared; globalThis.__sb.calls = []; notes.length = 0;
  try { win.sessionStorage.clear(); win.localStorage.clear(); } catch { /* fine */ }
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Funding, { S, role, notify, dept: { name: "Test VFD" }, meId: "m1", members: [] })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const norm = (s) => s.replace(/\s+/g, " ");
const text = (host) => norm(host.textContent);
const btn = (host, t) => [...host.querySelectorAll("button")].find((b) => norm(b.textContent).trim().includes(t));
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const field = (host, label) => { const l = [...host.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(label)); return l && l.querySelector("input, select, textarea"); };
const CAL = "FUNDRAISING & COMMUNITY EVENTS";
const chipCount = (host) => [...host.querySelectorAll("[title]")].filter((n) => (n.getAttribute("title") || "").includes("tap for details")).length;

// 1 + 2. the hub, per role
for (const [who, role, cds, canAdd, layout] of [
  ["Department Admin", ["Department Admin"], true, true, "overview"],
  ["Officer", ["Officer"], false, true, "overview"],
  ["Board Member", ["Board Member"], false, false, "overview"],
  ["Project Admin", ["Project Admin"], true, false, "tiles"],
]) {
  const { host, unmount } = await mount(role, cds);
  const t = text(host);
  const iCal = t.indexOf(CAL);
  ok(`${who}: the events calendar is on the hub, both tables' events on it`, iCal >= 0 && chipCount(host) === 2 && t.includes("Pancake breakfast") && t.includes("Open house"), `chips ${chipCount(host)}`);
  ok(`${who}: Add an event ${canAdd ? "shown" : "hidden"}`, !!btn(host, "Add an event") === canAdd);
  ok(`${who}: kicker reads FUNDING & EVENTS`, t.includes("FUNDING & EVENTS · Test VFD"));
  if (layout === "overview") {
    const iChips = t.indexOf("Raised this year"), iFunds = t.indexOf("Manage funds"), iFrs = t.indexOf("All fundraisers"), iTrack = t.indexOf("Donation tracker");
    ok(`${who}: under the stat chips, above Funds / Fundraisers / Donation tracker`, iChips >= 0 && iChips < iCal && iCal < iFunds && iCal < iFrs && iCal < iTrack, JSON.stringify({ iChips, iCal, iFunds, iFrs, iTrack }));
    ok(`${who}: "Funding calendar ›" is now "All fundraisers ›"`, !t.includes("Funding calendar") && !!btn(host, "All fundraisers"));
  } else {
    ok(`${who}: tile layout keeps the Fundraisers tile, calendar above it`, iCal >= 0 && t.indexOf("Plan an event with a hand from B4C") > iCal && !t.includes("Raised this year"));
  }
  unmount();
}

// 3. the Fundraisers sub-view: no calendar there any more; back returns to the hub with it
{ const { host, unmount } = await mount(["Department Admin"], true);
  await click(btn(host, "All fundraisers")); await tick(); await tick();
  ok("Fundraisers sub-view: no events calendar mounted", !text(host).includes(CAL) && chipCount(host) === 0 && !btn(host, "Add an event"));
  const back = btn(host, "Funding & Events");
  ok("Fundraisers sub-view: the back button reads Funding & Events", !!back);
  await click(back); await tick(); await tick();
  ok("back on the hub: the calendar is there again, freshly read", text(host).includes(CAL) && chipCount(host) === 2);
  unmount(); }

// 4. the type picker on the hub
{ const { host, unmount } = await mount(["Officer"], false);
  await click(btn(host, "Add an event"));
  ok("Add opens the type tiles: both kinds, no form, nothing preselected", !!btn(host, "Fundraiser event") && !!btn(host, "Community event") && !field(host, "Title") && !btn(host, "Add to") && text(host).includes("What kind of event is it?"));
  await click(btn(host, "Community event"));
  ok("picking Community event opens its form (no 'Part of a fundraiser')", !!field(host, "Title") && !field(host, "Part of a fundraiser") && !!btn(host, "Change type"));
  await click(btn(host, "Change type"));
  ok("Change type returns to the tiles", !field(host, "Title") && !!btn(host, "Fundraiser event"));
  await click(btn(host, "Fundraiser event"));
  ok("picking Fundraiser event opens its form with 'Part of a fundraiser'", !!field(host, "Title") && !!field(host, "Part of a fundraiser"));
  await click(btn(host, "Change type")); await click(btn(host, "Cancel"));
  ok("Cancel from the tiles closes the add, nothing written", !btn(host, "Fundraiser event") && globalThis.__sb.calls.every((c) => c.op === "select"));
  unmount(); }

// 5. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const BASE = "origin/main";
const base = execSync(`git show ${BASE}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const body = (s, name) => { const i = s.indexOf(`function ${name}(`); if (i < 0) return null; let j = s.indexOf("\nfunction ", i + 10); const k = s.indexOf("\nconst ", i + 10); if (k > 0 && k < j) j = k; return s.slice(i, j); };
const changed = execSync(`git diff --name-only ${BASE} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime) vs origin/main", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
ok("exactly one <EventsCalendar mount, in Funding, none in Fundraisers", (src.match(/<EventsCalendar /g) || []).length === 1 && body(src, "Funding").includes("<EventsCalendar ") && !body(src, "Fundraisers").includes("<EventsCalendar") && !strip(src).includes("fundingReloadKey"));
ok("nav: label Funding & Events, key still funding, roles still LEADERSHIP", src.includes('{ key: "funding", label: "Funding & Events", Icon: DollarSign, roles: LEADERSHIP }'));
ok("no default kind: a new add starts at kind null, and addEvent refuses an unknown kind", body(src, "EventsCalendar").includes("const blank = (day) => ({ kind: null,") && body(src, "EventsCalendar").includes("if (!EVENT_KINDS[f.kind])"));
const tables = (s) => [...new Set((s.match(/\.from\("([a-z_]+)"\)/g) || []))].sort();
const rpcs = (s) => [...new Set((s.match(/\.rpc\("([a-z_]+)"/g) || []))].sort();
ok("no new table read or RPC", JSON.stringify(tables(src)) === JSON.stringify(tables(base)) && JSON.stringify(rpcs(src)) === JSON.stringify(rpcs(base)));
const writes = (s) => (s.match(/\.(insert|update|upsert|delete)\(/g) || []).length;
ok("no new write anywhere", writes(src) === writes(base), `${writes(src)} vs ${writes(base)}`);
ok("the gates are unchanged: EventsCalendar still CANMANAGE_OPS_ROLES + useCanDeleteShared",
  body(src, "EventsCalendar").includes("const canWrite = hasAny(role, CANMANAGE_OPS_ROLES);") && body(src, "EventsCalendar").includes("const canDelete = canWrite && canDeleteShared;"));
const hex = (s) => (strip(s).match(/#[0-9A-Fa-f]{3,8}\b/g) || []).length;
ok("no new hex literal in EventsCalendar or Funding", hex(body(src, "EventsCalendar")) === hex(body(base, "EventsCalendar")) && hex(body(src, "Funding")) === hex(body(base, "Funding")));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
