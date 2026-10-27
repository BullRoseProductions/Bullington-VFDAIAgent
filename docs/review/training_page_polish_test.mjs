// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/training_page_polish_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs, apiBase faked)
// and checks the Training page polish (claude/B4C_TrainingPage_Polish_BuildOrder.md):
//   1. the Schedule | Training Plans toggle sits UNDER the band header — after the page title in document order, as the first
//      thing in the page body — on the leader view, the member view and Training Plans, and still switches views
//   2. the "finished drills with no length recorded" notice: tucked by default (header + count + chevron only), expands /
//      collapses on click (aria-expanded), amber kept (left border + icon), shown only while noLen > 0
//   3. the source: only src/App.jsx; the toggle is no longer in any PageShell `above`; verified count unchanged; Notify absent
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
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const MOCKS = {
  sb: `
    function q() { const b = {}; for (const m of ["select","eq","neq","in","is","order","limit","gte","lte","not","maybeSingle","single","insert","update","delete","upsert"]) b[m] = () => b;
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej); return b; }
    export const supabase = { from: q, rpc: () => ({ then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej) }),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test"; export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-polish-")), "app.under-test.mjs");
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
const { FIRE } = await import(pathToFileURL(join(root, "src/theme.js")).href);

const today = new Date();
const mk = (id, title, dAgo, extra = {}) => { const d = new Date(today); d.setDate(d.getDate() - dAgo); return { id, title, y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), done: true, durationMin: null, audience: "everyone", isOffsite: false, attendance: [{ member_id: "m1" }, { member_id: "m2" }], plans: [], planId: null, ...extra }; };
const NOLEN = [mk("a", "Hose drill", 3), mk("b", "Ladder drill", 10), mk("c", "Pump ops", 17)];
const FINE = [mk("d", "SCBA drill", 5, { durationMin: 90 }), mk("e", "Board meeting", 6, { audience: "board" }), mk("f", "Empty drill", 7, { attendance: [] })];
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => s.replace(/\s+/g, " ").trim();
async function mount(role, sessions) {
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: [], setPlan: () => {}, loadPlans: () => {}, sessions, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: [{ id: "m1", name: "A", status: "Active", access: ["Member"] }], meId: "m1", notify: () => {}, dept: { name: "North Hood" }, addFeedback: () => {} })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const toggles = (h) => [...h.querySelectorAll("button[aria-pressed]")].filter((b) => ["Schedule", "Training Plans"].includes(norm(b.textContent)));
// position: the visible view's toggle comes AFTER its h1 (the band) in document order, inside the same page shell, and is the
// first meaningful thing after the band
const after = (a, b) => !!(a.compareDocumentPosition(b) & win.Node.DOCUMENT_POSITION_FOLLOWING);
function placement(h, title) {
  const h1 = [...h.querySelectorAll("h1")].find((x) => norm(x.textContent) === title);
  const vis = toggles(h).filter((b) => !b.closest('[style*="display: none"]'));
  const seg = vis[0]?.parentElement;
  return { h1: !!h1, segAfterTitle: !!(h1 && seg && after(h1, seg)), shell: !!(h1 && seg && h1.closest('[style*="border-radius: 20px"]') === seg.closest('[style*="border-radius: 20px"]')), seg };
}

// 1 the toggle under the band — leader, then Training Plans, then the member view
{ const { host, unmount } = await mount(["Department Admin"], [...NOLEN, ...FINE]);
  const p = placement(host, "Keep training on schedule");
  const notice = [...host.querySelectorAll("button[aria-expanded]")].find((b) => /no length recorded/.test(b.textContent));
  ok("leader view: the toggle is under the band header (after the title, same page shell) and above the drills notice",
    p.h1 && p.segAfterTitle && p.shell && notice && after(p.seg, notice), JSON.stringify({ h1: p.h1, after: p.segAfterTitle, shell: p.shell }));
  await act(async () => { toggles(host).find((b) => norm(b.textContent) === "Training Plans").dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick(); await tick();
  const q = placement(host, "Training Plans");
  ok("Training Plans: the toggle is under its band header too (after the title, same page shell), Plans pressed", q.h1 && q.segAfterTitle && q.shell
    && toggles(host).filter((b) => !b.closest('[style*="display: none"]')).find((b) => norm(b.textContent) === "Training Plans")?.getAttribute("aria-pressed") === "true");
  await act(async () => { toggles(host).filter((b) => !b.closest('[style*="display: none"]')).find((b) => norm(b.textContent) === "Schedule").dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick();
  ok("…and switches back to Schedule", placement(host, "Keep training on schedule").segAfterTitle && !!host.querySelector("h1") && norm(host.textContent).includes("Keep training on schedule"));
  // same spot: in both views the segmented control is the FIRST child of the page body (NoirSkin renders no wrapper, so the
  // body's first element is the control's own box)
  const firstAfterBand = (title) => { const h1 = [...host.querySelectorAll("h1")].find((x) => norm(x.textContent) === title); const band = h1.closest(".noir-hero"); const body = band.nextElementSibling; return body && body.firstElementChild; };
  ok("same spot on both: the segmented control is the first element of the body directly under the band", toggles(host).includes(firstAfterBand("Keep training on schedule")?.firstElementChild) || firstAfterBand("Keep training on schedule")?.querySelector('button[aria-pressed]') === toggles(host)[0]);
  unmount(); }
{ const { host, unmount } = await mount(["Member"], [...NOLEN, ...FINE]);
  const p = placement(host, "Your training calendar");
  ok("member view: the toggle is under the band header too (after the title, same page shell)", p.h1 && p.segAfterTitle && p.shell);
  ok("member view: no drills notice (it's an officer instruction)", !/no length recorded/.test(host.textContent));
  unmount(); }

// 2 the notice
{ const { host, unmount } = await mount(["Department Admin"], [...NOLEN, ...FINE]);
  const head = () => [...host.querySelectorAll("button[aria-expanded]")].find((b) => /no length recorded/.test(b.textContent));
  const card = head().parentElement;
  const t0 = norm(card.textContent);
  ok("tucked by default: header shows the count (3 — the board / measured / empty drills excluded), body hidden", head().getAttribute("aria-expanded") === "false"
    && t0 === "3 finished drills with no length recorded" && !t0.includes("Nobody marked present"), t0);
  const bl = (card.style.borderLeft || "").toLowerCase();
  ok("amber kept: the 3px amber left border", bl.includes("3px") && (bl.includes(FIRE.amberText.toLowerCase()) || bl.includes("214, 169, 94")), bl);
  ok("…the header icon is the amber clock (not CardHead's red)", [...head().querySelectorAll("svg")].some((s) => (s.getAttribute("stroke") || s.getAttribute("color") || "").toLowerCase() === FIRE.amberText.toLowerCase()));
  await act(async () => { head().dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick();
  const t1 = norm(card.textContent);
  ok("click expands: the explanation + the session list (title · date · N present)", head().getAttribute("aria-expanded") === "true" && t1.includes("Nobody marked present at these is getting training hours") && t1.includes("Hose drill") && t1.includes("2 present"));
  await act(async () => { head().dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await tick();
  ok("click again tucks it away", head().getAttribute("aria-expanded") === "false" && !norm(card.textContent).includes("Nobody marked present"));
  unmount(); }
{ const { host, unmount } = await mount(["Department Admin"], FINE);
  ok("no drills missing a length -> no notice", !/no length recorded/.test(host.textContent));
  unmount(); }
{ const { host, unmount } = await mount(["Department Admin"], [NOLEN[0], ...FINE]);
  ok("one drill -> singular header", [...host.querySelectorAll("button[aria-expanded]")].some((b) => norm(b.textContent) === "1 finished drill with no length recorded"));
  unmount(); }

// 3 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
// Structural fences are PINNED to this slice's own release (c6aa254, a --no-ff merge whose first parent is the main it landed
// on): "vs origin/main" was true only until the next slice merged. Historical = the release vs its parent; ongoing guards
// compare a block this slice owns in today's tree with the release's copy.
const REL = "c6aa254";
const at = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const rel = at(REL), relParent = at(`${REL}^1`);
const changedFiles = execSync(`git diff --name-only ${REL}^1 ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("Training page polish (c6aa254) changed only src/App.jsx (runtime) vs its parent", JSON.stringify(changedFiles) === '["src/App.jsx"]', JSON.stringify(changedFiles));
// 4 in-body sites since Training Library slice 1 added the third tab (the Library view puts the toggle in its body too —
// the invariant this guards, "never in the band's `above` slot", is unchanged).
ok("the toggle is in no PageShell `above` slot any more", !/above=\{[^}]*viewToggle/.test(src) && (src.match(/\{viewToggle\}\{\/\* Schedule \| Training Plans/g) || []).length === 4);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged by Training page polish (c6aa254) vs its parent", tok(rel) === tok(relParent), `${tok(rel)} vs ${tok(relParent)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
