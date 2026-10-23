// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/standard_certs_picker_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for
// in-memory fakes) and checks the standard-certs UI slice ("Add from the standard list" on the Cert Types panel):
//   1. the gate: the button shows only inside the DA / PA panel (an Officer / Board never sees the panel)
//   2. the picker reads standard_cert_types (the SELECT policy, no RPC), grouped SFFMA / TCFP / Texas EMS / Cards in
//      that order, collapsed, with counts; each item shows its name + Doesn't expire / Expires
//   3. a name already in the catalog reads "In your catalog", checked + disabled; picking a name that exists in two
//      tracks ("Fire Inspector") disables the other ("Same name selected")
//   4. add -> add_standard_cert_type(id) once per pick, in order; a raised clash is SHOWN on its own row; the
//      successes are dropped from the selection, the failure stays; the catalog reloads once; an error toast, no success
//   5. all succeed -> success toast, the picker closes
//   6. a failed read of the list is shown with Retry (not an empty list); Retry loads it
//   7. the source: set_cert_type / delete_cert_type / assign_cert_type / update_cert / delete_cert calls byte-identical to
//      HEAD; no hex in the new component; the locked-token count unchanged; the only new RPC is add_standard_cert_type
import { mkdtempSync, readFileSync } from "fs";
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  supabase: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _op: "select" };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "maybeSingle", "single"]) b[m] = () => b;
      b.then = (res, rej) => Promise.resolve(st.table(table)).then(res, rej);
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
const out = join(mkdtempSync(join(tmpdir(), "b4c-std-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { CertTypesPanel, CertTypesCtx };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { CertTypesPanel, CertTypesCtx, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- fixtures: the catalog already has TCFP's "Firefighter II"; "Fire Inspector" is in both SFFMA and TCFP
const TYPES = [{ id: "t1", name: "Firefighter II", never_expires: true, category: "certification", cert_count: 22 }];
const STD = [
  { id: "s1", track: "sffma", name: "Firefighter", never_expires: true, category: "certification", sort_order: 1 },
  { id: "c1", track: "cards", name: "CPR / BLS", never_expires: false, category: "continuing_education", sort_order: 1 },
  { id: "e1", track: "ems", name: "Emergency Medical Technician (EMT)", never_expires: false, category: "certification", sort_order: 2 },
  { id: "t3", track: "tcfp", name: "Firefighter II", never_expires: true, category: "certification", sort_order: 3 },
  { id: "s5", track: "sffma", name: "Fire Inspector", never_expires: true, category: "certification", sort_order: 5 },
  { id: "c5", track: "cards", name: "NIMS/ICS 100", never_expires: true, category: "continuing_education", sort_order: 5 },
  { id: "t15", track: "tcfp", name: "Fire Inspector", never_expires: true, category: "certification", sort_order: 15 },
];
let answers = {}; let tableAnswer = null; const reads = [];
globalThis.__sb = {
  calls: [],
  answer: (n, args) => answers[n] ? answers[n](args) : { data: null, error: null },
  table: (t) => { reads.push(t); return tableAnswer ? tableAnswer(t) : { data: t === "standard_cert_types" ? STD : [], error: null }; },
};
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const reloads = [];
async function mount(role) {
  globalThis.__sb.calls = []; notes.length = 0; reloads.length = 0; reads.length = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  const ctx = { types: TYPES, typeMap: new Map(TYPES.map((t) => [t.id, t])), reload: async () => { reloads.push(1); return { error: null }; } };
  await act(async () => { r.render(React.createElement(CertTypesCtx.Provider, { value: ctx }, React.createElement(CertTypesPanel, { S, role, notify }))); });
  await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const norm = (s) => s.replace(/\s+/g, " ").trim();
const btn = (host, t) => [...host.querySelectorAll("button")].find((b) => norm(b.textContent).includes(t));
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const text = (host) => norm(host.textContent);
const row = (host, name) => [...host.querySelectorAll("label")].find((l) => norm(l.textContent).startsWith(name));
const box = (host, name) => row(host, name)?.querySelector('input[type="checkbox"]');
// 1. gate
for (const [who, role, seen] of [["Department Admin", ["Department Admin"], true], ["Project Admin", ["Project Admin"], true], ["Officer", ["Officer"], false], ["Board Member", ["Board Member"], false]]) {
  const { host, unmount } = await mount(role);
  if (seen) await click(btn(host, "Manage"));
  ok(`gate — ${who}: "Add from the standard list" ${seen ? "shown" : "never shown"}`, !!btn(host, "Add from the standard list") === seen && reads.length === 0);
  unmount();
}

// 2-5
{ const { host, unmount } = await mount(["Department Admin"]);
  await click(btn(host, "Manage"));
  await click(btn(host, "Add from the standard list")); await tick();
  const heads = [...host.querySelectorAll("button[aria-expanded]")].map((b) => norm(b.textContent));
  ok("reads standard_cert_types directly (no list RPC); tracks SFFMA / TCFP / Texas EMS / Cards in order, collapsed, with counts",
    reads.includes("standard_cert_types") && globalThis.__sb.calls.length === 0 && heads.length === 4
    && heads[0].startsWith("SFFMA2") && heads[1].startsWith("TCFP2") && heads[2].startsWith("Texas EMS1") && heads[3].startsWith("Cards2")
    && !row(host, "Firefighter"), JSON.stringify(heads));
  ok("TCFP header says 1 already added", heads[1].includes("1 added"));
  for (const t of ["SFFMA", "TCFP", "Texas EMS", "Cards"]) await click([...host.querySelectorAll("button[aria-expanded]")].find((x) => norm(x.textContent).startsWith(t)));
  ok("items show name + Doesn't expire / Expires, in sort order within a track",
    norm(row(host, "Firefighter").textContent).includes("Doesn't expire") && norm(row(host, "CPR / BLS").textContent).includes("Expires")
    && text(host).indexOf("CPR / BLS") < text(host).indexOf("NIMS/ICS 100") && text(host).indexOf("Firefighter") < text(host).indexOf("Fire Inspector"));
  // 3
  const ffii = box(host, "Firefighter II");
  ok("a name already in the catalog: checked, disabled, \"In your catalog\"", ffii.checked && ffii.disabled && norm(row(host, "Firefighter II").textContent).includes("In your catalog"));
  ok("Add is disabled with nothing selected", btn(host, "Add to catalog").disabled);
  const [fiS, fiT] = [...host.querySelectorAll("label")].filter((l) => norm(l.textContent).startsWith("Fire Inspector")).map((l) => l.querySelector("input"));
  await click(fiS);
  ok("picking SFFMA \"Fire Inspector\" disables TCFP's same-name one", fiS.checked && !fiS.disabled && fiT.disabled && !fiT.checked && text(host).includes("Same name selected"));
  await click(box(host, "Emergency Medical Technician (EMT)"));
  await click(box(host, "CPR / BLS"));
  ok("the Add button counts the picks", !!btn(host, "Add 3 to catalog"));
  // 4 a partial failure
  answers.add_standard_cert_type = (a) => a.p_standard_id === "e1" ? { data: null, error: { message: "That cert type is already in your catalog." } } : { data: { id: "new-" + a.p_standard_id }, error: null };
  await click(btn(host, "Add 3 to catalog")); await tick();
  const adds = globalThis.__sb.calls.filter((c) => c.n === "add_standard_cert_type").map((c) => c.args.p_standard_id);
  ok("add -> add_standard_cert_type once per pick, in list order", JSON.stringify(adds) === JSON.stringify(["c1", "e1", "s5"]), JSON.stringify(adds));
  const emtWrap = row(host, "Emergency Medical Technician (EMT)").parentElement;
  ok("the clash is SHOWN on its own row; the failed pick stays selected, the successes are cleared",
    norm(emtWrap.textContent).includes("That cert type is already in your catalog.") && box(host, "Emergency Medical Technician (EMT)").checked
    && !box(host, "CPR / BLS").checked && !!btn(host, "Add 1 to catalog"));
  ok("catalog reloaded once; an error toast naming the split, no success toast",
    reloads.length === 1 && notes.some((n) => n.kind === "error" && n.title === "Added 2, 1 not added") && !notes.some((n) => n.kind === "success"), JSON.stringify(notes));
  // 5 all succeed -> closes
  delete answers.add_standard_cert_type; notes.length = 0; globalThis.__sb.calls = [];
  await click(btn(host, "Add 1 to catalog")); await tick();
  ok("all succeed -> success toast, the picker closes", notes.some((n) => n.kind === "success" && n.text === "Added 1 cert type from the standard list.") && !btn(host, "Add to catalog") && !text(host).includes("Texas EMS"));
  unmount(); }

// 6 a failed read
{ tableAnswer = () => ({ data: null, error: { message: "Load failed" } });
  const { host, unmount } = await mount(["Department Admin"]);
  await click(btn(host, "Manage"));
  await click(btn(host, "Add from the standard list")); await tick();
  ok("a failed read is shown with Retry, not an empty list", text(host).includes("Load failed") && !!btn(host, "Retry") && !host.querySelector("button[aria-expanded]"));
  tableAnswer = null;
  await click(btn(host, "Retry")); await tick();
  ok("Retry loads the list", host.querySelectorAll("button[aria-expanded]").length === 4 && !text(host).includes("Load failed"));
  unmount(); }

// 7 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const base = execSync("git show HEAD:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const rpcLines = (s, n) => (s.match(new RegExp(`.*supabase\\.rpc\\("${n}".*`, "g")) || []).join("\n");
ok("set_cert_type / delete_cert_type / assign_cert_type / update_cert / delete_cert calls byte-identical to HEAD",
  ["set_cert_type", "delete_cert_type", "assign_cert_type", "update_cert", "delete_cert"].every((n) => rpcLines(src, n) === rpcLines(base, n) && rpcLines(src, n).length > 0));
const rpcNames = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
const added = [...rpcNames(src)].filter((n) => !rpcNames(base).has(n));
ok("the only new RPC is add_standard_cert_type", JSON.stringify(added) === '["add_standard_cert_type"]', JSON.stringify(added));
const i = src.indexOf("function StandardCertPicker("), j = src.indexOf("\nfunction ", i + 10);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
ok("no hex literal in the new component", i > 0 && (strip(src.slice(i, j)).match(/#[0-9A-Fa-f]{3,8}\b/g) || []).length === 0);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count in App.jsx unchanged vs HEAD", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
