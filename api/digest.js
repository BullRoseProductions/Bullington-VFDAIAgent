// Vercel serverless function — email digest: detect what needs attention, compose, send.
//
// Runs weekly from Vercel Cron (see vercel.json), which calls this path with
// `Authorization: Bearer ${CRON_SECRET}` — the same gate a browser satisfies with ?secret=.
// A real run mails each department's own Department Admins. Adding ?to= makes it a TEST SEND:
// one address, never the real admins, and it renders even when nothing is flagged.
// Adding ?dry=1 makes it a DRY RUN: everything is read, grouped, measured and RENDERED, but the two
// outbound effects — the email and the push/notification write — are skipped, and the composed
// { subject, html } comes back in the JSON instead. Without it there is no way to see what a REAL
// broadcast contains, because ?to= both changes the render (testMode) and actually sends.
// The two compose: ?dry=1 alone previews the real broadcast; ?to=x&dry=1 previews the test render.
//
// Env (Vercel → Settings → Environment Variables):
//   CRON_SECRET               — request gate (Bearer header from Cron, or ?secret= in a browser)
//   RESEND_API_KEY            — sending
//   SUPABASE_URL              — server-side project URL (NOT the VITE_-prefixed one; those are
//                               build-time inlined into the browser bundle and are absent here)
//   SUPABASE_SERVICE_ROLE_KEY — bypasses RLS so one run can read every department
//
// Service role means NO RLS. Department scoping is this file's job: every row is grouped by its own
// department_id and composed into that department's email. Nothing crosses departments.
import { createClient } from "@supabase/supabase-js";
import { buildNotifications, insertNotifications, sendPush } from "./_push.js";

const DEFAULT_TO = "ashlea@bullroseproductions.com";
const FROM = "B4C <notifications@b4thecall.com>";
// Gmail strips data: URIs, so the logo MUST be an absolute https URL to a public asset.
// public/b4c-email-logo.png ships with the app and is served at the site root.
const APP_URL = process.env.VITE_APP_URL || process.env.APP_URL || "https://app.b4thecall.com";
const LOGO_URL = `${APP_URL}/b4c-email-logo.png`;
// Brand tokens lifted from FIRE in App.jsx:30 so the email reads as the same product as the screen.
const C = {
  shell: "#0A0C0F", card: "#13161B", hairline: "rgba(255,255,255,.08)",
  text: "#F7F8FA", secondary: "#B6BDC8", muted: "#7E8794",
  red: "#C8323A", redText: "#E58A90", amber: "#D6A95E", green: "#76C98D",
};
const CERT_WINDOW_DAYS = 60;
const GEAR_WINDOW_DAYS = 90;
const MAINT_WINDOW_DAYS = 14;
const MAINT_CADENCE_DAYS = { Weekly: 7, Monthly: 30, Quarterly: 90, Annual: 365 };   // mirrors MAINT_CADENCE_DAYS in App.jsx
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;

// A department with nothing flagged sends no email at all (slice 2 rule). Metrics alone don't trigger a send.
// Flip to true if the summary is worth mailing on a quiet week.
const SEND_WHEN_NOTHING_FLAGGED = false;

// Notification rows + push stay OFF until a device test confirms delivery. Set PUSH_ENABLED=1 in
// Vercel to turn them on; the email digest is completely unaffected either way.
const PUSH_ENABLED = process.env.PUSH_ENABLED === "1";
// Who gets ops notifications (gear, maintenance) — mirrors CANMANAGE_OPS_ROLES in App.jsx:88:
// Department Admin + Officer. Board Member is governance-only and is deliberately NOT buzzed
// about a pump test; Project Admin is excluded by countsInStats anyway.
const OPS_LEADER_ROLES = ["Department Admin", "Officer"];

// Notification copy. Addressed to the RECIPIENT: a cert row goes to the member who holds it,
// so it reads in second person; ops rows go to leaders and name the asset instead.
function notifTextFor(it) {
  if (it.kind === "cert_expired")  return { title: "Certification expired",  body: `Your ${it.cert} ${it.state}.` };
  if (it.kind === "cert_expiring") return { title: "Certification expiring", body: `Your ${it.cert} ${it.state}.` };
  if (it.kind === "gear_retire")   return { title: "Gear past service life", body: `${it.item} — retire it.` };
  if (it.kind === "gear_retiring") return { title: "Gear nearing retirement", body: `${it.item} ${it.state}.` };
  if (it.kind === "maint_overdue") return { title: "Maintenance overdue",    body: `${it.apparatus} · ${it.task} is overdue.` };
  return { title: "Maintenance due", body: `${it.apparatus} · ${it.task} — ${it.state}.` };
}

/* STATS_EXCLUDED_IDS — MUST stay in sync with App.jsx:1152. These three accounts (owner, test, demo)
   plus anyone holding Project Admin are excluded from every denominator on screen. If the digest
   counted them, its percentages would silently disagree with the dashboard the chief is looking at. */
const STATS_EXCLUDED_IDS = new Set([
  "0ad3dc98-5af3-4ae5-8c04-f7902e0cf7c4",  // Ashlea (owner)
  "02c4a728-9d58-4e58-89b4-4f277aad2272",  // test account
  "fc4a1a0f-f885-4ca9-baf9-ce47eb47448f",  // Demo Account (test@b4c.com)
]);
const countsInStats = (m) => !STATS_EXCLUDED_IDS.has(m.id) && !(Array.isArray(m.access) && m.access.includes("Project Admin"));

/* ---------------- Station Duties week window ----------------
   The digest reports the WEEK THAT JUST ENDED: [Monday 00:00, next Monday 00:00) in local time.

   Anchored to the week boundary rather than "the last 168 hours" on purpose. Cron fires Monday 12:00
   UTC, but a retry, a cold start or a manual re-run hours later would otherwise slide the window and
   report a different set of rows for the same week.

   TIMEZONE. Hardcoded Central, because both current departments are Central and the alternative is a
   schema round-trip for a value nobody differs on yet. It matters: done_at is timestamptz, so a duty
   completed Sunday 8pm Central is Monday 02:00 UTC — bucketing in UTC would push it into the NEXT
   week and disagree with the in-app History screen, which buckets in the browser's local time.

   TODO (second department): replace DIGEST_TZ with a per-department departments.timezone column.
   Track alongside the existing week_start_day item — the Monday cron likewise ignores a department
   that starts its week on another day. Both are "when a non-Central / non-Monday department joins". */
const DIGEST_TZ = "America/Chicago";

// Offset of `tz` from UTC at a given instant, in ms. Derived from Intl rather than hardcoded so DST
// is handled by the platform's tz database instead of by us.
function tzOffsetMs(instant, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).reduce((a, x) => (x.type === "literal" ? a : (a[x.type] = x.value, a)), {});
  // hour can format as "24" for midnight in some ICU builds — normalise before arithmetic.
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - instant;
}
// The UTC instant of local midnight on a given calendar date in `tz`. Two passes because the offset
// itself depends on the instant: the first guess picks the wrong side of a DST change twice a year.
function zonedMidnightUtc(y, m, d, tz) {
  const wall = Date.UTC(y, m - 1, d, 0, 0, 0);
  let ts = wall - tzOffsetMs(wall, tz);
  ts = wall - tzOffsetMs(ts, tz);
  return new Date(ts);
}
function digestWeekWindow(now, tz = DIGEST_TZ) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).reduce((a, x) => (x.type === "literal" ? a : (a[x.type] = x.value, a)), {});
  const y = +p.year, m = +p.month, d = +p.day;
  // Pure calendar arithmetic on the LOCAL date — no instant involved, so no tz skew here.
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();       // 0 Sun … 6 Sat
  const sinceMonday = (dow + 6) % 7;                              // Mon → 0, Sun → 6
  const endCal   = new Date(Date.UTC(y, m - 1, d - sinceMonday));      // Monday of the run's week
  const startCal = new Date(Date.UTC(y, m - 1, d - sinceMonday - 7));  // the Monday before that
  const weekEnd   = zonedMidnightUtc(endCal.getUTCFullYear(), endCal.getUTCMonth() + 1, endCal.getUTCDate(), tz);
  const weekStart = zonedMidnightUtc(startCal.getUTCFullYear(), startCal.getUTCMonth() + 1, startCal.getUTCDate(), tz);
  return { weekStart, weekEnd, tz };
}

/* ---------------- Station Duties rollup ----------------
   CREDITS, not rows. One duty completed by three people is three credits, because the point of the
   section is recognising who turned up.

   Checklist  → the primary done_by AND every member in helper_ids.
   Other work → done_by_member_id when set, else the free-text done_by label (same precedence the app
                uses: the uuid is authoritative, the snapshotted text is the fallback and the only
                attribution a visitor or a whole crew can have).

   countsInStats is applied to BOTH the people list and the total, so the list always sums to the
   total — consistent with every other figure in this digest. A credit whose member is excluded is
   dropped entirely rather than folded into an "other" bucket, which would make the sum lie.
   `rowsRead` is reported separately so an excluded-heavy week is diagnosable rather than mysterious. */
function rollupDuties(dutyRows, otherRows, countedIds, memberNameById) {
  const tally = new Map();   // key → { name, memberId, duties, other, total }
  const credit = (key, name, memberId, kind) => {
    if (!tally.has(key)) tally.set(key, { name, memberId, duties: 0, other: 0, total: 0 });
    const t = tally.get(key);
    t[kind] += 1; t.total += 1;
  };
  for (const r of dutyRows) {
    for (const id of [r.done_by, ...(Array.isArray(r.helper_ids) ? r.helper_ids : [])]) {
      if (!id || !countedIds.has(id)) continue;
      credit(`m:${id}`, memberNameById.get(id) || "Unknown member", id, "duties");
    }
  }
  for (const r of otherRows) {
    if (r.done_by_member_id) {
      if (!countedIds.has(r.done_by_member_id)) continue;                       // excluded member → drop
      credit(`m:${r.done_by_member_id}`, memberNameById.get(r.done_by_member_id) || "Unknown member", r.done_by_member_id, "other");
    } else {
      const label = (r.done_by || "").trim() || "A member";                     // no member record: text is all there is
      credit(`t:${label.toLowerCase()}`, label, null, "other");
    }
  }
  const people = [...tally.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    rowsRead: { duties: dutyRows.length, other: otherRows.length },
    credits: { duties: people.reduce((n, p) => n + p.duties, 0), other: people.reduce((n, p) => n + p.other, 0) },
    total: people.reduce((n, p) => n + p.total, 0),
    people,
  };
}

/* ---------------- date helpers ----------------
   Dates are parsed FIELD-BY-FIELD, never new Date(str): "2016-05-01" through the string parser is
   UTC midnight, which is the previous day in every US timezone. Same reasoning as gearStatus in App.jsx. */
const startOfToday = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const fmtMonYear = (d) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const daysBetween = (from, to) => Math.round((to - from) / DAY_MS);

// A cert's `exp` is 'YYYY-MM' and means end of that month — new Date(y, m, 0) is the last day of month m.
function certExpiryEnd(exp) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(exp || ""));
  if (!m) return null;                                    // no/garbled date → NOT flagged; an absent value must never read as an expired one
  const d = new Date(Number(m[1]), Number(m[2]), 0);
  return isNaN(d.getTime()) ? null : d;
}
// Gear retirement = manufacture_date + service_life_years. Mirrors gearStatus's math exactly.
function gearRetireDate(manufactureDate, serviceLifeYears) {
  const yrs = Number(serviceLifeYears);
  if (!manufactureDate || !Number.isFinite(yrs) || yrs <= 0) return null;   // missing either half → skip, we don't know
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(manufactureDate));
  if (!m) return null;
  const d = new Date(Number(m[1]) + yrs, Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function parseDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/* ---------------- detection ----------------
   Each loader returns a flat array of flagged items carrying their own department_id; grouping happens once, after. */
async function detectCerts(sb, today) {
  const { data, error } = await sb.from("certs").select("id, department_id, member_id, name, exp, members(name)");
  if (error) throw new Error(`certs read failed: ${error.message}`);
  const cutoff = addDays(today, CERT_WINDOW_DAYS);
  return (data || []).flatMap((r) => {
    const end = certExpiryEnd(r.exp);
    if (!end || !r.department_id || end > cutoff) return [];
    const expired = end < today;
    return [{
      department_id: r.department_id,
      subject_ref: r.id,                                    // stable identity for notification de-dupe
      member_id: r.member_id,                               // the person who has to renew it
      kind: expired ? "cert_expired" : "cert_expiring",
      sort: end.getTime(),
      member: r.members?.name || "Unknown member",
      cert: r.name || "Unnamed cert",
      state: expired ? `expired ${fmtMonYear(end)}` : `expires ${fmtMonYear(end)}`,
      urgent: expired,
    }];
  });
}
async function detectGear(sb, today) {
  const { data, error } = await sb.from("equipment")
    .select("id, department_id, serial_number, manufacture_date, equipment_type(name, service_life_years)");
  if (error) throw new Error(`equipment read failed: ${error.message}`);
  const cutoff = addDays(today, GEAR_WINDOW_DAYS);
  return (data || []).flatMap((r) => {
    const retire = gearRetireDate(r.manufacture_date, r.equipment_type?.service_life_years);
    if (!retire || !r.department_id || retire > cutoff) return [];
    const past = retire <= today;
    const type = r.equipment_type?.name || "Equipment";
    return [{
      department_id: r.department_id,
      subject_ref: r.id,
      kind: past ? "gear_retire" : "gear_retiring",
      sort: retire.getTime(),
      item: r.serial_number ? `${type} #${r.serial_number}` : type,
      state: past ? "RETIRE" : `retires ${fmtMonYear(retire)}`,
      urgent: past,
    }];
  });
}
async function detectMaintenance(sb, today) {
  const { data, error } = await sb.from("apparatus_maintenance")
    .select("id, department_id, task, cadence, last_done_at, apparatus(name)");
  if (error) throw new Error(`apparatus_maintenance read failed: ${error.message}`);
  return (data || []).flatMap((r) => {
    if (!r.department_id) return [];
    const interval = MAINT_CADENCE_DAYS[r.cadence] || 30;
    const last = parseDateOnly(r.last_done_at);
    const nextDue = last ? addDays(last, interval) : null;      // null last_done_at → never done → overdue
    const overdue = !nextDue || nextDue < today;
    if (!overdue) {
      if (daysBetween(today, nextDue) > MAINT_WINDOW_DAYS) return [];
    }
    return [{
      department_id: r.department_id,
      subject_ref: r.id,
      kind: overdue ? "maint_overdue" : "maint_due",
      sort: overdue ? -1 : daysBetween(today, nextDue),
      apparatus: r.apparatus?.name || "All units",           // rig_id is nullable — a task can apply to every unit
      task: r.task || "Maintenance task",
      state: overdue ? "overdue" : `due in ${daysBetween(today, nextDue)}d`,
      urgent: overdue,
    }];
  });
}

/* ---------------- metrics ----------------
   Every metric returns null when the department has no data to compute it from — null renders as "—".
   A zero would be a claim ("0% of certs are current"); "—" is the truth ("nothing to measure yet"). */

// Cert rank, mirroring certStatus in App.jsx: 0 expired, 1 expiring (≤3 months), 2 current.
// A missing/garbled exp returns null and is excluded from the denominator — same as the app's "NO DATE".
function certRank(exp, today) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(exp || ""));
  if (!m) return null;
  const diff = (Number(m[1]) * 12 + Number(m[2])) - (today.getFullYear() * 12 + today.getMonth() + 1);
  return diff < 0 ? 0 : diff <= 3 ? 1 : 2;
}
function certsCurrentPct(certRows, countedIds, today) {
  const ranks = certRows.filter((c) => countedIds.has(c.member_id)).map((c) => certRank(c.exp, today)).filter((r) => r !== null);
  if (!ranks.length) return null;                                   // no dated certs on counted members → "—"
  return Math.round(100 * ranks.filter((r) => r === 2).length / ranks.length);
}

// Training compliance, mirroring deptAttendance (App.jsx:1162) for the current calendar year.
// Eligible sessions: done, inside the year, at least one attendance row, and counting toward the rate
// (restricted leadership/board events and optional sessions are excluded — countsTowardRate, App.jsx:106).
// The department figure is the MEAN OF PER-MEMBER PERCENTAGES, not a pooled ratio — the app's definition.
function trainingCompliancePct(sessions, attendance, countedMembers, year) {
  const attendedBy = new Map();                                     // session_id → Set(member_id)
  for (const a of attendance) {
    if (!attendedBy.has(a.session_id)) attendedBy.set(a.session_id, new Set());
    attendedBy.get(a.session_id).add(a.member_id);
  }
  const eligible = sessions.filter((s) => {
    if (!s.done) return false;
    if (String(s.date || "").slice(0, 4) !== String(year)) return false;
    if (s.audience === "leadership" || s.audience === "board") return false;
    if (s.counts_toward_attendance === false) return false;
    return (attendedBy.get(s.id)?.size || 0) > 0;                   // a session with no roll taken is not a denominator
  });
  if (!eligible.length || !countedMembers.length) return null;      // nothing held (or nobody counted) → "—"
  const pcts = countedMembers.map((m) => 100 * eligible.filter((s) => attendedBy.get(s.id)?.has(m.id)).length / eligible.length);
  return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
}

// Shift duration from the two timestamps — station_presence stores no hours column.
// Date.parse IS correct here (unlike the date-only fields above): these are timestamptz values carrying an
// explicit offset, so there is no local-vs-UTC midnight ambiguity to get wrong.
// A shift that can't be parsed, or that ends before it starts, is DROPPED rather than credited — bad data
// must not quietly move a figure that gets reported to an outside body.
function shiftHours(s) {
  const a = Date.parse(s.checked_in_at), b = Date.parse(s.checked_out_at);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return (b - a) / 3600000;
}
// Station presence rollup — mirrors the app's own derivation at App.jsx:6304-6323 exactly:
//   • only CLOSED shifts count (an open one has no duration to credit)
//   • VERIFIED-ONLY CREDIT: unverified time lands in its own bucket and is never folded into the credited
//     figure, because that figure is what gets reported to ISO/LOSAP
//   • kind splits credited time into training vs standby ("standby is the only other surfaced kind")
//   • verifiedPct is the share of check-in EVENTS verified, not of hours
// Totals are summed raw and rounded once at the end, matching h1() (App.jsx:6327) — rounding per row would drift.
const h1 = (n) => Math.round(n * 10) / 10;
function stationMetrics(rows, countedIds) {
  const mine = rows.filter((s) => countedIds.has(s.member_id));
  let standby = 0, training = 0, unverified = 0, vTrue = 0, n = 0;
  for (const s of mine) {
    const hrs = shiftHours(s);
    if (hrs === null) continue;
    n += 1;
    if (!s.verified) unverified += hrs;                             // recorded, not credited
    else if (s.kind === "training") training += hrs;
    else standby += hrs;
    if (s.verified) vTrue += 1;
  }
  if (!n) return { credited: null, standby: null, training: null, unverified: null, verifiedPct: null };
  return {
    credited: h1(standby + training),
    standby: h1(standby),
    training: h1(training),
    unverified: h1(unverified),
    verifiedPct: Math.round(100 * vTrue / n),
  };
}

/* ---------------- compose ----------------
   Table-based, inline-styled, 600px — the shape every email client renders predictably.
   Flex/grid and <style> blocks are deliberately avoided: Outlook drops them. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const byWorstFirst = (a, b) => a.sort - b.sort;

function section(title, items, lineFor) {
  if (!items.length) return "";                                        // omit empty sections entirely
  const rows = [...items].sort(byWorstFirst).map((it) => {
    const color = it.urgent ? C.redText : C.amber;                     // same red/amber vocabulary as the app's badges
    return `<tr><td style="padding:7px 0;border-top:1px solid ${C.hairline};font-size:14px;color:${C.secondary};line-height:1.45">
      ${lineFor(it)} <span style="color:${color};font-weight:700">${esc(it.state)}</span></td></tr>`;
  }).join("");
  return `<tr><td style="padding:22px 24px 0">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.red};font-weight:700">${esc(title)}
        <span style="color:${C.muted};font-weight:400">(${items.length})</span></div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">${rows}</table>
    </td></tr>`;
}

// "—" for anything with no data behind it. A 0% would assert something false; a dash says "not measured yet".
const dash = (v, suffix = "") => (v === null || v === undefined ? "&mdash;" : `${esc(v)}${suffix}`);
function metricsBlock(m) {
  const tiles = [
    ["Training", dash(m.trainingPct, "%")],
    ["Certs current", dash(m.certsPct, "%")],
    ["Station hrs", dash(m.station.credited)],
    ["Verified", dash(m.station.verifiedPct, "%")],
    ["Apparatus", m.apparatus.total === null ? "&mdash;" : `${esc(m.apparatus.inService)}/${esc(m.apparatus.total)}`],
  ];
  const tds = tiles.map(([label, value]) => `<td width="20%" align="center" style="padding:12px 4px;background:${C.card};border:1px solid ${C.hairline};border-radius:10px">
      <div style="font-size:19px;font-weight:700;color:${C.text};line-height:1.1">${value}</div>
      <div style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};margin-top:4px">${esc(label)}</div>
    </td>`).join(`<td width="6"></td>`);
  // Unverified hours sit OUTSIDE the credited figure — shown, never added in.
  const note = m.station.unverified
    ? `<div style="font-size:11.5px;color:${C.amber};margin-top:8px">${esc(m.station.unverified)} h unverified &mdash; recorded, not credited toward ISO/LOSAP.</div>` : "";
  return `<tr><td style="padding:20px 24px 0">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};font-weight:700;margin-bottom:8px">Readiness at a glance</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tds}</tr></table>${note}
    </td></tr>`;
}

function compose(deptName, groups, metrics, { testMode } = {}) {
  const total = groups.certs.length + groups.gear.length + groups.maint.length;
  const subject = `B4C — ${deptName}: ${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`;
  const headline = `${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`;
  const testBanner = testMode
    ? `<tr><td style="padding:12px 24px 0"><div style="background:rgba(214,169,94,.12);border:1px solid ${C.amber};border-radius:8px;padding:9px 12px;font-size:12px;color:${C.amber}">
        TEST MODE &mdash; preview sent to the test address, not to ${esc(deptName)}'s admins.</div></td></tr>` : "";
  const html = `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(headline)} &mdash; ${esc(deptName)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.shell};margin:0;padding:0">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.shell};border:1px solid ${C.hairline};border-radius:14px;overflow:hidden;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
      <tr><td style="padding:22px 24px 18px;border-bottom:1px solid ${C.hairline}">
        <img src="${LOGO_URL}" width="132" alt="B4C — Before the Call" style="display:block;border:0;outline:none;text-decoration:none;height:auto">
      </td></tr>
      <tr><td style="padding:20px 24px 0">
        <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${C.red};font-weight:700">Weekly digest</div>
        <div style="font-size:19px;font-weight:700;color:${C.text};margin-top:5px;line-height:1.3">${esc(deptName)}</div>
        <div style="font-size:14px;color:${C.secondary};margin-top:3px">${esc(headline)}.</div>
      </td></tr>
      ${testBanner}
      ${metricsBlock(metrics)}
      ${section("Certifications", groups.certs, (it) => `${esc(it.member)} &middot; ${esc(it.cert)} &middot;`)}
      ${section("Gear retirement", groups.gear, (it) => `${esc(it.item)} &middot;`)}
      ${section("Maintenance", groups.maint, (it) => `${esc(it.apparatus)} &middot; ${esc(it.task)} &middot;`)}
      <tr><td style="padding:24px 24px 4px">
        <a href="${APP_URL}" style="display:inline-block;background:${C.red};color:#fff;font-size:14px;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px">Open B4C &rarr;</a>
      </td></tr>
      <tr><td style="padding:20px 24px 24px">
        <div style="border-top:1px solid ${C.hairline};padding-top:14px;font-size:11.5px;color:${C.muted};line-height:1.6">
          Before the Call &middot; &copy; 2026 Big Bull Technologies, LLC. All rights reserved.<br>
          You're receiving this because you're a Department Admin for ${esc(deptName)}.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>`;
  return { subject, html };
}

/* ---------------- send ---------------- */
// Recipients for a REAL send: active Department Admins of that one department, same exclusions as the
// stats, deduped by lowercased email. Scoping by department_id is what keeps one department's roster out
// of another's inbox now that service-role has removed RLS from the picture.
function deptAdminEmails(members, deptId) {
  const out = new Set();
  for (const m of members) {
    if (m.department_id !== deptId) continue;
    if (m.status !== "Active") continue;                              // inactive admins don't get mail
    if (!countsInStats(m)) continue;                                  // owner/test/demo + Project Admin
    if (!Array.isArray(m.access) || !m.access.includes("Department Admin")) continue;
    const e = String(m.email || "").trim().toLowerCase();
    if (e) out.add(e);
  }
  return [...out];
}

async function sendEmail(key, recipients, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: FROM, to: recipients, subject, html }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data === "object" ? JSON.stringify(data) : String(data));
  return data?.id;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "Missing CRON_SECRET" });   // fail closed — no secret configured, no sends
  }
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = bearer || req.query?.secret || "";
  if (provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const resendKey = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    !resendKey && "RESEND_API_KEY",
    !supabaseUrl && "SUPABASE_URL",
    !serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({ error: `Missing ${missing.join(", ")}` });
  }

  // An explicit ?to= is a MANUAL TEST SEND: it always renders, even for a department with nothing flagged,
  // so the layout and the "—" fallbacks can be eyeballed on a quiet week. Without ?to= (how Cron will call
  // it) SEND_WHEN_NOTHING_FLAGGED governs, so a real broadcast still stays silent when there's nothing to say.
  const isTestSend = !!req.query?.to;
  // Explicit allow-list rather than !!req.query.dry, so ?dry=0 does NOT silently enable a dry run —
  // the failure mode of a truthy "0" here is someone believing they previewed when they broadcast.
  const isDry = ["1", "true", "yes", "on"].includes(String(req.query?.dry ?? "").toLowerCase());
  const to = req.query?.to || DEFAULT_TO;
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });   // no session server-side → no authFetch refresh wrapper
  const today = startOfToday();
  const week = digestWeekWindow(new Date());   // the week that just ended, [Mon 00:00, Mon 00:00) Central

  let certs, gear, maint, depts;
  try {
    [certs, gear, maint, depts] = await Promise.all([
      detectCerts(sb, today),
      detectGear(sb, today),
      detectMaintenance(sb, today),
      sb.from("departments").select("id, name").then(({ data, error }) => {
        if (error) throw new Error(`departments read failed: ${error.message}`);
        return data || [];
      }),
    ]);
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e?.message || e) });   // a failed READ is never an empty digest
  }

  // Group by department — the only thing standing in for RLS now.
  const nameById = new Map(depts.map((d) => [d.id, d.name || "Unknown department"]));
  const byDept = new Map();
  const bucket = (id) => {
    if (!byDept.has(id)) byDept.set(id, { certs: [], gear: [], maint: [] });
    return byDept.get(id);
  };
  for (const c of certs) bucket(c.department_id).certs.push(c);
  for (const g of gear) bucket(g.department_id).gear.push(g);
  for (const m of maint) bucket(m.department_id).maint.push(m);
  // byDept is built FROM flagged items, so a department with nothing flagged never appears here at all.
  // When every department must be considered anyway (a manual test send, or a broadcast configured to go
  // out on a quiet week), seed an empty bucket for each one — otherwise the send loop has nothing to walk.
  if (isTestSend || SEND_WHEN_NOTHING_FLAGGED) for (const d of depts) bucket(d.id);

  const year = today.getFullYear();
  const monthStart = new Date(year, today.getMonth(), 1);
  const monthEnd = new Date(year, today.getMonth() + 1, 1);       // [first of month, first of next) — the whole month

  // Metric inputs — deliberately NON-FATAL, unlike the detection reads above. If this block fails the
  // summary degrades to "—" and the digest still goes out; it never blocks the items that need attention.
  // station_presence is read DIRECTLY: the service-role key already bypasses RLS, so no RPC is needed —
  // the app's RPCs exist only because a browser client has to be walled off by my_department_id().
  let mi = { members: [], sessions: [], attendance: [], certRows: [], apparatus: [], shifts: [], error: null };
  try {
    const rs = await Promise.all([
      sb.from("members").select("id, department_id, access, email, status"),
      sb.from("training_sessions").select("id, department_id, date, done, audience, counts_toward_attendance"),
      sb.from("session_attendance").select("session_id, member_id"),
      sb.from("certs").select("department_id, member_id, exp"),
      sb.from("apparatus").select("department_id, in_service"),
      sb.from("station_presence").select("department_id, member_id, checked_in_at, checked_out_at, verified, kind")
        .not("checked_out_at", "is", null)                        // closed shifts only — an open one has no duration
        .gte("checked_in_at", monthStart.toISOString())
        .lt("checked_in_at", monthEnd.toISOString()),
    ]);
    const bad = rs.find((r) => r.error);
    if (bad) throw new Error(bad.error.message);
    const [m, s, a, c, ap, sp] = rs.map((r) => r.data || []);
    mi = { members: m, sessions: s, attendance: a, certRows: c, apparatus: ap, shifts: sp, error: null };
  } catch (e) {
    mi.error = String(e?.message || e);   // surfaced in the response so a silent all-"—" digest is diagnosable
  }

  // Station Duties activity for the reported week. NON-FATAL, like metrics and unlike the detection
  // reads: a duty_log hiccup must never stop a digest that has real expiries to report. On failure
  // both arrays stay empty and du.error surfaces in the response, so a silent empty section is
  // diagnosable rather than mysterious.
  let du = { dutyLog: [], stationLog: [], error: null };
  try {
    const rs = await Promise.all([
      sb.from("duty_log")
        .select("department_id, duty_name, done_by, helper_ids, done_at")
        .gte("done_at", week.weekStart.toISOString()).lt("done_at", week.weekEnd.toISOString()),
      sb.from("station_log")
        .select("department_id, what, done_by, done_by_member_id, done_at")
        .gte("done_at", week.weekStart.toISOString()).lt("done_at", week.weekEnd.toISOString()),
    ]);
    const bad = rs.find((r) => r.error);
    if (bad) throw new Error(bad.error.message);
    du = { dutyLog: rs[0].data || [], stationLog: rs[1].data || [], error: null };
  } catch (e) {
    du.error = String(e?.message || e);
  }
  // Member names for attribution. nameById above maps DEPARTMENT ids; this is a separate map.
  const memberNameById = new Map((mi.members || []).map((m) => [m.id, m.name]));

  const results = [];
  const skipped = [];                                        // departments deliberately not mailed, with the reason — never silent
  let total = 0;
  for (const [deptId, groups] of byDept) {
    const counts = { certs: groups.certs.length, gear: groups.gear.length, maintenance: groups.maint.length };
    const n = counts.certs + counts.gear + counts.maintenance;
    if (n === 0 && !SEND_WHEN_NOTHING_FLAGGED && !isTestSend) continue;   // nothing to report → silent, unless this is a test send
    total += n;
    const name = nameById.get(deptId) || "Unknown department";

    // Per-department metrics. countsInStats mirrors App.jsx so these percentages match the dashboard.
    const counted = mi.members.filter((m) => m.department_id === deptId && countsInStats(m));
    const countedIds = new Set(counted.map((m) => m.id));
    // D4b: JSON only. compose() is deliberately NOT given this yet — the rendered email must stay
    // byte-identical this slice; the visible section is D4c.
    const dutiesWeek = rollupDuties(
      du.dutyLog.filter((r) => r.department_id === deptId),
      du.stationLog.filter((r) => r.department_id === deptId),
      countedIds, memberNameById);
    const deptApparatus = mi.apparatus.filter((a) => a.department_id === deptId);
    const metrics = {
      trainingPct: trainingCompliancePct(mi.sessions.filter((s) => s.department_id === deptId), mi.attendance, counted, year),
      certsPct: certsCurrentPct(mi.certRows.filter((c) => c.department_id === deptId), countedIds, today),
      station: stationMetrics(mi.shifts.filter((s) => s.department_id === deptId), countedIds),
      apparatus: {
        total: deptApparatus.length || null,                  // no apparatus on file → "—", not "0 of 0"
        inService: deptApparatus.filter((a) => a.in_service !== false).length,   // null counts as in service, matching App.jsx:6789
      },
    };
    // TEST MODE goes to the one test address and NEVER to real admins; a real run resolves that
    // department's own Department Admins. A department with none is skipped and reported, not crashed on.
    // ---- notification rows + push ----
    // Runs BEFORE the email-recipient check on purpose: a department with no admin email address
    // still has members who need their unread badge. Email and notifications fail independently.
    // Never in test mode — a preview send must not write rows or buzz real members' phones.
    let notified = null;
    if (PUSH_ENABLED && !isTestSend && !isDry) {
      try {
        const leaderIds = mi.members
          .filter((m) => m.department_id === deptId && m.status === "Active" && countsInStats(m)
            && Array.isArray(m.access) && m.access.some((r) => OPS_LEADER_ROLES.includes(r)))
          .map((m) => m.id);
        const items = [...groups.certs, ...groups.gear, ...groups.maint].map((it) => ({ ...it, ...notifTextFor(it) }));
        const rows = buildNotifications(items, deptId, leaderIds, countedIds);
        const { inserted, rows: fresh } = await insertNotifications(sb, rows);
        // Push ONLY the genuinely new rows — upsert returns nothing for a de-duped repeat, so a
        // persisting item can't buzz the same phone every single run.
        let push = { sent: 0, failed: 0 };
        if (fresh.length) {
          const { data: devices } = await sb.from("member_devices")
            .select("member_id, token").in("member_id", [...new Set(fresh.map((r) => r.member_id))]);
          const tokensByMember = new Map();
          for (const d of devices || []) {
            if (!tokensByMember.has(d.member_id)) tokensByMember.set(d.member_id, []);
            tokensByMember.get(d.member_id).push(d.token);
          }
          push = await sendPush(sb, fresh, tokensByMember);
        }
        notified = { candidates: rows.length, inserted, push };
      } catch (e) {
        notified = { error: String(e?.message || e) };   // never blocks the email
      }
    }

    const recipients = isTestSend ? [to] : deptAdminEmails(mi.members, deptId);
    if (!recipients.length) {
      skipped.push({ name, reason: mi.error ? `member read failed: ${mi.error}` : "no active Department Admin with an email address" });
      continue;
    }
    const { subject, html } = compose(name, groups, metrics, { testMode: isTestSend });
    // DRY RUN stops here. Everything above ran for real — the same reads, the same grouping, the same
    // n===0 skip, the same recipient resolution, the same render. Only sendEmail is skipped (push was
    // skipped above). `wouldSendTo` is the genuine recipient list a real run would have used, which is
    // half the value of the preview: seeing WHO as well as WHAT.
    if (isDry) {
      results.push({ name, counts, metrics, dutiesWeek, sentTo: null, wouldSendTo: recipients, subject, html, dryRun: true, ...(notified ? { notified } : {}) });
      continue;
    }
    try {
      const id = await sendEmail(resendKey, recipients, subject, html);   // sequential — one Resend call at a time
      results.push({ name, counts, metrics, dutiesWeek, sentTo: recipients, id, ...(notified ? { notified } : {}) });
    } catch (e) {
      results.push({ name, counts, metrics, dutiesWeek, sentTo: null, error: String(e?.message || e), ...(notified ? { notified } : {}) });   // one bad send never hides the rest
    }
  }
  return res.status(200).json({
    ...(isDry ? { dryRun: true, note: "Nothing was emailed and no notifications were written." } : {}),
    week: { start: week.weekStart.toISOString(), end: week.weekEnd.toISOString(), tz: week.tz },
    departments: results, total,
    ...(du.error ? { dutiesError: du.error } : {}),
    ...(skipped.length ? { skipped } : {}),
    ...(mi.error ? { metricsError: mi.error } : {}),
  });
}
