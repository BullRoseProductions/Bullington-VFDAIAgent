# B4C — Phone layout: the Notifications screen + the horizontal-scroll sweep — DRAFT (web only). NOT deployed.

**Branch:** `fix/phone-layout`, off main `308f906` (industrial-noir-59). Ashlea's Oct 31 report: the Notifications layout is
off in the app, and several screens scroll side-to-side.
**Changed:**
- `index.html`;
- `src/Notifications.jsx`;
- `src/App.jsx`: CardHead, the Training "Show" select, the Recruit grids, toast text;
- `docs/review/phone_layout_test.mjs`;
- `docs/review/phone_layout_sweep/`: the dev harness, not shipped;
- this note.

**Unchanged:** no SQL, api, native or `vercel.json`. **No `overflow-x: hidden` / clip added anywhere** (the test asserts it).

## How it was measured (Step 0)
**Real Chrome layout, not happy-dom.**
- `docs/review/phone_layout_sweep/` serves the real app from this branch, with `supabaseClient` / `apiBase` aliased to fakes.
- The fakes give a DA/PA identity and realistic fixtures: long names, emails, serials and URLs.
- Every screen loads into an iframe of exactly **360 / 375 / 390 / 430 px**. All 28 screens × 4 widths = 112 renders.

**Each render reports:**
- page-level overflow;
- every element that scrolls or clips content wider than itself;
- the deepest elements that poke out.

**Two things the sweep taught:**
1. **The app shell already clips sideways.** The main column is `overflow: hidden auto`; with `overflow-y: auto`, CSS forces x to
   hidden or auto. So in a browser an offender never shows as page scroll: it's **silently cut off** and reads as CLIPPED on that
   column. Every such entry is a real offender.
2. **The sideways panning Ashlea sees isn't layout.** No screen overflowed the page at any width. It's **iOS focus-zoom**, below.

## The offender list
| # | Screen / element | Cause | Before (real layout) | Fix | After |
|---|---|---|---|---|---|
| **R** | **Every screen with a text field, on iPhone** (Safari and the app's WKWebView): sign-in, search, filters, forms | iOS **zooms in when a field under 16px is tapped** and stays zoomed, so the page then pans sideways. Inputs were `FS.input` 14.5px, sign-in 15px, many inline 12–13px; the viewport meta allows zoom | the side-to-side scroll in the report (iOS behaviour; desktop layout can't show it) | `index.html`: on `(hover: none) and (pointer: coarse)`, text inputs / select / textarea → **16px** (`!important`, since sizes are inline). **Pinch-zoom is NOT disabled** (no `maximum-scale` / `user-scalable=no`) | a forced-16px sweep (the rule injected, since desktop Chrome won't match the media query) shows **no new overflow on any screen** |
| A1 | **Notifications** list: a body with an email / URL | flex child `minWidth: 0` but unbreakable strings; the list box `overflow: hidden` **cut them off** | CLIPPED 162px at 360 | title in its own `minWidth: 0` span; title + body `overflowWrap: "anywhere"` | clean at 360 / 375 / 390 / 430, and in the Settings sub-view |
| A2 | **Notifications** header | title `flex: 1; minWidth: 150`: at 360, "Mark all read" and the cog wrapped **separately**, left-aligned under Back ("the layout is off") | visual | Back + title (`minWidth: 0`) share line 1; **both actions in one group with `marginLeft: auto`**, so they wrap together, right-aligned; the "N new" badge can't split | visual check at 360: one tidy right-aligned action row |
| B1 | **Training** session list header (and any `CardHead` with a right-hand slot) | `CardHead` was one `nowrap` flex line: title + count + right slot (the select + Edit button) couldn't fit at 360 | CLIPPED **43px** at 360 (28 at 375, 13 at 390); 84 / 54 / 14 with 16px inputs | `CardHead`: `flexWrap: "wrap"`; the right slot drops to its own line, still right-pushed. One line wherever it fits (every desktop card) | **0** on 10 / 10 Training samples (5 reloads × 2 times, with 16px forced); full after-sweep clean |
| B2 | **Training** "Show" select | a `<select width:auto>` sizes to its longest option ("Completed this month") | part of B1 | `maxWidth: "100%", minWidth: 0` | part of B1 |
| C | **Recruit** 60-day plan phases | `repeat(3, 1fr)`: a plain `1fr` can't go below min-content, so the 3rd column pushed out | CLIPPED **16px** at 360 | `repeat(auto-fit, minmax(min(200px, 100%), 1fr))`: three across where they fit, stacked on a phone. Same for the unused `tierRow` sibling | clean at all four widths |
| D | **Toasts** ("We emailed a login link to …") | title / text had no wrap rule; a long email ran past the ≤324px toast at 360 | not hit by the fixtures (data-driven) | title + text `overflowWrap: "anywhere"` (details already wrapped) | — |
| E | everywhere: long emails / URLs / serials in ordinary text | no wrap default | — | `html { overflow-wrap: break-word }`: the typographic default. It breaks a word **only** when it would overflow its line, so ordinary text is unchanged and **nothing is hidden** | — |

**Checked and not changed (by design):**
- **Roster card glow:** an absolutely positioned decorative circle (`right: -30px`) the card is meant to crop. It's "CLIPPED 30px" at every
  width, and it's deliberate.
- **Ellipsis truncation:** Equipment, Funding and Roster names with `text-overflow: ellipsis; white-space: nowrap` are intended, and are
  excluded from the sweep's report.
- **Station Hours report tables:** already scroll **inside their own card** (`overflowX: "auto"`), never the page. There's **no visible
  affordance** that they scroll, though. ⚑ **A design call:** a right-edge fade or a "scroll →" hint. Not built.
- **Grid floors:** every `minmax(Npx …)` floor is ≤ 260px, which fits a 360px phone's content box. There are no fixed widths ≥ 340px and
  no horizontal negative margins that escape a card. The six `<table>`s: four are wrapped, and two are print HTML.

## The screens that can't fit 360px
**None found.** Every screen fits once the offenders above are fixed, so there's no design question about a screen.

## What the review test can and can't prove
**`docs/review/phone_layout_test.mjs`, 20/0.**
- **happy-dom has no layout**, so it **can't** assert "no horizontal overflow at 360px". That proof is the Chrome sweep above, before
  and after.
- **The test asserts:**
  - the **real `NotificationCenter`**, rendered with long strings, carries the fix: title / body wrap; the shrinkable title; both actions
    in one right-pushed group; the badge nowrap;
  - the 16px touch rule exists, and main's 14.5px / 15px inputs were the cause;
  - the viewport meta is byte-identical to main's (zoom kept);
  - `html` break-word;
  - CardHead wrap, the select, the Recruit grid, the toast wraps;
  - **no `overflow` hidden / clip assignment was added** in any changed file.
- **Fences:** only the files above; verified 132/32/14; Notify held.
- **To re-run the real-layout proof:** `docs/review/phone_layout_sweep/README.md`.

**Native:** the iOS / Android apps run their bundled web code, so the input-zoom fix reaches them with the next native build (build 18).
The web app gets it on deploy.
