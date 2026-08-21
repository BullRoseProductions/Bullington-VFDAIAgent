// Client-side department report PDF — original red-banner design.
// Generates a downloadable PDF from the department's live data.
import { jsPDF } from "jspdf";
import "jspdf-autotable";

// palette (RGB)
const RED = [177, 30, 47], RED_DK = [126, 20, 32], PINK = [243, 201, 206];
const SLATE = [31, 41, 51], GRAY = [91, 100, 112], LINE = [217, 221, 227];
const PANEL = [243, 244, 246];
const GREEN = [27, 127, 75], GREEN_BG = [228, 243, 234];
const AMBER = [180, 83, 9], AMBER_BG = [251, 239, 217];
const REDX = [155, 28, 28], REDX_BG = [248, 227, 227];
const NEUT = [107, 114, 128], NEUT_BG = [236, 237, 240];

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/* Hours, always one decimal — the Station Hours screen's formatter, character for character. Module
   scope because three builders now print hours (the standalone Station Hours PDF, the Chief's Report,
   and anything that follows); a per-builder copy is exactly how two documents start disagreeing about
   the same number for reasons no reader could diagnose. */
const h1 = (n) => (Math.round((Number(n) || 0) * 10) / 10).toFixed(1);

function badgeColors(text) {
  const t = String(text).toLowerCase();
  // "fail" added for the apparatus check report. Without it a FAILED checklist item fell
  // through to the neutral grey badge — a failure that reads as "no status" on a form a
  // county inspector is looking at. Safe against the existing reports: none of their badge
  // values (Lapsed, Expiring, Overdue, Open, Active, Probationary, Inactive) contain "fail".
  if (/(out of service|lapsed|expired|flag|high|overdue|fail)/.test(t)) return [REDX_BG, REDX];
  if (/(expiring|watch|follow|needs|low|medium|probation)/.test(t)) return [AMBER_BG, AMBER];
  if (/(in service|current|healthy|active|ready|on target|pass)/.test(t)) return [GREEN_BG, GREEN];
  return [NEUT_BG, NEUT];
}

/* ---------------- shared page chrome ----------------
   `ensure` and `header` were defined IDENTICALLY inside both builders. They are the only
   two that were byte-for-byte the same, so they are the only two lifted here: `para` and
   `table` genuinely differ between the reports (the department table badges a column, the
   capital one does not), and folding those together would mean parameterising away a real
   difference rather than removing a duplicate.

   WHY A FACTORY AND NOT A PLAIN FUNCTION. Both helpers MUTATE the caller's cursor, and a
   module-scope function cannot reassign a `let y` living in another scope. The builder
   hands over a getter and a setter and keeps `y` as its own local, which leaves every
   existing call site — `ensure(26)`, `header("Certifications")` — completely untouched.
   That is what makes this diff reviewable as a no-op: the call sites do not move, only the
   two duplicated bodies disappear. The builders' own `para`/`table` keep mutating `y`
   directly and still work, because getY reads the same live binding. */
function makeChrome(doc, { M, BOTTOM, getY, setY }) {
  function ensure(h) { if (getY() + h > BOTTOM) { doc.addPage(); setY(M); } }
  function header(title) {
    ensure(26);
    const y = getY();
    doc.setFillColor(...RED); doc.rect(M, y, 4, 13, "F");
    doc.setTextColor(...SLATE); doc.setFont("helvetica", "bold"); doc.setFontSize(12.5);
    doc.text(title, M + 10, y + 10.5);
    setY(y + 21);
  }
  return { ensure, header };
}

/* The red banner, identical in both builders except for two strings: the subtitle after the
   station, and the value on the right (a month+year period for the department report, a
   bare year for the capital plan). Both are passed in rather than derived, so neither
   caller's wording is decided here.

   `deptName` is passed already-resolved because the two builders disagree about the
   fallback — the capital plan defaults to "Department", the department report does not —
   and that difference is theirs to keep, not this helper's to unify.

   Returns the cursor position below the banner. Assumes it draws at the top of a fresh
   page, which is the only way either builder uses it. */
function reportBanner(doc, { deptName, station, subtitle, period, prepared }) {
  const PW = doc.internal.pageSize.getWidth();
  const M = 44, CW = PW - 2 * M;
  const y = M, BH = 92;
  doc.setFillColor(...RED); doc.rect(M, y, CW, BH, "F");
  doc.setFillColor(...RED_DK); doc.rect(M, y, 6, BH, "F");
  // emblem
  const cx = M + 30, cy = y + BH / 2;
  doc.setDrawColor(255); doc.setLineWidth(1.5); doc.circle(cx, cy, 16, "S");
  doc.setFillColor(255);
  doc.rect(cx - 2.4, cy - 9.5, 4.8, 19, "F");
  doc.rect(cx - 9.5, cy - 2.4, 19, 4.8, "F");
  // dept name (auto-fit). Reserve the right column's width so a long department name can't
  // collide with the period. A single date ("AUG 4, 2026") fits the old fixed 100pt reserve; a
  // date RANGE ("JUL 1, 2026 – JUL 31, 2026") is wider, so grow the reserve to the period's
  // measured width when it exceeds 100. Never below 100 -> single-date reports (department,
  // single check) are byte-for-byte unchanged.
  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  const rightReserve = Math.max(100, doc.getTextWidth(period || "") + 18);
  doc.setTextColor(255); doc.setFont("helvetica", "bold");
  let fs = 15.5;
  doc.setFontSize(fs);
  const avail = CW - 60 - rightReserve;
  while (doc.getTextWidth(deptName) > avail && fs > 10) { fs -= 0.5; doc.setFontSize(fs); }
  doc.text(deptName, M + 56, y + 36);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...PINK);
  doc.text(`${station ? station + " \u00b7 " : ""}${subtitle}`, M + 56, y + 54);
  doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  doc.text(period, M + CW - 14, y + 34, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...PINK);
  doc.text(prepared, M + CW - 14, y + 48, { align: "right" });
  return y + BH + 16;
}

/* Ruled sign-and-date lines. UNUSED IN THIS COMMIT — added here so the extraction lands in
   one place, and consumed by the apparatus county report in the next slice.

   A county form needs a wet signature: the PDF is evidence that a human inspected the rig,
   and an unsigned printout is only a claim the software makes about itself. Each entry gets
   a long rule for the name and a short one for the date, since a date written on the same
   rule as a signature is what makes a scanned form ambiguous.

   Returns the cursor position below the block. */
function signatureBlock(doc, y, { lines = [] } = {}) {
  if (!lines.length) return y;
  const PW = doc.internal.pageSize.getWidth();
  const M = 44, CW = PW - 2 * M;
  const DATE_W = 120, GAP = 24, ROW = 46;
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(7.6);
  lines.forEach((label) => {
    const ruleY = y + 22;
    doc.setDrawColor(...LINE); doc.setLineWidth(0.6);
    doc.line(M, ruleY, M + CW - DATE_W - GAP, ruleY);          // signature
    doc.line(M + CW - DATE_W, ruleY, M + CW, ruleY);           // date
    doc.text(label, M, ruleY + 10);
    doc.text("Date", M + CW - DATE_W, ruleY + 10);
    y += ROW;
  });
  return y;
}

export function downloadDepartmentReport(data) {
  const { doc, slug } = buildReportDoc(data);
  doc.save(slug);
}

export function buildReportDoc(data) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 44, CW = PW - 2 * M;
  const BOTTOM = PH - 50;
  let y = M;

  const now = new Date();
  const period = `${MONTHS[now.getMonth()].toUpperCase()} ${now.getFullYear()}`;
  const prepared = `Prepared ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const fullName = data.deptName;
  const station = data.station || "";

  // ---------- banner ----------
  y = reportBanner(doc, { deptName: fullName, station, subtitle: "Department Report", period, prepared });

  // ---------- KPI tiles ----------
  const k = data.kpis;
  const tiles = [
    { num: `${k.active}/${k.total}`, label: "ACTIVE MEMBERS", sub: `${data.counts.prob} probationary`, sc: GRAY },
    { num: `${k.certPct}%`, label: "CERT COMPLIANCE", sub: `${data.counts.expg} expiring \u00b7 ${data.counts.expd} expired`, sc: k.certWarn ? REDX : AMBER },
    { num: `${k.avgPart}%`, label: "AVG PARTICIPATION", sub: "over the period", sc: GRAY },
  ];
  const KH = 64;
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, KH, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2.2, "F");
  const colW = CW / tiles.length;
  tiles.forEach((t, i) => {
    const x = M + i * colW;
    if (i > 0) { doc.setDrawColor(...LINE); doc.setLineWidth(0.75); doc.line(x, y + 10, x, y + KH - 10); }
    doc.setTextColor(...RED); doc.setFont("helvetica", "bold"); doc.setFontSize(20);
    doc.text(t.num, x + 13, y + 31);
    doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(7.4);
    doc.text(t.label, x + 13, y + 44);
    doc.setTextColor(...t.sc); doc.setFont("helvetica", "bold"); doc.setFontSize(7.4);
    doc.text(t.sub, x + 13, y + 55);
  });
  y += KH + 18;

  // ---------- helpers ----------
  const { ensure, header } = makeChrome(doc, { M, BOTTOM, getY: () => y, setY: (v) => { y = v; } });
  function para(text, color = SLATE, size = 9.3) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, CW);
    lines.forEach((ln) => { ensure(13); doc.text(ln, M, y + 9); y += 13; });
  }
  function bullets(items) {
    doc.setFontSize(9.3);
    items.forEach((it) => {
      const lines = doc.splitTextToSize(it, CW - 14);
      lines.forEach((ln, idx) => {
        ensure(13);
        if (idx === 0) { doc.setTextColor(...RED); doc.setFont("helvetica", "bold"); doc.text("\u2022", M + 2, y + 9); }
        doc.setTextColor(...SLATE); doc.setFont("helvetica", "normal"); doc.text(ln, M + 14, y + 9);
        y += 13;
      });
    });
  }
  function table(head, body, opts = {}) {
    ensure(40);
    doc.autoTable({
      startY: y,
      head: [head],
      body,
      margin: { left: M, right: M },
      styles: { font: "helvetica", fontSize: 8.6, textColor: SLATE, cellPadding: 4.5, lineColor: LINE, lineWidth: 0.3, valign: "middle" },
      headStyles: { fillColor: SLATE, textColor: 255, fontStyle: "bold", fontSize: 8.4 },
      alternateRowStyles: { fillColor: PANEL },
      columnStyles: opts.columnStyles || {},
      didParseCell: (hook) => {
        if (hook.section === "body" && opts.badgeCol != null && hook.column.index === opts.badgeCol) {
          const [bg, fg] = badgeColors(hook.cell.raw);
          hook.cell.styles.fillColor = bg; hook.cell.styles.textColor = fg;
          hook.cell.styles.fontStyle = "bold"; hook.cell.styles.halign = "center";
        }
      },
    });
    y = doc.lastAutoTable.finalY + 14;
  }

  // ---------- Chief's Summary ----------
  const c = data.counts;
  const pd = data.period || {};
  header("Chief\u2019s Summary");
  if (pd.label) para(`Report period: ${pd.label}${pd.generated ? `   \u00b7   Generated ${pd.generated}` : ""}`, SLATE, 9.3);
  if (pd.label) para(`During this period, the department held ${pd.drillsHeld} training session${pd.drillsHeld === 1 ? "" : "s"} with recorded attendance (${pd.avgPart}% average attendance), completed ${pd.dutiesDone} dut${pd.dutiesDone === 1 ? "y" : "ies"}, and resolved ${pd.actionsResolved} action item${pd.actionsResolved === 1 ? "" : "s"}.`);
  para(`As of today, the department has ${c.active} active members of ${c.total} on the roster (${c.prob} probationary). `
    + (c.expd > 0
      ? `${c.expd} certification${c.expd > 1 ? "s are" : " is"} expired and ${c.expg} expiring within 90 days \u2014 flagged below as action items.`
      : `Certifications are in good standing, with ${c.expg} expiring within 90 days to watch.`));
  y += 6;

  // ---------- Certifications ----------
  header("Certifications \u2014 Action Items");
  if (data.flaggedCerts.length) {
    table(["Member", "Certification", "Expires", "Status"],
      data.flaggedCerts.map((f) => [f.member, f.cert, f.exp, f.status]),
      { badgeCol: 3, columnStyles: { 0: { fontStyle: "bold" }, 3: { cellWidth: 80 } } });
  } else {
    para("All certifications are current. No action required this period.", GRAY);
    y += 8;
  }

  // ---------- Pending Certification Approvals ----------
  header("Pending Certification Approvals");
  if ((data.pendingCerts || []).length) {
    table(["Member", "Certification"],
      data.pendingCerts.map((p) => [p.member, p.cert]),
      { columnStyles: { 0: { fontStyle: "bold" } } });
  } else { para("No certification submissions are awaiting approval.", GRAY); y += 8; }

  // ---------- Open & Overdue Duties ----------
  header("Open & Overdue Duties");
  if ((data.duties || []).length) {
    table(["Duty", "Due", "Assigned", "Status"],
      data.duties.map((d) => [d.duty, d.due || "\u2014", d.who, d.overdue ? "Overdue" : "Open"]),
      { badgeCol: 3, columnStyles: { 0: { fontStyle: "bold" }, 3: { cellWidth: 74 } } });
  } else { para("No open station duties — all assigned tasks are complete.", GRAY); y += 8; }

  // ---------- Personnel & Participation ----------
  header("Personnel & Participation");
  table(["Member", "Role", "Participation", "Status"],
    data.members.map((m) => [m.name, m.role, m.participation == null ? "\u2014" : `${m.participation}%`, m.status]),
    { badgeCol: 3, columnStyles: { 0: { fontStyle: "bold" }, 2: { halign: "right" }, 3: { cellWidth: 90 } } });

  // ---------- Station Hours (PERIOD) ----------
  // Board-level summary only; the shift-by-shift record lives in the standalone Station Hours PDF.
  // `stationHours` is null when the read failed — the section is OMITTED rather than printed as zeros,
  // because "0 credited hours" in front of a council is a false statement, not a missing one.
  const sh = data.stationHours;
  if (sh) {
    header("Station Hours \u2014 ISO/LOSAP");
    // CREDITED leads every sentence. The recorded figure is named in full every time it appears —
    // a board that sees a bigger second number without a label will read it as hours worked.
    para(`${h1(sh.credited)} hours CREDITED during the period (location-verified station standby and training) `
      + `across ${sh.shifts} record${sh.shifts === 1 ? "" : "s"} by ${sh.members} member${sh.members === 1 ? "" : "s"}. `
      + `ISO/LOSAP figure: ${h1(sh.iso)} hours. ${sh.vpct}% of check-ins were location-verified.`);
    para(`RECORDED \u2014 attendance & unverified check-ins, not credited toward ISO/LOSAP: ${h1(sh.unverified)} hours.`
      + (sh.attendanceHrs ? ` Of that, ${h1(sh.attendanceHrs)} hours come from drill attendance at each drill's recorded length rather than from a check-in.` : ""), GRAY, 8.6);
    if (sh.rows.length) {
      table(["Member", "Credited", "Recorded (not credited)", "Records"],
        sh.rows.map((r) => [r.name || "\u2014", h1(r.credited), h1(r.unverified), String(r.shifts)]),
        { columnStyles: { 0: { fontStyle: "bold" }, 1: { halign: "right", cellWidth: 66 }, 2: { halign: "right", cellWidth: 76 }, 3: { halign: "center", cellWidth: 50 } } });
    } else { para("No station hours were recorded during this period.", GRAY); y += 8; }
  }

  // ---------- Recent Training ----------
  header("Recent Training");
  // Optional (off-hours/one-off) sessions are marked so a bare "4 / 25" on a printed
  // report can't read as terrible turnout — it's recorded attendance, not a rate.
  table(["Session", "Date", "Type", "Attendance"],
    data.activity.map((e) => [e.optional ? `${e.name} (Optional)` : e.name, e.date, e.type, e.optional ? `${e.present} / ${e.total} — optional` : `${e.present} / ${e.total}`]),
    { columnStyles: { 0: { fontStyle: "bold" }, 3: { halign: "right" } } });
  if ((data.activity || []).some((e) => e.optional)) para("“Optional” sessions (off-hours or one-off trainings) are recorded for those who attended but are not counted toward attendance rates — their turnout should not be read as a participation figure.", GRAY, 8);

  // ---------- Upcoming Training ----------
  header("Upcoming Training");
  if ((data.upcoming || []).length) {
    table(["Session", "Date", "Audience"],
      data.upcoming.map((u) => [u.title, u.date, u.leadership ? "Leadership" : "All members"]),
      { columnStyles: { 0: { fontStyle: "bold" } } });
  } else { para("No upcoming training is currently scheduled.", GRAY); y += 8; }

  // ---------- Apparatus Readiness (AS OF TODAY) ----------
  // Labelled as a snapshot, like the roster: readiness is a today fact and must never read as though it
  // described the reporting period.
  const rd = data.readiness;
  if (rd) {
    header("Apparatus Readiness");
    para(`As of ${rd.asOf}: ${rd.ready} ready, ${rd.flagged} needing attention, ${rd.oos} out of service of ${rd.total} apparatus. `
      + `${rd.openFailures} check failure${rd.openFailures === 1 ? "" : "s"} remain${rd.openFailures === 1 ? "s" : ""} unresolved.`);
    const rigRows = [
      ...rd.flaggedRigs.map((r) => [r.name || "\u2014", "Needs attention", r.note || "\u2014"]),
      ...rd.oosRigs.map((r) => [r.name || "\u2014", "Out of service", r.note || "\u2014"]),
    ];
    if (rigRows.length) {
      table(["Apparatus", "Status", "Reason on record"], rigRows,
        { badgeCol: 1, columnStyles: { 0: { fontStyle: "bold" }, 1: { cellWidth: 96 } } });
    } else { para("Every apparatus is in service and passing its last check.", GRAY); y += 8; }
  }

  // ---------- Recommended Actions ----------
  const actions = [];
  data.flaggedCerts.filter((f) => f.status === "Lapsed").slice(0, 3).forEach((f) =>
    actions.push(`Schedule ${f.member} for the next ${f.cert} refresher \u2014 certification has lapsed.`));
  if (sh && sh.autoClosed > 0) actions.push(`Review ${sh.autoClosed} auto-closed shift${sh.autoClosed > 1 ? "s" : ""} \u2014 the system estimated the stop time, so those hours are not credited until an officer confirms them.`);
  if (rd && rd.openFailures > 0) actions.push(`Close out ${rd.openFailures} open apparatus check failure${rd.openFailures > 1 ? "s" : ""}.`);
  if (c.prob > 0) actions.push(`Continue mentoring ${c.prob} probationary member${c.prob > 1 ? "s" : ""}; review status at the next business meeting.`);
  if (data.flaggedCerts.some((f) => f.status === "Expiring")) actions.push("Confirm seats for members with certifications expiring in the next 90 days in upcoming refresher classes.");
  if (actions.length) {
    header("Recommended Actions");
    bullets(actions);
    y += 6;
  }

  // ---------- Provenance ----------
  ensure(56);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, 46, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2, "F");
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(7.6);
  const prov = doc.splitTextToSize(
    "How this report was produced. Drafted automatically from the department\u2019s roster, training, and certification "
    + "records, then reviewed and approved by a qualified officer before release \u2014 the platform\u2019s "
    + "standing rule: the system drafts, a human approves, then it publishes.", CW - 24);
  let py = y + 13;
  prov.forEach((ln) => { doc.text(ln, M + 12, py); py += 10; });
  doc.text("Approved by: ____________________  (Training Officer)   \u00b7   Date: __________", M + 12, py + 2);

  // ---------- footers ----------
  const n = doc.getNumberOfPages();
  const shortName = (station ? `${data.deptName} \u00b7 ${station}` : data.deptName);
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, PH - 38, PW - M, PH - 38);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...GRAY);
    doc.text(`${shortName} \u00b7 Confidential \u2014 Board & Leadership`, M, PH - 26);
    doc.text(`Page ${i} of ${n}`, PW - M, PH - 26, { align: "right" });
  }

  const slug = data.deptName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")
    + (station ? "-" + station.replace(/\s+/g, "") : "")
    + `-Report-${MONTHS[now.getMonth()].slice(0, 3)}-${now.getFullYear()}.pdf`;
  return { doc, slug };
}

/* ---------------- Capital Replacement Plan ----------------
   The artifact a chief hands the selectboard: what the fleet cost, when each rig is planned for
   replacement, and what that costs by year. Same banner/table styling as the department report.
   `data` = { deptName, station, groups: [{ year, rows, subtotal }], unplanned: [rows], grandTotal }
   where each row is { name, type, purchaseYear, purchaseCost, replaceYear, replaceCost }. */
export function downloadCapitalPlan(data) {
  const { doc, slug } = buildCapitalPlanDoc(data);
  doc.save(slug);
}

export function buildCapitalPlanDoc(data) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 44, CW = PW - 2 * M;
  const BOTTOM = PH - 50;
  let y = M;

  const now = new Date();
  const prepared = `Prepared ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const fullName = data.deptName || "Department";
  const station = data.station || "";
  const money = (n) => (n == null ? "—" : `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`);

  // ---------- banner ----------
  y = reportBanner(doc, { deptName: fullName, station, subtitle: "Capital Replacement Plan", period: String(now.getFullYear()), prepared });

  const { ensure, header } = makeChrome(doc, { M, BOTTOM, getY: () => y, setY: (v) => { y = v; } });
  function para(text, color = SLATE, size = 9.3) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(text, CW).forEach((ln) => { ensure(13); doc.text(ln, M, y + 9); y += 13; });
  }
  function table(head, body, opts = {}) {
    ensure(40);
    doc.autoTable({
      startY: y,
      head: [head],
      body,
      margin: { left: M, right: M },
      styles: { font: "helvetica", fontSize: 8.6, textColor: SLATE, cellPadding: 4.5, lineColor: LINE, lineWidth: 0.3, valign: "middle" },
      headStyles: { fillColor: SLATE, textColor: 255, fontStyle: "bold", fontSize: 8.4 },
      alternateRowStyles: { fillColor: PANEL },
      columnStyles: opts.columnStyles || {},
    });
    y = doc.lastAutoTable.finalY + 14;
  }

  const groups = data.groups || [];
  const unplanned = data.unplanned || [];

  // ---------- forecast summary ----------
  header("Replacement Forecast");
  if (groups.length === 0) {
    para("No apparatus has a planned replacement year on record yet.", GRAY);
  } else {
    table(["Replacement year", "Apparatus", "Estimated cost"],
      groups.map((g) => [String(g.year), String(g.rows.length), money(g.subtotal)]),
      { columnStyles: { 1: { halign: "center" }, 2: { halign: "right" } } });
    doc.setFillColor(...PANEL); ensure(30);
    doc.rect(M, y, CW, 26, "F");
    doc.setFillColor(...RED); doc.rect(M, y, 3, 26, "F");
    doc.setTextColor(...SLATE); doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    doc.text("Total planned replacement cost", M + 12, y + 17);
    doc.text(money(data.grandTotal), M + CW - 12, y + 17, { align: "right" });
    y += 26 + 16;
  }

  // ---------- detail by year ----------
  groups.forEach((g) => {
    header(`${g.year} — ${money(g.subtotal)}`);
    table(["Apparatus", "Type", "Purchased", "Purchase cost", "Est. replacement"],
      g.rows.map((r) => [r.name, r.type || "—", r.purchaseYear == null ? "—" : String(r.purchaseYear), money(r.purchaseCost), money(r.replaceCost)]),
      { columnStyles: { 2: { halign: "center" }, 3: { halign: "right" }, 4: { halign: "right" } } });
  });

  // ---------- not yet planned ----------
  if (unplanned.length) {
    header("Not Yet Planned");
    para("These units have no planned replacement year on record.", GRAY);
    table(["Apparatus", "Type", "Purchased", "Purchase cost"],
      unplanned.map((r) => [r.name, r.type || "—", r.purchaseYear == null ? "—" : String(r.purchaseYear), money(r.purchaseCost)]),
      { columnStyles: { 2: { halign: "center" }, 3: { halign: "right" } } });
  }

  // ---------- provenance ----------
  ensure(50);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, 44, "F");
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(7.6);
  const prov = doc.splitTextToSize(
    "Figures are the department’s own recorded purchase and replacement estimates, not appraisals or bids. "
    + "Estimated replacement costs are planning figures entered by department leadership and should be "
    + "re-validated against current pricing before any funding request.", CW - 24);
  let py = y + 13;
  prov.forEach((ln) => { doc.text(ln, M + 12, py); py += 10; });
  y += 44 + 10;

  // ---------- footers ----------
  const n = doc.getNumberOfPages();
  const shortName = (station ? `${fullName} · ${station}` : fullName);
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, PH - 38, PW - M, PH - 38);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...GRAY);
    doc.text(`${shortName} · Capital Replacement Plan`, M, PH - 26);
    doc.text(`Page ${i} of ${n}`, PW - M, PH - 26, { align: "right" });
  }

  const slug = fullName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")
    + (station ? "-" + station.replace(/\s+/g, "") : "")
    + `-Capital-Plan-${now.getFullYear()}.pdf`;
  return { doc, slug };
}


/* Shared with the fleet report below, so the two documents cannot describe the same check
   differently. A timestamp that fails to parse prints an em dash rather than "Invalid Date",
   which is what an unguarded toLocaleString would put on a county form. */
function apparatusWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return "—";
  const hh = d.getHours(), mm = String(d.getMinutes()).padStart(2, "0");
  const h12 = ((hh + 11) % 12) + 1, ap = hh < 12 ? "AM" : "PM";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${h12}:${mm} ${ap}`;
}

/* One checklist item -> one table row. SHARED so the single-check PDF and the fleet PDF give a
   failure identical treatment: same wording, same resolution trail, same "UNRESOLVED" language.
   If these diverged, the same failed item would read as closed on one document and open on the
   other, which is the worst thing either document could do. */
function apparatusItemRows(items) {
  return (items || []).map((it) => {
    const isFail = String(it.result || "").toLowerCase() === "fail";
    const bits = [];
    if (it.note) bits.push(it.note);
    // An open failure has to be legible AS an open failure. A county reader should not have to
    // notice the absence of a resolution line to work out that nothing was fixed.
    if (isFail) {
      bits.push(it.resolved_at
        ? `Resolved by ${it.resolved_by_name || "—"} on ${apparatusWhen(it.resolved_at)}${it.resolution_note ? ` — ${it.resolution_note}` : ""}`
        : "UNRESOLVED as of this report");
    }
    return [it.item_label || "—", isFail ? "Fail" : "Pass", bits.join("\n") || "—"];
  });
}
const APPARATUS_ITEM_COLSTYLE = { badgeCol: 1, columnStyles: { 0: { fontStyle: "bold" }, 1: { cellWidth: 54 } } };

/* ---------------- Apparatus Check Report ----------------
   The artifact a department hands the county: one completed truck check — who ran it, when,
   what passed, what failed, and whether each failure was closed out. A pure function of what
   the check-history screen already has in memory; it issues no query of its own.

   APPARATUS IDENTIFIER GAP, stated rather than papered over. A county form usually wants a
   unit number or VIN, and the apparatus table has no such column. This report therefore
   identifies the rig by name and type only. Deriving something VIN-shaped from the name, or
   printing a blank labelled "Unit #", would both be inventing an identifier the department
   never recorded — on a document whose whole purpose is to be trusted by an outside body.
   If the county rejects name+type, the fix is a real column and a form field, not a guess
   made here.

   data = { deptName, station,
            rig:   { name, type },
            check: { performed_by_name, performed_at, outcome, pass_count, fail_count, general_note },
            items: [{ item_label, result, note, resolved_at, resolved_by_name, resolution_note }] } */
export function downloadApparatusCheck(data) {
  const { doc, slug } = buildApparatusCheckDoc(data);
  doc.save(slug);
}

export function buildApparatusCheckDoc(data) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 44, CW = PW - 2 * M;
  const BOTTOM = PH - 50;
  let y = M;

  const now = new Date();
  const prepared = `Prepared ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const fullName = data.deptName || "Department";
  const station = data.station || "";
  const rig = data.rig || {};
  const chk = data.check || {};
  const items = data.items || [];

  // Dates are formatted here rather than passed in pre-formatted, so the PDF cannot drift
  // from the screen if the screen's formatting ever changes. A bad timestamp prints "—"
  // instead of "Invalid Date", which is what an unguarded toLocaleString would put on a
  // county form.
  const when = apparatusWhen;   // shared with the fleet report — one formatter, one em-dash guard
  const pd = chk.performed_at ? new Date(chk.performed_at) : null;
  const periodLabel = (pd && !isNaN(pd.getTime()))
    ? `${MONTHS[pd.getMonth()].slice(0, 3).toUpperCase()} ${pd.getDate()}, ${pd.getFullYear()}`
    : "";

  // ---------- banner ----------
  y = reportBanner(doc, { deptName: fullName, station, subtitle: "Apparatus Check Report", period: periodLabel, prepared });

  // ---------- helpers ----------
  const { ensure, header } = makeChrome(doc, { M, BOTTOM, getY: () => y, setY: (v) => { y = v; } });
  function para(text, color = SLATE, size = 9.3) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(text, CW).forEach((ln) => { ensure(13); doc.text(ln, M, y + 9); y += 13; });
  }
  function table(head, body, opts = {}) {
    ensure(40);
    doc.autoTable({
      startY: y,
      head: [head],
      body,
      margin: { left: M, right: M },
      styles: { font: "helvetica", fontSize: 8.6, textColor: SLATE, cellPadding: 4.5, lineColor: LINE, lineWidth: 0.3, valign: "middle" },
      headStyles: { fillColor: SLATE, textColor: 255, fontStyle: "bold", fontSize: 8.4 },
      alternateRowStyles: { fillColor: PANEL },
      columnStyles: opts.columnStyles || {},
      didParseCell: (hook) => {
        if (hook.section === "body" && opts.badgeCol != null && hook.column.index === opts.badgeCol) {
          const [bg, fg] = badgeColors(hook.cell.raw);
          hook.cell.styles.fillColor = bg; hook.cell.styles.textColor = fg;
          hook.cell.styles.fontStyle = "bold"; hook.cell.styles.halign = "center";
        }
      },
    });
    y = doc.lastAutoTable.finalY + 14;
  }

  // ---------- summary strip ----------
  // The four facts a county reader checks first: which rig, who signed off on it, when, and
  // did it pass. Everything else on the page is detail supporting these.
  const failed = String(chk.outcome || "").toLowerCase() === "fail";
  const SH = 78;
  ensure(SH + 10);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, SH, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2.2, "F");
  doc.setTextColor(...SLATE); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
  doc.text(rig.name || "Apparatus", M + 13, y + 28);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...GRAY);
  doc.text(rig.type || "\u2014", M + 13, y + 43);
  doc.setFontSize(8.4);
  doc.text(`Performed by ${chk.performed_by_name || "\u2014"}`, M + 13, y + 59);
  doc.text(when(chk.performed_at), M + 13, y + 70);
  const [obg, ofg] = badgeColors(failed ? "Fail" : "Pass");
  const BW = 96, BBH = 26, bx = M + CW - 13 - BW;
  doc.setFillColor(...obg); doc.rect(bx, y + 16, BW, BBH, "F");
  doc.setTextColor(...ofg); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  doc.text(failed ? "FAIL" : "PASS", bx + BW / 2, y + 34, { align: "center" });
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(8.4);
  doc.text(`${chk.pass_count ?? 0} passed \u00b7 ${chk.fail_count ?? 0} failed`, M + CW - 13, y + 59, { align: "right" });
  doc.text(`${items.length} item${items.length === 1 ? "" : "s"} recorded`, M + CW - 13, y + 70, { align: "right" });
  y += SH + 16;

  // ---------- note ----------
  if (chk.general_note) {
    header("Note from the check");
    para(`\u201c${chk.general_note}\u201d`);
    y += 4;
  }

  // ---------- checklist ----------
  header("Checklist");
  if (items.length) {
    table(["Item", "Result", "Notes & resolution"],
      apparatusItemRows(items), APPARATUS_ITEM_COLSTYLE);
  } else {
    para("No checklist items were recorded for this check.", GRAY);
    y += 8;
  }

  // ---------- provenance ----------
  ensure(46);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, 40, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2, "F");
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(7.6);
  const prov = doc.splitTextToSize(
    "Generated from the department\u2019s own apparatus-check records. Item results, notes and "
    + "resolutions are reproduced exactly as recorded by the member who performed the check and "
    + "the officer who closed out each failure. Times are shown in the department\u2019s local time.", CW - 24);
  let py = y + 13;
  prov.forEach((ln) => { doc.text(ln, M + 12, py); py += 10; });
  y += 40 + 14;

  // ---------- certification ----------
  // The signatures are the point of the exercise: this page is evidence a human inspected a
  // truck, and an unsigned printout is only a claim the software makes about itself.
  ensure(120);
  header("Certification");
  y = signatureBlock(doc, y, { lines: ["Inspected by", "Reviewed by"] });

  // ---------- footers ----------
  const n = doc.getNumberOfPages();
  const shortName = (station ? `${fullName} \u00b7 ${station}` : fullName);
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, PH - 38, PW - M, PH - 38);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...GRAY);
    doc.text(`${shortName} \u00b7 Apparatus Check Report`, M, PH - 26);
    doc.text(`Page ${i} of ${n}`, PW - M, PH - 26, { align: "right" });
  }

  const clean = (v) => String(v || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const stamp = (pd && !isNaN(pd.getTime()))
    ? `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, "0")}-${String(pd.getDate()).padStart(2, "0")}`
    : `${now.getFullYear()}`;
  const slug = clean(fullName) + (station ? "-" + station.replace(/\s+/g, "") : "")
    + `-${clean(rig.name) || "Apparatus"}-Check-${stamp}.pdf`;
  return { doc, slug };
}

/* ---------------- Fleet Apparatus Checks (date range) ----------------
   Every unit's checks over a period, as ONE document — what a county asks for when it wants
   the quarter rather than a single truck on a single day.

   Built entirely from the shared chrome (reportBanner / makeChrome / signatureBlock /
   badgeColors) and the shared item mapping, so a failed item reads identically here and on the
   single-check PDF.

   data = { deptName, station,
            range: { from, to },                       // YYYY-MM-DD, inclusive, as shown to the user
            rigs: [ { name, type, checks: [ { ...check row, items: [...] } ] } ] }

   Totals are computed HERE rather than passed in, so the cover figures cannot disagree with the
   per-truck tables printed underneath them — the one inconsistency a reader would actually catch. */

/* DETAIL LEVEL — TUNABLE. Today a FAILED check expands to its full item-by-item checklist and a
   passing check stays one line, which keeps a quarterly packet readable while still showing every
   failure in full. To print the complete checklist for EVERY check, change this one line to
   `() => true`. That is the whole switch; nothing else below depends on the choice. */
const FLEET_EXPAND_ITEMS = (check) => String(check?.outcome || "").toLowerCase() === "fail";

export function downloadFleetCheck(data) {
  const { doc, slug } = buildFleetCheckDoc(data);
  doc.save(slug);
}

export function buildFleetCheckDoc(data) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 44, CW = PW - 2 * M;
  const BOTTOM = PH - 50;
  let y = M;

  const now = new Date();
  const prepared = `Prepared ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const fullName = data.deptName || "Department";
  const station = data.station || "";
  const rigs = data.rigs || [];
  const range = data.range || {};

  // Range labels come off the YYYY-MM-DD strings the picker produced. Parsed as local dates
  // (not UTC) so the printed period matches the days the user selected.
  const dayLabel = (s) => {
    if (!s) return "—";
    const [yy, mm, dd] = String(s).split("-").map(Number);
    const d = new Date(yy, (mm || 1) - 1, dd || 1);
    return isNaN(d.getTime()) ? "—" : `${MONTHS[d.getMonth()].slice(0, 3).toUpperCase()} ${d.getDate()}, ${d.getFullYear()}`;
  };
  const periodLabel = `${dayLabel(range.from)} – ${dayLabel(range.to)}`;

  y = reportBanner(doc, { deptName: fullName, station, subtitle: "Apparatus Checks", period: periodLabel, prepared });

  const { ensure, header } = makeChrome(doc, { M, BOTTOM, getY: () => y, setY: (v) => { y = v; } });
  function para(text, color = SLATE, size = 9.3) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(text, CW).forEach((ln) => { ensure(13); doc.text(ln, M, y + 9); y += 13; });
  }
  function table(head, body, opts = {}) {
    ensure(40);
    doc.autoTable({
      startY: y,
      head: [head],
      body,
      margin: { left: M, right: M },
      styles: { font: "helvetica", fontSize: 8.6, textColor: SLATE, cellPadding: 4.5, lineColor: LINE, lineWidth: 0.3, valign: "middle" },
      headStyles: { fillColor: SLATE, textColor: 255, fontStyle: "bold", fontSize: 8.4 },
      alternateRowStyles: { fillColor: PANEL },
      columnStyles: opts.columnStyles || {},
      didParseCell: (hook) => {
        if (hook.section === "body" && opts.badgeCol != null && hook.column.index === opts.badgeCol) {
          const [bg, fg] = badgeColors(hook.cell.raw);
          hook.cell.styles.fillColor = bg; hook.cell.styles.textColor = fg;
          hook.cell.styles.fontStyle = "bold"; hook.cell.styles.halign = "center";
        }
      },
    });
    y = doc.lastAutoTable.finalY + 14;
  }

  // ---------- per-rig figures ----------
  const isFail = (c) => String(c?.outcome || "").toLowerCase() === "fail";
  const stats = rigs.map((r) => {
    const checks = r.checks || [];
    const open = checks.reduce((n, c) => n + (c.items || []).filter(
      (it) => String(it.result || "").toLowerCase() === "fail" && !it.resolved_at).length, 0);
    const latest = checks.reduce((best, c) => {
      const t = c.performed_at ? new Date(c.performed_at).getTime() : NaN;
      return (!isNaN(t) && (best == null || t > best)) ? t : best;
    }, null);
    return {
      rig: r,
      checks,
      total: checks.length,
      passed: checks.filter((c) => !isFail(c)).length,
      failed: checks.filter(isFail).length,
      open,
      latest,
    };
  });
  const fleet = stats.reduce((a, s) => ({
    checks: a.checks + s.total, passed: a.passed + s.passed, failed: a.failed + s.failed, open: a.open + s.open,
  }), { checks: 0, passed: 0, failed: 0, open: 0 });

  // ---------- cover summary ----------
  const SH = 64;
  ensure(SH + 10);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, SH, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2.2, "F");
  const tiles = [
    { num: String(rigs.length), label: "UNITS", sc: GRAY },
    { num: String(fleet.checks), label: "CHECKS IN PERIOD", sc: GRAY },
    { num: String(fleet.passed), label: "PASSED", sc: GREEN },
    { num: String(fleet.failed), label: "FAILED", sc: fleet.failed ? REDX : GRAY },
    { num: String(fleet.open), label: "OPEN FAILURES", sc: fleet.open ? REDX : GREEN },
  ];
  const colW = CW / tiles.length;
  tiles.forEach((t, i) => {
    const x = M + i * colW;
    if (i > 0) { doc.setDrawColor(...LINE); doc.setLineWidth(0.75); doc.line(x, y + 10, x, y + SH - 10); }
    doc.setTextColor(...RED); doc.setFont("helvetica", "bold"); doc.setFontSize(19);
    doc.text(t.num, x + 13, y + 32);
    doc.setTextColor(...t.sc); doc.setFont("helvetica", "normal"); doc.setFontSize(7.2);
    doc.text(t.label, x + 13, y + 47);
  });
  y += SH + 16;

  // ---------- fleet summary table ----------
  header("Fleet summary");
  if (!rigs.length) {
    para("No apparatus on record for this department.", GRAY);
    y += 8;
  } else {
    table(["Apparatus", "Checks", "Pass", "Fail", "Open failures", "Most recent check"],
      stats.map((s) => [
        s.rig.name || "—",
        String(s.total),
        String(s.passed),
        String(s.failed),
        s.open ? `${s.open} open` : "None",
        s.latest == null ? "No checks in this period" : apparatusWhen(new Date(s.latest).toISOString()),
      ]),
      { badgeCol: 4, columnStyles: { 0: { fontStyle: "bold" }, 1: { halign: "center", cellWidth: 44 }, 2: { halign: "center", cellWidth: 40 }, 3: { halign: "center", cellWidth: 40 }, 4: { cellWidth: 84 } } });
  }

  // ---------- one section per truck ----------
  stats.forEach((s) => {
    header(`${s.rig.name || "Apparatus"}${s.rig.type ? ` — ${s.rig.type}` : ""}`);
    if (!s.checks.length) {
      // Said explicitly. A truck silently missing from a county packet reads as an oversight;
      // a truck listed with "no checks in this period" is a finding.
      para("No checks in this period.", GRAY);
      y += 6;
      return;
    }
    table(["Date", "Performed by", "Result", "Failed items"],
      s.checks.map((c) => [
        apparatusWhen(c.performed_at),
        c.performed_by_name || "—",
        isFail(c) ? "Fail" : "Pass",
        String(c.fail_count ?? 0),
      ]),
      { badgeCol: 2, columnStyles: { 2: { cellWidth: 54 }, 3: { halign: "center", cellWidth: 66 } } });

    // Failed checks expand to the full checklist — see FLEET_EXPAND_ITEMS.
    s.checks.filter((c) => FLEET_EXPAND_ITEMS(c)).forEach((c) => {
      ensure(30);
      doc.setTextColor(...GRAY); doc.setFont("helvetica", "bold"); doc.setFontSize(8.6);
      doc.text(`Checklist — ${apparatusWhen(c.performed_at)}`, M, y + 8);
      y += 16;
      if (c.general_note) para(`“${c.general_note}”`, GRAY, 8.4);
      const rows = apparatusItemRows(c.items);
      if (rows.length) table(["Item", "Result", "Notes & resolution"], rows, APPARATUS_ITEM_COLSTYLE);
      else { para("No checklist items were recorded for this check.", GRAY, 8.4); y += 6; }
    });
  });

  // ---------- provenance ----------
  ensure(46);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, 40, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2, "F");
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(7.6);
  const prov = doc.splitTextToSize(
    "Generated from the department’s own apparatus-check records for the period shown. Item results, "
    + "notes and resolutions are reproduced exactly as recorded by the member who performed each check "
    + "and the officer who closed out each failure. Checks that passed are listed by date; checks that "
    + "failed are expanded in full. Times are shown in the department’s local time.", CW - 24);
  let py = y + 13;
  prov.forEach((ln) => { doc.text(ln, M + 12, py); py += 10; });
  y += 40 + 14;

  // ---------- certification ----------
  ensure(120);
  header("Certification");
  y = signatureBlock(doc, y, { lines: ["Inspected by", "Reviewed by"] });

  // ---------- footers ----------
  const n = doc.getNumberOfPages();
  const shortName = (station ? `${fullName} · ${station}` : fullName);
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, PH - 38, PW - M, PH - 38);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...GRAY);
    doc.text(`${shortName} · Apparatus Checks · ${periodLabel}`, M, PH - 26);
    doc.text(`Page ${i} of ${n}`, PW - M, PH - 26, { align: "right" });
  }

  const clean = (v) => String(v || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = clean(fullName) + (station ? "-" + station.replace(/\s+/g, "") : "")
    + `-Apparatus-Checks-${range.from || "start"}_to_${range.to || "end"}.pdf`;
  return { doc, slug };
}

/* ---------------- Station Hours (verified/credited, per member) ----------------
   The ISO/LOSAP artifact: who stood how many hours, which of those hours count, and the shift-by-shift
   record behind the totals.

   RENDERS, DOES NOT RECOMPUTE. Every figure here is passed in already summed by the Station Hours
   screen — the same `rows` it ranks the roster with and the same dept totals under its tiles. This
   builder does no arithmetic on hours beyond formatting them, which is the only way the PDF and the
   screen can be guaranteed to agree. If a number looks wrong, it is wrong on the screen too, and the
   fix belongs in the one place both read from.

   Rounding matches the screen exactly (h1: one decimal, rounded once at the end). Rounding per row
   would drift the column away from the total printed above it.

   data = { deptName, station,
            range:   { label, from, to },              // the chip the user picked, as shown on screen
            totals:  { credited, unverified, iso, members, shifts, verifiedPct },
            members: [ { id, name, standby, training, unverified, total, n, vTrue, vpct } ],
            shifts:  [ { member_id, member_name, checked_in_at, checked_out_at, hours, kind,
                         verified, auto_closed } ] }

   NO CAPTURE-METHOD COLUMN, deliberately. station_presence carries `source` (geo, gps_geofence, …) but
   dept_station_shifts does not return it, and widening that RPC is a schema change. An always-blank
   "Capture" column would look like missing data rather than an absent field, so the column is omitted
   and the provenance note says why. */
export function downloadStationHoursReport(data) {
  const { doc, slug } = buildStationHoursDoc(data);
  doc.save(slug);
}

export function buildStationHoursDoc(data) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 44, CW = PW - 2 * M;
  const BOTTOM = PH - 50;
  let y = M;

  const now = new Date();
  const prepared = `Prepared ${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const fullName = data.deptName || "Department";
  const station = data.station || "";
  const t = data.totals || {};
  const members = data.members || [];
  const shifts = data.shifts || [];
  const range = data.range || {};

  const stamp = (iso) => {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "—";
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  };
  const clock = (iso) => {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "—";
    const hh = d.getHours(), mm = String(d.getMinutes()).padStart(2, "0");
    return `${((hh + 11) % 12) + 1}:${mm} ${hh < 12 ? "AM" : "PM"}`;
  };
  const periodLabel = range.label ? String(range.label).toUpperCase() : "";

  y = reportBanner(doc, { deptName: fullName, station, subtitle: "Station Hours", period: periodLabel, prepared });

  const { ensure, header } = makeChrome(doc, { M, BOTTOM, getY: () => y, setY: (v) => { y = v; } });
  function para(text, color = SLATE, size = 9.3) {
    doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor(...color);
    doc.splitTextToSize(text, CW).forEach((ln) => { ensure(13); doc.text(ln, M, y + 9); y += 13; });
  }
  function table(head, body, opts = {}) {
    ensure(40);
    doc.autoTable({
      startY: y, head: [head], body, margin: { left: M, right: M },
      styles: { font: "helvetica", fontSize: 8.6, textColor: SLATE, cellPadding: 4.5, lineColor: LINE, lineWidth: 0.3, valign: "middle" },
      headStyles: { fillColor: SLATE, textColor: 255, fontStyle: "bold", fontSize: 8.4 },
      alternateRowStyles: { fillColor: PANEL },
      columnStyles: opts.columnStyles || {},
      didParseCell: (hook) => {
        if (hook.section === "body" && opts.badgeCol != null && hook.column.index === opts.badgeCol) {
          const [bg, fg] = badgeColors(hook.cell.raw);
          hook.cell.styles.fillColor = bg; hook.cell.styles.textColor = fg;
          hook.cell.styles.fontStyle = "bold"; hook.cell.styles.halign = "center";
        }
      },
    });
    y = doc.lastAutoTable.finalY + 14;
  }

  // ---------- cover ----------
  // CREDITED leads and is the only figure in red. Unverified sits beside it in muted grey on purpose:
  // it is recorded time and belongs on the page, but it must never read as though it were countable.
  const SH = 66;
  ensure(SH + 10);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, SH, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2.2, "F");
  const tiles = [
    { num: h1(t.credited), label: "CREDITED HRS", nc: RED,  sc: GRAY },
    { num: h1(t.unverified), label: "RECORDED", nc: NEUT, sc: NEUT },
    { num: h1(t.iso), label: "ISO HRS", nc: RED,  sc: GRAY },
    { num: String(t.members ?? members.length), label: "MEMBERS", nc: SLATE, sc: GRAY },
    { num: String(t.shifts ?? shifts.length), label: "SHIFTS", nc: SLATE, sc: GRAY },
  ];
  const colW = CW / tiles.length;
  tiles.forEach((tile, i) => {
    const x = M + i * colW;
    if (i > 0) { doc.setDrawColor(...LINE); doc.setLineWidth(0.75); doc.line(x, y + 10, x, y + SH - 10); }
    doc.setTextColor(...tile.nc); doc.setFont("helvetica", "bold"); doc.setFontSize(18);
    doc.text(tile.num, x + 12, y + 32);
    doc.setTextColor(...tile.sc); doc.setFont("helvetica", "normal"); doc.setFontSize(7.2);
    doc.text(tile.label, x + 12, y + 47);
  });
  y += SH + 8;
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  doc.text(`${range.label || "Selected period"}${t.verifiedPct == null ? "" : `  \u00b7  ${t.verifiedPct}% of check-ins verified`}`, M, y + 8);
  y += 12;
  // The recorded bucket is spelled out, not left as a bare word. A board reading "unverified: 60.0"
  // beside "credited: 5.0" will otherwise take the larger number for hours worked. Naming what it is
  // made of — attendance estimates and unverified check-ins — and that it is not creditable, is the
  // difference between a figure that informs and one that misleads.
  doc.setFontSize(7.4); doc.setTextColor(...NEUT);
  doc.text("RECORDED = drill attendance at the drill's recorded length + check-ins that were not location-verified. Not credited toward ISO/LOSAP.", M, y + 8);
  y += 20;

  // ---------- roster summary ----------
  header("Roster summary");
  if (!members.length) {
    para("No station hours recorded in this period.", GRAY);
    y += 8;
  } else {
    // Already ranked by credited hours on the screen; the order is preserved rather than re-sorted so
    // the two lists read identically. Padding unverified time cannot climb this list.
    table(["Member", "Credited", "Recorded", "Shifts", "Verified"],
      members.map((m) => [
        m.name || "—",
        h1(m.total),
        h1(m.unverified),
        String(m.n ?? 0),
        `${m.vpct ?? 0}%`,
      ]),
      { columnStyles: { 0: { fontStyle: "bold" }, 1: { halign: "right", cellWidth: 62 }, 2: { halign: "right", cellWidth: 66 }, 3: { halign: "center", cellWidth: 48 }, 4: { halign: "center", cellWidth: 56 } } });
  }

  // ---------- per-member detail ----------
  // Joined on member_id, not name: two members can share a name, and a county filing is the wrong place
  // to find that out.
  const byMember = new Map();
  for (const s of shifts) {
    const k = s.member_id ?? s.member_name;
    if (!byMember.has(k)) byMember.set(k, []);
    byMember.get(k).push(s);
  }
  members.forEach((m) => {
    const list = (byMember.get(m.id) || []).slice()
      .sort((a, b) => String(a.checked_in_at || "").localeCompare(String(b.checked_in_at || "")));
    header(`${m.name || "Member"} — ${h1(m.total)} credited`);
    if (!list.length) { para("No shifts in this period.", GRAY); y += 6; return; }
    table(["Date", "In", "Out", "Hours", "Kind", "Source", "Status"],
      list.map((s) => [
        stamp(s.checked_in_at),
        clock(s.checked_in_at),
        clock(s.checked_out_at),
        h1(s.hours),
        s.kind === "training" ? "Training" : "Standby",
        // WHERE THE ROW CAME FROM. "From attendance" means nobody clocked in — the times shown are
        // the drill's scheduled start and its recorded length, not an observed arrival and departure.
        // Printing those beside clocked rows without saying so would dress an estimate as a punch.
        s.source === "attendance" ? (s.optional ? "Attendance (optional)" : "From attendance") : "Clocked",
        // One column, because these are one question: does this shift count, and if not, why not.
        // auto-closed is named FIRST — it is the reason a verified shift can still be uncredited, and a
        // reader who sees only "Verified" on such a row would draw the wrong conclusion.
        s.auto_closed ? "Auto-closed" : s.verified ? "Verified" : "Unverified",
      ]),
      // Widths deliberately NOT pinned. Fixing all six columns left 174pt of the page unallocated,
      // which autoTable cannot distribute — it warns and renders the table narrow, adrift from the
      // full-width tables above it. Only the alignments are set; autoTable fits the rest to the page.
      { badgeCol: 6, columnStyles: { 3: { halign: "right" }, 6: { halign: "center" } } });
  });

  // ---------- provenance ----------
  ensure(84);
  doc.setFillColor(...PANEL); doc.rect(M, y, CW, 78, "F");
  doc.setFillColor(...RED); doc.rect(M, y, CW, 2, "F");
  doc.setTextColor(...GRAY); doc.setFont("helvetica", "normal"); doc.setFontSize(7.6);
  const prov = doc.splitTextToSize(
    "WHAT COUNTS. Credited hours are station standby and training shifts whose check-in was "
    + "location-verified at the station. Those are the hours reported for ISO and LOSAP.\n"
    + "ATTENDANCE-DERIVED HOURS. A member marked present at a drill earns hours at the drill's recorded "
    + "length. Those hours are RECORDED, never credited: nobody verified they were at the station, and the "
    + "times shown are the drill's schedule rather than an observed arrival. Where a member did check in, "
    + "their actual clocked duration is used instead and the estimate is not produced at all. Board meetings, "
    + "off-site sessions and drills with no recorded length produce no hours.\n"
    + "WHAT IS EXCLUDED, and shown anyway. Unverified shifts are recorded and listed but never added to "
    + "the credited figure. Auto-closed shifts are excluded even when the check-in was verified: the stop "
    + "time was estimated by the system rather than observed, so the duration is not evidence until an "
    + "officer confirms it. Off-site work, incident time, and shifts still open at the end of the period "
    + "are not included at all.\n"
    + "The ISO figure de-overlaps concurrent shifts and clips them to the period, so it will not always "
    + "equal the credited total. Capture method (manual or automatic check-in) is recorded against each "
    + "shift but is not reproduced here.", CW - 24);
  let py = y + 12;
  prov.forEach((ln) => { doc.text(ln, M + 12, py); py += 9.4; });
  y += 78 + 14;

  // ---------- certification ----------
  ensure(120);
  header("Certification");
  y = signatureBlock(doc, y, { lines: ["Prepared by", "Certified by"] });

  // ---------- footers ----------
  const n = doc.getNumberOfPages();
  const shortName = (station ? `${fullName} · ${station}` : fullName);
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.5); doc.line(M, PH - 38, PW - M, PH - 38);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...GRAY);
    doc.text(`${shortName} · Station Hours · ${range.label || ""}`, M, PH - 26);
    doc.text(`Page ${i} of ${n}`, PW - M, PH - 26, { align: "right" });
  }

  const clean = (v) => String(v || "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = clean(fullName) + (station ? "-" + station.replace(/\s+/g, "") : "")
    + `-Station-Hours-${clean(range.label) || "period"}.pdf`;
  return { doc, slug };
}
