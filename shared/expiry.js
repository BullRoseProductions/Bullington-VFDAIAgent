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

/* A cert expiry ("YYYY-MM") that means a real month: the shape, a month 01–12 and a plausible year (>= 1900). The shape
 * alone let garbage through — "0000-00" (seen live) read as EXPIRED and rendered "expired undefined 0"; "2026-13" was
 * accepted on save. Anything that fails is NO DATE ("No expiration date"), never expired. One rule for every reader:
 * certStatus / expPhrase / the save validators / the cert sort (App.jsx) and the assistant's certStatus (api/assistant.js).
 * The SQL readers are hardened to the same rule in lockstep. */
export function validExpYM(exp) {
  const m = /^(\d{4})-(\d{2})$/.exec(typeof exp === "string" ? exp : "");
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]);
  return y >= 1900 && mo >= 1 && mo <= 12;
}

// A real "YYYY-MM" -> "Mar 2024" (the earned month on a cert row). Anything else -> null.
export function ymLabel(ym) {
  if (!validExpYM(ym)) return null;
  const [y, m] = ym.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

/* CERT DATES (Slice B) — the client twin of update_cert's rules (Slice A, D1): the expiry is a real month unless the cert
 * doesn't expire; the optional achievement month is a real month, not in the future, and not after the expiry. Returns the
 * first problem in the server's own words, or null. `today` is injectable for tests. */
export function certDatesError({ exp, noExpiry, achievedOn }, today = new Date()) {
  const e = String(exp || "").trim(), a = String(achievedOn || "").trim();
  if (!noExpiry && e && !validExpYM(e)) return "Expiration must be a real month as YYYY-MM (e.g. 2027-06).";
  if (a && !validExpYM(a)) return "Achievement date must be a real month as YYYY-MM (e.g. 2024-03).";
  const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  if (a && a > thisMonth) return "Achievement date can't be in the future.";
  if (a && !noExpiry && e && a > e) return "Achievement date can't be after the expiration.";
  return null;
}

// "YYYY-MM…" -> a month index (y*12 + m). Anything else -> NaN.
export function monthIndex(ymd) {
  const m = /^(\d{4})-(\d{2})/.exec(String(ymd || ""));
  return m ? Number(m[1]) * 12 + Number(m[2]) : NaN;
}

/* One expirations row (dept_expirations / my_expirations) -> the bucket the UI shows.
 * The database's `expired`, `no_date` and `no_expiry` stand as they are (exact dates; an undated item is a gap, never
 * current; a cert whose catalog type never expires is satisfied with no date — cert catalog, Slice A).
 * Everything else is re-bucketed on the badge's month window: soon when the expiry month is within EXPIRING_MONTHS
 * of `todayYM` (a month index), else current. */
export function expiryBucket(row, todayYM) {
  if (!row) return "no_date";
  if (row.bucket === "expired" || row.bucket === "no_date" || row.bucket === "no_expiry") return row.bucket;
  const mi = monthIndex(row.expires_on);
  if (!Number.isFinite(mi)) return "no_date";
  return mi - todayYM <= EXPIRING_MONTHS ? "soon" : "current";
}

// The rank the dashboard sorts by — expired, then no date, then expiring soon, then current (the DB's order); a cert that
// never expires sorts last — it needs no attention. Only a satisfied state is added; the 3-month window is unchanged.
export const BUCKET_RANK = { expired: 0, no_date: 1, soon: 2, current: 3, no_expiry: 4 };
