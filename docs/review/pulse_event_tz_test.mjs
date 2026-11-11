// node docs/review/pulse_event_tz_test.mjs
// No network, no DB. HOTFIX fix/pulse-event-tz: pulse event reminders said "at 1:00 PM" for a 7:00 PM session.
//
// Cause: api/pulse.js called zonedInstant(sess.date, sess.start_time) with no tz. The undefined zone reached
// Intl.DateTimeFormat, which fell back to the PROCESS zone. That is UTC on Vercel and Central on the Mac this was
// tested on, which is why no local run ever saw it. startsAt landed 6h early (5h in CDT), moving the body's time
// AND both reminder bands.
//
// This test re-runs itself in a child with TZ=UTC (the Vercel condition), whatever zone the machine is in. Then:
//   1. shared/zoned-time.js under UTC: zonedInstant("2026-11-05","19:00") is 01:00Z Nov 6 with tz explicit AND by
//      default; zonedInstantFrom defaults the same; a CDT date is 5h, not 6.
//   2. The composition: the REAL api/pulse.js, bundled with esbuild against a fake Supabase client, run as a dry run
//      with the clock pinned. A "Back to the Basics" session on 2026-11-05 at 19:00:
//      - the body reads "Back to the Basics at 7:00 PM."; diag startsAtUTC is 2026-11-06T01:00:00.000Z;
//      - the 1h band opens only within the hour before 7 PM Central: 12:30 PM gives the 24h band, never the 1h one
//        (on the bug, 12:30 PM was the 1h band); 6:30 PM gives the 1h band; 7:30 PM gives nothing.
//   3. Each layer holds alone. The fixed pulse with the OLD zoned-time is correct, and the OLD pulse with the NEW
//      zoned-time is correct.
//   2b. Commit 2, todayISOIn: under UTC at 7:00 PM Central, todayISOIn() (no tz) is the Central date, not tomorrow's;
//      pulse's diag todayISO is the Central date; a task due today reads task_due_today, never task_overdue, at 7 PM
//      and at 11:59 PM; a task due tomorrow reads task_due_tomorrow. At BASE the same task read overdue at 7 PM.
//   2c. Commit 3: civil() and tzOffsetMs() with no tz are Central too, and no exported function takes tz without a default.
//   4. The test catches the bug: origin/main's pulse + zoned-time (BASE) under the same UTC clock reads "at 1:00 PM".
//   5. Fences: the files changed vs BASE are exactly api/pulse.js, shared/zoned-time.js and this test. api/_cron.js,
//      vercel.json and sql/ are untouched; verified counts 132/32/14; Notify held.
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "cae3f78";   // origin/main when the hotfix branched (industrial-noir-68): the bug, as deployed

// ---------------------------------------------------------------- re-run under TZ=UTC
if (process.env.PULSE_TZ_TEST_CHILD !== "1") {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TZ: "UTC", PULSE_TZ_TEST_CHILD: "1" }, stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

const { build } = await import("esbuild");
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

ok("the child really runs in UTC (the Vercel condition)",
  new Date(2026, 10, 5).getTimezoneOffset() === 0 && Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC",
  Intl.DateTimeFormat().resolvedOptions().timeZone);

// ---------------------------------------------------------------- 1. shared/zoned-time.js under UTC
const zt = await import(pathToFileURL(join(root, "shared/zoned-time.js")).href);
const CT = "America/Chicago";
ok("zonedInstant('2026-11-05','19:00', Central) = 2026-11-06T01:00Z",
  zt.zonedInstant("2026-11-05", "19:00", CT).toISOString() === "2026-11-06T01:00:00.000Z");
ok("zonedInstant('2026-11-05','19:00') with NO tz = the same Central instant, not 19:00Z",
  zt.zonedInstant("2026-11-05", "19:00").toISOString() === "2026-11-06T01:00:00.000Z",
  zt.zonedInstant("2026-11-05", "19:00").toISOString());
ok("zonedInstantFrom(2026,11,5,19,0) with NO tz = the same Central instant",
  zt.zonedInstantFrom(2026, 11, 5, 19, 0).toISOString() === "2026-11-06T01:00:00.000Z");
ok("in CDT the default is 5h, not 6: zonedInstant('2026-10-01','19:00') = 2026-10-02T00:00Z",
  zt.zonedInstant("2026-10-01", "19:00").toISOString() === "2026-10-02T00:00:00.000Z");
ok("todayISOIn() with NO tz at 7:00 PM CT Nov 5 (01:00Z Nov 6) = 2026-11-05, not 2026-11-06",
  zt.todayISOIn(undefined, new Date("2026-11-06T01:00:00Z")) === "2026-11-05", zt.todayISOIn(undefined, new Date("2026-11-06T01:00:00Z")));
ok("todayISOIn(Central) explicit at the same moment = 2026-11-05; at 12:00 AM CT Nov 6 it rolls to 2026-11-06",
  zt.todayISOIn(CT, new Date("2026-11-06T01:00:00Z")) === "2026-11-05" && zt.todayISOIn(CT, new Date("2026-11-06T06:00:00Z")) === "2026-11-06");
{ // commit 3: the last two helpers. 7:00 PM CT Nov 5 = 01:00Z Nov 6, so a UTC fallback would say Nov 6 / offset 0.
  const at = new Date("2026-11-06T01:00:00Z"), c = zt.civil(at);
  ok("civil(7:00 PM CT Nov 5) with NO tz = { y:2026, m:11, d:5, wd:4 } (Thursday in Central), not Nov 6",
    c.y === 2026 && c.m === 11 && c.d === 5 && c.wd === 4, JSON.stringify(c));
  ok("tzOffsetMs with NO tz = -6h in CST and -5h in CDT, not 0",
    zt.tzOffsetMs(at) === -6 * 3600e3 && zt.tzOffsetMs(new Date("2026-10-02T00:00:00Z")) === -5 * 3600e3, String(zt.tzOffsetMs(at)));
}
ok("no function in shared/zoned-time.js takes a tz without a default",
  !/\btz\s*[,)]/.test((readFileSync(join(root, "shared/zoned-time.js"), "utf8").match(/^export function [^\n]*\(([^)]*)\)/gm) || []).join("\n")),
  (readFileSync(join(root, "shared/zoned-time.js"), "utf8").match(/^export function [^\n]*/gm) || []).filter((l) => /\btz\b/.test(l)).length + " tz-taking functions");
ok("DEFAULT_TZ is exported as America/Chicago (duty-period.js's convention)", zt.DEFAULT_TZ === CT);

// ---------------------------------------------------------------- the fakes
Object.assign(process.env, { PULSE_ENABLED: "1", SUPABASE_URL: "https://x.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "svc-test-key", CRON_SECRET: "s3cret-cron-value-0123456789abcdef" });
delete process.env.PUSH_ENABLED;
const FAKE_SB = `
export function createClient() {
  const S = globalThis.__S;
  const q = (t) => new Proxy({}, { get(_, k) {
    if (k === "then") return (r, j) => Promise.resolve({ data: S.tables[t] || [], error: null, status: 200, count: (S.tables[t] || []).length }).then(r, j);
    if (k === "maybeSingle" || k === "single") return async () => ({ data: (S.tables[t] || [])[0] || null, error: null });
    if (k === "insert" || k === "upsert" || k === "update" || k === "delete") return () => { S.writes++; return q(t); };
    return () => q(t);
  } });
  return { from: (t) => q(t), rpc: async (n) => ({ data: n === "is_muted" ? false : [], error: null }) };
}`;
globalThis.fetch = async () => { throw new Error("no network in this test"); };

const outDir = mkdtempSync(join(tmpdir(), "b4c-pulsetz-"));
const show = (ref, p) => execSync(`git show ${ref}:${p}`, { cwd: root, maxBuffer: 1 << 26 }).toString();
// pulseRef / ztRef: null = the working tree, else a git ref. Lets each layer be swapped independently.
async function load(tag, pulseRef, ztRef) {
  const out = join(outDir, `pulse-${tag}.mjs`);
  const opts = { bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    plugins: [{ name: "fakes", setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onLoad({ filter: /^sb$/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
      if (ztRef) {
        b.onResolve({ filter: /zoned-time\.js$/ }, () => ({ path: "zt", namespace: "oldzt" }));
        b.onLoad({ filter: /^zt$/, namespace: "oldzt" }, () => ({ contents: show(ztRef, "shared/zoned-time.js"), loader: "js" }));
      }
    } }] };
  if (pulseRef) opts.stdin = { contents: show(pulseRef, "api/pulse.js"), resolveDir: join(root, "api"), sourcefile: "pulse.js", loader: "js" };
  else opts.entryPoints = [join(root, "api/pulse.js")];
  await build(opts);
  return (await import(pathToFileURL(out).href)).default;
}

// Pin the clock: Date.now() and new Date() (no args) read FAKE_NOW; everything else is the real Date.
const RealDate = Date;
let FAKE_NOW = 0;
class PinnedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(FAKE_NOW); else super(...a); }
  static now() { return FAKE_NOW; }
}
globalThis.Date = PinnedDate;

const TASKS = [
  { id: "t-today", department_id: "d1", text: "Check SCBA", due_date: "2026-11-05", status: "open", assigned_to: "m1" },
  { id: "t-tomorrow", department_id: "d1", text: "Hose test", due_date: "2026-11-06", status: "open", assigned_to: "m1" },
];
const SESSION = { id: "s-basics", department_id: "d1", title: "Back to the Basics", date: "2026-11-05", start_time: "19:00:00", audience: "all", done: false, status: "scheduled" };
async function run(handler, nowISO) {
  FAKE_NOW = RealDate.parse(nowISO);
  globalThis.__S = { writes: 0, tables: {
    training_sessions: [SESSION],
    members: [{ id: "m1", department_id: "d1", access: ["Member"], status: "Active" }],
    departments: [{ id: "d1", week_start_day: 1 }],
    action_items: TASKS,
  } };
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
  try { await handler({ method: "GET", query: { dry: "1" }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res); }
  finally { console.log = log; console.error = err; }
  const ev = (res.body?.would || []).filter((w) => w.subject_ref === `${SESSION.id}:${SESSION.date}`);
  const d = (res.body?.diag?.sessions || []).find((s) => s.id === SESSION.id);
  const task = (id) => (res.body?.would || []).filter((w) => w.subject_ref === id).map((w) => w.type);
  return { code: res.code, writes: globalThis.__S.writes, types: ev.map((w) => w.type), bodies: ev.map((w) => w.body), startsAtUTC: d?.startsAtUTC, band: d?.band,
           todayISO: res.body?.diag?.todayISO, taskToday: task("t-today"), taskTomorrow: task("t-tomorrow") };
}

// Moments, all CST (UTC-6) on 2026-11-05.
const AT_1230 = "2026-11-05T18:30:00Z";   // 12:30 PM CT: 6.5h before the session (the bug called this 1h-band time)
const AT_1830 = "2026-11-06T00:30:00Z";   //  6:30 PM CT: 30 min before
const AT_1930 = "2026-11-06T01:30:00Z";   //  7:30 PM CT: started
const AT_0900 = "2026-11-05T15:00:00Z";   //  9:00 AM CT: 10h before, inside the 24h band

// ---------------------------------------------------------------- 2. the composition, the fixed code
const NOW = await load("now", null, null);
{
  const r = await run(NOW, AT_1830);
  ok("pulse (fixed) under UTC: diag startsAtUTC = 2026-11-06T01:00:00.000Z", r.startsAtUTC === "2026-11-06T01:00:00.000Z", r.startsAtUTC);
  ok("pulse (fixed): 6:30 PM CT → the 1h band, body \"Back to the Basics at 7:00 PM.\"",
    r.code === 200 && JSON.stringify(r.types) === '["event_1h"]' && r.bodies[0] === "Back to the Basics at 7:00 PM.", JSON.stringify(r.bodies));
  ok("pulse (fixed): a dry run writes nothing", r.writes === 0);
}
{
  const r = await run(NOW, AT_1230);
  ok("pulse (fixed): 12:30 PM CT → the 24h band, NOT the 1h band (the bug's \"starting soon\" at lunchtime)",
    JSON.stringify(r.types) === '["event_24h"]' && r.bodies[0] === "Back to the Basics at 7:00 PM.", `${JSON.stringify(r.types)} ${JSON.stringify(r.bodies)}`);
}
{
  const r = await run(NOW, AT_0900);
  ok("pulse (fixed): 9:00 AM CT → the 24h band, body at 7:00 PM", JSON.stringify(r.types) === '["event_24h"]' && r.bodies[0] === "Back to the Basics at 7:00 PM.");
}
{
  const r = await run(NOW, AT_1930);
  ok("pulse (fixed): 7:30 PM CT → nothing (started), band 'past'", r.types.length === 0 && r.band === "past", r.band);
}
// The 1h band boundary, minute-exact around 6:00 PM CT.
{
  const a = await run(NOW, "2026-11-05T23:59:00Z"), b = await run(NOW, "2026-11-06T00:00:00Z");
  ok("pulse (fixed): the 1h band opens at 6:00 PM CT exactly (5:59 PM → 24h, 6:00 PM → 1h)",
    JSON.stringify(a.types) === '["event_24h"]' && JSON.stringify(b.types) === '["event_1h"]', `${a.types}/${b.types}`);
}

// ---------------------------------------------------------------- 2b. todayISOIn in pulse (commit 2)
{
  const r = await run(NOW, "2026-11-06T01:00:00Z");   // 7:00 PM CT Nov 5
  ok("pulse (fixed) at 7:00 PM CT: diag todayISO = 2026-11-05 (the Central date, not tomorrow's)", r.todayISO === "2026-11-05", r.todayISO);
  ok("pulse (fixed) at 7:00 PM CT: a task due today → task_due_today, NOT task_overdue", JSON.stringify(r.taskToday) === '["task_due_today"]', JSON.stringify(r.taskToday));
  ok("pulse (fixed) at 7:00 PM CT: a task due tomorrow → task_due_tomorrow, not due today", JSON.stringify(r.taskTomorrow) === '["task_due_tomorrow"]', JSON.stringify(r.taskTomorrow));
  const s = await run(NOW, "2026-11-06T05:59:00Z");   // 11:59 PM CT Nov 5
  ok("pulse (fixed) at 11:59 PM CT: still 2026-11-05, the task due today is still due today", s.todayISO === "2026-11-05" && JSON.stringify(s.taskToday) === '["task_due_today"]', `${s.todayISO} ${s.taskToday}`);
  const u = await run(NOW, "2026-11-06T06:00:00Z");   // 12:00 AM CT Nov 6
  ok("pulse (fixed) at 12:00 AM CT Nov 6: rolls over, yesterday's task is now overdue (the real boundary)", u.todayISO === "2026-11-06" && JSON.stringify(u.taskToday) === '["task_overdue"]', `${u.todayISO} ${u.taskToday}`);
}

// ---------------------------------------------------------------- 3. each layer alone
{
  const fixOnly = await load("fix-only", null, BASE);       // fixed pulse, the OLD zoned-time (no default)
  const r = await run(fixOnly, AT_1830);
  ok("layer: the pulse fix ALONE (old zoned-time) → startsAt 01:00Z, body at 7:00 PM",
    r.startsAtUTC === "2026-11-06T01:00:00.000Z" && r.bodies[0] === "Back to the Basics at 7:00 PM.", JSON.stringify(r.bodies));
  const defOnly = await load("default-only", BASE, null);   // the OLD pulse (bare call), the new default
  const s = await run(defOnly, AT_1830);
  ok("layer: the zoned-time default ALONE (old pulse, bare call) → startsAt 01:00Z, body at 7:00 PM",
    s.startsAtUTC === "2026-11-06T01:00:00.000Z" && s.bodies[0] === "Back to the Basics at 7:00 PM.", JSON.stringify(s.bodies));
}

// ---------------------------------------------------------------- 4. the test catches the bug
{
  const OLD = await load("base", BASE, BASE);
  const r = await run(OLD, AT_1230);
  ok(`the bug reproduces at ${BASE} under UTC: startsAt 19:00Z, and at 12:30 PM CT it says "Starting soon … at 1:00 PM"`,
    r.startsAtUTC === "2026-11-05T19:00:00.000Z" && JSON.stringify(r.types) === '["event_1h"]' && r.bodies[0] === "Back to the Basics at 1:00 PM.",
    `${r.startsAtUTC} ${JSON.stringify(r.types)} ${JSON.stringify(r.bodies)}`);
  const s = await run(OLD, AT_1830);
  ok(`at ${BASE}, by 6:30 PM CT the session already reads 'past': the real 1h window got no reminder`, s.types.length === 0 && s.band === "past", s.band);
  const o = await run(OLD, "2026-11-06T01:00:00Z");
  ok(`the today bug reproduces at ${BASE}: at 7:00 PM CT todayISO = 2026-11-06 and the task due today reads task_overdue`,
    o.todayISO === "2026-11-06" && JSON.stringify(o.taskToday) === '["task_overdue"]' && JSON.stringify(o.taskTomorrow) === '["task_due_today"]', `${o.todayISO} ${o.taskToday} ${o.taskTomorrow}`);
}
globalThis.Date = RealDate;

// ---------------------------------------------------------------- 5. fences
// PINNED to the reviewed range BASE..REV (gate PASS @328b918, deployed 2026-11-11). "vs the working tree" went red as soon
// as the next slice (fix/maint-renag) landed on top: slice test fences go stale.
const REV = "328b918";
const sh = (c) => execSync(c, { cwd: root }).toString().trim();
const changed = sh(`git diff --name-only ${BASE} ${REV}`).split("\n").filter(Boolean).sort();
const allowed = ["api/pulse.js", "docs/review/pulse_event_tz_test.mjs", "shared/zoned-time.js"];
ok("files changed vs BASE are exactly api/pulse.js, shared/zoned-time.js, this test", JSON.stringify(changed) === JSON.stringify(allowed), JSON.stringify(changed));
ok("api/_cron.js, vercel.json, sql/ untouched", sh(`git diff --name-only ${BASE} ${REV} -- api/_cron.js vercel.json sql`) === "");
const tok = (p) => ((execSync(`git show ${REV}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString()).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified counts: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
