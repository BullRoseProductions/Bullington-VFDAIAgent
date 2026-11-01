// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/handoff_confirm_ui_test.mjs
// No network, no DB. Hygiene slice 3 — the handoff confirm (L-7, receiver's half). The REAL src/App.jsx is bundled with
// esbuild (supabaseClient + apiBase swapped for fakes; qrcode.react stubbed) and rendered whole in happy-dom on a real
// /handoff?handoff=…&t=… URL, so the deep link → identity → preview path is the app's own. Checks:
//   1. a scan PREVIEWS (preview_equipment_handoff with the link's id + code) and never accepts by itself
//   2. the confirm renders "<giver> is handing you N items: <names>. Accept?" with Accept + Decline
//   3. Accept fires accept_equipment_handoff EXACTLY ONCE (a double tap included) with the same args as before
//      ({ p_handoff_id, p_code }) → "Transfer complete"; Decline fires nothing and says the code simply expires
//   4. every preview refusal (wrong code · expired · own · other department · no member) shows the SERVER's words, no retry
//   5. the countdown keys off the preview's expires_at (90 s ahead → ~90s; past → 0s) and is display only: at 0 Accept still
//      goes to the server, and an expired refusal shows the server's words, not a crash
//   6. the giver's modal never paints a guessed "60": its number comes from create's expires_at
//   7. nothing else in the handoff flow changed: doAcceptHandoff, routeDeepLink, the giver's create / cancel / link builder
//   fences: only src/App.jsx (+ this test); verified 132/32/14; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "3a0293b";   // live main when this was drafted (industrial-noir-58)
const REV = process.env.REV || null;   // the working tree until review; pin it in the promote push

const HID = "11111111-2222-3333-4444-555555555555", CODE = "c0dec0dec0dec0dec0dec0dec0dec0de";
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: `https://app.test/handoff?handoff=${HID}&t=${CODE}` });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "IntersectionObserver", "MutationObserver", "location", "history", "screen", "CustomEvent"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const W = () => globalThis.__w;
    function q(table) {
      const f = { table, single: false }; const b = {};
      for (const m of ["eq", "neq", "in", "is", "order", "limit", "gte", "lte", "lt", "gt", "or", "not", "range", "filter", "match", "contains", "overlaps", "ilike", "select", "insert", "update", "delete", "upsert"]) b[m] = () => b;
      b.single = () => { f.single = true; return b; };
      b.maybeSingle = () => ({ then: (r, j) => Promise.resolve({ data: null, error: null }).then(r, j) });
      b.then = (r, j) => Promise.resolve(table === "members" && f.single ? { data: { id: "m-recv", access: ["Member"] }, error: null } : { data: f.single ? null : [], error: null, count: 0 }).then(r, j);
      return b;
    }
    export const supabase = {
      from: q,
      rpc: (name, args) => { W().rpcs.push({ name, args }); return { then: (r, j) => Promise.resolve(W().rpc(name, args)).then(r, j) }; },
      auth: { getSession: async () => ({ data: { session: { user: { email: "recv@x.test" }, access_token: "t" } } }),
              onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }), getUser: async () => ({ data: { user: { email: "recv@x.test" } } }) },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, json: async () => ({}), text: async () => "" }; }`,
  qr: `export const QRCodeCanvas = (p) => null; export const QRCodeSVG = (p) => null; export default () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-hcf-")), "app.mjs");
await build({
  stdin: { contents: `export { default as App, HandoffModal } from "./src/App.jsx"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" },
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + "\nexport { HandoffModal };\n", loader: "jsx" }));
  } }],
});
const { App, HandoffModal, createRoot, act, createElement } = await import(pathToFileURL(out).href);
const origErr = console.error; console.error = () => {};

const ahead = (s) => new Date(Date.now() + s * 1000).toISOString();
const PREVIEW = (exp = ahead(90)) => ({ handoff_id: HID, from_member_name: "Finn Holder", expires_at: exp, items: [{ name: "SCBA 7" }, { name: "Radio 3" }] });
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render(rpc) {
  win.history.replaceState({}, "", `/handoff?handoff=${HID}&t=${CODE}`);
  globalThis.__w = { rpcs: [], rpc };
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(createElement(App)));
  await tick(8);
  const card = () => host.querySelector("[data-handoff-state]");
  return { host, r, card, state: () => card()?.getAttribute("data-handoff-state"), text: () => card()?.textContent || "", btn: (re) => [...(card()?.querySelectorAll("button") || [])].find((b) => re.test(b.textContent)) };
}
const calls = (n) => globalThis.__w.rpcs.filter((c) => c.name === n);

// 1 + 2 — the scan previews and renders the confirm
let v = await render((name) => name === "preview_equipment_handoff" ? { data: PREVIEW(), error: null } : name === "accept_equipment_handoff" ? { data: { handoff_id: HID, items: 2 }, error: null } : { data: null, error: null });
ok("1. the scan calls preview_equipment_handoff with the link's id + code ({ p_handoff_id, p_code })", calls("preview_equipment_handoff").length === 1 && JSON.stringify(calls("preview_equipment_handoff")[0].args) === JSON.stringify({ p_handoff_id: HID, p_code: CODE }));
ok("1. …and does NOT accept by itself", calls("accept_equipment_handoff").length === 0 && v.state() === "confirm");
ok("2. the confirm: \"Finn Holder is handing you 2 items: SCBA 7, Radio 3. Accept?\"", /Finn Holder is handing you 2 items: SCBA 7, Radio 3\. Accept\?/.test(v.text()), v.text().slice(0, 140));
ok("2. …with Accept and Decline", !!v.btn(/^\s*Accept\s*$/) && !!v.btn(/^Decline$/));
const cd = () => Number((v.host.querySelector("[data-handoff-countdown]")?.textContent.match(/(\d+)s/) || [])[1]);
ok("5. the countdown keys off the preview's expires_at (90 s ahead → 88–90s)", cd() >= 88 && cd() <= 90, `${cd()}s`);
// 3 — Accept, double-tapped
await act(async () => { const b = v.btn(/^\s*Accept\s*$/); b.click(); b.click(); });
await tick(6);
ok("3. Accept fires accept_equipment_handoff EXACTLY once (double tap included) with { p_handoff_id, p_code } — the same args as before",
  calls("accept_equipment_handoff").length === 1 && JSON.stringify(calls("accept_equipment_handoff")[0].args) === JSON.stringify({ p_handoff_id: HID, p_code: CODE }), `${calls("accept_equipment_handoff").length}`);
ok("3. …→ \"Transfer complete\" · \"2 items are now in your custody\"", v.state() === "done" && /2 items are now in your custody/.test(v.text()));
await act(async () => v.r.unmount());

// 3 — Decline
v = await render((name) => name === "preview_equipment_handoff" ? { data: PREVIEW(), error: null } : { data: null, error: null });
await act(async () => { v.btn(/^Decline$/).click(); });
await tick(3);
ok("3. Decline fires nothing (no accept, no cancel), and says the code simply expires / the sender can cancel", calls("accept_equipment_handoff").length === 0 && calls("cancel_equipment_handoff").length === 0 && v.state() === "declined" && /code simply expires/.test(v.text()) && /sender can also cancel/.test(v.text()));
await act(async () => v.r.unmount());

// 4 — each preview refusal, in the server's words, no retry
for (const msg of ["Invalid handoff code", "This handoff code has expired — ask for a fresh one", "You cannot accept your own handoff",
                   "Not authorized: this handoff belongs to another department", "No member record for the signed-in user", "This handoff code has already been used or cancelled"]) {
  v = await render((name) => name === "preview_equipment_handoff" ? { data: null, error: { message: msg } } : { data: null, error: null });
  ok(`4. preview refused → the server's words: "${msg}" — no Accept, no retry, no accept call`, v.state() === "error" && v.text().includes(msg) && !v.btn(/^\s*Accept\s*$/) && calls("preview_equipment_handoff").length === 1 && calls("accept_equipment_handoff").length === 0);
  await act(async () => v.r.unmount());
}

// 5 — expiry mid-confirm: the clock says 0, Accept still asks the server, the server's words come back
v = await render((name) => name === "preview_equipment_handoff" ? { data: PREVIEW(ahead(-5)), error: null }
  : name === "accept_equipment_handoff" ? { data: null, error: { message: "This handoff code has expired — ask for a fresh one" } } : { data: null, error: null });
ok("5. a past expires_at → the countdown reads 0s (display only) and Accept is still there", cd() === 0 && !!v.btn(/^\s*Accept\s*$/));
await act(async () => { v.btn(/^\s*Accept\s*$/).click(); });
await tick(4);
ok("5. Accept at 0 → the server refuses → its \"has expired\" words, not a crash", v.state() === "error" && /has expired — ask for a fresh one/.test(v.text()) && calls("accept_equipment_handoff").length === 1);
await act(async () => v.r.unmount());

// 6 — the giver's modal never paints a guessed 60
{ globalThis.__w = { rpcs: [], rpc: (name) => name === "create_equipment_handoff" ? { data: { handoff_id: HID, code: CODE, expires_at: ahead(120), items: 1 }, error: null } : { data: null, error: null } };
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  const seen = [];
  const mo = new win.MutationObserver(() => { const m = document.body.textContent.match(/Expires in (\d+)s/); if (m) seen.push(Number(m[1])); });
  mo.observe(document.body, { subtree: true, childList: true, characterData: true });
  await act(async () => r.render(createElement(HandoffModal, { items: [{ equipment_id: "e1", equipment_name: "SCBA 7" }], notify: () => {}, onClose: () => {} })));
  await tick(6);
  const now = Number((document.body.textContent.match(/Expires in (\d+)s/) || [])[1]);
  mo.disconnect();
  ok("6. the giver's countdown comes from create's expires_at (120 s ahead → 118–120s), never a painted \"60\"", now >= 118 && now <= 120 && !seen.includes(60), `now ${now}s · seen ${[...new Set(seen)].join(",")}`);
  await act(async () => r.unmount()); }
console.error = origErr;

// 7 — nothing else in the handoff flow changed
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");
const base = show(BASE, "src/App.jsx"), cur = show(REV, "src/App.jsx");
const block = (src, start, end) => { const i = src.indexOf(start); return i < 0 ? null : src.slice(i, src.indexOf(end, i + start.length) + end.length); };
ok("7. doAcceptHandoff is byte-identical (the accept call + its result shape)", block(base, "async function doAcceptHandoff(", "\n  }") === block(cur, "async function doAcceptHandoff(", "\n  }") && !!block(cur, "async function doAcceptHandoff(", "\n  }"));
ok("7. routeDeepLink is byte-identical (how a link becomes pendingHandoff)", block(base, "const routeDeepLink = (search) => {", "\n  };") === block(cur, "const routeDeepLink = (search) => {", "\n  };"));
ok("7. the giver's create / cancel calls and the /handoff link builder are byte-identical",
  ["supabase.rpc(\"create_equipment_handoff\", { p_equipment_ids: ids })", "supabase.rpc(\"cancel_equipment_handoff\", { p_handoff_id: st.handoffId })", "`${APP_ORIGIN}/handoff?handoff=${st.handoffId}&t=${st.code}`"].every((s) => base.includes(s) && cur.includes(s)));
ok("7. no accept call is left in the scan effect; the giver's comment / initial value no longer say 60",
  !/doAcceptHandoff\(pendingHandoff\.hid, pendingHandoff\.code\)/.test(cur) && !/single-use, 60s code/.test(cur) && !/useState\(60\)/.test(block(cur, "function HandoffModal(", "\n}\n") || ""));
// fences
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
ok("changed: only src/App.jsx (+ this test)", files.every((f) => ["docs/review/handoff_confirm_ui_test.mjs", "src/App.jsx"].includes(f)) && files.includes("src/App.jsx"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("no SQL, api/, shared/, native, vercel.json", ["sql", "api", "shared", "ios", "android", "vercel.json"].every(untouched));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
process.exit(process.exitCode || 0);
