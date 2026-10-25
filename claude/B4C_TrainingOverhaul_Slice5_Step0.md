# B4C — Training Overhaul Slice 5 (build a session from the Library + build-from-scratch) — STEP 0 (audit + plan, no code)

Spec [[B4C_TrainingOverhaul_Spec_Step0]] §"Training Library = the session builder". Audited from the live code on **main
`38ad62a`** (`src/App.jsx`; line numbers are main's), plus one read-only live query
(`docs/review/training_slice5_STEP0_OUTPUT.json`).

**Scope: UI-only.** No schema change, no new RPC, `verified` untouched, Notify held back. Every write in the plan is an
existing path, and all three are gated live by **`is_training_manager()`**, the exact twin of the client's
`canManageTraining`.

## What exists today — and where the gap is
**Session creation lives only on the Schedule tab:**
- the **"Schedule a session"** form opens inside the calendar card (`#tr-schedule`, opened from the hero's "Schedule
  session", the calendar's "Schedule a session", or a status-strip "Schedule");
- **its fields:**
  - Training **category** (`spid` → `plan_id`, a `training_plans` row or One-off);
  - **title** (blank defaults to the category name);
  - **day** (in the calendar's month), **start time**, **length** (`sDur`, optional);
  - **audience** (everyone / leadership / board), **counts toward attendance**, **meeting** (everyone only);
  - **off-site** + label;
  - **repeat** (weekly / bi-weekly / monthly-on-the-Nth-weekday × N occurrences).
- **The writes:**
  - `addSession()` (24270) is one direct `training_sessions` insert. It doesn't return the new row; it closes the form
    and reloads.
  - `scheduleRecurring()` (24302) is one bulk insert of the series, deduped per (category, date), and it updates the
    category's `starts_on`.
  - Live INSERT policy: `leaders write training_sessions`, `department_id = my_department_id() AND
    is_training_manager()`.
- Neither attaches a plan.

**The Library** (the Training Plans tab, `TrainingPlans`, 23712):
- **Draft with AI:** topic, type, duration, category (a select of the `training_plans` names), members expected, skill
  level, standard / SOG, **"Focus & notes"**.
- It saves the draft as a **draft** drill plan (`set_drill_plan`, `p_source 'ai'`).
- **For a selected plan:**
  - **Edit** (`DrillPlanEditForm`, 23587: title, category, duration, "who it's for", summary, objectives, run of show,
    materials, safety);
  - **Approve / Back to draft**, **Delete**;
  - **Attach to session**, which since Slice 4 lists upcoming **trainings** only.
- Writes are gated by `canWrite` = `canManageTraining`.

**The gap:** the Library can only attach a plan to a session that **already exists**. Its own empty state says "No
upcoming sessions — schedule one on the Schedule view first." There's no path from "this plan" to "a scheduled session
with this plan on it", and no way to write a plan without the AI.

**Live:**
- `drill_plans` is **empty**: no plans, `ai` or `manual`, in any department;
- no library plan is attached to any session;
- `drill_plans_source_chk` is `source IN ('ai','manual')`, and `set_drill_plan` accepts `'manual'` on create;
- all three writes are gated `is_training_manager()`: the session insert, `set_drill_plan`, and
  `attach_drill_plan_to_session`.

## The "build a session from the Library" flow — recommendation
**Option A (recommended): "Schedule with this plan" hands off to the existing Schedule form.**
1. On a selected Library plan (and as the last step of "Start blank", below), a **"Schedule with this plan"** button,
   under `canWrite`.
2. It flips the toggle to **Schedule**, the reverse of Slice 2's `goPlans`, and opens the **existing** schedule form,
   **pre-filled**:
   - **title** = the plan's title;
   - **length** = the plan's `duration_min`;
   - **category** = the `training_plans` row whose name matches the plan's category (case-insensitive), else One-off;
   - **day** = today in the current month. Audience / attendance / off-site / repeat keep the form's defaults.
   - A chip on the form, **"With plan: <title> ✕"**, shows the plan will be attached (✕ drops it, back to a plain
     schedule).
3. The officer **confirms or changes** every field in the form they already know, then presses the form's own
   Add / Schedule.
4. **The writes are all existing paths:**
   - `addSession` / `scheduleRecurring` insert exactly as today, but **return the new id(s)** (`.select("id")` on the same
     insert; the read is already allowed);
   - **then** `attach_drill_plan_to_session(plan, session)` for the new session(s), the existing RPC.
   - **No new RPC, no schema.**

**Trade-offs:**
- **Not atomic.** If the insert succeeds and the attach fails, the session exists without the plan. The UI says so ("The
  session is scheduled; the plan couldn't be attached — attach it from the Library") and nothing is lost. Making it
  atomic needs a new RPC (DB), which isn't recommended for a two-step that's safe to retry.
- **It leaves the Library for the Schedule tab.** That's deliberate: the date, time, length, audience, attendance,
  location and repeat logic lives in one form, so there's one place to keep correct, and recurrence (series, dedupe,
  `starts_on`) isn't duplicated.

**Option B (an inline mini-form in the Library): not recommended.** It's a second copy of the schedule form (fields,
validation, and above all recurrence), and the two would drift. The only gain is not switching tabs.

**Series + plan (Ruling 2):** when "repeat" is on, attach the plan to **every** new occurrence (recommended), so each
session's "View plan" shows it and members see it on every Up-next card. That's one RPC per occurrence (≤ 104, the
existing clamp), sequential, with a single summary toast. The alternative is the **first occurrence only**: fewer calls,
but later sessions show no plan.

## Build-from-scratch ("Start blank") — recommendation
- A **"Start blank"** entry beside "Draft with AI" in the Library header (under `canWrite`). It opens the **existing
  `DrillPlanEditForm`** with an empty plan:
  - `{ title: "", category: "", duration_min: null, audience: "", content: { summary: "", objectives: [], run_of_show: [], materials: [], safety: [] } }`;
  - the form already reads every field with `|| ""` / `[]` defaults.
- **On save:** `set_drill_plan(p_id: null, …, p_source: 'manual')`, the **existing** create path, with a title required
  as today. The new plan opens selected in the library (a draft, like an AI one), ready for **Edit / Approve /
  "Schedule with this plan" / Attach**.
- **The only code change** is that the form's save handler distinguishes create (no `id` → `p_id: null, p_source:
  'manual'`) from edit (today's `saveEdit`, which keeps the plan's own source). No new write path.
- **Small display touch (optional):** a "Manual" tag beside "AI" on library cards / the plan view, so the two sources
  read apart.

## "Describe your goals" + custom categories
- **"Describe your goals"** is the builder's existing **"Focus & notes (optional)"** textarea. **Recommend
  surfacing only:** relabel it **"Describe your goals (focus & notes)"** and move it up to sit right under "Topic / drill".
  It's already sent to the AI prompt, so nothing else changes.
- **Custom categories:**
  - the drill plan's `category` column is free text. The builder and editor offer the department's **training
    categories** (`training_plans` names), managed on the Library's own Training categories card since Slice 2;
  - so "custom categories" = add one on that card, and it appears in the selects. **No change.**
  - Live: 0 plans have a category yet, so nothing to reconcile.

## The confirm step ("reconfirm date/time/length/audience/attendance/location back in the training tab")
**That's the existing schedule form**, reached pre-filled via "Schedule with this plan". It **is** the confirm step:
every one of those fields is shown and editable before anything is written, with the "With plan" chip naming what will be
attached. **Nothing new.**

## Gates
| Entry point | Gate | Matches |
|---|---|---|
| "Schedule with this plan" (Library) | `canWrite` | the Library's existing write gate |
| "Start blank" (Library) | `canWrite` | the same |
| The Schedule form | `canManage` | its existing gate; Slice 2 / Slice 4 untouched |

All three are `= canManageTraining`, the client twin of `is_training_manager()`, which gates all three writes live. A
Board Member, an Officer who isn't a training officer, a Project Admin and a Member see none of the new entries, exactly
as with the Library's other write controls.

## What the build would touch (`src/App.jsx` only)
- **`Training` wrapper:** a `goSchedule(prefill)` (the reverse of `goPlans`) that flips the toggle and hands a prefill
  object to `TrainingSchedule`.
- **`TrainingSchedule`:**
  - accepts the prefill (opens the form; sets `stitle` / `sDur` / `spid` / `sd`), plus a `withPlan` chip;
  - `addSession` / `scheduleRecurring` add `.select("id")` to the same insert, then attach when `withPlan` is set;
  - the form's labels and behaviour are otherwise unchanged.
- **`TrainingPlans`:** the "Schedule with this plan" button on a selected plan, and the "Start blank" entry.
  `DrillPlanEditForm` is reused for create, with the save handler branching create vs edit. Focus & notes is relabelled
  and moved up.
- **Tests:**
  - a happy-dom test covering: the prefill, the chip, a single attach + a series attach, a failed attach surfaced with
    the session kept; Start blank → `set_drill_plan(p_id null, source 'manual')`; the role matrix on the new entries;
    the source fences pinned to the release in the promote push;
  - `ai_drafting_sliceB_test`'s source fences already pin to their release, so they won't go red.

## Rulings needed
1. **Flow:** **A**, hand-off to the pre-filled Schedule form (recommended), or **B**, an inline mini-form in the Library?
2. **Series + plan:** attach to **every** occurrence (recommended) or the **first** only?
3. **Prefill defaults:** title / length / category-by-name from the plan; day = today. Audience stays "everyone" (the
   plan's "who it's for" is free text, not the session's audience enum). OK?
4. **Start blank:** opens the existing editor empty; saves as `source 'manual'`, a draft. Add a **"Manual" tag**: yes / no?
5. **Describe your goals:** relabel and move "Focus & notes" up (recommended), or leave it as is?
