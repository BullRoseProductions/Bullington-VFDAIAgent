// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/library_fold_test.mjs
// No network, no DB. Training Library folded into the Training page (client only). Renders the REAL default-export <App/>
// (sidebar, router, Training, Library, Packet) under a fake signed-in session, with supabaseClient / ConfirmDestructive /
// NoirDialogs / apiBase swapped for in-memory fakes, and checks:
//   1. the sidebar has no "Training Library" entry; Training is there
//   2. Training → Library tab works (the catalog renders)
//   3. a packet opened from the Library tab: Training stays highlighted (no dead highlight — exactly one active item);
//      "Back to library" lands on the Library tab, Training highlighted
//   4. the "library" alias (deep link / go("library")) still lands on Training's Library tab, Training highlighted
//   5. a department with "library" in disabled_modules now sees the Library tab (and no toggle for it in Settings);
//      a department with "training" disabled is bounced off the alias and the packet screen (both follow Training)
//   6. source: NAV / TOGGLEABLE_MODULES / SCREEN_PARENT / the active-state / canOpen as intended; only src/App.jsx (+ tests /
//      notes) changed; verified 132 (108 raw) unchanged; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "291013e";   // main when this was drafted (industrial-noir-45)
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/", width: 1280, height: 900 });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "IntersectionObserver", "ResizeObserver", "CustomEvent"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _one: false };
      for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "range", "gte", "lte", "gt", "lt", "ilike", "like", "filter", "match", "contains", "overlaps"]) b[m] = () => b;
      b.single = () => { b._one = true; return b; }; b.maybeSingle = b.single;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = () => b;
      b.then = (res, rej) => { const r = st.table(table); const out = b._one ? { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error } : r; return Promise.resolve(out).then(res, rej); };
      return b;
    }
    export const supabase = {
      auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "me@test.fd" } } } }),
              onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), refreshSession: async () => ({}), getUser: async () => ({ data: { user: { id: "u1", email: "me@test.fd" } } }) },
      from: q, rpc: (n, args) => ({ then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0; export const authFetch = (...a) => fetch(...a);`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, json: async () => ({}), text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-libfold-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx" }));
  } }],
});
let { default: App, createRoot, act, React } = await import(pathToFileURL(out).href);
let run = 0;

// ---------------------------------------------------------------- the fake department
const DRILL = { id: "L1", code: "FIRE-203", title: "Primary Search & Rescue", track: "Fire", level: "Intermediate", duration_min: 90, audience: null, origin: "seed", credit_name: null, published_at: "2026-10-27T12:00:00Z",
  content: { summary: "Crews conduct a coordinated primary search.", objectives: ["Maintains crew contact"], run_of_show: [{ t: "Briefing — 15 min", d: "Set crew assignments." }], materials: ["Full PPE / SCBA"], safety: ["Assign a safety officer"] } };
let DISABLED = [];
globalThis.__sb = {
  table: (t) => {
    if (t === "members") return { data: [{ id: "m1", department_id: "d-1", name: "Me Member", email: "me@test.fd", access: ["Department Admin"], status: "Active" }], error: null };
    if (t === "members_view") return { data: [{ id: "m1", department_id: "d-1", name: "Me Member", access: ["Department Admin"], status: "Active" }], error: null };
    if (t === "departments") return { data: [{ id: "d-1", name: "Test FD", station: "1", disabled_modules: DISABLED, week_start_day: 1 }], error: null };
    if (t === "library_drills") return { data: [DRILL], error: null };
    return { data: [], error: null };
  },
  answer: (n) => {
    if (n === "my_department_id") return { data: "d-1", error: null };
    if (n === "my_member_id") return { data: "m1", error: null };
    if (n === "library_drill_usage") return { data: [], error: null };
    if (n === "has_password") return { data: true, error: null };
    return { data: null, error: null };
  },
};
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(); };
const click = (el) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const navBtns = () => [...document.querySelectorAll("nav button")];
const navLabels = () => navBtns().map((b) => norm(b.textContent));
const active = () => navBtns().filter((b) => b.className.includes("dr-nav-on")).map((b) => norm(b.textContent));
const button = (re) => [...document.querySelectorAll("button")].find((b) => re.test(norm(b.textContent)));
const onLibraryTab = () => !!document.querySelector('[class*="NoirSeg"], button') && /Find a packet/.test(norm(document.body.textContent)) && /Primary Search & Rescue/.test(norm(document.body.textContent));
let host, rootR;
async function boot({ disabled = [], place = null } = {}) {
  DISABLED = disabled;
  if (rootR) await act(async () => rootR.unmount());
  if (place) {
    // src/appUpdate.js restores the screen from sessionStorage "b4c.restore.v1" ONCE per module load (memoised), so a
    // restored-place boot gets a fresh instance of the bundle — the same path a post-update reload or deep link takes.
    win.sessionStorage.setItem("b4c.restore.v1", JSON.stringify({ ...place, at: Date.now() }));
    ({ default: App, createRoot, act, React } = await import(pathToFileURL(out).href + "?run=" + (++run)));
  }
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rootR = createRoot(host);
  await act(async () => { rootR.render(React.createElement(App)); });
  await settle(12);
}
async function goNav(label) { const b = navBtns().find((x) => norm(x.textContent) === label); if (!b) return false; await click(b); await settle(); return true; }

// ---------------------------------------------------------------- 1 + 2
await boot();
ok("signed-in DA renders the app shell with a sidebar", navBtns().length > 3, JSON.stringify(navLabels().slice(0, 6)));
ok("sidebar: no 'Training Library' entry; 'Training' is there", !navLabels().includes("Training Library") && navLabels().includes("Training"), JSON.stringify(navLabels()));
await goNav("Training");
ok("Training highlighted on the Training page (exactly one active item)", JSON.stringify(active()) === '["Training"]', JSON.stringify(active()));
const libTab = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "Library");
ok("Training has its Library tab", !!libTab);
if (libTab) { await click(libTab); await settle(); }
ok("the Library tab renders the catalog (Find a packet + the drill)", onLibraryTab(), norm(document.body.textContent).slice(0, 120));

// ---------------------------------------------------------------- 3 packet + back
const card = [...document.querySelectorAll("button")].find((b) => /Primary Search & Rescue/.test(norm(b.textContent)));
if (card) { await click(card); await settle(); }
const onPacket = !!button(/Back to library/);
ok("opening a drill from the Library tab shows the packet", onPacket);
ok("…with Training highlighted — no dead highlight (exactly one active item)", JSON.stringify(active()) === '["Training"]', JSON.stringify(active()));
const back = button(/Back to library/);
if (back) { await click(back); await settle(); }
ok("Back to library → lands on Training's Library tab", onLibraryTab() && !button(/Back to library/));
ok("…Training highlighted", JSON.stringify(active()) === '["Training"]', JSON.stringify(active()));

// ---------------------------------------------------------------- 4 the alias still lands (restored place = the "library" screen)
await boot({ place: { screen: "library" } });
const aliasLanded = onLibraryTab();
ok("the 'library' screen alias (restored place / deep link) lands on Training's Library tab", aliasLanded, norm(document.body.textContent).slice(0, 100));
ok("…Training highlighted", JSON.stringify(active()) === '["Training"]', JSON.stringify(active()));

// ---------------------------------------------------------------- 5 disabled_modules
await boot({ disabled: ["library"] });
await goNav("Training");
const libTab2 = [...document.querySelectorAll("button")].find((b) => norm(b.textContent) === "Library");
if (libTab2) { await click(libTab2); await settle(); }
ok("a department with 'library' in disabled_modules now sees the Library tab (the old value is ignored)", !!libTab2 && onLibraryTab());
await boot({ disabled: ["training"], place: { screen: "library" } });
ok("a department with Training disabled: no Training in the sidebar, and the library alias bounces to the dashboard", !navLabels().includes("Training") && !onLibraryTab() && JSON.stringify(active()) === '["Dashboard"]', JSON.stringify(active()));

// ---------------------------------------------------------------- 6 source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
ok("NAV has no library entry", !/key: "library", label:/.test(src));
ok("TOGGLEABLE_MODULES no longer lists library (always on with Training)", /const TOGGLEABLE_MODULES = \["training",/.test(src) && !/TOGGLEABLE_MODULES = \[[^\]]*"library"/.test(src));
ok("SCREEN_PARENT = { library: \"training\", packet: \"training\" }", src.includes('const SCREEN_PARENT = { library: "training", packet: "training" };'));
ok("sidebar active-state lights the parent for library / packet", src.includes("const active = screen === n.key || SCREEN_PARENT[screen] === n.key;"));
ok("Ask B4C may open the library alias wherever Training is reachable", src.includes("NAV.some((n) => n.key === (SCREEN_PARENT[k] || k) && hasAny(role, n.roles) && moduleEnabled(k, dept?.disabled_modules))"));
ok("the alias + packet-back are kept", src.includes('(screen === "training" || screen === "library") && <Training key={screen} initialView={screen === "library" ? "library" : "schedule"}') && src.includes('back={() => setScreen("library")}'));
const inStrings = src.split("\n").filter((l) => /["'`][^"'`]*Training Library[^"'`]*["'`]/.test(l));
ok("no string literal in src says 'Training Library' (only comments still name the feature)", inStrings.length === 0, JSON.stringify(inStrings.map((l) => l.trim().slice(0, 90))));
// Pinned to the reviewed range (released as industrial-noir-46): base 291013e .. reviewed 9edb751 — "vs the base" would go red once later work lands.
const changed = execSync(`git diff --name-only ${BASE} 9edb751`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
// + training_slice5_ui_test.mjs: its pinned toast text follows the copy fix ("attach it from Training Plans") — test-only
const okFile = (p) => ["src/App.jsx", "docs/review/library_fold_test.mjs", "docs/review/training_slice5_ui_test.mjs", "claude/B4C_LibraryFold_Draft.md"].includes(p);
ok(`only src/App.jsx (+ tests / notes) changed in the reviewed range ${BASE}..9edb751 — no api / shared / sql / vercel.json`, changed.every(okFile), JSON.stringify(changed.filter((p) => !okFile(p))));
ok("verified untouched: App.jsx 132 (108 raw)", (src.match(new RegExp("verifie" + "d", "gi")) || []).length === 132 && (src.match(new RegExp("verifie" + "d", "g")) || []).length === 108);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
await act(async () => rootR.unmount());
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
