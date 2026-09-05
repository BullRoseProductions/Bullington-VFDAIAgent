/* stationMetrics — the digest's half of the credited-hours agreement.
 *
 * Runs with no database and no network: `node api/digest.station-hours.test.mjs`.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It proves the MERGE is right — that credited comes from the ISO
 * rows and never from adding standby to training, that auto-closed time lands in the uncredited
 * bucket, that the union covers members present on only one side, and that an absent denominator
 * reports "—" rather than 0%. It cannot prove dept_iso_hours_for returns the right numbers; that is
 * SQL, it is tested in its own migration, and the live check against North Hood is the other half.
 *
 * Case 1 is Chase Thomas's real shape, which is the whole reason for this change.
 */
import { stationMetrics } from "./digest.js";

const CHASE = "11111111-1111-1111-1111-111111111111";
const DREW  = "22222222-2222-2222-2222-222222222222";
const SAM   = "33333333-3333-3333-3333-333333333333";
const PAT   = "44444444-4444-4444-4444-444444444444";
const TEST  = "99999999-9999-9999-9999-999999999999";   // not in countsInStats
const counted = new Set([CHASE, DREW, SAM, PAT]);

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
}
const shift = (member_id, hours, extra = {}) => ({
  member_id,
  checked_in_at: "2026-09-01T12:00:00.000Z",
  checked_out_at: new Date(Date.parse("2026-09-01T12:00:00.000Z") + hours * 3600000).toISOString(),
  verified: true, auto_closed: false, kind: "standby", ...extra,
});
const isoRow = (member_id, training, standby) => ({
  member_id, member_name: "x",
  training_hours: training, standby_hours: standby, iso_total_hours: training + standby,
});

console.log("\nCHASE — a drill he was already on standby for. THE BUG.");
{
  // 36.92 h of verified standby covering a 1.5 h drill. The old code read the drill out of
  // dept_station_shifts as its own training row and added it: 36.92 + 1.5 = 38.42 credited, for a
  // month in which he was present 36.92 hours.
  const rows = [shift(CHASE, 36.92)];
  const iso = [isoRow(CHASE, 1.5, 35.42)];
  const m = stationMetrics(rows, iso, counted);
  check("credited is the de-overlapped total, not standby+training", m.credited, 36.9);
  check("standby is carved down, not left whole", m.standby, 35.4);
  check("training survives at its own value", m.training, 1.5);
  check("credited is NOT the old added figure", m.credited === 38.4, false);
  check("nothing uncredited", m.unverified, 0);
  check("verified % from the check-in events", m.verifiedPct, 100);
}

console.log("\nDREW — attended a drill, no overlapping standby. Must be unchanged.");
{
  const rows = [shift(DREW, 1.5, { kind: "training" })];
  const iso = [isoRow(DREW, 1.5, 0)];
  const m = stationMetrics(rows, iso, counted);
  check("training credited normally", m.training, 1.5);
  check("credited equals the drill", m.credited, 1.5);
  check("standby zero", m.standby, 0);
}

console.log("\nAUTO-CLOSED — verified check-in, guessed stop time. Recorded, never credited.");
{
  // The sweeper stopped the clock at the cap; the duration is fiction until an officer sets the real
  // out-time. dept_iso_hours_for already excludes it, so there is no ISO row — but the hours must
  // still show in the uncredited bucket, which is what the digest used to get wrong in the other
  // direction by crediting them.
  const rows = [shift(SAM, 14, { auto_closed: true })];
  const m = stationMetrics(rows, [], counted);
  check("not credited", m.credited, 0);
  check("lands in the uncredited bucket", m.unverified, 14);
  check("still counts as a check-in event, and it was verified", m.verifiedPct, 100);
}

console.log("\nUNION — presence-only member has no ISO row and must still appear.");
{
  const rows = [shift(PAT, 5, { verified: false })];
  const m = stationMetrics(rows, [], counted);
  check("zero credited", m.credited, 0);
  check("uncredited hours reported", m.unverified, 5);
  check("appears in the per-member breakdown", m.members.length, 1);
  check("0% verified is a real measurement here", m.verifiedPct, 0);
}

console.log("\nUNION — ISO-only member: presence straddled the month start, so no event in window.");
{
  // This read filters on checked_in_at and misses the shift entirely; dept_iso_hours_for filters on
  // overlap and clips, so the part inside the month is credited. No denominator exists.
  const m = stationMetrics([], [isoRow(SAM, 0, 4.25)], counted);
  check("credited from the ISO row alone", m.credited, 4.3);
  check("verified % is null, not zero", m.verifiedPct, null);
  check("per-member row carries the null too", m.members[0].verifiedPct, null);
}

console.log("\ncountsInStats — a test account must not move a department statistic.");
{
  const m = stationMetrics([shift(TEST, 40)], [isoRow(TEST, 0, 40)], counted);
  check("excluded from both sides", m.credited, null);
  check("no members", m.members, []);
}

console.log("\nFAILED HOURS READ — null is 'could not find out', not zero.");
{
  const m = stationMetrics([shift(SAM, 3, { verified: false })], null, counted);
  check("credited dashes out", m.credited, null);
  check("standby dashes out", m.standby, null);
  check("uncredited hours still reported — this side was readable", m.unverified, 3);
  check("per-member credited dashes out too", m.members[0].credited, null);
}

console.log("\nEMPTY vs NULL — a department with genuinely no hours reports nothing, not zero.");
{
  const m = stationMetrics([], [], counted);
  check("all null", [m.credited, m.standby, m.training, m.unverified, m.verifiedPct],
        [null, null, null, null, null]);
}

console.log("\nDEPARTMENT TOTAL — sums the merged rows, rounds once.");
{
  const rows = [shift(CHASE, 36.92), shift(DREW, 1.5, { kind: "training" }), shift(SAM, 14, { auto_closed: true })];
  const iso = [isoRow(CHASE, 1.5, 35.42), isoRow(DREW, 1.5, 0)];
  const m = stationMetrics(rows, iso, counted);
  check("credited", m.credited, h(36.92 + 1.5));
  check("training", m.training, 3);
  check("uncredited is the auto-closed shift", m.unverified, 14);
  check("three members present across both sides", m.members.length, 3);
}
function h(n) { return Math.round(n * 10) / 10; }

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
