// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/cert_expiry_malformed_test.mjs
// No network, no DB. The client half of the malformed-cert-expiry fix (claude/B4C_CertExpiry_MalformedDate_Fix_BuildOrder.md):
//   1. shared/expiry.js validExpYM: shape + month 01–12 + year >= 1900
//   2. the REAL certStatus / expPhrase (App.jsx bundled): "0000-00" (the live row), "2026-00", "2026-13", "1899-06" read NO DATE
//      (rank 3, muted) / "No expiration date" — never EXPIRED, never "undefined"; a real past month is still EXPIRED with its
//      month name; the current month EXPIRING; neverExpires still wins over a garbage date
//   3. coverage: a member whose only cert is "0000-00" counts UNDATED, not expired (same as a blank date)
//   4. the assistant's certStatus (api/assistant.js) agrees: "no date" for garbage, "expired" for a real past month
//   5. the source: no loose /^\d{4}-\d{2}$/ cert-exp test left in App.jsx / api/assistant.js; the three save validators and the
//      cert sort use validExpYM; verified count unchanged
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
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
const { validExpYM } = await import(pathToFileURL(join(root, "shared/expiry.js")).href);
const out = join(mkdtempSync(join(tmpdir(), "b4c-exp-")), "app.under-test.mjs");
await build({
  entryPoints: [join(root, "src/App.jsx")], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { certStatus, expPhrase, certCoverage };\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { certStatus, expPhrase, certCoverage } = await import(pathToFileURL(out).href);

const now = new Date();
const ym = (d) => { const x = new Date(now.getFullYear(), now.getMonth() + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; };
const GARBAGE = ["0000-00", "2026-00", "2026-13", "1899-06", "2026-1", "26-06", "2026-06-01", "", null, undefined, 202606];

// 1 the validator
ok("validExpYM accepts real months", ["2027-06", "1900-01", "2026-12", ym(-2), ym(0), ym(24)].every(validExpYM));
ok("validExpYM rejects month 00 / 13, year < 1900, bad shapes, non-strings", GARBAGE.every((g) => !validExpYM(g)));

// 2 certStatus / expPhrase
for (const g of ["0000-00", "2026-00", "2026-13", "1899-06"]) {
  const s = certStatus(g), p = expPhrase(g);
  ok(`"${g}" -> NO DATE rank 3 (muted) + "No expiration date"`, s.label === "NO DATE" && s.rank === 3 && s.color === certStatus(null).color && p === "No expiration date" && !/undefined|expired/i.test(p), `${s.label}/${s.rank} · ${p}`);
}
const past = ym(-2), pastMon = new Date(now.getFullYear(), now.getMonth() - 2, 1).toLocaleString("en-US", { month: "short" });
ok("a real past month is still EXPIRED (rank 0), phrased with its month", certStatus(past).label === "EXPIRED" && certStatus(past).rank === 0 && expPhrase(past) === `expired ${pastMon} ${past.slice(0, 4)}`, expPhrase(past));
ok("the current month is EXPIRING; far future CURRENT", certStatus(ym(0)).label === "EXPIRING" && certStatus(ym(24)).label === "CURRENT" && expPhrase(ym(0)) === "expires this month");
ok("neverExpires still wins over a garbage date", certStatus("0000-00", true).label === "NO EXPIRY" && certStatus("0000-00", true).rank === 2 && expPhrase("0000-00", true) === "Doesn't expire");

// 3 coverage: garbage counts as undated, not expired
const mk = (certs) => [{ id: "m1", name: "A", status: "Active", access: ["Member"], certs }, { id: "m2", name: "B", status: "Active", access: ["Member"], certs: [{ id: "c2", name: "FF II", exp: ym(24) }] }];
const covGarbage = certCoverage(mk([{ id: "c1", name: "Boaters Ed Cert", exp: "0000-00" }]), { includeProbationary: true });
const covBlank = certCoverage(mk([{ id: "c1", name: "Boaters Ed Cert", exp: null }]), { includeProbationary: true });
const covExpired = certCoverage(mk([{ id: "c1", name: "Boaters Ed Cert", exp: past }]), { includeProbationary: true });
const nums = (c) => JSON.stringify(Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === "number")));   // the counts, not the echoed rows
ok("coverage: a \"0000-00\" cert counts exactly like a blank date (undated), not like an expired one",
  nums(covGarbage) === nums(covBlank) && nums(covGarbage) !== nums(covExpired) && covGarbage.undatedCerts === 1, `garbage ${nums(covGarbage)} · expired ${nums(covExpired)}`);

// 4 the assistant
const asst = readFileSync(join(root, "api/assistant.js"), "utf8");
const fnSrc = asst.slice(asst.indexOf("export function certStatus("), asst.indexOf("\n}\n", asst.indexOf("export function certStatus(")) + 2);
const todayCT = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const aCertStatus = new Function("validExpYM", "todayCT", fnSrc.replace("export function", "return function"))(validExpYM, todayCT);
ok("assistant certStatus: garbage -> \"no date\"; a real past month -> \"expired\"", ["0000-00", "2026-13", "2026-00"].every((g) => aCertStatus(g) === "no date") && aCertStatus(past) === "expired" && aCertStatus(ym(24)) === "current");

// 5 the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
ok("no loose YYYY-MM cert-exp test left (App.jsx + api/assistant.js)", !/\^\\d\{4\}-\\d\{2\}\$/.test(src) && !/\^\\d\{4\}-\\d\{2\}\$/.test(asst));
ok("certStatus / expPhrase / the 3 save validators / the cert sort use validExpYM", (src.match(/validExpYM\(/g) || []).length === 6 && /import \{ EXPIRING_MONTHS, expiryBucket, BUCKET_RANK, validExpYM \} from "\.\.\/shared\/expiry\.js";/.test(src));
const main = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(main), `${tok(src)} vs ${tok(main)}`);
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
