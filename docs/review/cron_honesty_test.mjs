// node docs/review/cron_honesty_test.mjs
// No network, no DB. Cron honesty — a scheduled run whose WORK failed answers 5xx, never 200. The REAL api/pulse.js and
// api/digest.js are bundled with esbuild (and, for the "success is unchanged" proof, origin/main's versions of the same
// two files) against a fake Supabase client whose failures are switchable per table / per probe / per RPC; global fetch
// is stubbed so every Resend send is counted and can be made to fail. console output is captured. Checks:
//   1. pulse: a clean run → 200 with a body + DB writes byte-identical to main's · the probe unreachable (HEAD, status 401,
//      EMPTY message — the live 2026-10-17+ signature) → 503 { ok:false, failed:["db"] }, the status in the LOG, nothing
//      internal in the body · a detection read failing → 500 "detect:<family>" · the write failing → 500 "write" ·
//      bad / no auth → still 401 with no client · PULSE_ENABLED off → the same 200 as before
//   2. digest: a clean run → 200 with a body + sends byte-identical to main's · a core read failing (the 2026-10-26 502
//      path) → 502 { ok:false, failed:["detection-read"] } and the DB message LOGGED, not echoed · PARTIAL send (one
//      department's email fails, the other's goes) → 500 "send", sent 1, notSent [the failed department] — the one that
//      went still went · every send failing → 500 sent 0 · a degraded metrics read → the emails still go (unchanged) but
//      500 "metrics-read" · bad auth → 401
//   3. shared/cron-outcome.js unit rules · fences: api/_cron.js byte-identical to main, vercel.json crons unchanged,
//      no SQL, locked tokens 132/32/14, Notify held, the files changed are exactly the five expected
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "09f7755";   // live main when this was drafted (industrial-noir-51)
// Structural fences PINNED to the reviewed range (released as industrial-noir-52): base 09f7755 .. reviewed e7ced15 — "vs the
// base" / "the working tree" would go red once later work lands. The handler checks run on the current code.
const REV = "e7ced15";
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
  S.sends.push({ url: String(url), to });
  if (S.failSendTo && to.includes(S.failSendTo)) return { ok: false, status: 500, json: async () => ({ message: "resend exploded" }), text: async () => "resend exploded" };
  return { ok: true, status: 200, json: async () => ({ id: "email-1" }), text: async () => "{}" };
};
const outDir = mkdtempSync(join(tmpdir(), "b4c-cronh-"));
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
const R = { pulse: await load("pulse"), digest: await load("digest"), pulseBase: await load("pulse", BASE), digestBase: await load("digest", BASE) };
// PULSE_ENABLED is read once at import, so the "switched off" copies are bundled + imported with it off
process.env.PULSE_ENABLED = "";
const outDirOff = mkdtempSync(join(tmpdir(), "b4c-cronh-off-"));
const loadAs = async (route, fromRef, dir) => { const out = join(dir, `${route}${fromRef ? "-" + fromRef : ""}.mjs`);
  const opts = { bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", plugins: [{ name: "fake-sb", setup(b) {
    b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" })); } }] };
  if (fromRef) opts.stdin = { contents: execSync(`git show ${fromRef}:api/${route}.js`, { cwd: root, maxBuffer: 1 << 26 }).toString(), resolveDir: join(root, "api"), sourcefile: `${route}.js`, loader: "js" };
  else opts.entryPoints = [join(root, `api/${route}.js`)];
  await build(opts); return (await import(pathToFileURL(out).href)).default; };
const OFF = { now: await loadAs("pulse", null, outDirOff), base: await loadAs("pulse", BASE, outDirOff) };
process.env.PULSE_ENABLED = "1";
const leaks = (body) => /svc-test|status 401|42501|permission|refused|exploded|Invalid|stack|at \w+ \(|chief@|m1|m2/i.test(JSON.stringify(body));

// ---------------------------------------------------------------- 1. pulse
{
  const now = await call(R.pulse), base = await call(R.pulseBase);
  ok("pulse: a clean run → 200, body + DB writes byte-identical to main's (success unchanged)", now.code === 200 && base.code === 200 && same(now.body, base.body) && JSON.stringify(now.writes) === JSON.stringify(base.writes), `${now.code}/${base.code}`);
  let r = await call(R.pulse, { setup: (S) => { S.failHead = 401; } });
  ok("pulse: the DB probe unreachable (HEAD → 401, EMPTY message — the live signature since 2026-10-17) → 503 { ok:false, failed:[\"db\"] }",
    r.code === 503 && JSON.stringify(r.body.failed) === '["db"]' && r.body.ok === false, JSON.stringify(r.body));
  ok("…the HTTP status is in the LOG (\"status 401\") so the next failure names its cause; the body carries nothing internal",
    r.logs.some((l) => /\[pulse\] FAILED 503 steps=db/.test(l)) && r.logs.some((l) => /db=unreachable: status 401/.test(l)) && !leaks(r.body), JSON.stringify(r.body));
  const b = await call(R.pulseBase, { setup: (S) => { S.failHead = 401; } });
  ok("…(main today answers that same run 200 — the bug)", b.code === 200 && /^unreachable/.test(b.body.db));
  r = await call(R.pulse, { setup: (S) => { S.fail.training_sessions = "permission denied for table training_sessions"; } });
  ok("pulse: a detection read failing → 500 naming it (detect:events), the DB message logged not echoed", r.code === 500 && r.body.failed.includes("detect:events") && !leaks(r.body) && r.logs.some((l) => /permission denied/.test(l)), JSON.stringify(r.body));
  r = await call(R.pulse, { auth: "Bearer wrong" });
  ok("pulse: bad auth → still 401, no client opened", r.code === 401 && r.clients === 0);
  r = await call(R.pulse, { auth: null });
  ok("pulse: no auth → still 401", r.code === 401 && r.clients === 0);
  const off = await call(OFF.now), offBase = await call(OFF.base);
  ok("pulse: PULSE_ENABLED off → the same 200 as main, no client (an intentionally-off endpoint is not a failure)", off.code === 200 && off.body.enabled === false && same(off.body, offBase.body) && off.clients === 0, JSON.stringify(off.body));
}

// ---------------------------------------------------------------- 2. digest
{
  const now = await call(R.digest), base = await call(R.digestBase);
  ok("digest: a clean run → 200, body + sends byte-identical to main's (success unchanged); both departments mailed",
    now.code === 200 && base.code === 200 && same(now.body, base.body) && JSON.stringify(now.sends) === JSON.stringify(base.sends) && now.sends.length === 2, `${now.code}/${base.code} sends ${now.sends.length}`);
  let r = await call(R.digest, { setup: (S) => { S.fail.certs = "Invalid API key"; } });
  ok("digest: a core read failing (the 2026-10-26 502 path) → 502 { ok:false, failed:[\"detection-read\"] }, nothing sent",
    r.code === 502 && JSON.stringify(r.body) === '{"ok":false,"failed":["detection-read"]}' && r.sends.length === 0, JSON.stringify(r.body));
  ok("…the DB message is LOGGED (it never was — why the 10-26 cause is unrecoverable) and no longer echoed in the response",
    r.logs.some((l) => /\[digest\] FAILED 502 steps=detection-read.*Invalid API key/.test(l)) && !leaks(r.body));
  const b = await call(R.digestBase, { setup: (S) => { S.fail.certs = "Invalid API key"; } });
  ok("…(main today: the same 502 but the raw message in the body and no log line)", b.code === 502 && /Invalid API key/.test(JSON.stringify(b.body)) && !b.logs.some((l) => /Invalid API key/.test(l)));
  r = await call(R.digest, { setup: (S) => { S.failSendTo = "chief@bravo.fd"; } });
  ok("digest PARTIAL: Alpha mailed, Bravo's send failed → 500 { failed:[\"send\"], sent:1, notSent:[\"Bravo FD\"] } — Alpha's mail still went",
    r.code === 500 && JSON.stringify(r.body.failed) === '["send"]' && r.body.sent === 1 && JSON.stringify(r.body.notSent) === '["Bravo FD"]' && r.sends.length === 2 && !leaks(r.body), JSON.stringify(r.body));
  const pb = await call(R.digestBase, { setup: (S) => { S.failSendTo = "chief@bravo.fd"; } });
  ok("…(main today answers that partial failure 200)", pb.code === 200);
  r = await call(R.digest, { setup: (S) => { S.failSendTo = "@"; } });
  ok("digest: every send failing → 500 \"send\", sent 0, both named", r.code === 500 && r.body.sent === 0 && r.body.notSent.length === 2);
  r = await call(R.digest, { setup: (S) => { S.fail.training_sessions = "statement timeout"; } });
  const mb = await call(R.digestBase, { setup: (S) => { S.fail.training_sessions = "statement timeout"; } });
  // Updated with the digest-members decoupling (feat/digest-members-decouple): the member list is read on its own, so a failed
  // metrics read no longer blanks the recipients — both admins are mailed (main at 09f7755 mailed nobody). Still 500.
  ok("digest: a failed metrics read → 500 \"metrics-read\" (main answered 200) — and since the decoupling the emails still go (main sent none)",
    r.code === 500 && JSON.stringify(r.body.failed) === '["metrics-read"]' && r.sends.length === 2 && mb.sends.length === 0 && mb.code === 200 && !leaks(r.body), `${JSON.stringify(r.body)} · main ${mb.code}, sends ${mb.sends.length}`);
  r = await call(R.digest, { auth: "Bearer wrong" });
  ok("digest: bad auth → still 401, no client, nothing sent", r.code === 401 && r.clients === 0 && r.sends.length === 0);
}

// ---------------------------------------------------------------- 3. the rule module + fences
const { pulseOutcome, digestOutcome } = await import(pathToFileURL(join(root, "shared/cron-outcome.js")).href);
ok("rule: pulse clean → 200 []", JSON.stringify(pulseOutcome({})) === '{"status":200,"failed":[]}');
ok("rule: pulse write / mute / drain / stamp / push failures each name their step", JSON.stringify(pulseOutcome({ writeError: "x", muteErrors: [{}], pushErrors: [{ drain: "d" }, { stamp: "s" }, { error: "e" }] }).failed) === '["mute-check","write","drain","stamp","push"]');
ok("rule: pulse db → 503 even alongside other failures; others → 500", pulseOutcome({ dbError: "x", writeError: "y" }).status === 503 && pulseOutcome({ writeError: "y" }).status === 500);
ok("rule: push 'skipped' (no FCM creds) is a failure only when push is ON", pulseOutcome({ pushErrors: [{ skipped: "no creds" }], pushEnabled: false }).status === 200 && pulseOutcome({ pushErrors: [{ skipped: "no creds" }], pushEnabled: true }).failed[0] === "push-config");
ok("rule: digest partial — sent counts the mailed, notSent names the failed, a 5xx even with one success", JSON.stringify(digestOutcome({ results: [{ name: "A", sentTo: ["a"] }, { name: "B", error: "x" }] })) === '{"status":500,"failed":["send"],"sent":1,"notSent":["B"]}');
ok("rule: digest detection-read → 502 alone (nothing else is evaluated)", JSON.stringify(digestOutcome({ detectionError: "x", metricsError: "y" })) === '{"status":502,"failed":["detection-read"],"sent":0,"notSent":[]}');
ok("rule: digest dry-run results never count as unsent; a deliberately skipped department is not a failure", digestOutcome({ results: [{ name: "A", dryRun: true, sentTo: null }] }).status === 200);
const diffNames = (p) => execSync(`git diff --name-only ${BASE} ${REV} -- ${p}`, { cwd: root }).toString().trim();
ok(`api/_cron.js (requireCron, the pinned L-1 gate) byte-identical across ${BASE}..${REV}`, diffNames("api/_cron.js") === "");
ok("vercel.json byte-identical (crons unchanged); no SQL", diffNames("vercel.json") === "" && diffNames("sql") === "");
const changed = execSync(`git diff --name-only ${BASE} ${REV}`, { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
const allowed = ["api/digest.js", "api/pulse.js", "claude/B4C_CronHonesty_Draft.md", "docs/review/cron_honesty_test.mjs", "shared/cron-outcome.js"];
ok("the files changed are exactly: api/pulse.js, api/digest.js, shared/cron-outcome.js, this test, the notes", changed.every((f) => allowed.includes(f)) && changed.includes("api/pulse.js") && changed.includes("api/digest.js"), JSON.stringify(changed));
const tok = (p) => (execSync(`git show ${REV}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString().match(new RegExp("verifie" + "d", "gi")) || []).length;
ok(`verified untouched at ${REV}: App.jsx 132 · digest 32 · assistant 14`, tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
