// HAPPY_DOM_DIR=<dir with happy-dom [+ @vercel/routing-utils]> node docs/review/routing_r1_test.mjs
// No network, no DB. Routing R1: the hand-written router (src/router.js) over App's existing go(). The REAL src/App.jsx is
// bundled with esbuild (supabaseClient + apiBase faked) and cold-loaded in happy-dom at real URLs; happy-dom implements
// pushState / replaceState / back / forward / popstate. The recovery-link check bundles the REAL src/main.jsx.
//   1. the route table: every top-level screen has one readable kebab-case path; parse(format(k)) = k; ids are dot-free;
//      /checkin + /handoff + unknown paths are "not ours"
//   2. cold-load every top-level path as a Member and as a DA: the right screen, the URL unchanged, and NO bounce. The
//      address bar is never rewritten to "/" during the load (the guard waits for identity, so a DA's cold /reports holds).
//      Paths the role's sidebar never offers bounce to "/" (replaced) once identity lands.
//   3. an unknown path → the dashboard at "/", replaced (no Back step)
//   4. Back walks SCREENS, not tabs: screen changes push, a tab switch adds nothing; Back / Forward land on the right screen
//   5. scroll: a push puts the main panel at the top; Back restores the position saved on that entry
//   6. refresh stays in place: a remount on the same URL is the same screen, and the entry's navArg survives (state, not URL)
//   7. /checkin and /handoff: untouched (routeDeepLink, pendingScan, app links and the two rewrites byte-identical); a cold
//      scan link still checks in / previews; leaving the one-shot screen REPLACES, so Back can't land on a spent code
//   8. the auth hash is never read, written or cleared: a recovery link through the real main.jsx reaches "Set a new
//      password" with the hash intact; App-level pushes carry a hash through verbatim
//   9. the pending path (magic-link round-trip): captured from the pathname only, consumed once, applied only on "/" and
//      never over a QR scan
//  10. View-as and sign-out land on "/" with no Back step
//  11. vercel.json: ONE added rewrite; crons, headers and the two existing rewrites byte-identical; compiled with Vercel's
//      own routing-utils, it sends app paths to index.html and leaves /api, /assets, /.well-known and real files alone
//   fences: src/App.jsx, src/router.js, src/main.jsx, vercel.json, this test, the note; appUpdate / pendingScan / deeplink /
//   Login / SetPassword byte-identical; verified 132/32/14; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "635d643";   // live main when this was drafted (industrial-noir-62)
const REV = process.env.REV || null;   // the working tree until review; pin it in the promote push
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");

const depDir = process.env.HAPPY_DOM_DIR || root;
const hdReq = createRequire(join(depDir, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "IntersectionObserver", "MutationObserver", "location", "history", "screen", "CustomEvent", "PopStateEvent"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });   // /version.json etc.

// Every address-bar write, in order: [kind, path+search+hash]
const writes = [];
for (const kind of ["pushState", "replaceState"]) {
  const orig = win.history[kind].bind(win.history);
  win.history[kind] = (st, t, url) => { orig(st, t, url); writes.push([kind === "pushState" ? "push" : "replace", win.location.pathname + win.location.search + win.location.hash]); };
}

const MOCKS = {
  sb: `
    const FX = () => globalThis.__fx || {};
    const me = () => FX().me || { id: "m-me", department_id: "d-1", name: "Dana Member", access: ["Member"], status: "Active", email: "me@x.test" };
    const BASE_RPC = () => { const a = me().access; const lead = a.some((r) => ["Department Admin", "Officer", "Board Member", "Project Admin"].includes(r)); const da = a.includes("Department Admin") || a.includes("Project Admin");
      return { my_member_id: me().id, my_department_id: "d-1", is_dept_admin: da, is_department_admin: da, is_leader: lead, is_leadership: lead, is_canmanage: lead, is_canmanage_ops: lead, is_project_admin: a.includes("Project Admin"), has_password: true,
        my_open_station_session: [], my_stations: [], dept_cert_types: [], my_read_sign_queue: [], member_check_in: "ok", preview_equipment_handoff: { from_member_name: "Giver", items: [{ name: "Radio 1" }], expires_at: new Date(Date.now() + 90000).toISOString() } }; };
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
      rpc: (n, args) => { (globalThis.__rpcs ||= []).push({ n, args }); const all = { ...BASE_RPC(), ...(FX().rpc || {}) }; return { then: (res, rej) => Promise.resolve(n in all ? { data: all[n], error: null } : { data: null, error: { message: "no fixture: " + n } }).then(res, rej) }; },
      auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: me().email }, access_token: "t", expires_at: 9e9 } } }), getUser: async () => ({ data: { user: { id: "u1", email: me().email } } }),
              onAuthStateChange: (cb) => { (globalThis.__authCbs ||= []).push(cb); return { data: { subscription: { unsubscribe() { globalThis.__authCbs = globalThis.__authCbs.filter((x) => x !== cb); } } } }; },
              signOut: async () => ({}), refreshSession: async () => ({ data: {} }), updateUser: async () => ({ data: {}, error: null }) },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }), list: async () => ({ data: [], error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, json: async () => ({}), text: async () => "" }; }`,
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
const common = { bundle: true, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }), __BUILD_ID__: '"test"' }, plugins };
const dir = mkdtempSync(join(tmpdir(), "b4c-r1-"));
await build({ ...common, outfile: join(dir, "app.mjs"),
  stdin: { contents: `export { default as App } from "./src/App.jsx"; export * from "./src/router.js"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" } });
const R = await import(pathToFileURL(join(dir, "app.mjs")).href);
const { App, createRoot, act, createElement: h } = R;
const origErr = console.error; console.error = () => {};
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const ROLE = { member: { id: "m-me", department_id: "d-1", name: "Mo Member", access: ["Member"], status: "Active", email: "mo@x.test" },
               da: { id: "m-da", department_id: "d-1", name: "Dee Admin", access: ["Department Admin"], status: "Active", email: "dee@x.test" } };
const screenNow = () => document.querySelector("[data-b4c-scroll=main]")?.getAttribute("data-b4c-screen");
const here = () => win.location.pathname;
async function boot(url, who, { tables, rpc, state } = {}) {
  globalThis.__fx = { me: ROLE[who] || who, tables, rpc }; globalThis.__rpcs = [];
  win.sessionStorage.clear();
  win.history.replaceState(state ?? null, "", url);
  writes.length = 0;
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(App)));
  await tick(12);
  return { host, unmount: async () => { await act(async () => r.unmount()); host.remove(); } };
}
const navBtn = (host, label) => [...host.querySelectorAll("button, a")].find((b) => b.textContent.trim() === label);

// ---- 1. the route table ----
const NAV_KEYS = ["dashboard", "training", "roster", "onboarding", "apparatus", "qualifications", "equipment", "myequipment", "stationhours", "duties", "recruit", "funding", "visibility", "minutes", "reports", "expirations", "readiness", "study", "qanda", "documents", "readsign", "resources", "settings", "admin", "adddept", "department"];
const appSrc = show(REV, "src/App.jsx");
const navInApp = [...appSrc.slice(appSrc.indexOf("const NAV = ["), appSrc.indexOf("];", appSrc.indexOf("const NAV = ["))).matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]);
ok("1. every sidebar screen (all 26 NAV keys) + notifications + library has exactly one path", JSON.stringify(navInApp) === JSON.stringify(NAV_KEYS) && [...NAV_KEYS, "notifications", "library"].every((k) => typeof R.pathFor(k) === "string") && R.ROUTES.length === 28);
ok("1. parse(format(k)) = k for every route; the packet route carries its id", R.ROUTES.every(([k, p]) => R.parsePath(p)?.screen === k) && R.parsePath("/training/library/drill_01-x")?.packetId === "drill_01-x" && R.pathFor("packet", { packetId: "abc-1" }) === "/training/library/abc-1");
ok("1. readable kebab-case paths, never the internal keys where they differ", R.pathFor("stationhours") === "/station-hours" && R.pathFor("resources") === "/your-six" && R.pathFor("minutes") === "/meetings" && R.pathFor("myequipment") === "/my-equipment" && R.ROUTES.every(([, p]) => /^\/[a-z0-9/-]*$/.test(p)));
ok("1. ids in paths are dot-free: a dotted / slashed packet id gets no path and parses to nothing", R.pathFor("packet", { packetId: "a.b" }) === null && R.parsePath("/training/library/a.b") === null && R.parsePath("/training/library/a/b") === null);
ok("1. /checkin, /handoff, the retired /ai and unknown paths are NOT the router's", R.parsePath("/checkin") === null && R.parsePath("/handoff/") === null && R.pathFor("checkin") === null && R.pathFor("ai") === null && R.parsePath("/no-such-page") === null);
ok("1. trailing slashes tolerated", R.parsePath("/roster/")?.screen === "roster");

// ---- 2. cold loads ----
const allowed = (who, k) => who === "da" ? !["admin", "adddept", "department"].includes(k)
  : ["dashboard", "notifications", "training", "roster", "apparatus", "qualifications", "equipment", "myequipment", "stationhours", "duties", "readiness", "study", "qanda", "documents", "readsign", "resources", "settings", "library"].includes(k);
const KEYS = [...NAV_KEYS, "notifications", "library"];
const bad = { member: [], da: [] }, bounced = { member: [], da: [] }, early = [];
for (const who of ["member", "da"]) {
  for (const k of KEYS) {
    const path = R.pathFor(k);
    const v = await boot(path, who);
    const want = allowed(who, k);
    if (want) {
      if (!(screenNow() === k && here() === path)) bad[who].push(`${k}: screen=${screenNow()} url=${here()}`);
      if (writes.some(([, u]) => u.split(/[?#]/)[0] === "/" && path !== "/")) early.push(`${who} ${k}`);
    } else if (!(screenNow() === "dashboard" && here() === "/" && writes.every(([kind]) => kind === "replace"))) bounced[who].push(`${k}: screen=${screenNow()} url=${here()} ${JSON.stringify(writes)}`);
    await v.unmount();
  }
}
ok("2. cold-load as a MEMBER: every path the member's sidebar offers opens that screen, URL unchanged", bad.member.length === 0, bad.member.join(" | "));
ok("2. cold-load as a DA: every DA path opens its screen, URL unchanged (incl. /reports, /expirations, /meetings, /funding)", bad.da.length === 0, bad.da.join(" | "));
ok("2. NO BOUNCE: during those loads the bar was never rewritten to \"/\" (the guard waits for identity: role starts as Member)", early.length === 0, early.join(", "));
ok("2. a path the role's sidebar never offers bounces to \"/\" by REPLACE once identity lands (member: leadership screens; DA: PA-only)", bounced.member.length === 0 && bounced.da.length === 0, [...bounced.member, ...bounced.da].join(" | "));

// ---- 3. unknown path ----
{ const len = win.history.length; const v = await boot("/no-such-page", "member");
  ok("3. an unknown path → the dashboard at \"/\", replaced (history length unchanged)", screenNow() === "dashboard" && here() === "/" && win.history.length === len && writes.every(([k]) => k === "replace"), JSON.stringify(writes));
  await v.unmount(); }

// ---- 4 + 5. Back walks screens, not tabs; scroll ----
{ const v = await boot("/", "da");
  const len0 = win.history.length;
  const main = () => document.querySelector("[data-b4c-scroll=main]");
  main().scrollTop = 480;
  await act(async () => { navBtn(v.host, "Training").click(); }); await tick(8);
  ok("4. a sidebar tap PUSHES: /training, one new entry", here() === "/training" && screenNow() === "training" && win.history.length === len0 + 1);
  ok("5. the push put the main panel at the top", main().scrollTop === 0, String(main().scrollTop));
  const plansTab = [...v.host.querySelectorAll("button")].find((b) => b.textContent.trim() === "Training Plans");
  await act(async () => { plansTab?.click(); }); await tick(6);
  ok("4. a TAB switch inside the screen adds no entry and leaves the URL alone", !!plansTab && here() === "/training" && win.history.length === len0 + 1);
  await act(async () => { navBtn(v.host, "Roster").click(); }); await tick(8);
  ok("4. another screen pushes again: /roster", here() === "/roster" && screenNow() === "roster" && win.history.length === len0 + 2);
  await act(async () => { win.history.back(); }); await tick(10);
  ok("4. Back → /training, the Training screen (one step back = one screen, not a tab)", here() === "/training" && screenNow() === "training");
  await act(async () => { win.history.back(); }); await tick(10);
  ok("4. Back again → \"/\", the dashboard", here() === "/" && screenNow() === "dashboard");
  ok("5. Back restored the panel to where it was on that entry (480)", main().scrollTop === 480, String(main().scrollTop));
  await act(async () => { win.history.forward(); }); await tick(10);
  ok("4. Forward → /training, without pushing a duplicate (length unchanged)", here() === "/training" && screenNow() === "training" && win.history.length === len0 + 2);
  await v.unmount(); }

// ---- 6. refresh stays in place ----
{ let v = await boot("/station-hours", "member");
  const len = win.history.length; await v.unmount();
  v = await boot("/station-hours", "member", { state: win.history.state });
  ok("6. refresh (remount on the same URL) → the same screen, no new entry", screenNow() === "stationhours" && here() === "/station-hours" && win.history.length === len);
  await v.unmount();
  v = await boot("/meetings", "da", { state: { b4c: 1, screen: "minutes", packetId: null, navArg: "minutes" } });
  const pressed = [...v.host.querySelectorAll("button[aria-pressed=true]")].map((b) => b.textContent.trim());
  ok("6. the entry's navArg survives a refresh in history state, never in the URL (DA's /meetings reopens on Minutes, not Agenda)", pressed.some((t) => /^Minutes$/i.test(t)) && !pressed.some((t) => /^Agenda$/i.test(t)) && here() === "/meetings" && !win.location.search, pressed.join(","));
  await v.unmount(); }

// ---- 7. /checkin and /handoff ----
const fnText = (src, sig) => { const i = src.indexOf(sig); return i < 0 ? "" : src.slice(i, src.indexOf("\n  };\n", i) + 5); };
ok("7. routeDeepLink is byte-identical to main", fnText(appSrc, "const routeDeepLink = (search) => {") === fnText(show(BASE, "src/App.jsx"), "const routeDeepLink = (search) => {") && fnText(appSrc, "const routeDeepLink = (search) => {").length > 500);
const sameFile = (p) => show(REV, p) === show(BASE, p);
ok("7. pendingScan.js, deeplink.js, appUpdate.js, Login.jsx, SetPassword.jsx, the AASA, assetlinks and the Android manifest are byte-identical",
  ["src/pendingScan.js", "src/deeplink.js", "src/appUpdate.js", "src/Login.jsx", "src/SetPassword.jsx", "public/.well-known/apple-app-site-association", "public/.well-known/assetlinks.json", "android/app/src/main/AndroidManifest.xml"].every(sameFile));
{ const v = await boot("/checkin?checkin=sess-1&t=tok-9", "member");
  const ci = globalThis.__rpcs.filter((r) => r.n === "member_check_in");
  ok("7. a cold /checkin?checkin=…&t=… still checks in (member_check_in with that session + token) on the check-in screen",
    ci.length === 1 && ci[0].args.p_session_id === "sess-1" && ci[0].args.p_token === "tok-9" && screenNow() === "checkin");
  ok("7. …the router wrote nothing before routeDeepLink read the code; the only write is routeDeepLink's own clear to /checkin",
    writes.length >= 1 && writes[0][1] === "/checkin" && writes.every(([, u]) => u === "/checkin"), JSON.stringify(writes));
  const len = win.history.length;
  const leave = [...v.host.querySelectorAll("button")].find((b) => /Go to my training/.test(b.textContent));
  await act(async () => { leave.click(); }); await tick(8);
  ok("7. leaving the check-in screen REPLACES the spent /checkin (Back can't return to it)", here() === "/training" && win.history.length === len, `${here()} ${win.history.length - len}`);
  await v.unmount(); }
{ const v = await boot("/handoff?handoff=h-1&t=c-2", "member");
  const pv = globalThis.__rpcs.filter((r) => r.n === "preview_equipment_handoff");
  ok("7. a cold /handoff?handoff=…&t=… still previews the transfer (same args), on the handoff screen, URL cleared to /handoff by routeDeepLink",
    pv.length === 1 && pv[0].args.p_handoff_id === "h-1" && pv[0].args.p_code === "c-2" && screenNow() === "handoff" && here() === "/handoff" && !win.location.search);
  await v.unmount(); }
{ const v = await boot("/checkin", "member");
  ok("7. a bare /checkin (a refresh after the code was spent) runs nothing and shows the dashboard", !globalThis.__rpcs.some((r) => r.n === "member_check_in") && screenNow() === "dashboard");
  await v.unmount(); }

// ---- 8. the hash: App level ----
{ const v = await boot("/#access_token=AT1&refresh_token=RT1&type=magiclink", "da");
  const h0 = win.location.hash;
  await act(async () => { navBtn(v.host, "Roster").click(); }); await tick(8);
  ok("8. App never clears an auth hash: its first write and a push both carry it through verbatim", h0 === "#access_token=AT1&refresh_token=RT1&type=magiclink" && win.location.hash === h0 && writes.every(([, u]) => u.endsWith(h0)), JSON.stringify(writes));
  await v.unmount();
  win.history.replaceState(null, "", "/"); }
const routerSrc = show(REV, "src/router.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");   // code only, not the comments that explain the rule
ok("8. router.js never assigns, parses or clears the hash: it only appends location.hash as-is",
  !/location\.hash\s*=|\.hash\.(includes|split|match|replace|slice)|hashchange|access_token|URLSearchParams\([^)]*hash/.test(routerSrc) && (routerSrc.match(/window\.location\.hash/g) || []).length === 1);

// ---- 9. the pending path ----
{ const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  ok("9. captured from a real non-root path only: /reports yes; \"/\", /checkin, /handoff, unknown no", R.capturePendingPath("/reports", st) === "/reports" && R.capturePendingPath("/", st) === null && R.capturePendingPath("/checkin", st) === null && R.capturePendingPath("/handoff", st) === null && R.capturePendingPath("/nope", st) === null);
  ok("9. consumed ONCE (read deletes)", R.consumePendingPath(st) === "/reports" && R.consumePendingPath(st) === null);
  mem.set(R.PENDING_PATH_KEY, JSON.stringify({ path: "/reports", ts: Date.now() - R.PENDING_PATH_TTL_MS - 1 }));
  ok("9. expires after 30 minutes (and is cleared)", R.consumePendingPath(st) === null && !mem.has(R.PENDING_PATH_KEY)); }
{ win.localStorage.setItem("b4c_pending_path", JSON.stringify({ path: "/reports", ts: Date.now() }));
  globalThis.__fx = {}; const len = win.history.length;
  const v = await boot("/", "da");
  ok("9. a magic link landing on \"/\" with a fresh pending /reports → Reports, by REPLACE (no Back to an empty dashboard)", screenNow() === "reports" && here() === "/reports" && win.history.length === len && !win.localStorage.getItem("b4c_pending_path"));
  await v.unmount(); }
{ win.localStorage.setItem("b4c_pending_path", JSON.stringify({ path: "/reports", ts: Date.now() }));
  win.localStorage.setItem("b4c_pending_scan", JSON.stringify({ kind: "checkin", id: "sess-7", token: "t7", ts: Date.now() }));
  const v = await boot("/", "da");
  ok("9. …but a QR scan in play always wins: the scan replays, the pending path is spent and ignored", screenNow() === "checkin" && globalThis.__rpcs.some((r) => r.n === "member_check_in" && r.args.p_session_id === "sess-7") && !win.localStorage.getItem("b4c_pending_path"));
  await v.unmount(); }

// ---- 10. View-as and sign-out ----
{ const v = await boot("/", { id: "m-two", department_id: "d-1", name: "Two Hats", access: ["Department Admin", "Officer"], status: "Active", email: "two@x.test" });
  await act(async () => { navBtn(v.host, "Reports").click(); }); await tick(8);
  const len = win.history.length;
  const sel = [...v.host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "__all__"));
  await act(async () => { sel.value = "Officer"; sel.dispatchEvent(new win.Event("change", { bubbles: true })); }); await tick(8);
  ok("10. View-as lands on \"/\" with NO Back step (replaced, length unchanged)", here() === "/" && screenNow() === "dashboard" && win.history.length === len, `${here()} ${win.history.length - len}`);
  await act(async () => { navBtn(v.host, "Roster").click(); }); await tick(6);
  const len2 = win.history.length;
  await act(async () => { (globalThis.__authCbs || []).forEach((cb) => cb("SIGNED_OUT", null)); }); await tick(4);
  ok("10. sign-out (SIGNED_OUT) lands the tab on \"/\" with no Back step", here() === "/" && win.history.length === len2);
  await v.unmount(); }
ok("10. go() points the URL at the destination BEFORE an app-update boundary reload (and puts it back if none happens)",
  /const before = updateReady\(\) && dest \?/.test(appSrc) && appSrc.indexOf("if (before) replaceRoute(dest") < appSrc.indexOf("if (applyAtBoundary({ screen: k")
  && appSrc.indexOf("if (applyAtBoundary({ screen: k") < appSrc.indexOf("if (before) { try { window.history.replaceState(before.state"));

// ---- 11. vercel.json ----
const vNew = JSON.parse(show(REV, "vercel.json")), vOld = JSON.parse(show(BASE, "vercel.json"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok("11. crons and headers byte-identical; the two existing rewrites byte-identical and first", same(vNew.crons, vOld.crons) && same(vNew.headers, vOld.headers) && same(vNew.rewrites.slice(0, 2), vOld.rewrites) && same(Object.keys(vNew), Object.keys(vOld)));
ok("11. exactly ONE rewrite added: the catch-all to /index.html", vNew.rewrites.length === 3 && same(vNew.rewrites[2], { source: "/((?!api/|assets/|\\.well-known/)[^.]*)", destination: "/index.html" }));
const vDiff = execSync(`git diff -U0 ${REV ? `${BASE} ${REV}` : BASE} -- vercel.json`, { cwd: root }).toString().split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
ok("11. the raw diff is only that block (no reformatting of the rest of the file)", JSON.stringify(vDiff) === JSON.stringify(["+    },", "+    {", '+      "source": "/((?!api/|assets/|\\\\.well-known/)[^.]*)",', '+      "destination": "/index.html"']) || JSON.stringify(vDiff) === JSON.stringify(["-    }", "+    },", "+    {", '+      "source": "/((?!api/|assets/|\\\\.well-known/)[^.]*)",', '+      "destination": "/index.html"', "+    }"]), JSON.stringify(vDiff));
let ru = null; try { ru = createRequire(join(depDir, "package.json"))("@vercel/routing-utils"); } catch { ru = null; }
if (!ru) ok("11. (routing-utils) Vercel's own compiler available in HAPPY_DOM_DIR", false, "npm i @vercel/routing-utils there");
else {
  const t = ru.getTransformedRoutes({ rewrites: vNew.rewrites, headers: vNew.headers });
  ok("11. Vercel's routing-utils accepts the whole rewrites + headers config (no error)", !t.error, t.error ? JSON.stringify(t.error).slice(0, 200) : "");
  const re = new RegExp(ru.sourceToRegex(vNew.rewrites[2].source).src);
  const to = ["/", "/roster", "/station-hours", "/training/library/abc-123", "/my-equipment", "/reports"];
  const notTo = ["/api/digest", "/api/claude", "/assets/index-abc.js", "/.well-known/apple-app-site-association", "/.well-known/assetlinks.json", "/version.json", "/manifest.json", "/favicon.ico", "/b4c-email-logo.png", "/index.html"];
  ok("11. compiled: every app path → index.html", to.every((p) => re.test(p)));
  ok("11. compiled: /api, /assets, /.well-known and every real file (anything with a dot) are left alone", notTo.every((p) => !re.test(p)), notTo.filter((p) => re.test(p)).join(","));
}

// ---- 8 (cont.). a recovery link through the REAL main.jsx ----
{ win.localStorage.clear(); win.sessionStorage.clear();
  win.history.replaceState(null, "", "/roster#access_token=AT9&expires_in=3600&refresh_token=RT9&type=recovery");
  const rootEl = document.createElement("div"); rootEl.id = "root"; document.body.innerHTML = ""; document.body.appendChild(rootEl);
  globalThis.__fx = { me: ROLE.da }; writes.length = 0;
  await build({ ...common, outfile: join(dir, "main.mjs"), stdin: { contents: `import "./src/main.jsx";`, resolveDir: root, loader: "js" } });
  await act(async () => { await import(pathToFileURL(join(dir, "main.mjs")).href); });
  await tick(16);
  ok("8. a recovery link (even on a deep path) reaches \"Set a new password\" through the real main.jsx", /Set a new password/.test(document.body.textContent) && !document.querySelector("[data-b4c-screen]"));
  ok("8. …with the hash exactly as it arrived (nothing read, written or cleared it on the way)", win.location.hash === "#access_token=AT9&expires_in=3600&refresh_token=RT9&type=recovery" && writes.length === 0, JSON.stringify(writes));
  ok("8. …and the pending path took the PATHNAME only (/roster), never the hash", JSON.parse(win.localStorage.getItem("b4c_pending_path") || "{}").path === "/roster" && !/access_token/.test(win.localStorage.getItem("b4c_pending_path") || "")); }

// ---- fences ----
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const allowedFiles = new Set(["src/App.jsx", "src/router.js", "src/main.jsx", "vercel.json", "docs/review/routing_r1_test.mjs", "claude/B4C_Routing_R1_Draft.md"]);
const stray = [...changed, ...untracked.filter((p) => /^(src|api|shared|sql|docs\/review|ios|android|public|index\.html|vercel\.json|capacitor)/.test(p))].filter((p) => !allowedFiles.has(p));
ok("fences: only App.jsx, router.js, main.jsx, vercel.json, this test and the note (no api, shared, SQL, native, public)", stray.length === 0, JSON.stringify(stray));
const mainDiff = execSync(`git diff -U0 ${diffArgs} -- src/main.jsx`, { cwd: root }).toString().split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
ok("fences: main.jsx only GAINS the import + one module-scope capturePendingPath(pathname) (nothing removed)", mainDiff.every((l) => l.startsWith("+")) && mainDiff.filter((l) => /capturePendingPath\(/.test(l) && !/^\+import/.test(l)).length === 1 && mainDiff.some((l) => l === '+import { capturePendingPath } from "./router";'));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("Notify held: api/notify-session.js absent", REV ? !execSync(`git ls-tree --name-only ${REV} api/`, { cwd: root }).toString().includes("notify-session.js") : !existsSync(join(root, "api/notify-session.js")));
console.error = origErr;
process.exit(process.exitCode || 0);
