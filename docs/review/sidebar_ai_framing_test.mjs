// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/sidebar_ai_framing_test.mjs
// No network, no DB. Bret's final slice: the grouped sidebar + AI framing. The REAL src/App.jsx is bundled with esbuild
// (supabaseClient + apiBase faked, as in routing_r1_test) and rendered in happy-dom at real URLs.
//   1. the item map: every NAV key has exactly one home (a group or the gear); notifications joins Today
//   2. grouping per role (Member, Department Admin, Project-Admin-only): the SAME items the flat sidebar showed, under
//      the right headers; no empty group ever renders; the gear is a plain item when it holds one entry, a menu otherwise
//   3. collapse: a header folds its group, it is remembered per device (localStorage), and a broken storage is harmless;
//      the group holding the screen on show is always open
//   4. badges: Read & Sign and unread notifications surface on their COLLAPSED group's header
//   5. routing untouched: router.js / main.jsx / vercel.json byte-identical, go() byte-identical, a grouped item still
//      pushes its R1 path (routing_r1_test runs green in the same suite)
//   6. the Q&A count: documents.type classifies SOP/SOG; forms and checklists are counted as station documents
//   7. the Q&A wait: staged status lines (role=status), not a bare spinner
//   8. prefill: the recruitment + PR drafters fill from the loaded department, roster and sessions; a typed value wins
//   9. the AI note: one plain line + "more" on every AI-output surface; the long paragraph stays on library packets only
//   fences: the changed-file list; verified 132/32/14; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "2f1bf9a";   // live main when this was drafted (industrial-noir-63, routing R1)
const REV = process.env.REV || null;   // the working tree until review; pin it in the promote push
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");

const depDir = process.env.HAPPY_DOM_DIR || root;
const hdReq = createRequire(join(depDir, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "IntersectionObserver", "MutationObserver", "location", "history", "screen", "CustomEvent", "PopStateEvent"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
const writes = [];
for (const kind of ["pushState", "replaceState"]) {
  const orig = win.history[kind].bind(win.history);
  win.history[kind] = (st, t, url) => { orig(st, t, url); writes.push([kind === "pushState" ? "push" : "replace", win.location.pathname]); };
}

const MOCKS = {
  sb: `
    const FX = () => globalThis.__fx || {};
    const me = () => FX().me;
    const BASE_RPC = () => { const a = me().access; const lead = a.some((r) => ["Department Admin", "Officer", "Board Member", "Project Admin"].includes(r)); const da = a.includes("Department Admin") || a.includes("Project Admin");
      return { my_member_id: me().id, my_department_id: "d-1", is_dept_admin: da, is_department_admin: da, is_leader: lead, is_leadership: lead, is_canmanage: lead, is_canmanage_ops: lead, is_project_admin: a.includes("Project Admin"), has_password: true,
        my_open_station_session: [], my_stations: [], dept_cert_types: [], my_read_sign_queue: [] }; };
    function q(table) {
      const f = { single: false }; const b = {};
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "lt", "gt", "or", "not", "range", "filter", "match", "contains", "overlaps", "ilike", "like", "textSearch", "insert", "update", "delete", "upsert"]) b[m] = () => b;
      b.single = () => { f.single = true; return b; }; b.maybeSingle = () => { f.single = true; return b; };
      b.then = (res, rej) => { const t = { members: [me()], departments: [{ name: "Test VFD", disabled_modules: [] }], ...(FX().tables || {}) }; const rows = t[table] || [];
        return Promise.resolve(f.single ? { data: rows[0] || null, error: null } : { data: rows, error: null, count: rows.length }).then(res, rej); };
      return b;
    }
    export const supabase = {
      from: q,
      rpc: (n) => { const all = { ...BASE_RPC(), ...(FX().rpc || {}) }; return { then: (res, rej) => Promise.resolve(n in all ? { data: all[n], error: null } : { data: null, error: { message: "no fixture: " + n } }).then(res, rej) }; },
      auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "x@x.test" }, access_token: "t", expires_at: 9e9 } } }), getUser: async () => ({ data: { user: { id: "u1", email: "x@x.test" } } }),
              onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}), refreshSession: async () => ({ data: {} }), updateUser: async () => ({ data: {}, error: null }) },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }), list: async () => ({ data: [], error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  // authedFetch hangs while __hang is set (an AI call in flight), so the Q&A wait can be looked at
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { if (globalThis.__hang) return new Promise(() => {}); return { ok: false, status: 503, json: async () => ({}), text: async () => "" }; }`,
  qr: `export const QRCodeCanvas = () => null; export const QRCodeSVG = () => null; export default () => null;`,
};
const plugins = [{ name: "fakes", setup(b) {
  b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
  b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
  b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
  b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
  b.onResolve({ filter: /^qrcode\.react$/ }, () => ({ path: "qr", namespace: "fake" }));
  b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
} }];
const dir = mkdtempSync(join(tmpdir(), "b4c-sbg-"));
await build({ bundle: true, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent", outfile: join(dir, "app.mjs"),
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }), __BUILD_ID__: '"test"' }, plugins,
  stdin: { contents: `export { default as App } from "./src/App.jsx"; export * from "./src/navGroups.js"; export * from "./src/aiFraming.js"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" } });
const M = await import(pathToFileURL(join(dir, "app.mjs")).href);
const { App, createRoot, act, createElement: h, NAV_GROUPS, GEAR_KEYS, groupNav, readCollapsed, writeCollapsed, NAV_COLLAPSE_KEY, isSopType, groundingSummary, qaStage, draftPrefill, nextSession } = M;
const origErr = console.error; console.error = () => {};
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const ROLE = {
  member: { id: "m-me", department_id: "d-1", name: "Mo Member", access: ["Member"], status: "Active", email: "mo@x.test" },
  da: { id: "m-da", department_id: "d-1", name: "Dee Admin", access: ["Department Admin"], status: "Active", email: "dee@x.test" },
  pa: { id: "m-pa", department_id: "d-1", name: "Pat Platform", access: ["Project Admin"], status: "Active", email: "pat@x.test" },
};
async function boot(url, who, { tables, rpc, keepStorage } = {}) {
  globalThis.__fx = { me: ROLE[who], tables, rpc };
  win.sessionStorage.clear();
  if (!keepStorage) win.localStorage.clear();
  win.history.replaceState(null, "", url);
  writes.length = 0;
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(App)));
  await tick(14);
  return { host, unmount: async () => { await act(async () => r.unmount()); host.remove(); } };
}
const aside = (host) => host.querySelector("aside");
const groupsShown = (host) => [...aside(host).querySelectorAll("[data-nav-group]")].map((g) => g.getAttribute("data-nav-group"));
const keysIn = (host, id) => [...aside(host).querySelectorAll(`[data-nav-group="${id}"] [data-nav-key]`)].map((b) => b.getAttribute("data-nav-key"));
const allKeys = (host) => [...aside(host).querySelectorAll("[data-nav-key]")].map((b) => b.getAttribute("data-nav-key"));
const header = (host, id) => aside(host).querySelector(`[data-nav-group="${id}"] > button`);
const click = async (el) => { await act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick(4); };
const typeInto = async (el, v) => {
  const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new win.Event("input", { bubbles: true })); });
  await tick(3);
};
const fieldByLabel = (host, text) => [...host.querySelectorAll("main label")].find((l) => l.textContent.trim().toLowerCase().startsWith(text.toLowerCase()))?.querySelector("input, textarea");

const appSrc = show(REV, "src/App.jsx");
const navKeys = [...appSrc.slice(appSrc.indexOf("const NAV = ["), appSrc.indexOf("];", appSrc.indexOf("const NAV = ["))).matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);

// ---- 1. the item map ----
const mapped = [...NAV_GROUPS.flatMap((g) => g.keys), ...GEAR_KEYS];
ok("1 map: NAV is the 26 screens it was", navKeys.length === 26, navKeys.length);
ok("1 map: every NAV key has a home", navKeys.every((k) => mapped.includes(k)), navKeys.filter((k) => !mapped.includes(k)).join(","));
ok("1 map: no key has two homes", new Set(mapped).size === mapped.length);
ok("1 map: the map names nothing outside NAV except notifications", mapped.filter((k) => !navKeys.includes(k)).join(",") === "notifications");
ok("1 map: Bret's five groups, in order", NAV_GROUPS.map((g) => g.label).join(",") === "Today,Train,People,Station,Outreach");
const G = Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g.keys.join(",")]));
ok("1 map: Today", G.today === "dashboard,notifications,duties,minutes", G.today);
ok("1 map: Train", G.train === "training,study,qanda", G.train);
ok("1 map: People", G.people === "roster,onboarding,qualifications,expirations,reports", G.people);
ok("1 map: Station", G.station === "apparatus,equipment,myequipment,stationhours,documents,readiness,readsign,resources", G.station);
ok("1 map: Outreach", G.outreach === "recruit,funding,visibility", G.outreach);
ok("1 map: the gear holds Settings, Content Admin, Add Department (+ the PA's Department list)", GEAR_KEYS.join(",") === "settings,admin,adddept,department");
const g0 = groupNav([{ key: "dashboard" }, { key: "settings" }]);
ok("1 groupNav: empty groups are dropped", g0.groups.map((g) => g.id).join(",") === "today" && g0.gear.length === 1);
const g1 = groupNav([{ key: "dashboard" }, { key: "brand-new" }]);
ok("1 groupNav: an unmapped key is still reachable (last group), never dropped", g1.groups.at(-1).items.some((n) => n.key === "brand-new"));

// ---- 2. grouping per role ----
{
  const { host, unmount } = await boot("/", "member");
  ok("2 Member: groups Today/Train/People/Station; no Outreach (no visible items)", groupsShown(host).join(",") === "today,train,people,station", groupsShown(host).join(","));
  ok("2 Member: Today", keysIn(host, "today").join(",") === "dashboard,notifications,duties", keysIn(host, "today").join(","));
  ok("2 Member: Train", keysIn(host, "train").join(",") === "training,study,qanda");
  ok("2 Member: People = roster + their own qualifications", keysIn(host, "people").join(",") === "roster,qualifications", keysIn(host, "people").join(","));
  ok("2 Member: Station (no Equipment log, no Read & Sign with nothing outstanding)", keysIn(host, "station").join(",") === "apparatus,myequipment,stationhours,documents,readiness,resources", keysIn(host, "station").join(","));
  ok("2 Member: one gear item → a plain Settings & Support entry, no menu", allKeys(host).includes("settings") && !aside(host).querySelector('[data-nav-group="gear"]'));
  ok("2 Member: every rendered group has items", [...aside(host).querySelectorAll("[data-nav-group]")].every((g) => g.querySelector("[data-nav-key]")));
  await unmount();
}
{
  const { host, unmount } = await boot("/", "da");
  ok("2 DA: all five groups", groupsShown(host).join(",") === "today,train,people,station,outreach", groupsShown(host).join(","));
  ok("2 DA: Today carries Meetings", keysIn(host, "today").join(",") === "dashboard,notifications,duties,minutes", keysIn(host, "today").join(","));
  ok("2 DA: People carries Onboarding, Expirations, Reports", keysIn(host, "people").join(",") === "roster,onboarding,qualifications,expirations,reports", keysIn(host, "people").join(","));
  ok("2 DA: Station carries the Equipment log", keysIn(host, "station").join(",") === "apparatus,equipment,myequipment,stationhours,documents,readiness,resources", keysIn(host, "station").join(","));
  ok("2 DA: Outreach", keysIn(host, "outreach").join(",") === "recruit,funding,visibility");
  ok("2 DA: no Project Admin screens", !["admin", "adddept", "department"].some((k) => allKeys(host).includes(k)));
  ok("2 DA: the same entries the flat sidebar had — 22 NAV items (26 less the 3 PA screens and Read & Sign with nothing outstanding) + Notifications", allKeys(host).length === 23, allKeys(host).length);
  await unmount();
}
{
  const { host, unmount } = await boot("/", "pa");
  ok("2 PA-only: Today only (dashboard + notifications); the trimmed oversight nav is unchanged", groupsShown(host).join(",") === "today,gear" && keysIn(host, "today").join(",") === "dashboard,notifications", groupsShown(host).join(","));
  const gearBtn = header(host, "gear");
  ok("2 PA-only: the gear is a closed menu", gearBtn?.getAttribute("aria-expanded") === "false" && keysIn(host, "gear").length === 0);
  await click(gearBtn);
  ok("2 PA-only: opening it shows Settings, Content Admin, Add Department, Department", keysIn(host, "gear").join(",") === "settings,admin,adddept,department", keysIn(host, "gear").join(","));
  await unmount();
}

// ---- 3. collapse, remembered; the active group always open ----
{
  const { host, unmount } = await boot("/", "da");
  await click(header(host, "outreach"));
  ok("3 a header folds its group", header(host, "outreach").getAttribute("aria-expanded") === "false" && keysIn(host, "outreach").length === 0);
  ok("3 remembered per device", JSON.parse(win.localStorage.getItem(NAV_COLLAPSE_KEY) || "{}").outreach === true);
  await unmount();
  const again = await boot("/", "da", { keepStorage: true });
  ok("3 still folded after a reload", keysIn(again.host, "outreach").length === 0);
  await click(header(again.host, "outreach"));
  ok("3 unfolds again", keysIn(again.host, "outreach").join(",") === "recruit,funding,visibility");
  await again.unmount();
}
{
  win.localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify({ station: true, today: true }));
  const { host, unmount } = await boot("/station-hours", "member", { keepStorage: true });
  ok("3 the group holding the screen is open even when remembered folded", keysIn(host, "station").includes("stationhours") && header(host, "station").getAttribute("aria-disabled") === "true");
  ok("3 …and the other remembered fold holds", keysIn(host, "today").length === 0);
  await unmount();
}
{
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  ok("3 broken storage reads as 'everything open'", JSON.stringify(readCollapsed(broken)) === "{}");
  let threw = false; try { writeCollapsed({ x: true }, broken); } catch { threw = true; }
  ok("3 broken storage never throws on write", !threw);
  ok("3 junk in storage reads as 'everything open'", JSON.stringify(readCollapsed({ getItem: () => "[1,2]" })) === "{}");
}

// ---- 4. badges surface on collapsed headers ----
{
  win.localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify({ station: true, today: true }));
  const { host, unmount } = await boot("/training", "member", { keepStorage: true,
    rpc: { my_read_sign_queue: [{ status: "needs" }, { status: "resign" }, { status: "current" }] },
    tables: { notifications: [{ id: "n1", member_id: "m-me", read_at: null, created_at: new Date().toISOString() }, { id: "n2", member_id: "m-me", read_at: null, created_at: new Date().toISOString() }, { id: "n3", member_id: "m-me", read_at: new Date().toISOString(), created_at: new Date().toISOString() }, { id: "n4", member_id: "m-other", read_at: null, created_at: new Date().toISOString() }] } });
  const sb = aside(host).querySelector('[data-nav-group-badge="station"]'), tb = aside(host).querySelector('[data-nav-group-badge="today"]');
  ok("4 Read & Sign's count (2 outstanding) on the folded Station header", sb?.textContent === "2", sb?.textContent);
  ok("4 your unread notifications (2; read and others' don't count) on the folded Today header", tb?.textContent === "2", tb?.textContent);
  await click(header(host, "station"));
  ok("4 unfolded: the badge moves back onto the Read & Sign item", !aside(host).querySelector('[data-nav-group-badge="station"]') && aside(host).querySelector('[data-nav-key="readsign"]')?.textContent.includes("2"));
  await unmount();
}

// ---- 5. routing untouched ----
for (const p of ["src/router.js", "src/main.jsx", "vercel.json", "src/appUpdate.js", "src/pendingScan.js", "src/deeplink.js"]) ok(`5 ${p} byte-identical`, show(REV, p) === show(BASE, p));
const goOf = (src) => { const i = src.indexOf("  function go(k, arg) {"); return src.slice(i, src.indexOf("\n  }\n", i)); };
ok("5 go() byte-identical", goOf(appSrc) === goOf(show(BASE, "src/App.jsx")) && goOf(appSrc).length > 200);
{
  const { host, unmount } = await boot("/", "da");
  await click(aside(host).querySelector('[data-nav-key="stationhours"]'));
  ok("5 a grouped item still pushes its R1 path", win.location.pathname === "/station-hours" && writes.some(([k, p]) => k === "push" && p === "/station-hours"));
  await click(aside(host).querySelector('[data-nav-key="notifications"]'));
  ok("5 the new Notifications entry pushes /notifications", win.location.pathname === "/notifications" && host.querySelector("[data-b4c-screen]")?.getAttribute("data-b4c-screen") === "notifications");
  await unmount();
}

// ---- 6. the SOP count ----
ok("6 'SOP / SOG' is an SOP", isSopType("SOP / SOG"));
ok("6 bare 'SOP' and 'SOG' (older rows) are SOPs", isSopType("SOP") && isSopType("SOG") && isSopType("sops"));
ok("6 Forms, Reference, Handbook, Policy, Other, null are not", ["Forms", "Reference", "Handbook", "Policy", "Other", "Agreement", null, ""].every((t) => !isSopType(t)));
ok("6 the file name never classifies (a Forms upload called \"SOP 12\" is a station document)", groundingSummary([{ name: "SOP 12 checklist", type: "Forms" }]).text === "1 station document");
ok("6 mixed → both counts", groundingSummary([{ type: "SOP / SOG" }, { type: "Forms" }, { type: "Reference" }]).text === "1 SOP/SOG document and 2 other station documents");
ok("6 no SOPs → counted honestly as station documents", groundingSummary([{ type: "Forms" }, { type: "Forms" }]).text === "2 station documents");
ok("6 all SOPs", groundingSummary([{ type: "SOG" }, { type: "SOP / SOG" }]).text === "2 SOP/SOG documents");
{
  const { host, unmount } = await boot("/station-qa", "member", { tables: { documents: [{ name: "SOG 101 Structure Fire", type: "SOP / SOG", content_text: "Two in two out." }, { name: "Daily truck checklist", type: "Forms", content_text: "Tires. Lights." }, { name: "Hose testing form", type: "Forms", content_text: "PSI." }] } });
  const g = host.querySelector("[data-qa-grounding]")?.textContent || "";
  ok("6 Q&A reads: 1 SOP/SOG document and 2 other station documents", g.startsWith("Reading 1 SOP/SOG document and 2 other station documents"), g);
  ok("6 Q&A chip stays SOP-grounded when an SOP is in play", host.textContent.includes("SOP-grounded"));
  await unmount();
  const f = await boot("/station-qa", "member", { tables: { documents: [{ name: "Daily truck checklist", type: "Forms", content_text: "Tires." }] } });
  const g2 = f.host.querySelector("[data-qa-grounding]")?.textContent || "";
  ok("6 forms only: 'Reading 1 station document', no SOP claim", g2.startsWith("Reading 1 station document") && !g2.includes("SOP") && f.host.textContent.includes("Document-grounded") && !f.host.textContent.includes("SOP-grounded"), g2);
  await f.unmount();
}

// ---- 7. the Q&A wait ----
ok("7 stage 1: sending", qaStage(500, 3) === "Sending your question…");
ok("7 stage 2: reading N station documents", qaStage(4000, 3) === "Reading your 3 station documents…" && qaStage(4000, 1) === "Reading your 1 station document…");
ok("7 stage 2 without documents makes no reading claim", qaStage(4000, 0) === "Working through your question…");
ok("7 stage 3: writing", qaStage(12000, 3) === "Writing the answer…");
ok("7 stage 4: still writing, no false finish time", qaStage(25000, 3) === "Still writing — longer answers can take up to half a minute.");
{
  globalThis.__hang = true;
  const { host, unmount } = await boot("/station-qa", "member", { tables: { documents: [{ name: "SOG 1", type: "SOP / SOG", content_text: "x" }] } });
  const input = host.querySelector('input[aria-label="Your question"]');
  await typeInto(input, "What is our RIT procedure?");
  await click([...host.querySelectorAll("main button")].find((b) => b.textContent.trim() === "Ask"));
  const st = host.querySelector("[data-qa-stage]");
  ok("7 while waiting: a staged status line (role=status, polite), not a bare spinner", st?.getAttribute("role") === "status" && st.textContent.includes("Sending your question…"), st?.textContent);
  globalThis.__hang = false;
  await unmount();
}

// ---- 8. prefill ----
const ymd = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
const SESS = [
  { id: "s-past", title: "Old drill", date: ymd(-2), start_time: "19:00:00", is_meeting: false, audience: "everyone", status: "scheduled", done: true },
  { id: "s-lead", title: "Officers only", date: ymd(1), start_time: "18:00:00", is_meeting: true, audience: "leadership", status: "scheduled", done: false },
  { id: "s-cxl", title: "Cancelled drill", date: ymd(2), start_time: "19:00:00", is_meeting: false, audience: "everyone", status: "cancelled", done: false },
  { id: "s-train", title: "Ladder throws", date: ymd(3), start_time: "19:00:00", is_meeting: false, audience: "everyone", status: "scheduled", done: false },
  { id: "s-meet", title: "Business meeting", date: ymd(5), start_time: "18:30:00", is_meeting: true, audience: "everyone", status: "scheduled", done: false },
];
const ROSTER = [ROLE.da, { id: "a1", name: "A", access: ["Member"], status: "Active" }, { id: "a2", name: "B", access: ["Member"], status: "Probationary" }, { id: "a3", name: "C", access: ["Member"], status: "Inactive" }, { id: "a4", name: "D", access: ["Project Admin"], status: "Active" }];
const DEPT = [{ name: "Test VFD", city: "Granbury, TX", disabled_modules: [] }];
const expDates = `Our next meeting: ${day(5)} at 6:30 PM\nOur next training night: ${day(3)} at 7:00 PM (Ladder throws)`;
{
  const asSession = (r) => { const [y, m, d] = r.date.split("-").map(Number); return { ...r, y, m: m - 1, d, startTime: r.start_time, isMeeting: r.is_meeting, cancelled: r.status === "cancelled" }; };
  const p = draftPrefill({ dept: DEPT[0], members: ROSTER, sessions: SESS.map(asSession) });
  ok("8 unit: town from the department row", p.town === "Granbury, TX");
  ok("8 unit: size = the shared headcount (Active + Probationary; not Inactive, not PA)", p.size === "3", p.size);
  ok("8 unit: dates skip past, cancelled and leadership-only sessions", p.localDates === expDates, JSON.stringify(p.localDates));
  ok("8 unit: PR topic = the next public training night", p.topic === `Training night ${day(3)} — Ladder throws`, p.topic);
  ok("8 unit: nothing known → blanks, so the fields keep their defaults", JSON.stringify(draftPrefill({})) === JSON.stringify({ town: "", size: "", localDates: "", topic: "" }));
  ok("8 unit: nextSession('meeting') ignores trainings", nextSession(SESS.map(asSession), "meeting")?.x.id === "s-meet");
}
{
  const { host, unmount } = await boot("/recruitment", "da", { tables: { departments: DEPT, members: ROSTER, members_view: ROSTER, training_sessions: SESS } });
  ok("8 Recruitment: town lands in the field", fieldByLabel(host, "Your town")?.value === "Granbury, TX", fieldByLabel(host, "Your town")?.value);
  ok("8 Recruitment: size lands (no more made-up 14)", fieldByLabel(host, "Department size")?.value === "3", fieldByLabel(host, "Department size")?.value);
  ok("8 Recruitment: next meeting + training night land in Key local dates", fieldByLabel(host, "Key local dates")?.value === expDates, JSON.stringify(fieldByLabel(host, "Key local dates")?.value));
  await typeInto(fieldByLabel(host, "Your town"), "Tolar");
  await tick(6);
  ok("8 Recruitment: a typed value wins over the prefill", fieldByLabel(host, "Your town")?.value === "Tolar");
  await unmount();
  const v = await boot("/public-relations", "da", { tables: { departments: DEPT, members: ROSTER, members_view: ROSTER, training_sessions: SESS } });
  ok("8 PR: the caption topic is the next public training night", fieldByLabel(v.host, "What's the post about?")?.value === `Training night ${day(3)} — Ladder throws`, fieldByLabel(v.host, "What's the post about?")?.value);
  await v.unmount();
  const none = await boot("/public-relations", "da", { tables: { departments: DEPT, members: ROSTER, members_view: ROSTER } });
  ok("8 PR: no upcoming session → the old example stays", fieldByLabel(none.host, "What's the post about?")?.value === "A Tuesday-night ladder drill");
  await none.unmount();
}
const fnSrc = (name) => { const i = appSrc.indexOf(`function ${name}(`); return appSrc.slice(i, appSrc.indexOf("\nfunction ", i + 10)); };
ok("8 prefill reads nothing new: no supabase call added to Recruitment / Visibility", (fnSrc("Recruitment").match(/supabase\./g) || []).length === (show(BASE, "src/App.jsx").slice(show(BASE, "src/App.jsx").indexOf("function Recruitment("), show(BASE, "src/App.jsx").indexOf("\nfunction ", show(BASE, "src/App.jsx").indexOf("function Recruitment(") + 10)).match(/supabase\./g) || []).length && !/supabase\./.test(fnSrc("Visibility")));
ok("8 aiFraming.js never touches the database or the AI", !/supabase|callClaude|fetch\(/.test(show(REV, "src/aiFraming.js")));

// ---- 9. the AI note ----
const AI_SURFACES = ["StudySession", "StationQA", "DrillPlanPanel", "Recruitment", "Documents", "Visibility", "FundraiserHQ", "Fundraisers", "RosterCerts", "RosterReports", "MaintenancePanel", "Minutes", "MeetingAgenda", "Onboarding", "AiPlanViewer", "AskB4C", "useInsightDrafts"];
const missing = AI_SURFACES.filter((n) => !fnSrc(n).includes("<AiNote"));
ok(`9 every AI-output surface carries the note (${AI_SURFACES.length})`, missing.length === 0, missing.join(","));
const discUses = [...appSrc.matchAll(/<Disclaimer /g)].length;
ok("9 the long paragraph stays only on library packets", discUses === 1 && fnSrc("Packet").includes("<Disclaimer "));
{
  const { host, unmount } = await boot("/station-qa", "member");
  const note = host.querySelector("[data-ai-note]");
  ok("9 one plain line", note?.textContent.startsWith("Written by AI — it can be wrong. Check it against your department's SOPs before you use it.") && !note.textContent.includes("medical direction"), note?.textContent);
  await click([...note.querySelectorAll("button")].find((b) => b.textContent === "more"));
  const n2 = host.querySelector("[data-ai-note]");
  ok("9 'more' opens the full terms + How we use AI", n2.textContent.includes("does not provide medical direction") && n2.querySelector('a[href="https://b4thecall.com/legal/responsible-ai"]')?.textContent === "How we use AI");
  ok("9 …and closes again ('less')", [...n2.querySelectorAll("button")].some((b) => b.textContent === "less"));
  await unmount();
}

// ---- fences ----
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const ALLOWED = ["src/App.jsx", "src/Notifications.jsx", "src/navGroups.js", "src/aiFraming.js", "docs/review/sidebar_ai_framing_test.mjs", "claude/B4C_SidebarGrouping_AIFraming_Draft.md",
  "docs/review/ai_drafting_sliceB_test.mjs", "docs/review/xss_m1m2_test.mjs"];   // the two re-ruled guards (AiPlanViewer AI-note swap; AI_POLICY_URL classified)
const touched = [...new Set([...changed, ...untracked])];
ok("fence: only the slice's files", touched.every((f) => ALLOWED.includes(f)), touched.filter((f) => !ALLOWED.includes(f)).join(","));
ok("fence: api/, shared/, vercel.json untouched", !touched.some((f) => f.startsWith("api/") || f.startsWith("shared/") || f === "vercel.json"));
const bellOut = (src) => { const i = src.indexOf("export function NotificationBell("); const c = src.lastIndexOf("/*", i); const k = src.slice(c, i).includes("onCount") ? c : i; return src.slice(0, k) + src.slice(src.indexOf("\n}\n", i)); };
ok("fence: Notifications.jsx changes only inside NotificationBell (the onCount report)", bellOut(show(REV, "src/Notifications.jsx")) === bellOut(show(BASE, "src/Notifications.jsx")) && /if \(onCount\) onCount\(n\)/.test(show(REV, "src/Notifications.jsx")));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("counts: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("Notify held: api/notify-session.js absent", REV ? !execSync(`git ls-tree --name-only ${REV} api/`, { cwd: root }).toString().includes("notify-session.js") : !existsSync(join(root, "api/notify-session.js")));
console.error = origErr;
process.exit(process.exitCode || 0);
