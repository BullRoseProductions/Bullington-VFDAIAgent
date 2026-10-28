# Security list item 1 — M-1 / M-2 stored-XSS hardening (DRAFT — client only, nothing shipped)

Branch `feat/xss-m1-m2` from `origin/main` (84a698c). No DB, no `api/`. verified 132 / 32 / 14 (case-insensitive, as fenced),
`api/notify-session.js` absent. Ships to web on promote; rides the next native build.

## M-1 — the docx preview
- `src/safeHtml.js` (new): `sanitizeDocxHtml(html)` — **DOMPurify 3.4.17**, pinned exactly (`"dompurify": "3.4.17"`, published
  2026-10-12, 16 days old; npm `latest`; no open advisory — the audit's DOMPurify finding is `<=3.4.16`). Bundled from node_modules,
  lazy-loaded with mammoth on the first docx preview (its own 12 kB-gz chunk; main bundle unchanged by it).
  Config: HTML profile only (no SVG/MathML); script/style/form/input/button/iframe/object/embed/base/meta/link forbidden; `style`,
  `srcset`, `action`, `formaction`, `ping`, `xlink:href` attributes forbidden; every `on*` handler stripped (DOMPurify default);
  URI allowlist `https? / mailto / tel / #`. A hook then runs every surviving `href` through **the same `safeHref`** as M-2 and
  makes external links `target=_blank rel="noopener noreferrer"` (on a phone a same-tab link would replace the app's web view).
  Kept: in-doc anchors (`#_Toc…`), mammoth's embedded images (`data:image/…` on `<img>` only), tables, lists, emphasis.
  **Fails closed**: no usable DOM → `""` → the viewer's existing Download fallback.
- `src/App.jsx` DocViewer: `setHtml(sanitizeDocxHtml(value))` — the only `setHtml` call; `dangerouslySetInnerHTML` renders only that state.

## M-2 — user-supplied links
- `src/safeHref.js` (new): `safeHref(raw)` → the parsed href if the scheme is **http / https / mailto / tel**, else `null`.
  Uses the WHATWG URL parser (the browser's own), which strips leading control chars and every tab/newline before reading the
  scheme — so `java\tscript:`, `" javascript:"`, `JaVaScRiPt:` are all caught; what is checked is byte-for-byte what is rendered.
- Routed through it: **Resources → Website** (`r.website`), **Resources → Email** (`mailto:${r.email}`), and the **Donate page**
  link on donation funds (`c.external_url` — not named in the roadmap, found by the sweep). A rejected scheme renders **no link**.

### ⚑ One behavior choice for your ruling
A **bare host** (`www.firehero.org`, `firehero.org/help`) is read as `https://…`. Rendered raw today it is a *relative* link into the
app itself (broken on web, navigates the web view on a phone). Only strings shaped like a hostname are promoted; nothing else is
guessed. If you'd rather keep it strict (bare host → no link), it's one line in `safeHref`.

## The sweep — every render site in `src/` (the test re-derives this and FAILS on any unclassified site)
**`dangerouslySetInnerHTML`** — 1 site: App.jsx DocViewer `.docx-view` → **now DOMPurify (M-1)**.

**`href={…}`** — 13 sites, all App.jsx:
| site | expression | verdict |
|---|---|---|
| ResourceActions labelBtn / iconBtn (2) | `href` param | the `b(…)` calls: Website `safeHref(r.website)` **→ helper**; Email `safeHref(mailto:…)` **→ helper**; Call/Text `tel:`/`sms:${telDigits()}` (fixed scheme, digits only); Directions `mapsHref()` (fixed `https://maps.…/?q=` + encodeURIComponent) |
| DonationFunds Donate page | `donate` | `safeHref(c.external_url)` **→ helper** |
| Reach-out / Your Six call + text (5) | `` `tel:${telDigits(…)}` `` / `` `sms:${telDigits(…)}` `` | app-built: fixed scheme, digits-only payload |
| Settings legal rows | `href` from `LEGAL` | constant `https://b4thecall.com/legal/…` |
| Geofence disclosure | `GEOFENCE_DISCLOSURE.policy.href` | constant https literal |
| Support | `` `mailto:${SUPPORT_EMAIL}` `` | constant |
| DocViewer Download (2) | `url` | Supabase signed URL — all 5 DocViewer callers pass `data.signedUrl` |

**`window.open(`** — 2 sites: the print shell `window.open("", "_blank")` (writes HTML built by `blocksToHtml`, which escapes every
field via `printEsc`; signature images pass `rsSafeSig`) and `window.open(data.signedUrl, "_blank", "noopener")`. Neither takes a user URL.
**Elsewhere in `src/`**: none of the three; `share.js`'s `a.href = url` is its own `URL.createObjectURL(blob)`.
**Not in scope, noted:** `<img src={…}>` sites (signatures, signed photo URLs, data URLs) — browsers do not execute `javascript:` in `img src`.

## Tests — `docs/review/xss_m1m2_test.mjs` (36 PASS, 0 FAIL) · full suite 32 tests, 898 PASS, 0 FAIL · build OK
1. safeHref: 19 hostile inputs → null (javascript:/data:/vbscript:/file:/blob:/sms:/about:, case / whitespace / tab / newline /
   control-char spellings, protocol-relative, relative); real links pass as the parsed href.
2. sanitizer on crafted payloads: no handler attribute, no javascript:/vbscript:/data:text href/src/action/formaction, no
   script/iframe/object/embed/svg/math/form/style/base; link text kept; a same-line https link survives (new tab, noopener); a normal
   document (heading, emphasis, list, table, https + mailto, in-doc anchor, embedded data:image) renders intact; fails closed.
3. a **real .docx built in the test**: raw mammoth output *carries* `href="javascript:…"` / `href="data:text/html…"` (the hole is real);
   sanitized, gone — text and the https link and table kept.
4. **rendered from the real bundled App.jsx**: DocViewer shows that .docx with no executable href and no handler; ResourceActions with a
   javascript: / data: / tab-split website renders no Website link (Call still works), with https renders it intact (new tab);
   DonationFunds with javascript: / data: / https campaigns renders exactly one Donate link — the https one.
5. pins: the site sweep above; DOMPurify pinned exactly, lockfile + node_modules agree, imported only by `safeHtml.js`, no CDN;
   verified 132/32/14; Notify held; only App.jsx + the two helpers + package.json/lock + this test/record changed.

**Test DOM:** these run under **jsdom 30.1.2** (`JSDOM_DIR=…`), test tooling only, not a project dependency. Under happy-dom,
DOMPurify 3.4.17 misbehaves (drops `<a>` wholesale yet keeps `onerror`, mis-parses attributes) — a result there says nothing about
a browser, so happy-dom is not used for this test. To re-run: `npm i --prefix <dir> jsdom@30.1.2` then
`JSDOM_DIR=<dir> node docs/review/xss_m1m2_test.mjs`.

## Follow-ups (not folded in)
- **Optional, defense-in-depth:** a write-side `CHECK` on `resources.website` / `donation_campaigns.external_url`
  (`~* '^(https?://|mailto:)'` or NULL) — a DB slice of its own.
- **Pre-existing audit findings, separate slice:** `jspdf` 2.5.2 (critical; its nested DOMPurify 2.5.9 is the audit's DOMPurify hit —
  only reachable through `jspdf.html()`, which the app never calls) and `jspdf-autotable`; the fix is a semver-major bump. Capacitor
  8.5.0 is already tracked for the next native build.
