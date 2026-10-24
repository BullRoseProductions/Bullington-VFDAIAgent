# B4C — AI Drafting (Training Plans) — Slice A (DB) — BUILD ORDER for CC

**Scope (locked Oct 24):** the reusable **drill-plan library** behind the Training "Plans" page ([[B4C_AIDrafting_Concept_Step0]]). DB-only this slice. Decisions (Ashlea): **draft + approve = DA/Officer** (`is_canmanage_ops()`), and **the author may approve their own plan** (no separate-reviewer gate — approval is a status a DA/Officer sets); content stored **structured** (jsonb). The existing per-session plan flow (`session_plans`) and the inline "Draft with AI" planner stay as-is. Additive; `verified` never touched; standard discipline (single DO block, pin + snapshot, PGlite dry run, SENTINEL RETEST). Deliver the migration + dry run + RETEST for gate review before apply.

## 1. New table `drill_plans` (the reusable library)
- `id uuid PK = gen_random_uuid()`
- `department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE`
- `title text NOT NULL` (CHECK non-blank)
- `category text` (nullable — free text; the UI offers the dept's training categories but stores the label)
- `duration_min int` (nullable, CHECK > 0 when set)
- `audience text` (nullable — skill level / who it's for)
- `content jsonb NOT NULL` — the structured plan. Documented shape (the UI slice aligns the generator's output to it): `{ "summary": text, "objectives": [text], "run_of_show": [{"t": text, "d": text}], "materials": [text], "safety": [text] }`. Validate it's a JSON **object** (CHECK `jsonb_typeof(content) = 'object'`); don't over-constrain the inner shape at the DB.
- `status text NOT NULL DEFAULT 'draft'` CHECK in (`draft`, `approved`)
- `source text NOT NULL DEFAULT 'ai'` CHECK in (`ai`, `manual`)
- `created_by uuid`, `created_at timestamptz NOT NULL DEFAULT now()`
- `approved_by uuid`, `approved_at timestamptz` (both nullable; set on approve, cleared if it returns to draft)
- `updated_by uuid`, `updated_at timestamptz NOT NULL DEFAULT now()`
- **RLS ON.** One SELECT policy `{authenticated}` USING `department_id = my_department_id()` (any dept member can read the library). **No write policy** — all writes via the RPCs below.
- Index: `(department_id, status)` for the library list.

## 2. Link `session_plans.drill_plan_id`
`ALTER TABLE public.session_plans ADD COLUMN drill_plan_id uuid REFERENCES public.drill_plans(id) ON DELETE SET NULL` — **nullable**. Existing `session_plans` rows stay null → behave exactly as today. (Confirm `session_plans` has full table grants / RLS is the gate, like the other tables — `has_column_privilege` check in the migration.) This is how an attached library plan links back; the existing "View plan" surface is unchanged.

## 3. RPCs (all `SECURITY DEFINER`, `search_path=public`, EXECUTE `authenticated` only)
- **`set_drill_plan(p_id, p_title, p_category, p_duration_min, p_audience, p_content jsonb, p_source default 'ai')`** — `is_canmanage_ops()` (DA/Officer) + `my_department_id()`-scoped. Create (`p_id` null) or edit. Validates title non-blank and `content` is a JSON object. Returns the row. **Edit keeps the current `status`** (the author re-approves if they want; self-approval makes that trivial) — do NOT auto-revert to draft. `updated_by/at` stamped.
- **`approve_drill_plan(p_id)`** — `is_canmanage_ops()`, own dept. Sets `status='approved'`, `approved_by=my_member_id()`, `approved_at=now()`. **Self-approval allowed** (the author may approve their own plan — Ashlea's call; this is a lesson plan, not a custody attestation, so the second-signature custody rule does not apply here). No-op-safe if already approved (friendly).
- **`unapprove_drill_plan(p_id)`** — `is_canmanage_ops()`, own dept. Sets `status='draft'`, clears `approved_by/at`. (Lets a DA/Officer pull a plan back to draft to revise.)
- **`delete_drill_plan(p_id)`** — `is_canmanage_ops()`, own dept. The `session_plans.drill_plan_id` FK (ON DELETE SET NULL) clears any attachments; the per-session `session_plans` rows themselves are kept (an already-run session keeps its plan text). (Client routes this through the typed-phrase `confirmDestructive`.)
- **`dept_drill_plans()`** — any dept member reads the library: returns each plan + an **attached-session count** (`count of session_plans where drill_plan_id = this`). Ordered by status then updated_at.
- **`attach_drill_plan_to_session(p_plan_id, p_session_id)`** — `is_canmanage_ops()`. Validates **both** the plan and the session are in `my_department_id()`. Inserts a `session_plans` row for the session referencing the plan (`drill_plan_id = p_plan_id`, `source='library'` or `'ai'`, `title` = the plan title, `ai_text` = a serialized form of the plan content so the existing "View plan" renders it with no new view code, `department_id`, `created_by`). Friendly error if the plan or session isn't in the dept, or if already attached (decide: allow re-attach or dedupe — recommend **dedupe** per (session_id, drill_plan_id)).

## 4. Discipline + proof
Single all-or-nothing DO block. Preconditions: neither `drill_plans` nor the RPCs exist yet (re-run-safe); `session_plans` exists and lacks `drill_plan_id`; pin `is_canmanage_ops()` + `my_department_id()` + `my_member_id()` md5s (and confirm `is_canmanage_ops` is the DA/Officer gate). Post-conditions: the table (RLS on, the one SELECT policy, CHECKs, index), `session_plans.drill_plan_id` nullable FK, the RPCs definer/search_path/authenticated-only; **every other function + policy byte-identical**; `total_policies` delta = +1; the `verifie||d` token count unchanged; `verified` untouched. **PGlite dry run with mutations** (a write policy slipped onto `drill_plans` → caught; an RPC not dept-scoped or not `is_canmanage_ops` → caught; anon execute → caught; the content non-object CHECK dropped → caught; attach crossing departments → caught). **Live RETEST (SENTINEL-rolled-back):** a DA/Officer creates a draft, approves it (status/approved_by set), another dept's DA/Officer can't read/edit/attach it, a plain member can read the library but can't write, attach links a plan to a session (count reflects it) and is refused across departments, delete clears the attachment but keeps the `session_plans` row, unapprove returns it to draft.

## Then the UI slice (Slice B)
The Training **"Plans" tab**: the AI builder (reusing the existing `/api/claude` generator → `set_drill_plan` draft), the library grid (`dept_drill_plans`), the awaiting-review/approval (`approve_drill_plan`), edit, attach-to-session (`attach_drill_plan_to_session`). Mock-faithful; gated DA/Officer for writes, dept members read. Scoped after Slice A's DB PASS.

**Draft Slice A first; deliver the migration + dry run + RETEST for gate review before apply.**
