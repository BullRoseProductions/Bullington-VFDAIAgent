// node docs/review/ws4d_hours_test.mjs
// No network, no DB. WS-4d — the CLIENT half + the SQL's provenance (claude/B4C_WS4d_Draft.md). Checks:
//   1. V-a in shared/station-hours.js: a VOIDED shift (out = in) is not a shift (totals.shifts / per-member n) but IS
//      still a check-in (the verified-% denominator); a sub-minute shift still counts; hours unchanged
//   2. the screen and the email still agree: api/digest.js stationMetrics gives byte-identical figures with or without
//      the voided row (its hours were 0 — the email prints no shift count)
//   3. HELPER PIN: station-hours.js takes "voided" from shared/shift-span.js (WS-4a's one rule) — no local copy
//   4. F3-b labels: the scorecard (screen + PDF) says "credited station hours (location-confirmed + officer-attested),
//      last 12 months"; the old "closed station shifts as logged … not ISO-credited" wording is gone
//   5. the SQL is exactly what docs/review/ws4d_hours_build.mjs generates from the live bodies (not hand-edited), and
//      the RETEST carries the dry run's six post-apply md5s
//   6. invariants: verified literal counts 132 · 32 · 14; Notify held; no station_presence write; runtime files changed
import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { createHash } from "crypto";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const { rollupStationHours, mergeStationHours } = await import(pathToFileURL(join(root, "shared/station-hours.js")).href);
const { stationMetrics } = await import(pathToFileURL(join(root, "api/digest.js")).href);

// ---------------------------------------------------------------- 1. V-a in the rollup
const IN = "2026-10-20T15:00:00.000Z";
const row = (id, hours, out, extra = {}) => ({ member_id: id, member_name: id, checked_in_at: IN, checked_out_at: out ?? new Date(Date.parse(IN) + hours * 3600e3).toISOString(),
  hours, kind: "standby", verified: true, auto_closed: false, officer_attested: false, optional: false, ...extra });
const real = row("m1", 2), voided = row("m1", 0, IN), subMin = row("m1", 0.01, "2026-10-20T15:00:20.000Z");
const withV = rollupStationHours([real, voided, subMin]), withoutV = rollupStationHours([real, subMin]);
ok("V-a: a voided shift is not a shift — totals.shifts 2 (real + sub-minute), not 3", withV.totals.shifts === 2 && withV.rows[0].n === 2, `${withV.totals.shifts}`);
ok("V-a: …but it IS still a check-in (verified-% denominator 3)", withV.totals.checkins === 3 && withV.totals.vTrue === 3, `${withV.totals.checkins}`);
ok("V-a: hours are untouched by the voided row (credited identical with or without it)", withV.totals.credited === withoutV.totals.credited && withV.totals.standby === withoutV.totals.standby);
ok("G-2 kept: a 20-second shift still counts as a shift", rollupStationHours([subMin]).totals.shifts === 1);
const merged = mergeStationHours([real, voided], [{ member_id: "m1", member_name: "m1", training_hours: 0, standby_hours: 2, iso_total_hours: 2 }]);
ok("V-a through mergeStationHours (the Station Hours screen / Chief's Report / Agenda): shifts 1", merged.totals.shifts === 1, `${merged.totals.shifts}`);

// ---------------------------------------------------------------- 2. the email agrees
const iso = [{ member_id: "m1", member_name: "m1", training_hours: 0, standby_hours: 2, iso_total_hours: 2 }];
const eWith = stationMetrics([real, voided], iso, new Set(["m1"])), eWithout = stationMetrics([real], iso, new Set(["m1"]));
ok("email: stationMetrics byte-identical with or without the voided row (credited / standby / training / unverified)",
  ["credited", "standby", "training", "unverified"].every((k) => JSON.stringify(eWith[k]) === JSON.stringify(eWithout[k])), JSON.stringify({ eWith, eWithout }).slice(0, 160));

// ---------------------------------------------------------------- 3 · 4. pins + labels
const sh = readFileSync(join(root, "shared/station-hours.js"), "utf8");
ok("PIN: station-hours.js takes 'voided' from ./shift-span.js (no local copy of the rule)",
  sh.includes('import { shiftSpan } from "./shift-span.js";') && sh.includes('if (shiftSpan(s.checked_in_at, s.checked_out_at) !== "voided") m.n += 1;') && !/checked_out_at\s*===\s*s\.checked_in_at/.test(sh));
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
ok("F3-b: the scorecard says credited station hours (screen footnote + PDF paragraph)",
  (src.match(/credited station hours \(location-confirmed \+ officer-attested\), last 12 months/g) || []).length === 2 && src.includes('"Credited station hours"') && src.includes('"Credited station hrs"'));
ok("F3-b: the old 'closed station shifts as logged … not ISO-credited' wording is gone", !/closed station shifts as logged/.test(src) && !/not ISO-credited hours/.test(src));

// ---------------------------------------------------------------- 5. the SQL's provenance
const md5 = (s) => createHash("md5").update(s).digest("hex");
const sqlNow = readFileSync(join(root, "sql/ws4d_hours_credit_DRAFT.sql"), "utf8");
execSync("node docs/review/ws4d_hours_build.mjs", { cwd: root, stdio: "pipe" });
const sqlRegen = readFileSync(join(root, "sql/ws4d_hours_credit_DRAFT.sql"), "utf8");
ok("the migration is byte-for-byte what the generator makes from the live bodies (not hand-edited)", md5(sqlNow) === md5(sqlRegen), md5(sqlNow));
const ret = readFileSync(join(root, "sql/ws4d_hours_credit_RETEST.sql"), "utf8");
ok("the RETEST carries six post-apply md5s and the live grants (no placeholders left)", !ret.includes("__MD5_") && !ret.includes("__META__") && (ret.match(/"(verdict|isoFor|byStation|shifts|myShifts|byMonth)": "[0-9a-f]{32}"/g) || []).length === 6);

// ---------------------------------------------------------------- 6. invariants
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token counts unchanged (App.jsx 132 · digest.js 32 · assistant.js 14)",
  tok(src) === 132 && tok(readFileSync(join(root, "api/digest.js"), "utf8")) === 32 && tok(readFileSync(join(root, "api/assistant.js"), "utf8")) === 14, String(tok(src)));
ok("Notify crew held back", !execSync("git ls-files api", { cwd: root }).toString().includes("notify-session") && !src.includes("NotifyCrewModal"));
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
ok("runtime files changed vs origin/main = shared/station-hours.js + src/App.jsx (labels)", JSON.stringify(changed) === JSON.stringify(["shared/station-hours.js", "src/App.jsx"]), JSON.stringify(changed));
const added = execSync("git diff origin/main -- src api shared", { cwd: root }).toString().split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
ok("no station_presence line added on the client", !added.some((l) => l.includes("station_presence")));
