// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/standard_certs_picker_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for
// in-memory fakes) and checks the standard-certs UI slice ("Add from the standard list" on the Cert Types panel):
//   1. the button is on the open panel (DA / PA only — the panel's own gate); the picker reads standard_cert_types
//      directly, grouped SFFMA / TCFP / Texas EMS / Cards in that order, each item with its name + expires flag
//   2. a standard whose name is already in the catalog (case / spacing-insensitive) shows as added, disabled
//   3. same-named standards on two tracks (SFFMA + TCFP "Fire Inspector") can't both be picked
//   4. confirm -> add_standard_cert_type(p_standard_id) once per pick; the catalog reloads once; success; it closes
//   5. a raised clash is SHOWN on its row and the rest still land; the failed one stays picked; no blanket success
//   6. a failed list READ shows the error + Retry (never an empty list), and Retry loads it
//   7. the source: set_cert_type / delete_cert_type / assign_cert_type / dept_cert_types calls byte-identical to the
//      base; no hex in the new component; the locked-token count unchanged
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
      const b = { _t: table, _op: "select", _order: [] };
      for (const m of ["eq", "neq", "in", "is", "maybeSingle", "single"]) b[m] = () => b;
      b.select = (cols) => { b._cols = cols; return b; };
      b.order = (c) => { b._order.push(c); return b; };
      b.then = (res, rej) => { st.reads.push({ t: table, cols: b._cols, order: b._order }); return Promise.resolve(st.read(table)).then(res, rej); };
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; } };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  confirm: `
    export const confirmDestructive = async () => true;
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

// the catalog already has "firefighter " (spacing / case differ from SFFMA "Firefighter") and TCFP "Officer I"
const TYPES = [{ id: "t1", name: "firefighter ", never_expires: true, category: "certification", cert_count: 4 },
               { id: "t2", name: "Officer I", never_expires: true, category: "certification", cert_count: 1 }];
const STD = [   // deliberately out of track order — the picker groups by STD_TRACKS, not by the read order
  { id: "c1", track: "cards", name: "CPR / BLS", never_expires: false, category: "continuing_education", sort_order: 1 },
  { id: "e1", track: "ems", name: "Emergency Medical Technician (EMT)", never_expires: false, category: "certification", sort_order: 2 },
  { id: "s1", track: "sffma", name: "Firefighter", never_expires: true, category: "certification", sort_order: 1 },
  { id: "s5", track: "sffma", name: "Fire Inspector", never_expires: true, category: "certification", sort_order: 5 },
  { id: "p8", track: "tcfp", name: "Officer I", never_expires: true, category: "certification", sort_order: 8 },
  { id: "p15", track: "tcfp", name: "Fire Inspector", never_expires: true, category: "certification", sort_order: 15 },
];
let answers = {}; let readAnswer = null;
globalThis.__sb = { calls: [], reads: [], answer: (n, a) => answers[n] ? answers[n](a) : { data: { id: "new" }, error: null },
                    read: (t) => readAnswer ? readAnswer(t) : { data: t === "standard_cert_types" ? STD : [], error: null } };
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const reloads = [];
async function mount(role) {
  globalThis.__sb.calls = []; globalThis.__sb.reads = []; notes.length = 0; reloads.length = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  const ctx = { types: TYPES, typeMap: new Map(TYPES.map((t) => [t.id, t])), reload: async () => { reloads.push(1); return { error: null }; } };
  await act(async () => { r.render(React.createElement(CertTypesCtx.Provider, { value: ctx }, React.createElement(CertTypesPanel, { S, role, notify }))); });
  await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const btn = (host, t) => [...host.querySelectorAll("button")].find((b) => b.textContent.replace(/\s+/g, " ").trim().includes(t));
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const text = (host) => host.textContent.replace(/\s+/g, " ");
const row = (host, name, nth = 0) => [...host.querySelectorAll("label")].filter((l) => l.querySelector('input[type="checkbox"]') && l.textContent.includes(name))[nth];
const box = (host, name, nth = 0) => row(host, name, nth)?.querySelector('input[type="checkbox"]');

// 1. gate + the list
for (const [who, role, seen] of [["Department Admin", ["Department Admin"], true], ["Project Admin", ["Project Admin"], true], ["Officer", ["Officer"], false], ["Board Member", ["Board Member"], false]]) {
  const { host, unmount } = await mount(role);
  if (btn(host, "Manage")) await click(btn(host, "Manage"));
  ok(`standard-list button — ${who}: ${seen ? "shown" : "hidden"}`, !!btn(host, "Add from the standard list") === seen);
  unmount();
}
{ const { host, unmount } = await mount(["Department Admin"]);
  ok("closed panel: no standard-list button until Manage", !btn(host, "Add from the standard list"));
  await click(btn(host, "Manage"));
  await click(btn(host, "Add from the standard list")); await tick();
  const rd = globalThis.__sb.reads.find((r) => r.t === "standard_cert_types");
  ok("reads standard_cert_types directly (no RPC), ordered track, sort_order", rd && /never_expires/.test(rd.cols) && rd.order.join(",") === "track,sort_order" && !globalThis.__sb.calls.some((c) => /standard/.test(c.n)));
  const t = text(host);
  const at = (s) => t.indexOf(s);
  ok("grouped SFFMA -> TCFP -> Texas EMS -> Cards & courses", at("SFFMA") > 0 && at("SFFMA") < at("TCFP") && at("TCFP") < at("Texas EMS") && at("Texas EMS") < at("Cards & courses")
     && at("SFFMA") < at("Fire Inspector") && at("Fire Inspector") < at("TCFP") && at("Texas EMS") < at("Emergency Medical Technician (EMT)") && at("Cards & courses") < at("CPR / BLS"));
  ok("each item shows its expires flag", row(host, "Firefighter").textContent.includes("Doesn't expire") && row(host, "CPR / BLS").textContent.includes("Expires") && !row(host, "CPR / BLS").textContent.includes("Doesn't"));

  // 2. already in the catalog
  ok("already-added (case / spacing-insensitive) is checked + disabled + labelled", box(host, "Firefighter").disabled && box(host, "Firefighter").checked && row(host, "Firefighter").textContent.includes("Already in your catalog")
     && box(host, "Officer I").disabled && !box(host, "Fire Inspector").disabled && !box(host, "CPR / BLS").disabled);
  ok("nothing picked: the add button is disabled", btn(host, "Pick the ones to add")?.disabled === true);

  // 3. same-named standards
  await click(box(host, "Fire Inspector", 0));   // SFFMA
  ok("picking SFFMA Fire Inspector disables TCFP Fire Inspector, says why", box(host, "Fire Inspector", 0).checked && box(host, "Fire Inspector", 1).disabled
     && row(host, "Fire Inspector", 1).textContent.includes("Same name already picked under SFFMA") && !!btn(host, "Add 1 to your catalog"));
  await click(box(host, "Fire Inspector", 0));
  ok("un-picking frees it again", !box(host, "Fire Inspector", 1).disabled && !!btn(host, "Pick the ones to add"));

  // 4. confirm
  await click(box(host, "Fire Inspector", 1));   // TCFP this time
  await click(box(host, "Emergency Medical Technician (EMT)"));
  await click(box(host, "CPR / BLS"));
  await click(btn(host, "Add 3 to your catalog")); await tick();
  const adds = globalThis.__sb.calls.filter((c) => c.n === "add_standard_cert_type");
  ok("add_standard_cert_type once per pick, with p_standard_id only", adds.length === 3 && adds.map((c) => c.args.p_standard_id).sort().join(",") === "c1,e1,p15" && adds.every((c) => Object.keys(c.args).join() === "p_standard_id"), JSON.stringify(adds));
  ok("the catalog reloads once; success notice; the picker closes", reloads.length === 1 && notes.some((n) => n.kind === "success" && /3 cert types added/.test(n.text)) && !text(host).includes("Pick the Texas fire") && !!btn(host, "Add from the standard list"));
  ok("no other write RPC was called", globalThis.__sb.calls.every((c) => c.n === "add_standard_cert_type"));
  unmount(); }

// 5. a per-item clash
{ answers.add_standard_cert_type = (a) => a.p_standard_id === "e1" ? { data: null, error: { message: "That cert type is already in your catalog." } } : { data: { id: "n" }, error: null };
  const { host, unmount } = await mount(["Department Admin"]);
  await click(btn(host, "Manage")); await click(btn(host, "Add from the standard list")); await tick();
  await click(box(host, "Emergency Medical Technician (EMT)")); await click(box(host, "CPR / BLS"));
  await click(btn(host, "Add 2 to your catalog")); await tick();
  ok("the clash is SHOWN on its row; the other still added (both called); catalog reloaded",
     row(host, "Emergency Medical Technician (EMT)").textContent.includes("That cert type is already in your catalog.") && globalThis.__sb.calls.filter((c) => c.n === "add_standard_cert_type").length === 2 && reloads.length === 1);
  ok("the failed one stays picked; picker stays open; mixed notice, no blanket success", box(host, "Emergency Medical Technician (EMT)").checked && !!btn(host, "Add 1 to your catalog")
     && notes.some((n) => n.kind === "error" && n.title === "1 added, 1 not added") && !notes.some((n) => n.kind === "success"));
  answers.add_standard_cert_type = () => ({ data: null, error: { message: "Only a Department Admin can manage cert types." } });
  globalThis.__sb.calls = []; reloads.length = 0; notes.length = 0;
  await click(btn(host, "Add 1 to your catalog")); await tick();
  ok("all refused: no reload, the refusal shown", reloads.length === 0 && row(host, "Emergency Medical Technician (EMT)").textContent.includes("Only a Department Admin can manage cert types.") && notes.some((n) => n.kind === "error" && n.title === "That one wasn't added"));
  delete answers.add_standard_cert_type;
  unmount(); }

// 6. a failed READ
{ readAnswer = (t) => t === "standard_cert_types" ? { data: null, error: { message: "Load failed" } } : { data: [], error: null };
  const { host, unmount } = await mount(["Department Admin"]);
  await click(btn(host, "Manage")); await click(btn(host, "Add from the standard list")); await tick();
  ok("a failed read shows the error + Retry, no empty list, no add button", text(host).includes("Load failed") && !!btn(host, "Retry") && !row(host, "Firefighter") && !btn(host, "Pick the ones to add"));
  readAnswer = null;
  await click(btn(host, "Retry")); await tick();
  ok("Retry loads the list and clears the error", !!row(host, "Firefighter") && !text(host).includes("Load failed"));
  unmount(); }

// 7. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const base = execSync("git show 0d1113b:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const rpcLines = (s, n) => (s.match(new RegExp(`.*supabase\\.rpc\\("${n}".*`, "g")) || []).join("\n");
ok("set_cert_type / delete_cert_type / assign_cert_type / dept_cert_types calls byte-identical to the base",
   ["set_cert_type", "delete_cert_type", "assign_cert_type", "dept_cert_types"].every((n) => rpcLines(src, n) === rpcLines(base, n) && rpcLines(src, n).length > 0));
const i = src.indexOf("function StandardCertPicker("), j = src.indexOf("\nfunction ", i + 10);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
ok("no hex literal in the new component", i > 0 && (strip(src.slice(i, j)).match(/#[0-9A-Fa-f]{3,8}\b/g) || []).length === 0);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count in App.jsx unchanged vs the base", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
