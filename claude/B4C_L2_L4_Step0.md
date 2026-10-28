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
