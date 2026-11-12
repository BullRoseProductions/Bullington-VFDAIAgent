// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/live_data_1b_test.mjs
// LIVE DATA SLICE 1b (client): src/liveData.js + useAutoRefresh's trigger (src/useReconnect.js) + root loadSessions wiring.
// Bundles src/liveData.js (with the real useReconnect.js and React) against a FAKE supabase: per-client instances (each with
// its own department / auth listeners) sharing one fake Realtime bus. Short debounce/interval values are passed through the
// hook's options to keep the run fast; the defaults (1.5s / 5s) are asserted separately and are what App.jsx uses.
//   KILL SWITCH: VITE_LIVE_DATA_ENABLED=0 at build time disables live data entirely (check 7 bundles with it).
//   1. two clients, same department: B's save emits a signal → A's loader runs once, no navigation
//   2. an open editor defers the refresh until it closes (+ the 2s grace), then it runs once
//   3. a burst of 5 signals inside 1s → exactly one refetch; the minimum interval is respected (no drop: a later signal
//      inside the window waits it out and runs once)
//   4. an errored / closed socket loses nothing: the resume refresh still runs and the channel is rebuilt on resume
//   5. SIGNED_OUT leaves the channel; SIGNED_IN as a user of another department rejoins the new topic
//   6. the channel is private, the topic is dept:<my_department_id()>, the event is 'live'; another key does not run the
//      trainings loader; a member of another department never sees the signal
//   7. VITE_LIVE_DATA_ENABLED=0 → no channel is ever created, the resume refresh still works
//   8. no table writes; App.jsx wiring; defaults; invariants (verified 132/32/14, Notify held, cron/vercel untouched);
//      files-changed fence vs 17153e2
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "17153e2";   // the build-18 re-cut sha this slice is cut from
const REV = "cdf1d37";    // gate PASS @cdf1d37 (2026-11-12): fences pinned to the released range BASE..REV
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const realInfo = console.info; console.info = () => {};   // the module's sparse "[live]" logs

// One fake supabase module; the INSTANCE comes from the import URL's query (?a / ?b / ?off) so each simulated client has
// its own module state (its own liveData singleton) while sharing the Realtime bus.
const FAKE_SB = `
  const inst = new URL(import.meta.url).search.slice(1) || "a";
  const st = () => globalThis.__clients[inst];
  const bus = () => globalThis.__bus;
  function channel(topic, cfg) {
    const ch = { topic, cfg, handlers: [], statusCb: null, removed: false,
      on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return ch; },
      subscribe(cb) { ch.statusCb = cb; st().channels.push(ch); bus().channels.add(ch); setTimeout(() => !ch.removed && cb && cb("SUBSCRIBED"), 0); return ch; } };
    st().created.push({ topic, cfg });
    return ch;
  }
  export const supabase = {
    rpc: (n) => { st().calls.push(n); return Promise.resolve(n === "my_department_id" ? { data: st().dept, error: null } : { data: null, error: null }); },
    channel,
    removeChannel: (ch) => { ch.removed = true; bus().channels.delete(ch); st().removed.push(ch.topic); try { ch.statusCb && ch.statusCb("CLOSED"); } catch {} return Promise.resolve("ok"); },
    from: (t) => { st().writes.push(t); return {}; },
    auth: { onAuthStateChange: (cb) => { st().auth.push(cb); return { data: { subscription: { unsubscribe() {} } } }; } },
  };
  export const APP_ORIGIN = "https://app.test";`;

async function bundle(flagOff) {
  const out = join(mkdtempSync(join(tmpdir(), "b4c-live1b-")), "live.under-test.mjs");
  await build({
    entryPoints: [join(root, "src/liveData.js")], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
    banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
    loader: { ".js": "jsx" },
    define: { "import.meta.env": JSON.stringify({ VITE_LIVE_DATA_ENABLED: flagOff ? "0" : undefined, MODE: "test" }) },
    plugins: [{ name: "fakes", setup(b) {
      b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: "cap", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: a.path === "sb" ? FAKE_SB : "export const Capacitor = { isNativePlatform: () => false };", loader: "js" }));
      b.onLoad({ filter: /src[\\/]liveData\.js$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { createRoot } from "react-dom/client";\nexport { act, default as React } from "react";\nexport { useEditorOpen } from "./useReconnect";`, loader: "jsx" }));
    } }],
  });
  return out;
}
const outOn = await bundle(false), outOff = await bundle(true);
const newClient = (dept) => ({ dept, calls: [], created: [], channels: [], removed: [], writes: [], auth: [] });
globalThis.__bus = { channels: new Set() };
globalThis.__clients = { a: newClient("dept-A"), b: newClient("dept-A"), c: newClient("dept-B"), off: newClient("dept-A") };
const A = await import(pathToFileURL(outOn).href + "?a");
const C = await import(pathToFileURL(outOn).href + "?c");
const OFF = await import(pathToFileURL(outOff).href + "?off");
const { act, React, createRoot } = A;

const sleep = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/* "B's save": the DB trigger would call realtime.send(…, 'dept:<B's department>'); every channel joined on that topic
   receives the broadcast (Realtime's job). Payload shape as live: {k, at, id}. */
function emit(topic, k = "trainings") {
  for (const ch of globalThis.__bus.channels) {
    if (ch.topic !== topic || ch.removed) continue;
    for (const h of ch.handlers) if (h.type === "broadcast" && h.filter?.event === "live") h.cb({ event: "live", payload: { k, at: new Date().toISOString(), id: "m" + Math.random() } });
  }
}
const resume = () => act(async () => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new win.Event("visibilitychange")); });

async function mountLive(M, { keys = ["trainings"], editorOpen = null, opts = { debounceMs: 60, liveMinIntervalMs: 250 } } = {}) {
  const runs = [];
  const loader = async () => { runs.push(Date.now()); };
  function Screen() { M.useLiveRefresh(keys, loader, opts); return null; }
  let setOpen = null;
  function Editor() { const [o, s] = M.React.useState(editorOpen.v); setOpen = s; M.useEditorOpen(o); return null; }
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = M.createRoot(host);
  await M.act(async () => { r.render(M.React.createElement(M.React.Fragment, null, M.React.createElement(Screen), editorOpen ? M.React.createElement(Editor) : null)); });
  return { runs, unmount: () => M.act(async () => { r.unmount(); }), setOpen: (v) => M.act(async () => { setOpen(v); }) };
}

// ---------------------------------------------------------------- 6 (shape) + 1. two clients, same department
{
  const a = await mountLive(A);
  await sleep(30);
  const st = A.__liveState();
  const made = globalThis.__clients.a.created[0];
  ok("6. one channel, topic = dept:<my_department_id()> (from the rpc)", globalThis.__clients.a.calls.includes("my_department_id") && st.topic === "dept:dept-A" && globalThis.__clients.a.created.length === 1);
  ok("6. the channel is PRIVATE and listens for broadcast event 'live'", made?.cfg?.config?.private === true && globalThis.__clients.a.channels[0].handlers.some((h) => h.type === "broadcast" && h.filter.event === "live"));
  await sleep(300);   // past the mount-seeded min interval
  const before = a.runs.length;
  emit("dept:dept-A");                       // B (same department) saved a training
  await sleep(40);
  ok("1. nothing runs before the debounce elapses", a.runs.length === before);
  await sleep(120);
  ok("1. B's save → A's loader runs ONCE, no navigation, no remount", a.runs.length === before + 1, `runs=${a.runs.length - before}`);
  emit("dept:dept-A", "attendance"); await sleep(400);
  ok("6. a signal for another key does not run the trainings loader", a.runs.length === before + 1);

  // a member of another department joins their own topic and never sees A's department signal
  const c = await mountLive(C); await sleep(330);
  const cBefore = c.runs.length;
  emit("dept:dept-A"); await sleep(400);
  ok("6. a member of department B is on dept:dept-B and is not refreshed by dept:dept-A's signal", C.__liveState().topic === "dept:dept-B" && c.runs.length === cBefore);
  await c.unmount();

  // ------------------------------------------------------------ 3. burst → exactly one refetch; min interval, no drop
  const b0 = a.runs.length;
  for (let i = 0; i < 5; i++) { emit("dept:dept-A"); await sleep(15); }
  await sleep(200);
  ok("3. a burst of 5 signals inside the window → exactly ONE refetch", a.runs.length === b0 + 1, `runs=${a.runs.length - b0}`);
  emit("dept:dept-A"); await sleep(90);
  ok("3. a signal inside the minimum interval does not run early", a.runs.length === b0 + 1);
  await sleep(300);
  ok("3. …and is NOT dropped: it runs once when the interval allows", a.runs.length === b0 + 2, `runs=${a.runs.length - b0}`);

  // ------------------------------------------------------------ 4. an errored socket loses nothing
  const ch0 = globalThis.__clients.a.channels.at(-1);
  await act(async () => { ch0.statusCb("CHANNEL_ERROR"); });
  ok("4. CHANNEL_ERROR marks the channel broken (silently; nothing thrown)", A.__liveState().broken === true);
  const createdBefore = globalThis.__clients.a.created.length;
  await resume(); await sleep(40);
  ok("4. on resume the broken channel is rebuilt (left + rejoined on the same topic)", globalThis.__clients.a.created.length === createdBefore + 1 && A.__liveState().broken === false && A.__liveState().topic === "dept:dept-A" && globalThis.__clients.a.removed.includes("dept:dept-A"));
  const r0 = a.runs.length;
  emit("dept:dept-A"); await sleep(400);
  ok("4. signals flow again on the rebuilt channel", a.runs.length === r0 + 1);
  await a.unmount();
  ok("lifecycle: the last subscriber unmounting leaves the channel", A.__liveState().channel === null && A.__liveState().subscriberCount === 0);
}

// ---------------------------------------------------------------- 4b. the resume refresh still runs with no socket at all
{
  globalThis.__clients.a.dept = null;   // my_department_id() → null: no topic, no channel (degrades to today's behaviour)
  const runs = [];
  function Screen() { A.useLiveRefresh(["trainings"], async () => { runs.push(1); }, { minIntervalMs: 0, debounceMs: 60, liveMinIntervalMs: 250 }); return null; }
  const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Screen)); }); await sleep(2100);
  const createdBefore = globalThis.__clients.a.created.length;
  await resume(); await sleep(50);
  ok("4. with no channel at all, the resume refresh still runs the loader", runs.length === 1 && A.__liveState().channel === null && globalThis.__clients.a.created.length === createdBefore);
  await act(async () => { r.unmount(); });
  globalThis.__clients.a.dept = "dept-A";
}

// ---------------------------------------------------------------- 2. an open editor defers, then runs once
{
  const a = await mountLive(A, { editorOpen: { v: true } });
  await sleep(330);
  const e0 = a.runs.length;
  emit("dept:dept-A"); await sleep(600);
  ok("2. with an editor open the signal does NOT refresh under the form", a.runs.length === e0);
  await a.setOpen(false);
  await sleep(1200);
  ok("2. still deferred inside the 2s grace after the editor closes", a.runs.length === e0);
  await sleep(1600);
  ok("2. …then runs exactly once", a.runs.length === e0 + 1, `runs=${a.runs.length - e0}`);
  await a.unmount();
}

// ---------------------------------------------------------------- 5. SIGNED_OUT leaves; another user's department rejoins
{
  const a = await mountLive(A); await sleep(40);
  ok("5. joined dept:dept-A", A.__liveState().topic === "dept:dept-A");
  const authCbs = globalThis.__clients.a.auth;
  ok("5. one auth listener for the whole app (wired once)", authCbs.length === 1);
  await act(async () => { authCbs.forEach((cb) => cb("SIGNED_OUT", null)); });
  ok("5. SIGNED_OUT leaves the channel", A.__liveState().channel === null);
  globalThis.__clients.a.dept = "dept-Z";
  await act(async () => { authCbs.forEach((cb) => cb("SIGNED_IN", {})); }); await sleep(40);
  ok("5. SIGNED_IN as a user of another department joins the NEW topic", A.__liveState().topic === "dept:dept-Z" && globalThis.__clients.a.created.at(-1).topic === "dept:dept-Z");
  await act(async () => { authCbs.forEach((cb) => cb("TOKEN_REFRESHED", {})); }); await sleep(20);
  ok("5. TOKEN_REFRESHED does not rejoin (supabase-js re-auths the socket itself)", globalThis.__clients.a.created.at(-1).topic === "dept:dept-Z" && globalThis.__clients.a.created.filter((x) => x.topic === "dept:dept-Z").length === 1);
  await a.unmount();
  globalThis.__clients.a.dept = "dept-A";
}

// ---------------------------------------------------------------- 7. kill switch
{
  const o = await mountLive(OFF, { opts: { minIntervalMs: 0, debounceMs: 60, liveMinIntervalMs: 250 } });
  await sleep(2100);
  emit("dept:dept-A"); await sleep(300);
  ok("7. VITE_LIVE_DATA_ENABLED=0: LIVE_ENABLED false, no channel, no rpc, no auth listener", OFF.LIVE_ENABLED === false && globalThis.__clients.off.created.length === 0 && globalThis.__clients.off.calls.length === 0 && globalThis.__clients.off.auth.length === 0);
  await OFF.act(async () => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new win.Event("visibilitychange")); });
  await sleep(50);
  ok("7. …and the resume refresh still runs (exactly useAutoRefresh)", o.runs.length === 1);
  await o.unmount();
}

// ---------------------------------------------------------------- 8. source, wiring, defaults, invariants, fence
const lsrc = readFileSync(join(root, "src/liveData.js"), "utf8");
const app = readFileSync(join(root, "src/App.jsx"), "utf8");
const ur = readFileSync(join(root, "src/useReconnect.js"), "utf8");
ok("8. defaults: debounce 1.5s, min interval 5s, event 'live' (D4)", A.LIVE_DEBOUNCE_MS === 1500 && A.LIVE_MIN_INTERVAL_MS === 5000 && A.LIVE_EVENT === "live");
ok("8. no table writes from the live path", Object.values(globalThis.__clients).every((c) => c.writes.length === 0) && !/\.from\(/.test(lsrc));
ok("8. no hand-rolled token pushes (supabase-js re-auths on TOKEN_REFRESHED)", !/setAuth\s*\(/.test(lsrc) && !/access_token/.test(lsrc));
ok("8. App.jsx: root loadSessions is wired with useLiveRefresh([\"trainings\"], loadSessions) and the plain useAutoRefresh(loadSessions) is gone (one refresher)",
  /useLiveRefresh\(\["trainings"\], loadSessions\)/.test(app) && !/useAutoRefresh\(loadSessions\)/.test(app) && /import \{ useLiveRefresh \} from "\.\/liveData";/.test(app));
ok("8. App.jsx: members and plans keep their plain resume refresh", /useAutoRefresh\(loadMembers\);/.test(app) && /useAutoRefresh\(loadPlans\);/.test(app));
ok("8. useAutoRefresh stays backwards compatible: same signature, resume path unchanged, now returns the trigger",
  /export function useAutoRefresh\(loader, \{ minIntervalMs = 60000, skipWhen \} = \{\}\)/.test(ur) && /useReconnect\(\(\) => \{ attemptRef\.current\(minIntervalMs\); \}\);/.test(ur) && /return triggerRef\.current;/.test(ur));
ok("8. kill switch reads VITE_LIVE_DATA_ENABLED !== \"0\"", /import\.meta\.env\?\.VITE_LIVE_DATA_ENABLED !== "0"/.test(lsrc));
const tok = (p) => (readFileSync(join(root, p), "utf8").match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("8. verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("8. Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
const changed = execSync(`git diff --name-only ${BASE} ${REV}`, { cwd: root, maxBuffer: 1 << 27 }).toString().trim().split("\n").filter(Boolean);
const untracked = [];   // pinned range: committed files only
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const EXPECT = ["docs/review/field_requests_ui_test.mjs", "docs/review/live_data_1b_BUILD_ORDER.md", "docs/review/live_data_1b_test.mjs", "src/App.jsx", "src/liveData.js", "src/useReconnect.js"];   // + the field-requests test's maxBuffer fix (ENOBUFS on git show of App.jsx)
ok("8. files changed vs 17153e2: exactly the 1b set", JSON.stringify(files) === JSON.stringify(EXPECT), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${BASE} ${REV} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("8. no ios/, android/, package, api/, sql/, shared/, vercel.json, api/_cron.js changes", ["ios", "android", "package.json", "package-lock.json", "api", "sql", "shared", "vercel.json", "api/_cron.js"].every(untouched));
ok("8. supabase-js (realtime) is an existing dependency — nothing added", /"@supabase\/supabase-js"/.test(readFileSync(join(root, "package.json"), "utf8")));
console.info = realInfo;
process.exit(process.exitCode || 0);
