# B4C — FE-B-DB DRAFT: event needs + sign-ups, jobs on community events, community subtypes

**CC, 2026-10-27. DRAFT — NOT APPLIED, NOT REVIEWED.** For Claude's gate review; nothing is applied until the review PASSes and Ashlea gives the go.

- **Rulings:** [[B4C_FundingEvents_Redesign_Step0_ReviewRecord]] (FE2 subtypes REAL, FE4, FE5 + FE5.1–5.4, FE6).
- **UI:** FE-A is a separate DRAFT (`feat/fe-a-hub-calendar`). FE-B-UI and FE-C-UI come after this is live.

## Files (branch `feat/fe-b-db`)

| File | What |
|---|---|
| `sql/fe_b_event_needs_DRAFT.sql` (sha256 `ddb514a2…`) | The migration: one all-or-nothing DO block → `NOTIFY pgrst` → a read-only state row |
| `sql/fe_b_event_needs_RETEST.sql` (sha256 `b2bbef8d…`) | SENTINEL-rolled-back, role-switched retest: 5 once-checks + 13 per department |
| `docs/review/fe_b_db_LIVEDEFS.sql` → `_LIVEDEFS.json` | The live read (2026-10-27, **Postgres 17.6**) that every pin and every mock body comes from |
| `docs/review/fe_b_db_dryrun_harness.mjs` → `_DRYRUN.txt` | The PGlite dry run |

## What it adds (additive only)

- **`recruitment_events.event_type`**
  - Nullable, with a CHECK: `open_house · booth · school_visit · parade · community_safety · other`.
  - No default; the 6 live rows stay NULL, which means a plain "Community event".
  - "Required" (Ashlea's ruling) is read as: this slice must include the column. A NOT NULL is not wanted, because the record keeps the existing rows NULL.
- **`UNIQUE (id, department_id)` on both `recruitment_events` and `funding_events`.** These are the targets for the composite FKs below.
- **`action_items.recruitment_event_id`**
  - FK `(recruitment_event_id, department_id) → recruitment_events(id, department_id) ON DELETE SET NULL (recruitment_event_id)`.
  - The INSERT policy (`is_canmanage()`) and the lifecycle RPCs are untouched (FE6).
- **`event_needs`**
  - Columns: role_label (1–80 characters), slots_needed (1–50), optional shift start/end with end ≥ start, notes (≤ 1000), sort, created_by, created_at.
  - Parent: **exactly one of** `recruitment_event_id` / `funding_event_id`, each a composite FK with `ON DELETE CASCADE`.
  - RLS: SELECT `dept`; INSERT / UPDATE / DELETE `dept AND is_canmanage_ops()`. INSERT also requires `created_by = my_member_id()`.
  - Guard trigger (D3).
- **`event_need_claims`**
  - One row per (need, member), composite FK to the need (CASCADE), member FK (CASCADE).
  - RLS: SELECT `dept`, so **every member sees who signed up** (FE5.2).
  - **SELECT is the only grant**; rows change only through the four RPCs.
- **RPCs** — SECURITY DEFINER, `search_path=public`, REVOKE PUBLIC/anon, GRANT authenticated:
  - `claim_event_need(need)`: self only; takes the need row `FOR UPDATE` before counting, so the last slot can't be taken twice.
  - `unclaim_event_need(need)`: self only.
  - `assign_event_need(need, member)`: `is_canmanage_ops()`; the assignee must be an active member of the department.
  - `remove_event_need_claim(claim)`: `is_canmanage_ops()`.
- **The new tables do not copy the pre-existing anon table grants.** Supabase's default privileges are revoked first. The dry run shows they'd otherwise be there (M2 is refused).

## What it pins / proves (pre-flight → post-conditions)

- **Pre-flight refuses on any drift:**
  - **15 function md5s:** `is_canmanage`, `is_canmanage_ops`, `is_leader`, `is_dept_admin`, `my_department_id`, `my_member_id`, `is_muted`, **`my_department_rollup` (`7f9723c9…`)**, `complete_/reopen_/cancel_action_item`, `notify_action_item_assigned`, `set_fundraiser_shared`, `set_fundraiser_step_visible`, `get_station_fundraisers`.
  - **The 11 policies** on the two event tables + `action_items`, verbatim, including roles.
  - The date and `department_id` shapes.
  - No name clashes, and nothing already applied.
- **Post-conditions are snapshot-based, so "nothing else moved" is proven, not sampled:**
  - Every pre-existing function's body + ACL is byte-identical, and exactly 5 functions are new.
  - Every pre-existing policy is byte-identical, and exactly 5 are new (4 + 1), all `TO authenticated`.
  - Every pre-existing table's ACL and RLS flag are unchanged.
  - Every pre-existing constraint and trigger is unchanged, apart from the 4 named additions.
  - The FK text is exact.
  - No existing row is touched.
  - The new tables' grants are exactly as intended, with nothing for anon.
  - RPC definer + search_path + EXECUTE privileges are correct, and the guard can be executed by no one.
  - **The `verified` count before = after.** Nothing here references `station_presence` beyond counting it.
- **State row:** total_policies is expected to be **180** (175 + 5) and fn_count **225** (220 + 5). verified_presence stays at the live value; it was 957 on 2026-10-27, and grows organically.

## Dry run (PGlite — `docs/review/fe_b_db_DRYRUN.txt`)

- **The mock:**
  - The live tables involved, with the **live policy text** (generated from `_LIVEDEFS.json`).
  - **14 live function bodies verbatim**: 14 of 15 md5s equal the pins.
  - `my_department_rollup` is a **stub** because it reads about 20 tables. Its pin is re-pointed to the stub's md5 for the run only, and the output says so.
  - Supabase-style default grants.
- **Results:**
  - The migration applies, and the state row is correct.
  - **A re-run is refused** ("looks applied").
  - **RETEST: 31 passed, 0 failed, 0 skipped.** That's 5 once-checks + 13 × 2 departments: one with a REAL DA, one with a fixture DA.
- **3 drift refusals, each caught by pre-flight:** a gate widened, an event policy rewritten, a table already present.
- **14 mutations, all caught:**
  - **The migration itself refuses 4:**
    - M1: claims get an INSERT grant.
    - M2: anon keeps its grants.
    - M9: a plain (non-dept) FK on `action_items`.
    - M13: a pre-existing function is touched.
  - **RETEST turns red for the other 10:**
    - M3: needs gate widened to Board → T1.
    - M4: no `FOR UPDATE` → T4.
    - M5: overfill → T3/T5.
    - M6: no date window → T6.
    - M7: assign to any member → T7.
    - M8: assign open to everyone → T7.
    - M10: one-parent CHECK dropped → T2.
    - M11: claims readable by leaders only → T8.
    - M12: guard off → T10.
    - M14: remove open to everyone → T7.
  - Honest note: M7 and M8 turn T7 red through a `FULL` on that fixture, not through their own code. They're caught, but less precisely than the others.
- **One real bug was found by the dry run and fixed before this draft:** `text || tgenabled` is ambiguous (`"char"`), so the trigger snapshot needed `tgenabled::text`. It would have aborted on live as well, safely, since it runs before any DDL.

## Decisions the record didn't spell out (for the gate review)

- **D1 — the sign-up window.**
  - "Closes on the event date" is implemented as: **open through the event's day** in America/Chicago (the `get_station_fundraisers` clock), and `CLOSED` from the next day.
  - It applies to all four RPCs, leaders included, since this isn't attendance.
  - If Ashlea meant "closes at the start of the event day", change one `<` to `<=` in four places.
- **D2 — same-department links at the DB.** `action_items.recruitment_event_id` is a **composite** FK, which is stricter than `fundraiser_id`'s plain FK: a job can't point at another department's event. `SET NULL (recruitment_event_id)` nulls only the link (a Postgres 15+ column list; live is 17.6, and pre-flight checks the version).
- **D3 — the guard (`tg_event_needs_guard`, BEFORE UPDATE).**
  - A need's department, parent event and created_by never change: `PARENT_LOCKED` (to move one, delete it and add it again).
  - `slots_needed` can't drop below the people already signed up: `SLOTS_BELOW_CLAIMS` (remove someone first).
  - The capacity race with a concurrent claim is closed, because both lock the same row.
- **D4 — who can be signed up.** Signing up needs an Active/Probationary member of the department (`my_member_id()` already requires that). An assignee must be one too; otherwise `NOT_IN_DEPT`.
- **D5 — `event_needs.created_by`.** It defaults to `my_member_id()`, and the INSERT policy requires it to be the caller. That's stricter than the parent gate, not wider. There's no FK.
- **D6 — who made the claim.** `event_need_claims.claimed_by` records the member, or the leader who assigned them. There's no FK on it. `member_id` does cascade on member delete.
- **D7 — error codes.**
  - Errors are `CODE: sentence`: NO_MEMBER · NOT_FOUND · NOT_ALLOWED · CLOSED · ALREADY · FULL · NOT_SIGNED_UP · NOT_IN_DEPT · PARENT_LOCKED · SLOTS_BELOW_CLAIMS.
  - The RPCs return jsonb `{claim_id?, need_id, taken, slots_needed}`, which is what the UI slices need for the "3 of 5" chip without a reload.
- **D8 — deletes cascade.**
  - Deleting an event cascades its needs and sign-ups. Only a DA can delete an event, and FE-B-UI's confirm will name the sign-ups.
  - Pre-existing and **not** changed here: the two event tables have no FK to `departments`. That's noted for the RLS-normalization pass alongside the anon table grants.

## Apply (only after PASS + Ashlea's go)

- Run `sql/fe_b_event_needs_DRAFT.sql` as one execution: the DO block, `NOTIFY`, then the state row.
- Confirm the state row:
  - event_needs / event_need_claims `true`;
  - new_policies **5**; total_policies **180**;
  - 4 RPCs `anon=false auth=true`, guard `auth=false`;
  - event_type_null_rows = recruitment_events (6);
  - action_items_linked **0**; id_dept_keys **2**;
  - anon_on_new_tables **false**; claims_write_grant **false**;
  - fn_count **225**; verified_presence unchanged.
- Then run `sql/fe_b_event_needs_RETEST.sql` separately. It's SENTINEL-rolled-back and runs 5 + 13 × 5 departments.
- **Rollback** (nothing reads these yet):
  1. `DROP TABLE event_need_claims, event_needs`
  2. `DROP FUNCTION` the 5 functions
  3. `ALTER TABLE action_items DROP COLUMN recruitment_event_id`
  4. `ALTER TABLE recruitment_events DROP COLUMN event_type`
  5. Drop the two `*_id_dept_key` constraints

  Always end with `NOTIFY pgrst`.
- This is additive and invisible to the app until FE-B-UI ships, so it's safe on web and native the moment it's applied.
