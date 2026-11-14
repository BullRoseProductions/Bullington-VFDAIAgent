// node docs/review/digest_library_line_test.mjs ; echo "exit $?"
// No network, no DB. Library S3 (Weekly Training Content slice 3; docs/design/training_content_step0.md §4, gate PASS
// @2a0768c, ruling R4 @4cfe29f): the weekly digest gains ONE line, "New in the B4C library this week: … (+N more) — add
// them from Training → Library." The REAL api/digest.js and BASE's are bundled against the same switchable fake Supabase
// client + counted fetch as digest_members_decouple_test (each send's html captured). Checks:
//   1. nothing published this week → 200, body + sends byte-identical to BASE's (a quiet library changes nothing)
//   2. drills published in the week → every mailed department gets the line: the two newest titles, "(+N more)", the
//      Training → Library pointer; titles HTML-escaped; a drill outside the week, a submitted one and a withdrawn one are
//      never named; subject + headline unchanged; ONE library_drills read for the whole run, titles/state/date only
//   3. NOT A FLAG (R4): a week with nothing flagged + new drills → nobody is mailed (same as BASE)
//   4. the library read failing → every email still goes (without the line), the run answers 500 "library-read", the DB
//      message is logged and never in the body
//   5. the pure helpers + the rule unit · fences: only api/digest.js + shared/cron-outcome.js (+ this test + the build
//      order) changed vs BASE; api/_cron.js, api/pulse.js, vercel.json, src/, sql/ untouched; verified 132/32/14; Notify held
// Every run reports its exit code: a non-zero exit fails the run, however many PASS lines it printed.
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "4176cba";                  // main 8dbb398 (Library S2 UI, gate PASS) + its test-fence pin
const REV = process.env.REV ?? "";       // "" = working tree; pin to the passed sha on promotion
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");
const SECRET = "s3cret-cron-value-0123456789abcdef";
Object.assign(process.env, { PULSE_ENABLED: "1", RESEND_API_KEY: "re-test", SUPABASE_URL: "https://x.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "svc-test-key", CRON_SECRET: SECRET });

// ---------------------------------------------------------------- the fakes (digest_members_decouple_test's, + a read log)
const FAKE_SB = `
export function createClient() {
  const S = globalThis.__S; S.clients++;
  const q = (t, head, cols) => new Proxy({}, { get(_, k) {
    if (k === "then") return (r, j) => Promise.resolve((() => {
      S.reads.push({ t, cols });
      if (head && S.failHead) return { data: null, error: { message: "" }, status: S.failHead, count: null };
      if (S.fail[t]) return { data: null, error: { message: S.fail[t], code: "42501" }, status: 403 };
      return { data: S.tables[t] || [], error: null, status: 200, count: (S.tables[t] || []).length };
    })()).then(r, j);
    if (k === "maybeSingle" || k === "single") return async () => ({ data: (S.tables[t] || [])[0] || null, error: null });
    if (k === "select") return (c, opts) => q(t, head || !!(opts && opts.head), c);
    if (k === "insert" || k === "upsert" || k === "update" || k === "delete") return (rows) => { S.writes.push({ t, op: k, n: Array.isArray(rows) ? rows.length : 1 }); return q(t, head, cols); };
    return () => q(t, head, cols);
  } });
  return { from: (t) => q(t, false, null), rpc: async (n) => S.failRpc[n] ? { data: null, error: { message: S.failRpc[n] } } : { data: n === "is_muted" ? false : [], error: null } };
}`;
globalThis.fetch = async (url, init) => {
  const S = globalThis.__S, body = JSON.parse(init?.body || "{}");
  S.sends.push({ url: String(url), to: [].concat(body.to || []).join(","), subject: body.subject || "", html: body.html || "" });
  return { ok: true, status: 200, json: async () => ({ id: "email-1" }), text: async () => "{}" };
};
const outDir = mkdtempSync(join(tmpdir(), "b4c-dlib-"));
async function load(fromRef = null) {
  const out = join(outDir, `digest${fromRef ? "-" + fromRef : ""}.mjs`);
  const opts = { bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    plugins: [{ name: "fake-sb", setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
    } }] };
  if (fromRef) opts.stdin = { contents: execSync(`git show ${fromRef}:api/digest.js`, { cwd: root, maxBuffer: 1 << 26 }).toString(), resolveDir: join(root, "api"), sourcefile: "digest.js", loader: "js" };
  else opts.entryPoints = [join(root, "api/digest.js")];
  await build(opts);
  return await import(pathToFileURL(out).href);
}
const DEPTS = [{ id: "d1", name: "Alpha FD", week_start_day: 1 }, { id: "d2", name: "Bravo FD", week_start_day: 1 }];
function world() {
  globalThis.__S = { clients: 0, sends: [], writes: [], reads: [], fail: {}, failRpc: {}, failHead: 0, tables: {
    departments: DEPTS,
    members: [{ id: "m1", department_id: "d1", email: "chief@alpha.fd", access: ["Department Admin"], status: "Active", name: "Chief A" },
              { id: "m2", department_id: "d2", email: "chief@bravo.fd", access: ["Department Admin"], status: "Active", name: "Chief B" }],
    certs: [{ id: "c1", department_id: "d1", member_id: "m1", name: "EMT-B", exp: "2025-01", no_expiry: false, cert_types: null, members: { name: "Chief A" } },
            { id: "c2", department_id: "d2", member_id: "m2", name: "FF1", exp: "2025-02", no_expiry: false, cert_types: null, members: { name: "Chief B" } }],
  } };
}
let logs = [];
const origLog = console.log, origErr = console.error;
async function call(handler, { query = {}, setup = () => {} } = {}) {
  world(); setup(globalThis.__S); logs = [];
  console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" "));
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  try { await handler({ method: "GET", query, headers: { authorization: `Bearer ${SECRET}` } }, res); }
  finally { console.log = origLog; console.error = origErr; }
  return { code: res.code, body: res.body, sends: globalThis.__S.sends, reads: globalThis.__S.reads, writes: globalThis.__S.writes, logs };
}
const norm = (b) => JSON.parse(JSON.stringify(b, (k, v) => (k === "drainSince" || k === "now" ? "<t>" : v)));
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

// The digest's own week is [last Monday-before-last 00:00, last Monday 00:00) Central. now − 7 days is always inside it
// (weekEnd ≤ now < weekEnd + 7d), so in-week fixtures sit a few ms after that; the out-of-week one is 30 days back.
const t0 = Date.now() - 7 * 86400000;
const at = (ms) => new Date(t0 + ms).toISOString();
const LIB = [
  { title: "Mayday Operations", state: "published", published_at: at(3) },
  { title: "Tanker <Shuttle> & Co", state: "published", published_at: at(2) },
  { title: "Stroke Recognition", state: "published", published_at: at(1) },
  { title: "Old Ladder Drill", state: "published", published_at: new Date(Date.now() - 30 * 86400000).toISOString() },
  { title: "Draft In Queue", state: "submitted", published_at: null },
  { title: "Pulled Back", state: "withdrawn", published_at: at(4) },
];
const withLib = (S) => { S.tables.library_drills = LIB; };
const mod = await load(), base = await load(BASE);
const H = mod.default, HB = base.default;
const lineOf = (html) => (/New in the B4C library this week:[^<]*/.exec(html) || [""])[0];

// 1 — a quiet library changes nothing
{ const now = await call(H), b = await call(HB);
  ok("1. nothing published this week → 200, body + sends byte-identical to BASE's", now.code === 200 && b.code === 200 && same(now.body, b.body) && JSON.stringify(now.sends) === JSON.stringify(b.sends) && now.sends.length === 2,
    `${now.code}/${b.code} sends ${now.sends.length}`); }

// 2 — the line
{ const r = await call(H, { setup: withLib }), b = await call(HB, { setup: withLib });
  const lines = r.sends.map((s) => lineOf(s.html));
  ok("2. 200; both departments mailed, each with the same line", r.code === 200 && r.sends.length === 2 && lines[0] && lines[0] === lines[1], JSON.stringify(lines));
  ok("2. the two newest titles + \"(+1 more)\" + the Training → Library pointer; titles escaped",
    lines[0] === "New in the B4C library this week: Mayday Operations, Tanker &lt;Shuttle&gt; &amp; Co (+1 more) &mdash; add them from Training &rarr; Library.", lines[0]);
  const all = r.sends.map((s) => s.html).join("");
  ok("2. never named: the out-of-week, the submitted and the withdrawn drill", !/Old Ladder Drill|Draft In Queue|Pulled Back/.test(all));
  ok("2. subject unchanged vs BASE (the line is not an item that needs attention)", JSON.stringify(r.sends.map((s) => s.subject)) === JSON.stringify(b.sends.map((s) => s.subject)));
  ok("2. the flagged certs are still in each email", /EMT-B/.test(r.sends.find((s) => s.to === "chief@alpha.fd").html) && /FF1/.test(r.sends.find((s) => s.to === "chief@bravo.fd").html));
  const lr = r.reads.filter((x) => x.t === "library_drills");
  ok("2. ONE library_drills read for the whole run, titles/state/published_at only (never content, never origin_department_id)", lr.length === 1 && lr[0].cols === "title, state, published_at", JSON.stringify(lr));
  ok("2. no writes for the line (no notification rows for content)", JSON.stringify(r.writes) === JSON.stringify(b.writes)); }

// 3 — not a flag
{ const quiet = (S) => { withLib(S); S.tables.certs = []; };
  const r = await call(H, { setup: quiet }), b = await call(HB, { setup: quiet });
  ok("3. NOT A FLAG (R4): nothing flagged + new drills → nobody mailed, same as BASE", r.code === 200 && r.sends.length === 0 && b.sends.length === 0 && same(r.body, b.body), `${r.sends.length}/${b.sends.length}`); }

// 4 — a failed library read is honest and degrades
{ const r = await call(H, { setup: (S) => { withLib(S); S.fail.library_drills = "permission denied for table library_drills"; } });
  ok("4. library read fails → 500 \"library-read\", both admins STILL mailed, without the line", r.code === 500 && JSON.stringify(r.body.failed) === '["library-read"]' && r.body.sent === 2 && r.sends.length === 2 && r.sends.every((s) => !lineOf(s.html)), JSON.stringify(r.body));
  ok("4. the DB message is in the log, never in the body", r.logs.some((l) => /libraryError.*permission denied/.test(l)) && !/permission|chief@/.test(JSON.stringify(r.body))); }

// 5 — helpers, the rule, fences
{ const wk = { weekStart: new Date("2026-11-02T06:00:00Z"), weekEnd: new Date("2026-11-09T06:00:00Z") };
  const t = mod.newLibraryTitles([{ title: " A ", state: "published", published_at: "2026-11-03T00:00:00Z" }, { title: "a", state: "published", published_at: "2026-11-02T07:00:00Z" },
    { title: "Edge", state: "published", published_at: "2026-11-09T06:00:00Z" }, { title: "Start", state: "published", published_at: "2026-11-02T06:00:00Z" }, { title: "", state: "published", published_at: "2026-11-04T00:00:00Z" }], wk);
  ok("5. newLibraryTitles: [start, end) window, newest first, trimmed, case-insensitively de-duplicated, blanks dropped", JSON.stringify(t) === '["A","Start"]', JSON.stringify(t));
  ok("5. libraryBlock: empty → nothing; one → \"add it\"; three → two shown + (+1 more)", mod.libraryBlock([]) === "" && mod.libraryBlock(null) === ""
    && /this week: Solo &mdash; add it from/.test(mod.libraryBlock(["Solo"])) && /A, B \(\+1 more\) &mdash; add them/.test(mod.libraryBlock(["A", "B", "C"]))); }
const { digestOutcome } = await import(pathToFileURL(join(root, "shared/cron-outcome.js")).href);
ok("5. rule: library-read is its own step, after the degraded reads; a clean run is unchanged", JSON.stringify(digestOutcome({ metricsError: "x", libraryError: "y" }).failed) === '["metrics-read","library-read"]'
  && JSON.stringify(digestOutcome({ results: [{ name: "A", sentTo: ["a"] }] })) === '{"status":200,"failed":[],"sent":1,"notSent":[]}');
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["api/digest.js", "docs/review/digest_library_line_BUILD_ORDER.md", "docs/review/digest_library_line_test.mjs", "shared/cron-outcome.js"];
ok("5. fence: only api/digest.js + shared/cron-outcome.js + this test + the build order changed vs BASE", files.every((f) => allowed.includes(f)) && files.includes("api/digest.js"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("5. fence: api/_cron.js, api/pulse.js, vercel.json, src/, sql/, native, packages untouched", ["api/_cron.js", "api/pulse.js", "vercel.json", "src", "sql", "ios", "android", "package.json", "package-lock.json"].every(untouched));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("5. verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("5. Notify held: api/notify-session.js absent; SEND_WHEN_NOTHING_FLAGGED still false", !existsSync(join(root, "api/notify-session.js")) && /const SEND_WHEN_NOTHING_FLAGGED = false;/.test(show(REV, "api/digest.js")));
process.exit(process.exitCode || 0);
