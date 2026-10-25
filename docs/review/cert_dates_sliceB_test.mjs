// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/cert_dates_sliceB_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient + ConfirmDestructive swapped for in-memory
// fakes) and checks cert dates Slice B — the UI + api/ half of achieved_on / no_expiry (Slice A is live):
//   1. shared/expiry.js: certDatesError() = update_cert's rules (real month unless "doesn't expire"; earned a real month, not
//      in the future, not after the expiry) in the server's words; ymLabel()
//   2. enrichCerts: neverExpires = the cert's own noExpiry OR its type's never_expires (the twin of cert_never_expires());
//      certStatus / expPhrase then read NO EXPIRY (rank 2, counts like current) / "Doesn't expire" for a flagged cert
//   3. CertDatesFields: "Doesn't expire" disables (and blanks) the expiry month
//   4. CertProposals (member self-propose): "Doesn't expire" + earned -> cert_submissions insert carries no_expiry true,
//      exp null, achieved_on; a future earned month is refused before any upload / insert
//   5. ProposeCert (leader): the same, for the target member
//   6. MemberDetail inline editor: "Doesn't expire" + earned -> update_cert(cert_id, new_name, new_exp null,
//      new_no_expiry true, new_achieved_on); the edited cert re-enriches (neverExpires true) and shows "Earned …";
//      an earned month after the expiry is refused with no RPC
//   7. api/digest.js: certExpiryEnd / certRank use the shared rule ('0000-00' is no date, not Dec 1899); a never-expiring cert
//      (flag, or same-department type) ranks current and is never flagged; another department's type doesn't count
//   8. the source: only App.jsx / shared/expiry.js / api/digest.js / api/assistant.js change at runtime; both cert loaders
//      read no_expiry + achieved_on; the client still never writes certs directly; assistant my_certs reads the flag + type;
//      no hex in CertDatesFields; verified counts unchanged; Notify crew absent
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
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "IntersectionObserver"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { certDatesError, ymLabel } = await import(pathToFileURL(join(root, "shared/expiry.js")).href);
const MOCKS = {
  supabase: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _ins: null };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "lt", "gt", "not", "or"]) b[m] = () => b;
      b.insert = (row) => { b._ins = row; st.inserts.push({ table, row }); return b; };
      b.update = (row) => { st.updates.push({ table, row }); return b; };
      b.upsert = (row) => { st.updates.push({ table, row }); return b; };
      b.single = () => b; b.maybeSingle = () => b;
      b.then = (res, rej) => Promise.resolve(b._ins ? { data: b._ins, error: null } : st.table(table)).then(res, rej);
      return b;
    }
    export const supabase = {
      from: q,
      rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ upload: async (p) => { st.uploads.push(p); return { data: { path: p }, error: null }; }, createSignedUrl: async () => ({ data: { signedUrl: "https://x" }, error: null }) }) },
      auth: { getUser: async () => ({ data: { user: { id: "u-me" } } }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: () => {},
    };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0; export const authFetch = (...a) => fetch(...a);`,
  confirm: `
    export const confirmDestructive = async () => true;
    export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => true;
    export const DestructiveConfirmHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-cdB-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { enrichCerts, certStatus, expPhrase, CertDatesFields, CertProposals, ProposeCert, MemberDetail, CertTypesCtx };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { enrichCerts, certStatus, expPhrase, CertDatesFields, CertProposals, ProposeCert, MemberDetail, CertTypesCtx, createRoot, act, React } = await import(pathToFileURL(out).href);

const DEPT = "d-1", ME = { id: "m-me", department_id: DEPT };
globalThis.__sb = {
  calls: [], inserts: [], updates: [], uploads: [],
  answer: (n) => n === "my_member_id" ? { data: ME.id, error: null } : n === "my_department_id" ? { data: DEPT, error: null } : { data: null, error: null },
  table: () => ({ data: [], error: null }),
};
const reset = () => Object.assign(globalThis.__sb, { calls: [], inserts: [], updates: [], uploads: [] });
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => String(s || "").replace(/\s+/g, " ");
async function mount(el) {
  notes.length = 0; reset();
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(el); }); await tick(); await tick();
  return { host, rerender: async (e2) => { await act(async () => { r.render(e2); }); await tick(); }, unmount: () => act(() => r.unmount()) };
}
const btn = (host, text) => [...host.querySelectorAll("button")].find((b) => norm(b.textContent).trim() === text) || [...host.querySelectorAll("button")].find((b) => norm(b.textContent).includes(text));
const click = (el) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const fieldInput = (host, label) => [...host.querySelectorAll("label")].find((l) => norm(l.textContent).includes(label))?.querySelector("input");
const type = async (input, v) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set; setter.call(input, v);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
};
const attach = async (input) => {
  await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [{ name: "proof.pdf" }] }); input.dispatchEvent(new win.Event("change", { bubbles: true })); });
};
const now = new Date(), ym = (k) => { const x = new Date(now.getFullYear(), now.getMonth() + k, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; };

// 1 the shared rule
const T = new Date(2026, 9, 15);   // Oct 2026
ok("certDatesError: valid combos pass (expires + earned before it; doesn't expire + earned; nothing at all)",
  certDatesError({ exp: "2027-06", noExpiry: false, achievedOn: "2024-03" }, T) === null && certDatesError({ exp: "", noExpiry: true, achievedOn: "2024-03" }, T) === null
  && certDatesError({ exp: "", noExpiry: false, achievedOn: "" }, T) === null && certDatesError({ exp: "garbage", noExpiry: true, achievedOn: "" }, T) === null);
ok("certDatesError: the server's messages — bad expiry, bad earned, earned in the future, earned after the expiry",
  certDatesError({ exp: "2026-13", noExpiry: false, achievedOn: "" }, T) === "Expiration must be a real month as YYYY-MM (e.g. 2027-06)."
  && certDatesError({ exp: "", noExpiry: false, achievedOn: "0000-00" }, T) === "Achievement date must be a real month as YYYY-MM (e.g. 2024-03)."
  && certDatesError({ exp: "", noExpiry: true, achievedOn: "2026-12" }, T) === "Achievement date can't be in the future."
  && certDatesError({ exp: "2020-01", noExpiry: false, achievedOn: "2021-05" }, T) === "Achievement date can't be after the expiration."
  && certDatesError({ exp: "2026-10", noExpiry: false, achievedOn: "2026-10" }, T) === null);
// the live update_cert's raise messages, read from the applied Slice A migration (f27c525) — '' unescaped to '
const sliceA = execSync("git show f27c525:sql/cert_dates_sliceA_DRAFT.sql", { cwd: root, maxBuffer: 1 << 24 }).toString();
const updBody = sliceA.slice(sliceA.indexOf("CREATE FUNCTION public.update_cert("), sliceA.indexOf("REVOKE ALL ON FUNCTION public.update_cert("));
const sqlUpdate = [...updBody.matchAll(/raise exception '((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
ok("…and every message is word-for-word the live update_cert's (Slice A, f27c525)", ["Expiration must be a real month as YYYY-MM (e.g. 2027-06).", "Achievement date must be a real month as YYYY-MM (e.g. 2024-03).",
  "Achievement date can't be in the future.", "Achievement date can't be after the expiration."].every((m) => sqlUpdate.includes(m)));
ok("ymLabel: '2024-03' -> 'Mar 2024'; garbage -> null", ymLabel("2024-03") === "Mar 2024" && ymLabel("0000-00") === null && ymLabel(null) === null);

// 2 enrichCerts + status
const typeMap = new Map([["t-nx", { id: "t-nx", name: "Boaters Ed", never_expires: true }], ["t-ex", { id: "t-ex", name: "EMT", never_expires: false }]]);
const en = enrichCerts([{ id: 1, exp: null, noExpiry: true }, { id: 2, exp: "2020-01", certTypeId: "t-nx" }, { id: 3, exp: null, noExpiry: true, certTypeId: "t-nx" },
                        { id: 4, exp: "2020-01", certTypeId: "t-ex" }, { id: 5, exp: "2020-01" }], typeMap);
ok("enrichCerts: neverExpires = own flag OR never-expires type (flag · type · both true; plain type / no type false)", en.map((c) => c.neverExpires).join() === "true,true,true,false,false");
ok("a flagged cert reads NO EXPIRY (rank 2, counts like current) / \"Doesn't expire\"", certStatus(en[0].exp, en[0].neverExpires).label === "NO EXPIRY" && certStatus(en[0].exp, en[0].neverExpires).rank === 2 && expPhrase(en[0].exp, en[0].neverExpires) === "Doesn't expire");
ok("a real expired cert with no flag still reads EXPIRED", certStatus(en[4].exp, en[4].neverExpires).label === "EXPIRED");

// 3 CertDatesFields
{ const Harness = () => { const [e, setE] = React.useState("2027-06"), [n, setN] = React.useState(false), [a, setA] = React.useState("");
    return React.createElement(CertDatesFields, { S, exp: e, setExp: setE, noExpiry: n, setNoExpiry: setN, achievedOn: a, setAchievedOn: setA }); };
  const { host, unmount } = await mount(React.createElement(Harness));
  const expIn = fieldInput(host, "Expires (YYYY-MM)");
  const before = !expIn.disabled && expIn.value === "2027-06";
  await click(btn(host, "Doesn't expire"));
  const expIn2 = fieldInput(host, "Expires (YYYY-MM)");
  ok("CertDatesFields: \"Doesn't expire\" disables + blanks the expiry month; the choice is aria-pressed; Earned is there",
    before && expIn2.disabled && expIn2.value === "" && btn(host, "Doesn't expire").getAttribute("aria-pressed") === "true" && !!fieldInput(host, "Earned (YYYY-MM, optional)"));
  unmount(); }

// 4 CertProposals (member)
{ const { host, unmount } = await mount(React.createElement(CertProposals, { S, notify }));
  await click(btn(host, "Propose a certification")); await tick();
  await type(fieldInput(host, "Certification"), "Boaters Ed");
  await click(btn(host, "Doesn't expire"));
  await type(fieldInput(host, "Earned (YYYY-MM, optional)"), ym(1));    // next month = the future
  await attach(host.querySelector('input[type="file"]'));
  await click(btn(host, "Submit for review")); await tick();
  const refused = notes.some((n) => n.kind === "error" && n.text === "Achievement date can't be in the future.") && globalThis.__sb.inserts.length === 0 && globalThis.__sb.uploads.length === 0;
  await type(fieldInput(host, "Earned (YYYY-MM, optional)"), "2024-03");
  await click(btn(host, "Submit for review")); await tick(); await tick();
  const ins = globalThis.__sb.inserts.find((x) => x.table === "cert_submissions")?.row;
  ok("CertProposals: a future earned month is refused before any upload / insert", refused);
  ok("CertProposals: \"Doesn't expire\" + earned -> insert no_expiry true · exp null · achieved_on '2024-03' (source self, proof attached)",
    ins && ins.no_expiry === true && ins.exp === null && ins.achieved_on === "2024-03" && ins.source === "self" && !!ins.proof_path, JSON.stringify(ins));
  unmount(); }

// 5 ProposeCert (leader, for a member)
{ const target = { id: "m-t", department_id: DEPT, name: "Tess" };
  const { host, unmount } = await mount(React.createElement(ProposeCert, { S, role: ["Department Admin"], member: target, notify }));
  await click(btn(host, "Propose certification")); await tick();
  await type(fieldInput(host, "Certification"), "EMT-B");
  await type(fieldInput(host, "Expires (YYYY-MM)"), "2027-06");
  await type(fieldInput(host, "Earned (YYYY-MM, optional)"), "2023-11");
  await attach(host.querySelector('input[type="file"]'));
  await click(btn(host, "Submit for review")); await tick(); await tick();
  const ins = globalThis.__sb.inserts.find((x) => x.table === "cert_submissions")?.row;
  ok("ProposeCert: expires 2027-06 + earned 2023-11 -> insert no_expiry false · exp '2027-06' · achieved_on '2023-11' for the target member",
    ins && ins.no_expiry === false && ins.exp === "2027-06" && ins.achieved_on === "2023-11" && ins.member_id === "m-t", JSON.stringify(ins));
  unmount(); }

// 6 MemberDetail inline editor
{ const member = { id: "m-1", department_id: DEPT, name: "Boater B", status: "Active", access: ["Member"], phone: "—", certs: enrichCerts([{ id: "c-1", name: "Boaters Ed", exp: "2025-01", certTypeId: null, noExpiry: false, achievedOn: null }], new Map()) };
  let updated = null;
  const props = (m) => ({ S, member: m, role: ["Department Admin"], back: () => {}, onUpdate: (x) => { updated = x; }, sessions: [], notify, members: [m], meId: "m-da", dept: { name: "NH", disabled_modules: ["stationhours"] } });
  const ctx = (m) => React.createElement(CertTypesCtx.Provider, { value: { types: [], typeMap: new Map(), reload: async () => {} } }, React.createElement(MemberDetail, props(m)));
  const { host, rerender, unmount } = await mount(ctx(member));
  await click(btn(host, "Edit")); await tick();
  await type(fieldInput(host, "Expires (YYYY-MM)"), "2020-01");
  await type(fieldInput(host, "Earned (YYYY-MM, optional)"), "2021-05");
  await click(btn(host, "Save")); await tick();
  const refused = notes.some((n) => n.text === "Achievement date can't be after the expiration.") && !globalThis.__sb.calls.some((c) => c.n === "update_cert");
  await click(btn(host, "Doesn't expire"));
  await type(fieldInput(host, "Earned (YYYY-MM, optional)"), "2023-05");
  await click(btn(host, "Save")); await tick(); await tick();
  const call = globalThis.__sb.calls.find((c) => c.n === "update_cert");
  ok("MemberDetail: an earned month after the expiry is refused with no RPC", refused);
  ok("MemberDetail: \"Doesn't expire\" + earned -> update_cert(cert_id, new_name, new_exp null, new_no_expiry true, new_achieved_on '2023-05')",
    call && JSON.stringify(call.args) === JSON.stringify({ cert_id: "c-1", new_name: "Boaters Ed", new_exp: null, new_no_expiry: true, new_achieved_on: "2023-05" }), JSON.stringify(call?.args));
  const uc = updated?.certs?.[0];
  ok("…the edited cert re-enriches: noExpiry true, neverExpires true, exp null, achievedOn '2023-05'", uc && uc.noExpiry === true && uc.neverExpires === true && uc.exp === null && uc.achievedOn === "2023-05", JSON.stringify(uc));
  await rerender(ctx(updated));
  ok("…and the row reads \"Doesn't expire\" and \"Earned May 2023\"", norm(host.textContent).includes("Doesn't expire") && norm(host.textContent).includes("Earned May 2023"));
  unmount(); }

// 7 api/digest.js
const D = await import(pathToFileURL(join(root, "api/digest.js")).href);
const today = new Date(2026, 9, 15);
ok("digest: '0000-00' / '2026-13' are no date (null), not Dec 1899 / a wrapped month", D.certExpiryEnd("0000-00") === null && D.certExpiryEnd("2026-13") === null && D.certRank("0000-00", today) === null && D.certRank("2026-13", today) === null);
ok("digest: real months still rank (expired 0 / expiring 1 / current 2) and end on the month's last day", D.certRank("2026-01", today) === 0 && D.certRank("2026-12", today) === 1 && D.certRank("2028-01", today) === 2 && D.certExpiryEnd("2026-02").getDate() === 28);
ok("digest: never-expires = flag OR same-department type; another department's type doesn't count; it ranks current",
  D.certNeverExpires({ no_expiry: true, department_id: "a" }) && D.certNeverExpires({ no_expiry: false, department_id: "a", cert_types: { never_expires: true, department_id: "a" } })
  && !D.certNeverExpires({ no_expiry: false, department_id: "a", cert_types: { never_expires: true, department_id: "b" } }) && !D.certNeverExpires({ department_id: "a" })
  && D.certRank("2020-01", today, true) === 2);

// 8 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
// Structural fences are PINNED to cert dates Slice B's own release (739d1cc, a --no-ff merge whose first parent 2a94baa is the
// main it landed on): "vs origin/main" was true only until the next slice merged. Historical = the release vs its parent.
const REL = "739d1cc";
const atRef = (ref, p) => execSync(`git show ${ref}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const changed = execSync(`git diff --name-only ${REL}^1 ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
ok("Slice B (739d1cc) runtime changes vs its parent: only App.jsx, shared/expiry.js, api/digest.js, api/assistant.js", JSON.stringify(changed) === JSON.stringify(["api/assistant.js", "api/digest.js", "shared/expiry.js", "src/App.jsx"]), JSON.stringify(changed));
ok("both cert loaders read no_expiry + achieved_on", (src.match(/from\("certs"\)\.select\("id, member_id, name, exp, proof_path, cert_type_id, no_expiry, achieved_on"\)/g) || []).length === 2);
ok("the client still never writes certs directly", !/from\("certs"\)\.(insert|update|upsert|delete)/.test(src));
ok("update_cert is called with the two new named args", /rpc\("update_cert", \{ cert_id: c\.id, new_name: name, new_exp: expTrim \|\| null, new_no_expiry: draft\.noExpiry, new_achieved_on: achTrim \}\)/.test(src));
const asst = readFileSync(join(root, "api/assistant.js"), "utf8");
ok("assistant my_certs reads no_expiry + achieved_on + the type, and reports \"doesn't expire\"", asst.includes('select("name, exp, no_expiry, achieved_on, department_id, cert_types(never_expires, department_id)")') && asst.includes(`status: never(x) ? "doesn't expire"`));
const block = src.slice(src.indexOf("function CertDatesFields("), src.indexOf("\nfunction ", src.indexOf("function CertDatesFields(") + 10));
ok("no hex in CertDatesFields (FIRE / FS tokens)", !/#[0-9A-Fa-f]{3,8}\b/.test(block) && block.length > 500);
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token counts unchanged by Slice B (739d1cc) vs its parent (App.jsx, api/digest.js, api/assistant.js)", ["src/App.jsx", "api/digest.js", "api/assistant.js"].every((p) => tok(atRef(REL, p)) === tok(atRef(`${REL}^1`, p))));
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
