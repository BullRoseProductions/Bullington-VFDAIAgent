/* THE "EXPIRING SOON" WINDOW — one definition, imported by the Vite client (the roster's cert badge via certStatus(),
 * the Expirations dashboard) and the Vercel function (api/expiration-reminders.js).
 *
 * Framework-agnostic on purpose (no React, no browser globals, no imports), like shared/roles.js.
 *
 * WHY. The roster's cert badge has always read EXPIRING when a cert's expiry MONTH is 0–3 months after the current
 * month (certStatus(): month-index diff <= 3). The expirations read (dept_expirations()) returns a raw `days_until`
 * and its own 30-day "soon". Two windows would let one cert read "Expiring" on the roster and "Current" on the
 * dashboard. Ruled Oct 19: the dashboard uses the BADGE's window. So the rule lives here once, and certStatus,
 * the dashboard and the reminder sender all call it. Calendar-month counting, not days — same as the badge.
 */
export const EXPIRING_MONTHS = 3;

// "YYYY-MM…" -> a month index (y*12 + m). Anything else -> NaN.
export function monthIndex(ymd) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ymd || ""));
  return m ? Number(m[1]) * 12 + Number(m[2]) : NaN;
}

/* One expirations row (dept_expirations / my_expirations) -> the bucket the UI shows.
 * The database's `expired` and `no_date` stand as they are (exact dates, and an undated item is a gap, never current).
 * Everything else is re-bucketed on the badge's month window: soon when the expiry month is within EXPIRING_MONTHS
 * of `todayYM` (a month index), else current. */
export function expiryBucket(row, todayYM) {
  if (!row) return "no_date";
  if (row.bucket === "expired" || row.bucket === "no_date") return row.bucket;
  const mi = monthIndex(row.expires_on);
  if (!Number.isFinite(mi)) return "no_date";
  return mi - todayYM <= EXPIRING_MONTHS ? "soon" : "current";
}

// The rank the dashboard sorts by — expired, then no date, then expiring soon, then current (the DB's order).
export const BUCKET_RANK = { expired: 0, no_date: 1, soon: 2, current: 3 };
