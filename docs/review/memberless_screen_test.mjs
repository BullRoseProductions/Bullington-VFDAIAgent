// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/memberless_screen_test.mjs
// No network, no DB. Memberless logins: the REAL src/App.jsx is bundled with esbuild (supabaseClient + apiBase swapped for
// fakes whose answers each case sets) and rendered whole in happy-dom. Checks:
//   1. a member (the identity lookup returns their row) → the normal app shell; no NotAttached
//   2. CONFIRMED empty (.single() refuses with PGRST116 AND the head count reads 0 without error) → NotAttached: the
//      sentence, the signed-in email, a Sign out button that calls supabase.auth.signOut — and nothing else (no nav)
//   3. a READ ERROR (the count errors too) → today's behavior: the shell, never the screen; likewise one email on two rows
//   4. a row appearing on reload → the normal app
//   5. DEFAULT_BRAND is the sample identity and carries no real department's name / words
//   fences: only src/App.jsx (+ this test, the note) changed; verified 132/32/14; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "7b44c65";   // live main when this was drafted (industrial-noir-56)
// REV is the working tree until review; pin it to the reviewed commit in the promote push.
const REV = process.env.REV || null;

const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "IntersectionObserver", "MutationObserver", "location", "history", "screen", "CustomEvent"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The fake client: every from() read answers [] except the two the identity effect makes on "members", which the case sets.
const MOCKS = {
  sb: `
    const W = () => globalThis.__w;
    function q(table) {
      const f = { table, opts: null, single: false, ilike: null };
      const b = {};
      for (const m of ["eq", "neq", "in", "is", "order", "limit", "gte", "lte", "lt", "gt", "or", "not", "range", "filter", "match", "contains", "overlaps"]) b[m] = () => b;
      b.select = (_c, opts) => { f.opts = opts || null; return b; };
      b.ilike = (_col, v) => { f.ilike = v; return b; };
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = () => b;
      const answer = () => {
        if (table === "members" && f.ilike !== null && f.single) return W().single();
        if (table === "members" && f.ilike !== null && f.opts && f.opts.head) { W().counts++; return W().count(); }
        return { data: f.single ? null : [], error: null, count: 0 };
      };
      b.single = () => { f.single = true; return b; };
      b.maybeSingle = () => ({ then: (r, j) => Promise.resolve({ data: null, error: null }).then(r, j) });
      b.then = (r, j) => Promise.resolve(answer()).then(r, j);
      return b;
    }
    export const supabase = {
      from: q,
      rpc: () => ({ then: (r, j) => Promise.resolve({ data: null, error: null }).then(r, j) }),
      auth: {
        getSession: async () => ({ data: { session: { user: { email: W().email }, access_token: "t" } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: async () => { W().signOuts++; return { error: null }; },
        getUser: async () => ({ data: { user: { email: W().email } } }),
      },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  api: `
    export const isNative = () => false; export const apiUrl = (p) => p;
    export async function authedFetch() { return { ok: false, status: 503, json: async () => ({}), text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-mls-")), "app.mjs");
await build({
  stdin: { contents: `export { default as App } from "./src/App.jsx"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
  } }],
});
const { App, createRoot, act, createElement } = await import(pathToFileURL(out).href);
const origErr = console.error; console.error = () => {};   // the empty fakes make some loaders log; not under test

const PGRST116 = { data: null, error: { code: "PGRST116", details: "The result contains 0 rows", message: "Cannot coerce the result to a single JSON object" } };
async function render(w) {
  globalThis.__w = { email: "someone@example.test", counts: 0, signOuts: 0, ...w };
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(createElement(App)));
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return { host, r, text: () => host.textContent, screen: () => host.querySelector('[data-b4c="not-attached"]'), navSignOut: () => host.querySelector('button[aria-label="Sign out"]') };
}
const SENTENCE = "You’re signed in, but you’re not attached to a department yet. Ask your department admin to add you to the roster — they’ll use this same email.";

// 1 — a member
let v = await render({ single: () => ({ data: { id: "m1", access: ["Member"] }, error: null }), count: () => ({ count: 1, error: null }) });
ok("1. a member → the normal app shell (the nav's Sign out is there); no NotAttached", !v.screen() && !!v.navSignOut() && !v.text().includes("not attached to a department"));
ok("1. …and the confirming count is never asked when the row was found", globalThis.__w.counts === 0);
await act(async () => v.r.unmount());

// 2 — confirmed empty
v = await render({ single: () => PGRST116, count: () => ({ count: 0, error: null }) });
const scr = v.screen();
ok("2. CONFIRMED EMPTY (.single() PGRST116 + count 0, no error) → NotAttached with the exact sentence", !!scr && scr.textContent.includes(SENTENCE), v.text().slice(0, 160));
ok("2. …shows the signed-in email", !!scr && scr.textContent.includes("Signed in as") && scr.textContent.includes("someone@example.test"));
const btns = scr ? [...scr.querySelectorAll("button")] : [];
ok("2. …exactly one control: Sign out", btns.length === 1 && btns[0].textContent.trim() === "Sign out" && scr.querySelectorAll("a, input, select, textarea").length === 0, `${btns.length}`);
ok("2. …and NOTHING else reachable: no app shell, no nav, the whole render is the screen", !v.navSignOut() && v.host.children.length === 1 && v.host.querySelectorAll("nav, aside").length === 0);
await act(async () => { btns[0].click(); });
for (let i = 0; i < 3; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
ok("2. Sign out calls supabase.auth.signOut", globalThis.__w.signOuts === 1);
await act(async () => v.r.unmount());

// 3 — read errors keep today's behavior
v = await render({ single: () => ({ data: null, error: { message: "Load failed" } }), count: () => ({ count: null, error: { message: "Load failed" } }) });
ok("3. READ ERROR (both reads fail — a flaky resume) → today's shell, NOT the screen", !v.screen() && !!v.navSignOut());
await act(async () => v.r.unmount());
v = await render({ single: () => PGRST116, count: () => ({ count: null, error: { message: "Load failed" } }) });
ok("3. .single() says no row but the confirming count ERRORS → still the shell, never the screen", !v.screen() && !!v.navSignOut() && globalThis.__w.counts === 1);
await act(async () => v.r.unmount());
v = await render({ single: () => ({ data: null, error: { code: "PGRST116", details: "The result contains 2 rows" } }), count: () => ({ count: 2, error: null }) });
ok("3. one email on two rows (.single() refuses, count 2) → the shell as today, not the screen", !v.screen() && !!v.navSignOut());
await act(async () => v.r.unmount());

// 4 — a row appearing on reload
v = await render({ single: () => PGRST116, count: () => ({ count: 0, error: null }) });
const before = !!v.screen();
await act(async () => v.r.unmount());
v = await render({ single: () => ({ data: { id: "m9", access: ["Member"] }, error: null }), count: () => ({ count: 1, error: null }) });
ok("4. the admin adds them; on reload the row is there → the normal app", before && !v.screen() && !!v.navSignOut());
await act(async () => v.r.unmount());
console.error = origErr;

// 5 — the sample brand
const show = (p) => REV ? execSync(`git show ${REV}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");
const app = show("src/App.jsx");
const brandSrc = (app.match(/const DEFAULT_BRAND = \{[\s\S]*?\n\};/) || [""])[0];
const brand = Function(`return (${brandSrc.replace(/^const DEFAULT_BRAND = /, "").replace(/;$/, "")});`)();
ok("5. DEFAULT_BRAND is the sample: \"Sample Fire Department\", \"Station 1\"", brand.name === "Sample Fire Department" && brand.station === "Station 1", JSON.stringify({ name: brand.name, station: brand.station }));
ok("5. …same shape as before (name, station, primary, accent, font, tagline, voice, logo, guidelines)", JSON.stringify(Object.keys(brand)) === JSON.stringify(["name", "station", "primary", "accent", "font", "tagline", "voice", "logo", "guidelines"]));
const REAL = ["North Hood", "Indian Harbor", "Lipan", "Granbury", "B4C Demo", "Station 20", "Neighbors helping neighbors"];
const words = [brand.name, brand.station, brand.tagline, brand.voice].join(" | ");
ok("5. …no real department's name or words anywhere in it (the five live departments + the old sample's strings)", REAL.every((r) => !words.toLowerCase().includes(r.toLowerCase())), words);
ok("5. the old strings are gone from the code entirely", !/North Hood Country VFD|Neighbors helping neighbors/.test(app));

// fences
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["claude/B4C_Memberless_Screen_Draft.md", "docs/review/memberless_screen_test.mjs", "src/App.jsx"];
ok("changed: only src/App.jsx (+ this test, the note)", files.every((f) => allowed.includes(f)) && files.includes("src/App.jsx"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("no SQL, no api/, no native, vercel.json untouched", ["sql", "api", "ios", "android", "vercel.json", "src/Login.jsx", "src/main.jsx"].every(untouched));
const tok = (p) => (show(p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
process.exit(process.exitCode || 0);
