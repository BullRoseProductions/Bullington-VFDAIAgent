// Vercel serverless function — on-demand "Notify crew" for ONE training session.
//
// RIDES THE LIVE RAILS; ADDS NO NEW SEND CHANNEL.
//   inbox  — a notifications row per recipient, written with the same insertNotifications() pulse uses,
//            deduped by the same (member_id, type, subject_ref) unique index;
//   push   — the same sendPush() (FCM) pulse's drain uses, behind the same PUSH_ENABLED === "1" flag;
//   email  — the same Resend account + FROM the weekly digest uses.
//
// WHO MAY CALL IT. A signed-in user (requireUser) who is a Department Admin by the DATABASE's own gate —
// is_dept_admin() evaluated AS THAT USER — and whose my_department_id() is the session's department. A
// hidden button is not the boundary; this is. Anything else gets 403 and nothing is read about the crew.
//
// WHO HEARS IT. Active members of THAT session's department only, narrowed by the session's audience with
// the same rule pulse's event reminders use (board-only → board, leadership → leaders, else everyone).
// training_sessions has no station column, so there is no per-house narrowing to apply. Then the
// is_muted(member, 'events') gate — FAIL CLOSED: an unreadable preference is treated as muted, and a muted
// member gets NEITHER channel and no inbox row.
//
// DEDUPE. type = event_manual, subject_ref = "<session_id>:manual". A second press inserts nothing, and
// push + email go only to members whose row is NEW this call — so a double-press can't double-send, and
// the key can never collide with pulse's event_24h / event_1h rows ("<id>:<date>").
//
// MODES (query or JSON body):
//   ?dry=1        → nothing written or sent; returns wouldSendTo per channel + the message preview.
//   ?only=self    → audience is the CALLER alone (the self-test). Uses its own subject_ref so a test never
//                   blocks the real send, and can be repeated.
//
// Never touches `verified` or any table other than notifications (insert + pushed_at stamp) and
// member_devices (dead-token prune inside sendPush).
import { createClient } from "@supabase/supabase-js";
import { cors } from "./_cors.js";
import { requireUser } from "./_auth.js";
import { insertNotifications, sendPush } from "./_push.js";
import { LEADERSHIP, BOARD, hasAny } from "../shared/roles.js";
import { zonedInstant } from "../shared/zoned-time.js";

const TZ = "America/Chicago";
const FROM = "B4C <notifications@b4thecall.com>";
const APP_URL = process.env.VITE_APP_URL || process.env.APP_URL || "https://app.b4thecall.com";
const PUSH_ENABLED = process.env.PUSH_ENABLED === "1";            // same strict flag as pulse
const TRUTHY = ["1", "true", "yes", "on"];
const isTruthy = (v) => TRUTHY.includes(String(v ?? "").toLowerCase());
const ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Same audience rule as api/pulse.js (shared role sets, so the two cannot disagree).
const appliesTo = (session, member) =>
  session.audience === "board" ? hasAny(member.access, BOARD)
  : session.audience === "leadership" ? hasAny(member.access, LEADERSHIP)
  : true;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function whenText(sess) {
  const d = new Date(`${sess.date}T12:00:00`);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(d);
  if (!sess.start_time) return day;
  const t = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(zonedInstant(sess.date, sess.start_time));
  return `${day} at ${t}`;
}

function compose(sess, deptName) {
  const when = whenText(sess);
  const title = "Training reminder";
  const body = `${sess.title || "Training"} — ${when}.`;
  const subject = `${sess.title || "Training"} · ${when}`;
  const html = `<!doctype html><html><body style="margin:0;background:#0A0C0F;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0C0F;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#13161B;border:1px solid rgba(255,255,255,.08);border-radius:14px">
<tr><td style="padding:22px 24px">
<img src="${APP_URL}/b4c-email-logo.png" alt="B4C" height="28" style="display:block;height:28px;margin-bottom:16px">
<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#E58A90;font-weight:700">${esc(deptName || "Your department")} · Training</div>
<div style="font-size:22px;font-weight:700;color:#F7F8FA;margin:8px 0 6px">${esc(sess.title || "Training")}</div>
<div style="font-size:15px;color:#B6BDC8">${esc(when)}</div>
<a href="${APP_URL}" style="display:inline-block;margin-top:18px;background:#C8323A;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:9px">Open B4C</a>
<div style="font-size:12px;color:#7E8794;margin-top:18px">You're getting this because your department sent a reminder for this session. You can turn off event reminders in B4C → Notifications.</div>
</td></tr></table></td></tr></table></body></html>`;
  return { title, body, subject, html };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const user = await requireUser(req, res);
  if (!user) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const missing = [!supabaseUrl && "SUPABASE_URL", !serviceKey && "SUPABASE_SERVICE_ROLE_KEY", !anonKey && "SUPABASE_ANON_KEY"].filter(Boolean);
  if (missing.length) return res.status(500).json({ error: `Not configured here: ${missing.join(", ")}`, note: "Nothing was read or sent." });

  const q = { ...(req.query || {}), ...(typeof req.body === "object" && req.body ? req.body : {}) };
  const isDry = isTruthy(q.dry);
  const selfOnly = String(q.only || "") === "self";
  const sessionId = String(q.session_id || "");
  if (!ID_RE.test(sessionId)) return res.status(400).json({ error: "session_id is required" });

  // ---- AUTHORIZATION, evaluated by the database AS THE CALLER (their JWT, the anon key) ----
  const jwt = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const asUser = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const [{ data: isAdmin, error: aErr }, { data: myDept, error: dErr }, { data: myMember, error: mErr }] = await Promise.all([
    asUser.rpc("is_dept_admin"), asUser.rpc("my_department_id"), asUser.rpc("my_member_id"),
  ]);
  if (aErr || dErr || mErr) return res.status(403).json({ error: "Couldn't verify your access.", detail: (aErr || dErr || mErr).message });
  if (isAdmin !== true || !myDept) return res.status(403).json({ error: "Only a Department Admin can notify the crew." });

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: sess, error: sErr } = await sb.from("training_sessions")
    .select("id, department_id, title, date, start_time, audience, done").eq("id", sessionId).maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!sess) return res.status(404).json({ error: "Session not found." });
  if (sess.department_id !== myDept) return res.status(403).json({ error: "That session belongs to another department." });   // never another dept
  if (sess.done) return res.status(400).json({ error: "That session is already complete." });

  const { data: dept } = await sb.from("departments").select("name").eq("id", sess.department_id).maybeSingle();
  const { data: roster, error: rErr } = await sb.from("members")
    .select("id, department_id, access, status, email").eq("department_id", sess.department_id);
  if (rErr) return res.status(500).json({ error: rErr.message });

  let audience = (roster || []).filter((m) => m.department_id === sess.department_id && m.status === "Active" && appliesTo(sess, m));
  if (selfOnly) audience = (roster || []).filter((m) => m.id === myMember && m.department_id === sess.department_id);
  if (selfOnly && !audience.length) return res.status(400).json({ error: "Your member record isn't in this department." });

  // ---- MUTE GATE: is_muted(member, 'events'), fail closed ----
  const muted = new Set(); const muteErrors = [];
  await Promise.all(audience.map(async (m) => {
    const { data, error } = await sb.rpc("is_muted", { p_member: m.id, p_family: "events" });
    if (error) { muted.add(m.id); muteErrors.push({ member_id: m.id, error: error.message }); return; }
    if (data === true) muted.add(m.id);
  }));
  const deliver = audience.filter((m) => !muted.has(m.id));

  const subjectRef = selfOnly ? `${sess.id}:manual:test:${Date.now()}` : `${sess.id}:manual`;
  const type = "event_manual";
  const msg = compose(sess, dept?.name);

  // already notified (the dedupe key) — those members get nothing more
  let already = new Set();
  if (!selfOnly && deliver.length) {
    const { data: prior } = await sb.from("notifications").select("member_id")
      .eq("type", type).eq("subject_ref", subjectRef).in("member_id", deliver.map((m) => m.id));
    already = new Set((prior || []).map((r) => r.member_id));
  }
  const fresh = deliver.filter((m) => !already.has(m.id));

  const { data: devices } = fresh.length
    ? await sb.from("member_devices").select("member_id, token").in("member_id", fresh.map((m) => m.id))
    : { data: [] };
  const tokensByMember = new Map();
  for (const d of devices || []) { if (!tokensByMember.has(d.member_id)) tokensByMember.set(d.member_id, []); tokensByMember.get(d.member_id).push(d.token); }
  const emailable = fresh.filter((m) => EMAIL_RE.test(String(m.email || "").trim()));

  const wouldSendTo = {
    inbox: fresh.length,
    push: PUSH_ENABLED ? { members: fresh.filter((m) => (tokensByMember.get(m.id) || []).length).length, devices: (devices || []).length } : { members: 0, devices: 0, off: "PUSH_ENABLED is not 1 here" },
    email: process.env.RESEND_API_KEY ? emailable.length : 0,
    ...(process.env.RESEND_API_KEY ? {} : { emailOff: "RESEND_API_KEY is not set here" }),
  };
  const summary = { session: { id: sess.id, title: sess.title, when: whenText(sess), audience: sess.audience || "everyone" },
                    mode: selfOnly ? "self-test" : "crew", eligible: audience.length, muted: muted.size, alreadyNotified: already.size,
                    preview: { push: { title: msg.title, body: msg.body }, email: { subject: msg.subject } },
                    ...(muteErrors.length ? { muteErrors, muteNote: "Failed closed: treated as muted." } : {}) };

  if (isDry) return res.status(200).json({ dry: true, wouldSendTo, ...summary });

  // ---- WRITE (inbox rows) ----
  let inserted = [];
  if (fresh.length) {
    try {
      const out = await insertNotifications(sb, fresh.map((m) => ({ department_id: sess.department_id, member_id: m.id, type, title: msg.title, body: msg.body, subject_ref: subjectRef, severity: "info" })));
      inserted = out.rows || [];
    } catch (e) { return res.status(500).json({ error: String(e?.message || e), note: "Nothing was sent." }); }
  }
  const newIds = new Set(inserted.map((r) => r.member_id));   // only members whose row is NEW this call

  // ---- PUSH: claim our own rows atomically (pushed_at IS NULL → now) so pulse's drain can't double-send ----
  const push = { sent: 0, failed: 0, pruned: 0, noDevice: 0 };
  if (PUSH_ENABLED && inserted.length) {
    const { data: claimed, error: cErr } = await sb.from("notifications").update({ pushed_at: new Date().toISOString() })
      .in("id", inserted.map((r) => r.id)).is("pushed_at", null).select("id, member_id, title, body");
    if (cErr) push.error = cErr.message;
    const sendable = (claimed || []).filter((r) => (tokensByMember.get(r.member_id) || []).length);
    push.noDevice = (claimed || []).length - sendable.length;
    if (sendable.length) { const r = await sendPush(sb, sendable, tokensByMember); Object.assign(push, { sent: r.sent || 0, failed: r.failed || 0, pruned: r.pruned || 0 }, r.skipped ? { skipped: r.skipped } : {}, r.error ? { error: r.error } : {}); }
  } else if (!PUSH_ENABLED) push.off = "PUSH_ENABLED is not 1 here — inbox rows left for the normal drain.";

  // ---- EMAIL: one message per recipient (Resend batch), only to members with a NEW row ----
  const email = { sent: 0, failed: 0 };
  const key = process.env.RESEND_API_KEY;
  const toEmail = emailable.filter((m) => newIds.has(m.id));
  if (!key) email.off = "RESEND_API_KEY is not set here";
  else {
    for (let i = 0; i < toEmail.length; i += 100) {
      const chunk = toEmail.slice(i, i + 100);
      const r = await fetch("https://api.resend.com/emails/batch", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(chunk.map((m) => ({ from: FROM, to: [String(m.email).trim().toLowerCase()], subject: msg.subject, html: msg.html }))),
      });
      if (r.ok) email.sent += chunk.length; else { email.failed += chunk.length; email.error = (await r.text().catch(() => "")).slice(0, 300); }
    }
  }

  console.log(`[notify-session] session=${sess.id} dept=${sess.department_id} mode=${summary.mode} inbox=${inserted.length} push=${push.sent} email=${email.sent}`);
  return res.status(200).json({ dry: false, sent: { inbox: inserted.length, push, email }, ...summary });
}
