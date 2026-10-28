// node docs/review/m7_jspdf_render.mjs <root> <outDir>
// RENDERS every PDF export for real: bundles <root>/src/report.js + <root>/src/printPdf.js with esbuild against <root>'s own
// node_modules (so the same script renders main with jspdf 2.5.2 / autotable 3.8.4, or this branch with 4.2.1 / 5.0.9), feeds each
// builder a realistic fixture shaped like the data App.jsx passes, and writes the six PDFs + a manifest. The BROWSER build of
// jsPDF is used (platform "browser"), the one the app ships. Nothing here touches a network or a database.
// The fixtures are big enough to force page breaks (the Chief's Report roster, the station-hours shift log, a 3-truck fleet
// quarter), so doc.lastAutoTable.finalY after a multi-page table and the "page N of M" footers are both exercised.
import { mkdirSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";
const root = resolve(process.argv[2] || "."), out = resolve(process.argv[3] || "m7-out");
mkdirSync(out, { recursive: true });
const { build } = createRequire(join(root, "package.json"))("esbuild");

const tmp = mkdtempSync(join(tmpdir(), "m7-"));
const entry = join(tmp, "entry.mjs");
writeFileSync(entry, `export * from ${JSON.stringify(join(root, "src/report.js"))};\nexport { buildPrintPdf } from ${JSON.stringify(join(root, "src/printPdf.js"))};\n`);
await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", outfile: join(tmp, "bundle.mjs"), logLevel: "error",
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^\.\/share$|^@capacitor\/core$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: a.path === "./share" ? "export const saveOrShare = async () => ({ ok: true });" : "export const Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };", loader: "js" }));
  } }] });
const R = await import(pathToFileURL(join(tmp, "bundle.mjs")).href);

// ---------------------------------------------------------------- fixtures (shapes from App.jsx's download calls)
const NAMES = ["Avery Cole", "Blake Ruiz", "Casey Nguyen", "Dana Ortiz", "Eli Brooks", "Finley Shaw", "Gray Patel", "Harper Lane", "Indy Moss", "Jordan Reyes",
  "Kai Bennett", "Logan Price", "Morgan Diaz", "Noel Carter", "Oakley Grant", "Parker Hale", "Quinn Foster", "Riley Stone", "Sage Kim", "Taylor Webb",
  "Uma Ford", "Val Hughes", "Wren Ellis", "Xan Ward", "Yael Burke", "Zion Pope", "Ari Snow", "Bo Fields", "Cam Rhodes", "Dev Mills",
  "Emery Watts", "Flynn Day", "Gale Ross", "Hollis Kerr", "Ira Vance", "Jules Hart", "Kit Lowe", "Lane Frost", "Max Cruz", "Nico Bell"];
const ROLES = ["Chief", "Assistant Chief", "Captain", "Lieutenant", "Firefighter", "Firefighter", "Firefighter", "EMT", "Probationary FF", "Firefighter"];
const report = {
  deptName: "Mock County Volunteer Fire Department", station: "Station 1",
  kpis: { active: 34, total: 40, certPct: 87, certWarn: true, avgPart: 72, certCovered: 33, certDenom: 38, certUndated: 2 },
  counts: { active: 34, prob: 3, total: 40, cur: 31, expg: 4, expd: 3, avgPart: 72 },
  period: { label: "Q3 2026", generated: "October 28, 2026", drillsHeld: 11, avgPart: 72, dutiesDone: 46, actionsResolved: 9 },
  members: NAMES.map((n, i) => ({ name: n, role: ROLES[i % ROLES.length], participation: i % 9 === 0 ? null : 40 + ((i * 13) % 60), status: i % 11 === 0 ? "Probationary" : "Active" })),
  flaggedCerts: [
    { member: "Avery Cole", cert: "EMT-Basic", exp: "Aug 2026", status: "Lapsed" }, { member: "Dana Ortiz", cert: "Firefighter II", exp: "Sep 2026", status: "Lapsed" },
    { member: "Gray Patel", cert: "Hazmat Operations", exp: "Dec 2026", status: "Expiring" }, { member: "Riley Stone", cert: "CPR / BLS", exp: "Jan 2027", status: "Expiring" },
  ],
  activity: Array.from({ length: 12 }, (_, i) => ({ name: `${["Ladder drill", "SCBA confidence", "Pump ops", "Vehicle extrication"][i % 4]} #${i + 1}`, date: `Sep ${1 + i * 2}, 2026`, type: i % 3 ? "Drill" : "Meeting", present: 14 + (i % 9), total: 34, optional: i === 5 })),
  duties: [{ duty: "Check SCBA cylinders", due: "2026-10-20", who: "Blake Ruiz", overdue: true }, { duty: "Restock medical bags", due: "2026-11-02", who: "Station-wide", overdue: false }],
  upcoming: [{ title: "Live burn", date: "Nov 8, 2026", leadership: false }, { title: "Officer meeting", date: "Nov 12, 2026", leadership: true }],
  pendingCerts: [{ member: "Casey Nguyen", cert: "Driver/Operator" }],
  stationHours: { credited: 1240.5, unverified: 88.25, iso: 1310, vpct: 93, members: 31, shifts: 402, autoClosed: 3, attestedHrs: 120, vTrue: 380, oTrue: 22,
    rows: NAMES.slice(0, 10).map((n, i) => ({ name: n, credited: 80 - i * 4.5, unverified: i % 3, shifts: 30 - i })) },
  funding: { contributions: 4250, proceeds: 1875.5, activeCampaigns: 2, allTimeRaised: 18900 },
  rosterGrowth: { n: 3, label: "in 2026", names: ["Zion Pope", "Ari Snow", "Bo Fields"] },
  boardTurnout: { meetings: 3, pct: 81 },
  checkCompliance: { checks: 52, units: 5, failed: 2, totalUnits: 6 },
  certsApproved: { count: 4, list: [{ member: "Kai Bennett", cert: "Firefighter I" }, { member: "Sage Kim", cert: "EMR" }] },
  equipment: { openIssues: 3, issueKinds: [{ n: 2, label: "Damaged" }, { n: 1, label: "Missing" }], agingOut: 5, asOf: "October 28, 2026" },
  chiefNote: "Strong quarter on turnout. Thank you to everyone who covered the September storm calls.\n\nBudget request for new turnout gear goes to the board in November.",
  readiness: { total: 6, ready: 3, flagged: 1, neverChecked: 1, oos: 1, openFailures: 2, asOf: "October 28, 2026",
    flaggedRigs: [{ name: "Engine 2", note: "Pump pressure low on last check" }], neverCheckedRigs: [{ name: "Tanker 4", note: "" }], oosRigs: [{ name: "Brush 3", note: "Transmission at shop" }] },
};
const checkItems = (fail) => ["Tires / pressure", "Lights & sirens", "Pump test", "SCBA (4)", "Fuel level", "Radios", "Medical bag", "Hose load", "Ladders secured", "Saws start"].map((l, i) => ({
  item_label: l, result: fail.includes(i) ? "fail" : "pass", note: fail.includes(i) ? "Left rear inner tire at 60 psi" : "",
  resolved_at: i === fail[0] ? "2026-10-21T15:30:00Z" : null, resolved_by_name: i === fail[0] ? "Blake Ruiz" : null, resolution_note: i === fail[0] ? "Aired up, re-checked" : null }));
const check = (when, fail, by) => ({ performed_at: when, performed_by_name: by, outcome: fail.length ? "fail" : "pass", pass_count: 10 - fail.length, fail_count: fail.length, general_note: fail.length ? "Flagged for the officer." : "", items: checkItems(fail) });
const apparatus = { deptName: report.deptName, station: "Station 1", rig: { name: "Engine 1", type: "Type 1 Engine" }, check: check("2026-10-20T13:05:00Z", [0, 2], "Avery Cole"), items: checkItems([0, 2]) };
const fleet = { deptName: report.deptName, station: "Station 1", range: { from: "2026-07-01", to: "2026-09-30" },
  // App.jsx's byRig shape: { name, type, checks: [...check, items] } — the builder derives the per-rig stats itself
  rigs: ["Engine 1", "Tanker 4", "Brush 3"].map((name, r) => ({ name, type: ["Engine", "Tanker", "Brush"][r], checks: Array.from({ length: 6 }, (_, i) => check(`2026-0${7 + (i % 3)}-${10 + i}T14:00:00Z`, i === r ? [1] : [], NAMES[i])) })) };
const shifts = Array.from({ length: 70 }, (_, i) => { const inAt = new Date(Date.UTC(2026, 8, 1 + (i % 28), 12 + (i % 6), 15)); const hrs = 3 + (i % 9) + (i === 7 ? 30 : 0);
  return { member_id: `m${i % 12}`, member_name: NAMES[i % 12], checked_in_at: inAt.toISOString(), checked_out_at: new Date(inAt.getTime() + hrs * 3600e3).toISOString(), hours: hrs,
           kind: i % 10 === 0 ? "offsite" : "station", verified: i % 4 !== 0, officer_attested: i % 10 === 0, auto_closed: i === 13, optional: false }; });
const hours = { deptName: report.deptName, station: "Station 1", range: { label: "September 2026", from: "2026-09-01T05:00:00.000Z", to: "2026-10-01T05:00:00.000Z" },
  totals: { credited: 512.5, unverified: 61, iso: 540, members: 12, shifts: 70, verifiedPct: 89, vTrue: 52, oTrue: 7 },
  members: NAMES.slice(0, 12).map((n, i) => ({ id: `m${i}`, name: n, total: 60 - i * 3.5, unverified: i % 4, n: 6 + (i % 3), vpct: 75 + (i % 25) })), shifts };
const capital = { deptName: report.deptName, station: "Station 1", grandTotal: 1840000, recommendedAnnual: 96500,
  groups: [2027, 2029, 2032].map((year, gi) => ({ year, subtotal: [420000, 610000, 810000][gi],
    rows: [{ name: ["Engine 2", "Tanker 4", "Ladder 1"][gi], type: ["Engine", "Tanker", "Aerial"][gi], purchaseYear: 2006 + gi * 2, purchaseCost: 280000 + gi * 90000, finalCost: [420000, 610000, 810000][gi], isProjected: gi > 0, annualSetAside: [30000, 31500, 35000][gi] }] })),
  unplanned: [{ name: "Utility 6", type: "Utility", purchaseYear: null, purchaseCost: null }] };
const print = { title: "Standard Operating Guideline 4.2 — Water Supply", deptName: report.deptName, meta: "Adopted Oct 2026 · Rev 3", printedOn: "October 28, 2026", logo: null, monogram: "MC",
  blocks: [{ type: "h2", text: "Purpose" }, { type: "p", text: "To establish a **reliable water supply** at every working structure fire, using the nearest hydrant or a tanker shuttle where none exists." },
    { type: "list", ordered: true, items: ["First-due engine lays in from the hydrant.", "Second-due engine establishes a **supply line**.", "Tankers stage at the fill site."] },
    { type: "table", head: ["Unit", "Role", "Capacity"], rows: [{ cells: ["Engine 1", "Attack", "1,000 gal"] }, { cells: ["Tanker 4", "Shuttle", "3,000 gal"] }, { cells: ["Brush 3", "Exposure", "300 gal"], muted: true }] },
    { type: "sig" }] };

const jobs = [["chiefs-report", () => R.buildReportDoc(report)], ["capital-plan", () => R.buildCapitalPlanDoc(capital)], ["apparatus-check", () => R.buildApparatusCheckDoc(apparatus)],
  ["fleet-check", () => R.buildFleetCheckDoc(fleet)], ["station-hours", () => R.buildStationHoursDoc(hours)], ["print-sheet", () => R.buildPrintPdf(print)]];
const manifest = {};
for (const [name, fn] of jobs) {
  try {
    const r = fn();   // report builders return { doc, slug } (the download wrapper calls doc.output("blob")); buildPrintPdf returns the Blob
    const buf = r instanceof Blob ? Buffer.from(await r.arrayBuffer()) : Buffer.from(await r.doc.output("blob").arrayBuffer());
    if (!(r instanceof Blob)) manifest[name + ":slug"] = r.slug;
    writeFileSync(join(out, `${name}.pdf`), buf);
    manifest[name] = { ok: true, bytes: buf.length };
  } catch (e) { manifest[name] = { ok: false, error: String(e?.stack || e).split("\n").slice(0, 3).join(" | ") }; }
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify(manifest));
