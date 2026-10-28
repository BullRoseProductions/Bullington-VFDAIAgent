# B4C — Bug B1 · approved training plan stuck expanded — FIX (client only). Not reviewed, not promoted.

**Branch:** `fix/b1-approved-plan-collapse` off main `291013e`. **Runtime change:** `src/App.jsx` (`TrainingPlans`)
only. No SQL, API or vercel.json change. verified 132 / 108 raw unchanged. Notify held.

## Root cause (Step 0, from the code + a repro test against main)
- The Training Plans detail panel has **no collapse path**:
  - The plan card is an `aria-pressed` toggle, but `select(id)` only ever *sets* `selId`. Clicking the open plan's card
    again re-selects it.
  - There's no close button.
  - "Nothing selected" can't be expressed either: `sel = find(selId) || find(first draft)`. Clearing the selection
    would just surface a draft.
- Once you approve a plan and open it to view, it stays open for good. Drafts mask this, because the first draft
  auto-surfaces by design.
- Server-side is not involved: approve and the data are untouched.

## Fix (minimal)
- `PLAN_CLOSED` sentinel for `selId` (a const inside `TrainingPlans`), meaning the member collapsed the panel on purpose. In that state `sel` is `null`,
  with **no** draft fallback. The fallback is kept for `selId === null` ("nothing chosen yet"), so the draft awaiting
  review still surfaces on first open.
- Clicking the **open** plan's card collapses it (`on ? collapse() : select(id)`).
- A visible **Collapse** button (ChevronUp) in the panel header is shown to every role, read-only members included.
- `collapse()` is ignored while editing, so an edit is never dropped, and the button is hidden while editing.
- `const on = !!sel && …`: `aria-pressed` now reads "false" instead of disappearing when nothing is open. This is a
  small a11y fix the collapsed state exposed.
- **Unchanged:** `approve_drill_plan` and every other action. Approving the draft that's showing still moves the panel
  on to the next draft, as before.
- **One deliberate behaviour note:** clicking the card of the plan that's currently showing, including an
  auto-surfaced draft, now closes it. That's the toggle the card always advertised (`aria-pressed`).

## Test — `docs/review/b1_plan_collapse_test.mjs` (real `TrainingPlans`, fake RPCs): 18/0
- **Repro, the tester's flow:** approve the draft awaiting review (one `approve_drill_plan(p1)`, no writes; the panel
  moves to the next draft, as before). Open the approved plan, then click its card: **collapsed**, and no draft pops
  up in its place.
- The Collapse button collapses it too. It reopens on a click, and switching cards switches plans.
- A plain member can open and collapse.
- While editing there's no Collapse button, and a card click keeps the edit.
- Fences.
- **Against main's unfixed `App.jsx` the test FAILs:** the plan stays "approved · Hose advance", and there's no
  Collapse control. So it reproduces the bug.
