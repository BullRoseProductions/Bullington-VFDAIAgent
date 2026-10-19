# B4C — Security Fix: apparatus UPDATE gate (Officers + DA only)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir` · Supabase `ifeptqnlucmvhlvadcpj`
**Found:** Step 0 of #3 Qualifications (commit `3c38ac1`). Its own small reviewed change, separate from #3.

**One-line:** the live `apparatus` UPDATE policy "members update apparatus" is department-only, so **any member can update any apparatus column** — name, type, costs, `in_service`, `station_id`, and `deleted_at` (a member can soft-delete a rig). **Ashlea's rule:** any active member can *run a check*; only **Officers + DA** may *edit the apparatus / its checklist*. Gate the UPDATE to `is_canmanage_ops()`.

## Why this is safe (the thing to confirm first)
Running a check does NOT need direct `apparatus` UPDATE anymore — it goes through SECURITY DEFINER RPCs that write the apparatus row as the owner (RLS-independent): `start_or_resume_check` (SECURITY DEFINER confirmed; body inserts into apparatus_checks), `mark_check_item`, `finalize_check` (does `update apparatus set status='Pass'`), `take_apparatus_out_of_service`, `return_apparatus_to_service`, `resolve_apparatus_failure`, `retire_apparatus`, `restore_apparatus`, `set_apparatus_check_interval`. The only client-side `from("apparatus").update` is the admin edit screen (`src/App.jsx` ~16189, saveEditRig), reachable only via the Edit button that shows for DA/Officer — this fix enforces that server-side. The existing **INSERT** policy is already `department AND is_canmanage_ops()` (per the 2026-10-13 discovery), so UPDATE just becomes consistent with it. (UI comment at ~16018 already assumes this tighter rule.)

## 0. STEP 0 — CC confirms BEFORE changing anything (read-only, report)
1. List every `apparatus` policy (all cmds) with its `qual` / `with_check` — paste them. Confirm the UPDATE policy is the broad "members update apparatus" (`department_id = my_department_id()` with no role gate).
2. Confirm **every** write to `public.apparatus` that a member can reach is a SECURITY DEFINER RPC (the list above), i.e. there is **no** member-reachable client path doing a direct `from("apparatus").update` except the admin edit UI. (Code side CONFIRMED: only saveEditRig at ~16189, DA/Officer-gated; all check RPCs incl. start_or_resume_check are SECURITY DEFINER in the repo.) The live query is the authoritative confirmation.
3. Confirm `is_canmanage_ops()` is department-scoped and is the same gate the apparatus INSERT policy already uses.
- **If the live query shows any apparatus-writing function as SECURITY INVOKER, or a trigger that writes apparatus sitting on a table members can write to directly (both run as the member), STOP and report** — then we switch to per-column guard triggers (protect name/type/costs/in_service/station_id/deleted_at, leave the check-result columns) instead of tightening the whole policy. Otherwise proceed to §1.

## 1. The fix
- **Replace** the `apparatus` UPDATE policy "members update apparatus" with one gated to Officers + DA:
  `USING (department_id = public.my_department_id() AND public.is_canmanage_ops()) WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops())`.
- One statement, single transaction, all-or-nothing, re-run-safe (drop-if-exists the old policy by its exact name, create the new one). Touch ONLY the apparatus UPDATE policy — every other apparatus policy (SELECT/INSERT/DELETE), the check RPCs, the `apparatus_check_interval_guard` trigger (leave it — now belt-and-suspenders), and all other tables/policies stay exactly as they are.
- **Never** reference or write `verified`. Dept-scoped via `is_canmanage_ops()` (DA/Officer) — never `is_leader()`, never `is_canmanage()` (Board is looser and not what Ashlea asked for).
- Post-conditions: the apparatus UPDATE policy now contains `is_canmanage_ops()`; exactly one UPDATE policy on apparatus; INSERT/SELECT/DELETE policies byte-identical to before; all non-apparatus policies unchanged (snapshot); `verified` untouched.

## 2. RETEST (run after apply, separately) — prove the model, both directions
Per department with a DA, an Officer, and two plain members (real emails), SENTINEL-rolled-back fixtures:
1. **A member can still run a check end to end:** `start_or_resume_check` → `mark_check_item` → `finalize_check` succeeds and the apparatus `status` updates (through the definer RPC). This is the one that must not break.
2. **A member CANNOT directly update apparatus:** a member's `UPDATE public.apparatus SET name/costs/in_service/deleted_at ...` is refused by RLS (no row updated / policy violation).
3. **An Officer and a DA CAN directly update their department's apparatus** (the admin edit path).
4. **Cross-department:** a DA/Officer can't update another department's apparatus.
5. Maintenance / photos / check-item / check-result tables and the check-interval setter are unaffected; `verified` untouched.

## 3. Deliverable
`docs/review/apparatus_update_gate_DIFF.patch` + the RETEST + a PGlite dry run, for gate review **before apply**. Do not apply or deploy. After review PASS: Ashlea applies + runs the RETEST (expect the member-check PASS and the member-direct-update REFUSED), then it rides the next promote (served-bundle verify, Notify Crew held back). It's web/DB — RLS is enforced for every client (web and native) the moment it's applied, since it's a database policy, not shipped UI.

## Family-sweep note
This is the apparatus entry in the broader role-anywhere / over-broad-policy sweep (members cross-dept fix `d72aed2` was the first; the fundraiser log and this apparatus policy are the known next ones). Record each fix; keep hunting write policies that are department-only but missing a role gate, or role-anywhere without a department predicate.

## Known small UI follow-ups (not this fix)
- The #2 probation supervised-time apparatus dropdown lists deleted/retired rigs — filter them out. The same applies to the #3 qualification-type apparatus picker (the RPC already refuses a deleted rig; the picker should hide them too). Do on the next UI pass.
