# B4C — AI Drafting (Training Plans) — Slice B (UI) — BUILD ORDER for CC

**Scope (locked Oct 24):** the **"Plans" tab on the Training page** — the AI builder + the reusable plan library + approval + attach-to-session, to the mock (`claude/mocks/B4C_TrainingPlans_Facelift.html`, populated output `..._Training_AIDraft_Revamp.html`). The DB (Slice A) is **live & proven** — `drill_plans` + the six RPCs ([[B4C_AIDrafting_SliceA_DB_ReviewRecord]]). Web-layer only; deliver a diff for gate review, then promote. Decisions: **write = DA/Officer** (`CANMANAGE_OPS_ROLES`, the `is_canmanage_ops()` twin), members read; **a draft plan may be attached** (matches the mock — if Ashlea later wants approval-required, that's the Slice A RPC, not this). Leave the existing inline "Draft with AI" planner **as-is** (its removal is Tommy's training overhaul).

## Placement
A **"Plans" sub-view on the Training page** (`Training`, `src/App.jsx:~23469`) — the mock's **Schedule | Training Plans** toggle at the top of Training. Match the page's existing tab/sub-view mechanism; the current Training content becomes the "Schedule" view, the new `TrainingPlans` component the "Plans" view. Writes gated DA/Officer; any member can open the tab and read the library.

## 1. The AI builder (reuse the existing generation — don't write a new model)
Form (mock): **Topic/drill** (required), Type, Duration, **Category**, Members expected, Skill level, Standard/SOG (optional), Focus & notes (optional) + common-drill **seed chips**. "Draft plan" →
- **Reuse the existing training drill-plan generation** (the `/api/claude` path that already backs the inline "Draft with AI" planner and produces the structured `plan` object `serializeDrillPlan` consumes: `{ summary, durationMin, objectives[], safetyNotes[], equipment[], steps[{title, minutes, actions[]}], evaluationChecklist[] }`). Pass the form's topic/duration/category/skill/focus as context. Do **not** author a new system prompt unless the existing one can't take a free topic — if it can, reuse it verbatim.
- **Map the generated plan → the `drill_plans.content` jsonb shape** (this is the one shape Slice A's `attach_drill_plan_to_session` serializer + the plan viewer expect):
  ```
  content = {
    summary:      plan.summary || "",
    objectives:   plan.objectives || [],
    run_of_show:  (plan.steps||[]).map(s => ({ t: s.title + (s.minutes?` — ${s.minutes} min`:""), d: (s.actions||[]).join("; ") || s.detail || "" })),
    materials:    plan.equipment || [],
    safety:       plan.safetyNotes || []
  }
  ```
  (Carry `evaluationChecklist` into `safety` or append to `summary` only if you want it surfaced — optional; keep the five documented keys.)
- Save as a **draft** via `set_drill_plan(null, title, category, duration_min, audience, content, 'ai')` → lands in the library as `draft`. Show the drafted plan immediately (the "Awaiting review" featured view).
- The mock's **approve-note** verbatim-ish: "AI drafts the plan — a qualified officer reviews and approves it before it's used. Always verify against your SOGs."

## 2. The plan library (the grid)
`dept_drill_plans()` → cards (mock `.pcard`): title, category · objectives count · duration, status badge (**Approved** green / **Draft · needs review** amber), author (`created_by`/`approved_by`), **"Attached to N sessions"** (`attached_sessions`). Search + filter by category. Any member reads; the write actions below show only to DA/Officer.

## 3. Awaiting review + approval (DA/Officer)
A **featured / expanded** plan view (mock `.fplan`): Objectives, Run of show (from `content.run_of_show`), Materials, Safety. Actions (DA/Officer only):
- **Approve** → `approve_drill_plan(id)` (self-approval is allowed; the author can approve their own). Approved plans show the green badge + approver.
- **Unapprove** → `unapprove_drill_plan(id)` (pull back to draft to revise).
- **Edit** → `set_drill_plan(id, …)` (edit keeps status + source; re-save the mapped content).
- **Attach to session** → see §4.
- **Delete** → `delete_drill_plan(id)` through the typed-phrase **`confirmDestructive`** (the FK keeps any attached session_plans, just unlinks them — say so in the confirm copy).

## 4. Attach to a session
A session picker (the dept's `training_sessions`) → `attach_drill_plan_to_session(plan_id, session_id)`. On success, the plan is attached as an ordinary `session_plans` row and shows through the **existing "View plan"** surface — **confirm on the preview that an attached plan renders cleanly in the real plan viewer** (Slice A serializes `content` into the `## Quick Run Sheet` / `## <title> — Drill Plan` layout the viewer splits on; eyeball the round-trip). Surface the friendly errors (already attached / not in your department).

## Review hooks (what I'll check on the diff)
- The builder **reuses the existing generation** (no new/parallel AI model), and the **content mapping** matches the five `drill_plans.content` keys Slice A expects (so attach + viewer render correctly).
- Every write goes through the Slice A RPCs (`set_/approve_/unapprove_/delete_drill_plan`, `attach_…`); **no direct table writes**; every RPC error surfaced.
- Write controls gated `CANMANAGE_OPS_ROLES` (DA/Officer) — not `isDeptAdmin`; the library read is open to members.
- Delete via `confirmDestructive`; the inline "Draft with AI" planner is **untouched**; no DB change; `verified` literal unchanged; FIRE/FS tokens only; Industrial Noir; mock-faithful.
- The attached-plan round-trip renders in the existing viewer (eyeball).

## Promote
Web-layer; builds on current `main`. Same drill: Notify Crew held back, I verify the candidate from git (only the Slice B diff vs `main`, no Notify, `verified` equal) before it lands, then served-verify (the "Plans" tab + builder present in the served bundle).

*(Optional: if Ashlea wants to see the live builder/library before the full build, it's already mocked — the diff + preview on theme is the natural review point; no separate mock needed.)*
