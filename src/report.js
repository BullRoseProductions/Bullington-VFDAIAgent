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

function badgeColors(text) {
  const t = String(text).toLowerCase();
  if (/(out of service|lapsed|expired|flag|high|overdue)/.test(t)) return [REDX_BG, REDX];
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
  // dept name (auto-fit)
  doc.setTextColor(255); doc.setFont("helvetica", "bold");
  let fs = 15.5;
  doc.setFontSize(fs);
  const avail = CW - 60 - 100;
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

  // ---------- Recommended Actions ----------
  const actions = [];
  data.flaggedCerts.filter((f) => f.status === "Lapsed").slice(0, 3).forEach((f) =>
    actions.push(`Schedule ${f.member} for the next ${f.cert} refresher \u2014 certification has lapsed.`));
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
