# B4C — Per-step AI regenerate (training-plan editor) — BUILD (client only). Not reviewed, not promoted.

**Branch:** `feat/step-regen` off main `2c772d3`.
**Design:** `claude/B4C_StepRegen_Step0.md` (`design/step-regen-step0` @ `efdea4c`). Ashlea signed off the UX.
**Runtime change:** `src/App.jsx` only. No `api/` change, no SQL. verified 132 / 108 raw unchanged. Notify held.

## What changed (`src/App.jsx`)
- **`DRILL_STEP_SYSTEM`**, beside `DRILL_PLAN_SYSTEM`. It carries the drafting guardrails *verbatim*:
  - "You are NOT a substitute for certified instruction, medical direction, or the AHJ."
  - "Defer to local protocols, state requirements, and medical direction."
  - "qualified instructor + assigned safety officer + authorization" for high-risk evolutions.
  - "realistic for the stated staffing and apparatus."
  - New for this prompt:
    - rewrite ONLY the `>>> TARGET` step;
    - stay consistent with its neighbours, objectives, equipment and safety notes, and don't repeat their content;
    - **"Do not invent specifics the plan does not give (apparatus names or numbers, addresses, people, protocol or SOG
      numbers) — keep it appropriate to this department"**;
    - keep the minutes close unless the note says otherwise;
    - return ONLY one JSON object, `{"title","minutes":integer,"actions":[]}`, with 3–6 imperative actions.
- **`stepToRun(step)`** is pulled out of `drillPlanToContent`, which now calls it, so the two can't drift.
  - It's single-line and pipe-free: whitespace runs collapse to one space, and a `|` in a title becomes `/`. Minutes
    become a positive integer suffix or nothing.
  - **For normal drafted steps it's byte-identical to the old mapper** (tested). It differs only where the old mapper
    produced a line that couldn't round-trip:
    - a `|` or newline in a title;
    - a newline in an action;
    - fractional minutes, which the old `"— 12.6 min"` produced and `libRowToPacket`'s `(\d+)` couldn't read.
- **`runToText` / `runFromText`:** the editor's own "t | d" line format and its save parse (`tpSplit`, split at the
  first `|`). They're moved out of `DrillPlanEditForm` unchanged, so the round-trip test exercises the real code.
- **`parseStepReply(text)`, fail-closed.** It accepts exactly a JSON object where:
  - `title` is a non-empty string;
  - `minutes` is a non-negative integer or `null`;
  - `actions` is a non-empty array of non-blank strings.

  Anything else returns `null`, and the step is left exactly as it was. There's no partial apply. Code fences are
  tolerated, as in `draft()`.
- **`rewriteStep(plan, runLines, index, note)`**, beside `draft()` in `TrainingPlans`.
  - It makes **one** `callClaude(DRILL_STEP_SYSTEM, user)` call through the unchanged gated `/api/claude`:
    `requireMember` → `inputProblem` → `chargeAiCall(ctx, "claude")`. That's 150 per member per day, with a 1,500
    per department per day backstop.
  - `user` holds: the department; the plan's title, category, duration, audience, summary and objectives as the
    editor currently holds them; and the whole run of show, numbered, with `>>> TARGET` on the one step.
  - The other steps go as **read-only context** (Step 0 design), followed by "Rewrite step N only." and the optional
    note.
- **`DrillPlanEditForm`**, prop `onRewriteStep`. Under the run-of-show box there's a "Rewrite a step" list derived
  live from the box's lines, one row per step: `Step N · <step>`, an optional note (one line, 300 chars), Rewrite,
  and Undo after a rewrite.
  - A rewrite replaces only the N-th non-blank **raw** line in form state. Every other raw line is byte-identical,
    blank lines and spacing included.
  - If the target line changed while the call ran, nothing is applied.
  - **While a rewrite runs:** the run-of-show box is read-only, and every Rewrite button and **Save** are disabled.
  - **Nothing is saved until Save changes** (`saveEdit` → `set_drill_plan`). Cancel discards. Undo is per step, one
    level, and only while the rewritten line is still there.
- **Drafts only.** The single call site passes `onRewriteStep={sel.status === "draft" ? rewriteStep : undefined}`.
  - That's **any draft with steps, whatever its source** (AI-drafted, started blank, or from the Library).
  - Never an approved plan. Never Start blank (unsaved).
- **B1:** rewriting happens inside `editing`. Collapse is hidden and `collapse()` is a no-op while editing, so the
  panel can't close mid-rewrite.

## Tests — `docs/review/step_regen_test.mjs` (real `TrainingPlans` / `DrillPlanEditForm`, fake RPCs + fake `/api/claude`): 31/0
- **Round trip:**
  - `stepToRun` → the editor line → `runFromText` is byte-clean, and `libRowToPacket` reads the title and minutes back.
    That holds for 8 steps, including a pipe in a title, newlines, extra spacing, and null, 0 and fractional minutes.
  - Normal drafted steps are byte-identical to the old mapper.
- **Fail-closed parser:** 13 malformed shapes all return null (not JSON; a JSON array; title empty / a number /
  missing; minutes negative / fractional / a string / missing; actions a string / empty / a non-string / blank).
- **Rows:** on an AI draft (4) and a manual draft (2). Not on an approved plan, a stepless draft, or Start blank.
- **In flight:**
  - one `/api/claude` call with system = `DRILL_STEP_SYSTEM`;
  - the target and only the target is marked; the context, plan and note are present;
  - the box is read-only and all Rewrite buttons and Save are disabled;
  - no Collapse; a second tap makes no second call.
- **Result:** only line 3 changes and lines 1, 2 and 4 are byte-identical. Nothing is written before Save. Undo
  restores the text byte-for-byte.
- **Save:** one `set_drill_plan(p1)`. Steps 1, 2 and 4 deep-equal the stored ones, and step 3 = `stepToRun(reply)`,
  which re-parses clean through `libRowToPacket`. Two rewrites make two calls.
- **Fail-closed in the UI:** all 13 malformed replies, plus an HTTP 429 (the daily cap), leave the text
  byte-identical, show "Couldn't rewrite that step — it's unchanged", make one call each, and write nothing. No Undo
  is offered.
- **Guardrails and fences:**
  - the prompt carries the drafting guardrails and "Do not invent specifics";
  - `api/claude.js` is untouched, and its gate order is `requireMember` → `inputProblem` → `chargeAiCall("claude")`;
  - drafts only; verified 132/108; Notify held.
- **Mutation checks (each FAILs the test):**
  - loosening the minutes validation;
  - not disabling Save during a rewrite;
  - rows on any status.

**Full suite:** 39 files, **1063 PASS, 0 FAIL**. `npm run build` (eslint + vite) passes.
