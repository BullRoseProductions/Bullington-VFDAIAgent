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

function compose(deptName, groups) {
  const total = groups.certs.length + groups.gear.length + groups.maint.length;
  const subject = `B4C — ${deptName}: ${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px 20px">
    <h1 style="font-size:18px;margin:0 0 4px;color:#111">${esc(deptName)}</h1>
    <p style="margin:0 0 4px;font-size:14px;color:#6A7178">${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention.</p>
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

  const results = [];
  let total = 0;
  for (const [deptId, groups] of byDept) {
    const counts = { certs: groups.certs.length, gear: groups.gear.length, maintenance: groups.maint.length };
    const n = counts.certs + counts.gear + counts.maintenance;
    if (n === 0) continue;                                   // skip departments with nothing to report
    total += n;
    const name = nameById.get(deptId) || "Unknown department";
    const { subject, html } = compose(name, groups);
    try {
      const id = await sendEmail(resendKey, to, subject, html);   // sequential — one Resend call at a time
      results.push({ name, counts, sentTo: to, id });
    } catch (e) {
      results.push({ name, counts, sentTo: null, error: String(e?.message || e) });   // one bad send never hides the rest
    }
  }
  return res.status(200).json({ departments: results, total });
}
