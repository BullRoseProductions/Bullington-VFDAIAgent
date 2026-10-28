// node docs/review/onboarding_item_config_ui_test.mjs — reproducible from a clean checkout after `npm i` (no network, no DB).
// Bundles the REAL src/App.jsx with esbuild, exposing only the onboarding item-config pieces, then checks:
// 1. the honest state labels (probItemView): Approver not set / Awaiting officer check / Awaiting approval · {who};
// 2. the rendered config panel + member row: tiers + active members only, the scoped disclaimer on document items only,
//    NO file input anywhere; 3. who can sign (oicCanSign, mirrors onboarding_caller_can_sign) and the routing line;
// 4. the source: the four RPCs are the only writes, toggle() untouched, no upload control, no app-wide storage claim.
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

// ---- a browser just big enough for App.jsx's module scope to load under node ----
const noop = () => {};
const el = () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop }, sheet: { insertRule: noop } });
// atob/btoa: jspdf 4's node build binds window.atob/btoa at import (2.x shipped npm polyfills); Node has both natively (M-7)
globalThis.window = { atob: globalThis.atob, btoa: globalThis.btoa, location: { origin: "https://app.test", href: "https://app.test/", search: "", hash: "", pathname: "/" }, addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }), navigator: { userAgent: "node" }, innerWidth: 1200, innerHeight: 800, setTimeout, clearTimeout };
globalThis.document = { addEventListener: noop, removeEventListener: noop, createElement: el, createTextNode: () => ({}), head: el(), body: el(), documentElement: el(), visibilityState: "visible", querySelector: () => null, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }; globalThis.sessionStorage = globalThis.localStorage;

const root = fileURLToPath(new URL("../../", import.meta.url));
const APP = join(root, "src/App.jsx");
const EXPOSE = ["probItemView", "ProbItemRow", "OicItemConfig", "OicSignOff", "oicApproverLabel", "oicCanSign", "oicRoutingLine", "oicConfigured", "oicEligible"];
const out = join(mkdtempSync(join(tmpdir(), "b4c-oic-")), "app.under-test.mjs");
await build({
  entryPoints: [APP], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },   // node built-ins the renderer require()s
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "expose", setup(b) {
    // Vite asset imports ("…?url", "…?raw") have no meaning here — each becomes an empty string.
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, async (a) => {
      const { readFileSync } = await import("fs");
      return { contents: readFileSync(a.path, "utf8") + `\nexport { ${EXPOSE.join(", ")} };\nexport { renderToStaticMarkup } from "react-dom/server";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") };
    });
  } }],
});
// React + the renderer come from the SAME bundle as the components (two copies of React = an invalid hook call)
const { probItemView, ProbItemRow, OicItemConfig, OicSignOff, oicApproverLabel, oicCanSign, oicRoutingLine, oicConfigured, oicEligible, renderToStaticMarkup, React } = await import(pathToFileURL(out).href);


const R = (el) => renderToStaticMarkup(el);
const e = React.createElement;
// 1. labels
const person = { approver_kind: "person", approver_member_id: "m-kerr", approver_name: "D. Kerr", requires_doc: true, kind: "manual", is_mentor: false };
const tier = { approver_kind: "tier", approver_role: "Officer", requires_doc: false, kind: "manual", is_mentor: false };
const plain = { approver_kind: "tier", approver_role: null, requires_doc: false, kind: "manual", is_mentor: false };
ok("approver_not_set -> 'Approver not set' (muted, never a pass)", probItemView({ state: "approver_not_set" }, plain, true).text === "Approver not set" && probItemView({ state: "approver_not_set" }, plain, true).tone === "muted");
ok("awaiting_check -> 'Awaiting officer check'", probItemView({ state: "awaiting_check" }, person, true).text === "Awaiting officer check");
ok("awaiting_approval names the person", probItemView({ state: "awaiting_approval" }, person, true).text === "Awaiting approval · D. Kerr");
ok("awaiting_approval names the tier", probItemView({ state: "awaiting_approval" }, tier, true).text === "Awaiting approval · any Officer");
ok("awaiting_approval with no approver set names today's rule", probItemView({ state: "awaiting_approval" }, plain, true).text === "Awaiting approval · any officer or leadership");
ok("signed / open unchanged", probItemView({ state: "signed", signed_by_name: "Cap", signed_at: "2026-10-01T12:00:00Z" }, plain, true).text.startsWith("Signed by Cap") && probItemView({ state: "open" }, plain, true).text === "Open — an officer signs this off");
// 2. rendering
const members = [{ id: "m-kerr", name: "Dana Kerr", status: "Active", access: ["Member"] }, { id: "m-pro", name: "Pat Probie", status: "Probationary", access: ["Member"] },
  { id: "m-gone", name: "Gus Gone", status: "Inactive", access: ["Member"] }, { id: "m-pa", name: "Pam Admin", status: "Active", access: ["Project Admin"] }];
const cfgHtml = R(e(OicItemConfig, { it: { id: "i1", ...person }, members, busy: false, onSave: () => {} }));
ok("config: the three tiers + active / probationary members, never inactive or a Project Admin", ["Any Officer", "Any Department Admin", "Any Board Member", "Dana Kerr", "Pat Probie"].every((t) => cfgHtml.includes(t)) && !cfgHtml.includes("Gus Gone") && !cfgHtml.includes("Pam Admin"));
ok("config: a document item shows the scoped disclaimer", cfgHtml.includes("B4C doesn&#x27;t store this document — an officer checks it in person and records the sign-off."));
const cfgPlain = R(e(OicItemConfig, { it: { id: "i2", ...plain }, members, busy: false, onSave: () => {} }));
ok("config: no disclaimer when no document check", !cfgPlain.includes("store this document") && cfgPlain.includes("Any officer / leadership (default)"));
const staleHtml = R(e(OicItemConfig, { it: { id: "i3", approver_kind: "person", approver_member_id: "m-gone", requires_doc: false, kind: "manual" }, members, busy: false, onSave: () => {} }));
ok("config: an inactive person approver is shown as such (honest), not silently swapped", staleHtml.includes("Gus Gone (not active — pick someone else)"));
const row = (it, cfg) => R(e(ProbItemRow, { it, cfg, self: true, last: true }));
const docOpen = row({ item_id: "i1", label: "Medical statement", state: "awaiting_check", satisfied: false }, person);
const docDone = row({ item_id: "i1", label: "Medical statement", state: "signed", satisfied: true, signed_by_name: "Dana Kerr", signed_at: "2026-10-02T12:00:00Z" }, person);
ok("member row: an open document item carries the disclaimer; a signed one doesn't", docOpen.includes("B4C doesn&#x27;t store this document") && docOpen.includes("Awaiting officer check") && !docDone.includes("store this document"));
const so = R(e(OicSignOff, { requiresDoc: true, onSign: async () => true }));
ok("sign-off control renders a button, no input before it's opened", so.includes(">Sign off<") && !so.includes("<input"));
const all = [cfgHtml, cfgPlain, staleHtml, docOpen, docDone, so].join("");
ok("NO file input / capture anywhere rendered", !/type="file"|capture=|accept="/.test(all));
// 3. who signs
ok("can sign: the named person yes, someone else no, a DA always", oicCanSign(person, ["Member"], "m-kerr") && !oicCanSign(person, ["Officer"], "m-x") && oicCanSign(person, ["Department Admin"], "m-x"));
ok("can sign: the tier by access; Board isn't Officer", oicCanSign(tier, ["Officer"], "m-x") && !oicCanSign(tier, ["Board Member"], "m-x") && !oicCanSign(tier, ["Member"], "m-x"));
ok("can sign: unconfigured = Board / DA / Officer (the existing rule)", oicCanSign(plain, ["Board Member"], "m-x") && !oicCanSign(plain, ["Member"], "m-x"));
ok("routing line", oicRoutingLine({ ...person }, members) === "Signs off: Dana Kerr · Needs document checked in person." && oicRoutingLine(tier, members) === "Signs off: any Officer" && oicRoutingLine(plain, members) === null);
ok("only manual non-mentor items are eligible; configured = doc / person / tier", oicEligible({ kind: "manual" }) && !oicEligible({ kind: "hours" }) && !oicEligible({ kind: "manual", is_mentor: true }) && oicConfigured(tier) && !oicConfigured(plain));
// 4. source
const { readFileSync } = await import("fs");
const app = readFileSync(APP, "utf8");
const seg = app.slice(app.indexOf("/* ---------------- Onboarding item config"), app.indexOf("function ProbItemTags({ it }) {"));
ok("the new components write only through the RPCs (no .from(...).update / insert)", !/\.from\("onboarding_(items|progress)"\)\.(update|insert|upsert|delete)/.test(seg) && /rpc\("sign_off_onboarding_item"/.test(seg) && /rpc\("onboarding_signoff_queue"/.test(seg));
ok("approver config saved via set_onboarding_item_config; mark-ready via mark_onboarding_ready", /rpc\("set_onboarding_item_config"/.test(app) && /rpc\("mark_onboarding_ready", \{ p_item_id: itemId \}\)/.test(app));
ok("the document checkbox gates p_doc_checked = true", /disabled=\{!checked \|\| busy\} onClick=\{\(\) => go\(true\)\}/.test(seg));
const code = seg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");   // the code + UI strings, comments removed
ok("no upload control and no app-wide 'never store' claim in the new code", !/type="file"|capture|attach|camera|upload/i.test(code) && !/never stor|don't store any|we never/i.test(code));
process.exit(process.exitCode ?? 0);
