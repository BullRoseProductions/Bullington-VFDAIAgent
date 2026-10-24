# B4C — Review Record: Training Overhaul Slice 1 (Training Officers) — STEP 0

**Verdict: Step 0 PASS — cleared to write the migration.** Reviewed 2026-10-24 by Claude from the actual Step 0 files at `df8055b` on `feat/training-officers-step0` (`B4C_TrainingOverhaul_Slice1_TrainingOfficers_Step0.md` + `docs/review/training_officers_STEP0_OUTPUT.json`), cross-checked against the live read-only query output and `aed762f` — not CC's summary. Order: [[B4C_TrainingOverhaul_Slice1_TrainingOfficers_BuildOrder]]; spec [[B4C_TrainingOverhaul_Spec_Step0]]. No SQL yet; this gates the migration.

## What I verified independently (from the Step 0 JSON, not the prose)
- **`is_canmanage_ops()` is shared by 54 objects** (18 fns + 36 policies); only 13 touch training. The other 41 are apparatus / gear / member credentials / qualifications / supervised sessions / ai_outputs (agendas, minutes, funding, recruitment) / content calendar / duties / station log / fundraiser. **Leaving it unmutated is correct** — changing it would silently re-gate all of those.
- **The repoint set is exactly 13 and complete:** filtering the 54 users to the four training tables + drill plans yields precisely CC's list — 5 drill-plan RPCs (`set_/approve_/unapprove_/delete_drill_plan`, `attach_drill_plan_to_session`) + 8 policies (`training_sessions` insert/update, `training_plans` insert/update, `session_attendance` insert/delete, `session_plans` update/delete). No training write surface on `is_canmanage_ops()` was missed.
- **The equipment cross-dept leak is real.** I read the live `is_equipment_manager()` body (md5 `c4d54ae1…`): `select exists(select 1 from equipment_manager em join members m on m.id=em.member_id where lower(m.email)=lower(auth.email()) and m.status in ('Active','Probationary') and em.removed_at is null)` — **no `department_id` filter**. An equipment manager in one dept reads as one in every dept they belong to (same class as the Oct cert leak). Also seen un-scoped inline at `equipment_custody_slice2.sql:197`. CC correctly (a) makes `is_training_officer()` dept-scoped from the start and (b) flags the equipment fix as a separate, out-of-scope item. This also corrected a contradiction in my own build order (which asked for both "byte-for-byte equipment shape" and "dept-scoped").
- **Seed = 8** current Officers-not-DA (North Hood 5 · Lipan 2 · Indian Harbor 1 · Granbury 0 · Demo 0), matching `officer_counts`.
- Gate md5 prefixes CC cites match the established pins (`is_dept_admin` c692e44f…, `is_canmanage_ops` 92fa1803…, `my_department_id` 87f54665…, `my_member_id` 3f66369c…).

## Design accepted
- **New gate `is_training_manager()`** = Department Admin **in my_department_id()** OR `is_training_officer()` — deliberately **not** `is_dept_admin()` (that admits PA; today's `is_canmanage_ops()` excludes PA, preserved). `is_training_officer()` = active (`removed_at IS NULL`) `training_officer` row for `my_member_id()` in `my_department_id()`, **dept-scoped**.
- One named helper → each of the 13 sites is a one-token swap; functions re-created from live body with only the gate token (+ refusal message) changed, policies via `ALTER POLICY`. `total_policies` delta = **+1** (the new SELECT policy). `is_canmanage_ops()` md5-pinned before AND after; every non-enumerated function/policy byte-identical; `verified` untouched.
- Not repointed (correct): session/category **deletes** stay `is_dept_admin()`; `session_plans` **insert** stays `is_canmanage()` (who may attach is Slice 3); QR open/close stays `SIGNIN_ROLES` (decision #3); `move_week`/`swap_week_dates` + qualifications untouched.

## Ashlea's decisions (locked, Oct 24)
1. **Always-able admin:** DA only — PA stays out of *managing* training. ✅
2. **Cap:** none. ✅
3. **QR open-gate:** unchanged this slice (any Officer still opens a sign-in). ✅
4. **Card location:** the Training page, near scheduling, gated DA. ✅
5. **Seed:** auto-seed current Officers (8) as training officers in the migration; DA prunes after. ✅
6. **Who assigns:** `is_dept_admin()` (DA **+ PA**) — PA may *appoint* training officers though it can't manage training (mirrors equipment). ✅
7. **Re-assign/remove:** equipment-style history model (new row per assignment, `one_active_per_member` partial unique, stamped removals) with friendly no-ops. ✅
8. **Meetings / board events:** **one gate for everything** — DA + training officers schedule training *and* meetings/leadership/board events. Officers who aren't training officers lose meeting-scheduling too. No split policy. ✅ (Ashlea's call.)

## Conscious behavior change (shipping with it)
An Officer who is **not** a designated training officer loses schedule / edit / complete / Reopen / roster attendance / categories / plan-library writes **and** meeting/board-event scheduling. A plain Member who **is** designated gains the training-management set. The auto-seed (decision 5) makes deploy-day non-disruptive; DAs prune from there.

## Next
CC writes the migration (`training_officer` table + `is_training_officer()` / `is_training_manager()` + `assign_/remove_training_officer` + the 13 repoints + the Officer seed) with the standard discipline — single DO block, pin/snapshot (incl. `is_canmanage_ops()` byte-identical, only the 13 enumerated objects changed), PGlite dry run with mutations, SENTINEL-rolled-back live RETEST — and delivers it for gate review before apply. Then the UI card + client repoint after DB PASS + apply. The `is_equipment_manager()` scoping fix is tracked separately (not this slice).
