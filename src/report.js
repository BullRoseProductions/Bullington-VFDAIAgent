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
  if (/(out of service|lapsed|expired|flag|high)/.test(t)) return [REDX_BG, REDX];
  if (/(expiring|watch|follow|needs|low|medium|probation)/.test(t)) return [AMBER_BG, AMBER];
  if (/(in service|current|healthy|active|ready|on target|pass)/.test(t)) return [GREEN_BG, GREEN];
  return [NEUT_BG, NEUT];
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
  const BH = 92;
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
  while (doc.getTextWidth(fullName) > avail && fs > 10) { fs -= 0.5; doc.setFontSize(fs); }
  doc.text(fullName, M + 56, y + 36);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(...PINK);
  doc.text(`${station ? station + " \u00b7 " : ""}Monthly Department Report`, M + 56, y + 54);
  doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  doc.text(period, M + CW - 14, y + 34, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...PINK);
  doc.text(prepared, M + CW - 14, y + 48, { align: "right" });
  y += BH + 16;

  // ---------- KPI tiles ----------
  const k = data.kpis;
  const tiles = [
    { num: `${k.active}/${k.total}`, label: "ACTIVE MEMBERS", sub: `${data.counts.prob} probationary`, sc: GRAY },
    { num: `${k.certPct}%`, label: "CERT COMPLIANCE", sub: `${data.counts.expg} expiring \u00b7 ${data.counts.expd} expired`, sc: k.certWarn ? REDX : AMBER },
    { num: `${k.avgPart}%`, label: "AVG PARTICIPATION", sub: "last 90 days", sc: GRAY },
    { num: `${k.rigsReady}/${k.rigsTotal}`, label: "APPARATUS READY", sub: `${k.rigsTotal - k.rigsReady} flagged`, sc: (k.rigsTotal - k.rigsReady) ? AMBER : GREEN },
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
  function ensure(h) { if (y + h > BOTTOM) { doc.addPage(); y = M; } }
  function header(title) {
    ensure(26);
    doc.setFillColor(...RED); doc.rect(M, y, 4, 13, "F");
    doc.setTextColor(...SLATE); doc.setFont("helvetica", "bold"); doc.setFontSize(12.5);
    doc.text(title, M + 10, y + 10.5);
    y += 21;
  }
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
  header("Chief\u2019s Summary");
  para(`As of ${MONTHS[now.getMonth()]} ${now.getFullYear()}, the department has ${c.active} active members of `
    + `${c.total} on the roster (${c.prob} probationary) and ${c.avgPart}% average participation over the last 90 days. `
    + `${k.rigsReady} of ${k.rigsTotal} apparatus are ready to roll. `
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

  // ---------- Personnel & Participation ----------
  header("Personnel & Participation");
  table(["Member", "Role", "Participation", "Status"],
    data.members.map((m) => [m.name, m.role, `${m.participation}%`, m.status]),
    { badgeCol: 3, columnStyles: { 0: { fontStyle: "bold" }, 2: { halign: "right" }, 3: { cellWidth: 90 } } });

  // ---------- Apparatus ----------
  header("Apparatus Readiness");
  table(["Unit", "Type", "Last check", "Readiness", "Note"],
    data.apparatus.map((a) => [a.name, a.type, a.lastCheck, a.ready ? "In service" : "Needs attention", a.note || "\u2014"]),
    { badgeCol: 3, columnStyles: { 0: { fontStyle: "bold" }, 3: { cellWidth: 84 } } });

  // ---------- Recent Activity ----------
  header("Recent Activity");
  table(["Event", "Date", "Type", "Attendance"],
    data.activity.map((e) => [e.name, e.date, e.type, `${e.present} / ${e.total}`]),
    { columnStyles: { 0: { fontStyle: "bold" }, 3: { halign: "right" } } });

  // ---------- Recommended Actions ----------
  const actions = [];
  data.flaggedCerts.filter((f) => f.status === "Lapsed").slice(0, 3).forEach((f) =>
    actions.push(`Schedule ${f.member} for the next ${f.cert} refresher \u2014 certification has lapsed.`));
  data.apparatus.filter((a) => !a.ready).forEach((a) =>
    actions.push(`Resolve ${a.name}: ${a.note || "needs attention"} before it returns to service.`));
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
    "How this report was produced. Drafted automatically from the department\u2019s roster, training, certification, "
    + "and apparatus records, then reviewed and approved by a qualified officer before release \u2014 the platform\u2019s "
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
