// shared/training-due.js — how current a training category is: ONE definition for the app and the weekly drill cron.
//
// Moved from src/App.jsx's dueInfo() (Weekly Training Content slice 7; Step 0 §5.5 "the shared due-clock"). The
// arithmetic is unchanged: next due = last logged + the cadence's days; overdue past it; "due soon" inside a quarter of
// the cadence, capped at 30 days. dueInfo keeps the labels, colours and wording; this file only answers the state, so the
// cron (api/weekly-drill.js) can say "overdue / due soon / current" with the app's own rule.
// docs/review/weekly_cron_test.mjs runs the OLD and NEW dueInfo side by side and requires identical output.
// No imports: plain ESM for the browser bundle and a Vercel function alike.

export const CADENCE_DAYS = { Weekly: 7, "Bi-weekly": 14, Monthly: 30, Quarterly: 90, "Semi-annual": 180, Annual: 365, Biennial: 730 };

/* item = { cadence, lastISO }; today = a Date at local midnight (the app: the browser's; the cron: the Central date
   parsed the same way as lastISO, so both sides share one clock).
   → { state: "done" | "not_logged" | "overdue" | "due_soon" | "on_track", diff, next }
     diff = whole days from today to the next due date (negative = overdue); next = that Date. Both null without a date. */
export function trainingDue(item, today) {
  if (item.cadence === "One-off") return { state: item.lastISO ? "done" : "not_logged", diff: null, next: null };
  const days = CADENCE_DAYS[item.cadence] || 30;
  if (!item.lastISO) return { state: "not_logged", diff: null, next: null };
  const last = new Date(item.lastISO + "T00:00:00");
  const next = new Date(last.getTime() + days * 86400000);
  const diff = Math.round((next - today) / 86400000);
  if (diff < 0) return { state: "overdue", diff, next };
  const window = Math.min(Math.round(days * 0.25), 30);
  return { state: diff <= window ? "due_soon" : "on_track", diff, next };
}
