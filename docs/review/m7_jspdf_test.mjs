// node docs/review/m7_jspdf_test.mjs                       (M7_OLD_ROOT=<a checkout of main with its own node_modules> adds the old-vs-new check)
// No network, no DB. Security review M-7 — jspdf 2.5.2 → 4.2.1 (+ jspdf-autotable 3.8.4 → 5.0.9), client only. Checks:
//   1. versions: package.json pins jspdf 4.2.1 + jspdf-autotable 5.0.9 EXACTLY; lockfile + node_modules agree; autotable's
//      peer range admits jspdf 4
//   2. DOMPurify: exactly ONE copy in the tree — our own 3.4.17 (jspdf 4's optional dompurify dep dedupes onto it); the 2.5.9
//      that rode inside jspdf 2.x is gone from node_modules AND the lockfile
//   3. THE BREAK THIS SLICE FIXES, proven: under autotable 5 a bundled `import "jspdf-autotable"` leaves doc.autoTable
//      undefined (it only patches a global window.jsPDF); the functional autoTable(doc, …) draws and sets doc.lastAutoTable
//   4. call sites: exactly 6 `new jsPDF(` (printPdf.js 1, report.js 5), exactly 6 `autoTable(doc, {` — no `doc.autoTable(`,
//      no side-effect import left
//   5. EVERY export rendered for real (docs/review/m7_jspdf_render.mjs, the browser build): Chief's Report, Capital Plan,
//      Apparatus Check, Fleet Check, Station Hours, native print sheet — each a valid PDF with the expected page count,
//      "Page N of M" footers, and its table cells present; Producer jsPDF 4.2.1
//   6. (M7_OLD_ROOT) each PDF byte-identical to main's (jspdf 2.5.2 / autotable 3.8.4) once Producer / CreationDate / ID
//      are normalised
//   7. fences: only package.json, the lockfile, src/report.js, src/printPdf.js (+ this slice's review files) changed vs the
//      base; no api / shared / sql / vercel.json; verified 132/32/14; Notify held
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "7e1addc";   // main when this was drafted (industrial-noir-44)
const rd = (p) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(rd("package.json")), lock = JSON.parse(rd("package-lock.json"));
const ver = (p) => JSON.parse(rd(`node_modules/${p}/package.json`)).version;

// ---------------------------------------------------------------- 1. versions
ok("package.json pins jspdf 4.2.1 and jspdf-autotable 5.0.9 exactly (no ^ / ~)", pkg.dependencies.jspdf === "4.2.1" && pkg.dependencies["jspdf-autotable"] === "5.0.9");
ok("lockfile + node_modules agree: jspdf 4.2.1, jspdf-autotable 5.0.9",
  lock.packages["node_modules/jspdf"].version === "4.2.1" && lock.packages["node_modules/jspdf-autotable"].version === "5.0.9" && ver("jspdf") === "4.2.1" && ver("jspdf-autotable") === "5.0.9");
ok("jspdf-autotable 5.0.9's peer range admits jspdf 4", /\^4/.test(JSON.parse(rd("node_modules/jspdf-autotable/package.json")).peerDependencies.jspdf));

// ---------------------------------------------------------------- 2. DOMPurify
const lsJson = JSON.parse(spawnSync("npm", ["ls", "dompurify", "--all", "--json"], { cwd: root, encoding: "utf8" }).stdout || "{}");
const seen = []; (function walk(n) { for (const [k, v] of Object.entries(n.dependencies || {})) { if (k === "dompurify") seen.push(v.version); walk(v); } })(lsJson);
ok("npm ls dompurify: every occurrence is 3.4.17 (ours; jspdf's optional dep deduped onto it)", seen.length >= 1 && seen.every((v) => v === "3.4.17"), JSON.stringify(seen));
const lockDp = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/dompurify$/.test(k)).map(([k, v]) => `${k}@${v.version}`);
ok("lockfile: exactly one dompurify (node_modules/dompurify@3.4.17) — jspdf's nested 2.5.9 is gone", JSON.stringify(lockDp) === JSON.stringify(["node_modules/dompurify@3.4.17"]), JSON.stringify(lockDp));
ok("no dompurify 2.x anywhere under node_modules", !existsSync(join(root, "node_modules/jspdf/node_modules/dompurify")) && ver("dompurify") === "3.4.17");

// ---------------------------------------------------------------- 3. the break, proven
const tmp = mkdtempSync(join(tmpdir(), "m7t-"));
async function probe(code) {
  const entry = join(root, `.m7-probe-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);   // inside root so bare imports resolve to its node_modules
  writeFileSync(entry, code);
  const out = join(tmp, `p${Math.random().toString(36).slice(2)}.mjs`);
  try { await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", outfile: out, logLevel: "error" }); }
  finally { execSync(`rm -f ${JSON.stringify(entry)}`); }
  return (await import(pathToFileURL(out).href)).default;
}
const sideEffect = await probe(`import { jsPDF } from "jspdf"; import "jspdf-autotable"; export default typeof new jsPDF().autoTable;`);
ok("autotable 5: the OLD side-effect import leaves doc.autoTable undefined in a bundle (why every call site had to change)", sideEffect === "undefined", sideEffect);
const fn = await probe(`import { jsPDF } from "jspdf"; import { autoTable } from "jspdf-autotable";
  const d = new jsPDF({ unit: "pt", format: "letter" }); autoTable(d, { head: [["A", "B"]], body: [["1", "2"], ["3", "4"]], startY: 40 });
  export default { finalY: d.lastAutoTable && d.lastAutoTable.finalY, pages: d.getNumberOfPages() };`);
ok("autotable 5: autoTable(doc, …) draws and sets doc.lastAutoTable.finalY (every call site reads it)", typeof fn.finalY === "number" && fn.finalY > 40 && fn.pages === 1, JSON.stringify(fn));

// ---------------------------------------------------------------- 4. call sites
const srcFiles = execSync("git ls-files src shared", { cwd: root }).toString().trim().split("\n").filter((f) => /\.(js|jsx|mjs)$/.test(f));
const count = (re) => Object.fromEntries(srcFiles.map((f) => [f, (rd(f).match(re) || []).length]).filter(([, n]) => n));
ok("exactly 6 `new jsPDF(` sites: src/printPdf.js 1, src/report.js 5", JSON.stringify(count(/new jsPDF\(/g)) === JSON.stringify({ "src/printPdf.js": 1, "src/report.js": 5 }), JSON.stringify(count(/new jsPDF\(/g)));
ok("exactly 6 `autoTable(doc, {` calls, same files", JSON.stringify(count(/(?<![.\w])autoTable\(doc, \{/g)) === JSON.stringify({ "src/printPdf.js": 1, "src/report.js": 5 }));
ok("no `doc.autoTable(` and no side-effect `import \"jspdf-autotable\"` left in src/shared",
  Object.keys(count(/doc\.autoTable\(/g)).length === 0 && Object.keys(count(/^import "jspdf-autotable";/gm)).length === 0);
ok("both files import the named autoTable", ["src/printPdf.js", "src/report.js"].every((f) => rd(f).includes('import { autoTable } from "jspdf-autotable";')));

// ---------------------------------------------------------------- 5. every export rendered
const outNew = mkdtempSync(join(tmpdir(), "m7new-"));
const r = spawnSync("node", [join(root, "docs/review/m7_jspdf_render.mjs"), root, outNew], { encoding: "utf8" });
const man = JSON.parse(readFileSync(join(outNew, "manifest.json"), "utf8"));
const EXPECT = {
  "chiefs-report": { pages: 4, text: ["Mock County Volunteer Fire Department", "Certifications \\u2014 Action Items", "Hazmat Operations", "Nico Bell", "Station Hours \\u2014 ISO/LOSAP", "Page 4 of 4"] },
  "capital-plan": { pages: 1, text: ["Replacement Forecast", "Tanker 4", "$610,000 (projected)", "Not Yet Planned", "Page 1 of 1"] },
  "apparatus-check": { pages: 1, text: ["Engine 1", "Tires / pressure", "Left rear inner tire at 60 psi", "Certification", "Page 1 of 1"] },
  "fleet-check": { pages: 3, text: ["Fleet summary", "Tanker 4", "Brush 3", "Lights & sirens", "Page 3 of 3"] },
  "station-hours": { pages: 5, text: ["Roster summary", "Avery Cole", "Officer check-in", "Page 5 of 5"] },
  "print-sheet": { pages: 1, text: ["Water Supply", "PURPOSE", "Tanker 4", "Page 1 of 1"] },
};
for (const [name, e] of Object.entries(EXPECT)) {
  const m = man[name];
  if (!m?.ok) { ok(`render: ${name}`, false, m?.error || r.stderr.slice(0, 200)); continue; }
  const raw = readFileSync(join(outNew, `${name}.pdf`)).toString("latin1");
  const pages = (raw.match(/\/Type \/Page\b/g) || []).length;
  const unesc = raw.replace(/\\\(/g, "(").replace(/\\\)/g, ")");
  // jsPDF writes text uncompressed as (…) Tj with non-ASCII as escapes — check the ASCII-safe fragments of each string
  const missing = e.text.map((t) => JSON.parse(`"${t}"`)).filter((t) => !t.split(/[—–]/).map((s) => s.trim()).filter(Boolean).every((frag) => unesc.includes(frag)));
  ok(`render: ${name} — valid PDF, ${e.pages} page(s), footers + table cells present, Producer jsPDF 4.2.1`,
    raw.startsWith("%PDF-") && /%%EOF\s*$/.test(raw) && pages === e.pages && missing.length === 0 && raw.includes("/Producer (jsPDF 4.2.1)"),
    `${m.bytes} bytes · ${pages} pages${missing.length ? " · missing " + JSON.stringify(missing) : ""}`);
}

// ---------------------------------------------------------------- 6. old vs new (optional)
if (process.env.M7_OLD_ROOT) {
  const outOld = mkdtempSync(join(tmpdir(), "m7old-"));
  spawnSync("node", [join(root, "docs/review/m7_jspdf_render.mjs"), process.env.M7_OLD_ROOT, outOld], { encoding: "utf8" });
  const norm = (p) => readFileSync(p).toString("latin1").replace(/\/Producer \([^)]*\)/g, "").replace(/\/CreationDate \([^)]*\)/g, "").replace(/\/ID \[[^\]]*\]/g, "");
  const oldProd = readFileSync(join(outOld, "chiefs-report.pdf")).toString("latin1").match(/\/Producer \(([^)]*)\)/)?.[1];
  const diff = Object.keys(EXPECT).filter((n) => norm(join(outOld, `${n}.pdf`)) !== norm(join(outNew, `${n}.pdf`)));
  ok(`old (${oldProd}) vs new (jsPDF 4.2.1): all 6 PDFs byte-identical once Producer / CreationDate / ID are normalised`, oldProd && oldProd !== "jsPDF 4.2.1" && diff.length === 0, JSON.stringify(diff));
} else console.log("SKIP  old-vs-new byte comparison (set M7_OLD_ROOT to a main checkout with its node_modules)");

// ---------------------------------------------------------------- 7. fences
// Pinned to the reviewed range (released as industrial-noir-45): base 7e1addc .. reviewed 0a87254 — "vs the base" would go red once later work lands.
const changed = execSync(`git diff --name-only ${BASE} 0a87254`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
// + two older review tests whose bare window stub lacked atob/btoa, which jspdf 4's node build binds at import (test-only)
const allowed = (p) => ["package.json", "package-lock.json", "src/report.js", "src/printPdf.js", "docs/review/scorecard_ui_test.mjs", "docs/review/onboarding_item_config_ui_test.mjs"].includes(p) || /^docs\/review\/m7_/.test(p) || /^claude\/B4C_M7_/.test(p);
ok(`only package.json + lockfile + src/report.js + src/printPdf.js (+ M-7 review files) changed in the reviewed range ${BASE}..0a87254 — no api / shared / sql / vercel.json`, changed.every(allowed), JSON.stringify(changed.filter((p) => !allowed(p))));
const tok = (p) => (rd(p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
