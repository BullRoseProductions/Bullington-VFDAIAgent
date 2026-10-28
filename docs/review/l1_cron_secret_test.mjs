// node docs/review/l1_cron_secret_test.mjs
// No network, no DB. Security review L-1 — the cron secret. The REAL api/digest.js and api/pulse.js are bundled with
// esbuild, their Supabase client replaced by a fake that counts every createClient (a refused call must open no
// service-role client) and global fetch stubbed so every Resend send is COUNTED. Checks:
//   1. both routes: no secret configured → 500 · no header → 401 · wrong Bearer → 401 · wrong secret of the same
//      length → 401 · ?secret=<the RIGHT secret> with no header → 401 (the query form is gone, value never compared)
//      · ?secret= alongside a right header → still 401 · right Bearer → runs. No refusal touches the DB or sends.
//   2. digest ?to=: an address off the allow-list → 400 before any read (no client, no send), never swapped for the
//      default · the default address passes · DIGEST_TEST_TO widens the list (case/space-insensitive) · ?to=x&dry=1
//      renders for x and sends nothing · a real run (no ?to=) still mails the department's admins
//   3. source fences: no `!==` secret compare and no req.query.secret read left in digest/pulse; both import
//      requireCron; _cron.js uses timingSafeEqual over fixed-length digests; locked tokens 132/32/14; Notify held;
//      the files changed vs the base are exactly _cron.js, digest.js, pulse.js, this test and the L-1 notes
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "8f9474a";   // main when this was drafted (industrial-noir-43)
const SECRET = "s3cret-cron-value-0123456789abcdef";
Object.assign(process.env, { PULSE_ENABLED: "1", RESEND_API_KEY: "re-test", SUPABASE_URL: "https://x.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "svc-test" });

// ---------------------------------------------------------------- the fakes
// Any chain of query-builder calls resolves to the table's rows; departments has one, with one admin member.
const FAKE_SB = `
export function createClient() {
  const S = globalThis.__S; S.clients++;
  const rows = (t) => (S.tables[t] || []);
  const q = (t) => new Proxy({}, { get(_, k) {
    if (k === "then") return (r, j) => Promise.resolve({ data: rows(t), error: null }).then(r, j);
    if (k === "maybeSingle" || k === "single") return async () => ({ data: rows(t)[0] || null, error: null });
    return () => q(t);
  } });
  return { from: (t) => q(t), rpc: async () => ({ data: [], error: null }) };
}`;
globalThis.fetch = async (url, init) => {
  globalThis.__S.sends.push({ url: String(url), body: JSON.parse(init?.body || "{}") });
  return { ok: true, status: 200, json: async () => ({ id: "email-1" }) };
};
const outDir = mkdtempSync(join(tmpdir(), "b4c-l1-"));
async function load(route) {
  const out = join(outDir, `${route}.mjs`);
  await build({ entryPoints: [join(root, `api/${route}.js`)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    plugins: [{ name: "fake-sb", setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
    } }] });
  return (await import(pathToFileURL(out).href)).default;
}

function world() {
  globalThis.__S = { clients: 0, sends: [], tables: {
    departments: [{ id: "d1", name: "Test FD", week_start_day: 1 }],
    members: [{ id: "m1", department_id: "d1", email: "chief@test.fd", access: ["Department Admin"], status: "Active", name: "Chief" }],
    // one expired cert, so a real run has something to say (a quiet week is skipped by design)
    certs: [{ id: "c1", department_id: "d1", member_id: "m1", name: "EMT-B", exp: "2025-01", no_expiry: false, cert_types: null, members: { name: "Chief" } }],
  } };
}
async function call(handler, { query = {}, auth } = {}) {
  world();
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  await handler({ method: "GET", query, headers: auth ? { authorization: auth } : {} }, res);
  return { code: res.code, body: res.body, clients: globalThis.__S.clients, sends: globalThis.__S.sends };
}
const R = { digest: await load("digest"), pulse: await load("pulse") };
const RIGHT = `Bearer ${SECRET}`;

// ---------------------------------------------------------------- 1. the gate, both routes
for (const [name, h] of Object.entries(R)) {
  delete process.env.CRON_SECRET;
  let r = await call(h, { auth: RIGHT });
  ok(`${name}: no CRON_SECRET configured → 500, fail closed, no client`, r.code === 500 && r.clients === 0 && r.sends.length === 0, JSON.stringify(r.body));
  process.env.CRON_SECRET = SECRET;
  r = await call(h, {});
  ok(`${name}: no Authorization header → 401, no client, no send`, r.code === 401 && r.clients === 0 && r.sends.length === 0);
  r = await call(h, { auth: "Bearer nope" });
  ok(`${name}: wrong Bearer → 401`, r.code === 401 && r.clients === 0);
  r = await call(h, { auth: `Bearer ${SECRET.slice(0, -1)}X` });
  ok(`${name}: same-length wrong secret (one char off) → 401`, r.code === 401 && r.clients === 0);
  r = await call(h, { auth: SECRET });
  ok(`${name}: the right secret without "Bearer " → 401`, r.code === 401 && r.clients === 0);
  r = await call(h, { query: { secret: SECRET } });
  ok(`${name}: ?secret=<the RIGHT secret>, no header → 401 with the "send it as a header" note`, r.code === 401 && r.clients === 0 && r.sends.length === 0 && /Authorization: Bearer/.test(r.body?.note || ""), JSON.stringify(r.body));
  r = await call(h, { query: { secret: SECRET }, auth: RIGHT });
  ok(`${name}: ?secret= alongside the right header → still 401 (a secret in a URL is refused outright)`, r.code === 401 && r.clients === 0);
  r = await call(h, { query: { dry: "1" }, auth: RIGHT });
  ok(`${name}: right Bearer (+ dry=1) → 200, runs, sends nothing`, r.code === 200 && r.clients >= 1 && r.sends.length === 0, `${r.code} ${JSON.stringify(r.body).slice(0, 160)}`);
  r = await call(h, { query: { dry: "1" }, auth: `bearer   ${SECRET}` });
  ok(`${name}: Bearer scheme is case-insensitive / tolerant of extra spaces (what Cron sends still passes)`, r.code === 200);
}

// ---------------------------------------------------------------- 2. digest ?to=
process.env.CRON_SECRET = SECRET;
let r = await call(R.digest, { query: { to: "stranger@evil.test" }, auth: RIGHT });
ok("digest ?to=<off the allow-list> → 400 before any read: no client, no send", r.code === 400 && r.clients === 0 && r.sends.length === 0, JSON.stringify(r.body));
r = await call(R.digest, { query: { to: "stranger@evil.test", dry: "1" }, auth: RIGHT });
ok("digest ?to=<off the allow-list>&dry=1 → 400 too (dry does not open the door)", r.code === 400 && r.clients === 0);
r = await call(R.digest, { query: { to: "ashlea@b4thecall.com", dry: "1" }, auth: RIGHT });
const d0 = r.body?.departments?.[0];
ok("digest ?to=<the default address>&dry=1 → 200, renders for that address only, sends nothing", r.code === 200 && r.sends.length === 0 && JSON.stringify(d0?.wouldSendTo) === JSON.stringify(["ashlea@b4thecall.com"]), JSON.stringify(d0?.wouldSendTo));
r = await call(R.digest, { query: { to: "ashlea@b4thecall.com" }, auth: RIGHT });
ok("digest ?to=<the default address> → one send, to that address only", r.code === 200 && r.sends.length === 1 && JSON.stringify(r.sends[0].body.to) === JSON.stringify(["ashlea@b4thecall.com"]), JSON.stringify(r.sends.map((s) => s.body.to)));
r = await call(R.digest, { query: { to: "chief@test.fd" }, auth: RIGHT });
ok("digest ?to=<a real admin, but not on the test list> → 400 (the list is explicit, not 'any member')", r.code === 400 && r.sends.length === 0);
r = await call(R.digest, { auth: RIGHT });
ok("digest real run (no ?to=) → mails the department's admins (unchanged)", r.code === 200 && r.sends.length === 1 && JSON.stringify(r.sends[0].body.to) === JSON.stringify(["chief@test.fd"]), JSON.stringify(r.sends.map((s) => s.body.to)));
// DIGEST_TEST_TO is read at module load, so a second bundle sees the widened list.
process.env.DIGEST_TEST_TO = " Ashlea@B4theCall.com , qa@b4thecall.com ";
const digest2 = await (async () => { const out = join(outDir, "digest2.mjs"); await build({ entryPoints: [join(root, "api/digest.js")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{ name: "fake-sb", setup(b) { b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" })); b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" })); } }] });
  return (await import(pathToFileURL(out).href + "?2")).default; })();
r = await call(digest2, { query: { to: "QA@b4thecall.com ", dry: "1" }, auth: RIGHT });
ok("DIGEST_TEST_TO widens the list (case- and space-insensitive)", r.code === 200 && r.sends.length === 0, JSON.stringify(r.body).slice(0, 120));
r = await call(digest2, { query: { to: "ashlea@b4thecall.com", dry: "1" }, auth: RIGHT });
ok("DIGEST_TEST_TO replaces the default list (the default only passes if it's listed — it is here)", r.code === 200);
r = await call(digest2, { query: { to: "stranger@evil.test" }, auth: RIGHT });
ok("DIGEST_TEST_TO set: an unlisted address is still refused", r.code === 400 && r.sends.length === 0);
delete process.env.DIGEST_TEST_TO;

// ---------------------------------------------------------------- 3. source fences
const src = Object.fromEntries(["digest", "pulse", "_cron"].map((f) => [f, readFileSync(join(root, `api/${f}.js`), "utf8")]));
ok("digest + pulse import requireCron and gate with it; no own CRON_SECRET compare left",
  ["digest", "pulse"].every((f) => src[f].includes('import { requireCron } from "./_cron.js";') && /if \(!requireCron\(req, res\)\) return;/.test(src[f]) && !/process\.env\.CRON_SECRET/.test(src[f]) && !/provided !== secret/.test(src[f])));
ok("no route reads req.query.secret any more", Object.values(src).every((s) => !/query\??\.secret\b(?!\s*!=\s*null)/.test(s)) && !/req\.query\?\.secret \|\|/.test(src.digest + src.pulse));
ok("_cron.js compares with timingSafeEqual over sha256 digests (equal length always), header-only",
  /timingSafeEqual\(digest\(match\[1\]\), digest\(secret\)\)/.test(src._cron) && /createHash\("sha256"\)/.test(src._cron) && !/!==/.test(src._cron));
ok("no other api route reads CRON_SECRET", execSync("git grep --untracked -l CRON_SECRET -- api", { cwd: root }).toString().trim().split("\n").sort().join(",") === "api/_cron.js,api/digest.js,api/pulse.js");
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token counts unchanged (App.jsx 132 · digest.js 32 · assistant.js 14)",
  tok(readFileSync(join(root, "src/App.jsx"), "utf8")) === 132 && tok(src.digest) === 32 && tok(readFileSync(join(root, "api/assistant.js"), "utf8")) === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
// Pinned to the reviewed range (released as industrial-noir-44): base 8f9474a .. reviewed f837541 — "vs the base" would go red once later work lands.
const changed = execSync(`git diff --name-only ${BASE} f837541`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const allowed = (p) => ["api/_cron.js", "api/digest.js", "api/pulse.js", "docs/review/l1_cron_secret_test.mjs"].includes(p) || /^claude\/B4C_L1_/.test(p);
ok(`only _cron.js + digest.js + pulse.js + this test + the L-1 notes changed in the reviewed range ${BASE}..f837541 — no client, no DB, no vercel.json`, changed.every(allowed), JSON.stringify(changed.filter((p) => !allowed(p))));
