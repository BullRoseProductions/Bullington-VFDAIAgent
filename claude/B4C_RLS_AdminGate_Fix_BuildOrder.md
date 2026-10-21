# B4C — RLS Admin-Gate Cross-Dept Fix — BUILD ORDER (for CC)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir` · Supabase `ifeptqnlucmvhlvadcpj`.
**This is the fix for punch-list P1 #3a**, off the live Step 0 (`sql/rls_sweep_STEP0C_CHECK.sql`, `ff374b7`). DB policy only — no UI, no deploy; it takes effect on web AND native the moment applied. Brief: [[B4C_RLS_Sweep_Brief]].

## The finding (real — cross-department admin escalation)
Three write policies scope the ROW to the caller's current department (`department_id = my_department_id()`) but take the ADMIN ROLE from **`is_department_admin()`**, which returns true for a DA or PA in **ANY** department (it matches the caller's email to a member row with DA/PA access, with no department filter).
- **Exploit:** a user who is DA/PA of dept A **and a plain member of dept B** can, while B is their active department, satisfy both halves (`my_department_id() = B` because they're an active member of B; `is_department_admin() = true` because they're DA/PA of A) and write B's rows — without being an admin of B.
- **Affected policies:** `announcements` **UPDATE** and **DELETE**; `departments` **UPDATE** ("DA can update own department"); `duty_log` **UPDATE** ("dept admins edit duty_log").
- **Blast radius:** only multi-department admins (DA/PA in one dept, member of another). Count unknown — Step 0 didn't enumerate them; it doesn't change the fix.

## The invariant to enforce
Each of the three policies must be writable **only by a DA/PA of the ROW's department.** The row's department already equals `my_department_id()` (kept as-is). The role half must change from "DA/PA anywhere" to "DA/PA **of my_department_id()**."

## STEP A — settle the role predicate (CC does this first, reports back the body)
**Do NOT assume `is_dept_admin()` is the fix.** The reviewer read the only available body (schema.sql, 5 months stale) and it is **also global**: `exists(select 1 from members where lower(email)=lower(auth.email()) and access && array['Project Admin','Department Admin'])` — no department filter. If the LIVE body is the same, swapping `is_department_admin()` → `is_dept_admin()` only fixes the buggy `in` vs `&&` and does **not** close the gap.
- Paste back the live `pg_get_functiondef('public.is_dept_admin()')` and `pg_get_functiondef('public.is_department_admin()')`.
- **If live `is_dept_admin()` IS department-scoped** (its body filters `members.department_id = my_department_id()` or equivalent) **and covers exactly {Department Admin, Project Admin}** → the fix is to use `is_dept_admin()` for the role half. 
- **If live `is_dept_admin()` is NOT department-scoped** → use this self-contained predicate for the role half (provably scoped, no function dependency):
  ```sql
  EXISTS (SELECT 1 FROM public.members m
          WHERE lower(m.email) = lower(auth.email())
            AND m.department_id = public.my_department_id()
            AND m.access && ARRAY['Department Admin','Project Admin']::text[])
  ```
Either way the role half must be dept-scoped; the `department_id = my_department_id()` (or `id = my_department_id()` on `departments`) predicate and any author/other branches stay **byte-identical**.

## STEP B — one open design question (flag to Ashlea before applying)
`departments` UPDATE: a **Project Admin** is B4C's cross-department super-admin. Does a PA legitimately update a department they are **not** an active member of?
- If PAs manage departments through a `pa_*` SECURITY DEFINER RPC (check for one, e.g. a `pa_update_department`), then scoping this direct policy is **safe** — the PA path is unaffected.
- If PAs rely on this very policy to edit other departments, scoping it to the current dept would **regress** that. In that case keep a deliberate PA-cross-dept branch (`… OR public.is_project_admin()`) on `departments` UPDATE only, and note it.
- For `announcements` and `duty_log` (dept-operational records), no cross-dept PA path is expected — scope them fully.

## 1. The change
For each of the three policies, replace the `is_department_admin()` token with the dept-scoped role predicate from Step A, leaving everything else (the `department_id`/`id` predicate, the `announcements` author branch, roles, cmd) exactly as it is. Prefer `ALTER POLICY` where the structure allows a clean expression replacement; otherwise `DROP`+`CREATE` the one policy with everything else identical.

## 2. Migration discipline (single guarded DO block, re-run-safe)
- **Preconditions:** each of the three live policies' expression currently contains `is_department_admin()` and does NOT already contain the dept-scoped predicate (refuse if already fixed or drifted — same pattern as the members cross-dept fix's exact-expression guard). The helpers used exist.
- **Snapshot before/after:** every OTHER policy in `public` byte-identical (string_agg of tablename|policyname|cmd|roles|qual|with_check); `total_policies` unchanged (**169**); the `verified`-token function count unchanged (**17**, asserted split-token).
- **Post-conditions:** each of the three policies now contains the dept-scoped predicate and no bare `is_department_admin()`; RLS still ON on all three tables; the three tables' client grants unchanged; no other policy added/changed. State check at the end.

## 3. Prove it — PGlite dry run (mutations) + live RETEST (SENTINEL-rolled-back)
Seed/identify a **multi-dept admin**: Ada is DA of dept A and a plain member (not admin) of dept B; a genuine DA of B (Bob); a plain member of B (Cal). With B as Ada's active department:
- **Blocked (the fix):** Ada UPDATE/DELETE an `announcements` row in B → refused; Ada UPDATE the `departments` row for B → refused; Ada UPDATE a `duty_log` row in B → refused. **Prove the OLD policy would have allowed it** (the dry run runs the pre-fix expression and shows Ada succeeds, then the fixed expression and shows Ada refused — that's the regression-catch).
- **Still works (no regression):** Bob (real DA of B) does all three → allowed. The `announcements` author branch still lets an author edit their own. PA behavior per Step B.
- **Unchanged:** Cal (plain member) still can't; cross-dept writes still blocked; `verified` untouched.
- **Mutations each caught:** the fix left as `is_dept_admin()` while that function is global → Ada still succeeds (FAIL surfaced); the department predicate dropped → cross-dept opens (FAIL); any other policy changed → snapshot mismatch.

## 4. Deliverables (BEFORE apply)
`sql/rls_admin_gate_fix_DRAFT.sql` + `sql/rls_admin_gate_fix_RETEST.sql` + the PGlite dry-run output + the two live function bodies from Step A, to `docs/review/` for gate review. **Do not apply.** After PASS: Ashlea applies + runs the RETEST live; DB policy, so live everywhere immediately.

## Not in this fix (characterized, lower priority — Ashlea's call)
- **`member_active_department` / `member_active_station` INSERT+UPDATE** — own-row by email, no check on the value saved, every column client-writable. **Accepted as backstopped:** the readers (`my_department_id()` only honours a dept the user is an active member of; `my_active_station_id()` only a station in the current dept) and the `set_active_*` RPCs re-validate, so a bogus pick is inert. *Confirm `my_department_id()`'s live body does that membership re-check* (it's the load-bearing assumption). If confirmed, no action.
- **`aftercall_run_items` INSERT** — any active member can add items to any after-call run in their department, not just their own run. Low; likely intended (collaborative checklist). Tighten to the run's creator only if Ashlea wants it.
- **Delete surface (3b):** Step 0 set 4 — all 21 DELETE policies are own-row or own-department scoped; `ai_outputs`/`documents` hard-delete are PA-only. The only cross-dept-admin delete (`announcements` DELETE) is folded into this fix. **No separate delete-lock extension needed.**
