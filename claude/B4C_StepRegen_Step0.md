# B4C — Per-step AI regenerate (training plan editor) — STEP 0: design only. NOTHING BUILT.

**Investigated on main `2c772d3`** (read-only). The goal: in the plan editor, rewrite one step ("steps 1, 2 and 4 are
perfect, rewrite step 3") while the others stay byte-identical.

## 1. Grounding — confirmed, with one correction
- **A step is one `content.run_of_show` entry.** Its stored shape is **`{ t, d }`**, not the AI's shape:
  - `drillPlanToContent` (`src/App.jsx` ~24043) maps each AI step `{ title, minutes, actions[] }` to
    **`{ t: "Title — N min", d: "action; action; …" }`**.
  - The editor (`DrillPlanEditForm`, ~24070) edits the whole run of show as **one textarea**, one step per line, as
    `"t | d"`. On save, it splits each line back into `{ t, d }`.
  - So a regenerated step must come back as `{ title, minutes, actions[] }` and go through the **same** mapping.
- **Objectives** are `content.objectives`, a `string[]` edited one per line.
- **Full-plan drafting** uses `callClaude(DRILL_PLAN_SYSTEM, user)` → `POST /api/claude` (`api/claude.js`). The system
  prompt is client-side (`DRILL_PLAN_SYSTEM`, ~24041). It's one model call, and the JSON reply is mapped with
  `drillPlanToContent`.
- **Not `concepts.js`.** That's the Image Generator's art director: a fixed server prompt, poster concepts, and the
  `concepts` cap (30/member/day). It's the wrong home.

## 2. Granularity
- **v1: a step = one `run_of_show` entry**, i.e. one line of the textarea.
- **Objectives: not in v1 (recommended).** An objective is a single short line, and hand-editing it is as fast as a
  prompt. The same path *could* do it later (output `{ "objective": string }`), but it costs a full AI call per line for
  little gain.

## 3. Backend — no endpoint change (recommended): a new client prompt through the existing `/api/claude`
- `/api/claude` is already the gated, capped proxy that full drafting uses. A step rewrite is the same kind of call
  with a narrower prompt, so it **extends nothing server-side**:
  - no new endpoint;
  - no `api/` diff;
  - the same WS-2 gate, input caps and charge.
- Its main cost is a larger request: the whole plan goes in as context. A server-side fixed-prompt route would only
  matter if we later wanted to stop the client choosing the prompt. That applies equally to full drafting today, and
  is out of scope.
- **Prompt** — new `DRILL_STEP_SYSTEM`, next to `DRILL_PLAN_SYSTEM`:
  - The same safety framing: not a substitute for certified instruction; defer to the AHJ and local protocols; a
    high-risk evolution needs a qualified instructor and a safety officer.
  - *"Rewrite ONLY the one step marked TARGET in the plan below. Keep it consistent with the steps before and after
    it; do not repeat their content; do not change the plan. Keep minutes close to the original unless the note asks
    otherwise. Respond with ONLY one JSON object: `{"title":string,"minutes":number,"actions":string[]}` — 3–6 short,
    concrete, imperative actions."*
- **Input** (the `user` string):
  - title, category, duration, audience, summary and objectives;
  - the **full numbered run of show, as the editor currently holds it** (unsaved edits included), with the target line
    marked `>>> TARGET`;
  - the optional one-line hint: *"Note from the officer: …"*.
  - This is well under `USER_MAX` (120,000).
- **Output:** `{ title, minutes, actions[] }`.
  - It's validated: `title` must be a non-empty string, `actions` a non-empty string array, and `minutes` a positive
    number or absent.
  - It's mapped by **one shared helper**, `stepToRun(s)`, factored out of `drillPlanToContent` so the two can't drift:
    `{ t: title + " — N min", d: actions.join("; ") }`.
  - It replaces **only that line**. Every other line is untouched: the splice happens on the editor's own text, and
    the other steps are never re-requested.
  - Invalid JSON or a failed call → "Couldn't rewrite that step", and the line is left exactly as it was.

## 4. Gate and caps
- **The gate is unchanged:** `api/claude.js` runs `requireMember` (401/403/503), then `inputProblem` (413, before any
  charge), then **`chargeAiCall(ctx, "claude")`**. If that refuses (429/503), the model isn't called.
- **The cap it counts against:** the `claude` route, **150 per member per day**, with a **1,500 per department per
  day** backstop (America/Chicago day; WS-2 ruling D-2, `record_ai_call`). Each regenerate is **one** charged call,
  the same unit as a full-plan draft.
- **Is one step a sensible unit? Yes.**
  - Each tap is a deliberate officer action on a draft. It sits inside the same 150/day budget as every other Claude
    feature, and the budget bounds misuse.
  - Tokens: input ≈ the plan (~1–2k), output ≈ a few hundred. That's cheaper than a full draft, but it still counts as
    1 call, which errs on the safe side.
  - Client-side, the button disables while a rewrite is in flight. **No new cap or DB counter is needed.**
- *To re-confirm at build:* the live `record_ai_call` ceilings (150 / 1,500 for `claude`), read-only.

## 5. UX (decided: a per-step Regenerate control plus an optional one-line hint)
- In `DrillPlanEditForm`, **under the run-of-show textarea**, add a compact **"Rewrite a step"** list. It's derived
  live from the textarea's lines, one row per step:
  - `Step 3 · Size-up — 10 min` · `[ optional: what to change… ]` (one-line input) · `↻ Regenerate`
  - A successful rewrite replaces that line in the textarea (form state only) and shows **"Step 3 rewritten — review,
    then Save changes"**, with a one-level **Undo** for that step.
  - The textarea stays the source of truth. Typing in it is still the way to fine-tune, and the list re-derives from
    it.
  - While a rewrite runs, its row shows a spinner, and the other Regenerate buttons and **Save** are disabled, so a
    save can't race a rewrite.
- **Only while editing a draft:**
  - The rows render only when `p.status === "draft"` (prop `canRegenerate`, passed at the one call site, ~24461:
    `editing ? <DrillPlanEditForm … p={sel}`).
  - They **never render on an approved plan.**
  - Start blank (an unsaved new plan) gets no rows in v1; that's an option if wanted.
- **Nothing is written silently:**
  - A rewrite only changes form state.
  - Persisting goes through the existing **Save changes → `saveEdit` → `set_drill_plan(p_id, …)`** path, by the
    officer's explicit click.
  - Cancel discards it.
- **B1 interaction (`PLAN_CLOSED` and the edit guard):**
  - Rewriting happens *inside* `editing`. While editing, the Collapse button is hidden and `collapse()` is a no-op,
    so the panel can't close mid-rewrite or drop a rewritten step.
  - `DrillPlanEditForm` already holds `useEditorOpen(true)`, so a background refresh won't drop it either.
  - Approve is hidden while editing (`canWrite && !editing`), so a plan can't be approved with a rewrite pending in
    this view.

## 6. ⚑ An existing behaviour worth knowing (not changed by this design)
- **`set_drill_plan` on edit "keeps status + source".** An approved plan can be edited (Edit shows for approved
  plans), and it **stays approved** with the new content.
- Per-step rewrite is gated to drafts in the UI, so it adds nothing to this. But the UI gate is the only guard: a
  plan approved on another device while this one has the editor open would still accept Save.
- A hard "drafts only" rule would be a **DB change**: `set_drill_plan` would refuse content edits on an approved plan
  unless it's unapproved first. That's its own reviewed slice. Flagged, not proposed for this one.

## 7. Touch points for the build (all `src/App.jsx`; no `api/`, no SQL, no vercel.json)
| where | what |
|---|---|
| ~24041 | `const DRILL_STEP_SYSTEM = "…"` (above) |
| ~24043 | extract `stepToRun(s)` from `drillPlanToContent`, and use it in both places |
| new, beside `draft()` | `rewriteStep(context, runLines, index, hint)` → `callClaude(DRILL_STEP_SYSTEM, user)` → parse, validate, `stepToRun` |
| `DrillPlanEditForm` ~24070 | prop `canRegenerate` + `planContext`; the "Rewrite a step" rows under the run-of-show textarea; per-row hint, spinner, undo; Save disabled while one is in flight |
| ~24461 | pass `canRegenerate={sel.status === "draft"}` and the plan context |

**Invariants:** verified untouched (none of this touches `verified`). Notify held. **No DB touch.**
**Test plan:** a fake `authedFetch` returns a step JSON. The test asserts:
- only line N changes (the others are byte-identical);
- the hint reaches the prompt, and `>>> TARGET` marks the right line;
- invalid JSON leaves the line untouched;
- no rows show on an approved plan or on Start blank;
- nothing is written until Save, and Save sends `set_drill_plan` with only that step changed;
- Save is disabled while a rewrite is in flight;
- the editing guard holds (no Collapse).
