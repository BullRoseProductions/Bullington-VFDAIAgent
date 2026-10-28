# B4C — Bug B2 · "a new plan doesn't show under its category" — STEP 0 (no code change)

**Branch:** `fix/b2-plan-under-category` off main `291013e`. **Read-only** live checks and a UI probe; nothing changed.

## What it isn't
- **(a) Tagging on save: fine.**
  - Every create path sends `p_category`: the AI draft, Start blank, and Edit.
  - Live `set_drill_plan` (md5 `f574003f…`) stores `category = nullif(btrim(p_category),'')`.
  - The tester's live plan is stored correctly. Indian Harbor, "vehicle extrication with holmatro representatives",
    2026-10-28 14:33, approved, AI, has `category = 'Vehicle Extrication'`. That's exactly the name of Indian Harbor's
    "Vehicle Extrication" category (`training_plans`, One-off).
- **(b) The query: fine.** Live `dept_drill_plans` (md5 `d786d559…`) returns `p.category`. No RLS question arises: the
  row comes back to the creator's department.
- **(c) Stale state: fine.** In a probe against the real `TrainingPlans` component:
  - Start blank with category "Vehicle Extrication" sends `p_category: "Vehicle Extrication"`.
  - The new card is in the library immediately, its meta line reading "Vehicle Extrication · …".
  - The "Filter by category" dropdown gains "Vehicle Extrication".
  - Filtering on it lists the new plan.

## What it is
**No category view lists plans at all.**
- The **Training categories** card (Training Plans → bottom) and the Schedule's **Training categories** tiles are the
  recurring-requirement tracker. `training_plans` rows are categories with a cadence, and the tiles show the last
  held *session* and what's due.
- Neither renders the drill plans tagged to the category, for any plan, new or old. In the probe, the card shows
  "Vehicle Extrication · One-off" and nothing else.
- So "a category lists every plan tagged to it" is a missing link, not a refresh or grouping bug. The one place plans
  *are* grouped by category, the library's category filter, works.

## Decision needed: where should a category show its plans?
1. **(Recommended) The Training categories card in Training Plans.** Under each category row, add
   "N plans: title, title, …". Clicking a plan opens it in the library above, filtered to that category. This is
   client-only, uses data the view already has (the `plans` list), and puts the link right next to the plan library.
2. **The Schedule's category tiles.** Add "N plans" to each tile, linking to Training Plans filtered to that category.
   This is the view a member sees first, but it mixes plans into a session tracker.
3. **Both.**

All three are client-only, with no SQL or API, and none changes how plans are saved. Once you pick one, I'll build
it with a test that creates a plan in a category and asserts it's listed there.
