/* Attendance % and "drills" — ONE definition for every screen and the weekly email (WS-4b, metrics C + D).
 *
 * WHY THIS FILE EXISTS. The app's deptAttendance and the email's trainingCompliancePct were two copies of one rule
 * that had already drifted: the email had no join-date cutoff, so a member who joined in September was marked absent
 * for every January drill — the likely 51% (email) vs 54% (app). Same reasoning as shared/maint-due.js: one rule,
 * imported by src/App.jsx and api/digest.js. docs/review/ws4b_shared_test.mjs pins every listed call site to it.
 *
 * LIFTED FROM src/App.jsx (deptAttendance, memberAttendance, joinCutoff, expectedAfterJoin, isRestrictedEvent,
 * isOptionalEvent, countsTowardRate) with ONLY these rule changes, each a ruling:
 *   · a CANCELLED session never counts (status 'cancelled' — Slice 7)                         C rule
 *   · avg is null — "—" — when nobody is rated (it was 0)                                     C-3
 *   · drillsHeld = the counting sessions MINUS business meetings (is_meeting): meetings stay in the
 *     attendance % (deliberate, App.jsx's is_meeting note) but are not drills                  D-1 / D-2
 *   · needsRoll = finalized, not cancelled, counts toward the rate, but NO roll taken — shown as
 *     "needs roll", never counted as held                                                       D-3
 *   · drillsScheduled = not cancelled, counts toward the rate, not a meeting — any state       D-1
 * WHO IS COUNTED is the caller's: deptAttendance takes a `counted(member)` predicate. Since WS-4c both the app and the
 * email pass shared/members.js's isCountedMember (rulings B-1..B-4: Active/Probationary, not separated; C-1).
 *
 * SESSION SHAPE is the app's: { y, m (0-based), d, done, status, audience, countsAttendance, isMeeting, attendance:[member ids] }.
 * MEMBER SHAPE is the app's: { id, access, joinedOn ("YYYY-MM-DD"|null), joined ("YYYY"|…) }. The email maps its rows onto these.
 */
import { isLeader } from "./roles.js";

const pad2 = (n) => String(n).padStart(2, "0");
const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const sessDate = (s) => new Date(s.y, s.m, s.d);   // date-only, local — same as App.jsx's sessDate

// Event audience: 'everyone' | 'leadership' | 'board'. A RESTRICTED event (leadership OR board)
// is pulled out of regular training stats and shown labeled to all.
export const isRestrictedEvent = (s) => s?.audience === "leadership" || s?.audience === "board";
// A session feeds the attendance RATE only if it's a regular (non-restricted) event AND not
// flagged optional. Two INDEPENDENT reasons to exclude — they compose: a restricted event stays
// out via audience, a regular off-hours/one-off stays out via the flag, a normal drill counts.
// Optional sessions still record + display attendance; we drop them from the denominator, not the record.
export const isOptionalEvent = (s) => s?.countsAttendance === false;
export const countsTowardRate = (s) => !isRestrictedEvent(s) && !isOptionalEvent(s);
export const isCancelled = (s) => s?.status === "cancelled";
export const isMeetingSession = (s) => !!s?.isMeeting;
const rollTaken = (s) => (s.attendance || []).length > 0;

/* JOIN-DATE CUTOFF. A drill held before someone joined was never theirs to attend: it renders "—"
   (not expected) and stays out of their denominator, everywhere attendance is computed.
   Full join date if on file; else Jan 1 of a leading 4-digit `joined` year; else NO cutoff
   (eligible from the start — missing join info must never wrongly exclude). */
export const joinCutoff = (m) => {
  const d = String(m?.joinedOn || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const y = /^\s*(\d{4})/.exec(String(m?.joined ?? ""));
  return y ? `${y[1]}-01-01` : null;
};
export const expectedAfterJoin = (m, s) => { const c = joinCutoff(m); return !c || toISODate(sessDate(s)) >= c; };

export function deptAttendance(members, sessions, year, range, counted = () => true) {
  // scope by date range {from,to} (ISO) when given (empty bound = unbounded); else the original year filter — backward-compatible for dashboards
  const inScope = range
    ? (s) => { const iso = toISODate(sessDate(s)); return (!range.from || iso >= range.from) && (!range.to || iso <= range.to); }
    : (s) => s.y === year;
  const live = (s) => s.done && !isCancelled(s) && inScope(s) && countsTowardRate(s);
  const doneThisYear = (sessions || []).filter((s) => live(s) && rollTaken(s));   // TRAINING only — leadership EVENTS + optional (off-hours/one-off) sessions excluded from the rate; people/roles untouched; meetings IN (D-2)
  const rows = (members || []).filter(counted).map((m) => {   // exclude owner/test from denominators + the attendance table
    const memberLeader = isLeader(m.access);
    const eligible = doneThisYear.filter((s) => expectedAfterJoin(m, s));   // audience='everyone' → everyone, but only drills on/after this member's join date
    const attended = eligible.filter((s) => (s.attendance || []).includes(m.id)).length;
    const pct = eligible.length ? Math.round((attended / eligible.length) * 100) : null;
    return { id: m.id, name: m.name, role: m.role, status: m.status, attended, eligible: eligible.length, pct, leader: memberLeader };
  });
  const rated = rows.filter((r) => r.pct != null);
  const avg = rated.length ? Math.round(rated.reduce((s, r) => s + r.pct, 0) / rated.length) : null;   // C-3: nobody rated → "—", never 0%
  const drillsHeld = doneThisYear.filter((s) => !isMeetingSession(s));                                // D-1/D-2: a meeting is attended, not a drill
  const needsRoll = (sessions || []).filter((s) => live(s) && !rollTaken(s) && !isMeetingSession(s)); // D-3: held, but no roll — not "held" until it has one
  return { rows, avg, doneThisYear, drillsHeld, needsRoll };
}

// ONE member's own attendance over a date range — the member dashboard's rule set: finalized drills with a
// roll taken, optional events excluded, leadership events counted only for leaders (scored off the member's
// ACTUAL roles, not "View as"), and nothing before their join date. null = no drills they were expected at.
export const memberAttendance = (me, sessions, range) => {
  const meLeader = isLeader(me?.access);
  const rec = (sessions || []).filter((s) => { const iso = toISODate(sessDate(s)); return s.done && !isCancelled(s) && (s.attendance || []).length > 0 && iso >= range.from && iso <= range.to && !isOptionalEvent(s) && (meLeader || !isRestrictedEvent(s)) && expectedAfterJoin(me, s); });
  if (!rec.length) return null;
  const attended = me ? rec.filter((s) => (s.attendance || []).includes(me.id)).length : 0;
  return { total: rec.length, attended, pct: Math.round((attended / rec.length) * 100) };
};

// D-1 "N scheduled": drills on the calendar in the range — not cancelled, counting toward the rate, not a meeting; any state.
export const drillsScheduled = (sessions, range) => (sessions || []).filter((s) => {
  const iso = toISODate(sessDate(s));
  return !isCancelled(s) && countsTowardRate(s) && !isMeetingSession(s) && iso >= range.from && iso <= range.to;
});
