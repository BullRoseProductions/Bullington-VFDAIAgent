// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/cert_catalog_ui_slice1_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for
// in-memory fakes) and checks cert catalog UI Slice 1:
//   1. certStatus(exp, neverExpires): NO EXPIRY at rank 2 (also over an old / blank exp); untyped unchanged; CERT_FIRE
//   2. the math is unchanged: certCoverage + the compliance test give the SAME result for a never-expires cert as for a
//      current one (rank 2 equivalence), and an untyped blank cert still counts as undated
//   3. shared/expiry.js: no_expiry passes through and ranks last; the reminder sender's filter can't select it
//   4. enrichCerts: an untyped / stale-type cert enriches to neverExpires false, no type
//   5. CertTypesPanel (happy-dom): DA / PA see it, an Officer / Board don't; grouped by category; add / edit call
//      set_cert_type with the right args; a raised clash is SHOWN; delete goes through confirmDestructive then
//      delete_cert_type; a raised delete error is shown
//   6. CertTypePicker: assign_cert_type(cert, type | null); the row re-enriches to NO EXPIRY at once; an error is shown
//   7. the source: every certStatus call passes neverExpires; update_cert / delete_cert calls byte-identical to
//      origin/main; no hex in the new components; the locked-token count unchanged; no readiness-requirement UI added
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
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; } };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  confirm: `
    export const confirmDestructive = async (o) => { globalThis.__confirmed.push(o); return true; };
    export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => !!globalThis.__canDeleteShared;
    export const DestructiveConfirmHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-cat1-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { certStatus, expPhrase, certCoverage, CERT_FIRE, enrichCerts, CertTypesPanel, CertTypePicker, CertTypesCtx, EXP_SECTION };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const A = await import(pathToFileURL(out).href);
const { certStatus, expPhrase, certCoverage, CERT_FIRE, enrichCerts, CertTypesPanel, CertTypePicker, CertTypesCtx, EXP_SECTION, createRoot, act, React } = A;
const { expiryBucket, BUCKET_RANK, EXPIRING_MONTHS } = await import(pathToFileURL(join(root, "shared/expiry.js")).href);

// 1. certStatus
const now = new Date(); const ym = (d) => { const x = new Date(now.getFullYear(), now.getMonth() + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; };
const ne = certStatus(null, true), neOld = certStatus("2019-01", true), cur = certStatus(ym(12));
ok("certStatus(…, true) = NO EXPIRY, rank 2, CURRENT's colour", ne.label === "NO EXPIRY" && ne.rank === 2 && ne.color === cur.color);
ok("the type wins over an old exp (as expiration_rows does)", neOld.label === "NO EXPIRY" && neOld.rank === 2);
ok("untyped unchanged: blank NO DATE 3, old EXPIRED 0, soon EXPIRING 1, later CURRENT 2",
  certStatus(null).rank === 3 && certStatus(ym(-2)).rank === 0 && certStatus(ym(1)).rank === 1 && cur.rank === 2 && certStatus(ym(1), false).label === "EXPIRING");
ok("CERT_FIRE has NO EXPIRY = CURRENT's token", CERT_FIRE["NO EXPIRY"] && CERT_FIRE["NO EXPIRY"] === CERT_FIRE.CURRENT);
ok("expPhrase: never-expires reads \"Doesn't expire\"; untyped blank unchanged", expPhrase(null, true) === "Doesn't expire" && expPhrase(null) === "No expiration date");

// 2. the math is unchanged (a never-expires cert counts exactly like a current one)
const mk = (certs) => [{ id: "m1", name: "A", status: "Active", access: ["Member"], certs }, { id: "m2", name: "B", status: "Active", access: ["Member"], certs: [] }];
const covNe = certCoverage(mk([{ id: "c", name: "FF II", exp: null, neverExpires: true }]), { includeProbationary: true });
const covCur = certCoverage(mk([{ id: "c", name: "FF II", exp: ym(12) }]), { includeProbationary: true });
const covBlank = certCoverage(mk([{ id: "c", name: "FF II", exp: null }]), { includeProbationary: true });
ok("certCoverage: never-expires == current (covered, pct), not undated", covNe.covered === covCur.covered && covNe.pct === covCur.pct && covNe.undatedCerts === 0 && covCur.undatedCerts === 0, JSON.stringify({ ne: [covNe.covered, covNe.pct, covNe.undatedCerts], cur: [covCur.covered, covCur.pct] }));
ok("certCoverage: an untyped blank cert still counts undated, not covered", covBlank.undatedCerts === 1 && covBlank.covered < covNe.covered);
const compliance = (cs) => Math.round((cs.filter((c) => certStatus(c.exp, c.neverExpires).rank === 2).length / cs.length) * 100);   // the RosterMembers test
ok("compliance test: never-expires counts compliant like current", compliance([{ exp: null, neverExpires: true }, { exp: ym(12) }]) === 100 && compliance([{ exp: null }, { exp: ym(12) }]) === 50);

// 3. shared/expiry.js
const tym = now.getFullYear() * 12 + now.getMonth() + 1;
ok("expiryBucket passes no_expiry through (never re-bucketed to no_date)", expiryBucket({ bucket: "no_expiry", expires_on: null }, tym) === "no_expiry");
ok("expiryBucket unchanged for the rest", expiryBucket({ bucket: "no_date" }, tym) === "no_date" && expiryBucket({ bucket: "expired", expires_on: "2020-01-31" }, tym) === "expired" && EXPIRING_MONTHS === 3);
ok("BUCKET_RANK: no_expiry ranks last (after current)", BUCKET_RANK.no_expiry === 4 && BUCKET_RANK.current === 3 && BUCKET_RANK.expired === 0);
const reminders = readFileSync(join(root, "api/expiration-reminders.js"), "utf8");
ok("reminder sender only selects expired / soon with a date — no_expiry can't be sent", /\.filter\(\(r\) => \(r\.ui_bucket === "expired" \|\| r\.ui_bucket === "soon"\) && r\.member_id && r\.expires_on\)/.test(reminders));
ok("Expirations: a no_expiry section that reads satisfied (green, not an alert)", EXP_SECTION.no_expiry && EXP_SECTION.no_expiry.color === EXP_SECTION.current.color && EXP_SECTION.no_expiry.Icon === EXP_SECTION.current.Icon);

// 4. enrichCerts
const map = new Map([["t1", { id: "t1", name: "Firefighter II", never_expires: true, category: "certification" }], ["t2", { id: "t2", name: "EMT-Basic", never_expires: false, category: "certification" }]]);
const en = enrichCerts([{ id: "a", certTypeId: "t1" }, { id: "b", certTypeId: "t2" }, { id: "c", certTypeId: null }, { id: "d", certTypeId: "gone" }], map);
ok("enrichCerts: typed never-expires / typed expiring / untyped / stale (deleted) type", en[0].neverExpires && en[0].typeName === "Firefighter II" && !en[1].neverExpires && en[1].typeName === "EMT-Basic"
  && !en[2].neverExpires && en[2].typeName === null && !en[3].neverExpires && en[3].typeName === null);

// ---- happy-dom harness
const TYPES = [{ id: "t1", name: "Firefighter II", never_expires: true, category: "certification", cert_count: 22 },
               { id: "t2", name: "EMT-Basic", never_expires: false, category: "certification", cert_count: 12 },
               { id: "t3", name: "Water Rescue (SCUBA)", never_expires: true, category: "continuing_education", cert_count: 3 }];
let answers = {};
globalThis.__sb = { calls: [], answer: (n) => answers[n] ? answers[n]() : { data: n === "dept_cert_types" ? TYPES : null, error: null } };
globalThis.__confirmed = [];
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const reloads = [];
async function mount(el) {
  globalThis.__sb.calls = []; globalThis.__confirmed = []; notes.length = 0; reloads.length = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  const ctx = { types: TYPES, typeMap: new Map(TYPES.map((t) => [t.id, t])), reload: async () => { reloads.push(1); return { error: null }; } };
  await act(async () => { r.render(React.createElement(CertTypesCtx.Provider, { value: ctx }, el)); });
  await tick();
  return { host, unmount: () => act(() => r.unmount()) };
}
const btn = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent.replace(/\s+/g, " ").trim().includes(text));
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = async (n, v) => act(async () => {
  const proto = n.tagName === "SELECT" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(n, v);
  n.dispatchEvent(new win.Event(n.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
});
const text = (host) => host.textContent.replace(/\s+/g, " ");

// 5. CertTypesPanel
for (const [who, role, cds, seen] of [["Department Admin", ["Department Admin"], true, true], ["Project Admin", ["Project Admin"], true, true], ["Officer", ["Officer"], false, false], ["Board Member", ["Board Member"], false, false]]) {
  globalThis.__canDeleteShared = cds;
  const { host, unmount } = await mount(React.createElement(CertTypesPanel, { S, role, notify }));
  ok(`panel gate — ${who}: ${seen ? "shown" : "hidden"}`, !!btn(host, "Manage") === seen);
  unmount();
}
{ globalThis.__canDeleteShared = true;
  const { host, unmount } = await mount(React.createElement(CertTypesPanel, { S, role: ["Department Admin"], notify }));
  await click(btn(host, "Manage"));
  const t = text(host);
  ok("list grouped by category, with counts and the expires flag", t.indexOf("Certifications") < t.indexOf("Firefighter II") && t.indexOf("Continuing education") < t.indexOf("Water Rescue (SCUBA)")
     && t.indexOf("Firefighter II") < t.indexOf("Continuing education") && t.includes("22 member certs linked") && t.includes("Doesn't expire") && t.includes("Expires"));
  await click(btn(host, "Add cert type"));
  const nameIn = host.querySelector('input[placeholder="e.g. Firefighter II"]');
  await setVal(nameIn, "  Hazmat Ops  ");
  await click(btn(host, "Continuing education"));
  await click(host.querySelector('input[type="checkbox"]'));   // expires: on -> off = never expires
  await click(btn(host, "Save cert type")); await tick();
  const c1 = globalThis.__sb.calls.find((c) => c.n === "set_cert_type");
  ok("add -> set_cert_type(null, trimmed name, never_expires true, continuing_education); reloads; success", c1 && c1.args.p_id === null && c1.args.p_name === "Hazmat Ops" && c1.args.p_never_expires === true && c1.args.p_category === "continuing_education"
     && reloads.length === 1 && notes.some((n) => n.kind === "success"), JSON.stringify(c1?.args));
  answers.set_cert_type = () => ({ data: null, error: { message: 'Your department already has a cert type named "EMT-Basic".' } });
  const editBtns = [...host.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Edit");
  await click(editBtns[1]);   // EMT-Basic (second in Certifications)
  await click(btn(host, "Save cert type")); await tick();
  const c2 = globalThis.__sb.calls.filter((c) => c.n === "set_cert_type").at(-1);
  ok("edit -> set_cert_type(t2, …, never_expires false, certification); a raised clash is SHOWN inline, no success", c2.args.p_id === "t2" && c2.args.p_never_expires === false && c2.args.p_category === "certification"
     && text(host).includes('Your department already has a cert type named "EMT-Basic".') && !!btn(host, "Save cert type"));
  delete answers.set_cert_type; notes.length = 0;
  await click(btn(host, "Cancel"));
  const delBtns = [...host.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Delete");
  await click(delBtns[0]); await tick();   // Firefighter II
  const d1 = globalThis.__sb.calls.find((c) => c.n === "delete_cert_type");
  const conf = globalThis.__confirmed.at(-1);
  ok("delete -> confirmDestructive (says certs are kept, unlinked) -> delete_cert_type(t1)", d1 && d1.args.p_id === "t1" && conf && conf.noun === "cert type" && conf.name === "Firefighter II" && /kept and simply unlinked/.test(conf.impact));
  answers.delete_cert_type = () => ({ data: null, error: { message: "That cert type is not in your department." } });
  notes.length = 0;
  await click([...host.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Delete")[0]); await tick();
  ok("a raised delete error is shown (no silent success)", notes.some((n) => n.kind === "error" && n.text === "That cert type is not in your department.") && !notes.some((n) => n.kind === "success"));
  delete answers.delete_cert_type;
  unmount(); }
{ globalThis.__canDeleteShared = false;   // an edge: manage gate true but the typed-delete gate false -> no Delete control
  const { host, unmount } = await mount(React.createElement(CertTypesPanel, { S, role: ["Department Admin"], notify }));
  await click(btn(host, "Manage"));
  ok("Delete hidden when the typed-delete gate is off", !btn(host, "Delete") && !!btn(host, "Edit"));
  unmount(); }

// 6. CertTypePicker
{ let updated = null;
  const member = { id: "m1", name: "Marcus Reed", certs: [{ id: "c1", name: "Swiftwater cert", exp: null, certTypeId: null, neverExpires: false, typeName: null }] };
  const { host, unmount } = await mount(React.createElement(CertTypePicker, { cert: member.certs[0], member, onUpdate: (m) => { updated = m; }, notify }));
  const sel = host.querySelector("select");
  ok("picker: grouped options + an un-assign option", sel && [...sel.querySelectorAll("optgroup")].map((g) => g.label).join("|") === "Certifications|Continuing education" && sel.querySelector('option[value=""]'));
  await setVal(sel, "t3"); await tick();
  const a1 = globalThis.__sb.calls.find((c) => c.n === "assign_cert_type");
  const c = updated?.certs?.[0];
  ok("assign -> assign_cert_type(c1, t3); the row re-enriches -> NO EXPIRY at once; catalog refreshed", a1 && a1.args.p_cert_id === "c1" && a1.args.p_cert_type_id === "t3" && c?.certTypeId === "t3" && c?.neverExpires && c?.typeName === "Water Rescue (SCUBA)"
     && certStatus(c.exp, c.neverExpires).label === "NO EXPIRY" && reloads.length === 1);
  answers.assign_cert_type = () => ({ data: null, error: { message: "Only a Department Admin can assign cert types." } });
  updated = null;
  await setVal(sel, "t2"); await tick();
  ok("a raised assign error is shown and nothing changes", notes.some((n) => n.kind === "error" && n.text === "Only a Department Admin can assign cert types.") && updated === null);
  delete answers.assign_cert_type;
  unmount(); }
{ let updated = null;
  const member = { id: "m1", certs: [{ id: "c1", name: "FF II", exp: null, certTypeId: "t1", neverExpires: true, typeName: "Firefighter II" }] };
  const { host, unmount } = await mount(React.createElement(CertTypePicker, { cert: member.certs[0], member, onUpdate: (m) => { updated = m; }, notify }));
  await setVal(host.querySelector("select"), ""); await tick();
  const a2 = globalThis.__sb.calls.find((c) => c.n === "assign_cert_type");
  ok("un-assign -> assign_cert_type(c1, null); the row reads like an untyped cert again", a2 && a2.args.p_cert_type_id === null && updated?.certs[0].neverExpires === false && updated?.certs[0].typeName === null && certStatus(null, updated.certs[0].neverExpires).label === "NO DATE");
  unmount(); }

// 7. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const stripAll = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const calls = stripAll(src).match(/certStatus\([^()]*\)/g) || [];
const bare = calls.filter((c) => !/,/.test(c) && !/^certStatus\(exp, neverExpires/.test(c));
ok("every certStatus(…) call passes neverExpires", calls.length >= 13 && bare.length === 0, `${calls.length} calls · bare: ${JSON.stringify(bare)}`);
const rpcLines = (s, n) => (s.match(new RegExp(`.*supabase\\.rpc\\("${n}".*`, "g")) || []).join("\n");
ok("update_cert / delete_cert calls byte-identical to origin/main", rpcLines(src, "update_cert") === rpcLines(main, "update_cert") && rpcLines(src, "delete_cert") === rpcLines(main, "delete_cert") && rpcLines(src, "update_cert").length > 0);
const body = (name) => { const i = src.indexOf(`function ${name}(`); let j = src.indexOf("\nfunction ", i + 10); const k = src.indexOf("\nconst ", i + 10); if (k > 0 && k < j) j = k; return src.slice(i, j); };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const newCode = ["CertTypeForm", "CertTypesPanel", "CertTypePicker", "enrichCerts"].map(body).join("\n");
ok("no hex literal in the new components", (strip(newCode).match(/#[0-9A-Fa-f]{3,8}\b/g) || []).length === 0);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count in App.jsx unchanged vs origin/main", tok(src) === tok(main), `${tok(src)} vs ${tok(main)}`);
const kindLit = (x) => (x.match(/["']cert_type["']/g) || []).length;
ok("no readiness-requirement cert_type UI in this slice (Slice 2)", kindLit(src) === kindLit(main), `${kindLit(src)} vs ${kindLit(main)}`);
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
