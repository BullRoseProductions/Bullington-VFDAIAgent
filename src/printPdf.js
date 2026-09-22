import { jsPDF } from "jspdf";
import "jspdf-autotable";

/* THE PRINT SHELL, AS A PDF — the native half of printDocument.

   WHY A RENDERER AND NOT A SCREENSHOT. The obvious native route is html2canvas: take the
   same HTML, rasterise it, drop the bitmap in a PDF. It was rejected. A rasterised page
   is not selectable, not searchable and not readable when a chief zooms in on a phone,
   it triples the file size of a three-page set of minutes, and it needs a DOM node
   attached to a live document — which is exactly what a print pop-up was for, and pop-ups
   are the thing that doesn't work here. This draws real text instead.

   THE LAYOUT IS A DELIBERATE TRANSLATION OF printHTML'S STYLESHEET, not a fresh design.
   Every measurement below is the CSS px value times 0.75 (px -> pt), so the PDF a member
   shares from their phone and the sheet a member prints from a desktop browser are the
   same document: same crest, same rule under the header, same "Printed <date>" line, same
   uppercase ruled section headings. The two are meant to be indistinguishable in a folder.

   THE ONE ADDITION IS A PAGE-NUMBER FOOTER. A browser printing the HTML gets page numbers
   from the OS print dialog; a PDF shared out of the app carries nothing, and an unnumbered
   multi-page set of minutes is the kind of thing that gets stapled out of order. */

const PX = 0.75;                                  // CSS px -> PostScript pt, the whole conversion
const INK = [0, 0, 0], SUB = [51, 51, 51], RULE = [170, 170, 170], FOOT = [120, 120, 120];

// **bold** -> runs, matching sectionsToHtml's `inline` exactly: the same single-level,
// non-greedy, no-nesting rule, so a line cannot render bold on paper and plain on screen.
function toRuns(text) {
  const out = [];
  const s = String(text ?? "");
  let i = 0;
  const re = /\*\*([^*]+)\*\*/g;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > i) out.push({ text: s.slice(i, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    i = m.index + m[0].length;
  }
  if (i < s.length) out.push({ text: s.slice(i), bold: false });
  return out.length ? out : [{ text: "", bold: false }];
}

/* Word-wrap across a mixed bold/plain run list.

   jsPDF's splitTextToSize can only wrap one font at a time, so a paragraph with a bold
   phrase in it would either lose the bold or wrap at the wrong column. This walks words
   and measures each in its own font, which is the only way the line breaks land where the
   glyphs actually end. Returns lines of [{text, bold, w}] plus each line's width. */
function wrapRuns(doc, runs, maxW, size) {
  const widthOf = (t, bold) => { doc.setFont("times", bold ? "bold" : "normal"); doc.setFontSize(size); return doc.getTextWidth(t); };
  const lines = [];
  let line = [], lineW = 0;
  const push = () => { if (line.length) { lines.push(line); line = []; lineW = 0; } };
  for (const run of runs) {
    // Keep the spaces: splitting on /(\s+)/ means an intentional double space and the gap
    // either side of a bold phrase both survive into the PDF.
    for (const tok of String(run.text).split(/(\s+)/)) {
      if (tok === "") continue;
      const isSpace = /^\s+$/.test(tok);
      const w = widthOf(tok, run.bold);
      if (isSpace) { if (line.length) { line.push({ text: " ", bold: run.bold, w: widthOf(" ", run.bold) }); lineW += widthOf(" ", run.bold); } continue; }
      if (lineW + w > maxW && line.length) {
        while (line.length && /^\s+$/.test(line[line.length - 1].text)) { lineW -= line.pop().w; }   // no trailing space before a break
        push();
      }
      line.push({ text: tok, bold: run.bold, w }); lineW += w;
    }
  }
  push();
  return lines.length ? lines : [[]];
}

/* Build the PDF. Returns a Blob.
   blocks: [{type:"h2"|"p", text} | {type:"list", ordered, items:[text]} |
            {type:"table", head:[...], rows:[{cells:[...], muted}]}]
   logo:   a data: URI for the department crest, or null for the monogram fallback. */
export function buildPrintPdf({ title, deptName, meta, printedOn, logo, monogram, blocks }) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 0.5 * 72;                          // @media print { body { margin: .5in } }
  const CW = PW - 2 * M;
  const BOTTOM = PH - M - 14;                  // leave the footer band clear
  let y = M;

  /* The header block, drawn on page 1 only — matching the HTML, where .head is part of the
     flow and does not repeat. */
  const crest = 58 * PX;
  if (logo) {
    // A bad or unsupported data URI must not cost the member their document: without the
    // crest the sheet is still correct, so a failure here falls through to the monogram.
    try { doc.addImage(logo, M, y, crest, crest, undefined, "FAST"); }
    catch { drawMonogram(doc, M, y, crest, monogram); }
  } else {
    drawMonogram(doc, M, y, crest, monogram);
  }
  const tx = M + crest + 14 * PX;
  doc.setFont("times", "bold"); doc.setFontSize(20 * PX); doc.setTextColor(...INK);
  const headLines = doc.splitTextToSize(`${deptName} — ${title}`, CW - (crest + 14 * PX));
  let hy = y + 20 * PX;                        // first baseline
  headLines.forEach((l) => { doc.text(l, tx, hy); hy += 20 * PX * 1.15; });
  doc.setFont("times", "normal"); doc.setFontSize(12 * PX); doc.setTextColor(...SUB);
  const sub = [meta || "", `Printed ${printedOn}`].filter(Boolean).join(" · ");
  doc.text(sub, tx, hy - 20 * PX * 1.15 + 20 * PX * 0.95);
  y = Math.max(y + crest, hy) + 12 * PX;       // .head padding-bottom: 12px
  doc.setDrawColor(...INK); doc.setLineWidth(2 * PX);            // border-bottom: 2px solid #000
  doc.line(M, y, M + CW, y);
  y += 14 * PX;                                // .head margin-bottom: 14px

  /* ensure() RETURNS the cursor rather than mutating one.

     The renderers below (drawLines in particular) each hold their own y, so a shared
     mutable cursor would break a page inside a paragraph and then keep writing at the old
     coordinate — text stacked on the previous page's last line. Returning the corrected y
     means every caller has to accept the new position to keep going, which is the only
     shape of this that cannot silently get it wrong. */
  const ensure = (need, cy) => (cy + need > BOTTOM ? (doc.addPage(), M) : cy);

  for (const b of blocks || []) {
    if (b.type === "h2") {
      const size = 14 * PX;
      // break-after: avoid — a heading alone at the foot of a page reads as an empty
      // agenda item, so it carries one line of whatever follows it onto the next page.
      y = ensure(16 * PX + size + 3 * PX + 2 + 13 * PX * 1.5, y);
      y += 16 * PX;                            // h2 margin-top: 16px
      doc.setFont("times", "bold"); doc.setFontSize(size); doc.setTextColor(...INK);
      doc.setCharSpace(size * 0.04);           // letter-spacing: .04em
      const t = String(b.text ?? "").toUpperCase();
      doc.text(doc.splitTextToSize(t, CW)[0] ?? "", M, y + size);
      doc.setCharSpace(0);
      y += size + 3 * PX;                      // h2 padding-bottom: 3px
      doc.setDrawColor(...INK); doc.setLineWidth(1 * PX);
      doc.line(M, y, M + CW, y);
      y += 5 * PX;                             // h2 margin-bottom: 5px
      continue;
    }
    if (b.type === "p") {
      y = drawParagraph(doc, toRuns(b.text), M, y, CW, 13 * PX, ensure);
      y += 8 * PX;                             // p margin-bottom: 8px
      continue;
    }
    if (b.type === "list") {
      const size = 13 * PX, indent = 22 * PX;  // ul/ol padding-left: 22px
      (b.items || []).forEach((item, i) => {
        const marker = b.ordered ? `${i + 1}.` : "•";
        const lines = wrapRuns(doc, toRuns(item), CW - indent, size);
        y = ensure(size * 1.5, y);
        doc.setFont("times", "normal"); doc.setFontSize(size); doc.setTextColor(...INK);
        // RIGHT-ALIGNED against the text column. Left-aligned, "10." ran straight into the
        // first word the moment a list reached ten items — and a training plan's sequence
        // always does. Right-aligned, the numbers stack on their period like a printed list.
        doc.text(marker, M + indent - 4 * PX, y + size, { align: "right" });
        y = drawLines(doc, lines, M + indent, y, size, ensure);
        y += 3 * PX;                           // li margin-bottom: 3px
      });
      y += 6 * PX;                             // ul/ol margin-bottom: 9px, less the last li's 3px
      continue;
    }
    if (b.type === "table") {
      doc.autoTable({
        startY: y,
        margin: { left: M, right: M, top: M, bottom: M + 14 },
        head: [(b.head || []).map((h) => String(h).toUpperCase())],   // th { text-transform: uppercase }
        // .inact — the same word the HTML sheet prints in its small italic span. Grey text
        // alone is a style, not a statement, and a roster that lets an inactive member read
        // as active is the one error this sheet cannot make.
        body: (b.rows || []).map((r) => { const c = [...(r.cells || r)]; if (r.muted) c[0] = `${c[0]} (inactive)`; return c; }),
        theme: "plain",
        styles: { font: "times", fontSize: 12.5 * PX, cellPadding: { top: 6 * PX, bottom: 6 * PX, left: 10 * PX, right: 10 * PX }, textColor: INK, lineColor: RULE, lineWidth: { bottom: 1 * PX } },
        headStyles: { font: "helvetica", fontStyle: "bold", fontSize: 11 * PX, textColor: INK, lineColor: INK, lineWidth: { bottom: 2 * PX }, cellWidth: "auto" },
        // .r-inact — an inactive member prints greyed, exactly as the HTML roster does, so
        // the paper cannot imply somebody is on the active roll when they are not.
        didParseCell: (d) => { if (d.section === "body" && (b.rows[d.row.index]?.muted)) d.cell.styles.textColor = [85, 85, 85]; },
      });
      y = doc.lastAutoTable.finalY + 8 * PX;
      continue;
    }
  }

  // Page x of y, added last so the total is known.
  const n = doc.internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont("times", "normal"); doc.setFontSize(8); doc.setTextColor(...FOOT); doc.setCharSpace(0);
    doc.text(`Page ${i} of ${n}`, PW - M, PH - M + 10, { align: "right" });
  }
  return doc.output("blob");
}

// The monogram box the app falls back to when a department has no crest on file —
// .crest.mono: a 2px black rounded square with the initials centred in it.
function drawMonogram(doc, x, y, size, text) {
  doc.setDrawColor(...INK); doc.setLineWidth(2 * PX);
  doc.roundedRect(x, y, size, size, 8 * PX, 8 * PX, "S");
  doc.setFont("times", "bold"); doc.setFontSize(20 * PX); doc.setTextColor(...INK);
  doc.setCharSpace(20 * PX * 0.02);
  doc.text(String(text || ""), x + size / 2, y + size / 2 + 20 * PX * 0.36, { align: "center" });
  doc.setCharSpace(0);
}

function drawParagraph(doc, runs, x, y, maxW, size, ensure) {
  return drawLines(doc, wrapRuns(doc, runs, maxW, size), x, y, size, ensure);
}

/* Draw wrapped lines run by run, switching fonts mid-line. line-height: 1.5, as the
   stylesheet says. `ensure` is passed in rather than captured so a page break mid-list
   lands on the same margin as one mid-paragraph. */
function drawLines(doc, lines, x, y, size, ensure) {
  const lh = size * 1.5;
  for (const line of lines) {
    y = ensure(lh, y);
    let cx = x;
    for (const piece of line) {
      doc.setFont("times", piece.bold ? "bold" : "normal");
      doc.setFontSize(size); doc.setTextColor(...INK);
      doc.text(piece.text, cx, y + size);
      cx += piece.w;
    }
    y += lh;
  }
  return y;
}
