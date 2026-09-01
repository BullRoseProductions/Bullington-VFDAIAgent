/* Apparatus-maintenance due/overdue arithmetic — ONE definition, two engines.
 *
 * WHY THIS FILE EXISTS. api/digest.js computes "is this maintenance task overdue?" for the weekly
 * email. api/pulse.js now needs the same answer for the daily overdue push. Two copies of a rule
 * that decides whether a truck is out of compliance WILL drift — one gets a boundary fix, the other
 * does not, and then the email and the push disagree about the same pump test. Same reasoning as
 * shared/roles.js and shared/duty-period.js.
 *
 * LIFTED VERBATIM from api/digest.js (MAINT_CADENCE_DAYS :40, detectMaintenance :246-270, and the
 * date helpers :175-200). The arithmetic below is character-for-character the original, including
 * its quirks — see LOCAL MIDNIGHT and UNKNOWN CADENCE. shared/maint-due.test.mjs proves the two
 * agree across the whole input domain, not just on the rows that happen to exist today.
 *
 * LOCAL MIDNIGHT, NOT UTC. `new Date(y, m, d)` is midnight in the SERVER's timezone. A UTC-midnight
 * date would read as the previous day in every US timezone, so a task due today would flag as
 * overdue everywhere west of Greenwich. Preserved deliberately.
 *
 * UNKNOWN CADENCE FALLS BACK TO 30 DAYS, not to "never due". A typo'd or newly added cadence value
 * therefore reads as monthly rather than silently disappearing from compliance. That is a
 * deliberate fail-loud, and it is why the fallback is `|| 30` rather than a guard that returns [].
 */

// Mirrors MAINT_CADENCE_DAYS in App.jsx and api/digest.js.
export const MAINT_CADENCE_DAYS = { Weekly: 7, Monthly: 30, Quarterly: 90, Annual: 365 };

// How far ahead a not-yet-overdue task is worth mentioning. Overdue is always reported.
export const MAINT_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

export const startOfToday = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const daysBetween = (from, to) => Math.round((to - from) / DAY_MS);

export function parseDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/* The whole rule, for ONE apparatus_maintenance row.
 *
 * Returns null when the row is not worth reporting (not overdue and not due within the window), so
 * callers can flatMap over it exactly as detectMaintenance did.
 *
 * NULL last_done_at MEANS OVERDUE, not unknown. A maintenance task that has never been performed is
 * the most overdue thing on the truck; treating a missing date as "no data, skip" would hide
 * precisely the rows that matter most.
 */
export function maintStatus(row, today) {
  if (!row || !row.department_id) return null;
  const interval = MAINT_CADENCE_DAYS[row.cadence] || 30;
  const last = parseDateOnly(row.last_done_at);
  const nextDue = last ? addDays(last, interval) : null;      // null last_done_at → never done → overdue
  const overdue = !nextDue || nextDue < today;
  if (!overdue && daysBetween(today, nextDue) > MAINT_WINDOW_DAYS) return null;
  return {
    department_id: row.department_id,
    subject_ref: row.id,
    kind: overdue ? "maint_overdue" : "maint_due",
    sort: overdue ? -1 : daysBetween(today, nextDue),
    apparatus: row.apparatus?.name || "All units",           // rig_id is nullable — a task can apply to every unit
    task: row.task || "Maintenance task",
    state: overdue ? "overdue" : `due in ${daysBetween(today, nextDue)}d`,
    urgent: overdue,
    nextDue,                                                  // ADDED: callers that need the date, not just the verdict
  };
}

/* The digest's detector, as a pure function over already-fetched rows. */
export function detectMaintenanceFrom(rows, today) {
  return (rows || []).flatMap((r) => {
    const s = maintStatus(r, today);
    return s ? [s] : [];
  });
}

/* What the daily push cares about: overdue only. maint_due stays digest-only, because a daily nag
 * about something due in six days is noise and the weekly email already covers the warning tier. */
export function overdueOnly(rows, today) {
  return detectMaintenanceFrom(rows, today).filter((s) => s.kind === "maint_overdue");
}
