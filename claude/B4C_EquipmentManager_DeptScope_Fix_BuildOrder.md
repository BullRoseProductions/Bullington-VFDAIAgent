# B4C — Equipment-Manager department-scope fix — BUILD ORDER for CC

**Scope:** close the confirmed cross-department leak in `is_equipment_manager()` found during the Training Officers Step 0 ([[B4C_TrainingOverhaul_Slice1_TrainingOfficers_Step0_ReviewRecord]]). DB security fix. **Step 0 first (the call-site audit below), then the migration + dry run + SENTINEL RETEST for gate review before apply.** Standard discipline. `verified` never touched. Additive/tightening only.

## The bug (verified from the live body, md5 `c4d54ae10cb936dcc5f185ae38ec5fcd`)
```
select exists (
  select 1 from public.equipment_manager em
  join public.members m on m.id = em.member_id
  where lower(m.email) = lower(auth.email())
    and m.status in ('Active','Probationary')
    and em.removed_at is null
);
```
There is **no `department_id` filter**. A person who is an active equipment manager in **any** department reads as a manager in **every** department they belong to — the same role-anywhere class as the October cert leak. (`equipment_manager` carries `department_id`, so the data to scope on is right there.)

## The fix — dept-scope the gate (mirror `is_training_officer()`)
Re-create `is_equipment_manager()` as, semantically:
```
select exists (
  select 1 from public.equipment_manager em
  where em.member_id = public.my_member_id()
    and em.department_id = public.my_department_id()
    and em.removed_at is null
);
```
Keep its signature, `STABLE SECURITY DEFINER`, `search_path=public`, and grants **byte-identical** except the body. This is the exact shape the (correct) `is_training_officer()` uses. It **tightens** access (a manager in A acting in B is no longer a manager in B); that's the intended correction, not a regression.

## Step 0 — audit every consumer first (deliver for review, no SQL yet)
Enumerate, from live, **every** place equipment-manager membership is tested, and classify each:
1. **Every policy/RPC that calls `is_equipment_manager()`** — list each with its current expression. Mark which already AND `department_id = my_department_id()` themselves (so the fix is belt-and-suspenders there) vs which call it **bare** (where the leak actually bites). The custody/issue/handoff policies in `sql/equipment_custody_slice2.sql` appear to AND the dept already — confirm from live.
2. **Inline `equipment_manager` membership checks that are NOT the function** — e.g. the witness check in `equipment_custody_slice2.sql` (`exists (select 1 from equipment_manager em where em.member_id = v_witness.id and em.removed_at is null)`) has no dept filter and tests a *specific member*; decide the correct dept-scoped form (scope to the batch/department under action, not `my_department_id()` if the actor differs). Flag any others.
3. **The `equipment_manager` SELECT (read) policy** — confirm it dept-scopes the client read, because the client `isEqMgr` lookup (`App.jsx:~2515`) filters only by `member_id`; if the read policy isn't dept-scoped, `isEqMgr` can be true cross-dept on the client too. If the read policy already scopes to dept, the client is fine and no client change is needed; say so.
4. Confirm whether fixing the function alone fully closes the leak, or whether (2)/(3) also need a line. Recommend the minimal complete set.

## Migration discipline (same bar as the training slice)
Single all-or-nothing DO block. Preconditions: pin `is_equipment_manager()` to `c4d54ae1…` (refuse if it already drifted) + pin `my_member_id()` / `my_department_id()` md5s; refuse double-apply (detect the already-fixed body). Re-create the function (and any inline-check objects the audit says are exposed) from their live text with only the dept-scope added. Post-conditions: the new `is_equipment_manager()` body carries the `department_id = my_department_id()` (and `member_id = my_member_id()`) scope and its reviewed md5; **every other function, policy and trigger byte-identical**; `total_policies` unchanged; the `verifie||d` token count unchanged; `verified` untouched. **PGlite dry run with mutations:** prove a manager in A is refused in B **after** the fix (and was wrongly allowed before), a manager in A still manages in A, and any fixed inline check (witness) behaves. **Live RETEST (SENTINEL rolled back):** a real multi-department equipment manager (if one exists) is scoped; otherwise synthesize the cross-dept case in the dry run and note live has none.

## Deliver
Step 0 audit → gate review → migration + dry run + RETEST → gate review → CC applies → I verify the live state row + RETEST → recorded. Not "done" until applied + live RETEST 0-fail.
