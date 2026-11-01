# B4C: wide-table scroll affordance (DRAFT, web only, NOT deployed)

**Branch:** `fix/scroll-affordance`, off main `8869d3d` (industrial-noir-60). The gate approved adding the affordance after
the phone-layout sweep found Station Hours tables that scroll inside their card with no visible cue.
**Changed:** `src/App.jsx` (a new `ScrollX` component plus ten call sites), `docs/review/scroll_affordance_test.mjs`, and this note.
No SQL, api, shared, native, `index.html` or `vercel.json` changes.

## The pattern (house style, one component)
`ScrollX` wraps any box whose table scrolls sideways inside its card:
- **Right-edge fade:** a 36px gradient into the card face. It shows only while columns are hidden to the right, and goes
  away once you've scrolled to the end. It is `aria-hidden` and `pointer-events: none`, so taps reach the table. It
  follows the card's corner radius and colour (Noir gradient midpoint `#0D1016`, or the plain card `#13161B`).
- **"Swipe for more →":** one muted line under the card, right-aligned, shown at `max-width: 640px` only while the table
  overflows. At the right end it fades out but keeps its line, so the card doesn't jump while you swipe.
- **When the table fits,** there is no fade and no hint.
- **Re-measuring:** it re-measures on every render (rows arriving, filters), on scroll, on window resize, with a
  ResizeObserver where available, and when the phone-width query changes.
- **No layout change to the tables.** Each call site only renames `div` to `ScrollX` and drops `overflowX: "auto"` (ScrollX
  supplies it). The card's own style stays on the scroller; its outer margin moves to the wrapper, so card spacing is
  unchanged. Nothing is hidden or clipped.

## Where (all ten in-card table scrollers)
| Screen | Table |
|---|---|
| **Station Hours report** | Hours by member · ISO hours (no double-counting) · ISO hours by house · Shift log |
| Attendance report | the detail table |
| Capital plan report | each year's table · Not yet planned · Depreciation estimate |
| Roster → attendance | "Who's showing up" (member × last 10 sessions) |
| Qualifications | the member × qualification matrix |

**Left as they are (not tables):** the capital forecast card and its bar chart, and the sheet tab strip.

## Proof
- **Real Chrome** (the `docs/review/phone_layout_sweep/` harness, with a temporary Station Hours fixture that was reverted
  and not committed), on the Station Hours report:

  | Width | Hours by member | ISO hours | Shift log (fits) | Page overflow |
  |---|---|---|---|---|
  | 360 | 349px wider: fade + hint | 173px wider: fade + hint | neither | 0 |
  | 430 | 279px wider: fade + hint | 103px wider: fade + hint | neither | 0 |
  | 1000 | 15px wider: fade, no hint (desktop) | fits: neither | neither | 0 |

- **`scroll_affordance_test.mjs`: 25/25.** happy-dom has no layout, so the test sets the scroller's widths and the
  phone-width query by hand and renders the real `ScrollX` from the bundled App. It proves the logic:
  - the hint is present at 360 when the table overflows and absent when it fits;
  - the fade shows only while there's more to the right;
  - it re-measures when rows arrive;
  - it shows the fade only on desktop, and the hint appears on crossing into phone width;
  - the style and margin split is right, with the right colour per skin.

  From the source, it also checks the ten call sites; that every call-site hunk is a pure tag rename (each style kept
  exactly, minus `overflowX`); that no overflow hidden/clip was added; the fences; counts 132/32/14; and Notify held. It does
  **not** prove that a given report is wider than 360px; the Chrome run above covers that.

## ⚑ One visible side effect, for the gate
The four Station Hours cards and the capital cards scroll as **whole cards** (header and explainer text included); that is
the existing structure, which I didn't change. So while the fade shows, it also softly dims the last ~12px of each line of
the ISO explainer's text at the card's right edge. Fixing that properly means moving `overflowX` from the card to just the
`<table>`, which is a layout change to those cards, so it's left as your call.
