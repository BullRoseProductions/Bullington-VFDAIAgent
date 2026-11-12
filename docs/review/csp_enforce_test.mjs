// node docs/review/csp_enforce_test.mjs
// No network. CSP enforce (M-3 tail) — vercel.json's Content-Security-Policy-Report-Only becomes Content-Security-Policy with
// the SAME value; nothing else in vercel.json moves. Checks:
//   1. exactly one CSP header, enforced; no Report-Only copy left
//   2. its value is byte-identical to BASE's Report-Only value; script-src has no 'unsafe-inline' / 'unsafe-eval'
//   3. every other header block, the crons and the rewrites are identical to BASE
//   4. index.html (the source Vite builds from) has no inline <script> — an inline boot script would die under script-src 'self'
//   fences: only vercel.json (+ this test, the note) changed; no src / api / sql; verified 132/32/14; Notify held
// LATER (2026-11-12, csp_realtime_wss slice): the enforced value gained exactly `wss://ifeptqnlucmvhlvadcpj.supabase.co` in
// connect-src for Live Data 1b. This test stays PINNED to d377999..b6bb821 (the enforce step itself); the wss addition is
// guarded by docs/review/csp_realtime_wss_test.mjs and m3_headers_test §4.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "d377999";   // live main when this was drafted (industrial-noir-54)
// Structural fences PINNED to the reviewed range: base d377999 .. reviewed b6bb821 — "vs the working tree" would go red once
// later work lands. REV=<sha> (or REV="" for the working tree) overrides.
const REV = process.env.REV ?? "b6bb821";
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");
const base = JSON.parse(show(BASE, "vercel.json")), cur = JSON.parse(show(REV, "vercel.json"));
const all = (v) => v.headers.flatMap((b) => b.headers.map((h) => ({ src: b.source, ...h })));
const csp = all(cur).filter((h) => /^Content-Security-Policy/i.test(h.key));
const baseCsp = all(base).find((h) => h.key === "Content-Security-Policy-Report-Only");

ok("exactly one CSP header, enforced (Content-Security-Policy), on /(.*)", csp.length === 1 && csp[0].key === "Content-Security-Policy" && csp[0].src === "/(.*)", JSON.stringify(csp.map((h) => h.key)));
ok("no Report-Only copy left", !all(cur).some((h) => /Report-Only/i.test(h.key)));
ok("value byte-identical to the Report-Only value at BASE", !!baseCsp && csp[0]?.value === baseCsp.value);
const scriptSrc = (csp[0]?.value.match(/(?:^|;)\s*script-src([^;]*)/) || [])[1] || "";
ok("script-src is 'self' only — no 'unsafe-inline', no 'unsafe-eval'", scriptSrc.trim() === "'self'", scriptSrc.trim());
ok("frame-src 'none', object-src 'none', frame-ancestors 'none' kept", /frame-src 'none'/.test(csp[0]?.value) && /object-src 'none'/.test(csp[0]?.value) && /frame-ancestors 'none'/.test(csp[0]?.value));
const norm = (v) => JSON.stringify({ ...v, headers: v.headers.map((b) => ({ ...b, headers: b.headers.map((h) => h.key === "Content-Security-Policy-Report-Only" ? { ...h, key: "Content-Security-Policy" } : h) })) });
ok("everything else in vercel.json identical (other headers, crons, rewrites)", norm(base) === JSON.stringify(cur) && JSON.stringify(base.crons) === JSON.stringify(cur.crons));
const html = show(REV, "index.html");
const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc=/.test(m[1]) || m[2].trim());
ok("index.html: no inline <script> (only src= scripts)", inline.length === 0, `inline=${inline.length}`);

// fences
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["claude/B4C_CSP_Enforce_Draft.md", "docs/review/csp_enforce_test.mjs", "vercel.json"];
ok("changed: only vercel.json (+ this test, the note)", files.every((f) => allowed.includes(f)) && files.includes("vercel.json"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("no src/, api/, shared/, sql/, index.html, native changes", ["src", "api", "shared", "sql", "index.html", "ios", "android", "public"].every(untouched));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
