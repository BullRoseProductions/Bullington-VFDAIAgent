// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/ios_launch_timeout_test.mjs
// No network, no DB. Bundles the REAL src/main.jsx with esbuild (supabaseClient + the screens swapped for stubs) and
// checks the bounded launch (iOS 3.1 build 14 "blank screen" hardening):
//   1. getSession() never settles  -> "Loading…" at first, <Login/> once the 5s fallback fires
//   2. getSession() -> no session   -> <Login/> at once (the fallback adds nothing)
//   3. getSession() hangs past 5s, THEN resolves with a session -> <Login/>, then <App/> (nothing lost)
//   4. getSession() rejects         -> <Login/> (no hang on a rejection either)
//   5. getSession() -> a session    -> <App/>, and still <App/> after 5s (the fallback can't bounce a signed-in user)
//   6. vite.config.js refuses a build without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const STUBS = {
  sb: `
    const L = { cb: null };
    export const supabase = {
      auth: {
        getSession: () => globalThis.__getSession(),
        onAuthStateChange: (cb) => { globalThis.__authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        refreshSession: async () => ({}),
      },
      rpc: async () => ({ data: true, error: null }),
    };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";`,
  App: `export default function App() { return "APP-SCREEN"; }`,
  Login: `export default function Login() { return "LOGIN-SCREEN"; }`,
  SetPassword: `export function SetNewPassword() { return "SETPW-SCREEN"; }`,
  pendingScan: `export const capturePendingScan = () => {};`,
  liveUpdate: `export const markBundleHealthy = () => {}; export const watchLiveUpdates = async () => () => {};`,
  appUpdate: `export const startUpdateWatch = () => {};`,
  ConfirmDestructive: `export const DestructiveConfirmHost = () => null;`,
  NoirDialogs: `export const NoirDialogHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-launch-")), "main.under-test.mjs");
await build({
  entryPoints: [join(root, "src/main.jsx")], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^\.\/(supabaseClient|App|Login|SetPassword|pendingScan|liveUpdate|appUpdate|ConfirmDestructive|NoirDialogs)(\.jsx?|)$/ }, (a) => ({ path: a.path.replace(/^\.\//, "").replace(/\.jsx?$/, "").replace("supabaseClient", "sb"), namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js" }));
  } }],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = () => document.getElementById("root").textContent;
let run = 0;
async function launch(getSession) {
  document.body.innerHTML = '<div id="root"></div>';
  globalThis.__getSession = getSession;
  await import(pathToFileURL(out).href + "?run=" + (++run));   // main.jsx renders at module scope — a fresh instance per case
  await wait(50);
}
const never = () => new Promise(() => {});
const SESSION = { user: { id: "u1" }, expires_at: Math.floor(Date.now() / 1000) + 3600 };

// 1
await launch(never);
const t0 = screen();
await wait(5200);
ok("getSession() never settles: Loading… first, <Login/> after the 5s fallback", t0 === "Loading…" && screen() === "LOGIN-SCREEN", `${t0} -> ${screen()}`);
// 2
await launch(async () => ({ data: { session: null } }));
ok("no session: <Login/> at once", screen() === "LOGIN-SCREEN", screen());
// 3
let resolveLate;
await launch(() => new Promise((r) => { resolveLate = r; }));
await wait(5200);
const mid = screen();
resolveLate({ data: { session: SESSION } }); await wait(50);
ok("hangs past 5s, then resolves with a session: <Login/> then <App/> (nothing lost)", mid === "LOGIN-SCREEN" && screen() === "APP-SCREEN", `${mid} -> ${screen()}`);
// 3b the onAuthStateChange path also lands a signed-in user after the fallback
await launch(never);
await wait(5200);
globalThis.__authCb("SIGNED_IN", SESSION); await wait(50);
ok("after the fallback, onAuthStateChange(SIGNED_IN) still lands <App/>", screen() === "APP-SCREEN", screen());
// 4
await launch(() => Promise.reject(new Error("Load failed")));
ok("getSession() rejects: <Login/>, no hang", screen() === "LOGIN-SCREEN", screen());
// 5
await launch(async () => ({ data: { session: SESSION } }));
const first = screen();
await wait(5200);
ok("a session: <App/>, and still <App/> after 5s (the fallback is cleared)", first === "APP-SCREEN" && screen() === "APP-SCREEN", `${first} -> ${screen()}`);

// 6 the build guard (static: the config throws on a build with the vars missing)
const cfg = (await import(pathToFileURL(join(root, "vite.config.js")).href)).default;
const saved = { u: process.env.VITE_SUPABASE_URL, k: process.env.VITE_SUPABASE_ANON_KEY };
const emptyDir = mkdtempSync(join(tmpdir(), "b4c-noenv-"));
const cwd = process.cwd(); process.chdir(emptyDir);
delete process.env.VITE_SUPABASE_URL; delete process.env.VITE_SUPABASE_ANON_KEY;
let msg = "";
try { cfg({ command: "build", mode: "production" }); } catch (e) { msg = e.message; }
let serveOk = true;
try { cfg({ command: "serve", mode: "development" }); } catch { serveOk = false; }
process.env.VITE_SUPABASE_URL = "https://x.supabase.co"; process.env.VITE_SUPABASE_ANON_KEY = "k";
let withVars = true;
try { cfg({ command: "build", mode: "production" }); } catch { withVars = false; }
process.chdir(cwd);
if (saved.u === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = saved.u;
if (saved.k === undefined) delete process.env.VITE_SUPABASE_ANON_KEY; else process.env.VITE_SUPABASE_ANON_KEY = saved.k;
ok("vite.config refuses a build with no Supabase env (names both vars)", /refusing to build: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY/.test(msg), msg);
ok("…but not the dev server, and a build with the vars set (as on Vercel) passes", serveOk && withVars);
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
