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
// The WRITER only. sendPush stays unimported — this slice must remain incapable of sending.
// insertNotifications already owns the upsert + read-back dance (ignoreDuplicates returns no
// representation, so "what was actually new" has to be read back by created_at); duplicating
// that here would be a second definition of the same subtle thing.
import { insertNotifications, sendPush } from "./_push.js";
// The role vocabulary, shared with the client. See shared/roles.js for why this is not a copy.
import { LEADERSHIP, BOARD, hasAny } from "../shared/roles.js";
// Same definition the duty screens use — see shared/duty-period.js for why this is not a copy.
import { isDoneThisPeriod, periodKey } from "../shared/duty-period.js";

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
   Mirrors rollFor()/isBoard()/isLeader() in App.jsx — and now literally shares their definitions
   rather than restating them. LEADERSHIP and BOARD come from shared/roles.js, which App.jsx also
   imports, so the two cannot disagree.

   The duplicate this replaces had already drifted before it ever executed: it dropped
   "Board Member" and added "Chief"/"Assistant Chief", which are members.role RANK labels that can
   never appear in a members.access array. Every leadership-event reminder would have been silently
   withheld from board members — nothing erroring, nothing logged. */
const appliesTo = (session, member) =>
  session.audience === "board" ? hasAny(member.access, BOARD)
  : session.audience === "leadership" ? hasAny(member.access, LEADERSHIP)
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

  /* DIAGNOSTICS, dry-run only. candidates:0 is ambiguous on its own — it could mean the calendar is
     empty, the window is wrong, every session is already past, or no Active member matched the
     audience. Reporting the intermediate counts turns "nothing happened" into a reason. Populated
     always, emitted only when isDry, so a real run does not dump roster data into a response. */
  const diag = { now: new Date(nowMs).toISOString(), todayISO, tomorrowISO,
                 sessionWindow: [addDaysISO(todayISO, -1), addDaysISO(todayISO, 2)],
                 sessionsScanned: 0, membersLoaded: 0, sessions: [], itemsScanned: 0 };

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
      diag.membersLoaded = members.length;
      diag.membersInDeptsRaw = (m || []).length;                  // if this is >0 while membersLoaded is 0, status is the cause
    }
    diag.sessionsScanned = (sessions || []).length;

    // How many FUTURE sessions carry no start_time at all — i.e. how many are permanently
    // unreachable by lead-time reminders. head:true so this counts without pulling rows.
    const { count: futureTotal } = await sb.from("training_sessions")
      .select("id", { count: "exact", head: true }).gte("date", todayISO);
    const { count: futureNoTime } = await sb.from("training_sessions")
      .select("id", { count: "exact", head: true }).gte("date", todayISO).is("start_time", null);
    diag.futureSessions = { total: futureTotal ?? null, withoutStartTime: futureNoTime ?? null };

    for (const sess of sessions || []) {
      /* NO START TIME = NO REMINDER. zonedInstant coalesces a missing time to 00:00, which invents a
         start nobody scheduled: a session dated tomorrow with no time would read as ~midnight, land
         in the 24h band, and tell every member "Training at 12:00 AM". A lead-time reminder is a
         claim about WHEN something starts, and for these rows we do not know. Skipping is the only
         honest option — the session still exists, still shows on the calendar, and still takes
         attendance; it simply cannot be the subject of a "starts in N hours" push.

         Recorded in diag so these are visible rather than silently absent: a department whose
         sessions never carry times would otherwise look like a broken feature. */
      if (!sess.start_time) {
        diag.sessions.push({
          id: sess.id, date: sess.date, start_time: null, audience: sess.audience, done: sess.done,
          band: "no-start-time",
          note: "skipped — no start_time, so no lead time can be computed without inventing one",
        });
        continue;
      }

      const startsAt = zonedInstant(sess.date, sess.start_time);
      const hoursUntil = (startsAt.getTime() - nowMs) / 3_600_000;

      let type = null, severity = null, why = null;
      if (hoursUntil <= 0)                    { /* already started or past */ }
      else if (hoursUntil > 24)               { /* too far out for either band */ }
      else if (hoursUntil > 1)                { type = "event_24h"; severity = "info"; why = `starts in ${hoursUntil.toFixed(1)}h`; }
      else                                    { type = "event_1h";  severity = "warning"; why = `starts in ${Math.round(hoursUntil * 60)}m`; }

      // Recorded for EVERY session in the window, matched or not — a session that misses both bands
      // is exactly the case that needs explaining, and it is invisible in the candidate list.
      const audienceMatches = members.filter((mm) => mm.department_id === sess.department_id && appliesTo(sess, mm)).length;
      diag.sessions.push({
        id: sess.id, date: sess.date, start_time: sess.start_time, audience: sess.audience, done: sess.done,
        startsAtUTC: startsAt.toISOString(), hoursUntil: Number(hoursUntil.toFixed(2)),
        band: type || (hoursUntil <= 0 ? "past" : "beyond-24h"),
        deptMembersActive: members.filter((mm) => mm.department_id === sess.department_id).length,
        audienceMatches,
      });

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

    diag.itemsScanned = (items || []).length;
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

  /* STATION DUTIES — MEASUREMENT ONLY. Emits nothing.
     Nothing here pushes to `detected`, so no duty can produce a notification row or a push. The
     purpose is to answer two questions with real numbers before emission is enabled, because both
     could make the feature wrong in a way that only shows up on members' phones:

       1. ASSIGNEE COVERAGE. Duties notify the assignee only, matching tasks. But assigned_to is
          nullable and station chores are often left unassigned — if most are, assignee-only
          emission would notify almost nobody, and "duties reminders" would ship as a feature that
          silently does nothing for the department that asked for it.

       2. THE STANDING WEEKLY NAG. A Weekly duty whose due_date has passed is overdue in every
          period from now on, and because subject_ref carries the period it fires ONCE PER WEEK,
          indefinitely, until someone completes it. That may be exactly right for an outstanding
          chore, or it may be the thing that teaches a roster to swipe notifications away unread.
          The count decides it, not an opinion.

     Done-ness uses the shared isDoneThisPeriod, never due_date < today AND NOT done — a weekly
     duty completed last week is open again this week, and the naive form would tell a member their
     duty is overdue the day after they did it. */
  try {
    const { data: duties, error } = await sb
      .from("duties")
      .select("id, department_id, duty, due_date, done, done_at, recurrence, assigned_to");
    if (error) throw new Error(error.message);

    // week_start_day is per department and governs where a Weekly period begins.
    const { data: depts, error: dErr } = await sb.from("departments").select("id, week_start_day");
    if (dErr) throw new Error(dErr.message);
    const wsdByDept = new Map((depts || []).map((d) => [d.id, d.week_start_day ?? 1]));

    const now = new Date(nowMs);
    const d = {
      scanned: (duties || []).length,
      assigned: 0, unassigned: 0,
      withDueDate: 0, withoutDueDate: 0,
      doneThisPeriod: 0, outstanding: 0,
      wouldNotify: { duty_due_tomorrow: 0, duty_due_today: 0, duty_overdue: 0 },
      standingNag: { Weekly: 0, Monthly: 0, Quarterly: 0, "One-off": 0 },
      sample: [],
    };

    for (const row of duties || []) {
      const wsd = wsdByDept.get(row.department_id) ?? 1;
      const done = isDoneThisPeriod(row, wsd, TZ, now);

      if (row.assigned_to) d.assigned += 1; else d.unassigned += 1;
      if (row.due_date) d.withDueDate += 1; else d.withoutDueDate += 1;
      if (done) { d.doneThisPeriod += 1; continue; }
      d.outstanding += 1;

      // What emission WOULD produce: assignee present, due date present, not done this period.
      if (!row.assigned_to || !row.due_date) continue;
      let type = null;
      if (row.due_date < todayISO)        type = "duty_overdue";
      else if (row.due_date === todayISO) type = "duty_due_today";
      else if (row.due_date === tomorrowISO) type = "duty_due_tomorrow";
      if (!type) continue;                        // due further out — nothing fires yet
      d.wouldNotify[type] += 1;

      // The standing-nag count: past due AND recurring means it repeats every period forever.
      if (type === "duty_overdue") {
        const rec = row.recurrence || "One-off";
        if (d.standingNag[rec] !== undefined) d.standingNag[rec] += 1;
      }
      if (d.sample.length < 8) {
        d.sample.push({
          duty: row.duty, recurrence: row.recurrence, due_date: row.due_date, type,
          subject_ref: `${row.id}:${periodKey(row, wsd, TZ, now)}`,
        });
      }
    }
    diag.duties = d;
  } catch (e) {
    detectErrors.push({ family: "duties", error: String(e?.message || e) });
  }

  const candidates = detected;

  /* SCOPE IS APPLIED HERE, ONCE — not at send time. Narrowing the recipient list is what makes a
     real-engine test safe, so it happens before anything downstream can act on a candidate. */
  const scoped = onlyMember ? candidates.filter((c) => c.member_id === onlyMember) : candidates;

  /* ---- MUTE GATE ------------------------------------------------------------------------------
     A muted family produces NO ROW AT ALL, rather than a row suppressed at send time. The inbox is
     the record: a member who opted out of event reminders should not find them waiting there, and
     an unread badge for something they asked not to be told about is the same nuisance the opt-out
     existed to remove.

     Checked through the is_muted RPC rather than by reading notification_prefs directly. Reading the
     table would be one round-trip instead of several, but it would also be a SECOND definition of
     "muted" living in JavaScript — and the last two slices have both turned up a duplicated rule that
     drifted. The RPC is the single definition, including its raise-on-unknown-family guard.

     Batched by collapsing to DISTINCT (member, family) pairs first: a department where forty
     candidates land on twelve members costs twelve or twenty-four checks, not forty. Resolved
     concurrently. If this ever gets hot, the fix is a batch RPC taking arrays — not a local copy of
     the rule. */
  const pairs = [...new Set(scoped.map((c) => `${c.member_id}\u0000${c.family}`))].map((k) => {
    const [member_id, family] = k.split("\u0000");
    return { member_id, family };
  });

  const mutedSet = new Set();
  const muteErrors = [];
  await Promise.all(pairs.map(async ({ member_id, family }) => {
    const { data, error } = await sb.rpc("is_muted", { p_member: member_id, p_family: family });
    if (error) {
      // FAIL CLOSED on an unreadable preference. If we cannot tell whether someone opted out, the
      // safe answer is to say nothing: a missed notification is recoverable, a notification sent to
      // someone who explicitly asked not to receive it is not. is_muted also RAISES on an unknown
      // family, so a typo lands here loudly instead of silently reading as "not muted".
      muteErrors.push({ member_id, family, error: error.message });
      mutedSet.add(`${member_id}\u0000${family}`);
      return;
    }
    if (data === true) mutedSet.add(`${member_id}\u0000${family}`);
  }));

  const deliverable = scoped.filter((c) => !mutedSet.has(`${c.member_id}\u0000${c.family}`));
  const mutedCount = scoped.length - deliverable.length;

  /* ---- WRITE ----------------------------------------------------------------------------------
     Only the columns that exist. `family` and `why` are candidate-only: family is the mute key and
     why is the dry-run explanation, and neither has a column — passing them would fail the insert.
     pushed_at is deliberately not set, so every row lands NULL and slice 5's drain can find it.

     STILL NO SEND. sendPush remains unimported; the only helper brought in is the writer. A row
     appearing in the inbox is the whole of this slice's effect.

     ON CONFLICT DO NOTHING against (member_id, type, subject_ref) is what makes re-running inside
     the same lead-time window harmless — which is the property the hourly cron will depend on. */
  const toWrite = deliverable.map((c) => ({
    department_id: c.department_id,
    member_id: c.member_id,
    type: c.type,
    title: c.title,
    body: c.body,
    subject_ref: c.subject_ref,
    severity: c.severity,
  }));

  let written = 0, deduped = 0, writeError = null;
  if (!isDry && toWrite.length) {
    try {
      const { inserted } = await insertNotifications(sb, toWrite);
      written = inserted;
      deduped = toWrite.length - inserted;   // the rest collided with rows already there
    } catch (e) {
      writeError = String(e?.message || e);
    }
  }

  /* ---- DRAIN --------------------------------------------------------------------------------
     Claims unpushed rows and sends them. Three filters, each load-bearing.

     1. created_at >= now - DRAIN_WINDOW_HOURS.
        Every row that predates the pushed_at column is NULL despite having been pushed by the
        digest, so an unbounded drain would re-push history — weeks-old cert warnings arriving as
        fresh notifications, which is worse than never sending at all. Six hours: comfortably wider
        than the intended hourly cadence so a skipped or slow run still catches up, comfortably
        narrower than a day so nothing stale can resurface. Anything older has missed its moment
        and should stay in the inbox as a record rather than buzzing a phone about a drill that has
        already happened.

     2. type IN (pulse's own types).
        THIS IS THE ONE THAT PREVENTS A DOUBLE-PUSH, and it is not obvious. api/digest.js writes
        notification rows too, and pushes them itself — but it predates pushed_at and never stamps
        it. So every digest row sits at pushed_at IS NULL forever. Without this filter, any pulse
        run inside the window would find the digest's freshly-pushed compliance rows and send them
        a second time. Zero risk today only because PUSH_ENABLED means the digest has never
        written a row; it becomes real the moment that flag goes on. Pulse drains what pulse
        produces. Matching by prefix rather than an explicit list so a new event_/task_ type is
        covered automatically — a list would silently stop pushing whatever nobody remembered to
        add to it.

     3. member_id, when ?only_member is set — so a test drains one person and no one else.

     Ordered oldest-first: if the window ever holds more than one run's worth, the rows that have
     been waiting longest go first. */
  const DRAIN_WINDOW_HOURS = 6;
  const drainSince = new Date(nowMs - DRAIN_WINDOW_HOURS * 3_600_000).toISOString();

  let drained = 0, pushed = 0, pushFailed = 0, pruned = 0, noDevice = 0;
  const pushErrors = [];
  let wouldPush = [];

  try {
    let q = sb.from("notifications")
      .select("id, member_id, type, title, body, created_at")
      .is("pushed_at", null)
      .gte("created_at", drainSince)
      .or("type.like.event_*,type.like.task_*")
      .order("created_at", { ascending: true })
      .limit(500);                                   // a bounded run; leftovers go on the next pass
    if (onlyMember) q = q.eq("member_id", onlyMember);

    const { data: unpushed, error } = await q;
    if (error) throw new Error(error.message);
    drained = (unpushed || []).length;

    if (drained) {
      const memberIds = [...new Set(unpushed.map((r) => r.member_id))];
      const { data: devices, error: dErr } = await sb
        .from("member_devices").select("member_id, token").in("member_id", memberIds);
      if (dErr) throw new Error(dErr.message);

      const tokensByMember = new Map();
      for (const d of devices || []) {
        if (!tokensByMember.has(d.member_id)) tokensByMember.set(d.member_id, []);
        tokensByMember.get(d.member_id).push(d.token);
      }

      const sendable = unpushed.filter((r) => (tokensByMember.get(r.member_id) || []).length > 0);
      const deviceless = unpushed.filter((r) => (tokensByMember.get(r.member_id) || []).length === 0);
      noDevice = deviceless.length;

      wouldPush = unpushed.map((r) => ({
        id: r.id, member_id: r.member_id, type: r.type, title: r.title,
        devices: (tokensByMember.get(r.member_id) || []).length,
      }));

      if (!isDry) {
        if (sendable.length) {
          const res = await sendPush(sb, sendable, tokensByMember);
          pushed = res.sent || 0;
          pushFailed = res.failed || 0;
          pruned = res.pruned || 0;
          if (res.skipped) pushErrors.push({ skipped: res.skipped });
          if (res.error) pushErrors.push({ error: res.error });
        }

        /* STAMP EVERYTHING ATTEMPTED, INCLUDING THE DEVICELESS AND THE FAILED.

           A member with no registered device is stamped deliberately: there is nothing to send, the
           inbox row already IS the record, and leaving it NULL would make it reappear in every
           drain until the window slid past — burning a query per run forever on a member who may
           simply never install the app.

           Failed sends are stamped too, which is a real trade: a transient FCM error loses that
           notification's push. The alternative is retrying, and an unstamped row inside a
           six-hour window would retry on every run for six hours — so a device that is merely
           unreachable gets hammered, and a genuinely dead token is already pruned by sendPush.
           One attempt per notification is the honest contract, and the inbox never loses the row.
           If retry ever matters, it needs an attempt counter, not an unbounded NULL. */
        const stampIds = unpushed.map((r) => r.id);
        const { error: uErr } = await sb.from("notifications")
          .update({ pushed_at: new Date().toISOString() }).in("id", stampIds);
        if (uErr) pushErrors.push({ stamp: uErr.message });
      }
    }
  } catch (e) {
    pushErrors.push({ drain: String(e?.message || e) });
  }

  const report = {
    enabled: true,
    slice: "5-drain",
    scope,
    dry: isDry,
    note: isDry
      ? "Dry run: nothing written, nothing sent. `would` lists rows that would be inserted; `wouldPush` lists rows that would be pushed."
      : "Rows written and unpushed rows drained. pushed counts DEVICE sends, not rows.",
    counts: {
      candidates: candidates.length,     // everything detection found
      afterScope: scoped.length,         // after ?only_member
      muted: mutedCount,                 // dropped by an explicit opt-out — no row created
      deliverable: deliverable.length,   // survived the mute gate
      written,                           // genuinely new rows
      deduped,                           // collided with a row already there — the re-run guard working
      drained,                           // unpushed rows claimed this run
      pushed,                            // FCM accepts — counts DEVICES, not rows (two phones = two)
      noDevice,                          // rows for members with no registered device — stamped, not retried
      pushFailed,                        // FCM rejections
      pruned,                            // dead tokens removed by sendPush
    },
    drainWindowHours: DRAIN_WINDOW_HOURS,
    drainSince,
    ...(pushErrors.length ? { pushErrors } : {}),
    ...(isDry ? { wouldPush } : {}),
    ...(muteErrors.length ? { muteErrors, muteNote: "Failed closed: these were treated as muted rather than risk notifying someone who opted out." } : {}),
    ...(writeError ? { writeError } : {}),
    // Grouped so a dry run reads as "who gets what and why" rather than a flat list to eyeball.
    byType: deliverable.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {}),
    would: deliverable.map((c) => ({
      member_id: c.member_id, family: c.family, type: c.type,
      subject_ref: c.subject_ref, title: c.title, body: c.body, severity: c.severity, why: c.why,
    })),
    ...(detectErrors.length ? { detectErrors } : {}),
    ...(isDry ? { diag } : {}),
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
