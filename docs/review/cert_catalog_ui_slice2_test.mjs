// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/cert_catalog_ui_slice2_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for
// in-memory fakes) and checks cert catalog UI Slice 2 — a cert type as a readiness requirement in the #5 configurator:
//   1. RdSetup gains a "Cert types" group, right after Qualifications, built from CertTypesCtx (dept_cert_types()) —
//      no extra fetch; items are the catalog's names
//   2. the stale-row pattern: a required cert_type row whose type left the catalog still shows, ticked, by its DB label
//   3. ticking / unticking -> set_readiness_requirement({ p_kind: "cert_type", p_ref_id: <id>, p_required }) and a reload;
//      a raised refusal is surfaced (notify error), never swallowed
//   4. empty catalog -> "No cert types yet — add them in Cert Types (Roster → Certifications)."
//   5. the obsolete "set it up as a qualification" copy is gone; the new copy is there; the expiring-credential note kept
//   6. the source: only the RdSetup block changed; the two `configurer && <RdSetup` mounts (DA / PA) unchanged; the
//      scorecard's "certs don't count" visibility line unchanged; RPC set unchanged vs origin/main (no new RPC); the
//      locked-token count unchanged; no hex in RdSetup; Notify crew absent
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  supabase: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "maybeSingle", "single"]) b[m] = () => b;
      b.then = (res, rej) => { st.reads.push(table); return Promise.resolve(st.table(table)).then(res, rej); };
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
const out = join(mkdtempSync(join(tmpdir(), "b4c-cat2-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { RdSetup, CertTypesCtx };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { RdSetup, CertTypesCtx, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- fixtures
const CATALOG = [{ id: "ct1", name: "Firefighter II", never_expires: true, category: "certification", cert_count: 4 },
                 { id: "ct2", name: "EMT-Basic", never_expires: false, category: "certification", cert_count: 2 }];
const QUALS = [{ id: "q1", name: "Pump Operator", active: true, sort_order: 1 }];
let REQS = [];
let answers = {};
globalThis.__sb = {
  calls: [], reads: [],
  answer: (n, args) => answers[n] ? answers[n](args) : n === "dept_readiness_requirements" ? { data: REQS, error: null } : { data: null, error: null },
  table: (t) => ({ data: t === "qualification_types" ? QUALS : [], error: null }),
};
const notes = []; const notify = (n) => notes.push(n);
let changed = 0;
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount(types) {
  globalThis.__sb.calls = []; globalThis.__sb.reads = []; notes.length = 0; changed = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  const ctx = { types, typeMap: new Map(types.map((t) => [t.id, t])), reload: async () => ({ error: null }) };
  await act(async () => { r.render(React.createElement(CertTypesCtx.Provider, { value: ctx }, React.createElement(RdSetup, { notify, onChanged: () => { changed += 1; } }))); });
  const setUp = [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === "Set up");
  await act(async () => { setUp.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  await tick(); await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const norm = (s) => s.replace(/\s+/g, " ").trim();
const text = (host) => norm(host.textContent);
const groups = (host) => [...host.querySelectorAll("div")].filter((d) => d.style.textTransform === "uppercase" && d.style.fontSize === "10.5px").map((d) => norm(d.textContent));
const row = (host, label) => [...host.querySelectorAll("label")].find((l) => norm(l.textContent) === label);
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });

// 1 + 2
REQS = [{ kind: "qualification_type", ref_id: "q1", required: true, label: "Pump Operator" },
        { kind: "cert_type", ref_id: "ct1", required: true, label: "Firefighter II" },
        { kind: "cert_type", ref_id: "gone", required: true, label: "Hazmat Tech (removed)" }];
{ const { host, unmount } = await mount(CATALOG);
  const g = groups(host);
  ok("a \"Cert types\" group, right after Qualifications and before Documents", JSON.stringify(g) === JSON.stringify(["Credentials", "Qualifications", "Cert types", "Documents (Read & Sign)"]), JSON.stringify(g));
  ok("built from CertTypesCtx — no cert-type fetch of its own", !globalThis.__sb.reads.includes("cert_types") && !globalThis.__sb.calls.some((c) => c.n === "dept_cert_types"), JSON.stringify({ reads: globalThis.__sb.reads, calls: globalThis.__sb.calls.map((c) => c.n) }));
  const ff = row(host, "Firefighter II"), emt = row(host, "EMT-Basic"), stale = row(host, "Hazmat Tech (removed)");
  ok("catalog items listed; a required one is ticked, an unrequired one isn't", ff && emt && ff.querySelector("input").checked && !emt.querySelector("input").checked);
  ok("stale-row pattern: a required cert_type no longer in the catalog still shows, ticked, by its DB label", stale && stale.querySelector("input").checked);
  // 3 tick EMT-Basic, untick the stale one
  await click(emt.querySelector("input")); await tick();
  const c1 = globalThis.__sb.calls.filter((c) => c.n === "set_readiness_requirement").at(-1);
  ok("tick -> set_readiness_requirement(cert_type, ct2, true); the standard reloads", c1 && c1.args.p_kind === "cert_type" && c1.args.p_ref_id === "ct2" && c1.args.p_required === true && changed === 1, JSON.stringify(c1?.args));
  await click(row(host, "Hazmat Tech (removed)").querySelector("input")); await tick();
  const c2 = globalThis.__sb.calls.filter((c) => c.n === "set_readiness_requirement").at(-1);
  ok("untick the stale row -> set_readiness_requirement(cert_type, gone, false)", c2 && c2.args.p_kind === "cert_type" && c2.args.p_ref_id === "gone" && c2.args.p_required === false);
  answers.set_readiness_requirement = () => ({ data: null, error: { message: "That cert type is not in your department." } });
  notes.length = 0;
  await click(row(host, "EMT-Basic").querySelector("input")); await tick();
  ok("a refusal is surfaced (notify error with the DB message)", notes.some((n) => n.kind === "error" && n.text === "That cert type is not in your department."));
  delete answers.set_readiness_requirement;
  // 5
  const t = text(host);
  ok("obsolete \"set it up as a qualification\" copy gone; new copy present; expiring-credential note kept",
    !t.includes("set it up as a qualification") && !t.includes("Certs show on scorecards but don't count")
    && t.includes("Certs can be required directly — tick a cert type below. A current or never-expires cert satisfies it; an expired or undated one does not.")
    && t.includes("An expiring credential still counts and shows as a renewal due."));
  unmount(); }
// 4
REQS = [];
{ const { host, unmount } = await mount([]);
  ok("empty catalog -> points to Cert Types (Roster → Certifications)", text(host).includes("No cert types yet — add them in Cert Types (Roster → Certifications).") && text(host).includes("No documents collect signatures yet."));
  unmount(); }

// 6 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const changedFiles = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime)", JSON.stringify(changedFiles) === '["src/App.jsx"]', JSON.stringify(changedFiles));
const block = (s) => { const i = s.indexOf("function RdSetup("); return s.slice(i, s.indexOf("\nfunction ", i + 10)); };
// Re-baselined after promote: "outside RdSetup unchanged vs origin/main" only holds until a later slice lands. Pinned instead
// to the reviewed release itself — Slice 2 (e371010) changed nothing outside RdSetup vs its parent (ebfcb1c) — and the
// ongoing guard: RdSetup in this tree is byte-identical to Slice 2's.
const at = (ref) => execSync(`git show ${ref}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const s2 = at("e371010"), s2parent = at("e371010^1");
ok("Slice 2 (e371010) changed nothing outside RdSetup vs its parent; RdSetup here = Slice 2's", s2.replace(block(s2), "") === s2parent.replace(block(s2parent), "") && block(src) === block(s2) && block(src).length > 500);
const mounts = (s) => (s.match(/.*configurer && <RdSetup.*/g) || []).join("\n");
ok("the two DA/PA mounts (configurer && <RdSetup>) unchanged", mounts(src) === mounts(main) && (src.match(/configurer && <RdSetup/g) || []).length === 2);
ok("the scorecard's \"certs don't count\" visibility line unchanged", src.includes("Shown so they're visible — certs don't count toward the readiness verdict."));
const rpcs = (s) => [...new Set(s.match(/supabase\.rpc\("[a-z_]+"/g) || [])].sort().join(",");
ok("RPC set unchanged vs origin/main (no new RPC)", rpcs(src) === rpcs(main));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(main), `${tok(src)} vs ${tok(main)}`);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
ok("no hex literal in RdSetup", (strip(block(src)).match(/#[0-9A-Fa-f]{3,8}\b/g) || []).length === 0);
ok("Notify crew held back: no api/notify-session.js, 0 NotifyCrewModal", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
