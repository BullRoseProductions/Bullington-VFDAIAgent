// POST /api/expiration-reminders — "Send reminders to flagged members" on the Expirations dashboard (Phase 3.1 #4).
//
// WHO: a Board Member / Department Admin / Officer of the department. Not decided here — the database decides, AS THE
//   CALLER: dept_expirations() is is_canmanage()-gated and department-scoped, so a caller it refuses gets a 403 and
//   nothing is read or sent, and a caller it allows only ever sees their own department's rows.
// WHAT: every flagged item (expired, or expiring within the cert badge's window — shared/expiry.js, so the reminder,
//   the dashboard and the roster badge can't disagree) that belongs to a member — their certs, credentials and
//   assigned gear. Pool gear and apparatus tests have no one person to remind; leadership already sees them on the
//   dashboard. Each member gets ONE notification per flagged item per day (subject_ref = item + today, so a second
//   press the same day restacks nothing — the notifications de-dupe index does it).
// HOW: the EXISTING channel only — api/_push.js insertNotifications() (the in-app inbox) + sendPush() (FCM), behind
//   the same strict PUSH_ENABLED === "1" flag as pulse. Muted families are honoured through is_muted() (certs / gear),
//   failing closed. Push reaches only members on app 2.2+ who allowed notifications; the response says how many.
// NOT api/notify-session.js (the held-back Notify Crew) — nothing is imported from it.
import { createClient } from "@supabase/supabase-js";
import { cors } from "./_cors.js";
import { requireUser } from "./_auth.js";
import { insertNotifications, sendPush } from "./_push.js";
import { expiryBucket, monthIndex } from "../shared/expiry.js";

const TZ = "America/Chicago";
const PUSH_ENABLED = process.env.PUSH_ENABLED === "1";            // same strict flag as pulse / digest
const KIND_LABEL = { license: "License", med_card: "Med card", fit_test: "Fit test", other: "Credential", cert: "Cert", gear: "Gear" };

const todayYMD = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fmtDate = (ymd) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd}T00:00:00Z`));

function compose(row, bucket) {
  const what = `${row.label}${row.cls ? ` (${row.cls})` : ""}`;
  const kind = KIND_LABEL[row.source === "gear" ? "gear" : row.kind] || "Item";
  if (bucket === "expired") {
    return { title: `${kind} expired`, body: `${what} expired ${fmtDate(row.expires_on)}. Please get it renewed and let an officer know.`, severity: "critical" };
  }
  return { title: `${kind} expiring soon`, body: `${what} expires ${fmtDate(row.expires_on)}. Please renew it before then.`, severity: "warning" };
}

/* The pure part — which rows get a reminder and what it says. Exported so it can be tested without a network:
   flagged = expired or expiring-soon on the badge window, owned by a member, with a date. */
export function planReminders(rows, today) {
  const todayYM = monthIndex(today);
  return (rows || [])
    .map((r) => ({ ...r, ui_bucket: expiryBucket(r, todayYM) }))
    .filter((r) => (r.ui_bucket === "expired" || r.ui_bucket === "soon") && r.member_id && r.expires_on)
    .map((r) => ({ ...r, ...compose(r, r.ui_bucket), family: r.source === "gear" ? "gear" : "certs",
                   type: r.source === "gear" ? "gear_reminder" : "cert_reminder", subject_ref: `exp:${r.item_id}:${today}` }));
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

  // ---- AUTHORIZATION + THE ROWS, both from the database AS THE CALLER (their JWT + the anon key) ----
  const jwt = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const asUser = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const [{ data: myDept, error: dErr }, { data: rows, error: eErr }] = await Promise.all([
    asUser.rpc("my_department_id"), asUser.rpc("dept_expirations"),
  ]);
  if (eErr || dErr || !myDept) {
    return res.status(403).json({ error: "Only Board, Department Admins and Officers can send expiration reminders.", detail: (eErr || dErr)?.message });
  }

  const today = todayYMD();
  const flagged = planReminders(rows, today);
  if (!flagged.length) return res.status(200).json({ flagged: 0, members: 0, inserted: 0, push: { enabled: PUSH_ENABLED, sent: 0 }, note: "Nothing expired or expiring soon belongs to a member." });

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // ---- MUTE GATE: is_muted(member, family), fail closed (an error = skip that member, never "not muted") ----
  const familyOf = (r) => r.family;
  const pairs = [...new Set(flagged.map((r) => `${r.member_id}|${familyOf(r)}`))];
  const muted = new Set(); let muteErrors = 0;
  await Promise.all(pairs.map(async (p) => {
    const [member_id, family] = p.split("|");
    const { data, error } = await sb.rpc("is_muted", { p_member: member_id, p_family: family });
    if (error) { muteErrors += 1; muted.add(p); return; }
    if (data === true) muted.add(p);
  }));
  const toSend = flagged.filter((r) => !muted.has(`${r.member_id}|${familyOf(r)}`));

  // type prefix -> the inbox icon (cert / gear); subject_ref = item + today -> once per item per day
  const notifRows = toSend.map((r) => ({ department_id: myDept, member_id: r.member_id, type: r.type, title: r.title, body: r.body, severity: r.severity, subject_ref: r.subject_ref }));

  let inserted = { inserted: 0, rows: [] };
  try { inserted = await insertNotifications(sb, notifRows); }
  catch (e) { return res.status(500).json({ error: "Couldn't record the reminders.", detail: String(e.message || e) }); }

  // ---- PUSH: only the genuinely new rows, only behind PUSH_ENABLED, only to members with a registered device ----
  const push = { enabled: PUSH_ENABLED, sent: 0, failed: 0, members_with_device: 0 };
  if (inserted.rows.length) {
    const memberIds = [...new Set(inserted.rows.map((n) => n.member_id))];
    const { data: devices } = await sb.from("member_devices").select("member_id, token").in("member_id", memberIds);
    const tokensByMember = new Map();
    for (const d of devices || []) {
      if (!tokensByMember.has(d.member_id)) tokensByMember.set(d.member_id, []);
      tokensByMember.get(d.member_id).push(d.token);
    }
    push.members_with_device = memberIds.filter((id) => (tokensByMember.get(id) || []).length).length;
    const sendable = inserted.rows.filter((n) => (tokensByMember.get(n.member_id) || []).length);
    if (PUSH_ENABLED && sendable.length) {
      const r = await sendPush(sb, sendable, tokensByMember);
      Object.assign(push, { sent: r.sent || 0, failed: r.failed || 0 }, r.skipped ? { skipped: r.skipped } : {}, r.error ? { error: r.error } : {});
    }
  }

  return res.status(200).json({
    flagged: flagged.length,
    members: new Set(toSend.map((r) => r.member_id)).size,
    muted: flagged.length - toSend.length,
    mute_check_errors: muteErrors,
    inserted: inserted.inserted,                 // new inbox notifications (a same-day repeat adds 0)
    push,
  });
}
