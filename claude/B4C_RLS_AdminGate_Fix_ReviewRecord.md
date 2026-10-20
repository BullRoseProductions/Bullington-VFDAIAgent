# B4C — Review Record: RLS Admin-Gate Cross-Dept Fix (punch-list P1 #3a)

**Verdict: PASS — safe to apply.** Reviewed by Claude (gate reviewer) 2026-10-20. DRAFT `d486d24`, `sql/rls_admin_gate_fix_DRAFT.sql` + `sql/rls_admin_gate_fix_RETEST.sql` + PGlite dry run + `docs/review/rls_admin_gate_STEP_AB_OUTPUT.md`. Unreviewed/unapplied at review time. Build order: [[B4C_RLS_AdminGate_Fix_BuildOrder]]; sweep brief: [[B4C_RLS_Sweep_Brief]]. DB policy only — no deploy; live on web AND native the moment applied.

**How I reviewed it:** read the actual DRAFT line by line, diffed its pinned "before" expressions against the live A2 output, confirmed the `is_dept_admin()` body from A1, and traced the RETEST + all 8 mutations in the dry run. Not from CC's summary.

## The gap (confirmed real)
Four write policies scope the row to the caller's current department but take the admin role from **`is_department_admin()`**, which is true for a DA/PA of **any** department (A1: no department filter). A DA of dept A who is a plain member of dept B could, with B active, write B's `announcements` (UPDATE/DELETE), B's `departments` row (UPDATE), and B's `duty_log` (UPDATE) without being an admin of B. **Blast radius 0 today** (B3: no one is an admin in one dept and a plain member of another) — latent, closed before it can be used.

## Verified
- **Swap target is dept-scoped.** A1 live `is_dept_admin()` = caller's own row, `members.department_id = my_department_id()`, Active/Probationary, access ∈ {Project Admin, Department Admin}; md5 `c692e44f…`. The draft pins it by **both** normalized body text (`DA_BODY`) and md5 — refuses on any drift. `is_department_admin()` confirmed global.
- **Exactly the swap, nothing else.** The draft's pinned before-expressions (`T[][]`) match A2 character-for-character; each after-expression changes only `is_department_admin()` → `is_dept_admin()`. Announcements keeps its `(author_id = my_member_id() OR …)` branch and the `department_id = my_department_id()` predicate; departments keeps `id = my_department_id()`; duty_log keeps its predicate. ALTER POLICY keeps roles/cmd. Per-policy preconditions refuse on drift or double-apply; post-conditions re-read each expression and assert no `is_department_admin` remains.
- **PA assumption enforced, not assumed.** B2: both PAs hold PA access on their only dept row → plain swap on `departments` is behavior-neutral. A hard precondition refuses if any PA has a department row without PA access (mutation (e) proves it fires), directing to the PA-branch variant. B1 confirms PA cross-dept management runs through `pa_*` RPCs (`pa_create_department`, `pa_set_disabled_modules`, `pa_set_geofence_enabled`), not this policy — so scoping the direct policy removes no PA capability.
- **Everything else untouched.** Snapshot of every other policy byte-identical (before/after); `total_policies` 169; `verified`-token fn count 17 (split-token guard); RLS + the three tables' client grants unchanged. The literal `verified` appears nowhere. Single all-or-nothing DO block, re-run-safe.
- **Behavioral proof (genuine, role-switched, not self-certifying).** RETEST builds a real multi-dept admin (a DA of another dept + a plain-member row here + this dept active) and measures ROW_COUNT:
  - **X1** — the pre-fix predicate would have allowed (v_old true), the fixed one blocks (v_new false), and all four writes = 0 rows. The regression-catch.
  - **X2** — the real DA: all four allowed; another department's row still refused (cross-dept stays shut).
  - **X3** — the author edits their own announcement; a plain member can't touch departments/duty_log (author branch preserved).
  - **P1** — each PA with a row here still updates the department (plain swap kept their reach).
  - PGlite: pre-fix shows the gap (X1 writes 1/1/1/1); after-fix **9 passed, 0 failed, 1 skipped**; **8 mutations each caught** — incl. (a/a2) is_dept_admin made global → caught by the pin AND independently by the RETEST; (b/b2) dept predicate dropped; (c) collateral policy change; (d) a missed swap; (e) PA-with-plain-row; (f) author branch dropped.

## Not in this fix (characterized earlier, confirmed by Step 0)
- `member_active_department` / `member_active_station` writes — backstopped: A1 confirms `my_department_id()` re-checks active membership, so a bogus saved pick is inert. No action.
- `aftercall_run_items` INSERT — any active member can add to any run in their dept; low, likely intended. Ashlea's call.
- Delete surface (3b): all 21 DELETE policies own-row/own-dept scoped; the only cross-dept-admin delete (`announcements` DELETE) is in this fix. No separate delete-lock extension needed. **The P1 #3 sweep is complete with this fix.**

## Apply (after this PASS)
Ashlea applies `sql/rls_admin_gate_fix_DRAFT.sql` (single DO block; refuses a second apply or any drift). Confirm the state row: **fixed 4 · role_anywhere_left 0 · total_policies 169 · locked_token_fns 17**. Then run `sql/rls_admin_gate_fix_RETEST.sql` live, separately (SENTINEL-rolled-back) — expect Indian Harbor / Lipan / North Hood to pass X1/X2/X3 + P1; Demo/Granbury skip; P1 skips in a department with no Project Admin row (Lipan). It's a DB policy, so it's live on web AND native the moment applied — no deploy. Rollback if ever needed: ALTER the four policies back to `is_department_admin()` (the pre-fix expressions are recorded in the draft's `T[][]` and in A2).
