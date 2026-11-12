// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/field_requests_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for in-memory
// fakes) and checks the three field-request UI slices (gate rulings S-1 / A-1 / C-1, AL-1..3, 2026-11-12; their DB slices
// are live: shirt size @5f9af97, apparatus move @aea9002, cert accepted names @141afbc):
//   1. SHIRT SIZE: the list mirrors member_private_shirt_size_chk; My info reads my_shirt_size(), saves through
//      set_my_shirt_size({p_size}), clears with null; a FAILED READ is never shown as "not set" (Retry, dropdown disabled,
//      no write possible); BAD_SIZE / NO_MEMBER explained; the DA Edit form + Profile row use the same member_private upsert.
//   2. APPARATUS MOVE: hidden with < 2 active stations or a failed station read; DA/PA-only mount; select -> confirm ->
//      move_apparatus_to_station({p_apparatus, p_station}); moved:true -> success toast + list refresh; moved:false -> "already
//      there"; an RPC error shows the server's message; the source never writes station_id on an update.
//   3. CERT FIELD: suggestions = cert types + names on file, case-insensitive de-dupe, most-held first; the alias limits
//      (≤25, non-blank, ≤120, no duplicates incl. the cert name); the "won't auto-clear" marker only for blank name AND no
//      aliases (AL-1); chips add/remove through onSave({cert_aliases}); leaving the cert kind clears aliases; datalist wired.
//   4. FENCES vs main 7b609f4 (gate ruling 2026-11-12: build 18's re-cut is rebased onto main and carries notification
//      clearing + the build-18 native commits + these three features): the branch differs from 7b609f4 in EXACTLY the
//      build-18 native set (Capacitor 8.5.3, allowBackup=false, version bumps, their review files) + src/App.jsx + this test
//      + the notif_clearing_test fence pin; no api/, sql/, shared/, vercel.json change; verified 132 / 32 / 14; Notify held.
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "7b609f4";   // origin/main at the rebase (gate ruling 2026-11-12: the build-18 re-cut rides main)
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  supabase: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _op: "select", _args: null };
      for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "order", "maybeSingle", "single", "limit"]) b[m] = () => b;
      for (const m of ["update", "upsert", "insert", "delete"]) b[m] = (args) => { b._op = m; b._args = args; st.writes.push({ table, op: m, args }); return b; };
      b.then = (res, rej) => Promise.resolve(st.table(table, b._op, b._args)).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; } };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  confirm: `
    export const confirmDestructive = async (o) => true;
    export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => true;
    export const DestructiveConfirmHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-frui-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: a.path === "sb" ? MOCKS.supabase : MOCKS.confirm, loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { SHIRT_SIZES, ShirtSizeSelect, MyInfo, RigMoveStation, ProbItemConfig, buildCertSuggestions, certAliasProblem, certWontAutoClear, CERT_ALIAS_MAX };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";`, loader: "jsx" }));
  } }],
});
const M = await import(pathToFileURL(out).href);
const { createRoot, act, React } = M;

let answers = {};
globalThis.__sb = { calls: [], writes: [], answer: (n, args) => (answers[n] ? answers[n](args) : { data: null, error: null }), table: () => ({ data: [], error: null }) };
const notes = []; const notify = (n) => notes.push(n);
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const pick = (sel, v) => act(async () => { sel.value = v; sel.dispatchEvent(new win.Event("change", { bubbles: true })); });
const btn = (host, t) => [...host.querySelectorAll("button")].find((b) => norm(b.textContent).includes(t));
async function mount(el) {
  globalThis.__sb.calls = []; globalThis.__sb.writes = []; notes.length = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => { r.render(el); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}

// ---------------------------------------------------------------- 1. SHIRT SIZE
ok("1. sizes mirror member_private_shirt_size_chk (17, in order)", JSON.stringify(M.SHIRT_SIZES) === JSON.stringify(["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "W-XS", "W-S", "W-M", "W-L", "W-XL", "W-2XL", "Y-S", "Y-M", "Y-L"]));
{
  answers = { my_shirt_size: () => ({ data: "L", error: null }), set_my_shirt_size: ({ p_size }) => ({ data: p_size, error: null }) };
  const { host, unmount } = await mount(React.createElement(M.MyInfo, { notify }));
  const sel = host.querySelector("select");
  ok("1. My info reads my_shirt_size() and shows the size on file", globalThis.__sb.calls.some((c) => c.n === "my_shirt_size") && sel && sel.value === "L" && !sel.disabled);
  ok("1. My info is private copy (only you and your Department Admins)", /Only you and your Department Admins/.test(norm(host.textContent)));
  ok("1. the dropdown offers blank + 17 sizes in Adult / Women's / Youth groups", sel.querySelectorAll("option").length === 18 && [...sel.querySelectorAll("optgroup")].map((g) => g.label).join("|") === "Adult|Women's|Youth");
  await pick(sel, "2XL"); await tick();
  const set = globalThis.__sb.calls.find((c) => c.n === "set_my_shirt_size");
  ok("1. choosing a size saves through set_my_shirt_size({p_size}) — no table write", set && set.args.p_size === "2XL" && globalThis.__sb.writes.length === 0 && notes.some((n) => n.kind === "success"));
  await pick(host.querySelector("select"), ""); await tick();
  ok("1. clearing sends p_size null", globalThis.__sb.calls.filter((c) => c.n === "set_my_shirt_size").pop().args.p_size === null);
  unmount();
}
{
  answers = { my_shirt_size: () => ({ data: null, error: { message: "Load failed" } }) };
  const { host, unmount } = await mount(React.createElement(M.MyInfo, { notify }));
  const sel = host.querySelector("select");
  ok("1. a FAILED READ is never 'not set': dropdown disabled, Retry shown, nothing written", sel && sel.disabled && /couldn|retry/i.test(norm(host.textContent)) && !globalThis.__sb.calls.some((c) => c.n === "set_my_shirt_size"));
  answers.my_shirt_size = () => ({ data: "M", error: null });
  const retry = btn(host, "Retry") || btn(host, "Try again");
  if (retry) { await click(retry); await tick(); }
  ok("1. Retry loads it and enables the dropdown", retry && host.querySelector("select").value === "M" && !host.querySelector("select").disabled);
  unmount();
}
{
  answers = { my_shirt_size: () => ({ data: "S", error: null }), set_my_shirt_size: () => ({ data: null, error: { message: 'BAD_SIZE: "Q" is not one of the shirt sizes on the list.' } }) };
  const { host, unmount } = await mount(React.createElement(M.MyInfo, { notify }));
  await pick(host.querySelector("select"), "XL"); await tick();
  ok("1. BAD_SIZE: an error toast in plain words and the size stays S", notes.some((n) => n.kind === "error" && /isn't on the list/.test(n.text)) && host.querySelector("select").value === "S");
  answers.set_my_shirt_size = () => ({ data: null, error: { message: "NO_MEMBER: your login is not matched to an active member record." } });
  await pick(host.querySelector("select"), "M"); await tick();
  ok("1. NO_MEMBER explained", notes.some((n) => n.kind === "error" && /isn't matched to an active member record/.test(n.text)));
  unmount();
}
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
ok("1. DA path: member_private select + upsert carry shirt_size; Profile shows a Shirt size row; Edit form has the select",
  /from\("member_private"\)\.select\("birthday, address, joined_date, shirt_size"\)/.test(src)
  && /joined_date: jd, shirt_size: form\.shirt_size \|\| null \}, \{ onConflict: "member_id" \}/.test(src)
  && /\["Shirt size", priv\?\.shirt_size \|\| "—"\]/.test(src)
  && /<ShirtSizeSelect style=\{FS\.input\} value=\{form\.shirt_size\}/.test(src));
ok("1. My info card is offered to every member (no role gate) and routed", /\{card\("myinfo", Shirt,/.test(src) && /if \(view === "myinfo"\) return/.test(src));

// ---------------------------------------------------------------- 2. APPARATUS MOVE
const RIG = { id: "rig1", name: "Engine 1", station_id: "st1" };
const STNS = [{ station_id: "st1", name: "Station 1", label: null, is_default: true, is_active: true }, { station_id: "st2", name: "Station 2", label: "North", is_default: false, is_active: true }, { station_id: "st3", name: "Old house", label: null, is_default: false, is_active: false }];
const moved = [];
{
  answers = { my_stations: () => ({ data: [STNS[0], STNS[2]], error: null }) };
  const { host, unmount } = await mount(React.createElement(M.RigMoveStation, { rig: RIG, notify, onMoved: () => moved.push(1) }));
  ok("2. hidden when the department has < 2 ACTIVE stations (an inactive house doesn't count)", norm(host.textContent) === "");
  unmount();
  answers = { my_stations: () => ({ data: null, error: { message: "Load failed" } }) };
  const m2 = await mount(React.createElement(M.RigMoveStation, { rig: RIG, notify }));
  ok("2. a failed station read renders nothing (never a wrong control)", norm(m2.host.textContent) === "");
  m2.unmount();
}
{
  answers = { my_stations: () => ({ data: STNS, error: null }), move_apparatus_to_station: () => ({ data: { moved: true, from: "st1", to: "st2" }, error: null }) };
  const { host, unmount } = await mount(React.createElement(M.RigMoveStation, { rig: RIG, notify, onMoved: () => moved.push(1) }));
  const sel = host.querySelector("select");
  const opts = [...sel.querySelectorAll("option")].map((o) => o.value);
  ok("2. shown with 2+ active stations; current station named; targets exclude current + inactive", /Station: Station 1/.test(norm(host.textContent)) && JSON.stringify(opts) === JSON.stringify(["", "st2"]));
  ok("2. Move is disabled until a station is picked", btn(host, "Move").disabled);
  await pick(sel, "st2"); await click(btn(host, "Move"));
  ok("2. a confirm step names the target and says history goes with it; no RPC yet", /Move Engine 1 to Station 2 \(North\)\? Its checks and history go with it/.test(norm(host.textContent)) && !globalThis.__sb.calls.some((c) => c.n === "move_apparatus_to_station"));
  await click(btn(host, "Yes, move it")); await tick();
  const call = globalThis.__sb.calls.find((c) => c.n === "move_apparatus_to_station");
  ok("2. confirm -> move_apparatus_to_station({p_apparatus, p_station}); success toast; list refreshed; no table write",
    call && call.args.p_apparatus === "rig1" && call.args.p_station === "st2" && notes.some((n) => n.kind === "success" && /Moved to Station 2 \(North\) — its checks and history went with it/.test(n.text)) && moved.length === 1 && globalThis.__sb.writes.length === 0);
  unmount();
}
{
  answers = { my_stations: () => ({ data: STNS, error: null }), move_apparatus_to_station: () => ({ data: { moved: false, station_id: "st2" }, error: null }) };
  const { host, unmount } = await mount(React.createElement(M.RigMoveStation, { rig: RIG, notify, onMoved: () => moved.push(1) }));
  await pick(host.querySelector("select"), "st2"); await click(btn(host, "Move")); await click(btn(host, "Yes, move it")); await tick();
  ok("2. moved:false -> 'already at' info, no refresh", notes.some((n) => n.kind === "info" && /already at Station 2/.test(n.text)) && moved.length === 1);
  unmount();
  answers.move_apparatus_to_station = () => ({ data: null, error: { message: "Only a Department Admin can move a rig to another station." } });
  const m3 = await mount(React.createElement(M.RigMoveStation, { rig: RIG, notify }));
  await pick(m3.host.querySelector("select"), "st2"); await click(btn(m3.host, "Move")); await click(btn(m3.host, "Yes, move it")); await tick();
  ok("2. an RPC refusal shows the server's message", notes.some((n) => n.kind === "error" && /Only a Department Admin can move a rig/.test(n.text)));
  m3.unmount();
}
const base = execSync(`git show ${BASE}:src/App.jsx`, { cwd: root, maxBuffer: 64 << 20 }).toString();
const updStation = (s) => (s.match(/\.update\(\{[^}]*station_id/g) || []).length;
ok("2. no direct station_id write on update anywhere (count unchanged from build 18, = 0)", updStation(src) === 0 && updStation(base) === 0);
ok("2. the control mounts only for DA/PA (isDeptAdmin) in the rig panel", /\{isDeptAdmin\(role\) && <RigMoveStation rig=\{r\} notify=\{notify\} onMoved=\{loadRigs\} \/>\}/.test(src));

// ---------------------------------------------------------------- 3. CERT FIELD
const sug = M.buildCertSuggestions(["NIMS/ICS 100", "is-100", "Courage to be Safe"], [
  { name: "IS-100", member_id: "a" }, { name: "is-100 ", member_id: "b" }, { name: "IS-100", member_id: "b" }, { name: "Ics-100", member_id: "c" }, { name: "  ", member_id: "d" }]);
ok("3. suggestions: case/space-insensitive de-dupe, most-held first, types with no holders after", JSON.stringify(sug) === JSON.stringify([{ name: "IS-100", holders: 2 }, { name: "Ics-100", holders: 1 }, { name: "Courage to be Safe", holders: 0 }, { name: "NIMS/ICS 100", holders: 0 }]));
const P = M.certAliasProblem;
ok("3. alias limits mirror the CHECK: blank / >120 / 25 already / duplicate (incl. cert name) refused; a good one OK",
  P([], "IS-100", "  ") && P([], "IS-100", "x".repeat(121)) && P(Array.from({ length: M.CERT_ALIAS_MAX }, (_, i) => `n${i}`), "", "new") && P(["Ics-100"], "IS-100", " ics-100 ") && P([], "IS-100", "is-100")
  && P([], "IS-100", "x".repeat(120)) === null && P(Array.from({ length: 24 }, (_, i) => `n${i}`), "", "FEMA IS 100") === null && M.CERT_ALIAS_MAX === 25);
const W = M.certWontAutoClear;
ok("3. AL-1 marker: only blank name AND no aliases; a blank name WITH aliases is configured; non-cert never",
  W({ kind: "cert", cert_name: " ", cert_aliases: [] }) && W({ kind: "cert", cert_name: null }) && !W({ kind: "cert", cert_name: "", cert_aliases: ["IS-100"] }) && !W({ kind: "cert", cert_name: "CPR", cert_aliases: [] }) && !W({ kind: "manual", cert_name: "" }));
{
  const saves = [];
  const it = { id: "i1", kind: "cert", cert_name: "", cert_aliases: [], clears_to_run: false, phase: "probation" };
  const el = (x) => React.createElement(M.ProbItemConfig, { it: x, docs: [], busy: false, onSave: (p) => saves.push(p), certNames: sug });
  const { host, unmount } = await mount(el(it));
  ok("3. blank name + no aliases shows \"Won't auto-clear — pick a cert name\"", /Won't auto-clear — pick a cert name/.test(norm(host.textContent)));
  const inputs = [...host.querySelectorAll("input[list]")];
  const dl = host.querySelector("datalist");
  ok("3. cert name + alias inputs are wired to one datalist of the suggestions; free text still allowed (no select)", inputs.length === 2 && dl && inputs.every((i) => i.getAttribute("list") === dl.id) && dl.querySelectorAll("option").length === 4 && dl.querySelector("option").value === "IS-100");
  const aliasIn = inputs[1];
  await act(async () => { const set = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set; set.call(aliasIn, "Ics-100"); aliasIn.dispatchEvent(new win.Event("input", { bubbles: true })); });
  await click(btn(host, "Add"));
  ok("3. Add sends onSave({cert_aliases:[...]}) — the existing onboarding_items update path", saves.length === 1 && JSON.stringify(saves[0]) === JSON.stringify({ cert_aliases: ["Ics-100"] }));
  unmount();
  saves.length = 0;
  const it2 = { ...it, cert_aliases: ["Ics-100", "FEMA IS 100"] };
  const m2 = await mount(el(it2));
  ok("3. with aliases the marker is gone (AL-1) and chips show", !/Won't auto-clear/.test(norm(m2.host.textContent)) && /Also accept:/.test(norm(m2.host.textContent)) && /FEMA IS 100/.test(norm(m2.host.textContent)));
  await click(m2.host.querySelector('button[aria-label="Stop accepting Ics-100"]'));
  ok("3. × removes that chip through onSave", JSON.stringify(saves[0]) === JSON.stringify({ cert_aliases: ["FEMA IS 100"] }));
  const kindSel = [...m2.host.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "cert"));
  await pick(kindSel, "manual");
  ok("3. leaving the cert kind clears the aliases in the same save (the CHECK allows aliases only on cert items)", JSON.stringify(saves[1]) === JSON.stringify({ kind: "manual", cert_aliases: [] }));
  m2.unmount();
}
ok("3. onboarding_items select includes cert_aliases; suggestions load cert_types + certs only in edit mode", /cert_name, cert_aliases, requires_doc/.test(src) && /supabase\.from\("cert_types"\)\.select\("name"\), supabase\.from\("certs"\)\.select\("name, member_id"\)/.test(src));

// ---------------------------------------------------------------- 4. FENCES
const REV = "269fb0b";   // gate PASS @269fb0b (2026-11-12): fences pinned to the released range BASE..REV, so later slices can't stale them
const files = execSync(`git diff --name-only ${BASE} ${REV}`, { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
const NATIVE_B18 = ["android/app/build.gradle", "android/app/src/main/AndroidManifest.xml", "docs/review/ws1_capacitor_DEP_DIFF.patch",
  "docs/review/ws1_npm_audit_AFTER.txt", "docs/review/ws1_npm_audit_BEFORE.txt", "ios/App/App.xcodeproj/project.pbxproj",
  "ios/App/CapApp-SPM/Package.swift", "package-lock.json", "package.json"];   // WS-1 Capacitor 8.5.3, L-6 allowBackup, 3.2 (18) / vc16
const EXPECT = [...NATIVE_B18, "docs/review/field_requests_ui_test.mjs", "docs/review/notif_clearing_test.mjs", "src/App.jsx"].sort();
ok("4. changed vs 7b609f4: exactly the build-18 native set + src/App.jsx + this test + the notif test's fence pin", JSON.stringify(files) === JSON.stringify(EXPECT), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${BASE} ${REV} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("4. no api/, sql/, shared/, vercel.json, api/_cron.js changes", ["api", "sql", "shared", "vercel.json", "api/_cron.js"].every(untouched));
const nat = (p) => execSync(`git diff --name-only ${BASE} ${REV} -- ${p}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("4. ios/, android/, package changes are only the build-18 native files", [...nat("ios"), ...nat("android"), ...nat("package.json"), ...nat("package-lock.json")].every((f) => NATIVE_B18.includes(f)));
const tok = (p) => (execSync(`git show ${REV}:${p}`, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("4. verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("4. Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
process.exit(process.exitCode || 0);
