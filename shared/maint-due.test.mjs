/* Differential test for shared/maint-due.js.  Run:  node shared/maint-due.test.mjs
 *
 * WHAT THIS PROVES. The lift out of api/digest.js is behaviour-preserving. Below is the ORIGINAL
 * detectMaintenance arithmetic, pasted verbatim from api/digest.js:246-270 with only the database
 * read removed, run side by side with the shared version over the whole input domain.
 *
 * EXHAUSTIVE, NOT SAMPLED. Comparing over the apparatus_maintenance rows that happen to exist today
 * would prove the two agree on today's data — which is the weaker claim, because the rows that
 * break a date calculation are usually the ones nobody has entered yet. This enumerates every
 * cadence (including invalid ones) against offsets spanning each cadence's boundary in both
 * directions, plus null/garbled dates, plus the month-end and leap-day cases that catch naive
 * arithmetic. If the two ever disagree on any of it, this fails loudly with the exact input.
 *
 * No framework — this repo has none, matching shared/duty-period.test.mjs.
 */
import { detectMaintenanceFrom, overdueOnly, MAINT_CADENCE_DAYS, MAINT_WINDOW_DAYS } from "./maint-due.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE ORIGINAL, verbatim from api/digest.js. Do not tidy — its value is being a copy.
const ORIG_MAINT_CADENCE_DAYS = { Weekly: 7, Monthly: 30, Quarterly: 90, Annual: 365 };
const ORIG_MAINT_WINDOW_DAYS = 14;
const ORIG_DAY_MS = 86_400_000;
const origAddDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const origDaysBetween = (from, to) => Math.round((to - from) / ORIG_DAY_MS);
function origParseDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function origDetectMaintenance(rows, today) {
  return (rows || []).flatMap((r) => {
    if (!r.department_id) return [];
    const interval = ORIG_MAINT_CADENCE_DAYS[r.cadence] || 30;
    const last = origParseDateOnly(r.last_done_at);
    const nextDue = last ? origAddDays(last, interval) : null;
    const overdue = !nextDue || nextDue < today;
    if (!overdue) {
      if (origDaysBetween(today, nextDue) > ORIG_MAINT_WINDOW_DAYS) return [];
    }
    return [{
      department_id: r.department_id,
      subject_ref: r.id,
      kind: overdue ? "maint_overdue" : "maint_due",
      sort: overdue ? -1 : origDaysBetween(today, nextDue),
      apparatus: r.apparatus?.name || "All units",
      task: r.task || "Maintenance task",
      state: overdue ? "overdue" : `due in ${origDaysBetween(today, nextDue)}d`,
      urgent: overdue,
    }];
  });
}
// ─────────────────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Build the input domain.
const cadences = [...Object.keys(MAINT_CADENCE_DAYS), "Biweekly", "", null, undefined, "monthly"];
const anchors = [
  new Date(2026, 0, 15), new Date(2026, 1, 28), new Date(2026, 2, 1),    // month rollover
  new Date(2024, 1, 29), new Date(2024, 2, 1),                            // leap day
  new Date(2026, 10, 1), new Date(2026, 2, 8),                            // DST both directions (US)
  new Date(2026, 11, 31), new Date(2027, 0, 1),                           // year rollover
];
// Offsets chosen to straddle every cadence boundary and both edges of MAINT_WINDOW_DAYS.
const offsets = [];
for (const days of Object.values(MAINT_CADENCE_DAYS)) {
  for (const d of [-2, -1, 0, 1, 2]) offsets.push(days + d);
  for (const d of [-2, -1, 0, 1, 2]) offsets.push(days + MAINT_WINDOW_DAYS + d);
}
offsets.push(0, 1, 5000, -1);
const weirdDates = [null, "", "not-a-date", "2026-13-45", "2026-02-30", "2026-06-15T09:30:00Z"];

const cases = [];
let id = 0;
for (const today of anchors) {
  for (const cadence of cadences) {
    for (const off of offsets) {
      const last = new Date(today.getFullYear(), today.getMonth(), today.getDate() - off);
      cases.push({ today, row: { id: `r${id++}`, department_id: "d1", cadence, last_done_at: iso(last), task: "Pump test", apparatus: { name: "Engine 1" } } });
    }
    for (const wd of weirdDates) {
      cases.push({ today, row: { id: `r${id++}`, department_id: "d1", cadence, last_done_at: wd, task: null, apparatus: null } });
    }
  }
  // rows the detector must drop entirely
  cases.push({ today, row: { id: `r${id++}`, department_id: null, cadence: "Weekly", last_done_at: "2020-01-01" } });
}

// Compare.
let mismatches = 0;
for (const c of cases) {
  const a = origDetectMaintenance([c.row], c.today);
  const b = detectMaintenanceFrom([c.row], c.today).map(({ nextDue, ...rest }) => rest);   // nextDue is additive
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    if (mismatches < 5) {
      console.log("MISMATCH");
      console.log("  input :", JSON.stringify({ today: iso(c.today), ...c.row }));
      console.log("  orig  :", JSON.stringify(a));
      console.log("  shared:", JSON.stringify(b));
    }
    mismatches++;
  }
}
if (mismatches === 0) { pass++; console.log(`  PASS  ${cases.length} cases: shared === original, field for field`); }
else { fail++; console.log(`  FAIL  ${mismatches} of ${cases.length} cases disagree`); }

// The additive field must not perturb the originals.
const sample = detectMaintenanceFrom([{ id: "x", department_id: "d", cadence: "Weekly", last_done_at: "2020-01-01" }], new Date(2026, 0, 1));
if (sample.length === 1 && sample[0].kind === "maint_overdue" && sample[0].nextDue instanceof Date) {
  pass++; console.log("  PASS  maintStatus adds nextDue without altering the original fields");
} else { fail++; console.log("  FAIL  nextDue not exposed as expected"); }

// overdueOnly is a strict subset, and exactly the overdue ones.
const mixed = [
  { id: "a", department_id: "d", cadence: "Weekly", last_done_at: "2020-01-01" },              // long overdue
  { id: "b", department_id: "d", cadence: "Annual", last_done_at: iso(new Date(2026, 0, 1)) }, // not yet due
  { id: "c", department_id: "d", cadence: "Weekly", last_done_at: null },                      // never done
];
const today = new Date(2026, 0, 15);
const all = detectMaintenanceFrom(mixed, today);
const od = overdueOnly(mixed, today);
if (od.every((r) => r.kind === "maint_overdue") && od.length === all.filter((r) => r.kind === "maint_overdue").length) {
  pass++; console.log(`  PASS  overdueOnly returns exactly the overdue subset (${od.length} of ${all.length})`);
} else { fail++; console.log("  FAIL  overdueOnly is not the overdue subset"); }

// A never-performed task must be overdue, not skipped — the case most likely to be "fixed" wrongly.
const never = detectMaintenanceFrom([{ id: "n", department_id: "d", cadence: "Annual", last_done_at: null }], today);
if (never.length === 1 && never[0].kind === "maint_overdue") { pass++; console.log("  PASS  null last_done_at reads as OVERDUE, not as missing data"); }
else { fail++; console.log("  FAIL  null last_done_at did not read as overdue"); }

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
