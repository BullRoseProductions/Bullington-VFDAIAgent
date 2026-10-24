# B4C — Training Overhaul · Slice 1 (UI) — Training Officers card + client gate flip — BUILD ORDER for CC

**Scope:** the UI half of Slice 1 — the assign/remove **Training Officers card** and the **client gate repoint** so the app and the live database agree. The DB is **applied & proven live** ([[B4C_TrainingOverhaul_Slice1_TrainingOfficers_DB_ReviewRecord]]): `training_officer`, `is_training_officer()`, `is_training_manager()`, `assign_/remove_training_officer()`, the 13 repoints, and the 8-Officer seed are all live. **Web-layer only, no DB.** Deliver a diff for gate review, then promote (Notify crew held back, served-verify). Mirror the **equipment-managers card** pattern.

## Why this is the "turn-it-on" step
The DB gate is already live but is a **no-op today** because the seed made every current Officer a training officer. This slice makes the client agree with the DB: the app stops using `CANMANAGE_OPS_ROLES` for training and starts using the training-officer twin. Because of the seed, **no current user loses anything on deploy** — officers are all training officers. It also gives DAs the only way to actually change the list (today it's frozen at the seed with no UI).

## 1. The client twin + flag
- **`isTrainingOfficer`** — App-level active-row lookup, mirroring `isEqMgr` (`App.jsx:~2515–2519`): `supabase.from("training_officer").select("id").eq("member_id", myMemberId).is("removed_at", null).limit(1)` (RLS scopes the read to the dept). Load it alongside the dept context like `isEqMgr`.
- **`canManageTraining = hasAny(role, ["Department Admin"]) || isTrainingOfficer`** — the exact client twin of `is_training_manager()` (DA, **not** PA, OR training officer). Pass it down to the three components.

## 2. The gate repoint (training only — nothing else)
Swap the training write-gate from `CANMANAGE_OPS_ROLES` to `canManageTraining` in exactly these spots (from the Step 0 enumeration):
- `TrainingSchedule` `canManage` (`App.jsx:~23827`) — create / edit / complete / Reopen / roster attendance / categories / the attach-plan button.
- `AIDrillPlanner` `canManage` (`App.jsx:~5859`) — schedule-on-a-date + save-to-session.
- `TrainingPlans` `canWrite` (`App.jsx:~23581`) — builder + approve / edit / attach / delete.
- `canPlanAI` (`App.jsx:~23829`, today `SIGNIN_ROLES`) → `canManageTraining` (the planner's only outputs are writes the twin now gates).
- **Do NOT touch `canRunSignin`** (`App.jsx:~23828`, `SIGNIN_ROLES`) — running a QR sign-in stays at the current gate (decision 3).
- **Member-view exception:** `memberView = !isLeader(role)` (`App.jsx:~23830`) → `!isLeader(role) && !isTrainingOfficer`, so a training officer who is a plain Member reaches the training-management surfaces (the training-page analogue of the `isEqMgr` nav exception). The Training **nav** entry is already `ROLES` (everyone), so no sidebar change.
- Confirm no other component writes the training tables (Step 0 verified the three above are the only writers).

## 3. The Training Officers card (mirror the Equipment managers card)
On the **Training page**, near scheduling (leader view, beside the categories card). Visible to **DA + PA** (`isDeptAdmin` twin — the `assign_/remove_training_officer` RPCs are `is_dept_admin()`-gated, DA+PA appoint, decision 6).
- Lists the dept's active training officers (name + who/when assigned), read via the `training_officer` members-read SELECT (load like equipment's `managers`).
- **Assign** → `assign_training_officer(p_member_id)`; eligible = any **Active** member of the dept not already an active officer (mirror equipment's `eligibleForMgr`). **No cap** (decision 2) — show the count ("Training officers · N"), no "of N".
- **Remove** → `remove_training_officer(p_member_id)` behind the same confirm equipment uses (`noirConfirm` "Remove X as a training officer?" — this revokes a role, it is not a typed-phrase data delete).
- Surface every RPC error (friendly). After assign/remove, reload the list.
- Industrial Noir, FIRE/FS tokens only, mock-faithful to the equipment card.

## Review hooks (what I'll check on the diff)
- `isTrainingOfficer` is an active-row dept-scoped lookup like `isEqMgr`; `canManageTraining` = DA-or-training-officer (**not** PA, not `isDeptAdmin`).
- The gate swap hits exactly the 4 client sites + the member-view exception; `canRunSignin` untouched (decision 3); no non-training gate changed.
- The card writes only through `assign_/remove_training_officer`; no direct `training_officer` table writes; card gated `isDeptAdmin` (DA+PA); list read is the members-read SELECT.
- No DB change; `verified` literal unchanged; FIRE/FS tokens; Industrial Noir; equipment-card-faithful.
- The seed means deploy-day is non-disruptive: spot-check that a seeded Officer still has every training control.

## Promote
Web-layer on current `main`. Same drill: Notify Crew held back; I verify the candidate from git (only this diff vs `main`, no Notify, `verified` equal) before it lands; then served-verify the Training Officers card + that training controls still render for a seeded officer.
