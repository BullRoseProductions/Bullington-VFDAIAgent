/* PULSE — the hourly, time-sensitive notification run. SKELETON. SENDS NOTHING.
 *
 * Separate from api/digest.js on purpose. The digest is not just detection: it composes and sends
 * admin email, rolls up duty metrics and computes department stats. Running that hourly would mean
 * threading another "but not this time" flag through a function that already has two (isDry,
 * isTestSend) whose interaction cost us a debugging session. Pulse shares the notification helpers
 * in _push.js and nothing else, so the proven weekly path is untouched by anything that happens here.
 *
 * WHAT THIS SLICE CONTAINS: auth, flags, scope resolution, scope logging, and a report. There is no
 * detection and NO SEND PATH — sendPush is deliberately not even imported, because "inert" should be
 * a property of the file rather than a promise about how its flags are set. When slice 3 adds
 * detection, the import arrives with the code that legitimately calls it.
 *
 * ENV
 *   PULSE_ENABLED               must be truthy or this returns immediately. Defaults OFF, so
 *                               deploying the endpoint is not the same as switching it on.
 *   CRON_SECRET                 same secret the digest uses.
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *
 * QUERY
 *   ?dry=1                      compute and report, write nothing, send nothing.
 *   ?only_member=<uuid>         restrict delivery to ONE member. Detection still runs against real
 *                               data; only the recipient set narrows. This is how a real-engine test
 *                               is run without buzzing a roster, and it is why no test department
 *                               and no fake compliance rows are needed.
 */
import { createClient } from "@supabase/supabase-js";

/* ---------------- wall clock -> instant ----------------
   training_sessions stores `date` + `start_time` as a WALL CLOCK with no zone. Read in the server's
   zone (Vercel runs UTC) a 7pm drill becomes 7pm UTC — 1pm Central — and every lead-time window is
   five or six hours wrong. The same bug already cost this project once, in dept_station_shifts,
   which is why the SQL side now hardcodes 'America/Chicago' at four sites.

   Two passes, deliberately. The first offset is computed at the GUESSED instant, which is wrong for
   any wall time that lands near a DST transition; re-deriving the offset at that corrected instant
   settles it. Verified against both 2026 transitions and both standard offsets.

   Hardcoded Central, matching the SQL. When a non-Central department is onboarded this becomes a
   per-department IANA column, here and at the four SQL sites together — they are one decision. */
const TZ = "America/Chicago";

function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - date.getTime();
}

function zonedInstant(dateISO, timeHHMM, tz = TZ) {
  const [Y, M, D] = String(dateISO).split("-").map(Number);
  const [h, m] = String(timeHHMM || "00:00").slice(0, 5).split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m, 0);
  let inst = guess - tzOffsetMs(new Date(guess), tz);
  inst = guess - tzOffsetMs(new Date(inst), tz);
  return new Date(inst);
}

// Today, as the department experiences it. due_date is a plain date, so comparing it against a UTC
// "today" would roll over six hours early and call things overdue on the evening before.
function todayISOIn(tz = TZ, now = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return dtf.format(now);   // en-CA formats as YYYY-MM-DD
}
const addDaysISO = (iso, n) => {
  const [Y, M, D] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D + n));
  return d.toISOString().slice(0, 10);
};

/* ---------------- audience ----------------
   Mirrors rollFor()/isBoard()/isLeader() in App.jsx. A board-only event must not reach the whole
   roster, and a leadership event must not reach every member.

   SOURCE OF TRUTH: App.jsx:88-90 — ROLES / LEADERSHIP / DEPT_ADMIN_ROLES. These literals must equal
   LEADERSHIP (line 89) exactly. They are values of members.access, NOT members.role: `role` holds
   rank labels like Chief and Assistant Chief, which can never appear in an access array and would
   silently match nothing if copied here.

   THIS COPY ALREADY DRIFTED ONCE, before it ever ran: the first version of this file dropped
   "Board Member" and added two rank labels, which would have quietly withheld every leadership-event
   reminder from board members. Nothing would have errored. There would have been no failed run and
   no log line — only notifications that never arrived, discovered whenever somebody happened to
   mention they were not getting them.

   That is the same silent-drift failure as isDoneThisPeriod, and it retires the argument this
   comment used to make — that role literals are safer to duplicate than a date algorithm because
   they "fail loudly". They do not. Slice 3b therefore extracts a shared role-constants module
   (ROLES / LEADERSHIP / BOARD / DEPT_ADMIN) imported by both App.jsx and this file, alongside
   isDoneThisPeriod. Until then these literals are a KNOWN duplicate on borrowed time, kept honest
   only by this comment naming where the original lives. */
const LEADERSHIP_ROLES = ["Project Admin", "Department Admin", "Board Member", "Officer"];   // === App.jsx:89 LEADERSHIP
const BOARD_ROLES = ["Board Member"];                                                        // === App.jsx:99 isBoard
const hasAny = (access, roles) => Array.isArray(access) && access.some((r) => roles.includes(r));
const appliesTo = (session, member) =>
  session.audience === "board" ? hasAny(member.access, BOARD_ROLES)
  : session.audience === "leadership" ? hasAny(member.access, LEADERSHIP_ROLES)
  : true;

// Explicit allow-list rather than a truthiness check, matching the digest's reasoning about ?dry=0:
// the failure mode of a truthy "0" or "false" is someone believing this is off while it is on.
const TRUTHY = ["1", "true", "yes", "on"];
const isTruthy = (v) => TRUTHY.includes(String(v ?? "").toLowerCase());

const PULSE_ENABLED = isTruthy(process.env.PULSE_ENABLED);

// Kept here so slice 3 has one place to add to, and so the value passed to is_muted() can never be a
// literal typed at the call site. is_muted RAISES on an unknown family precisely because a typo would
// otherwise read as "not muted" and silently override somebody's opt-out.
const FAMILIES = ["certs", "gear", "maint", "events", "tasks"];

// Type names are load-bearing UI: the inbox picks its icon from type.split("_")[0]. Anything added
// here needs a matching ICON entry in src/Notifications.jsx or it renders as a generic warning.
const TYPE_PREFIX_BY_FAMILY = { events: "event", tasks: "task" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  /* FLAG FIRST, BEFORE AUTH AND BEFORE ANY DB CONNECTION. A disabled endpoint should be inert even
     to someone holding the cron secret, and it should not open a service-role connection to report
     that it is off. 200 rather than 404: this is a healthy endpoint that is switched off, and a
     monitor should be able to tell that apart from a broken deploy. */
  if (!PULSE_ENABLED) {
    return res.status(200).json({
      enabled: false,
      note: "PULSE_ENABLED is not set. Nothing ran, nothing was written, nothing was sent.",
    });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "Missing CRON_SECRET" });   // fail closed
  }
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = bearer || req.query?.secret || "";
  if (provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [!supabaseUrl && "SUPABASE_URL", !serviceKey && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean);
  if (missing.length) {
    return res.status(500).json({ error: `Missing ${missing.join(", ")}` });
  }

  const isDry = isTruthy(req.query?.dry);

  /* SCOPE. The dangerous default is that no parameter means everyone, so it is resolved once, here,
     and logged — rather than being implied by the absence of a filter somewhere further down. A run
     that loses its filter is then visible in the Vercel log rather than discovered on the roster's
     phones.

     A malformed uuid is REJECTED, not ignored. Ignoring it would silently widen a run that was
     explicitly asked to be narrow, which is the single worst outcome this endpoint can produce. */
  const onlyMemberRaw = req.query?.only_member;
  if (onlyMemberRaw != null && String(onlyMemberRaw).length && !UUID_RE.test(String(onlyMemberRaw))) {
    return res.status(400).json({
      error: "only_member must be a uuid",
      note: "Refusing rather than ignoring it — a bad filter here would silently widen the run to everyone.",
    });
  }
  const onlyMember = onlyMemberRaw ? String(onlyMemberRaw) : null;
  const scope = onlyMember ? `member:${onlyMember}` : "all";

  console.log(`[pulse] scope=${scope} dry=${isDry} families=${FAMILIES.join(",")}`);

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  /* ---- DETECTION -----------------------------------------------------------------------------
     Reads only. Produces candidate rows; nothing here writes or sends.
     -------------------------------------------------------------------------------------------- */
  const nowMs = Date.now();
  const todayISO = todayISOIn();
  const tomorrowISO = addDaysISO(todayISO, 1);

  const detected = [];
  const detectErrors = [];

  /* EVENTS — training sessions at 24h and 1h.

     The windows are RANGES, not instants, and that is what makes an hourly cron correct without
     precise scheduling: the dedupe index (member_id, type, subject_ref) means the first run inside
     a window wins and every later run collides harmlessly. So the 24h reminder actually lands
     somewhere in the hour before T-24h, which is what "about a day's notice" means anyway.

     The bands do not overlap (24h is >1h, 1h is <=1h) so a session created 30 minutes before it
     starts produces ONE notification rather than both at once.

     subject_ref carries the DATE, not just the session id. With a bare id, moving an event would
     collide with the reminder already sent for the old time and the member would never be told it
     had moved — a silent failure that looks like the feature working. */
  try {
    const { data: sessions, error } = await sb
      .from("training_sessions")
      .select("id, department_id, title, date, start_time, audience, done")
      .gte("date", addDaysISO(todayISO, -1))     // -1 day of slack so a late-evening event is never missed by a UTC/Central edge
      .lte("date", addDaysISO(todayISO, 2))
      .eq("done", false);
    if (error) throw new Error(error.message);

    const deptIds = [...new Set((sessions || []).map((s) => s.department_id))];
    let members = [];
    if (deptIds.length) {
      const { data: m, error: mErr } = await sb
        .from("members")
        .select("id, department_id, access, status")
        .in("department_id", deptIds);
      if (mErr) throw new Error(mErr.message);
      members = (m || []).filter((x) => x.status === "Active");   // an inactive member gets no reminders
    }

    for (const sess of sessions || []) {
      const startsAt = zonedInstant(sess.date, sess.start_time);
      const hoursUntil = (startsAt.getTime() - nowMs) / 3_600_000;
      if (hoursUntil <= 0) continue;                              // already started or past

      let type = null, severity = null, why = null;
      if (hoursUntil > 1 && hoursUntil <= 24) { type = "event_24h"; severity = "info"; why = `starts in ${hoursUntil.toFixed(1)}h`; }
      else if (hoursUntil <= 1)               { type = "event_1h";  severity = "warning"; why = `starts in ${Math.round(hoursUntil * 60)}m`; }
      if (!type) continue;

      const localStart = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(startsAt);
      for (const mem of members) {
        if (mem.department_id !== sess.department_id) continue;
        if (!appliesTo(sess, mem)) continue;                      // board-only stays with the board
        detected.push({
          member_id: mem.id,
          department_id: sess.department_id,
          family: "events",
          type,
          subject_ref: `${sess.id}:${sess.date}`,
          title: type === "event_1h" ? "Starting soon" : "Tomorrow",
          body: `${sess.title || "Training"} at ${localStart}.`,
          severity,
          why,
        });
      }
    }
  } catch (e) {
    detectErrors.push({ family: "events", error: String(e?.message || e) });
  }

  /* TASKS — open action items, to the ASSIGNEE only.

     Unassigned items are skipped entirely: there is no one to tell, and defaulting them to
     leadership would turn "nobody picked this up" into a nag aimed at everyone.

     Overdue fires ONCE per item, not once per run, because the dedupe key is stable. An item three
     weeks overdue produced one notification on the day it slipped and stays quiet after — the
     alternative is the thing that trains people to swipe notifications away unread.

     DUTIES ARE NOT HERE, AND THAT IS DELIBERATE — see the note below the loop. */
  try {
    const { data: items, error } = await sb
      .from("action_items")
      .select("id, department_id, text, due_date, status, assigned_to")
      .eq("status", "open")
      .not("assigned_to", "is", null)
      .not("due_date", "is", null)
      .lte("due_date", tomorrowISO);                              // due tomorrow, today, or already past
    if (error) throw new Error(error.message);

    for (const it of items || []) {
      let type, severity, why;
      if (it.due_date < todayISO)          { type = "task_overdue";       severity = "critical"; why = `due ${it.due_date}, now past`; }
      else if (it.due_date === todayISO)   { type = "task_due_today";     severity = "warning";  why = "due today"; }
      else                                 { type = "task_due_tomorrow";  severity = "info";     why = "due tomorrow"; }

      detected.push({
        member_id: it.assigned_to,
        department_id: it.department_id,
        family: "tasks",
        type,
        subject_ref: String(it.id),
        title: type === "task_overdue" ? "Task overdue" : type === "task_due_today" ? "Task due today" : "Task due tomorrow",
        body: it.text || "An assigned task needs attention.",
        severity,
        why,
      });
    }
  } catch (e) {
    detectErrors.push({ family: "tasks", error: String(e?.message || e) });
  }

  /* STATION DUTIES ARE DEFERRED, ON PURPOSE.

     A duty's "done" is PERIOD-RELATIVE: isDoneThisPeriod() in App.jsx reads recurrence, done_at and
     the department's week_start_day, so a Weekly duty completed last week is OPEN again this week
     and a One-off never reopens. Detecting overdue duties by `due_date < today AND NOT done` — the
     obvious implementation — would tell members their duty is overdue on the day after they did it.

     Getting it right means that rule existing here as well as in App.jsx, and the rule's own comment
     forbids exactly that: "it would live in two languages and have to stay in lockstep — the
     certStatus/dept_cert_readiness trap". pa_department_radar already deliberately disagrees with
     it; adding a third definition would make "how many duties are outstanding" a question with
     three answers.

     The right shape is a slice of its own: extract isDoneThisPeriod and its date helpers into a
     module both App.jsx and this file import, then detect duties against the single definition.
     Shipping action items now and duties on that foundation is slower and correct. The audience
     mapping above IS duplicated, which is a judgement call rather than a contradiction: three role
     literals drift visibly and fail loudly, a date algorithm drifts silently. */

  /* ---- (former stub) ---------------------------------------------------------------------------
     Nothing detects yet, so `candidates` is empty and everything downstream reports zero. The shape
     is fixed now so slices 3 and 4 add rows to a list rather than restructuring the endpoint:

       { member_id, family, type, subject_ref, title, body, severity, why }

     `why` is for the dry report only — the human-readable reason a row was produced ("starts in
     under 24h", "due tomorrow") — so a dry run explains itself instead of just listing output.

     Two rules for whoever writes slice 3:
       • subject_ref for session-based types is `${session.id}:${session.date}` — with a bare
         session id, RESCHEDULING an event would collide with the already-sent reminder and the
         member would never hear about the new time.
       • the recipient filter is applied HERE, once, not at send time. onlyMember narrowing the
         recipient list is what makes a real-engine test safe.
     -------------------------------------------------------------------------------------------- */
  const candidates = detected;

  const scoped = onlyMember ? candidates.filter((c) => c.member_id === onlyMember) : candidates;

  // Mute enforcement is slice 5. Stated here so the seam is obvious and nobody adds a send path
  // upstream of it: every candidate must survive is_muted(member_id, family) before it becomes a row.
  const deliverable = scoped;

  /* NO WRITE AND NO SEND IN THIS SLICE. Not "skipped because isDry" — absent. insertNotifications
     and sendPush are not imported, so no flag mistake and no future edit to the dry-path can cause
     this build to reach a phone. Slice 3 adds the write; the send path arrives with a drain. */
  const report = {
    enabled: true,
    slice: "3-detection",
    scope,
    dry: isDry,
    note: "Detection only: candidates are computed and reported. No writes, no push — insertNotifications and sendPush are not imported.",
    counts: { candidates: candidates.length, afterScope: scoped.length, deliverable: deliverable.length },
    // Grouped so a dry run reads as "who gets what and why" rather than a flat list to eyeball.
    byType: deliverable.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {}),
    would: deliverable.map((c) => ({
      member_id: c.member_id, family: c.family, type: c.type,
      subject_ref: c.subject_ref, title: c.title, body: c.body, severity: c.severity, why: c.why,
    })),
    ...(detectErrors.length ? { detectErrors } : {}),
    families: FAMILIES,
    typePrefixes: TYPE_PREFIX_BY_FAMILY,
  };

  // Prove the service-role connection works now rather than discovering it in slice 3 mid-detection.
  try {
    const { error } = await sb.from("notifications").select("id", { count: "exact", head: true }).limit(1);
    report.db = error ? `unreachable: ${error.message}` : "ok";
  } catch (e) {
    report.db = `unreachable: ${String(e?.message || e)}`;
  }

  console.log(`[pulse] done scope=${scope} dry=${isDry} deliverable=${deliverable.length} db=${report.db}`);
  return res.status(200).json(report);
}
