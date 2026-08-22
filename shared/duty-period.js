/* STATION DUTY PERIODS — one definition of "is this duty done for the CURRENT period".
 *
 * Framework-agnostic: no React, no browser globals. Imported by src/App.jsx (the screens) and
 * api/pulse.js (the reminder engine) so the two cannot disagree about whether a duty is outstanding.
 *
 * WHY THIS IS NOT A STRAIGHT COPY OF THE App.jsx ORIGINAL.
 * The original used JavaScript's local-time methods — getDay, getMonth, setHours. In a browser that
 * means the member's device zone; on Vercel it means UTC. Sharing the code verbatim would therefore
 * have produced two different answers from one function, which is the exact failure the original's
 * own comment warns about.
 *
 * Concretely, with week_start_day = 1 (Monday) and a weekly duty completed SUNDAY 7:00 PM Central:
 *   - in Central that Sunday belongs to the week that started the PREVIOUS Monday
 *   - in UTC it is Monday 01:00, which belongs to the week that started THAT Monday
 * So the server would consider the duty done for the current week and stay silent, while the screen
 * showed it outstanding. A member would be marked as owing nothing and told nothing, and no error
 * would ever be raised. Test WEEK_BOUNDARY below is precisely this case.
 *
 * So every period boundary here is computed in an EXPLICIT IANA zone. The zone is a parameter with a
 * Central default, matching the hardcoding already present in api/pulse.js and in the SQL
 * (dept_station_shifts, attested_training). When a non-Central department is onboarded, this default
 * and those SQL sites become one per-department column — they are a single decision, not four.
 *
 * KEY FORMATS CHANGED, HARMLESSLY. The original produced month keys from getMonth() (0-11) and
 * quarters as Q0-Q3. These produce 1-12 and Q1-Q4. Keys are only ever compared against other keys
 * from these same functions and are never stored, so the format is private. Q1-Q4 is used because a
 * key that leaks into a log should not say "Q0".
 */

const DEFAULT_TZ = "America/Chicago";
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad2 = (n) => String(n).padStart(2, "0");

/* An instant, expressed as the calendar date it falls on IN A GIVEN ZONE. Everything below works on
   these civil values with plain integer arithmetic, so no DST transition can shift a boundary: the
   arithmetic never touches an instant again once the civil date is known. */
function civil(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: WD[p.weekday] };
}

/* The date key of the week's first day, in `tz`. startDay follows Date#getDay: 0 = Sunday, 1 = Monday.
   Day subtraction goes through Date.UTC purely as calendar arithmetic — UTC is used BECAUSE it has no
   DST, so "seven days before" is always exactly seven days. */
export function weekStartKey(date, startDay = 1, tz = DEFAULT_TZ) {
  const c = civil(date, tz);
  const back = (c.wd - startDay + 7) % 7;
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d - back));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function monthKey(date, tz = DEFAULT_TZ) {
  const c = civil(date, tz);
  return `${c.y}-${pad2(c.m)}`;
}

export function quarterKey(date, tz = DEFAULT_TZ) {
  const c = civil(date, tz);
  return `${c.y}-Q${Math.floor((c.m - 1) / 3) + 1}`;
}

/* Has this duty been completed for the period it is CURRENTLY in?
 *
 * Gates on `done` first, not on done_at alone: a legacy row with done = true and done_at = null stays
 * done if One-off, and reads as due if recurring — the safe direction both ways.
 *
 * An unknown recurrence behaves like One-off rather than silently reopening: inventing a period for a
 * value nobody defined would make a duty nag forever.
 *
 * BOUNDARY, preserved from the original and still true: pa_department_radar deliberately does NOT use
 * this rule. Its overdue_duties_count means "has a past due_date and was never completed", a different
 * and self-consistent definition. The two surfaces disagreeing is EXPECTED. Do not teach the radar
 * this rule, and do not bend this rule to match it.
 *
 * Callers must supply recurrence and done_at, not just done.
 */
export function isDoneThisPeriod(duty, weekStartDay = 1, tz = DEFAULT_TZ, now = new Date()) {
  if (!duty?.done) return false;
  const rec = duty.recurrence || "One-off";
  if (rec === "One-off") return true;                 // never resets

  const at = duty.doneAt ?? duty.done_at;             // the client camelCases some rows
  if (!at) return false;                              // recurring with no timestamp -> treat as due
  const d = new Date(at);
  if (isNaN(d.getTime())) return false;

  if (rec === "Weekly")    return weekStartKey(d, weekStartDay, tz) === weekStartKey(now, weekStartDay, tz);
  if (rec === "Monthly")   return monthKey(d, tz) === monthKey(now, tz);
  if (rec === "Quarterly") return quarterKey(d, tz) === quarterKey(now, tz);
  return true;                                        // unknown recurrence: behave like One-off
}

/* The period a duty is currently in, as a stable string — for notification subject_ref.
 *
 * WHY subject_ref NEEDS THIS. The dedupe key is (member_id, type, subject_ref). With a bare duty id, a
 * weekly duty would collide with LAST week's reminder and never notify again: one notification, ever,
 * for a chore that recurs indefinitely. Including the period lets each new week produce exactly one
 * fresh reminder while still colliding harmlessly within that week.
 *
 * One-off returns "once" for the same reason inverted — it must NEVER produce a second notification.
 *
 * Computed in the same zone as isDoneThisPeriod, necessarily: a key derived in a different zone could
 * roll to the next period hours before the done-ness check agreed, producing a reminder for a period
 * the member has already satisfied.
 */
export function periodKey(duty, weekStartDay = 1, tz = DEFAULT_TZ, now = new Date()) {
  const rec = duty?.recurrence || "One-off";
  if (rec === "Weekly")    return weekStartKey(now, weekStartDay, tz);
  if (rec === "Monthly")   return monthKey(now, tz);
  if (rec === "Quarterly") return quarterKey(now, tz);
  return "once";
}
