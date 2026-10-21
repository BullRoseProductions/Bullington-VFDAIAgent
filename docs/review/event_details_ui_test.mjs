// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/event_details_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for
// in-memory fakes), mounts EventsCalendar in happy-dom and clicks through it. Checks:
//   1. the union: both tables load, each item tagged by kind; the chip leads with the start time; a time-less event is "All day"
//   2. the gate: Add + Edit = Department Admin / Officer (CANMANAGE_OPS_ROLES); Delete also needs the typed-delete gate
//      (DA / PA) — so DA only; a Project Admin and a plain member see neither; everyone can open the detail
//   3. the add form: the type toggle routes the insert to the right table; "Part of a fundraiser" only on Fundraiser;
//      the new fields are written; end < start is refused; a quick date-only add sends nulls
//   4. E1: edit + delete read back the row count — 0 rows is an error, never a silent success
//   5. the source: no tap-to-delete / "(tap to remove)" left; the Recruitment page no longer mounts a calendar; the
//      other readers' and the HQ writers' code is byte-identical to origin/main; no new hex; no locked token
import { mkdtempSync, readFileSync } from "fs";
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

// ---- the fakes ----
const MOCKS = {
  supabase: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    const result = (v) => ({ then: (res, rej) => Promise.resolve(v).then(res, rej) });
    function q(table) {
      const b = { _t: table, _op: "select", _f: [] };
      b.select = (cols) => { if (b._op === "select") b._cols = cols; else b._ret = cols; return b; };
      b.neq = (c, v) => { b._f.push(["neq", c, v]); return b; };
      b.eq = (c, v) => { b._f.push(["eq", c, v]); return b; };
      b.insert = (row) => { b._op = "insert"; b._row = row; return b; };
      b.update = (row) => { b._op = "update"; b._row = row; return b; };
      b.delete = () => { b._op = "delete"; return b; };
      b.then = (res, rej) => { st.calls.push({ table, op: b._op, cols: b._cols, row: b._row, filters: b._f, ret: b._ret });
        return Promise.resolve(st.answer(b)).then(res, rej); };
      return b;
    }
    export const supabase = { from: q, rpc: (n) => result({ data: n === "my_department_id" ? "dept-1" : null, error: null }) };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  confirm: `
    export const confirmDestructive = async () => true;
    export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => !!globalThis.__canDeleteShared;
    export const DestructiveConfirmHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-evd-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { EventsCalendar, MonthCalendar };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { EventsCalendar, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- data: this month, so the calendar opens on it ----
const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
const FUND = [{ id: "f1", date: `${ym}-08`, title: "Pancake breakfast", color: "#CC9E52", notes: "Bring syrup", start_time: "18:00:00", end_time: "21:00:00", location_label: "Station 20 bay", fundraiser_id: "fr1" },
              { id: "f2", date: `${ym}-12`, title: "Key date: permit", color: "#CC9E52", notes: null, start_time: null, end_time: null, location_label: null, fundraiser_id: null }];
const RECR = [{ id: "r1", date: `${ym}-15`, title: "Open house", color: "#2FA869", notes: null, start_time: "09:30:00", end_time: null, location_label: "High school gym" }];
let writeAnswer = [{ id: "x" }];
globalThis.__sb = { calls: [], answer: (b) => {
  if (b._op === "select" && b._t === "funding_events") return { data: FUND, error: null };
  if (b._op === "select" && b._t === "recruitment_events") return { data: RECR, error: null };
  if (b._op === "select" && b._t === "fundraisers") return { data: [{ id: "fr1", name: "Gear drive", target_date: null, color: "#CC9E52" }], error: null };
  if (b._op === "insert") return { data: null, error: null };
  if (b._op === "update" || b._op === "delete") return { data: writeAnswer, error: null };
  return { data: [], error: null };
} };
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });   // style bag — any key is an empty style

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount(role, canDeleteShared) {
  globalThis.__canDeleteShared = canDeleteShared; globalThis.__sb.calls = []; notes.length = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => { r.render(React.createElement(EventsCalendar, { S, role, notify })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const btn = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent.replace(/\s+/g, " ").trim().includes(text));
const chip = (host, text) => [...host.querySelectorAll("[title]")].find((n) => (n.getAttribute("title") || "").includes(text) && (n.getAttribute("title") || "").includes("tap for details"));
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = async (n, v) => act(async () => {
  const proto = n.tagName === "SELECT" ? win.HTMLSelectElement.prototype : n.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(n, v);
  n.dispatchEvent(new win.Event(n.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
});
const field = (host, label) => { const l = [...host.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(label)); return l && l.querySelector("input, select, textarea"); };
const text = (host) => host.textContent.replace(/\s+/g, " ");

// 1. the union + chips + detail
{ const { host, unmount } = await mount(["Member"], false);
  const reads = globalThis.__sb.calls.filter((c) => c.op === "select").map((c) => `${c.table}:${c.cols || ""}`);
  ok("loads both tables (+ fundraisers), with the new columns", reads.some((r) => r.startsWith("funding_events:") && r.includes("start_time, end_time, location_label") && r.includes("fundraiser_id"))
     && reads.some((r) => r.startsWith("recruitment_events:") && r.includes("start_time, end_time, location_label") && !r.includes("fundraiser_id")), JSON.stringify(reads));
  ok("chips from BOTH tables, tagged by kind", !!chip(host, "Fundraiser · Pancake breakfast") && !!chip(host, "Community event · Open house") && !!chip(host, "Fundraiser · Key date: permit"));
  ok("the chip leads with the start time; an all-day one doesn't", text(host).includes("6:00 PM · Pancake breakfast") && text(host).includes("9:30 AM · Open house") && !/\d · Key date: permit/.test(text(host)));
  ok("a member sees no Add button and no tap-to-delete wording", !btn(host, "Add an event") && !text(host).includes("tap to remove") && !text(host).includes("tap an event to remove"));
  await click(chip(host, "Pancake breakfast"));
  const d1 = text(host);
  ok("detail: kind, title, time range, location, fundraiser, notes", d1.includes("Fundraiser") && d1.includes("Pancake breakfast") && d1.includes("6:00 PM – 9:00 PM") && d1.includes("Station 20 bay") && d1.includes("Part of Gear drive") && d1.includes("Bring syrup"));
  ok("detail: a member gets no Edit / Delete", !btn(host, "Edit") && !btn(host, "Delete"));
  await click(host.querySelector('button[aria-label="Close"]'));
  await click(chip(host, "Key date: permit"));
  ok("detail: a time-less event reads All day, no location line", text(host).includes("All day") && !text(host).includes("Station 20 bay"));
  await click(host.querySelector('button[aria-label="Close"]'));
  await click(chip(host, "Open house"));
  ok("detail: community event, start only", text(host).includes("Community event") && text(host).includes("9:30 AM") && !text(host).includes("–"));
  ok("tapping never wrote anything", globalThis.__sb.calls.every((c) => c.op === "select"));
  unmount(); }

// 2. the gate
for (const [who, role, cds, add, edit, del] of [
  ["Department Admin", ["Department Admin"], true, true, true, true],
  ["Officer", ["Officer"], false, true, true, false],
  ["Project Admin (no DA / Officer)", ["Project Admin"], true, false, false, false],
  ["Board Member", ["Board Member"], false, false, false, false],
]) {
  const { host, unmount } = await mount(role, cds);
  const hasAdd = !!btn(host, "Add an event");
  await click(chip(host, "Pancake breakfast"));
  ok(`gate — ${who}: add ${add} · edit ${edit} · delete ${del}`, hasAdd === add && !!btn(host, "Edit") === edit && !!btn(host, "Delete") === del);
  unmount();
}

// 3. the add form
{ const { host, unmount } = await mount(["Officer"], false);
  await click(btn(host, "Add an event"));
  ok("add form: Fundraiser is the default and shows 'Part of a fundraiser'", !!field(host, "Part of a fundraiser"));
  await click(btn(host, "Community event"));
  ok("add form: Community event hides 'Part of a fundraiser'", !field(host, "Part of a fundraiser"));
  await setVal(field(host, "Title"), "Booth at the market");
  await setVal(field(host, "Day"), "20");
  await setVal(field(host, "Start time"), "10:00"); await setVal(field(host, "End time"), "09:00");
  await click(btn(host, "Add to"));
  ok("end before start is refused, nothing inserted", notes.some((n) => n.title === "Check the times") && !globalThis.__sb.calls.some((c) => c.op === "insert"));
  await setVal(field(host, "End time"), "13:00");
  await setVal(field(host, "Location"), "  Farmers market  "); await setVal(field(host, "Notes"), "Bring the sign-up sheet");
  await click(btn(host, "Add to")); await tick();
  const ins = globalThis.__sb.calls.find((c) => c.op === "insert");
  ok("community add -> recruitment_events with the new fields, no fundraiser_id", ins && ins.table === "recruitment_events" && ins.row.start_time === "10:00" && ins.row.end_time === "13:00"
     && ins.row.location_label === "Farmers market" && ins.row.notes === "Bring the sign-up sheet" && !("fundraiser_id" in ins.row) && ins.row.date === `${ym}-20` && ins.row.department_id === "dept-1", JSON.stringify(ins?.row));
  globalThis.__sb.calls = [];
  await click(btn(host, "Add an event"));
  await setVal(field(host, "Title"), "Raffle"); await setVal(field(host, "Part of a fundraiser"), "fr1");
  await click(btn(host, "Add to")); await tick();
  const ins2 = globalThis.__sb.calls.find((c) => c.op === "insert");
  ok("quick fundraiser add -> funding_events, fundraiser_id set, new fields null", ins2 && ins2.table === "funding_events" && ins2.row.fundraiser_id === "fr1"
     && ins2.row.start_time === null && ins2.row.end_time === null && ins2.row.location_label === null && ins2.row.notes === null, JSON.stringify(ins2?.row));
  unmount(); }

// 4. E1 — the row-count check on edit and delete
{ const { host, unmount } = await mount(["Department Admin"], true);
  await click(chip(host, "Open house")); await click(btn(host, "Edit"));
  await setVal(field(host, "Location"), "Fire hall"); await setVal(field(host, "End time"), "12:00");
  writeAnswer = [];
  await click(btn(host, "Save changes")); await tick();
  const up = globalThis.__sb.calls.find((c) => c.op === "update");
  ok("edit -> recruitment_events by id, with .select() to read back rows", up && up.table === "recruitment_events" && up.filters.some((f) => f[1] === "id" && f[2] === "r1") && up.ret === "id"
     && up.row.location_label === "Fire hall" && up.row.end_time === "12:00" && up.row.start_time === "09:30" && !("fundraiser_id" in up.row), JSON.stringify(up?.row));
  ok("edit: 0 rows back = an error, no success, still editing", notes.some((n) => n.kind === "error" && /Nothing was changed/.test(n.text)) && !notes.some((n) => n.kind === "success") && !!btn(host, "Save changes"));
  writeAnswer = [{ id: "r1" }]; notes.length = 0;
  await click(btn(host, "Save changes")); await tick();
  ok("edit: 1 row back = success", notes.some((n) => n.kind === "success") && !notes.some((n) => n.kind === "error"));
  writeAnswer = []; notes.length = 0; globalThis.__sb.calls = [];
  await click(btn(host, "Delete")); await tick();
  const del = globalThis.__sb.calls.find((c) => c.op === "delete");
  ok("delete -> by id with .select(); 0 rows = an error, detail stays open", del && del.table === "recruitment_events" && del.ret === "id" && notes.some((n) => n.kind === "error" && /Nothing was removed/.test(n.text)) && !!btn(host, "Delete"));
  writeAnswer = [{ id: "r1" }]; notes.length = 0;
  await click(btn(host, "Delete")); await tick();
  ok("delete: 1 row back = closes, no error", !notes.some((n) => n.kind === "error") && !btn(host, "Delete"));
  unmount(); }

// 5. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const body = (s, name) => { const i = s.indexOf(`function ${name}(`); if (i < 0) return null; let j = s.indexOf("\nfunction ", i + 10); const k = s.indexOf("\nconst ", i + 10); if (k > 0 && k < j) j = k; return s.slice(i, j); };
const ev = body(src, "EventsCalendar");
ok("the old two calendars are gone; one EventsCalendar mounted on Fundraisers", !src.includes("function RecruitmentCalendar(") && !src.includes("function FundingCalendar(") && (src.match(/<EventsCalendar /g) || []).length === 1 && src.includes("FUNDRAISING &amp; COMMUNITY EVENTS"));
const rec = body(src, "Recruitment");
ok("Recruitment page: no calendar mounted; planner, ideas, Graphic Studio, saved drafts kept", rec && !/<(EventsCalendar|MonthCalendar|RecruitmentCalendar)\b/.test(rec) && rec.includes("<RecruitmentPlanView") && rec.includes("<IdeaGrid") && rec.includes("<GraphicStudio") && rec.includes("Saved drafts"));
ok("no tap-to-delete wording left anywhere in the new calendar", ev && !/tap to remove|tap an event to remove/.test(ev));
ok("EventsCalendar gates writes on CANMANAGE_OPS_ROLES, delete also on useCanDeleteShared; never isDeptAdmin", ev.includes("hasAny(role, CANMANAGE_OPS_ROLES)") && ev.includes("canWrite && canDeleteShared") && !ev.includes("isDeptAdmin"));
for (const name of ["OfficerDashboard", "MemberDashboard", "DashboardCalendar", "FundraiserHQ"]) {
  ok(`unchanged vs origin/main: ${name}`, body(src, name) !== null && body(src, name) === body(main, name));
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const addedHex = (strip(ev).match(/#[0-9A-Fa-f]{3,8}\b/g) || []);
ok("no hex literal in the new calendar (brand tokens only)", addedHex.length === 0, JSON.stringify(addedHex));
ok("no locked token in the new calendar", !ev.toLowerCase().includes("verifie" + "d"));
// the refused-save toast must paint ABOVE the open detail (Notification is zIndex 60 and renders earlier in the DOM)
const toastZ = Number((src.slice(src.indexOf("function Notification("), src.indexOf("function Notification(") + 2000).match(/zIndex: (\d+)/) || [])[1]);
const modalZ = Number((ev.match(/position: "fixed", inset: 0[^}]*zIndex: (\d+)/) || [])[1]);
ok("detail modal sits under the toast (z-index)", toastZ > 0 && modalZ > 0 && modalZ < toastZ, `toast ${toastZ} · modal ${modalZ}`);
await win.happyDOM?.abort?.();
// happy-dom + the app leave timers alive; the verdict is in process.exitCode.
process.exit(process.exitCode || 0);
