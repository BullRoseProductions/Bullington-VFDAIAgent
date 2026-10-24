# B4C — Equipment-Manager department-scope fix — STEP 0 AUDIT (for gate review, no SQL yet)

Order: [[B4C_EquipmentManager_DeptScope_Fix_BuildOrder]]. Read from **live** (read-only, 2026-10-24 —
`docs/review/equipment_manager_scope_STEP0_OUTPUT.json`: every policy and function whose text references
`is_equipment_manager` / `equipment_manager`, with full bodies). Baselines: **173 policies**, **17 locked-token functions**;
`is_equipment_manager()` md5 **c4d54ae1…** (STABLE, SECURITY DEFINER, grants postgres / authenticated / service_role).

## Headline
**Fixing `is_equipment_manager()` alone fully closes the leak.** Every consumer takes its *role* from the function, and the
only inline `equipment_manager` checks are already department-safe. No client change, no policy change, no other function
change. **Live exposure today: none** — all 6 active managers (North Hood 2 · Lipan 2 · Indian Harbor 2) have a single member
row (no other department), so nobody can currently trigger it; the fix is latent-risk hardening, and the dry run must
synthesize the multi-department case.

> ⚠ **Correction to the order's framing of (1).** The order expects policies that AND `department_id = my_department_id()`
> to be "belt-and-suspenders". They are **not** — that clause scopes the **row** to the caller's *active* department, while
> the **role** (`is_equipment_manager()`) can still come from a *different* department. A manager in A who switches to B
> passes `is_equipment_manager()` (from A) **and** `department_id = my_department_id()` (B's rows, B active) — so B's rows are
> exposed. Same lesson as the 10-17 members leak, inverted: a row-department check doesn't fix a role-anywhere gate. So
> **all 9 policies and all 5 RPCs below leak** for a multi-department manager; all are closed by the one function fix.

## (1) Consumers of `is_equipment_manager()` — all LEAKING (role-anywhere), all fixed by the function
**Policies (9)** — every one is `(is_equipment_manager() OR is_dept_admin()) AND department_id = my_department_id()` (or the
handoff-party variant):

| Table | Policy | Cmd | Status |
|---|---|---|---|
| equipment | da or manager manage equipment | ALL | leaks (role) → fixed by fn |
| equipment_custody | leadership correct custody | UPDATE | leaks → fixed by fn |
| equipment_custody | managers read all custody | SELECT | leaks → fixed by fn |
| equipment_handoff | parties read handoffs | SELECT | the `from/to = my_member_id()` arms are safe; the manager arm leaks → fixed by fn |
| equipment_handoff_items | parties read handoff items | SELECT | same as handoff → fixed by fn |
| equipment_issue_batch | managers read batches | SELECT | leaks → fixed by fn |
| equipment_issues | managers read issues | SELECT | leaks → fixed by fn |
| equipment_photos | da or manager manage equipment photos | ALL | leaks → fixed by fn |
| equipment_type | da or manager manage equipment types | ALL | leaks → fixed by fn |

**RPCs (5)** — each gates `if not (is_equipment_manager() or is_dept_admin())`, then checks the *row's* department against
the actor's (`v_actor` = `my_member_id()`'s row = the active department). The role leaks the same way; all fixed by the fn:
`issue_equipment_batch`, `confirm_equipment_return`, `recover_equipment`, `mark_equipment_lost`, `resolve_equipment_issue`
(the last scopes the row with `department_id = my_department_id()` directly).

## (2) Inline `equipment_manager` membership checks (not the function) — all DEPARTMENT-SAFE
- **The witness check** in `issue_equipment_batch` (`sql/equipment_custody_slice2.sql:197`):
  `exists (select 1 from equipment_manager em where em.member_id = v_witness.id and em.removed_at is null)`. It has no
  `department_id`, but it keys on a specific **member row id**, and member rows are per-department; the witness row is
  already required to be in the actor's department two lines earlier (`v_witness.department_id <> v_actor.department_id →
  raise`). An `equipment_manager` row's `member_id` always points at a member row in that registry row's own department:
  live **0 mismatched rows**, and the table has no write policy — the only writer is `assign_equipment_manager`, which
  requires the target in the actor's department. So the witness check cannot be satisfied from another department.
  **Safe; no change.** (Optional hardening, not recommended for this fix: add `and em.department_id = v_actor.department_id`
  — it would change `issue_equipment_batch`'s body for no reachable case.)
- **`assign_equipment_manager` / `remove_equipment_manager`** — scoped by `v_actor.department_id`. Safe.
- **`equipment_manager_cap()`** (trigger) — counts by `new.department_id`. Safe.
- (`is_training_officer()` matched the search only because its comment mentions `is_equipment_manager()` — not a consumer.)

## (3) The `equipment_manager` read policy + the client `isEqMgr`
`members read assignments` — SELECT, authenticated, `USING (department_id = my_department_id())` — **department-scoped**.
The client lookup (`App.jsx:~2519`, `.eq("member_id", myMemberId).is("removed_at", null)`) therefore only ever sees the active
department's rows, and `myMemberId` is itself the active department's member row. **The client is safe; no client change.**

## (4) Recommendation — the minimal complete fix
Re-create **only** `is_equipment_manager()`, from its live definition, with the body swapped to the `is_training_officer()`
shape:
```
select exists (
  select 1 from public.equipment_manager em
   where em.member_id = public.my_member_id()
     and em.department_id = public.my_department_id()
     and em.removed_at is null
);
```
Same signature, `STABLE SECURITY DEFINER`, `search_path=public`, grants unchanged (`CREATE OR REPLACE` keeps them).
Behavior is otherwise identical: the old join's `status in ('Active','Probationary')` is already enforced by
`my_member_id()`. Nothing else changes.

**Migration plan (after this audit passes):** single DO block; preconditions pin `is_equipment_manager()` c4d54ae1 (refuse if
drifted / already fixed), `my_member_id()` 3f66369c, `my_department_id()` 87f54665; post-conditions: the new body carries
both scopes and its reviewed md5, grants / volatility / definer / search_path unchanged, **every other function, policy and
trigger byte-identical**, `total_policies` unchanged (173), locked-token count unchanged (17). **Dry run:** a person who is
an equipment manager in A and a plain member in B — before the fix, acting in B: manager true and can write B's equipment /
read B's custody / issue in B; after: false and refused on every one of the 9 policies + 5 RPCs, while still a manager in A;
the witness check unchanged; mutations (body left unscoped, member-only scope, department-only scope, a collateral
function / policy change, grants changed). **Live RETEST (SENTINEL):** single-department managers still manage in their own
department across the policies + RPCs, a DA still manages, a plain member refused, cross-department refused; live has no
multi-department manager, so the RETEST synthesizes one inside the rolled-back block (insert a second member row for a
manager into another department) to prove the scope on live — or, if that trips the members triggers, notes it and relies
on the dry run.
