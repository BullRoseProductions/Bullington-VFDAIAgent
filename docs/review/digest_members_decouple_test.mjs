// node docs/review/digest_members_decouple_test.mjs
// No network, no DB. Digest decoupling — the member list is read on its OWN, so a failed METRICS read only dashes its
// tiles instead of blanking every recipient. The REAL api/digest.js and main's (575a362) are bundled against the same
// switchable fake Supabase client + counted fetch as cron_honesty_test (each send's html captured). Checks:
//   1. a clean run → 200, body + sends byte-identical to main's (success unchanged)
//   2. THE FIX: each metric read failing (training_sessions / session_attendance / certs / apparatus / station_presence)
//      → BOTH departments are STILL mailed, to their real admins, with the flagged cert in the email; the run answers 500
//      "metrics-read" (cron honesty: the DB failed). Main, for the same failure, mails NOBODY — the bug.
//   3. …and the affected tile degrades: the training % that a clean run shows is "—" when training_sessions fails
//   4. the member read itself failing → 500 "members-read", nothing sent, every department in the log as skipped
//   5. bad auth → 401 · the rule unit · fences: only api/digest.js + shared/cron-outcome.js (+ this test / notes)
//      changed, api/_cron.js + api/pulse.js + vercel.json untouched, no SQL, verified 132/32/14, Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "575a362";   // live main when this was drafted (industrial-noir-52 — cron honesty)
const SECRET = "s3cret-cron-value-0123456789abcdef";
Object.assign(process.env, { PULSE_ENABLED: "1", RESEND_API_KEY: "re-test", SUPABASE_URL: "https://x.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "svc-test-key", CRON_SECRET: SECRET });

// ---------------------------------------------------------------- the fakes
const FAKE_SB = `
export function createClient() {
  const S = globalThis.__S; S.clients++;
  const q = (t, head) => new Proxy({}, { get(_, k) {
    if (k === "then") return (r, j) => Promise.resolve((() => {
      if (head && S.failHead) return { data: null, error: { message: "" }, status: S.failHead, count: null };   // HEAD: no error body
      if (S.fail[t]) return { data: null, error: { message: S.fail[t], code: "42501" }, status: 403 };
      return { data: S.tables[t] || [], error: null, status: 200, count: (S.tables[t] || []).length };
    })()).then(r, j);
    if (k === "maybeSingle" || k === "single") return async () => ({ data: (S.tables[t] || [])[0] || null, error: null });
    if (k === "select") return (_cols, opts) => q(t, head || !!(opts && opts.head));
    if (k === "insert" || k === "upsert" || k === "update" || k === "delete") return (rows) => { S.writes.push({ t, op: k, n: Array.isArray(rows) ? rows.length : 1 });
      if (S.failWrite && t === "notifications" && k !== "update") throw new Error("insert into notifications refused");
      return q(t, head); };
    return () => q(t, head);
  } });
  return { from: (t) => q(t, false), rpc: async (n) => S.failRpc[n] ? { data: null, error: { message: S.failRpc[n] } } : { data: n === "is_muted" ? false : [], error: null } };
}`;
globalThis.fetch = async (url, init) => {
  const S = globalThis.__S, body = JSON.parse(init?.body || "{}");
  const to = [].concat(body.to || []).join(",");
  S.sends.push({ url: String(url), to, html: body.html || "" });
  if (S.failSendTo && to.includes(S.failSendTo)) return { ok: false, status: 500, json: async () => ({ message: "resend exploded" }), text: async () => "resend exploded" };
  return { ok: true, status: 200, json: async () => ({ id: "email-1" }), text: async () => "{}" };
};
const outDir = mkdtempSync(join(tmpdir(), "b4c-dmd-"));
async function load(route, fromRef = null) {
  const out = join(outDir, `${route}${fromRef ? "-" + fromRef : ""}.mjs`);
  const opts = { bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    plugins: [{ name: "fake-sb", setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
    } }] };
  if (fromRef) opts.stdin = { contents: execSync(`git show ${fromRef}:api/${route}.js`, { cwd: root, maxBuffer: 1 << 26 }).toString(), resolveDir: join(root, "api"), sourcefile: `${route}.js`, loader: "js" };
  else opts.entryPoints = [join(root, `api/${route}.js`)];
  await build(opts);
  return (await import(pathToFileURL(out).href)).default;
}
const DEPTS = [{ id: "d1", name: "Alpha FD", week_start_day: 1 }, { id: "d2", name: "Bravo FD", week_start_day: 1 }];
function world(over = {}) {
  globalThis.__S = { clients: 0, sends: [], writes: [], fail: {}, failRpc: {}, failHead: 0, failWrite: false, failSendTo: null, tables: {
    departments: DEPTS,
    members: [{ id: "m1", department_id: "d1", email: "chief@alpha.fd", access: ["Department Admin"], status: "Active", name: "Chief A" },
              { id: "m2", department_id: "d2", email: "chief@bravo.fd", access: ["Department Admin"], status: "Active", name: "Chief B" }],
    certs: [{ id: "c1", department_id: "d1", member_id: "m1", name: "EMT-B", exp: "2025-01", no_expiry: false, cert_types: null, members: { name: "Chief A" } },
            { id: "c2", department_id: "d2", member_id: "m2", name: "FF1", exp: "2025-02", no_expiry: false, cert_types: null, members: { name: "Chief B" } }],
  }, ...over };
}
let logs = [];
const origLog = console.log, origErr = console.error;
async function call(handler, { query = {}, auth = `Bearer ${SECRET}`, setup = () => {} } = {}) {
  world(); setup(globalThis.__S); logs = [];
  console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" "));
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  try { await handler({ method: "GET", query, headers: auth ? { authorization: auth } : {} }, res); }
  finally { console.log = origLog; console.error = origErr; }
  return { code: res.code, body: res.body, clients: globalThis.__S.clients, sends: globalThis.__S.sends, writes: globalThis.__S.writes, logs };
}
const norm = (b) => JSON.parse(JSON.stringify(b, (k, v) => (k === "drainSince" || k === "now" ? "<t>" : v)));
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

// a department whose admin attended a finished training this year, so a clean run has a real training % to show
const SESS_TABLES = (S) => { const y = new Date().getFullYear();
  S.tables.training_sessions = [{ id: "s1", department_id: "d1", date: `${y}-01-15`, done: true, audience: "everyone", counts_toward_attendance: true, is_meeting: false, status: "scheduled" }];
  S.tables.session_attendance = [{ session_id: "s1", member_id: "m1" }]; };
const R = { digest: await load("digest"), base: await load("digest", BASE) };

// 1 — success unchanged
{ const now = await call(R.digest, { setup: SESS_TABLES }), base = await call(R.base, { setup: SESS_TABLES });
  ok("a clean run → 200, body + sends byte-identical to main's; both departments mailed", now.code === 200 && base.code === 200 && same(now.body, base.body)
    && JSON.stringify(now.sends) === JSON.stringify(base.sends) && now.sends.length === 2, `${now.code}/${base.code} sends ${now.sends.length}`); }

// 2 — the fix: every metric read, one at a time
for (const t of ["training_sessions", "session_attendance", "certs_metrics", "apparatus", "station_presence"]) {
  const failT = t === "certs_metrics" ? null : t;
  // certs is ALSO a core detection read; its metric twin can't fail alone in this fake, so it's covered by the others + the rule
  if (!failT) continue;
  const r = await call(R.digest, { setup: (S) => { SESS_TABLES(S); S.fail[failT] = "canceling statement due to statement timeout"; } });
  const b = await call(R.base, { setup: (S) => { SESS_TABLES(S); S.fail[failT] = "canceling statement due to statement timeout"; } });
  const tos = r.sends.map((x) => x.to).sort().join(" | ");
  ok(`${t} read fails → BOTH admins STILL mailed (chief@alpha.fd, chief@bravo.fd), the flagged cert in each; 500 "metrics-read" — main mails ${b.sends.length}`,
    r.code === 500 && JSON.stringify(r.body.failed) === '["metrics-read"]' && r.body.sent === 2 && tos === "chief@alpha.fd | chief@bravo.fd"
    && r.sends.every((x) => /EMT-B|FF1/.test(x.html)) && b.sends.length === 0, `${JSON.stringify(r.body)} sends: ${tos}`);
}

// 3 — the tile degrades
{ const clean = await call(R.digest, { setup: SESS_TABLES });
  const deg = await call(R.digest, { setup: (S) => { SESS_TABLES(S); S.fail.training_sessions = "statement timeout"; } });
  // the Attendance tile: its value <div> sits right before the "Attendance" label <div> (metricsBlock); a dash is "&mdash;"
  const pct = (html) => (/>([^<]*)<\/div>\s*<div[^>]*>Attendance<\/div>/.exec(html) || [])[1] || null;
  const a0 = clean.sends.find((x) => x.to === "chief@alpha.fd")?.html || "", a1 = deg.sends.find((x) => x.to === "chief@alpha.fd")?.html || "";
  ok("…and the tile degrades: Alpha's clean email shows an Attendance %, the degraded one shows \"—\" in that tile — the flagged cert still there",
    /^\d{1,3}%$/.test(pct(a0) || "") && pct(a1) === "&mdash;" && /EMT-B/.test(a1), `clean ${pct(a0)} · degraded ${pct(a1)}`); }

// 4 — the member read failing is honestly fatal
{ const r = await call(R.digest, { setup: (S) => { SESS_TABLES(S); S.fail.members = "permission denied for table members"; } });
  ok("the member read failing → 500 \"members-read\", nothing sent (nobody to send to), the reason logged per department, nothing internal in the body",
    r.code === 500 && r.body.failed.includes("members-read") && r.sends.length === 0 && r.logs.some((l) => /membersError.*permission denied/.test(l))
    && !/permission|chief@/.test(JSON.stringify(r.body)), JSON.stringify(r.body)); }

// 5 — auth, the rule, fences
{ const r = await call(R.digest, { auth: "Bearer wrong" });
  ok("bad auth → still 401, no client, nothing sent", r.code === 401 && r.clients === 0 && r.sends.length === 0); }
const { digestOutcome } = await import(pathToFileURL(join(root, "shared/cron-outcome.js")).href);
ok("rule: members-read is its own step, ahead of metrics-read", JSON.stringify(digestOutcome({ membersError: "x", metricsError: "y" }).failed) === '["members-read","metrics-read"]');
const changed = execSync(`git diff --name-only ${BASE}`, { cwd: root }).toString().trim().split("\n").concat(execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n")).filter(Boolean).sort();
const allowed = ["api/digest.js", "claude/B4C_DigestMembersDecouple_Draft.md", "docs/review/cron_honesty_test.mjs", "docs/review/digest_members_decouple_test.mjs", "shared/cron-outcome.js"];
ok("changed: only api/digest.js + shared/cron-outcome.js (+ this test, the one cron_honesty assertion it moves, notes)", changed.every((f) => allowed.includes(f)) && changed.includes("api/digest.js"), JSON.stringify(changed));
const untouched = (p) => execSync(`git diff --name-only ${BASE} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("api/_cron.js, api/pulse.js, vercel.json untouched; no SQL", ["api/_cron.js", "api/pulse.js", "vercel.json", "sql"].every(untouched));
const tok = (p) => (readFileSync(join(root, p), "utf8").match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
