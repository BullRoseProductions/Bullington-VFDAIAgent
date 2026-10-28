# B4C — Bug B2 (option a) · a category lists its plans in Training Plans — BUILD (client only). Not reviewed, not promoted.

**Branch:** `feat/b2-plans-by-category` off main `2ea5a38`. **Runtime change:** `src/App.jsx` (`TrainingPlans`) only.
No SQL, API or new query. verified 132 / 108 raw unchanged. Notify held.
Step 0: `claude/B4C_BugB2_PlanUnderCategory_Step0.md` (on `fix/b2-plan-under-category`).

## What it does
- A new **"Plans by category"** section sits directly above "Your plan library". It shows one card per category value
  in the library, each with its plan count and the plans' titles plus Draft/Approved.
- **Guardrail 1, no new query:** it's grouped from `plans[].category`, the screen's existing `cats` set (the same
  values the library's "Filter by category" select uses).
  - Clicking a category sets the **existing `catFilter`** and clears the search box, so every plan in it lists, then
    scrolls to the library. Clicking the active category again shows all.
  - Clicking a plan title sets the filter to its category and opens that plan (the existing `select`).
  - Plans with no category aren't grouped. They stay in the library as before.
- **Guardrail 2, kept distinct:** it's **its own section, not inside the "Training categories" card.**
  - That card is the recurring-requirements tracker (`training_plans`: name + cadence, what the Schedule shows as
    due), a different notion of "category". It's unchanged and lists no plans.
  - The new section's header says "Each plan's own category — the recurring Training categories are below".
  - The category colour dot reuses `colorOf`: a matching requirement category's colour when the names match, the
    muted grey when they don't.
- Visible to every role, the same as the library itself.

## Test — `docs/review/b2_plans_by_category_test.mjs` (real `TrainingPlans`, fake RPCs): 16/0
1. Create a plan in "Vehicle Extrication" through Start blank. It sends `set_drill_plan(p_id null, p_category
   'Vehicle Extrication')` and **lists under "Vehicle Extrication" immediately** (1 plan). Fire still lists only its
   own plan, and an uncategorised plan isn't grouped.
2. Clicking the category sets the existing filter and clears a stale search, and the library shows exactly that
   category's plans. Clicking again shows all.
3. Clicking a plan title opens it, filtered to its category.
4. The requirements card still shows name + cadence and no plan titles. The section is labelled as distinct. A
   read-only member sees it.
5. No new read: the only RPC on screen load is `dept_drill_plans`. Fences pass.

**Against main's `App.jsx` the test FAILs:** no category lists the new plan.
**Full suite:** 38 files, **1032 PASS, 0 FAIL**. `npm run build` (eslint + vite) passes.
