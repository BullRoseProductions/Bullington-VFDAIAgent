# B4C — Training Overhaul Slice 2 (landing / layout reorg) — STEP 0 (audit + plan, no code)

Spec [[B4C_TrainingOverhaul_Spec_Step0]] §"Next Training / landing layout". Audited from the live code on **main `739d1cc`**
(`src/App.jsx`). Line numbers are main's.

**Scope confirmed UI-only.**
- **No schema change, no new RPC, no change to `verified`, Notify crew held back.** Every item below rearranges,
  re-gates or resizes existing JSX in `TrainingSchedule` (23963–25197) / `TrainingPlans` (23628–23865) / `Training`
  (23948–23962).
- Item 6 **moves** existing `training_plans` table writes; it adds none. The same three writes (insert / update /
  delete) go through the same RLS.

## The landing page today (what a user sees, top to bottom)
`Training` mounts both views and shows one at a time (`Schedule | Training Plans` toggle). The Library (`TrainingPlans`)
mounts for **every** role. Its writes are gated by `canManageTraining` (a Department Admin or a training officer — the
client twin of `is_training_manager()`).

**Leader view** (`!memberView`: PA / DA / Board / Officer, or a training officer who is a plain Member), in render order:
1. the view toggle (24647);
2. the "no length recorded" notice: amber, tucked (24651–24672);
3. **Next Training hero** (24676–24755): countdown, title, when/where, plan, Training-Ready ring, 3 stats
   ("categories on track", sessions YTD, last attendance). Buttons on it:
   - **QR sign-in** (24718, `canRunSignin`);
   - **Draft with AI** (24720, `canPlanAI`);
   - **Register plans** (24721).
4. the AIDrillPlanner, inline, when Draft-with-AI is open (24757);
5. the overdue banner (24760–24766): "…see the plan below and schedule a session";
6. the Training Officers card (24768, `isDeptAdmin` = DA + PA);
7. **Training categories** card (24770–24853);
8. **Attendance trend** (24855–24873): the last 8 completed sessions;
9. **Training calendar** (24875–24936): MonthCalendar, with the schedule-a-session form opening inside it;
10. **Sessions · <month>** (24938–…): that month's full list, edit / QR / plans per row.

**Member view** (`memberView`):
1. the toggle;
2. **"What's coming up"** (24510–24553): the MonthCalendar on the left, **"Up next for you"** on the right (the next
   **3** upcoming sessions from any month, each with a **Details** toggle that is **closed** by default, `upOpen = null`);
3. **"Where you stand"** (24556–…): the 90-day ring, plus an **8-month monthly trend**;
4. **"Catch up on what you missed."**

---

## 1. Calendar placement vs the Next-Training card
**Today:** in the leader view the calendar is the **9th** block. Between it and the hero sit the planner (when open), the
overdue banner, the Training Officers card, the categories card and the attendance trend. In the member view the
calendar is already the first card (inside "What's coming up").

**Recommend:** in the leader view, move the **calendar card + the Sessions card together** to sit directly under the
Next-Training hero (and under the AIDrillPlanner when it's open). New order:
- hero → calendar → Sessions → attendance trend → overdue banner? (see below) → Training Officers card → (categories,
  per item 6).
- The member view doesn't change for this item.

**Trade-offs:**
- **Calendar and Sessions must stay adjacent.** The Sessions card is the calendar month's list: it shares `cur`, and
  the hero's QR / Plans buttons scroll to a row in it (`goToNext` → `#ts-<id>`). Splitting them would put the month
  picker and its list far apart.
- **The overdue banner:** keep it above the calendar (it's an alert), or move it with the categories it points at.
  **Recommend keeping it directly under the hero**, so the alert stays first after "what's next".

## 2. Removing "Draft with AI" from the Next-Training card
**Correction to the premise:**
- The button (24720) is gated by **`canPlanAI`**, and since **Training Officers (noir-26, `2a94baa`)** that is
  **`!!canManageTraining`** (23968), not `SIGNIN_ROLES`.
- The Slice 1 UI deliberately re-pointed it, because the planner's only outputs (save to a session, schedule on a date)
  are writes that `is_training_manager()` gates.
- So **today it shows to Department Admins and training officers only. Project Admins already lost this entry on
  Oct 24.** The spec's note (written before Slice 1) said `SIGNIN_ROLES`.

**What removing it leaves:**
- The **Training Plans tab** (the Library: builder + library + approve + attach) is the remaining AI-drafting entry. Its
  writes are gated by the same `canManageTraining`, so **DAs and training officers lose nothing**: the same people
  draft there.
- **Project Admins have no AI-draft entry point, either way.** They can open the Library and read it, but have no write
  controls there. This is unchanged by Slice 2; it was decided in Slice 1, and their writes would be refused by
  `is_training_manager()` anyway.
- The inline AIDrillPlanner (24757) and the `draftOpen` state become **unused on this page**:
  - the component itself still exists;
  - `ai_drafting_sliceB_test.mjs` asserts the builder reuses AIDrillPlanner's system prompt;
  - **so delete only the mount and the button, not the component.**

**Recommend:** remove the button and the inline mount. Optionally put a small **"Draft a plan →"** link on the hero that
switches the toggle to Training Plans, shown under the same `canManageTraining`.
- **Trade-off:** a one-tap path to drafting stays on the landing page, for one more control on the hero. Without the
  link, drafting is one toggle away.

## 3. Which attendance-trend view repositions
There are two, in different views:
- **Leader — "Attendance trend"** (24855–24873): the last 8 completed training sessions, attendees ÷ counted roster
  (`doneTraining`). It's also the basis of the hero's Training-Ready ring. **This is the one the spec means:** "below the
  calendar" only makes sense on the leader page, where the trend currently sits *above* the calendar.
- **Member — the 8-month monthly bars inside "Where you stand"** (24486–24578). These are already below "What's coming
  up" (the calendar card), and they belong to the member's ring.

**Recommend:** move the **leader** trend to directly after the Sessions card (hero → calendar → Sessions → trend).
**Leave the member trend where it is.**

**Trade-off:** the trend explains the Training-Ready number on the hero, so moving it further down separates the ring
from its evidence. The hero could get a "see trend ↓" anchor, but that's optional; I'd skip it.

**"Rearrangeable sections"** (from the spec) is **not recommended for Slice 2.** Per-user ordering needs persisted
state, either localStorage or a new column. The column is a schema change; localStorage drifts across devices.

## 4. "Current month expanded by default" — which list
**What exists:**
- **No month-grouped, collapsible list exists on the Training page.**
- The **leader Sessions card** already shows exactly one month (the calendar's `cur`, which opens on today's month), so
  "current month by default" is already true there. Its rows' Plans panels are collapsed, which is an unrelated toggle.
- The **member "Up next for you"** is the only upcoming list. It shows the **next 3** sessions regardless of month, each
  with **Details** collapsed.

**Options for Ashlea:**
- **(a) Recommended — member Up-next becomes "This month" + "Later":**
  - every remaining session of the current month is shown with **Details open**;
  - sessions in later months sit under a collapsed **"Later (N)"** row that opens to the existing cards;
  - the 3-item cap applies only to "Later".
  - **Trade-off:** in a busy month the card gets longer, and the calendar next to it already shows the month. But it
    matches the ask literally, and members see the details they'd otherwise tap for.
- **(b) Minimal:** keep the next-3 list, but open Details by default for any of them in the current month. Smallest
  diff; does less than the ask.
- **(c) Leader Sessions:** no change needed (it's already month-scoped). Collapsing other months doesn't apply because
  it shows only one.

## 5. "Bigger QR" — concretely
**What exists:**
- Pressing **QR sign-in** (on the hero, or a row's QR button) scrolls to the row and opens its **sign-in panel**.
- Once a code is live, the panel shows an **inline QR at `size={172}`** (25132), plus Expand / download / code.
- **Expand** opens a **fullscreen overlay**: QR up to 560px, viewport-aware (25170–25178), on near-black. It's the
  "hold the phone up to the room" view.
- A hidden **720px** copy (25136) feeds the PNG download.

**Options:**
- **(a) Recommended — enlarge the inline QR**: 172 → about **260px**, with the panel's layout letting it wrap below the
  text on a phone (it's already `flexWrap`).
  - The scan target is meaningfully bigger at arm's length.
  - **Trade-off:** the panel gets taller in the row.
- **(b) Open the fullscreen overlay by default** when an officer opens sign-in from the **hero's QR button**. The row's
  own QR button keeps the inline panel.
  - **Trade-off:** it's the biggest possible code, but it covers the page (tap to close), which surprises anyone who
    only wanted to check the code.
- **(a) + keep Expand one tap away covers both.** (b) is the alternative if officers mostly project the code. Ask
  Ashlea which they do.
- Either way the token, the RPCs, the 720px download and the overlay are unchanged.

## 6. Moving the `training_plans` category-management card into the Library
**What exists:**
- The **Training categories** card (24770–24853) is both a **status grid** and **management**:
  - per category: name, cadence, colour, last / next, an "on track / due / overdue" label (from `reconcile` +
    `dueInfo` over `sessions`), and a **Schedule** button (`scheduleFor` → opens the calendar's schedule form,
    pre-filled);
  - management behind **Edit trainings**: `addPlan` / `updatePlan` / `removePlan` — direct `training_plans`
    insert / update / delete (24175–24197) under the existing RLS, with `confirmDestructive` on delete;
  - edits are gated by `canManage` (= `canManageTraining`).
- **Three other landing-page pieces read the same data:** the hero's **"categories on track"** stat (24743), the
  **overdue banner** ("see the plan below", 24764), and the schedule form's **Training** dropdown (24889).
- The Library already **reads** the categories (`categories={props.plan}`, for the category select / filter / colour)
  but has no `setPlan` / `loadPlans`.

**Options:**
- **(a) Recommended — move management only.**
  - The Library gets a **"Training categories"** card with the add / edit / remove controls, under the same
    `canManageTraining` gate and the same three writes, with `confirmDestructive` kept. This needs the Library to
    receive `loadPlans` from App, the way `TrainingSchedule` does.
  - The landing page keeps a **read-only status strip**: categories with their on-track labels and the **Schedule**
    button, because scheduling is the landing page's job. "Edit trainings" becomes **"Manage in Training Plans →"**,
    which switches the toggle.
  - The overdue banner's copy changes to point at the strip.
  - **Trade-off:** the categories show in two places (status here, management there), but no workflow breaks.
- **(b) Move the whole card.** The status grid and Schedule buttons go to the Library.
  - Scheduling from a category would then need a cross-view jump: switch to Schedule, open the form, pre-fill. The hero
    stat and the overdue banner would point at a different tab.
  - **Trade-off:** a cleaner landing page, but scheduling a due category takes more taps. It also starts to blur into
    **Slice 5** ("build a session from the Library"); doing it there would make more sense.

## What I'd hand back as the Slice 2 build order (after Ashlea rules)
UI-only, `src/App.jsx` only:
- leader order: hero → (planner gone) → overdue banner → calendar → Sessions → attendance trend → Training Officers card →
  category status strip;
- Draft-with-AI button + inline mount removed (optional "Draft a plan →" link);
- member Up-next per 4(a);
- inline QR 172 → ~260 (plus 5(b) if ruled);
- category management in the Library per 6(a).

Gates unchanged: `canRunSignin` stays `SIGNIN_ROLES` (QR); every write stays `canManageTraining`. A happy-dom test covers
the new order and the role matrix (DA / training officer / Officer-not-TO / PA / Board / Member). Diff for gate review,
web-layer promote, Notify held back.

## Rulings needed
1. Calendar + Sessions directly under the hero, with the overdue banner kept above them? (recommended)
2. Draft-with-AI: remove, with or without a "Draft a plan →" link? (PAs are unaffected either way — they already have no
   AI-draft entry since Slice 1.)
3. Reposition the **leader** "Attendance trend" below Sessions; leave the member trend? (recommended) Skip "rearrangeable"?
4. "Current month expanded": (a) This month open + Later collapsed (recommended), or (b) minimal?
5. QR: (a) enlarge inline to ~260, and/or (b) open fullscreen from the hero's button?
6. Categories: (a) management to the Library, status + Schedule stay (recommended), or (b) the whole card?
