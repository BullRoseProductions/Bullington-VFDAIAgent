# B4C — Training page polish — BUILD ORDER for CC

**Scope:** two small UI tweaks to the Training page, from Ashlea looking at live (North Hood, DA) on 2026-10-24. Web-layer only, **no DB**. Deliver a diff for gate review, then promote (Notify crew held back, served-verify). FIRE/FS tokens, Industrial Noir, `verified` untouched. Independent of the Training Officers UI slice — keep this a clean separate diff; it can land before or after that one (both touch `TrainingSchedule`, so rebase cleanly / don't tangle the reviews).

## 1. Move the "Schedule | Training Plans" toggle to UNDER the page header
Today the toggle (`viewToggle`, the `NoirSeg` built in the `Training` wrapper, `App.jsx:~23817`) is rendered as the **first item in the PageShell `above` slot**, so it sits *above* the red "Keep training on schedule" / "Your training calendar" band. Ashlea wants it **directly under that band header**, above the "8 finished drills" notice.

- Move `viewToggle` out of the `above` slot and render it as the **first element inside the page body** (just inside `NoirSkin` / the content, before the drills notice) in **every** Training view that shows it:
  - `TrainingSchedule` leader return (`App.jsx:~24504`, the "Keep training on schedule" PageShell),
  - `TrainingSchedule` member return (`App.jsx:~24360`, "Your training calendar"),
  - `TrainingPlans` (its own `PageShell` — move its `{viewToggle}` from `above` to the top of the body too).
- Keep the rest of `above` as-is (the `OfflineNotice` / `mounts`). The toggle must stay **visible and functional on BOTH views** and sit in the **same spot** on each so flipping Schedule↔Training Plans doesn't make the page jump. Keep its `marginBottom`.

## 2. Make the "8 finished drills with no length recorded" notice collapsible (tuck-away)
Today it's an always-expanded amber left-border card (`TrainingSchedule` leader return, `App.jsx:~24514`, the `noLen` block). Ashlea wants it to **tuck away so it's not always shouting** — collapsible, like the reports **"Needs your attention"** card.

- Make it a **collapsible card using the same pattern as the reports attention card** (`CardHead` with `onToggle` chevron / the `attnOpen` `useState` pattern at `App.jsx:~4057`): a **compact header row always visible** — the `Clock` icon + "**N finished drills with no length recorded**" + a chevron — and the **explanation sentence + the session list collapse/expand** beneath it.
- **Default collapsed** (tucked) — that's the point; the count stays visible in the header so it still nudges, just quietly. (If Ashlea later wants it default-open, it's a one-line flip.)
- Keep the **amber accent** (the `FIRE.amberText` left border / icon). It still renders **only when `noLen.length > 0`**, so it naturally "comes back while drills still need a length." Collapse state is view-local `useState` (no persistence needed; fine to leave it re-collapsed on reload).

## Review hooks (what I'll check on the diff)
- Only `src/App.jsx`; no DB; `verified` literal unchanged; FIRE/FS tokens; Noir; mock/pattern-faithful.
- The toggle renders **under** the band header on Schedule, Training Plans, and the member view, in the same spot on each, still switching views.
- The drills notice is collapsible (reports-attention pattern), **default collapsed**, header shows the count, amber kept, still appears whenever `noLen > 0`.

## Promote
Web-layer on current `main`. Notify held back; I verify the candidate from git (only this diff vs `main`, no Notify, `verified` equal), then served-verify (toggle under the header + the drills notice collapses).
