# B4C — Security L-2 (scope `departments` reads) + L-4 (role-anywhere helpers) — STEP 0

**Branch:** `feat/l2-l4-step0` off main `8f9474a`. **For review. There's no migration yet**; it gets written after you
run the check and the gate clears it (standard discipline, same as the equipment-manager scope fix).

**The check:** `sql/l2_l4_STEP0_CHECK.sql`. It is read-only and returns one result set (ord · what · name · verdict ·
detail). It was dry-run on PGlite against a stub schema: every section returned rows and parsed cleanly. **It has not
run on live.** Run it in the SQL editor with **No limit** and send the result back.

---

## L-2 · Any signed-in user can read every `departments` row
**Finding** (audit L-2): the SELECT policy is `TO authenticated USING (true)`. A self-registered stranger (H-1) can
read all 5 rows: `station_lat`/`station_lng`, geofence settings, `disabled_modules` and branding. It's
cross-tenant, though the data is low-sensitivity.

### What the code says (main `8f9474a`)
- **Every client read is the caller's own department:**
  - `App.jsx:2535`: brand/settings load, `.eq("id", my_department_id())`.
  - `App.jsx:26793`: `week_start_day`, `.eq("id", deptId)`.
- The four `.update(...).select()` writes (`App.jsx:531`, `:1931`, `:26281`, `:26805`) also target the caller's own
  row. Their RETURNING needs SELECT visibility of **that** row only.
- There are no embedded `departments(...)` joins anywhere in `src/`, `shared/` or `api/`.
- **Server:**
  - `digest.js` and `pulse.js` use the service role, so RLS doesn't apply to them.
  - `assistant.js:262` reads one row by the caller's own `deptId` through the as-caller client.
- **Departments are single-membership.** The department switcher was removed in B2 (`App.jsx:2208–2214`). Its SQL
  (`my_departments`, `set_active_department`, `member_active_department`) is left in place, unused.
- **So, from the code:** nothing in the app needs another department's row.

### What Step 0 has to confirm from live
- **L2-1** The exact current policies on `departments`, so the draft can pin them as preconditions.
- **L2-3** Every **function** that reads `departments`:
  - **DEFINER** functions are unaffected by RLS, e.g. the PA `pa_*` RPCs and `pa_department_radar`, which are
    expected to be definer.
  - **INVOKER** functions would see only the caller's own row afterwards. If any of them legitimately needs another
    department, that's the blocker.
- **L2-4 / L2-5** Every view or policy that reads `departments` under the caller's rights (same question).
- **L2-6** Whether anyone still has member rows in more than one department, and whether `member_active_department`
  holds any row. Expect "every email: 1 dept" and "0 rows". If not, D-1 changes.
- **L2-2** Grants. anon holds SELECT here too (part of M-6, which this item doesn't touch).

### Proposed fix (subject to Step 0)
Replace the one SELECT policy with `TO authenticated USING (id = public.my_department_id())`. The UPDATE/INSERT
policies are untouched. Pin the live policy text and the `my_department_id()` md5. RETEST: a member sees exactly 1
row (their own), a stranger with no member row sees 0, and every INVOKER reader from L2-3/4/5 still works.

---

## L-4 · `is_department_admin()` and `is_leadership()` match the role in any department
**Finding** (audit L-4, F-2): both helpers check the role without a department filter. The audit found every live
use already ANDed with a department check:
- `is_department_admin()`: only in `announcements`' SELECT.
- `is_leadership()`: 2 policies and 13 functions.

So it's safe today, but a footgun for the next author. It's the same class as the 10-13 cert leak and the 10-24
`is_equipment_manager()` fix.

### What Step 0 has to confirm from live
- **L4-1** Both bodies in full, plus md5, DEFINER/volatility and ACL. Also `is_dept_admin()`, `my_department_id()` and
  `my_member_id()` to pin against.
- **L4-2 / L4-3 / L4-4** Every policy, function and view that calls either helper, and whether each one also
  compares a department.
  - The audit's count (1 + 2 policies, 13 functions) is the expectation.
  - **Any call that does NOT compare a department is a live leak** and changes the urgency.

### Proposed fix (subject to Step 0)
**Re-create both in place, dept-scoped**, with `CREATE OR REPLACE`:
- Same signature, `STABLE SECURITY DEFINER`, `search_path=public`. `CREATE OR REPLACE` keeps the ACL, and a DROP is
  avoided because it would re-open anon EXECUTE.
- The only body change is that the role lookup also requires `department_id = my_department_id()`. This mirrors the
  approved `is_equipment_manager()` fix.
- Because every caller already ANDs a department and departments are single-membership, the expected behaviour
  change on live is **none**. RETEST has to synthesize the multi-department case to prove the scope bites.
- **Not proposed:** dropping them and repointing ~15 callers at `is_dept_admin()`. That one admits Project Admin,
  so the semantics differ, and it means many more objects re-created for no extra safety.

---

## Decisions for you
- **D-1 · L-2 scope.** Recommend **own department only** (`id = my_department_id()`). The alternative is "any
  department the caller has a member row in", which only matters if L2-6 shows multi-department people.
- **D-2 · L-4 approach.** Recommend **dept-scope in place** (above), not drop-and-repoint.
- **D-3 · Packaging.** Recommend **one Step 0, two migrations** (L-2 DRAFT, then L-4 DRAFT), each with its own
  RETEST and gate. They change different things and have different blast radii, and a separate rollback for each is
  simpler.

---

## Live result — ran 2026-10-28 (read-only, SQL editor)
`docs/review/l2_l4_STEP0_OUTPUT.json` (51 rows). There was also a follow-up, `sql/l2_l4_STEP0B_CHECK.sql` →
`_STEP0B_OUTPUT.json` (13 rows), which pulled the department lines out of each helper caller with comments stripped,
and checked the one active-department row.

### L-2
- **Policies:** `signed in can read departments`, SELECT `[authenticated]` `USING true`, plus `DA can update own
  department`, UPDATE `USING/CHECK (id = my_department_id() AND is_dept_admin())`. There's no INSERT or DELETE policy.
- **Grants:** anon has **none** on `departments`; that was revoked since the audit. authenticated has S/I/U/D, with
  I and D denied by RLS. RLS is on, and there are 5 rows.
- **No invoker-rights path needs another department's row:**
  - 26 functions read `departments`. **25 are SECURITY DEFINER**, so RLS doesn't apply to them, including every
    `pa_*` RPC and `pa_department_radar`.
  - The one INVOKER is `tg_departments_probation_enabled_guard()`, a trigger on `departments` that compares
    NEW and OLD. It only names the table in a comment.
  - **No view** reads `departments`, and **no other table's policy** does either.
- **Multi-department:** **108 of 108 emails have member rows in exactly 1 department.**
  - `member_active_department` holds 1 row, and it points at a department that email is an Active/Probationary
    member of, i.e. their only one. That makes it inert: `my_department_id()` resolves the same either way.

### L-4
- **Live bodies:**
  - `is_department_admin()` is md5 `99570e17…`: access in {DA, PA}, Active/Probationary, **no department**.
  - `is_leadership()` is md5 `cc5861c2…`: access in {PA, DA, Board Member, Officer}, **no department**.
  - Both are DEFINER, STABLE, search_path=public, with ACL postgres/authenticated/service_role. **anon cannot
    EXECUTE them.**
- **Callers: 3 policies + 9 functions.** The audit counted 1+2 policies and 13 functions; 3 functions have since
  moved to `is_dept_admin()`.
  - `is_department_admin()`: 1 policy, `announcements` SELECT. It's ANDed with `department_id = my_department_id()`.
    No function calls it.
  - `is_leadership()`, policies: `training_session_audit` SELECT and `training_session_requests` SELECT, both ANDed
    with `department_id = my_department_id()`.
  - `is_leadership()`, functions: `approve_offsite`, `reject_offsite`, `dept_iso_hours`, `dept_iso_hours_by_station`,
    `dept_on_station_now`, `dept_on_station_now_all`, `dept_shifts_needing_review`, `dept_station_shifts`,
    `session_change_signatures`. Every one scopes its rows to `my_department_id()`, either through `v_dept` or by
    passing it to `dept_iso_hours_for` / `attested_training`.
  - `dept_open_long_shifts`, `resolve_auto_closed_shift` and `void_auto_closed_shift` match only in a **comment**
    ("was is_leadership()"). They gate on `is_dept_admin()`.
- **Read carefully: every caller scopes the ROWS, none scopes the ROLE.** This is exactly the
  `is_equipment_manager()` finding of 10-24. Someone who is an Officer in department A and a plain member of B would
  pass `is_leadership()` while acting in B, and see B's leadership rows.
  - **Live exposure today: zero**, because all 108 emails are single-department.
  - So "safe because ANDed" holds only while nobody has two memberships. The in-place dept-scope fix closes it by
    construction.

### What this means for D-1…D-3
- **D-1:** own department only is safe. Nothing needs another department's row, and nobody has two.
- **D-2:** dept-scoping in place changes nothing on live and closes the latent role-anywhere path. Note that
  `is_department_admin()` admits PA, so after scoping it's the same predicate as `is_dept_admin()` (c692e44f).
  Re-creating it with that body is the obvious form.
- **D-3:** two migrations still recommended.
