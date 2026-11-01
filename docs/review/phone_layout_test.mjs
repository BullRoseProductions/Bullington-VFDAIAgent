// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/phone_layout_test.mjs
// No network, no DB. Phone layout (Ashlea's Oct 31 report): the Notifications screen + the horizontal-scroll sweep.
// WHAT THIS TEST CAN AND CAN'T PROVE. happy-dom has no layout engine (getBoundingClientRect is all zeros), so it CANNOT
// measure "no horizontal overflow at 360px" — that proof is the real-Chrome sweep in docs/review/phone_layout_sweep/
// (results in claude/B4C_PhoneLayout_Draft.md: before / after per offender at 360·375·390·430). What it CAN prove:
//   1. the REAL NotificationCenter, rendered with long unbroken strings, carries the fix: the title is its own shrinkable
//      span and the title + body wrap anywhere; the header keeps Back + title together and puts BOTH actions in one
//      right-pushed group; the "N new" badge can't split
//   2. the root cause of the side-to-side panning is closed: on touch screens every text field is 16px (iOS zooms in on
//      anything smaller and stays zoomed); pinch-zoom is NOT disabled; html carries overflow-wrap: break-word
//   3. the other offenders' fixes are in place: CardHead wraps its right slot; the Training "Show" select can shrink;
//      the Recruit phase grid stacks instead of a 1fr min-content floor; toast text wraps
//   4. NO band-aid: nothing sets overflow-x: hidden / clip on html, body, #root or the app shell that wasn't already there
//   fences: only the expected files; no SQL / api / native; verified 132/32/14; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "308f906";   // live main when this was drafted (industrial-noir-59)
const REV = process.env.REV ?? "f9e362c";   // pinned to the reviewed commit (gate PASS @f9e362c)
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------- 1. the real NotificationCenter
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) { try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only */ } }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const ME = "m-me";
const LONG = "reach.this.very.long.address.firefighter.volunteer@northcountyfiredepartment-example.org https://northcountyfiredepartment-example.org/a/very/long/path/that/does/not/wrap.pdf";
const ROWS = [
  { id: "n1", member_id: ME, type: "cert_expired", title: "Your Emergency Medical Technician — Basic (National Registry) certification expired", body: LONG, severity: "critical", read_at: null, created_at: new Date().toISOString() },
  { id: "n2", member_id: ME, type: "maint_overdue", title: "Engine 1 annual pump test is overdue", body: "Station 1", severity: "warning", read_at: null, created_at: new Date().toISOString() },
];
const MOCK_SB = `
  function q() { const b = {}; for (const m of ["select", "eq", "in", "is", "order", "limit", "gte", "lte", "not", "or"]) b[m] = () => b;
    b.then = (r, j) => Promise.resolve({ data: globalThis.__rows, error: null, count: globalThis.__rows.length }).then(r, j); b.maybeSingle = async () => ({ data: null, error: null }); b.single = b.maybeSingle; return b; }
  export const supabase = { from: q, rpc: async () => ({ data: null, error: null }), channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
  export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";`;
const out = join(mkdtempSync(join(tmpdir(), "b4c-phone-")), "n.mjs");
await build({
  stdin: { contents: `export { default as NotificationCenter } from "./src/Notifications.jsx"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test" }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: MOCK_SB, loader: "js" }));
  } }],
});
const { NotificationCenter, createRoot, act, createElement } = await import(pathToFileURL(out).href);
globalThis.__rows = ROWS;
const host = document.createElement("div"); document.body.appendChild(host);
const r = createRoot(host);
await act(async () => r.render(createElement(NotificationCenter, { S: {}, meId: ME, back: () => {} })));
for (let i = 0; i < 4; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
const st = (el) => (el?.getAttribute("style") || "").replace(/\s+/g, " ");
const titleEl = [...host.querySelectorAll("span")].find((s) => s.textContent === ROWS[0].title);
const bodyEl = [...host.querySelectorAll("div")].find((d) => d.textContent === LONG);
ok("1. a long notification title is its own span that can shrink and wraps anywhere (min-width: 0; overflow-wrap: anywhere)", !!titleEl && /min-width: 0/.test(st(titleEl)) && /overflow-wrap: anywhere/.test(st(titleEl)), st(titleEl));
ok("1. a body with an unbroken email + URL wraps anywhere (was cut off by the list box's overflow:hidden)", !!bodyEl && /overflow-wrap: anywhere/.test(st(bodyEl)), st(bodyEl));
const h1 = host.querySelector("h1");
ok("1. the title shrinks (min-width: 0, grows 1 1 auto) — not a 150px floor that forced the actions apart", /min-width: 0/.test(st(h1)) && /flex: 1 1 auto|flex-grow: 1/.test(st(h1)) && !/min-width: 150/.test(st(h1)), st(h1));
const markAll = [...host.querySelectorAll("button")].find((b) => /Mark all read/.test(b.textContent));
const cog = host.querySelector('button[aria-label="Notification settings"]');
ok("1. \"Mark all read\" and the settings cog share ONE right-pushed group (they wrap together, right-aligned)", !!markAll && !!cog && markAll.parentElement === cog.parentElement && /margin-left: auto/.test(st(cog.parentElement)) && cog.parentElement !== h1.parentElement, st(cog.parentElement));
const badge = [...h1.querySelectorAll("span")].find((s) => / new$/.test(s.textContent));
ok("1. the \"N new\" badge never splits from its number (white-space: nowrap)", !!badge && /white-space: nowrap/.test(st(badge)));
await act(async () => r.unmount());
const baseN = show(BASE, "src/Notifications.jsx");
ok("1. (before, for the record: main's row text had no wrap rule and the title had minWidth: 150)", !/overflowWrap/.test(baseN) && /minWidth: 150/.test(baseN));

// ---------------------------------------------------------------- 2. the root cause: iOS focus zoom
const html = show(REV, "index.html"), baseHtml = show(BASE, "index.html");
ok("2. on touch screens every text field is 16px (iOS zooms in on anything smaller and stays zoomed → the sideways pan)",
  /@media \(hover: none\) and \(pointer: coarse\)/.test(html) && /select, textarea \{ font-size: 16px !important; \}/.test(html) && /input:not\(\[type="checkbox"\]\)/.test(html));
ok("2. …and it was the cause: main's inputs were 14.5px (FS.input) / 15px (sign-in) with no such rule", !/pointer: coarse/.test(baseHtml) && /fontSize: 14\.5/.test(show(BASE, "src/App.jsx")));
const meta = (h) => (h.match(/<meta name="viewport"[^>]*>/) || [""])[0];
ok("2. pinch-zoom is NOT taken away: the viewport meta is byte-identical to main's (no maximum-scale, no user-scalable=no)", meta(html) === meta(baseHtml) && !/maximum-scale|user-scalable/.test(meta(html)), meta(html));
ok("2. html { overflow-wrap: break-word } — long strings break only when they'd overflow; nothing is hidden", /html \{ overflow-wrap: break-word; \}/.test(html));

// ---------------------------------------------------------------- 3. the other offenders
const app = show(REV, "src/App.jsx");
const cardHead = app.slice(app.indexOf("function CardHead("), app.indexOf("\n}\n", app.indexOf("function CardHead(")));
ok("3. CardHead wraps (flexWrap: wrap): its right slot drops to its own line instead of running past the card (Training clipped 43px at 360)", /display: "flex", alignItems: "center", flexWrap: "wrap"/.test(cardHead));
const showSel = (app.match(/<select aria-label="Show" value=\{listFilter\}.*$/m) || [""])[0];
ok("3. Training's \"Show\" select can shrink (maxWidth: 100%, minWidth: 0) — it was sized by its longest option", /maxWidth: "100%", minWidth: 0/.test(showSel), showSel.slice(0, 160));
ok("3. Recruit's phase grid stacks on a phone (auto-fit, minmax(min(200px, 100%), 1fr)) — a plain 1fr pushed the 3rd column past 360px", /phaseRow: \{ display: "grid", gridTemplateColumns: "repeat\(auto-fit, minmax\(min\(200px, 100%\), 1fr\)\)"/.test(app) && !/gridTemplateColumns: "repeat\(3, 1fr\)"/.test(app));
const toast = app.slice(app.indexOf("function Notification({ S, kind"), app.indexOf("\n}\n", app.indexOf("function Notification({ S, kind")));
ok("3. toast title / text wrap anywhere (they carry emails: \"We emailed a login link to …\")", (toast.match(/overflowWrap: "anywhere"/g) || []).length >= 3);

// ---------------------------------------------------------------- 4. no band-aid
// real property assignments only (JS style objects / CSS rules) — comment lines that NAME the old clip don't count
const clip = /overflow(X)?:\s*["'](hidden|clip)["']|overflow(-x)?\s*:\s*(hidden|clip)\s*[;}!]/;
const isComment = (l) => /^\+\s*(\/\/|\{?\/\*|\*|<!--)/.test(l) || /^\+\s+[a-z].*[^;{}>]$/i.test(l) && !/[:=]/.test(l);
const changedSrc = ["index.html", "src/App.jsx", "src/Notifications.jsx"];
const addedLines = changedSrc.flatMap((p) => execSync(`git diff ${REV ? `${BASE} ${REV}` : BASE} -- ${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString().split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")));
ok("4. NO overflow hidden/clip added anywhere in this change (no body/html/#root/shell clip masking the overflow)", !addedLines.some((l) => !isComment(l) && clip.test(l)), JSON.stringify(addedLines.filter((l) => !isComment(l) && clip.test(l))));
ok("4. index.html has no overflow-x clip on html / body at all", !/(html|body)[^{]*\{[^}]*overflow(-x)?\s*:\s*(hidden|clip)/.test(html));

// fences
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = (f) => ["index.html", "src/App.jsx", "src/Notifications.jsx", "docs/review/phone_layout_test.mjs", "claude/B4C_PhoneLayout_Draft.md"].includes(f) || f.startsWith("docs/review/phone_layout_sweep/");
ok("changed: index.html, src/App.jsx, src/Notifications.jsx (+ this test, the sweep harness, the note)", files.every(allowed) && files.includes("index.html"), JSON.stringify(files.filter((f) => !allowed(f))));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("no SQL, api/, shared/, native, vercel.json", ["sql", "api", "shared", "ios", "android", "vercel.json"].every(untouched));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
process.exit(process.exitCode || 0);
