# B4C — Training Overhaul · Slice 1 — Training Officers registry — BUILD ORDER for CC

**Scope (locked Oct 24):** a per-dept **Training Officers** registry that gates who can schedule and manage training — modeled exactly on the **equipment-manager registry**. From [[B4C_TrainingOverhaul_Spec_Step0]] (Ashlea's ruling: "make it like equipment and have a set training officers"). This slice is the foundation — scheduling and the rest of the overhaul key off this gate — so it goes first. **DB-then-UI. Deliver a Step 0 concept first (the gate-semantics + repoint-surface decisions below), then the migration + dry run + SENTINEL RETEST for gate review before apply.** Standard discipline: single all-or-nothing DO block, pin + snapshot, PGlite dry run with mutations, SENTINEL-rolled-back live RETEST. `verified` never touched.

## The pattern to mirror (read it first)
The live **equipment-manager registry** is the template — build the training one the same way:
- **Table `equipment_manager`** (`member_id`, `removed_at` nullable, dept-scoped, RLS members-read).
- **Gate helper `is_equipment_manager()`** (SECURITY DEFINER) — true when the caller has an active row in their dept.
- **RPCs `assign_equipment_manager(p_member_id)` / `remove_equipment_manager(p_member_id)`**, gated `is_dept_admin()`.
- **Client:** `isEqMgr` boolean (active-row lookup for the current member); a `managers` list; an **assign/remove card** on the Equipment registry page ("Equipment managers · {n} of 2"); eligibility = any Active member.
- **Write gate across equipment:** `is_dept_admin() OR is_equipment_manager()`.

## 1. New DB objects (mirror equipment)
- **`training_officer`** table: `id`, `department_id` (FK, ON DELETE CASCADE), `member_id` (FK members), `assigned_by`, `assigned_at`, `removed_at` (nullable — soft-remove, like equipment). RLS ON; one SELECT policy members-read (`department_id = my_department_id()`); no write policy (writes via RPC). Index `(department_id)` filtered on `removed_at IS NULL`.
- **`is_training_officer()`** — SECURITY DEFINER, `search_path=public`, authenticated-only. True when the caller's `my_member_id()` has an active (`removed_at IS NULL`) `training_officer` row in `my_department_id()`. Byte-for-byte the shape of `is_equipment_manager()` with the table swapped.
- **`assign_training_officer(p_member_id)` / `remove_training_officer(p_member_id)`** — SECURITY DEFINER, `is_dept_admin()`-gated, dept-scoped, idempotent (re-assign clears `removed_at`; re-remove is a no-op-safe). Mirror the equipment assign/remove RPCs.

## 2. The new training-management gate — the careful part
Introduce a **new** client + server gate for *training management* and repoint the training surfaces to it. **The gate = `is_dept_admin() OR is_training_officer()`** (server) with a client twin.

**CRITICAL — do NOT mutate `is_canmanage_ops()`.** It's shared by non-training features; changing it would ripple everywhere. Introduce the new training gate and repoint **only the training surfaces** to it; leave `is_canmanage_ops()` and every non-training use byte-identical.

**Repoint surface (training only) — Step 0 must enumerate the exact policies/RPCs, for review:**
- `training_sessions` writes: create / edit / remove / complete / **Reopen** / `open_signin`.
- Attendance capture + the QR sign-in open-gate (currently `SIGNIN_ROLES` — reconcile: should a plain Officer still open a QR if not a training officer? **decision below**).
- Training **categories** (`training_plans`) management.
- The **Training Plans** drill-plan library writes + AI planner + attach (currently `is_canmanage_ops()` / `CANMANAGE_OPS_ROLES` on the client).

**Behavior change (intended):** an Officer who is **not** a designated training officer **loses** training-management rights — same as equipment, where being an Officer doesn't grant equipment rights. This is the point of the slice; call it out in Step 0 so it's a conscious flip.

## 3. Client
- `isTrainingOfficer` boolean (active-row lookup for the current member), loaded alongside the dept context like `isEqMgr`.
- A **Training Officers** assign/remove **card** (mirror the Equipment managers card) — on the Training page (or Settings; **decision below**), gated `is_dept_admin()`. Eligible = any Active member. Shows the current set; assign/remove via the new RPCs.
- Repoint the training write gates from `CANMANAGE_OPS_ROLES` to the new twin (`is_dept_admin() OR is_training_officer()`). Nav/visibility exceptions mirror the `isEqMgr` sidebar exception so a training officer who's a plain Member still reaches the training-management surfaces.

## Decisions for Step 0 (fold Ashlea's answers before building)
1. **Always-able admin:** equipment uses `is_dept_admin()` (DA **+ Project Admin**). Training's current `is_canmanage_ops()` deliberately **excludes PA**. So: should the training gate be `is_dept_admin() OR is_training_officer()` (re-adds PA to training), or **DA-only + training officers** (keeps PA out)? **Recommend: keep PA out of training** — PA is non-operational; so the gate is `my_role is DA OR is_training_officer()`, not the equipment mirror exactly. Confirm with Ashlea.
2. **Cap:** equipment caps at 2 managers. Training officers — a cap, or unlimited? **Recommend: no hard cap** (a dept may have several training officers); Step 0 can propose a soft display only.
3. **QR open-gate:** today any `SIGNIN_ROLES` (PA/DA/Officer) can open a drill's QR. Keep that, or require training-officer to open a training QR? **Recommend: keep QR open at the current gate** for this slice (don't couple sign-in to the registry yet) — repoint only *scheduling/management*, not *running* a sign-in. Confirm.
4. **Card location:** Training page vs Settings. **Recommend: the Training page**, near scheduling, like the Equipment managers card sits on the Equipment page.
5. **Migration of current state:** on first deploy, no one is a training officer → only DA (and PA, if #1 keeps them) can schedule until officers are assigned. **Seed step:** Step 0 should propose whether to auto-seed existing Officers as training officers on migration (so nothing breaks the day it ships) or leave empty for the DA to assign. **Recommend: auto-seed current Officers as training officers** so the flip is non-disruptive, then the DA prunes.

## Discipline + proof (same bar as every DB slice)
Single all-or-nothing DO block. Preconditions: `training_officer` + the three RPCs absent (double-apply guard); pin `my_department_id()` / `my_member_id()` / `is_dept_admin()` md5s; pin `is_equipment_manager()` as the shape reference. Snapshot every other function + policy + the `verifie||d` token count. Post-conditions: the table (RLS on, one SELECT policy, index), `is_training_officer()` definer/search_path/authenticated-only + correct body, the assign/remove RPCs gated + dept-scoped; **the repointed training policies/RPCs now carry the new gate and NOTHING else changed**; `is_canmanage_ops()` + every non-training function/policy **byte-identical**; `total_policies` delta accounted for; `verified` untouched. **PGlite dry run with mutations** (an officer-not-training-officer is refused scheduling; a training officer schedules; cross-dept refused; assign/remove gated to DA; `is_canmanage_ops()` drift → caught). **Live RETEST (SENTINEL-rolled-back):** DA assigns a member as training officer → they can schedule/manage training; a plain Officer (not assigned) is refused; remove revokes it; cross-dept isolation; PA per decision #1.

## Deliver for gate review
1. **Step 0 concept** answering the five decisions + the exact repoint enumeration — I review before any SQL.
2. Then the migration + PGlite dry run + RETEST (SENTINEL) — I review from the actual files at the commit, not a summary.
3. Then UI on top once the DB is applied + proven. Web-layer promote, Notify crew held back, served-verify.
