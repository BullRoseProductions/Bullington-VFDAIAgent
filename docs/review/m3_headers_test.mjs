// node docs/review/m3_headers_test.mjs — no network, no DB. Security review M-3 (headers + report-only CSP), vercel.json only:
//   1. one new "/(.*)" entry carries exactly X-Frame-Options DENY · nosniff · HSTS · Referrer-Policy · CSP-Report-Only;
//      there is NO enforcing Content-Security-Policy anywhere (enforcing stays a later step — Ashlea's call)
//   2. everything else in vercel.json (crons, rewrites, the existing header rules) is byte-for-byte what main has
//   3. the CSP's shape: script-src 'self' only (no unsafe-inline / unsafe-eval / wildcard), object-src / frame-src /
//      frame-ancestors 'none', base-uri + form-action 'self'
//   4. DERIVED FROM WHAT THE APP LOADS: every external origin literal in src/ + shared/ is either allowed in the directive
//      that loads it or classified as navigation-only (a link, never fetched); the Supabase project origin is the one
//      supabase-js talks to; the pdf.js worker is a same-origin Vite asset; no realtime channel (so no wss:)
//   5. verified 132/32/14, Notify held, only vercel.json + this test + the review record changed vs the base
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "9cd3762";   // main when this was drafted (industrial-noir-42)
const V = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const MAIN = JSON.parse(execSync(`git show ${BASE}:vercel.json`, { cwd: root }).toString());
const SUPABASE = "https://ifeptqnlucmvhlvadcpj.supabase.co";

// ---------------------------------------------------------------- 1. the header set
const all = V.headers.filter((h) => h.source === "/(.*)");
const H = Object.fromEntries((all[0]?.headers || []).map(({ key, value }) => [key, value]));
ok("one '/(.*)' rule, first in the list (applies to every path)", all.length === 1 && V.headers[0].source === "/(.*)");
ok("X-Frame-Options: DENY", H["X-Frame-Options"] === "DENY");
ok("X-Content-Type-Options: nosniff", H["X-Content-Type-Options"] === "nosniff");
ok("Strict-Transport-Security: max-age=63072000; includeSubDomains (Vercel already serves max-age=63072000; no preload)", H["Strict-Transport-Security"] === "max-age=63072000; includeSubDomains");
ok("Referrer-Policy: strict-origin-when-cross-origin", H["Referrer-Policy"] === "strict-origin-when-cross-origin");
ok("exactly those five keys", JSON.stringify(Object.keys(H).sort()) === JSON.stringify(["Content-Security-Policy-Report-Only", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options"]));
ok("NO enforcing Content-Security-Policy header anywhere in vercel.json", !V.headers.some((r) => r.headers.some((h) => h.key.toLowerCase() === "content-security-policy")));

// ---------------------------------------------------------------- 2. nothing else moved
const rest = { ...V, headers: V.headers.filter((h) => h.source !== "/(.*)") };
ok("crons, rewrites and every existing header rule are exactly main's", JSON.stringify(rest) === JSON.stringify(MAIN));

// ---------------------------------------------------------------- 3. the CSP's shape
const CSP = Object.fromEntries(H["Content-Security-Policy-Report-Only"].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
const has = (d, ...v) => v.every((x) => (CSP[d] || []).includes(x));
console.log("   CSP-Report-Only: " + H["Content-Security-Policy-Report-Only"]);
ok("default-src 'self'; script-src exactly 'self' (no 'unsafe-inline', no 'unsafe-eval', no wildcard, no host)", JSON.stringify(CSP["default-src"]) === `["'self'"]` && JSON.stringify(CSP["script-src"]) === `["'self'"]`);
ok("no wildcard source and no 'unsafe-eval' in any directive", !Object.values(CSP).flat().some((s) => s === "*" || /^\*\.|^https?:$|'unsafe-eval'/.test(s)));
ok("object-src, frame-src, frame-ancestors 'none'; base-uri, form-action, manifest-src 'self'",
  ["object-src", "frame-src", "frame-ancestors"].every((d) => JSON.stringify(CSP[d]) === `["'none'"]`) && ["base-uri", "form-action", "manifest-src"].every((d) => JSON.stringify(CSP[d]) === `["'self'"]`));
ok("style-src: 'self' 'unsafe-inline' (React style attributes + <style> blocks) + Google Fonts CSS", JSON.stringify(CSP["style-src"]) === JSON.stringify(["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]));

// ---------------------------------------------------------------- 4. derived from what the app loads
const files = [];
const walk = (d) => { for (const x of readdirSync(join(root, d))) { const p = join(d, x); if (statSync(join(root, p)).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(x) && !/\.test\./.test(x)) files.push(p); } };
walk("src"); walk("shared");
const src = files.map((p) => readFileSync(join(root, p), "utf8")).join("\n");
const origins = [...new Set([...src.matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)].map((m) => m[0]))].sort();
const NAV_ONLY = {   // links a person taps — top-level navigation, which CSP does not govern
  "https://b4thecall.com": "legal / policy links (href)", "https://maps.apple.com": "Directions link (mapsHref)", "https://maps.google.com": "Directions link (mapsHref)",
  "http://www.w3.org": "SVG/XML namespace strings, never fetched", "http://localhost": "dev-only comparison string", "https://x.test": "test fixture string",
};
const LOADED = { "https://fonts.googleapis.com": ["style-src"], "https://app.b4thecall.com": ["connect-src"] };
const unclassified = origins.filter((o) => !NAV_ONLY[o] && !LOADED[o]);
ok(`every external origin in src/ + shared/ is classified (${origins.length} found)`, unclassified.length === 0, JSON.stringify(unclassified));
ok("the loaded ones are allowed where they load: Google Fonts CSS in style-src, its font files in font-src, app.b4thecall.com (native API base) in connect-src",
  has("style-src", "https://fonts.googleapis.com") && has("font-src", "https://fonts.gstatic.com") && has("connect-src", "https://app.b4thecall.com") && /@import url\('https:\/\/fonts\.googleapis\.com\/css2/.test(src));
ok("the Supabase project origin (REST/auth/storage fetch + signed image URLs) is in connect-src and img-src", has("connect-src", "'self'", SUPABASE) && has("img-src", SUPABASE));
ok("no realtime channel in the client, so no wss: is allowed (add it if a .channel() ever lands)", !/supabase\.channel\(|\.channel\("/.test(src) && !Object.values(CSP).flat().some((s) => s.startsWith("wss:")));
ok("data:/blob: only where the app needs them — img (QR canvas, signatures, data-URI logos, mammoth images, object URLs), font (pdf.js embedded fonts), worker (pdf.js)",
  has("img-src", "data:", "blob:") && has("font-src", "data:") && has("worker-src", "'self'", "blob:") && !has("script-src", "data:") && !has("script-src", "blob:") && !has("connect-src", "data:"));
ok("the pdf.js worker is a same-origin Vite asset (?url import), so worker-src 'self' covers it", /import PDF_WORKER_URL from "pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url"/.test(src));
ok("index.html carries no inline <script> (script-src 'self' cannot break it)", !/<script(?![^>]*\bsrc=)[^>]*>/.test(readFileSync(join(root, "index.html"), "utf8")));

// ---------------------------------------------------------------- 5. fences
const vcount = (p) => (readFileSync(join(root, p), "utf8").match(/verified/gi) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", vcount("src/App.jsx") === 132 && vcount("api/digest.js") === 32 && vcount("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
// Pinned to the reviewed range (released as industrial-noir-43): base 9cd3762 .. reviewed e86c105 — "vs the base" would go red once later work lands.
const changed = execSync(`git diff --name-only ${BASE} e86c105`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const allowed = (p) => p === "vercel.json" || p === "docs/review/m3_headers_test.mjs" || /^claude\/B4C_M3_/.test(p);
ok(`only vercel.json + this test + the review record changed in the reviewed range ${BASE}..e86c105 — no client, no api/, no DB`, changed.every(allowed), JSON.stringify(changed.filter((p) => !allowed(p))));
