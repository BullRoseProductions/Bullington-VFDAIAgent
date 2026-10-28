# B4C — Security L-2 + L-4 — DB DRAFT (two migrations). NOTHING APPLIED.

**Branch:** `feat/l2-l4-db`. It is the Step 0 branch (`19ab452`) plus main `7e1addc`.
**Rulings:** D-1 own department only · D-2 dept-scope in place · D-3 two migrations. Step 0 cleared.
**No client / api / shared / vercel.json change:** verified 132/32/14, Notify held.

## Provenance: generated from a live capture
- `sql/l2_l4_CAPTURE.sql` is a single read-only SELECT. It ran on live 2026-10-28 and produced
  `docs/review/l2_l4_LIVEDEFS.json`:
  - both `departments` policies and the 10 helper bodies, each with md5 and ACL;
  - the role-helper sweep;
  - the table and EXECUTE matrices;
  - the 85 relations authenticated may read;
  - counts: 228 functions, 181 policies, 966 verified, 5 departments, **0 multi-department emails**.
- It was read twice, before and after adding `is_announcer`, and the reads were identical apart from the addition.
- **Every** policy name, predicate, function body and pin in the SQL comes from that file, via
  `docs/review/l2_l4_build.mjs`. `--check` regenerates all 7 outputs **byte-identical**.
- Before writing anything, the generator refuses if the capture no longer says what the Step 0 said: the SELECT policy
  is still `USING (true)`, 0 multi-department emails, anon executes nothing, the helper attributes and ACLs, and so on.
- It also **proves from the live text** that each scoped twin really is its original plus the department line (next
  section).

## L-2 · `sql/l2_departments_scope_DRAFT.sql` (+ `_RETEST`, `_ROLLBACK`)
**The change:** `ALTER POLICY "signed in can read departments" ON public.departments USING (id = public.my_department_id())`.
Only the predicate changes. SELECT, PERMISSIVE and `{authenticated}` are not re-entered.

**⚑ This one is not a zero-diff change, by design.** Today every signed-in person reads all 5 `departments` rows; after,
they read exactly 1. So the proof can't be "every count byte-identical". In-transaction, it is:
- **All 85 relations**, read as a real DA and a real member of **every** department, before and after:
  - every relation byte-identical, errors included, **except `departments`**;
  - `departments` must go from all 5 to **exactly 1**, and that row must be the person's **own** department.
- A signed-in stranger (no member row): 5 → **0**.
- The new policy is exactly `SELECT|PERMISSIVE|{authenticated}|(id = my_department_id())`.
- The UPDATE policy matches its md5. **Every other public policy and every public function** matches (md5 over all of
  them).
- Table and EXECUTE matrices unchanged, policy and function counts unchanged, `verified` unchanged.

**Preflight pins (refuses on drift):**
- both departments policies, by md5 of their full definition; exactly 2 policies;
- RLS on, **FORCE off, owner postgres**. FORCE off is why the 25 SECURITY DEFINER readers, `pa_*` and
  `pa_department_radar` among them, keep reading all rows;
- `my_department_id()` by md5;
- the matrices;
- nobody in two departments;
- refuses if already applied.

**RETEST** (rolled back per department):
- O1: policies as intended.
- O2: a stranger reads 0; anon is refused.
- T1: each real DA and member reads exactly 1 row, their own.
- T2: the app's own-department read still returns that row.
- T3: the no-op UPDATE touches 1 row for a DA and 0 for a member, as before.
- T4: with `USING (true)` put back inside the rollback, the DA reads all rows again. That shows the policy, and only the
  policy, does the scoping.

**ROLLBACK:** puts `USING (true)` back and proves the captured md5.

## L-4 · `sql/l4_role_helpers_scope_DRAFT.sql` (+ `_RETEST`, `_ROLLBACK`)
| helper | live (role-anywhere) | after |
|---|---|---|
| `is_leadership()` | {PA, DA, Board Member, Officer}, any department | `select public.is_leader();` |
| `is_department_admin()` | {DA, PA}, any department | `select public.is_dept_admin();` |
| `is_announcer()` | {DA, PA, Officer}, any department | same body + `and department_id = public.my_department_id()` |

- `CREATE OR REPLACE` keeps the signature, STABLE, SECURITY DEFINER and `search_path=public`. **The ACL is kept by
  construction and checked.**
- Not touched: any caller (3+1 policies, 9 functions), any policy, any grant.

**The consolidation (F-2): folded in at the body level, and here's why.**
- The generator checks from the live text that `is_leadership()` **plus "in my department" is exactly `is_leader()`**:
  same 4 roles, same status filter, only the department line differs.
- Likewise `is_department_admin()` + department **is exactly `is_dept_admin()`**: same {PA, DA}, both admit PA.
- So each old helper becomes a one-line delegation to its scoped twin. There's one definition and nothing to drift
  apart, and no caller is touched.
- **Flagged, not done:** repointing the 12 callers to `is_leader()` / `is_dept_admin()` and dropping the two names. It
  would edit 3 policies and re-create 9 functions for no extra safety. It's a cosmetic follow-up whenever convenient,
  or never.

**Beyond the three you named.** The live sweep covers every `is_*()` that reads `members.access`:
- **`is_announcer()` is a fourth role-anywhere helper.** It's the announcements post-gate, with 1 caller (the
  `announcements` INSERT policy, which already checks the department). By your rule it belongs here, so it's included.
- `is_equipment_manager()` is **already dept-scoped** (2026-10-24, md5 `a979933d`). It's pinned and unchanged.
- `is_project_admin()` is role-anywhere **by design**: PA is the cross-department platform role. Pinned, unchanged.
- `is_leader`, `is_dept_admin`, `is_canmanage`, `is_canmanage_ops` and `is_training_manager` are all dept-scoped already.

**In-transaction proof:**
- **For every member email** (as authenticated), the triple (`is_leadership`, `is_department_admin`, `is_announcer`)
  is compared before and after and must be **byte-identical**. The keys are hashes, so no email ever lands in an error.
  With 0 multi-department people, this is the "no live behaviour change" property itself.
- **All 85 relations** as a real DA and member of every department: byte-identical.
- The three bodies exactly match the generated text; attributes and ACL as captured.
- **Every other function and every policy** byte-identical (md5 of all).
- Matrices, counts and `verified` unchanged.

**Preflight pins:**
- the three bodies plus `is_leader`, `is_dept_admin`, `my_department_id`, `my_member_id`, `is_equipment_manager` and
  `is_project_admin`, all by md5;
- the matrices;
- nobody in two departments;
- refuses if already applied.

**RETEST** (rolled back per department):
- S0: the bodies and attributes are as intended.
- H1: each real DA, Officer or Board Member, and member gets the answers their own access list implies.
- **X1, the fix:** a real DA is given a plain member row in **another** department, synthesized inside the rollback
  (the 10-24 X1 shape), and switched there. All three helpers return false, `dept_on_station_now()` refuses, and
  `training_session_audit` reads 0. Switched back home, all three are true again.
- If the synthetic row can't be inserted, X1 is SKIPPED with the reason.

**ROLLBACK:** re-creates the three from their exact captured definitions and proves the md5s and ACL.

## Dry run · `docs/review/l2_l4_DRYRUN.txt`: **48 passed, 0 failed** (PGlite, mock)
- **Pins reproduce** in the mock: both departments policies and all 9 helper function md5s, created from the live text.
  - The 5 matrix pins can't reproduce in a mock, so the mock's own values are substituted. Labelled, as in WS-5.
- **L-2:**
  - applies; re-run refuses; **RETEST 0 failed**; rollback round trip; re-apply passes;
  - post-apply drift (policy back to `true`) → RETEST FAILs;
  - **7/7 drift refusals:** SELECT or UPDATE policy drifted, a third policy, FORCE on, `my_department_id()` drifted,
    someone in two departments, a grant lost;
  - **7/7 mutations caught and rolled back:** `… OR true`, `false`, a stranger-shaped hole, loosening another table's
    policy, editing the UPDATE policy, revoking a grant, replacing a function.
- **L-4:**
  - **the RETEST fails S0 and X1 on the unmigrated DB**, so it has teeth;
  - applies; re-run refuses; **RETEST 0 failed, X1 PASS**; RETEST leaves no synthetic row behind; rollback round trip;
  - post-apply drift (`is_announcer` back to role-anywhere) → RETEST FAILs;
  - **the fix, directly:** an Officer of Alpha acting in Bravo goes from leadership + announcer `true` to `false`;
  - **5/5 drift refusals;**
  - **7/7 mutations caught:** `select true`, delegating to the wrong twin (Officers lose it), `is_announcer` losing
    Officer, revoking EXECUTE, loosening a policy, replacing another function, VOLATILE.
- **Suite:** `docs/review/l2_l4_db_test.mjs` (regenerate byte-identical + dry run + fences) is 5/0. The full suite is
  35 files, **959 PASS, 0 FAIL**. ESLint clean.

## Apply plan (your go, then Ashlea's)
1. **L-2:** paste the DRAFT, then the state row, then the RETEST.
2. **L-4:** paste the DRAFT, then the state row, then the RETEST.
3. Smoke test after each, since these are RLS changes:
   - **logged-out:** the login page renders, and anon still reads nothing;
   - **member login:** the dashboard, the brand/crest (the departments read) and Training;
   - **DA login:** the same, plus Settings save (the departments UPDATE), announcements post, and leadership screens
     (on-station now, shifts needing review).
4. Rollbacks are ready if anything looks off.
