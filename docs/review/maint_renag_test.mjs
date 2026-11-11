// node docs/review/maint_renag_test.mjs
// No network, no DB. fix/maint-renag: the pulse maintenance summary used to fire EVERY DAY while anything was overdue
// (North Hood: "Brush 26 · Radio Not Working" to 8 officers daily, Nov 2-11, 80 pushes). Gate-approved rule: the
// summary's identity is a fingerprint of the overdue set; send when the set changes, otherwise at most weekly.
//
// The REAL api/pulse.js is bundled with esbuild against a fake Supabase client and run as a dry run (?dry=1) with the
// clock pinned. It runs in a child with TZ=UTC (the Vercel condition). The fake applies no filters, so the history
// table is exactly what each scenario puts there. Checks:
//   1. first summary: no history → every ops leader gets one; subject_ref = <dept>:<fp>:<day>; title + body unchanged
//   2. same set, sent 1 / 6 days ago → suppressed; sent 7 / 8 days ago → re-sent (weekly)
//   3. set changes: an item added → sent the same day; an item cleared with others left → sent the same day
//   4. per member: a new officer with no history gets it while the others are suppressed
//   5. a legacy ref (<dept>:<day>, no fingerprint) yesterday → one summary in the new format
//   6. the Brush 26 replay: 15 consecutive days, unchanged set, each day's would-be rows fed back as history →
//      sent on day 0, 7 and 14 only (3 days, not 15); fingerprint stable; nothing overdue → nothing sent; and 328b918's
//      pulse, on the same replay, sends on all 15 days (the test catches the old behaviour)
//   7. history unreadable → detect:maint (500 per cron honesty), no maint summary guessed
//   8. fences: files changed vs 328b918 are exactly api/pulse.js, this test and the tz test's fence pin; api/digest.js (the weekly email),
//      api/_cron.js, vercel.json, shared/, sql/ untouched; verified 132/32/14; Notify held
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "328b918";   // main after the timezone hotfix (gate PASS @328b918)

if (process.env.MAINT_RENAG_CHILD !== "1") {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: "UTC", MAINT_RENAG_CHILD: "1" }, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { build } = await import("esbuild");
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

Object.assign(process.env, { PULSE_ENABLED: "1", SUPABASE_URL: "https://x.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "svc-test-key", CRON_SECRET: "s3cret-cron-value-0123456789abcdef" });
delete process.env.PUSH_ENABLED;
const FAKE_SB = `
export function createClient() {
  const S = globalThis.__S;
  const q = (t) => new Proxy({}, { get(_, k) {
    if (k === "then") return (r, j) => Promise.resolve(S.fail[t] ? { data: null, error: { message: S.fail[t] }, status: 500 }
                                                                   : { data: S.tables[t] || [], error: null, status: 200, count: (S.tables[t] || []).length }).then(r, j);
    if (k === "maybeSingle" || k === "single") return async () => ({ data: (S.tables[t] || [])[0] || null, error: null });
    if (k === "insert" || k === "upsert" || k === "update" || k === "delete") return () => { S.writes++; return q(t); };
    return () => q(t);
  } });
  return { from: (t) => q(t), rpc: async (n) => ({ data: n === "is_muted" ? false : [], error: null }) };
}`;
globalThis.fetch = async () => { throw new Error("no network in this test"); };

const outDir = mkdtempSync(join(tmpdir(), "b4c-maintrenag-"));
const out = join(outDir, "pulse.mjs");
await build({ entryPoints: [join(root, "api/pulse.js")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{ name: "fake-sb", setup(b) {
    b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onLoad({ filter: /^sb$/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
  } }] });
const handler = (await import(pathToFileURL(out).href)).default;
// The pre-slice pulse (328b918), for the "the test catches the old behaviour" check.
const outBase = join(outDir, "pulse-base.mjs");
await build({ stdin: { contents: execSync(`git show ${BASE}:api/pulse.js`, { cwd: root, maxBuffer: 1 << 26 }).toString(), resolveDir: join(root, "api"), sourcefile: "pulse.js", loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: outBase, logLevel: "silent",
  plugins: [{ name: "fake-sb", setup(b) {
    b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onLoad({ filter: /^sb$/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
  } }] });
const baseHandler = (await import(pathToFileURL(outBase).href)).default;

const RealDate = Date;
let FAKE_NOW = 0;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FAKE_NOW); else super(...a); }
  static now() { return FAKE_NOW; }
};

const D = "d-nhc";
const RADIO = { id: "mt-radio", department_id: D, task: "Radio Not Working", cadence: "Weekly", last_done_at: "2026-10-11T05:01:41Z", apparatus: { name: "Brush 26", deleted_at: null } };
const PUMP = { id: "mt-pump", department_id: D, task: "Pump test", cadence: "Monthly", last_done_at: "2026-09-01T12:00:00Z", apparatus: { name: "Engine 20", deleted_at: null } };
const CURRENT = { id: "mt-ok", department_id: D, task: "Tires", cadence: "Annual", last_done_at: "2026-10-30T12:00:00Z", apparatus: { name: "Tanker 2", deleted_at: null } };
const LEADERS = [
  { id: "m-da", department_id: D, status: "Active", access: ["Department Admin"] },
  { id: "m-off1", department_id: D, status: "Active", access: ["Officer"] },
  { id: "m-off2", department_id: D, status: "Active", access: ["Officer"] },
];
const MEMBER = { id: "m-ff", department_id: D, status: "Active", access: ["Member"] };   // not an ops leader: never gets it

// noon Central on a given day (18:00Z in CST): same calendar date in UTC and Central, so the date math is unambiguous
const noonCT = (iso) => `${iso}T18:00:00Z`;
const addDays = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); const t = new RealDate(RealDate.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };

async function run(dayISO, { maint = [RADIO, CURRENT], members = [...LEADERS, MEMBER], history = [], fail = {}, h = handler } = {}) {
  FAKE_NOW = RealDate.parse(noonCT(dayISO));
  globalThis.__S = { writes: 0, fail, tables: {
    apparatus_maintenance: maint, members, notifications: history,
    departments: [{ id: D, week_start_day: 1 }],
  } };
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
  const log = console.log, err = console.error; console.log = () => {}; console.error = () => {};
  try { await h({ method: "GET", query: { dry: "1" }, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, res); }
  finally { console.log = log; console.error = err; }
  const rows = (res.body?.would || []).filter((w) => w.type === "maint_summary");
  return { code: res.code, body: res.body, rows, to: rows.map((r) => r.member_id).sort(), refs: [...new Set(rows.map((r) => r.subject_ref))],
           summary: res.body?.diag?.maintSummary?.[D], failed: res.body?.failed || [], detectErrors: res.body?.detectErrors || [] };
}
// what a real (non-dry) run would have written, as history rows
const asHistory = (r, dayISO) => r.rows.map((w) => ({ member_id: w.member_id, department_id: D, type: "maint_summary", subject_ref: w.subject_ref, created_at: noonCT(dayISO) }));
const sentFor = (fp, day, ids = LEADERS.map((l) => l.id)) => ids.map((id) => ({ member_id: id, department_id: D, type: "maint_summary", subject_ref: `${D}:${fp}:${day}`, created_at: noonCT(day) }));

const T = "2026-11-11";
const LEADER_IDS = LEADERS.map((l) => l.id).sort();

// ---------------------------------------------------------------- 1. first summary
const first = await run(T);
const FP = first.refs[0]?.split(":")[1];
ok("first: no history → every ops leader (3) gets one, the plain member does not", JSON.stringify(first.to) === JSON.stringify(LEADER_IDS), JSON.stringify(first.to));
ok("first: subject_ref = <dept>:<12-hex fingerprint>:<Central day>", first.refs.length === 1 && new RegExp(`^${D}:[0-9a-f]{12}:${T}$`).test(first.refs[0]), first.refs[0]);
ok("first: title + body unchanged (\"1 maintenance item overdue\" / \"Brush 26 · Radio Not Working\"), severity critical",
  first.rows.every((r) => r.title === "1 maintenance item overdue" && r.body === "Brush 26 · Radio Not Working" && r.severity === "critical"), JSON.stringify(first.rows[0]));
ok("first: why names the reason (first)", first.rows.every((r) => /\(first\)$/.test(r.why)), first.rows[0]?.why);
ok("first: a dry run writes nothing", first.code === 200 && globalThis.__S.writes === 0, String(first.code));

// ---------------------------------------------------------------- 2. same set: suppressed inside the week, weekly after
for (const [ago, expectSent] of [[1, false], [6, false], [7, true], [8, true]]) {
  const r = await run(T, { history: sentFor(FP, addDays(T, -ago)) });
  ok(`same set, last sent ${ago} day(s) ago → ${expectSent ? "re-sent (weekly) to all 3" : "suppressed for all 3"}`,
    expectSent ? (JSON.stringify(r.to) === JSON.stringify(LEADER_IDS) && r.rows.every((w) => /\(weekly\)$/.test(w.why)) && r.refs[0] === `${D}:${FP}:${T}`)
               : (r.rows.length === 0 && r.summary?.suppressedSameSetThisWeek === 3 && r.summary?.fanOut === 0),
    `${r.rows.length} rows ${JSON.stringify(r.summary)}`);
}
{ // the same set again TODAY (an hourly re-run) → nothing new
  const r = await run(T, { history: sentFor(FP, T) });
  ok("same set already sent today (hourly re-run) → nothing", r.rows.length === 0);
}

// ---------------------------------------------------------------- 3. set changes
{
  const r = await run(T, { maint: [RADIO, PUMP, CURRENT], history: sentFor(FP, addDays(T, -1)) });
  const fp2 = r.refs[0]?.split(":")[1];
  ok("set change (an item added) → sent the same day to all 3, new fingerprint, \"2 maintenance items overdue\"",
    JSON.stringify(r.to) === JSON.stringify(LEADER_IDS) && fp2 && fp2 !== FP && r.rows.every((w) => w.title === "2 maintenance items overdue" && /\(set-changed\)$/.test(w.why)),
    `${fp2} ${r.rows[0]?.title}`);
  const back = await run(T, { maint: [RADIO, CURRENT], history: sentFor(fp2, addDays(T, -1)) });
  ok("set change (one cleared, one left) → sent the same day, fingerprint back to the one-item set",
    JSON.stringify(back.to) === JSON.stringify(LEADER_IDS) && back.refs[0] === `${D}:${FP}:${T}`, back.refs[0]);
  const order = await run(T, { maint: [CURRENT, PUMP, RADIO] });
  ok("fingerprint ignores row order (same set, different read order → same fingerprint)", order.refs[0]?.split(":")[1] === fp2, order.refs[0]);
}

// ---------------------------------------------------------------- 4. per member
{
  const r = await run(T, { history: sentFor(FP, addDays(T, -2), ["m-da", "m-off1"]) });
  ok("per member: an officer with no history (m-off2) gets it; the two inside their week do not", JSON.stringify(r.to) === '["m-off2"]' && r.summary?.suppressedSameSetThisWeek === 2, JSON.stringify(r.to));
}

// ---------------------------------------------------------------- 5. legacy refs
{
  const legacy = LEADERS.map((l) => ({ member_id: l.id, department_id: D, type: "maint_summary", subject_ref: `${D}:${addDays(T, -1)}`, created_at: noonCT(addDays(T, -1)) }));
  const r = await run(T, { history: legacy });
  ok("legacy ref (<dept>:<day>, no fingerprint) yesterday → one summary in the new format", JSON.stringify(r.to) === JSON.stringify(LEADER_IDS) && r.refs[0] === `${D}:${FP}:${T}`, r.refs[0]);
  const after = await run(addDays(T, 1), { history: [...legacy, ...asHistory(r, T)] });
  ok("…and the day after that, the new-format row governs: suppressed", after.rows.length === 0);
}

// ---------------------------------------------------------------- 6. the Brush 26 replay
{
  const start = "2026-11-02";
  let history = [];
  const sentDays = [];
  const fps = new Set();
  for (let i = 0; i < 15; i++) {
    const day = addDays(start, i);
    const r = await run(day, { history });
    if (r.rows.length) { sentDays.push(i); r.refs.forEach((x) => fps.add(x.split(":")[1])); history = [...history, ...asHistory(r, day)]; }
  }
  ok("Brush 26 replay: 15 days, unchanged set → sent on days 0, 7 and 14 only (was every day)", JSON.stringify(sentDays) === "[0,7,14]", JSON.stringify(sentDays));
  ok("Brush 26 replay: one fingerprint throughout; 9 pushes in 15 days instead of 45 (3 leaders)", fps.size === 1 && history.length === 9, `${fps.size} fp, ${history.length} rows`);
  let baseDays = 0, baseHistory = [];
  for (let i = 0; i < 15; i++) {
    const day = addDays(start, i);
    const r = await run(day, { history: baseHistory, h: baseHandler });
    if (r.rows.length) { baseDays++; baseHistory = [...baseHistory, ...asHistory(r, day)]; }
  }
  ok(`the test catches the old behaviour: ${BASE}'s pulse sends the same replay on all 15 days`, baseDays === 15, String(baseDays));
  const none = await run(T, { maint: [CURRENT], history });
  ok("nothing overdue → nothing sent, fingerprint null", none.rows.length === 0 && none.summary?.fingerprint === null && none.summary?.overdueItems === 0, JSON.stringify(none.summary));
}

// ---------------------------------------------------------------- 7. history unreadable
{
  const r = await run(T, { fail: { notifications: "permission denied for table notifications" } });
  // The fake fails the whole notifications table, so the DB probe and the drain fail too ("db", "drain"); what matters
  // here is that the maint family is named as failed and nothing was composed from a guessed history.
  ok("history unreadable → detect:maint named in a 5xx (cron honesty), no maint summary composed",
    r.code >= 500 && r.failed.includes("detect:maint") && r.rows.length === 0 && !(r.body?.would || []).some((w) => w.type === "maint_summary"),
    `${r.code} ${JSON.stringify(r.failed)}`);
}
globalThis.Date = RealDate;

// ---------------------------------------------------------------- 8. fences
const sh = (c) => execSync(c, { cwd: root }).toString().trim();
const changed = [...new Set([...sh(`git diff --name-only ${BASE}`).split("\n"), ...sh("git ls-files --others --exclude-standard -- api shared src docs/review sql vercel.json").split("\n")])].filter(Boolean).sort();
// + pulse_event_tz_test.mjs: its working-tree fence pinned to its released range (cae3f78..328b918), fence lines only.
ok("files changed vs 328b918 are exactly api/pulse.js, this test, and the tz test's fence pin",
  JSON.stringify(changed) === JSON.stringify(["api/pulse.js", "docs/review/maint_renag_test.mjs", "docs/review/pulse_event_tz_test.mjs"]), JSON.stringify(changed));
ok("weekly email untouched: api/digest.js, shared/maint-due.js byte-identical; api/_cron.js, vercel.json, sql/ untouched",
  sh(`git diff --name-only ${BASE} -- api/digest.js shared api/_cron.js vercel.json sql`) === "");
const tok = (p) => (readFileSync(join(root, p), "utf8").match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified counts: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
