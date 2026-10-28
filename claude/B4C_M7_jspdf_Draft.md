# B4C — Security M-7 · jspdf 2.5.2 → 4.2.1 — DRAFT (client only). Not reviewed, not promoted.

**Branch:** `feat/m7-jspdf` off main `7e1addc`. No api / shared / SQL / vercel.json change. verified 132/32/14, Notify held.

## Versions
| package | before (main) | after | why |
|---|---|---|---|
| `jspdf` | `^2.5.2` → 2.5.2 | **`4.2.1`** (exact) | the audit's fix version (critical GHSA-wfv2-pwc8-crg5 + the highs) |
| `jspdf-autotable` | `^3.8.4` → 3.8.4 | **`5.0.9`** (exact; latest) | 3.8.4's peer range is `jspdf ^2.5.1`; 5.0.9 declares `^2 \|\| ^3 \|\| ^4` |

- Both are pinned exactly, matching how DOMPurify 3.4.17 was pinned for the XSS work.
- **Lockfile changes are limited to jspdf's dependency tree:**
  - added: `fast-png`, `iobuffer`, a nested `pako` (`@types/pako`);
  - removed: the `atob` and `btoa` polyfills, and jspdf's nested `dompurify`.

## DOMPurify — `npm ls dompurify`
Before (main):
```
├── dompurify@3.4.17
├─┬ jspdf-autotable@3.8.4
│ └── jspdf@2.5.2 deduped
└─┬ jspdf@2.5.2
  └── dompurify@2.5.9
```
After (this branch):
```
├── dompurify@3.4.17
├─┬ jspdf-autotable@5.0.9
│ └── jspdf@4.2.1 deduped
└─┬ jspdf@4.2.1
  └── dompurify@3.4.17 deduped
```
- **The old 2.5.9 is gone.**
- jspdf 4.2.1 still lists `dompurify ^3.3.1`, as an **optional** dependency used only by its `html()` path, which we don't call. npm installs it, and it **dedupes onto our own 3.4.17**, so there's one copy in the tree and in the lockfile.
- **The shipped bundle confirms it.** Main's `vite build` emits two DOMPurify copies: `purify.es-*.js` at "2.5.9" (from jspdf) and our "3.4.17". This branch's build emits **one**, `purify.es-*.js` at 3.4.17.

## Every `new jsPDF(` call site (6), and the matching autoTable call
| # | file:line | export | the user-facing button |
|---|---|---|---|
| 1 | `src/report.js` `buildReportDoc` | **Chief's Report** (department report) | Reports → Download PDF |
| 2 | `src/report.js` `buildCapitalPlanDoc` | Capital Replacement Plan | Fleet → Capital plan → Download PDF |
| 3 | `src/report.js` `buildApparatusCheckDoc` | **Apparatus check** (one rig, one check) | a check → Download PDF (2 places in App.jsx) |
| 4 | `src/report.js` `buildFleetCheckDoc` | **Fleet checks** (rigs × date range) | Apparatus checks → combined / per-truck PDF |
| 5 | `src/report.js` `buildStationHoursDoc` | **Station-hours report** | Station hours → Download PDF |
| 6 | `src/printPdf.js` `buildPrintPdf` | the native "Print" sheet (SOGs, documents, rosters) | Print, inside the iOS/Android app (web uses window.print) |

- The test pins these sites by count: exactly 6 `new jsPDF(` and exactly 6 `autoTable(doc, {`.
- Nothing else in `src/` or `shared/` imports jspdf. `share.js` and the `App.jsx` mention are comments only.

## What 4.x / autotable 5 required, and the only code change
- **The breaking change is autotable 5's registration, not jspdf 4.**
  - autotable 3 patched `jsPDF.API.autoTable` as a side effect of `import "jspdf-autotable"`.
  - autotable 5's side-effect import only patches a **global `window.jsPDF`**, and a bundled ESM import never creates that global.
  - So under 5.0.9 every `doc.autoTable({...})` is `undefined()`, and **all six exports would throw.** The test proves this with a real bundle: `typeof doc.autoTable === "undefined"`.
- **Fix, at all 6 sites:** `import { autoTable } from "jspdf-autotable"` (named), and `doc.autoTable({` → `autoTable(doc, {`.
  - The options objects are untouched: `didParseCell` hooks, styles, `startY`, `margin`.
  - `doc.lastAutoTable.finalY`, which every site reads, is still set by the functional form. The test checks that too.
- **jspdf 4 itself needed nothing.** I checked every jsPDF API the six builders use against the 4.2.1 typings and runtime: `text`, `setFont`/`setFontSize`, `setTextColor`, `rect`/`roundedRect`/`circle`/`line`, the fill/draw/line-width setters, `splitTextToSize`, `getTextWidth`, `setCharSpace`, `addPage`/`setPage`/`getNumberOfPages`, `internal.pageSize.getWidth/getHeight`, `internal.getNumberOfPages`, `addImage`/`getImageProperties`, and `output("blob")`. All are present and behave the same.

## How each PDF was verified as rendered, not just compiled
- **`docs/review/m7_jspdf_render.mjs`** bundles the **real** `src/report.js` and `src/printPdf.js` with esbuild, using the **browser** build of jsPDF (the one the app ships).
  - It feeds each builder a fixture shaped like the data `App.jsx` passes (read from the call sites), with `share.js` stubbed.
  - It writes all six PDFs.
  - The fixtures force page breaks: a 40-member roster, a 70-shift log and a 3-truck quarter. That exercises `lastAutoTable.finalY` after multi-page tables, and the "Page N of M" footers.
- **Old vs new, byte for byte:** the same script rendered main (jspdf 2.5.2, autotable 3.8.4, old code) and this branch.
  - **All 6 PDFs are byte-identical** once the three intentionally varying fields are normalised: `/Producer` (jsPDF 2.5.2 vs 4.2.1), `/CreationDate` and `/ID`.
  - That covers 15 pages: Chief's 4 · capital 1 · apparatus 1 · fleet 3 · station-hours 5 · print 1.
  - `M7_OLD_ROOT=<main checkout> node docs/review/m7_jspdf_test.mjs` repeats this check.
- **Opened and looked at.** Each new PDF was rasterised with the app's own pdf.js (`pdfjs-dist` 4.10.38) in Chrome and checked by eye:
  - **Chief's Report**, all 4 pages: banner and KPI tiles; the cert table with Lapsed/Expiring cell colours (so `didParseCell` works); the roster table continuing onto page 2 with its header repeated; Station Hours, Funding, Activity and Recent Training; "Page 1 of 4" through "Page 4 of 4".
  - **Station hours**, 5 pages: the per-member shift tables flow across pages.
  - **Apparatus check:** FAIL badge; Fail rows tinted; the resolution note; the certification lines.
  - **Fleet:** the summary with all 3 trucks; per-truck check tables; checklists split across pages.
  - **Capital plan:** forecast, per-year tables, Not Yet Planned.
  - **Print sheet:** monogram header, bold runs, ordered list; the table's muted row reads "(inactive)".
- **`npm run build`** (eslint + vite) passes. `printPdf` still splits into its own lazy chunk.

### Two layout quirks seen while looking (both pre-existing; identical bytes on main; NOT changed here)
- Station hours: a member's heading can be stranded at the bottom of a page, with its table starting on the next.
- Station hours: the CREDITED/RECORDED legend line under the tiles runs past the right margin.

These are candidates for a later polish slice, not for M-7.

## Tests
- **`docs/review/m7_jspdf_test.mjs`: 22/0** with `M7_OLD_ROOT`, 21/0 + 1 SKIP without it. It covers:
  - versions, pinned and agreeing across `package.json`, the lockfile and `node_modules`;
  - one DOMPurify, 3.4.17, in the tree and the lockfile;
  - the autotable-5 break, proven, and that the functional form works;
  - the 6/6 call sites;
  - all six exports rendered: valid PDF, expected page count, footers, and table cells present;
  - fences.
- **Two older review tests needed a test-only touch:** `scorecard_ui_test.mjs` and `onboarding_item_config_ui_test.mjs`.
  - They bundle `App.jsx` for Node, which selects jspdf's **node** build. That build binds `window.atob/btoa` at import, where 2.x shipped npm polyfills instead.
  - Their hand-made `window` stub had neither, so they crashed on load. The other App tests use happy-dom's full `Window`.
  - I added Node's own `atob`/`btoa` to the two stubs. They're back to 23/0 and 22/0, the same as main.
  - **No app code is involved:** the shipped bundle uses jspdf's browser build.
- **Full suite: 35 files, 975 PASS, 0 FAIL.** That's main's 954 plus this slice's 21. ESLint is clean.

## Changed files vs `7e1addc`
- `package.json`, `package-lock.json`
- `src/report.js`: the import, plus 5 × `autoTable(doc, {`
- `src/printPdf.js`: the import, plus 1 × `autoTable(doc, {`
- `docs/review/m7_jspdf_test.mjs` and `docs/review/m7_jspdf_render.mjs` (new)
- `docs/review/scorecard_ui_test.mjs` and `docs/review/onboarding_item_config_ui_test.mjs` (test stubs only)
- this writeup

## Before it ships
- **Native:** the print sheet is the native-only path. It's rendered and byte-identical here, but the store builds only pick it up in the next native build.
- **Suggested smoke after promote (web):**
  - download the Chief's Report, an apparatus check, a fleet-check range, and a station-hours month;
  - open each in Preview or Acrobat;
  - check the pages, tables and footers.
