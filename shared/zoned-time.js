/* WALL CLOCK <-> INSTANT, in an explicit IANA zone.
 *
 * Framework-agnostic: no React, no browser globals, no imports. Shared by src/App.jsx (via
 * duty-period.js), api/pulse.js, and anything else that has to turn a stored wall-clock value into
 * a real moment.
 *
 * WHY IT IS EXPLICIT ABOUT ZONE. A training session's `date` + `start_time`, and a duty's period
 * boundary, are wall clocks with no zone attached. Read with JavaScript's local-time methods they
 * mean the member's device zone in a browser and UTC on Vercel — a five or six hour difference that
 * has already cost this project twice: once in dept_station_shifts (fixed by hardcoding
 * America/Chicago at four SQL sites), and once in the duty period rule (slice 3b, where a
 * differential run found 172 disagreements in 10,016 cases between a browser and a server).
 *
 * These functions were previously defined inside api/pulse.js. They are moved here VERBATIM — the
 * two-pass offset resolution below is unchanged — because a slice whose purpose is removing
 * duplicated time logic should not leave a second copy of the wall-clock converter behind.
 */

const pad2 = (n) => String(n).padStart(2, "0");

/* DEFAULT ZONE. zonedInstant, zonedInstantFrom and todayISOIn default to Central, the same convention as
   duty-period.js's DEFAULT_TZ. Before this default existed, a call that left out tz handed
   `undefined` to Intl.DateTimeFormat, which quietly fell back to the PROCESS zone: correct on a
   Central-zone Mac, six hours wrong on Vercel. That is how api/pulse.js sent "at 1:00 PM" for a
   7:00 PM session, and how its bare todayISOIn() called a task due today "overdue" from 6 PM to
   midnight Central, from the day the converter moved here (2026-08-22) until the hotfix
   (fix/pulse-event-tz). A fixed default, even one a future non-Central department will outgrow, is
   better than one that changes with the machine.
   This is part of the standing one-decision timezone plan: these defaults, duty-period.js's
   DEFAULT_TZ, pulse's TZ and the hardcoded America/Chicago SQL sites all become the
   departments.timezone column when it ships. Callers should still pass tz explicitly. */
export const DEFAULT_TZ = "America/Chicago";

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/* An instant, expressed as the calendar date it falls on IN A GIVEN ZONE. Callers do integer
   arithmetic on these civil values, so once the civil date is known no DST transition can move a
   boundary — the arithmetic never touches an instant again. */
export function civil(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: WD[p.weekday] };
}

export function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/* A wall-clock Y/M/D H:M in `tz` -> the instant it names.
   TWO PASSES, deliberately. The first offset is computed at the GUESSED instant, which is wrong for
   any wall time near a DST transition; re-deriving the offset at that corrected instant settles it.
   Verified against both 2026 transitions and both standard offsets. */
export function zonedInstantFrom(y, m, d, hh, mm, tz = DEFAULT_TZ) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let inst = guess - tzOffsetMs(new Date(guess), tz);
  inst = guess - tzOffsetMs(new Date(inst), tz);
  return new Date(inst);
}

/* The form api/pulse.js uses: an ISO date string plus "HH:MM" (a session's date + start_time). */
export function zonedInstant(dateISO, timeHHMM, tz = DEFAULT_TZ) {
  const [Y, M, D] = String(dateISO).split("-").map(Number);
  const [h, m] = String(timeHHMM || "00:00").slice(0, 5).split(":").map(Number);
  return zonedInstantFrom(Y, M, D, h, m, tz);
}

/* Today, as the department experiences it. A plain date compared against a UTC "today" would roll
   over six hours early and call things overdue on the evening before. */
export function todayISOIn(tz = DEFAULT_TZ, now = new Date()) {
  const c = civil(now, tz);
  return `${c.y}-${pad2(c.m)}-${pad2(c.d)}`;
}

export function addDaysISO(iso, n) {
  const [Y, M, D] = String(iso).split("-").map(Number);
  const t = new Date(Date.UTC(Y, M - 1, D + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/* Shift a civil {y,m,d} by whole days. Goes through Date.UTC purely as calendar arithmetic —
   UTC is used BECAUSE it has no DST, so "one day earlier" is always exactly one day. */
export function shiftCivil({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const civilToISO = ({ y, m, d }) => `${y}-${pad2(m)}-${pad2(d)}`;
