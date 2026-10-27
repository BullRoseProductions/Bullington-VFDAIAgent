/* How a closed shift's LENGTH reads on screen — ONE rule for every shift row (WS-4a, ruling G).
 *
 * WHY THIS FILE EXISTS. Four screens list individual shifts (Station Hours day detail + shift log for
 * leaders; My hours recent shifts + full list for members). Each printed `h1(hours) h` on its own, so a
 * voided shift read as a "0.0-hour shift (11:47 PM – 11:47 PM)" — which looks like a validation hole.
 * Same reasoning as shared/maint-due.js: one definition, so the next screen can't grow its own copy.
 * docs/review/ws4a_quick_test.mjs pins every listed call site to this file.
 *
 * VOIDED. void_auto_closed_shift keeps the row and sets checked_out_at = checked_in_at ("zero duration:
 * kept, credits nothing", sql/early_catch_open_shifts_2026-09-09.sql:371). There is no void flag — an
 * out-time EQUAL to the in-time is the marker. It now reads "Voided" (G-1).
 *
 * UNDER A MINUTE. station_check_out has no minimum, so a check-out seconds after check-in is a true
 * record that rounds to 0.0 h. It stays visible and reads "< 1 min" (G-2: label, don't hide).
 *
 * DISPLAY ONLY. The hours themselves come from the server untouched; nothing here credits, uncredits,
 * or drops a shift. Counts ("N shifts") are deliberately NOT changed here — they come from
 * shared/station-hours.js, which is out of 4a's scope.
 */

const MINUTE_MS = 60_000;

// "open" | "voided" | "under_minute" | "timed". An unreadable timestamp falls back to "timed" so the
// caller's own hours text shows — never a label the data can't support.
export function shiftSpan(inAt, outAt) {
  if (!outAt) return "open";
  const a = Date.parse(inAt), b = Date.parse(outAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "timed";
  if (b === a) return "voided";
  if (b > a && b - a < MINUTE_MS) return "under_minute";
  return "timed";
}

// The hours cell: "Voided" · "< 1 min" · otherwise the caller's own formatted hours, unchanged.
export function shiftHoursText(inAt, outAt, hoursText) {
  const k = shiftSpan(inAt, outAt);
  return k === "voided" ? "Voided" : k === "under_minute" ? "< 1 min" : hoursText;
}
