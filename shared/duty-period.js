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

import { civil, shiftCivil, civilToISO, zonedInstantFrom } from "./zoned-time.js";

const DEFAULT_TZ = "America/Chicago";
const pad2 = (n) => String(n).padStart(2, "0");

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


/* ---------------------------------------------------------------------------
 * PERIOD CLOSE — when a recurring duty's period ends, and when to nudge about it.
 *
 * Recurring station duties are collective, unassigned and undated: "sweep the bay, weekly, whoever
 * is on". There is no due_date to count down to, so the PERIOD ITSELF is the deadline and the
 * reminder has to be derived from when that period closes.
 * ------------------------------------------------------------------------ */

/* How many days before the period ends the nudge window opens. A longer period earns more runway —
 * a day's notice on a quarterly job is not notice, it is an accusation.
 *
 * ONE TABLE, DELIBERATELY. Changing Weekly from 1 to 2 (nudge on Saturday rather than Sunday) is a
 * single number here and nothing else moves. */
export const LEAD_DAYS = { Weekly: 2, Monthly: 2, Quarterly: 3 };
// Weekly is 2 (Saturday 08:00, ~40 hours of runway) rather than 1 (Sunday 08:00, ~16 hours). A
// station chore needs somebody to physically come in, and a Sunday-morning nudge about a period
// closing that midnight is barely a warning. Set back to 1 to move it to Sunday; nothing else moves.

/* The hour, department-local, at which a nudge window opens. Morning on purpose: a station-duty
 * reminder that arrives at 22:00 is one nobody can act on until tomorrow, by which point the period
 * may have closed. */
export const NUDGE_HOUR = 8;

/* The LAST CALENDAR DAY of the period `now` falls in, in `tz`. Returns null for One-off and unknown
 * recurrences — they have no period, so they can never have a period-close nudge. That null is the
 * mechanism by which One-off duties are skipped entirely, rather than a separate check somewhere
 * that could be forgotten. */
export function periodEndCivil(recurrence, weekStartDay = 1, tz = DEFAULT_TZ, now = new Date()) {
  if (recurrence === "Weekly") {
    const [y, m, d] = weekStartKey(now, weekStartDay, tz).split("-").map(Number);
    return shiftCivil({ y, m, d }, 6);
  }
  const c = civil(now, tz);
  // Day 0 of the FOLLOWING month is the last day of this one — the standard trick, and it is why
  // February needs no special case and leap years need no table.
  if (recurrence === "Monthly") {
    const t = new Date(Date.UTC(c.y, c.m, 0));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  if (recurrence === "Quarterly") {
    const qEndMonth = Math.floor((c.m - 1) / 3) * 3 + 3;      // -> 3, 6, 9, 12
    const t = new Date(Date.UTC(c.y, qEndMonth, 0));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  return null;
}

export function periodEndISO(recurrence, weekStartDay = 1, tz = DEFAULT_TZ, now = new Date()) {
  const e = periodEndCivil(recurrence, weekStartDay, tz, now);
  return e ? civilToISO(e) : null;
}

/* The nudge window: [08:00 local on the Nth-from-last day, the instant the period ends).
 *
 * A WINDOW, NOT AN INSTANT — the same reasoning as the event lead-time bands. The hourly run that
 * first lands inside it writes the row, and the dedupe key makes every later run a no-op. An exact
 * 08:00 trigger would silently skip an entire period whenever that one hour was missed by a deploy,
 * a cold start or an outage; a window turns that into a delay of an hour instead of a loss.
 *
 * Closes at midnight local on the day AFTER the last day — i.e. the moment the period ends, which
 * is also the moment periodKey rolls over. Half-open on purpose: exactly one window contains any
 * given instant, so a nudge can never belong to two periods. */
export function nudgeWindow(recurrence, weekStartDay = 1, tz = DEFAULT_TZ, now = new Date()) {
  const lead = LEAD_DAYS[recurrence];
  const end = periodEndCivil(recurrence, weekStartDay, tz, now);
  if (!lead || !end) return null;                       // One-off / unknown: no window, ever

  const open = shiftCivil(end, -(lead - 1));
  const dayAfter = shiftCivil(end, 1);
  return {
    opensAt: zonedInstantFrom(open.y, open.m, open.d, NUDGE_HOUR, 0, tz),
    closesAt: zonedInstantFrom(dayAfter.y, dayAfter.m, dayAfter.d, 0, 0, tz),
    periodEnd: civilToISO(end),
  };
}

export function isNudgeWindowOpen(recurrence, weekStartDay = 1, tz = DEFAULT_TZ, now = new Date()) {
  const w = nudgeWindow(recurrence, weekStartDay, tz, now);
  if (!w) return false;
  const t = now.getTime();
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime();
}
