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

  /* ---- DETECTION GOES HERE (slice 3+) ---------------------------------------------------------
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
  const candidates = [];

  const scoped = onlyMember ? candidates.filter((c) => c.member_id === onlyMember) : candidates;

  // Mute enforcement is slice 5. Stated here so the seam is obvious and nobody adds a send path
  // upstream of it: every candidate must survive is_muted(member_id, family) before it becomes a row.
  const deliverable = scoped;

  /* NO WRITE AND NO SEND IN THIS SLICE. Not "skipped because isDry" — absent. insertNotifications
     and sendPush are not imported, so no flag mistake and no future edit to the dry-path can cause
     this build to reach a phone. Slice 3 adds the write; the send path arrives with a drain. */
  const report = {
    enabled: true,
    slice: "2-skeleton",
    scope,
    dry: isDry,
    note: "Skeleton only: no detection, no writes, no push. Nothing here is capable of sending.",
    counts: { candidates: candidates.length, afterScope: scoped.length, deliverable: deliverable.length },
    would: deliverable.map((c) => ({
      member_id: c.member_id, family: c.family, type: c.type, subject_ref: c.subject_ref, why: c.why,
    })),
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
