// node docs/review/csp_realtime_wss_test.mjs
// No network. CSP realtime slice (LD-5, gate ruling 2026-11-12). The enforced CSP blocked Live Data 1b's websocket on the
// web, so connect-src gains exactly `wss://ifeptqnlucmvhlvadcpj.supabase.co`. Native has no CSP and needs nothing.
// Checks:
//   1. vercel.json vs BASE (cdf1d37, Live Data 1b): the ONLY change is that one token inserted into connect-src. Every
//      other directive, header, cron and rewrite is identical.
//   2. today's enforced CSP: exactly one wss: origin anywhere, the project's, in connect-src only. No wss: wildcard,
//      no bare `wss:` scheme, and script-src is still 'self' only.
//   3. the token matches the realtime host supabase-js derives from the project URL (https -> wss, same host).
//   fences: only vercel.json + m3_headers_test + csp_enforce_test (comment) + the 1b test's fence pin + this test + the
//   build order changed vs BASE;
//   no src/ api/ sql/ shared/ native; verified 132/32/14; Notify held.
// Every run reports its exit code: a non-zero exit fails the run, however many PASS lines it printed.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "cdf1d37";   // Live Data 1b, gate PASS
const REV = process.env.REV ?? "";   // "" = working tree; pin to the passed sha on promotion
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");
const PROJECT = "ifeptqnlucmvhlvadcpj.supabase.co";
const TOKEN = `wss://${PROJECT}`;

const base = JSON.parse(show(BASE, "vercel.json")), cur = JSON.parse(show(REV, "vercel.json"));
const cspOf = (v) => v.headers.flatMap((b) => b.headers).find((h) => h.key === "Content-Security-Policy")?.value || "";
const parse = (val) => Object.fromEntries(val.split(";").map((d) => d.trim().split(/\s+/)).filter((a) => a[0]).map(([k, ...v]) => [k, v]));
const B = parse(cspOf(base)), C = parse(cspOf(cur));

// 1
const expectConnect = [...B["connect-src"]]; expectConnect.splice(expectConnect.indexOf(`https://${PROJECT}`) + 1, 0, TOKEN);
ok("1. connect-src = BASE's connect-src + exactly the project wss origin (inserted after its https origin)", JSON.stringify(C["connect-src"]) === JSON.stringify(expectConnect), JSON.stringify(C["connect-src"]));
ok("1. every other directive identical to BASE", Object.keys({ ...B, ...C }).filter((k) => k !== "connect-src").every((k) => JSON.stringify(B[k]) === JSON.stringify(C[k])));
const swap = (v) => JSON.stringify({ ...v, headers: v.headers.map((b) => ({ ...b, headers: b.headers.map((h) => h.key === "Content-Security-Policy" ? { ...h, value: "<csp>" } : h) })) });
ok("1. every other header, cron and rewrite identical to BASE", swap(base) === swap(cur) && JSON.stringify(base.crons) === JSON.stringify(cur.crons) && JSON.stringify(base.rewrites) === JSON.stringify(cur.rewrites));

// 2
const wss = Object.entries(C).flatMap(([d, v]) => v.filter((s) => /^wss:/i.test(s)).map((s) => `${d} ${s}`));
ok("2. exactly one wss: source anywhere: connect-src wss://<project>", JSON.stringify(wss) === JSON.stringify([`connect-src ${TOKEN}`]), JSON.stringify(wss));
ok("2. no wildcard / bare scheme / ws: in connect-src", !C["connect-src"].some((s) => s === "wss:" || s === "ws:" || /^wss?:\/\/\*/.test(s) || s === "*"));
ok("2. script-src still 'self' only", JSON.stringify(C["script-src"]) === JSON.stringify(["'self'"]));

// 3
const supaUrlUse = /createClient\(\s*supabaseUrl/.test(show(REV, "src/supabaseClient.js"));
ok("3. the token's host is the project host supabase-js connects to (https origin also allowed)", C["connect-src"].includes(`https://${PROJECT}`) && supaUrlUse);
ok("3. the client opens exactly one channel, private, in src/liveData.js", /supabase\.channel\(t, \{ config: \{ private: true \} \}\)/.test(show(REV, "src/liveData.js")));

// fences
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["docs/review/csp_enforce_test.mjs", "docs/review/csp_realtime_wss_BUILD_ORDER.md", "docs/review/csp_realtime_wss_test.mjs", "docs/review/live_data_1b_test.mjs", "docs/review/m3_headers_test.mjs", "vercel.json"];   // + 1b test fence pin (cdf1d37)
ok("fence: only vercel.json + the two CSP tests + the 1b fence pin + this test + the build order changed vs cdf1d37", files.every((f) => allowed.includes(f)) && files.includes("vercel.json"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("fence: no src/, api/, shared/, sql/, index.html, native, package changes", ["src", "api", "shared", "sql", "index.html", "ios", "android", "package.json", "package-lock.json"].every(untouched));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("fence: verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("fence: Notify held: api/notify-session.js absent; crons unchanged", !existsSync(join(root, "api/notify-session.js")) && JSON.stringify(base.crons) === JSON.stringify(cur.crons));
process.exit(process.exitCode || 0);
