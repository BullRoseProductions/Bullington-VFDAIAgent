// node docs/review/expirations_ui_test.mjs — reproducible from a clean checkout (no network, no DB).
// 1. ONE CERT NEVER READS TWO WAYS: the REAL certStatus() (extracted from src/App.jsx) vs the dashboard's
//    expiryBucket() (shared/expiry.js) on a dept_expirations-shaped cert row, for every month offset -2..+8.
// 2. The reminder plan (api/expiration-reminders.js planReminders): who gets what.
import { readFileSync } from "fs";
import { expiryBucket, monthIndex, EXPIRING_MONTHS, validExpYM } from "../../shared/expiry.js";
const app = readFileSync(new URL("../../src/App.jsx", import.meta.url), "utf8");
const grab = (name) => { const i = app.indexOf(`function ${name}(`); if (i < 0) throw new Error(`${name} not found in App.jsx`); let d = 0, j = app.indexOf("{", i); for (; j < app.length; j++) { if (app[j] === "{") d++; else if (app[j] === "}" && --d === 0) break; } return app.slice(i, j + 1); };
// certStatus has read the shared validExpYM (shared/expiry.js) since the malformed-date fix (9e2b170) — inject the real one,
// as EXPIRING_MONTHS is, so the extracted function runs exactly as it does in the app.
const certStatus = new Function("EXPIRING_MONTHS", "validExpYM", `${grab("nowYM")}\n${grab("certStatus")}\nreturn certStatus;`)(EXPIRING_MONTHS, validExpYM);
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const now = new Date(); const todayYM = now.getFullYear() * 12 + now.getMonth() + 1;
const ymOf = (k) => { const y = Math.floor((k - 1) / 12), m = k - y * 12; return `${y}-${String(m).padStart(2, "0")}`; };
const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const todayYMD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const MAP = { EXPIRED: "expired", EXPIRING: "soon", CURRENT: "current", "NO DATE": "no_date" };
let mismatches = [];
for (let off = -2; off <= 8; off++) {
  const ym = ymOf(todayYM + off);
  const exp = monthEnd(ym);
  // the DB's own bucket for that row (expired = month-end before today; else its 30-day soon/current — re-bucketed by the UI)
  const dbBucket = exp < todayYMD ? "expired" : "current";
  const ui = expiryBucket({ bucket: dbBucket, expires_on: exp }, todayYM);
  const badge = MAP[certStatus(ym).label];
  if (ui !== badge) mismatches.push(`${ym}: badge ${badge} vs dashboard ${ui}`);
}
ok("certStatus() and the dashboard agree for every month -2..+8", mismatches.length === 0, mismatches.join("; "));
ok("an undated cert: badge NO DATE = dashboard no_date", MAP[certStatus("").label] === "no_date" && expiryBucket({ bucket: "no_date", expires_on: null }, todayYM) === "no_date");
ok("the window is the badge's 3 months", EXPIRING_MONTHS === 3);
// 2. the reminder plan
const { planReminders } = await import(new URL("../../api/expiration-reminders.js", import.meta.url).href).catch(() => ({}));
if (!planReminders) { console.log("SKIP reminder plan — api/expiration-reminders.js needs its deps installed (npm i)"); }
else {
  const plus = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  const rows = [
    { source: "credential", kind: "med_card", item_id: "a", member_id: "m1", label: "DOT med card", cls: "DOT", expires_on: plus(-5), bucket: "expired" },
    { source: "cert", kind: "cert", item_id: "b", member_id: "m2", label: "EMT-B", cls: null, expires_on: monthEnd(ymOf(todayYM + 2)), bucket: "current" },   // DB says current (>30d) — badge says soon
    { source: "credential", kind: "license", item_id: "c", member_id: "m1", label: "License", cls: "Class C", expires_on: monthEnd(ymOf(todayYM + 6)), bucket: "current" },
    { source: "cert", kind: "cert", item_id: "d", member_id: "m3", label: "FF I", cls: null, expires_on: null, bucket: "no_date" },
    { source: "gear", kind: "gear", item_id: "e", member_id: "m2", label: "Coat", cls: null, expires_on: plus(10), bucket: "soon" },
    { source: "gear", kind: "gear", item_id: "f", member_id: null, label: "Pool helmet", cls: null, expires_on: plus(-1), bucket: "expired" },
    { source: "apparatus_test", kind: "pump", item_id: "g", member_id: null, label: "pump test", cls: null, expires_on: plus(-3), bucket: "expired" },
  ];
  const plan = planReminders(rows, todayYMD);
  const ids = plan.map((p) => p.item_id).sort().join(",");
  ok("flags expired + badge-window soon owned by a member (a, b, e); not current, undated, pool gear or apparatus", ids === "a,b,e", ids);
  const a = plan.find((p) => p.item_id === "a"), e = plan.find((p) => p.item_id === "e");
  ok("expired -> critical, cert family, cert_reminder", a.severity === "critical" && a.family === "certs" && a.type === "cert_reminder" && /expired/i.test(a.title));
  ok("gear -> gear family + gear_reminder; soon -> warning", e.family === "gear" && e.type === "gear_reminder" && e.severity === "warning");
  ok("one per item per day (subject_ref = item + today)", a.subject_ref === `exp:a:${todayYMD}`);
  ok("the message carries the class, never a number", /\(DOT\)/.test(a.body) && !/\d{5,}/.test(a.body));
}
