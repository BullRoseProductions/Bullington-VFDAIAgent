// node docs/review/l5_reminders_terse_test.mjs
// No network, no DB. Hygiene slice 1 — L-5 on api/expiration-reminders.js: the route meets the cron-honesty standard.
// The REAL handler and main's (BASE) are bundled against the same fakes (@supabase/supabase-js and ./_push.js) and driven
// through every path. Checks:
//   1. CLEAN RUNS ARE BYTE-IDENTICAL to main's body: flagged + push sent, flagged + push skipped, nothing flagged — and log nothing
//   2. each failure path (config missing · 403 authorize via a DB error · 403 no department · 500 write · push error on
//      the 200 path) → the body carries NO Supabase / FCM prose and no setting name, only { ok:false, failed:[step],
//      error:<the fixed sentence> } (or push.error = "push"); main's body DID carry it (the leak, reproduced)
//   3. …and the log carries it, with the step and the caller / department by id, never a key
//   4. the sentences the Expirations button shows (out.error) are unchanged for 403 and the write failure
//   fences: only api/expiration-reminders.js (+ this test); src/App.jsx untouched; verified 132/32/14; Notify held
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "5b26d28";   // live main when this was drafted (industrial-noir-57)
// REV is the working tree until review; pin it to the reviewed commit in the promote push.
const REV = process.env.REV || null;
const SVC = "svc-KEY-never-in-a-body";
Object.assign(process.env, { PUSH_ENABLED: "1", SUPABASE_URL: "https://x.supabase.test", SUPABASE_SERVICE_ROLE_KEY: SVC, SUPABASE_ANON_KEY: "anon-test" });

const FAKE_SB = `
export function createClient(url, key, opts) {
  const S = globalThis.__S;
  const as = (opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || null;
  const q = () => { const b = {}; for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b; b.then = (r, j) => Promise.resolve({ data: S.devices, error: null }).then(r, j); return b; };
  return {
    auth: { getUser: async (tok) => (tok === "tok-ok" ? { data: { user: { id: "user-1", email: "lead@x.test" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    rpc: async (name, args) => S.rpc(name, args, as, key),
    from: () => q(),
  };
}`;
const FAKE_PUSH = `
export async function insertNotifications(sb, rows) { return globalThis.__S.insert(rows); }
export async function sendPush(sb, n, t) { return globalThis.__S.push(n, t); }`;
const outDir = mkdtempSync(join(tmpdir(), "b4c-l5-"));
async function bundle(entry, name) {
  const out = join(outDir, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    plugins: [{ name: "fakes", setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onResolve({ filter: /_push\.js$/ }, () => ({ path: "push", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: a.path === "sb" ? FAKE_SB : FAKE_PUSH, loader: "js" }));
    } }] });
  return (await import(pathToFileURL(out).href)).default;
}
// main's handler: its file + the helpers it imports, laid out as in the repo at BASE
const mainDir = join(outDir, "main");
for (const p of ["api/expiration-reminders.js", "api/_cors.js", "api/_auth.js", "shared/expiry.js"]) {
  mkdirSync(join(mainDir, p.split("/")[0]), { recursive: true });
  writeFileSync(join(mainDir, p), execSync(`git show ${BASE}:${p}`, { cwd: root }).toString());
}
const NEW = await bundle(join(root, "api/expiration-reminders.js"), "new");
const MAIN = await bundle(join(mainDir, "api/expiration-reminders.js"), "main");

const ym = new Date().toISOString().slice(0, 7);
const ROWS = [
  { item_id: "c1", member_id: "m1", source: "cert", kind: "cert", label: "EMT", cls: null, expires_on: "2020-01-31", bucket: "expired" },
  { item_id: "g1", member_id: "m2", source: "gear", kind: "gear", label: "SCBA mask", cls: "M", expires_on: `${ym}-28`, bucket: "current" },
];
const DB_PROSE = "permission denied for function dept_expirations SECRET-DB-DETAIL";
const FCM_PROSE = "invalid_grant: Invalid JWT Signature SECRET-FCM-DETAIL";
function world({ rpcErr = null, noDept = false, rows = ROWS, insertThrows = null, push = { sent: 2, failed: 0 } } = {}) {
  globalThis.__S = {
    devices: [{ member_id: "m1", token: "t1" }, { member_id: "m2", token: "t2" }],
    rpc: (name) => {
      if (name === "my_department_id") return rpcErr === "dept" ? { data: null, error: { message: DB_PROSE } } : { data: noDept ? null : "dept-1", error: null };
      if (name === "dept_expirations") return rpcErr === "exp" ? { data: null, error: { message: DB_PROSE } } : { data: rows, error: null };
      if (name === "is_muted") return { data: false, error: null };
      return { data: null, error: null };
    },
    insert: (r) => { if (insertThrows) throw new Error(insertThrows); return { inserted: r.length, rows: r }; },
    push: () => push,
  };
}
const logs = []; const origErr = console.error; console.error = (...a) => logs.push(a.join(" "));
async function call(h, { token = "tok-ok" } = {}) {
  const res = { code: 0, body: null, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
  await h({ method: "POST", headers: { origin: "https://app.b4thecall.com", authorization: `Bearer ${token}` }, body: {} }, res);
  return res;
}
async function both(w) { world(w); logs.length = 0; const n = await call(NEW); const nl = [...logs]; world(w); logs.length = 0; const m = await call(MAIN); return { n, m, nl }; }
const leaks = (b) => /SECRET|permission denied|invalid_grant|SUPABASE_|SERVICE_ROLE/.test(JSON.stringify(b)) || JSON.stringify(b).includes(SVC);

// 1 — clean runs are byte-identical
let r = await both({});
ok("1. CLEAN RUN (flagged, push sent) → body byte-identical to main's; nothing logged", r.n.code === 200 && JSON.stringify(r.n.body) === JSON.stringify(r.m.body) && r.nl.length === 0, JSON.stringify(r.n.body));
ok("1. …the button's fields are all there: inserted, members, muted, mute_check_errors, push.enabled/sent/failed/members_with_device",
  ["flagged", "members", "muted", "mute_check_errors", "inserted", "push"].every((k) => k in r.n.body) && ["enabled", "sent", "failed", "members_with_device"].every((k) => k in r.n.body.push));
r = await both({ push: { sent: 0, failed: 0, skipped: "FIREBASE_SERVICE_ACCOUNT missing or malformed" } });
ok("1. CLEAN RUN, push skipped → byte-identical (skipped kept exactly as it is)", r.n.code === 200 && JSON.stringify(r.n.body) === JSON.stringify(r.m.body) && r.n.body.push.skipped === "FIREBASE_SERVICE_ACCOUNT missing or malformed");
r = await both({ rows: [] });
ok("1. CLEAN RUN, nothing flagged → byte-identical", r.n.code === 200 && JSON.stringify(r.n.body) === JSON.stringify(r.m.body) && r.nl.length === 0);

// 2 + 3 + 4 — failure paths
r = await both({ rpcErr: "exp" });
ok("2. 403 (dept_expirations errors) → { ok:false, failed:[\"authorize\"], error:<the sentence> } — no Supabase prose", r.n.code === 403 && r.n.body.ok === false && r.n.body.failed[0] === "authorize" && !("detail" in r.n.body) && !leaks(r.n.body), JSON.stringify(r.n.body));
ok("2. …main's body carried it (the leak, reproduced)", r.m.code === 403 && JSON.stringify(r.m.body).includes("SECRET-DB-DETAIL"));
ok("3. …the log has it: step, which RPC, the database's words, the caller by id", r.nl.some((l) => /FAILED authorize/.test(l) && /dept_expirations: permission denied/.test(l) && /user user-1/.test(l)));
ok("4. …the sentence the button shows is unchanged", r.n.body.error === r.m.body.error);
r = await both({ rpcErr: "dept" });
ok("2. 403 (my_department_id errors) → terse, logged with that RPC named", r.n.code === 403 && !leaks(r.n.body) && r.nl.some((l) => /my_department_id: permission denied/.test(l)));
r = await both({ noDept: true });
ok("2. 403 (no department resolved) → terse, logged", r.n.code === 403 && !leaks(r.n.body) && r.nl.some((l) => /no department/.test(l)) && r.n.body.error === r.m.body.error);
r = await both({ insertThrows: "duplicate key value violates unique constraint SECRET-DB-DETAIL" });
ok("2. 500 write (the inbox insert throws) → { ok:false, failed:[\"write\"], error:\"Couldn't record the reminders.\" } — no DB prose", r.n.code === 500 && r.n.body.failed[0] === "write" && !("detail" in r.n.body) && !leaks(r.n.body) && r.n.body.error === r.m.body.error, JSON.stringify(r.n.body));
ok("2. …main's carried it", JSON.stringify(r.m.body).includes("SECRET-DB-DETAIL"));
ok("3. …logged with the department and caller by id and the row count", r.nl.some((l) => /FAILED write/.test(l) && /SECRET-DB-DETAIL/.test(l) && /dept dept-1/.test(l) && /user user-1/.test(l) && /2 rows/.test(l)));
r = await both({ push: { sent: 0, failed: 0, error: FCM_PROSE } });
ok("2. 200 with an FCM failure → push.error is the step \"push\", never FCM's text", r.n.code === 200 && r.n.body.push.error === "push" && !leaks(r.n.body), JSON.stringify(r.n.body.push));
ok("2. …every other field identical to main's (counts, members_with_device, sent/failed)", JSON.stringify({ ...r.n.body, push: { ...r.n.body.push, error: null } }) === JSON.stringify({ ...r.m.body, push: { ...r.m.body.push, error: null } }));
ok("2. …main's carried FCM's text", JSON.stringify(r.m.body).includes("SECRET-FCM-DETAIL"));
ok("3. …the log has FCM's words + the department + how many were sendable", r.nl.some((l) => /FAILED push/.test(l) && /SECRET-FCM-DETAIL/.test(l) && /dept dept-1/.test(l) && /2 sendable/.test(l)));
const saved = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
r = await both({});
process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
ok("2. 500 config → names no setting: { ok:false, failed:[\"config\"], error:\"Reminders aren't set up on this server.\", note }", r.n.code === 500 && r.n.body.failed[0] === "config" && !/SUPABASE|SERVICE_ROLE|ANON/.test(JSON.stringify(r.n.body)) && r.n.body.note === "Nothing was read or sent.", JSON.stringify(r.n.body));
ok("2. …main's named them", /SUPABASE_SERVICE_ROLE_KEY/.test(JSON.stringify(r.m.body)));
ok("3. …the log names the missing setting by NAME and the caller, never a value", r.nl.some((l) => /FAILED config/.test(l) && /SUPABASE_SERVICE_ROLE_KEY/.test(l) && /user user-1/.test(l)) && !r.nl.some((l) => l.includes(SVC)));
world({}); logs.length = 0; const bad = await call(NEW, { token: "nope" });
ok("bad session → still requireUser's 401, nothing read", bad.code === 401);
console.error = origErr;

// fences
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["api/expiration-reminders.js", "docs/review/l5_reminders_terse_test.mjs"];
ok("changed: only api/expiration-reminders.js (+ this test)", files.every((f) => allowed.includes(f)) && files.includes("api/expiration-reminders.js"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("src/App.jsx (the button that reads out.error), api/_push.js, api/_auth.js, sql/, vercel.json untouched", ["src/App.jsx", "api/_push.js", "api/_auth.js", "sql", "vercel.json"].every(untouched));
const show = (p) => REV ? execSync(`git show ${REV}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : execSync(`cat ${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const tok = (p) => (show(p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
