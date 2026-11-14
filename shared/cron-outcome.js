/* CRON HONESTY — a scheduled run whose work failed must not answer 200.

   Both crons used to catch every failure, keep going, fold the error into the JSON body and return 200 regardless.
   Vercel's cron monitoring only sees the status code, so a run that read nothing, wrote nothing and sent nothing
   looked identical to a healthy one. (From 2026-10-17 ~20:00Z every pulse run logged db=unreachable and wrote
   nothing, and every one returned 200.)

   These two functions turn what a run observed into { status, failed[] }:
     - status 200 with an empty failed[] means the work happened. The handler returns its usual body, unchanged.
     - Anything else is a 5xx. The handler logs the details (Vercel logs) and answers with a TERSE body naming the
       failed steps: no secrets, no stack traces, no database messages, no member data.
   Auth never reaches here. requireCron (api/_cron.js, untouched) answers 401 / 500 before any work, and only WORK
   failures become a 5xx.

   Step names are a fixed vocabulary, so a monitor or a person can read the body without the code. */

/** pulse: any step failing fails the run. Pulse is hourly and idempotent (writes de-dupe on (member_id, type,
 *  subject_ref)), so the next tick retries everything. A partial run is still reported as a failure: the
 *  families that failed sent nothing, and silence is the bug this exists to remove. */
export function pulseOutcome({ dbError = null, detectErrors = [], muteErrors = [], writeError = null, pushErrors = [], pushEnabled = false } = {}) {
  const failed = [];
  if (dbError) failed.push("db");
  for (const e of detectErrors) failed.push(`detect:${e.family}`);
  if (muteErrors.length) failed.push("mute-check");      // failed CLOSED (treated as muted), still a failed read
  if (writeError) failed.push("write");
  for (const e of pushErrors) {
    if (e.drain) failed.push("drain");
    else if (e.stamp) failed.push("stamp");
    else if (e.error) failed.push("push");
    else if (e.skipped && pushEnabled) failed.push("push-config");   // push is ON but cannot send (no FCM credentials)
  }
  const uniq = [...new Set(failed)];
  // 503 when the database itself could not be reached: the run could not even look. 500 for any other failed step.
  return { status: uniq.length === 0 ? 200 : dbError ? 503 : 500, failed: uniq };
}

/** digest: the PROPOSED rule (B4C cron-honesty writeup).
 *  - core detection read failed → 502 "detection-read" (no digest can be built; unchanged status, terse body)
 *  - any department's email failed to send → 500 "send", EVEN IF OTHERS WENT. Partial is a failure: a Department
 *    Admin who didn't get their weekly digest is the job failing for them, and the digest is weekly, so nothing
 *    retries. The body names the departments that did NOT get it (names only), plus the sent count, so a re-send
 *    can be targeted. Vercel crons don't retry, so a 5xx never causes a duplicate send.
 *  - the member list failed to read → 500 "members-read": nobody to send to, so every department is in `skipped`.
 *  - a degraded read (metrics / duties / hours) → 500 "metrics-read" / "duties-read" / "iso-hours". The emails still
 *    went out with "—" tiles; the run is reported failed because the DB failed. (Since the member list was split out
 *    of the metrics read, "still went out" is true — before that, a metric failure also blanked the recipients.)
 *  - the B4C library read failed → 500 "library-read". Like metrics, the emails still went, just without the
 *    "New in the B4C library this week" line (Library S3).
 *  - the weekly AI drill read failed → 500 "weekly-read". The emails still went, without the "waiting for an
 *    officer's review" line (Weekly Training Content slice 7).
 *  - a department's notification rows or push failed → 500 "notify" / "push" / "push-config".
 *  - NOT failures: a department deliberately skipped (no active DA email — config, already listed in `skipped`), a
 *    quiet week, per-device FCM rejections (delivery outcomes, counted in push.failed), and a dry run's unsent mail. */
export function digestOutcome({ detectionError = null, membersError = null, metricsError = null, dutiesError = null, isoErrors = [], libraryError = null, weeklyError = null, results = [], pushEnabled = false } = {}) {
  if (detectionError) return { status: 502, failed: ["detection-read"], sent: 0, notSent: [] };
  const failed = [];
  if (membersError) failed.push("members-read");
  if (metricsError) failed.push("metrics-read");
  if (dutiesError) failed.push("duties-read");
  if (isoErrors.length) failed.push("iso-hours");
  if (libraryError) failed.push("library-read");
  if (weeklyError) failed.push("weekly-read");
  for (const r of results) {
    const n = r.notified;
    if (n && n.error) failed.push("notify");
    else if (n && n.push && n.push.error) failed.push("push");
    else if (n && n.push && n.push.skipped && pushEnabled) failed.push("push-config");
  }
  const notSent = results.filter((r) => !r.dryRun && r.error).map((r) => r.name);
  if (notSent.length) failed.push("send");
  const sent = results.filter((r) => !r.dryRun && !r.error && r.sentTo).length;
  const uniq = [...new Set(failed)];
  return { status: uniq.length ? 500 : 200, failed: uniq, sent, notSent };
}

/** weekly-drill (Weekly Training Content slice 7; Step 0 §5.6): the weekly AI drill draft. Hourly inside a Monday
 *  00:00–05:00 UTC window, idempotent per department-week, so the next slot retries whatever failed.
 *  - db → 503: a read the run needs failed (the opted-in departments, this week's existing drafts, or the seed). Nothing
 *    was spent: no backstop count, no model call, no write.
 *  - gen:<n> → 500: n departments' generations failed this slot (provider error, network, a malformed reply, an input
 *    refusal). Each wrote nothing and is retried next slot.
 *  - write → 500: put_weekly_drill_draft errored for a department.
 *  - cap → 500: the department backstop refused (or could not be checked, failing closed). Reported, not retried in
 *    this slot; the model was not called.
 *  - NOT failures: a department toggled off at write time ("disabled"), one that already has this week's draft
 *    ("exists", found before any spend), a slot where everyone is done (200, no model call), a dry run, and departments
 *    "deferred" past this slot's per-run limit (the next slot takes them).
 *  The body is counts and step names only: no prompts, no model text, no provider messages, no department names. */
export function weeklyDrillOutcome({ dbError = null, results = [], deferred = 0 } = {}) {
  const n = (o) => results.filter((r) => r.outcome === o).length;
  const counts = { departments: results.length + deferred, inserted: n("inserted"), exists: n("exists"), disabled: n("disabled"), deferred };
  if (dbError) return { status: 503, failed: ["db"], ...counts };
  const failed = [];
  if (n("gen")) failed.push(`gen:${n("gen")}`);
  if (n("write")) failed.push("write");
  if (n("cap")) failed.push("cap");
  return { status: failed.length ? 500 : 200, failed, ...counts };
}
