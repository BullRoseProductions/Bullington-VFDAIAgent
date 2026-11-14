# Weekly Training Content, slice 5: Weekly UI + shared prompt: build order and hand-back

**Status:** for gate. **Not reviewed, not promoted.** Branch `feat/weekly-drill-ui`, off `013eeb8`.
- **What `013eeb8` holds:** the Weekly DB apply record. It sits on `25979b3` ("Weekly DB: gate PASS @25979b3", applied 2026-11-14, live RETEST 15/0/0), which sits on main `6742304` plus the S3 test pin `0df9c1e`. All of it rides this merge.
- Client only: `src/App.jsx` plus the new `shared/drill-prompt.js`. No `api/`, `sql/`, native, package or `vercel.json` change, and no SQL to apply.
- It ships to the web on merge, and to phones in the next native build.

**Design:** `docs/design/training_content_step0.md` §5.1 (the toggle), §5.3 (the prompt in `shared/`) and §5.4 (labelling) (gate PASS @2a0768c; rulings @4cfe29f, R3 DA-owned).

## What it does

### 1. The prompt moves to `shared/drill-prompt.js`
These are **moved verbatim** from `src/App.jsx`, and the test pins each one byte-identical to the base:
- `DRILL_PLAN_SYSTEM`;
- `strList`, `oneLine`;
- `stepToRun`, `drillPlanToContent`.

`App.jsx` now imports them; existing tests that re-export these names from App keep working, since re-exporting an import is valid ESM.
- **New: `parseDrillPlanReply(text)`.** This is `draft()`'s parse, made reusable and **fail-closed**. It strips code fences and parses the whole reply, else the first `{…}` span. Anything that isn't a plain object returns `null`, so the caller writes nothing. `draft()` now calls it.
- The weekly cron (slice 7) will import the same functions: one definition.
- **Left as it is:** `AIDrillPlanner`'s inline copy of the prompt. `ai_drafting_sliceB_test` reads it from the source and pins it equal; this test re-checks that equality.

### 2. The `ai_weekly` labels: one helper, `planSrc(p)`
All five places Training Plans reads a plan's source now go through it: the list pill, the card line, the detail's head, pill and meta line. So do the Plans-by-category labels.
- **ai / library / manual:** BASE's exact strings, which the test checks.
- **ai_weekly:**
  - pill "Draft · B4C weekly AI";
  - card "Drafted by B4C's weekly AI";
  - head "Drafted by B4C's weekly AI · needs an officer's approval";
  - meta "drafted by B4C's weekly AI";
  - Plans by category "Weekly AI draft".

  **It never shows a member's name** (`byPerson: false`), even if `created_by` were set, and never plain "Draft".

### 3. The Department Admin's switch
- **Where:** a "Weekly AI drill draft" card in Settings, with an "Off" badge while off and Step 0's sub-line verbatim.
- **Who sees it:** real Department Admins only. That's `hasAny(role, ["Department Admin"])`, the same gate as `set_weekly_drill_draft_enabled`, so a Project Admin never sees it. The card and the route are gated alike.
- **The screen:** a `WeeklyDrillSettings` screen with ON/OFF.
  - **Turning on asks first.** It says what the weekly run sends (Step 0 §5.5: category names and how current each is, recent titles, city, the date, an approximate member count; never names, emails, notes, certs, hours, attendance or addresses), and that nothing is used until an officer approves it.
  - **Turning off** asks nothing and deletes nothing.
  - **The only write** is the RPC. A refused write keeps the state and shows the server's message.
- `departments` is now read with `weekly_drill_draft_enabled` included.

## Judgment calls for the gate
- **WU-1, the switch lives in Settings, not "beside probation".** Step 0 §5.1 says "the department's settings, beside the probation switch", but the probation switch actually lives inside the Onboarding screen, not in Settings. The weekly draft is a training setting with nothing to do with onboarding. So it gets its own Settings card, following the opt-in After-Call Checklist card pattern.
- **WU-2, the switch ships before the cron, and says so.** `WEEKLY_DRAFT_RUN_LIVE = false` until slice 7. Until then, the screen says *"B4C's weekly run hasn't started yet. If this is on, your department is included from its first week."* It never promises a Monday draft. Slice 7 flips the constant.
- **WU-3, `parseDrillPlanReply` also refuses an array reply.** The old inline parse let a JSON array through (`typeof [] === "object"`), and an array saved an empty draft. Strings, numbers, null and garbage were already refused, so the only behaviour change is that an array now fails.
- **WU-4:** the Plans-by-category label for a weekly draft reads "Weekly AI draft", not "Draft", so it never falls back to plain "Draft" (Step 0 §5.4).

## Tests
- **`docs/review/weekly_ui_test.mjs`: 38/38, exit 0.** It bundles the real `App.jsx` and checks:
  1. the 5 moves are byte-identical and no longer defined in App, the AIDrillPlanner pin, and the parser plus its fail-closed cases;
  2. every label for all four sources, including no name on a weekly draft that carries a `created_by`;
  3. the switch: who sees it, confirm or cancel, on and off, a refused write, the "not started" note;
  4. the department read;
  5. the fences (verified 132/32/14, Notify held, `_cron.js` untouched).
- **Suite:** 70 files, all exit 0.
- **Build and lint:** both exit 0. The build used placeholder env vars only, as a compile check.

## Invariants
- verified counts: App.jsx 132 · digest 32 · assistant 14, unchanged;
- Notify held;
- `api/_cron.js` and `vercel.json` untouched;
- no SQL, RLS or grant change.

## After gate PASS (on Ashlea's go, with the PASS sha quoted verbatim from the relayed message)
1. Pin this test's `REV` to the passed sha, then merge to main and push.
2. Served-verify `version.json`.
3. **Ashlea's live check, signed in as a Department Admin:**
   - Settings → Weekly AI drill draft;
   - turn it on: check the confirm text, then that it reads ON;
   - turn it off.

   No weekly drafts exist yet, so the labels can only show up after slice 7.
