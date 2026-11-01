// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/scroll_affordance_test.mjs
// No network, no DB. The wide-table scroll affordance: every table that scrolls sideways inside its card now sits in
// ScrollX — a right-edge fade while columns are hidden to the right, and at phone widths a one-line "Swipe for more →".
// WHAT THIS CAN AND CAN'T PROVE: happy-dom has no layout, so scrollWidth / clientWidth are always 0 there. The test gives the
// scroller explicit widths (a getter on the element whose style is overflowX: auto) and a controllable matchMedia, then
// renders the REAL ScrollX out of the bundled src/App.jsx. So it proves the component's logic — hint present at a 360px
// phone when the content is wider than its box, absent when it fits, fade only while there's more to the right, re-measure
// when rows arrive — not that a given report really is wider than 360px. That half is the real-Chrome sweep
// (docs/review/phone_layout_sweep/), recorded in claude/B4C_ScrollAffordance_Draft.md.
//   1. phone + overflowing → fade + "Swipe for more →"            2. phone + fits → neither
//   3. scrolled to the right end → fade gone; the hint keeps its line, faded out (no jump)
//   4. desktop + overflowing → fade, no hint                       5. rows arriving after mount → re-measured
//   6. the scroller keeps its card style (+ overflowX: auto); the outer margins move to the wrapper; fade colour per skin
//   7. source: the ten in-card table scrollers use ScrollX — the four Station Hours tables among them — and the table
//      markup is untouched (each call-site change is the tag rename + dropping overflowX); no overflow hidden / clip added
//   fences: only src/App.jsx (+ this test + the note); verified 132/32/14; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "8869d3d";   // live main when this was drafted (industrial-noir-60)
const REV = process.env.REV ?? "d7cfb0e";   // pinned to the reviewed commit (gate PASS @d7cfb0e)
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");

const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
let PHONE = true;
const mqs = new Set();
win.matchMedia = (q) => { const m = { media: q, get matches() { return /max-width: 640px/.test(q) ? PHONE : false; }, addEventListener: (_, f) => mqs.add(f), removeEventListener: (_, f) => mqs.delete(f) }; return m; };
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "MutationObserver", "location", "history", "CustomEvent"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
// No layout in happy-dom: the scroller (the element styled overflowX: auto) reports the widths the case sets.
const D = { sw: 0, cw: 0, left: 0 };
const isScroller = (el) => el.style?.overflowX === "auto";
Object.defineProperty(win.HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return isScroller(this) ? D.sw : 0; } });
Object.defineProperty(win.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return isScroller(this) ? D.cw : 0; } });
Object.defineProperty(win.HTMLElement.prototype, "scrollLeft", { configurable: true, get() { return isScroller(this) ? D.left : 0; }, set() {} });
globalThis.ResizeObserver = undefined;   // the every-render measure + resize listener carry it; RO is a bonus where it exists
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `export const supabase = { from: () => ({}), rpc: async () => ({}), auth: { getSession: async () => ({ data: {} }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
       export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test"; export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, json: async () => ({}) }; }`,
  qr: `export const QRCodeCanvas = () => null; export const QRCodeSVG = () => null; export default () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-sca-")), "app.mjs");
await build({
  stdin: { contents: `export { ScrollX, NoirSkin } from "./src/App.jsx"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onResolve({ filter: /^qrcode\.react$/ }, () => ({ path: "qr", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + "\nexport { ScrollX, NoirSkin };\n", loader: "jsx" }));
  } }],
});
const { ScrollX, NoirSkin, createRoot, act, createElement: h } = await import(pathToFileURL(out).href);

const CARD = { background: "linear-gradient(180deg, #0F131A, #0B0E13)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 12, padding: "8px 0", marginBottom: 14 };
const table = (cols) => h("table", null, h("tbody", null, h("tr", null, ...Array.from({ length: cols }, (_, i) => h("td", { key: i }, `col ${i}`)))));
async function mount({ phone, sw, cw, left = 0, noir = true, cols = 6 }) {
  PHONE = phone; Object.assign(D, { sw, cw, left });
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  const el = (c) => h(ScrollX, { style: CARD }, table(c));
  await act(async () => r.render(noir ? h(NoirSkin, null, el(cols)) : el(cols)));
  const q = () => ({ fade: host.querySelector("[data-scroll-fade]"), hint: host.querySelector("[data-scroll-hint]"), scroller: [...host.querySelectorAll("div")].find(isScroller) });
  return { host, r, q, rerender: async (c) => act(async () => r.render(noir ? h(NoirSkin, null, el(c)) : el(c))) };
}

// 1 — a 360px phone; the table is 620 wide in a 358 box
let v = await mount({ phone: true, sw: 620, cw: 358 });
ok("1. phone (360) + overflowing → the right-edge fade is shown", !!v.q().fade);
ok("1. …and the one-line hint \"Swipe for more →\", visible", v.q().hint?.textContent === "Swipe for more →" && v.q().hint.style.opacity === "1");
ok("1. …the fade is decoration only: aria-hidden, pointer-events none (taps reach the table)", v.q().fade.getAttribute("aria-hidden") === "true" && v.q().fade.style.pointerEvents === "none");
// 3 — swipe to the right end
D.left = 262; await act(async () => { v.q().scroller.dispatchEvent(new win.Event("scroll")); });
ok("3. scrolled to the right end → the fade goes (nothing more to the right)", !v.q().fade);
ok("3. …the hint keeps its line but fades out (opacity 0), so the card doesn't jump while swiping", !!v.q().hint && v.q().hint.style.opacity === "0");
D.left = 100; await act(async () => { v.q().scroller.dispatchEvent(new win.Event("scroll")); });
ok("3. back from the end → fade and hint return", !!v.q().fade && v.q().hint.style.opacity === "1");
await act(async () => v.r.unmount());

// 2 — fits
v = await mount({ phone: true, sw: 358, cw: 358 });
ok("2. phone + the table fits → no fade, no hint", !v.q().fade && !v.q().hint);
// 5 — rows / columns arrive after mount: no resize event, the next render re-measures
D.sw = 700; await v.rerender(9);
ok("5. the content grows after mount (rows arrive) → re-measured: fade + hint appear", !!v.q().fade && !!v.q().hint);
D.sw = 358; await v.rerender(3);
ok("5. …and shrinks back to fitting → both gone again", !v.q().fade && !v.q().hint);
await act(async () => v.r.unmount());

// 4 — desktop
v = await mount({ phone: false, sw: 900, cw: 700 });
ok("4. wider than phone + overflowing → the fade shows, the phone hint doesn't", !!v.q().fade && !v.q().hint);
// rotating / resizing into phone width flips the hint on (matchMedia change)
PHONE = true; await act(async () => { mqs.forEach((f) => f()); });
ok("4. …crossing into phone width (matchMedia change) → the hint appears", !!v.q().hint);
await act(async () => v.r.unmount());

// 6 — style handling + skin colour
v = await mount({ phone: true, sw: 620, cw: 358 });
const sc = v.q().scroller, wrap = v.host.firstElementChild;
ok("6. the scroller keeps its card style (background, border, radius, padding) with overflowX: auto", sc.style.padding === "8px 0px" || sc.style.padding === "8px 0", sc.style.padding);
ok("6. …and the card's border-radius / face are on the scroller, not the wrapper", sc.style.borderRadius === "12px" && /linear-gradient/.test(sc.style.background) && !wrap.style.background);
ok("6. the outer margin moved to the wrapper (spacing between cards unchanged), not left on the scroller", wrap.style.marginBottom === "14px" && !sc.style.marginBottom);
ok("6. the fade follows the card's corner radius and the Noir face colour", /^0(px)? 12px 12px 0(px)?$/.test(v.q().fade.style.borderRadius) && /#0D1016|13, 16, 22\)\)?$/i.test(v.q().fade.style.background), v.q().fade.style.background);
await act(async () => v.r.unmount());
v = await mount({ phone: true, sw: 620, cw: 358, noir: false });
ok("6. outside the Noir skin the fade ends in the plain card colour (#13161B)", /#13161B|19, 22, 27/i.test(v.q().fade.style.background), v.q().fade.style.background);
await act(async () => v.r.unmount());

// 7 — source
const app = show(REV, "src/App.jsx"), baseApp = show(BASE, "src/App.jsx");
const fnBody = (src, name) => { const i = src.indexOf(`function ${name}(`); const j = src.indexOf("\nfunction ", i + 10); return src.slice(i, j); };
const sh = fnBody(app, "StationHoursReport");
ok("7. the four Station Hours tables (Hours by member · ISO hours · ISO by house · Shift log) are in ScrollX",
  (sh.match(/<ScrollX style=\{\{ \.\.\.FS\.cardNoir/g) || []).length === 4 && !/overflowX: "auto"/.test(sh));
const sites = (app.match(/<ScrollX[ >]/g) || []).length;
ok("7. ten in-card table scrollers use it: Station Hours ×4, Attendance detail, Capital plan ×3, Who's showing up, Qualifications matrix", sites === 10, `${sites}`);
const left = app.split("\n").filter((l) => /overflowX: "auto"/.test(l)).map((l) => l.trim());
ok("7. the only raw overflowX scrollers left are not tables: ScrollX itself, the forecast card + its bar chart, the sheet tab strip",
  left.length === 4 && /ref=\{ref\}/.test(left[0]) && left.some((l) => /height: 170/.test(l)) && left.some((l) => /^\{tabs &&/.test(l)) && left.some((l) => /marginBottom: 14, overflowX/.test(l)), JSON.stringify(left.map((l) => l.slice(0, 50))));
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const diff = execSync(`git diff -U0 ${diffArgs} -- src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const hunks = diff.split("\n@@").slice(1);
const defHunk = hunks.filter((hk) => /function ScrollX/.test(hk));
const siteHunks = hunks.filter((hk) => !/function ScrollX/.test(hk));
const siteLine = (l) => /^[-+]\s*<\/?(div|ScrollX)\b/.test(l);
ok("7. one hunk adds ScrollX (next to Card); every other hunk only renames a scroller's tags (div ⇄ ScrollX, overflowX dropped) — table markup untouched",
  defHunk.length === 1 && siteHunks.length === 20 && siteHunks.every((hk) => hk.split("\n").slice(1).filter((l) => /^[-+]/.test(l)).every(siteLine)), `${defHunk.length} + ${siteHunks.length}`);
ok("7. each renamed opening tag keeps the exact style it had, minus overflowX",
  siteHunks.every((hk) => { const m = hk.match(/^-(.*)<div(.*)$/m), p = hk.match(/^\+(.*)<ScrollX(.*)$/m); if (!m) return /^-\s*<\/div>/m.test(hk); return p && m[1] === p[1] && m[2].replace(/,? ?overflowX: "auto"/, "").replace(/ style=\{\{\s*\}\}/, "") === p[2]; }));
const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++") && !/^\+\s*\/\//.test(l));
ok("7. no overflow: hidden / clip added (the affordance doesn't hide anything)", !added.some((l) => /overflow[XY]?\s*:\s*["']?(hidden|clip)/i.test(l)));

// fences
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const allowed = new Set(["src/App.jsx", "docs/review/scroll_affordance_test.mjs", "claude/B4C_ScrollAffordance_Draft.md"]);
const stray = [...changed, ...untracked.filter((p) => /^(src|api|shared|sql|docs\/review|ios|android|index\.html|vercel\.json)/.test(p))].filter((p) => !allowed.has(p));
ok("fences: only src/App.jsx, this test and the note", stray.length === 0, JSON.stringify(stray));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("Notify held: api/notify-session.js absent", REV ? !execSync(`git ls-tree --name-only ${REV} api/`, { cwd: root }).toString().includes("notify-session.js") : !existsSync(join(root, "api/notify-session.js")));
void baseApp;
process.exit(process.exitCode || 0);
