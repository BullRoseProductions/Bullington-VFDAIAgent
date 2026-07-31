// Vercel serverless function — email digest: detect what needs attention, compose, send.
// Slice 2 is TEST MODE: every department's email goes to the test recipient, never to real admins.
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

const DEFAULT_TO = "ashlea@bullroseproductions.com";
const FROM = "B4C <notifications@b4thecall.com>";
const CERT_WINDOW_DAYS = 60;
const GEAR_WINDOW_DAYS = 90;
const MAINT_WINDOW_DAYS = 14;
const MAINT_CADENCE_DAYS = { Weekly: 7, Monthly: 30, Quarterly: 90, Annual: 365 };   // mirrors MAINT_CADENCE_DAYS in App.jsx
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;

// A department with nothing flagged sends no email at all (slice 2 rule). Metrics alone don't trigger a send.
// Flip to true if the summary is worth mailing on a quiet week.
const SEND_WHEN_NOTHING_FLAGGED = false;

/* STATS_EXCLUDED_IDS — MUST stay in sync with App.jsx:1152. These three accounts (owner, test, demo)
   plus anyone holding Project Admin are excluded from every denominator on screen. If the digest
   counted them, its percentages would silently disagree with the dashboard the chief is looking at. */
const STATS_EXCLUDED_IDS = new Set([
  "0ad3dc98-5af3-4ae5-8c04-f7902e0cf7c4",  // Ashlea (owner)
  "02c4a728-9d58-4e58-89b4-4f277aad2272",  // test account
  "fc4a1a0f-f885-4ca9-baf9-ce47eb47448f",  // Demo Account (test@b4c.com)
]);
const countsInStats = (m) => !STATS_EXCLUDED_IDS.has(m.id) && !(Array.isArray(m.access) && m.access.includes("Project Admin"));

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
  const { data, error } = await sb.from("certs").select("department_id, name, exp, members(name)");
  if (error) throw new Error(`certs read failed: ${error.message}`);
  const cutoff = addDays(today, CERT_WINDOW_DAYS);
  return (data || []).flatMap((r) => {
    const end = certExpiryEnd(r.exp);
    if (!end || !r.department_id || end > cutoff) return [];
    const expired = end < today;
    return [{
      department_id: r.department_id,
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
    .select("department_id, serial_number, manufacture_date, equipment_type(name, service_life_years)");
  if (error) throw new Error(`equipment read failed: ${error.message}`);
  const cutoff = addDays(today, GEAR_WINDOW_DAYS);
  return (data || []).flatMap((r) => {
    const retire = gearRetireDate(r.manufacture_date, r.equipment_type?.service_life_years);
    if (!retire || !r.department_id || retire > cutoff) return [];
    const past = retire <= today;
    const type = r.equipment_type?.name || "Equipment";
    return [{
      department_id: r.department_id,
      sort: retire.getTime(),
      item: r.serial_number ? `${type} #${r.serial_number}` : type,
      state: past ? "RETIRE" : `retires ${fmtMonYear(retire)}`,
      urgent: past,
    }];
  });
}
async function detectMaintenance(sb, today) {
  const { data, error } = await sb.from("apparatus_maintenance")
    .select("department_id, task, cadence, last_done_at, apparatus(name)");
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

// Station presence for one department over a window, via the service-role-only RPC.
// VERIFIED-ONLY CREDIT, mirroring App.jsx:6299 — unverified time is reported in its own bucket and is
// NEVER folded into the credited figure, because that figure is what gets reported to ISO/LOSAP.
async function stationMetrics(sb, deptId, from, to, countedIds) {
  const { data, error } = await sb.rpc("dept_station_shifts_for", {
    p_department_id: deptId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) return { error: error.message, credited: null, unverified: null, verifiedPct: null };
  const rows = (data || []).filter((s) => countedIds.has(s.member_id));
  if (!rows.length) return { credited: null, unverified: null, verifiedPct: null };
  let credited = 0, unverified = 0, vTrue = 0;
  for (const s of rows) {
    const hrs = Number(s.hours) || 0;
    if (s.verified) { credited += hrs; vTrue += 1; } else { unverified += hrs; }
  }
  return {
    credited: Math.round(credited * 10) / 10,
    unverified: Math.round(unverified * 10) / 10,
    verifiedPct: Math.round(100 * vTrue / rows.length),             // % of check-in EVENTS verified, not of hours
  };
}

/* ---------------- compose ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const byWorstFirst = (a, b) => a.sort - b.sort;

function section(title, items, lineFor) {
  if (!items.length) return "";                                        // omit empty sections entirely
  const rows = [...items].sort(byWorstFirst).map((it) => {
    const color = it.urgent ? "#B11E2A" : "#9A6B12";                   // same red/amber vocabulary as the app's badges
    return `<li style="margin:0 0 6px;line-height:1.45">${lineFor(it)} <span style="color:${color};font-weight:600">${esc(it.state)}</span></li>`;
  }).join("");
  return `<h2 style="font-size:15px;margin:22px 0 8px;color:#111">${esc(title)} <span style="color:#6A7178;font-weight:400">(${items.length})</span></h2>
    <ul style="margin:0;padding-left:18px;font-size:14px;color:#333">${rows}</ul>`;
}

// "—" for anything with no data behind it. A 0% would assert something false; a dash says "not measured yet".
const dash = (v, suffix = "") => (v === null || v === undefined ? "&mdash;" : `${esc(v)}${suffix}`);
function metricsBlock(m) {
  const cells = [
    ["Training compliance", dash(m.trainingPct, "%")],
    ["Certs current", dash(m.certsPct, "%")],
    ["Station hours credited", dash(m.station.credited, " h")],
    ["Verified presence", dash(m.station.verifiedPct, "%")],
    ["Apparatus in service", m.apparatus.total === null ? "&mdash;" : `${esc(m.apparatus.inService)} of ${esc(m.apparatus.total)}`],
  ];
  const tds = cells.map(([label, value]) => `<td style="padding:8px 10px 8px 0;vertical-align:top">
      <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#6A7178">${esc(label)}</div>
      <div style="font-size:18px;font-weight:700;color:#111;margin-top:2px">${value}</div></td>`).join("");
  // Unverified hours sit OUTSIDE the credited figure — shown, never added in.
  const note = m.station.unverified ? `<p style="margin:6px 0 0;font-size:12px;color:#9A6B12">${esc(m.station.unverified)} h unverified &mdash; recorded, not credited toward ISO/LOSAP.</p>` : "";
  return `<table style="width:100%;border-collapse:collapse;margin:14px 0 4px"><tr>${tds}</tr></table>${note}`;
}

function compose(deptName, groups, metrics) {
  const total = groups.certs.length + groups.gear.length + groups.maint.length;
  const subject = `B4C — ${deptName}: ${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 20px">
    <h1 style="font-size:18px;margin:0 0 4px;color:#111">${esc(deptName)}</h1>
    <p style="margin:0 0 4px;font-size:14px;color:#6A7178">${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention.</p>
    ${metricsBlock(metrics)}
    ${section("Certifications", groups.certs, (it) => `${esc(it.member)} &middot; ${esc(it.cert)} &middot;`)}
    ${section("Gear retirement", groups.gear, (it) => `${esc(it.item)} &middot;`)}
    ${section("Maintenance", groups.maint, (it) => `${esc(it.apparatus)} &middot; ${esc(it.task)} &middot;`)}
    <p style="margin:26px 0 0;padding-top:12px;border-top:1px solid #E5E7EB;font-size:12px;color:#6A7178">
      TEST MODE — this went to the test address, not to ${esc(deptName)}'s admins.</p>
  </div>`;
  return { subject, html };
}

/* ---------------- send ---------------- */
async function sendEmail(key, to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
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
  // ?debug=1 — reports WHICH key shape Vercel is holding without touching Supabase or sending anything.
  // Prefix only, never the key itself: 10 chars distinguishes `sb_secret_` from a legacy `eyJhbGciOi` JWT and reveals nothing usable.
  // Sits after the CRON_SECRET gate but before the missing-vars check, so it can still answer when a var is absent.
  if (req.query?.debug === "1") {
    return res.status(200).json({
      keyPrefix: (serviceKey || "").slice(0, 10) || "MISSING",
      keyLen: (serviceKey || "").length,
      urlPresent: !!supabaseUrl,
      urlPrefix: (supabaseUrl || "").slice(0, 24),
    });
  }
  // ?debug=2 — why a run came back empty. Reads only, sends nothing, returns COUNTS not rows (no names, no PII).
  // Separates the three causes of {"total":0}: rows invisible (key not bypassing RLS), rows present but
  // department_id null (detectors skip those), or rows present and simply nothing inside the date windows.
  if (req.query?.debug === "2" && supabaseUrl && serviceKey) {
    const sb2 = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const countOf = async (table, filter) => {
      let q = sb2.from(table).select("*", { count: "exact", head: true });
      if (filter) q = filter(q);
      const { count, error } = await q;
      return error ? `ERROR: ${error.message}` : count;
    };
    const notNull = (col) => (q) => q.not(col, "is", null);
    const out = {};
    for (const t of ["departments", "members", "certs", "equipment", "equipment_type", "apparatus_maintenance"]) {
      out[t] = { rows: await countOf(t) };
    }
    out.certs.withDept = await countOf("certs", notNull("department_id"));
    out.certs.withExp = await countOf("certs", notNull("exp"));
    out.equipment.withDept = await countOf("equipment", notNull("department_id"));
    out.equipment.withMfgDate = await countOf("equipment", notNull("manufacture_date"));
    out.equipment_type.withServiceLife = await countOf("equipment_type", notNull("service_life_years"));
    out.apparatus_maintenance.withDept = await countOf("apparatus_maintenance", notNull("department_id"));
    out.apparatus_maintenance.neverDone = await countOf("apparatus_maintenance", (q) => q.is("last_done_at", null));
    const today = startOfToday();
    const flagged = {};
    for (const [k, fn] of [["certs", detectCerts], ["gear", detectGear], ["maintenance", detectMaintenance]]) {
      try { flagged[k] = (await fn(sb2, today)).length; } catch (e) { flagged[k] = `ERROR: ${e.message}`; }
    }
    return res.status(200).json({ today: today.toISOString().slice(0, 10), tables: out, flagged });
  }
  const missing = [
    !resendKey && "RESEND_API_KEY",
    !supabaseUrl && "SUPABASE_URL",
    !serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({ error: `Missing ${missing.join(", ")}` });
  }

  const to = req.query?.to || DEFAULT_TO;
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });   // no session server-side → no authFetch refresh wrapper
  const today = startOfToday();

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

  // Metric inputs — deliberately NON-FATAL, unlike the detection reads above. If this block fails the
  // summary degrades to "—" and the digest still goes out; it never blocks the items that need attention.
  let mi = { members: [], sessions: [], attendance: [], certRows: [], apparatus: [], error: null };
  try {
    const rs = await Promise.all([
      sb.from("members").select("id, department_id, access"),
      sb.from("training_sessions").select("id, department_id, date, done, audience, counts_toward_attendance"),
      sb.from("session_attendance").select("session_id, member_id"),
      sb.from("certs").select("department_id, member_id, exp"),
      sb.from("apparatus").select("department_id, in_service"),
    ]);
    const bad = rs.find((r) => r.error);
    if (bad) throw new Error(bad.error.message);
    const [m, s, a, c, ap] = rs.map((r) => r.data || []);
    mi = { members: m, sessions: s, attendance: a, certRows: c, apparatus: ap, error: null };
  } catch (e) {
    mi.error = String(e?.message || e);   // surfaced in the response so a silent all-"—" digest is diagnosable
  }

  const year = today.getFullYear();
  const monthStart = new Date(year, today.getMonth(), 1);
  const monthEnd = new Date(year, today.getMonth() + 1, 1);       // [first of month, first of next) — the whole month

  const results = [];
  let total = 0;
  for (const [deptId, groups] of byDept) {
    const counts = { certs: groups.certs.length, gear: groups.gear.length, maintenance: groups.maint.length };
    const n = counts.certs + counts.gear + counts.maintenance;
    if (n === 0 && !SEND_WHEN_NOTHING_FLAGGED) continue;      // skip departments with nothing to report
    total += n;
    const name = nameById.get(deptId) || "Unknown department";

    // Per-department metrics. countsInStats mirrors App.jsx so these percentages match the dashboard.
    const counted = mi.members.filter((m) => m.department_id === deptId && countsInStats(m));
    const countedIds = new Set(counted.map((m) => m.id));
    const deptApparatus = mi.apparatus.filter((a) => a.department_id === deptId);
    const metrics = {
      trainingPct: trainingCompliancePct(mi.sessions.filter((s) => s.department_id === deptId), mi.attendance, counted, year),
      certsPct: certsCurrentPct(mi.certRows.filter((c) => c.department_id === deptId), countedIds, today),
      station: await stationMetrics(sb, deptId, monthStart, monthEnd, countedIds),
      apparatus: {
        total: deptApparatus.length || null,                  // no apparatus on file → "—", not "0 of 0"
        inService: deptApparatus.filter((a) => a.in_service !== false).length,   // null counts as in service, matching App.jsx:6789
      },
    };
    const { subject, html } = compose(name, groups, metrics);
    try {
      const id = await sendEmail(resendKey, to, subject, html);   // sequential — one Resend call at a time
      results.push({ name, counts, metrics, sentTo: to, id });
    } catch (e) {
      results.push({ name, counts, metrics, sentTo: null, error: String(e?.message || e) });   // one bad send never hides the rest
    }
  }
  return res.status(200).json({ departments: results, total, ...(mi.error ? { metricsError: mi.error } : {}) });
}
