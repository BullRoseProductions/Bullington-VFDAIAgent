/* mergeStationHours — the Station Hours screen's half of the credited-hours agreement.
 *
 * Runs with no database, no browser and no React: `node src/app.station-hours.test.mjs`.
 * The sibling suite is shared/digest.station-hours.test.mjs; the fixtures deliberately mirror it, because
 * the whole point is that the screen and the weekly email agree about the same member.
 *
 * WHAT THIS PROVES. That the merge is right: credited comes from the de-overlapped ISO rows and is
 * never standby+training added, auto-closed time lands in the uncredited bucket, the union covers
 * members present on only one side, and an absent denominator reports "—" instead of 0%.
 *
 * WHAT IT CANNOT PROVE. That dept_iso_hours returns the right numbers. That is SQL and is verified
 * against the live database separately (sql/verify_iso_credited_2026-09-04.sql). Here the ISO rows are
 * fixtures — this suite tests the join, not the interval arithmetic.
 *
 * Every case asserts the OLD rollup alongside the new merge, so each fixture is shown to actually
 * reproduce the bug it claims to. A fixture that no longer double-counts would pass the new assertion
 * for the wrong reason and quietly stop testing anything.
 */
import { rollupStationHours, mergeStationHours } from "../shared/station-hours.js";

const CHASE = "11111111-1111-1111-1111-111111111111";
const DREW  = "22222222-2222-2222-2222-222222222222";
const SAM   = "33333333-3333-3333-3333-333333333333";
const PAT   = "44444444-4444-4444-4444-444444444444";
const OWNER = "99999999-9999-9999-9999-999999999999";

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed += 1; console.log(`  ok   ${label}`); return; }
  failed += 1;
  console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
}
const h1 = (n) => Math.round(n * 10) / 10;

// dept_station_shifts row. Defaults describe the ordinary case: a real, location-verified,
// officer-confirmed standby check-in.
const shift = (member_id, hours, extra = {}) => ({
  member_id, member_name: "x", hours, kind: "standby",
  verified: true, officer_attested: false, auto_closed: false, optional: false, ...extra,
});
// dept_iso_hours row — already de-overlapped by the RPC, training already winning the tie.
const isoRow = (member_id, training, standby) => ({
  member_id, member_name: "x",
  training_hours: training, standby_hours: standby, iso_total_hours: training + standby,
});
const rowFor = (res, id) => res.rows.find((r) => r.id === id);

console.log("\nCHASE — a drill sitting inside a standby shift. THE BUG.");
{
  // 36.92 h of verified standby, with a 1.5 h attested drill inside it. dept_station_shifts returns
  // both, and the old rollup added them.
  const shifts = [
    shift(CHASE, 36.92),
    shift(CHASE, 1.5, { kind: "training", verified: false, officer_attested: true }),
  ];
  const iso = [isoRow(CHASE, 1.5, 35.42)];

  const old = rollupStationHours(shifts);
  check("the fixture really does reproduce the bug: old credited = 38.42", h1(old.totals.credited), 38.4);

  const m = mergeStationHours(shifts, iso);
  const r = rowFor(m, CHASE);
  check("credited is the de-overlapped total", h1(r.total), 36.9);
  check("standby is carved down, not left whole", h1(r.standby), 35.4);
  check("training survives at its own value", h1(r.training), 1.5);
  check("credited is NOT the old added figure", h1(r.total) === 38.4, false);
  check("department credited follows the rows", h1(m.totals.credited), 36.9);
  check("nothing uncredited", r.unverified, 0);
  check("attested hours still tracked separately", h1(r.attestedHrs), 1.5);
  check("verified % counts check-ins only — the attested row is not one", r.vpct, 100);
}

console.log("\nDREW — attended a drill, no overlapping standby. Must be unchanged.");
{
  const shifts = [shift(DREW, 1.5, { kind: "training", verified: false, officer_attested: true })];
  const iso = [isoRow(DREW, 1.5, 0)];

  const old = rollupStationHours(shifts);
  check("old and new agree here — there was never anything to de-overlap", h1(old.totals.credited), 1.5);

  const r = rowFor(mergeStationHours(shifts, iso), DREW);
  check("training credited normally", h1(r.training), 1.5);
  check("credited equals the drill", h1(r.total), 1.5);
  check("standby zero", r.standby, 0);
}

console.log("\nAUTO-CLOSED — verified check-in, guessed stop time. Recorded, never credited.");
{
  // The sweeper stopped the clock at the cap, so the duration is fiction until an officer sets the
  // real out-time. dept_iso_hours excludes it, so there is no ISO row — but the hours must still be
  // visible in the uncredited bucket rather than vanishing.
  const shifts = [shift(SAM, 14, { auto_closed: true })];
  const m = mergeStationHours(shifts, []);
  const r = rowFor(m, SAM);
  check("not credited", r.total, 0);
  check("lands in the uncredited bucket", r.unverified, 14);
  check("counted as an auto-closed shift", r.autoClosed, 1);
  check("still a check-in, and it was verified", r.vpct, 100);
  check("department credited stays zero", m.totals.credited, 0);
}

console.log("\nUNION — rollup-only member: no ISO row, must still appear.");
{
  const shifts = [shift(PAT, 5, { verified: false })];
  const m = mergeStationHours(shifts, []);
  const r = rowFor(m, PAT);
  check("appears at all", !!r, true);
  check("zero credited", r.total, 0);
  check("uncredited hours reported", r.unverified, 5);
  check("0% verified is a real measurement here, not an empty denominator", r.vpct, 0);
}

console.log("\nUNION — ISO-only member: presence straddled the period start.");
{
  // dept_station_shifts filters on checked_in_at, so a shift that STARTED before the period is not in
  // it; dept_iso_hours filters on overlap and clips, so the part inside the period IS. No check-in
  // event exists in the window, so there is no denominator to take a percentage of.
  const m = mergeStationHours([], [isoRow(SAM, 0, 4.25)]);
  const r = rowFor(m, SAM);
  check("appears at all", !!r, true);
  check("credited from the ISO row alone", h1(r.total), 4.3);
  check("vpct is null — renders '—', never '0%'", r.vpct, null);
  check("no shifts behind it", r.n, 0);
  check("department credited counts it", h1(m.totals.credited), 4.3);
}

console.log("\nORDERING — ranked by credited, so padding uncredited time cannot climb the list.");
{
  const shifts = [shift(PAT, 90, { verified: false }), shift(CHASE, 2)];
  const iso = [isoRow(CHASE, 0, 2)];
  const m = mergeStationHours(shifts, iso);
  check("the credited member outranks the 90 uncredited hours", m.rows[0].id, CHASE);
  check("both still listed", m.rows.length, 2);
}

console.log("\nOWNER / TEST ACCOUNT — the screen does NOT filter, and that is deliberate.");
{
  // countsInStats is applied by the DIGEST, whose figures are department statistics. This screen is a
  // ledger: dept_iso_hours returns every member with hours and the ISO table below renders those rows
  // straight from the RPC, so filtering here — and only here — would make two tables on one screen
  // disagree about the same department. Pinned as an assertion so the difference stays a decision
  // rather than becoming a surprise the next time the two are compared.
  const shifts = [shift(OWNER, 40)];
  const iso = [isoRow(OWNER, 0, 40)];
  const m = mergeStationHours(shifts, iso);
  check("the owner/test account IS included on the screen", !!rowFor(m, OWNER), true);
  check("and counted in the department total", h1(m.totals.credited), 40);
}

console.log("\nEMPTY — no shifts and no ISO rows.");
{
  const m = mergeStationHours([], []);
  check("no rows", m.rows, []);
  check("zero credited", m.totals.credited, 0);
  check("zero members", m.totals.members, 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
