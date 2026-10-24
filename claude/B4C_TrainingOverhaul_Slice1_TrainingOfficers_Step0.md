# B4C — Training Overhaul · Slice 1 — Training Officers registry — STEP 0 CONCEPT (for gate review, no SQL yet)

Order: [[B4C_TrainingOverhaul_Slice1_TrainingOfficers_BuildOrder]]. Everything below is read from **live** (read-only Step 0
query, 2026-10-24 — `docs/review/training_officers_STEP0_OUTPUT.json`, the full function bodies + policies) and from
`aed762f` (main). Baselines: **172 policies**, **17 locked-token functions**; gate md5s `is_dept_admin()` c692e44f…,
`is_canmanage_ops()` 92fa1803…, `my_department_id()` 87f54665…, `my_member_id()` 3f66369c…, `is_equipment_manager()` c4d54ae1….

---

## (c) `is_canmanage_ops()` is NOT mutated — confirmed

`is_canmanage_ops()` has **54 live users** — 18 functions + 36 policies (full list in the Step 0 output,
`canmanage_ops_users`). Only **12** of them are training; the other 42 are apparatus / maintenance / photos / check
items, gear, member credentials, qualifications + supervised sessions, documents, ai_outputs (agendas / minutes /
recruitment / funding), content calendar, post categories, funding + recruitment events, duties, station log,
fundraiser log. Changing it would silently re-gate all of those.

So the migration will:
- add a **new** gate function (below) and repoint **only** the training surfaces enumerated in (a);
- pin `is_canmanage_ops()`'s md5 as a precondition **and** a post-condition (byte-identical after);
- snapshot every function + policy and require that **only** the enumerated ones changed (each repointed one compared
  against its pre-image with the gate expression swapped — nothing else in the body may move).

### The new gate — one helper, not an inline `OR`
`is_training_manager()` — `STABLE SECURITY DEFINER`, `search_path=public`, EXECUTE authenticated only:
> true when the caller (active / probationary, **in `my_department_id()`**) is a **Department Admin**, OR
> `is_training_officer()`.

(Per decision #1 — DA, **not** `is_dept_admin()`, which also admits Project Admin.) One named helper keeps the 13
repointed sites to a one-token swap (`is_canmanage_ops()` → `is_training_manager()`) and gives the client a single twin.

`is_training_officer()` — `STABLE SECURITY DEFINER`, `search_path=public`, authenticated only: an active
(`removed_at is null`) `training_officer` row for **`my_member_id()` in `my_department_id()`**.

> ⚠ **Template finding — do NOT mirror `is_equipment_manager()` byte-for-byte.** The live body is **not
> department-scoped**: it is true if the caller's *email* has an active `equipment_manager` row in **any**
> department (no `em.department_id = my_department_id()`, and the members join isn't dept-scoped). A member of two
> departments who is an equipment manager in one is an equipment manager in both — the same role-anywhere class as
> the 10-13 cert leak. The order asks for both "byte-for-byte the equipment shape" and "an active row in
> `my_department_id()`"; those conflict. **Recommend the dept-scoped body** for training, and a separate tiny fix for
> `is_equipment_manager()` (out of this slice — flagged, not touched).

---

## (a) The exact repoint surface

### Server — 13 objects change their gate (all others byte-identical)

| # | Object | Today | After |
|---|---|---|---|
| 1 | policy `training_sessions` · **leaders write training_sessions** (INSERT) | `dept AND is_canmanage_ops()` | `dept AND is_training_manager()` |
| 2 | policy `training_sessions` · **leaders update training_sessions** (UPDATE, using + check) — covers edit, complete / finalize, **Reopen**, the schedule-form flags | `is_canmanage_ops()` | `is_training_manager()` |
| 3 | policy `training_plans` · **leaders write training_plans** (INSERT) — categories | `is_canmanage_ops()` | `is_training_manager()` |
| 4 | policy `training_plans` · **leaders update training_plans** (UPDATE) | `is_canmanage_ops()` | `is_training_manager()` |
| 5 | policy `session_attendance` · **leaders insert session_attendance** — roster marking (`toggleAttend`) | `is_canmanage_ops()` (+ open-session clause, unchanged) | `is_training_manager()` |
| 6 | policy `session_attendance` · **leaders delete session_attendance** | `is_canmanage_ops()` (+ clause unchanged) | `is_training_manager()` |
| 7 | policy `session_plans` · **canmanage update session_plans** | `is_canmanage_ops()` | `is_training_manager()` |
| 8 | policy `session_plans` · **canmanage delete session_plans** (detach / remove a plan) | `is_canmanage_ops()` | `is_training_manager()` |
| 9 | fn `set_drill_plan(…)` | `coalesce(public.is_canmanage_ops(), false)` | `coalesce(public.is_training_manager(), false)` |
| 10 | fn `approve_drill_plan(uuid)` | same | same swap |
| 11 | fn `unapprove_drill_plan(uuid)` | same | same swap |
| 12 | fn `delete_drill_plan(uuid)` | same | same swap |
| 13 | fn `attach_drill_plan_to_session(uuid,uuid)` | same | same swap |

Functions are re-created with `CREATE OR REPLACE` from their **live** body with the single gate token swapped (and the
refusal message "Department Admin or Officer" → "Department Admin or training officer"); policies with `ALTER POLICY`
(same name, same command, same roles, only the expression). `total_policies` delta for the whole slice = **+1** (the
`training_officer` SELECT policy) — the repoints are in place, not drop/create.

### Server — deliberately NOT repointed (each a conscious call — review these)

| Object | Gate today | Why it stays |
|---|---|---|
| policy `training_sessions` · admins delete | `is_dept_admin()` (DA + PA) + not-done + no-attendance | Deleting a session is admin-only today; repointing would **widen** delete to training officers. Out of scope. |
| policy `training_plans` · admins delete (categories) | `is_dept_admin()` | Same — admin-only delete stays admin-only. |
| policy `session_plans` · canmanage **insert** | `is_canmanage()` (DA + Officer + **Board**) | Who may **attach** is Training Overhaul **Slice 3**'s open question (the "members attach their own plans" finding). Repointing now would remove Board's DB ability and pre-empt that ruling. Leave for Slice 3. |
| `open_signin` / `close_signin` / `current_signin_token` / `set_session_location` | inline `access && ['Department Admin','Officer','Project Admin']` (= `SIGNIN_ROLES`) | Decision #3 — **running** a sign-in stays at the current gate this slice. |
| `member_check_in` | member self-service (QR) | Not a management action. |
| `session_reg_is_leader()`, `my_department_rollup()`, `set_my_session_registration` | visibility / self-service arrays | Read + self-service, not training management. |
| `move_week` / `swap_week_dates` | `is_admin()` | Write `training_sessions` dates but have **no caller** in the web client; admin-gated already. Untouched. |
| qualifications / supervised sessions (`sign_qualification`, `revoke_qualification`, `log_supervised_session`, `void_supervised_session`, `log_qualification_drive`) | `is_canmanage_ops()` | Probation / member qualifications, not the training schedule. A later slice may want training officers to sign these — **not** this one. |
| drill-plan reads (`dept_drill_plans`, the SELECT policies) | dept members | Reads stay open to the department. |

### Client — the twin
- `isTrainingOfficer` — App-level active-row lookup, mirroring `isEqMgr` (`App.jsx:2515–2519`):
  `training_officer … .eq("member_id", myMemberId).is("removed_at", null)` (RLS scopes the read to the dept).
- **Training-manager twin:** `canManageTraining = hasAny(role, ["Department Admin"]) || isTrainingOfficer`, passed down.
- Repoint (**training only**):
  - `TrainingSchedule` `canManage` (`App.jsx:23827`) — create / edit / complete / Reopen / attendance / categories / attach-plan button.
  - `AIDrillPlanner` `canManage` (`App.jsx:5859`) — schedule-on-a-date + save-to-session.
  - `TrainingPlans` `canWrite` (`App.jsx:23581`) — builder + approve / edit / attach / delete.
  - `canPlanAI` (`App.jsx:23829`, today `SIGNIN_ROLES`) → the twin (the planner's only outputs are writes the twin gates).
  - **Not** `canRunSignin` (`App.jsx:23828`, `SIGNIN_ROLES`) — decision #3.
- **Member-view exception:** `memberView = !isLeader(role)` (`App.jsx:23830`) would put a training officer who is a plain
  **Member** in the read-only member view. Becomes `!isLeader(role) && !isTrainingOfficer` — the training-page
  analogue of the `isEqMgr` nav exception. (The Training **nav** entry is already `ROLES` — everyone — so no sidebar
  change is needed, unlike Equipment.)
- No other component writes the training tables (verified: every client write to `training_sessions` /
  `training_plans` / `session_attendance` / `session_plans` and every drill-plan / sign-in RPC call sits in those three
  components).

### Intended behavior change (the conscious flip)
An **Officer who is not a designated training officer loses** schedule / edit / complete / Reopen / roster attendance /
categories / plan-library writes. A **plain Member who is designated gains** them. Department Admins are unaffected.
Project Admins are unaffected (they can't do these today — `is_canmanage_ops()` excludes PA — and #1 keeps it so).
Officers keep **opening / closing QR sign-in** (#3).

> ⚠ **Also governs meetings / board events.** Leadership and board events, and meetings, are `training_sessions`
> rows (`audience`, `is_meeting`). Repointing rows 1–2 means **only DA + training officers** can schedule or edit them
> too — today any Officer can. Board Members can't schedule them today either way. **Confirm** that's intended; the
> alternative (keep `is_canmanage_ops()` for `audience in ('leadership','board') or is_meeting`) is a more complex
> policy and is not recommended for this slice.

---

## (b) The five Step 0 decisions — recommendations

1. **Always-able admin: DA only (PA stays out).** `is_training_manager()` = DA in my department OR training officer.
   Mirrors today exactly for PA (no PA training writes now), keeps PA non-operational. Deletes stay on
   `is_dept_admin()` (unchanged — PA can still delete as today). *Ashlea to confirm.*
2. **Cap: none.** No cap trigger (equipment has `equipment_manager_cap()` at 2 — not mirrored). A department can have
   several training officers; the card shows the count ("Training officers · 3"), no "of N".
3. **QR open-gate: unchanged this slice.** `open_signin` / `close_signin` / `current_signin_token` /
   `set_session_location` keep the `SIGNIN_ROLES` arrays; client `canRunSignin` unchanged. Coupling sign-in to the
   registry is a later call.
4. **Card location: the Training page**, near scheduling (leader view, beside the categories card), gated DA
   (client `isDeptAdmin`-style twin of the RPCs' gate — see #6 below). Eligible = any Active / Probationary member of
   the department not already active.
5. **Seed: auto-seed current Officers** (Active / Probationary, `Officer`, **not** already `Department Admin`) as
   training officers in the same migration, `assigned_by` NULL / `assigned_by_name` `'Migration seed (was Officer)'`,
   so the day it ships nothing changes for anyone. Live today that seeds **8**: North Hood 5 · Lipan 2 ·
   Indian Harbor 1 · Granbury 0 · Demo 0. The DA then prunes. The RETEST will cover a **non-seeded** Officer.

### Two more decisions the order didn't list
6. **Who assigns:** the order says `is_dept_admin()` (DA **+ PA**) for assign / remove — mirroring equipment. With #1
   keeping PA out of *managing* training, should PA still *designate* training officers? **Recommend: mirror
   equipment — `is_dept_admin()`** (PA is the support role that sets people up; it doesn't grant PA training writes).
   Flag if Ashlea wants DA-only.
7. **Re-assign / re-remove semantics:** the order says "re-assign clears `removed_at`; re-remove no-op-safe"; equipment
   instead **inserts a new row** each assignment (history kept, `one_active_per_member` partial unique index) and
   **raises** on a duplicate assign / a remove of a non-active member. **Recommend equipment's history model** (new row
   per assignment, removals stamped `removed_by`/`removed_by_name`) **with friendly no-ops**: assigning an already-active
   officer returns the active row; removing a non-officer returns null — so double-clicks don't error. History is the
   point of a registry that gates authority.

---

## Proposed shape (for the migration, after this is passed)
- **`training_officer`**: `id`, `department_id` (FK departments **ON DELETE CASCADE** — equipment has no dept FK; added
  here), `member_id` (FK members ON DELETE CASCADE), `assigned_by` (FK members SET NULL), `assigned_by_name`,
  `assigned_at`, `removed_at`, `removed_by` (FK SET NULL), `removed_by_name` — equipment's columns 1:1.
  RLS on; **one** SELECT policy `members read training officers` (`department_id = my_department_id()`); no write policy.
  Indexes: `(department_id) WHERE removed_at IS NULL`, and `UNIQUE (department_id, member_id) WHERE removed_at IS NULL`.
- **Functions:** `is_training_officer()`, `is_training_manager()`, `assign_training_officer(uuid)`,
  `remove_training_officer(uuid)` — definer, `search_path=public`, revoked from PUBLIC + anon, granted authenticated;
  md5-pinned post-conditions; the assign target must be Active / Probationary in the caller's department.
- **Repoints:** the 13 in (a), each compared to its pre-image.
- **Seed:** the Officer seed in #5, counted in the state check.
- **Proof:** PGlite dry run with mutations (a non-TO Officer refused schedule / roster / plan writes; a TO schedules;
  cross-department refused; assign / remove gated; `is_canmanage_ops()` drift / collateral change → refused; a
  non-dept-scoped `is_training_officer()` → caught; seed miscount → caught; a 14th object changed → refused), then the
  SENTINEL RETEST on live (DA assigns → member can schedule / mark roster / write plans; non-seeded Officer refused;
  remove revokes; cross-department; PA per #1; QR still opens for a non-TO Officer per #3).

**Not in this slice:** the UI card and client repoint (after DB PASS + apply), the `is_equipment_manager()` scoping fix,
the delete gates, session_plans insert (Slice 3), QR coupling, qualifications.
