/* Tests for shared/duty-period.js.  Run:  node shared/duty-period.test.mjs
 *
 * No framework — this repo has none, and a period calculation is exactly the kind of thing that
 * should be checkable with `node <file>` five years from now.
 *
 * The cases that matter are the boundaries: DST transitions, and instants whose CIVIL DATE differs
 * between Central and UTC. Those are where a naive implementation silently disagrees with itself.
 */
import { weekStartKey, monthKey, quarterKey, isDoneThisPeriod, periodKey,
         periodEndISO, nudgeWindow, isNudgeWindowOpen, LEAD_DAYS } from "./duty-period.js";

const TZ = "America/Chicago";
let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n         got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

console.log("\n-- week boundaries (Monday start) --");
// THE DIVERGENCE CASE. 2026-08-23 is a Sunday. 19:00 Central = 2026-08-24T00:00Z (Monday in UTC).
// In Central it belongs to the week starting Mon 2026-08-17. A UTC-based reader would say 08-24.
eq(weekStartKey(new Date("2026-08-24T00:00:00Z"), 1, TZ), "2026-08-17",
   "WEEK_BOUNDARY: Sun 19:00 Central (= Mon 00:00 UTC) belongs to the PREVIOUS week");
eq(weekStartKey(new Date("2026-08-24T05:00:00Z"), 1, TZ), "2026-08-24",
   "Mon 00:00 Central starts the new week");
eq(weekStartKey(new Date("2026-08-24T04:59:00Z"), 1, TZ), "2026-08-17",
   "one minute before Central midnight is still the old week");
eq(weekStartKey(new Date("2026-08-20T18:00:00Z"), 0, TZ), "2026-08-16",
   "Sunday start (startDay=0) anchors to Sun 08-16");

console.log("\n-- DST transitions --");
// Spring forward 2026-03-08, fall back 2026-11-01. A week spanning either must not shift.
eq(weekStartKey(new Date("2026-03-09T06:00:00Z"), 1, TZ), "2026-03-09",
   "Mon 01:00 CDT, day after spring-forward, starts its own week");
eq(weekStartKey(new Date("2026-03-08T07:30:00Z"), 1, TZ), "2026-03-02",
   "during the spring-forward gap, still the week of 03-02");
eq(weekStartKey(new Date("2026-11-01T05:30:00Z"), 1, TZ), "2026-10-26",
   "fall-back Sunday 00:30 CDT belongs to the week of 10-26");
eq(weekStartKey(new Date("2026-11-01T07:30:00Z"), 1, TZ), "2026-10-26",
   "fall-back Sunday 01:30 CST (repeated hour) — same week, not shifted");

console.log("\n-- month / quarter boundaries --");
eq(monthKey(new Date("2026-09-01T04:00:00Z"), TZ), "2026-08",
   "Aug 31 23:00 Central is AUGUST, not September");
eq(monthKey(new Date("2026-09-01T05:00:00Z"), TZ), "2026-09", "Sep 1 00:00 Central is September");
eq(quarterKey(new Date("2026-10-01T04:00:00Z"), TZ), "2026-Q3",
   "Sep 30 23:00 Central is Q3, not Q4");
eq(quarterKey(new Date("2026-10-01T05:00:00Z"), TZ), "2026-Q4", "Oct 1 00:00 Central is Q4");
eq(quarterKey(new Date("2026-01-05T12:00:00Z"), TZ), "2026-Q1", "January is Q1 (not Q0)");

console.log("\n-- isDoneThisPeriod --");
const now = new Date("2026-08-25T15:00:00Z");          // Tue 10:00 Central, week of Mon 08-24
eq(isDoneThisPeriod({ done: false, recurrence: "Weekly", done_at: now }, 1, TZ, now), false,
   "done=false is never done");
eq(isDoneThisPeriod({ done: true, recurrence: "One-off", done_at: null }, 1, TZ, now), true,
   "One-off never resets, even with no timestamp");
eq(isDoneThisPeriod({ done: true, recurrence: "Weekly", done_at: null }, 1, TZ, now), false,
   "recurring with no timestamp reads as due");
eq(isDoneThisPeriod({ done: true, recurrence: "Weekly", done_at: "not a date" }, 1, TZ, now), false,
   "unparseable timestamp reads as due");
eq(isDoneThisPeriod({ done: true, recurrence: "Weekly", done_at: "2026-08-24T14:00:00Z" }, 1, TZ, now), true,
   "done Monday this week -> done");
eq(isDoneThisPeriod({ done: true, recurrence: "Weekly", done_at: "2026-08-24T00:00:00Z" }, 1, TZ, now), false,
   "THE BUG CASE: done Sun 19:00 Central = LAST week -> still due this week");
eq(isDoneThisPeriod({ done: true, recurrence: "Monthly", done_at: "2026-08-02T12:00:00Z" }, 1, TZ, now), true,
   "done earlier this month -> done");
eq(isDoneThisPeriod({ done: true, recurrence: "Monthly", done_at: "2026-07-31T12:00:00Z" }, 1, TZ, now), false,
   "done last month -> due again");
eq(isDoneThisPeriod({ done: true, recurrence: "Quarterly", done_at: "2026-07-01T12:00:00Z" }, 1, TZ, now), true,
   "same quarter -> done");
eq(isDoneThisPeriod({ done: true, recurrence: "Sporadic", done_at: "2020-01-01T00:00:00Z" }, 1, TZ, now), true,
   "unknown recurrence behaves like One-off, never reopens");
eq(isDoneThisPeriod({ done: true, recurrence: "Weekly", doneAt: "2026-08-24T14:00:00Z" }, 1, TZ, now), true,
   "camelCase doneAt is accepted (the client uses it)");

console.log("\n-- periodKey (subject_ref) --");
eq(periodKey({ recurrence: "Weekly" }, 1, TZ, now), "2026-08-24", "weekly key is the week start");
eq(periodKey({ recurrence: "Monthly" }, 1, TZ, now), "2026-08", "monthly key");
eq(periodKey({ recurrence: "Quarterly" }, 1, TZ, now), "2026-Q3", "quarterly key");
eq(periodKey({ recurrence: "One-off" }, 1, TZ, now), "once", "one-off never re-notifies");
eq(periodKey({}, 1, TZ, now), "once", "missing recurrence defaults to once");
// A weekly duty must produce a DIFFERENT key next week, or it would never re-notify.
const nextWeek = new Date("2026-09-01T15:00:00Z");
eq(periodKey({ recurrence: "Weekly" }, 1, TZ, nextWeek) !== periodKey({ recurrence: "Weekly" }, 1, TZ, now), true,
   "weekly key changes across weeks (so a new reminder can fire)");


console.log("\n-- periodEnd: month lengths and leap years --");
// Day 0 of the following month, so February needs no special case.
eq(periodEndISO("Monthly", 1, TZ, new Date("2026-02-10T18:00:00Z")), "2026-02-28", "Feb 2026 (not leap) ends on the 28th");
eq(periodEndISO("Monthly", 1, TZ, new Date("2028-02-10T18:00:00Z")), "2028-02-29", "Feb 2028 (LEAP) ends on the 29th");
eq(periodEndISO("Monthly", 1, TZ, new Date("2026-04-10T17:00:00Z")), "2026-04-30", "April ends on the 30th");
eq(periodEndISO("Monthly", 1, TZ, new Date("2026-12-10T18:00:00Z")), "2026-12-31", "December ends on the 31st");

console.log("\n-- periodEnd: weeks and quarters --");
eq(periodEndISO("Weekly", 1, TZ, new Date("2026-08-26T17:00:00Z")), "2026-08-30", "Mon-start week ends Sunday 08-30");
eq(periodEndISO("Weekly", 0, TZ, new Date("2026-08-26T17:00:00Z")), "2026-08-29", "Sun-start week ends Saturday 08-29");
eq(periodEndISO("Quarterly", 1, TZ, new Date("2026-08-26T17:00:00Z")), "2026-09-30", "Q3 ends 09-30");
eq(periodEndISO("Quarterly", 1, TZ, new Date("2026-01-15T18:00:00Z")), "2026-03-31", "Q1 ends 03-31");
eq(periodEndISO("Quarterly", 1, TZ, new Date("2026-11-15T18:00:00Z")), "2026-12-31", "Q4 ends 12-31");
eq(periodEndISO("One-off", 1, TZ, new Date("2026-08-26T17:00:00Z")), null, "One-off has NO period end");
eq(periodEndISO("Sporadic", 1, TZ, new Date("2026-08-26T17:00:00Z")), null, "unknown recurrence has no period end");

console.log("\n-- nudge window: opens 08:00 local, closes at period end --");
const wk = nudgeWindow("Weekly", 1, TZ, new Date("2026-08-26T17:00:00Z"));
eq(wk.opensAt.toISOString(),  "2026-08-30T13:00:00.000Z", "Weekly (lead 1): opens Sun 08:00 CDT");
eq(wk.closesAt.toISOString(), "2026-08-31T05:00:00.000Z", "Weekly: closes at Mon 00:00 CDT");
const mo = nudgeWindow("Monthly", 1, TZ, new Date("2026-08-10T17:00:00Z"));
eq(mo.opensAt.toISOString(),  "2026-08-30T13:00:00.000Z", "Monthly (lead 2): opens on the 30th, 08:00 CDT");
eq(mo.closesAt.toISOString(), "2026-09-01T05:00:00.000Z", "Monthly: closes at Sep 1 00:00 CDT");
const qt = nudgeWindow("Quarterly", 1, TZ, new Date("2026-08-26T17:00:00Z"));
eq(qt.opensAt.toISOString(),  "2026-09-28T13:00:00.000Z", "Quarterly (lead 3): opens 09-28 08:00 CDT");
eq(qt.closesAt.toISOString(), "2026-10-01T05:00:00.000Z", "Quarterly: closes at Oct 1 00:00 CDT");
eq(nudgeWindow("One-off", 1, TZ, new Date("2026-08-26T17:00:00Z")), null, "One-off never has a window");

console.log("\n-- nudge window across DST --");
// Fall back is 2026-11-01 02:00. A window opening at 08:00 that day is CST (UTC-6), not CDT.
const fb = nudgeWindow("Weekly", 1, TZ, new Date("2026-10-28T17:00:00Z"));
eq(fb.periodEnd, "2026-11-01", "week of 10-26 ends on fall-back Sunday");
eq(fb.opensAt.toISOString(),  "2026-11-01T14:00:00.000Z", "opens 08:00 CST (14:00Z), not 13:00Z");
eq(fb.closesAt.toISOString(), "2026-11-02T06:00:00.000Z", "closes Mon 00:00 CST");
// Spring forward is 2026-03-08 02:00; 08:00 that day is already CDT.
const sf = nudgeWindow("Weekly", 1, TZ, new Date("2026-03-04T18:00:00Z"));
eq(sf.periodEnd, "2026-03-08", "week of 03-02 ends on spring-forward Sunday");
eq(sf.opensAt.toISOString(),  "2026-03-08T13:00:00.000Z", "opens 08:00 CDT (13:00Z)");
const nv = nudgeWindow("Monthly", 1, TZ, new Date("2026-11-15T18:00:00Z"));
eq(nv.opensAt.toISOString(),  "2026-11-29T14:00:00.000Z", "November monthly opens 08:00 CST");
eq(nv.closesAt.toISOString(), "2026-12-01T06:00:00.000Z", "and closes Dec 1 00:00 CST");

console.log("\n-- isNudgeWindowOpen (half-open interval) --");
const W = (iso) => isNudgeWindowOpen("Weekly", 1, TZ, new Date(iso));
eq(W("2026-08-30T12:59:59Z"), false, "one second before opening -> shut");
eq(W("2026-08-30T13:00:00Z"), true,  "exactly at opening -> OPEN");
eq(W("2026-08-30T20:00:00Z"), true,  "mid-window -> open");
eq(W("2026-08-31T04:59:59Z"), true,  "one second before close -> still open");
eq(W("2026-08-31T05:00:00Z"), false, "exactly at close -> SHUT (half-open, so no period overlap)");
eq(isNudgeWindowOpen("One-off", 1, TZ, new Date("2026-08-30T20:00:00Z")), false, "One-off is never open");
eq(LEAD_DAYS.Weekly === 1 && LEAD_DAYS.Monthly === 2 && LEAD_DAYS.Quarterly === 3, true,
   "LEAD_DAYS table is the single place to retune (Weekly 1 = Sunday; set 2 for Saturday)");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
