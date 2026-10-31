# B4C — E1/E3 Slice R (training reactions, DB) — DRAFT. NOT APPLIED.

**Branch:** `feat/e1e3-slice-r-db`, on top of `feat/e1e3-slice-t-db` @ `326adcc` (Slice T is applied on live).
**Design:** the Step 0 (`claude/B4C_E1E3_TrainingTime_Reactions_Step0.md`, §1 Slice R and §3) plus the gate's Slice R
directive.
- `B4C_E1E3_Step0_ReviewRecord` is not in the repo, so the directive's rulings are taken as written.
- **Apply:** waits on Ashlea's explicit go after gate review.

## Provenance
Two read-only captures were run on live 2026-10-31 at 00:35 UTC, after Slice T was applied. Nothing was written.
- `sql/e1e3_sliceR_CAPTURE_A_fns.sql` → `docs/review/e1e3_sliceR_LIVE_fns.json`: 15 functions, with definition, md5 and ACL.
  - The guard (`c1af95df`), correct (`8c000665`) and the times finalize (`b702ad77`) are exactly Slice T's state row.
  - The length-only finalize (`3f31142b`), `attested_training` (`aff25333`) and `dept_iso_hours_for` (`705c9a9b`) are
    unchanged.
  - `is_leader` is `3f462af2` and is department-scoped.
  - Neither `set_session_reaction` nor `session_reaction_tally` exists.
- `sql/e1e3_sliceR_CAPTURE_B_meta.sql` → `docs/review/e1e3_sliceR_LIVE_meta.json`:
  - the triggers and constraints of `training_sessions` and `session_attendance`;
  - columns and the `session_attendance` policies;
  - **`pg_default_acl`**: a table created by postgres in public gets `authenticated=arwdDxtm` (anon is already off). So
    the migration revokes it to SELECT explicitly.
  - the policy md5 `a9947383…`;
  - counts: 229 functions, 181 policies, 92 relations, 177 sessions, 444 roll rows, 0 cancelled, verified 1025, 12 DAs who
    qualify for the RETEST;
  - the per-department ledger.

`docs/review/e1e3_sliceR_build.mjs` generates everything from those two files. `--check` regenerates all 4 outputs
byte-identical.

## Files
- `sql/e1e3_sliceR_session_reactions_DRAFT.sql`: one all-or-nothing `DO $migrate$` block, then `NOTIFY pgrst`, then the
  state row.
- `sql/e1e3_sliceR_session_reactions_RETEST.sql`: S0 + R1–R11, rolled back via SENTINEL.
- `sql/e1e3_sliceR_session_reactions_ROLLBACK.sql`.
- `docs/review/e1e3_sliceR_CHANGE_LIST.md`.
- `docs/review/e1e3_sliceR_DRYRUN.txt`.

## What it does
1. **`training_session_reactions`:**
   - columns `id`, `department_id`, `session_id`, `member_id`, `value smallint` (CHECK ±1), `created_at`, `updated_at`;
   - **`UNIQUE (session_id, member_id)`**;
   - all three FKs `ON DELETE CASCADE`, exactly like `session_attendance`'s, so deleting a member or session never gets
     blocked by a vote;
   - an index on `member_id`.
   - **RLS on, one policy:** `members read own reaction`, which is SELECT TO authenticated USING
     `member_id = my_member_id()`.
   - **No** INSERT, UPDATE or DELETE policy, and no leadership read.
   - Grants: authenticated **SELECT only** (the default ALL is revoked), anon and PUBLIC nothing, service_role ALL.
2. **`set_session_reaction(p_session_id uuid, p_value integer) → jsonb`**: SECURITY DEFINER, `search_path=public`, no
   defaults. It's the only write path.
   - `NOT_ALLOWED` if there's no active member row.
   - `BAD_VALUE` unless the value is 1 or -1.
   - `NOT_FOUND` for an unknown session, or one outside the caller's department (one message for both).
   - `NOT_FINALIZED` unless `done`.
   - `CANCELLED`.
   - `NOT_PRESENT` unless the caller has a `session_attendance` row.
   - **`CLOSED` when (today in America/Chicago) − the session's date > 14**, so day 14 is still open.
   - Then an upsert `ON CONFLICT (session_id, member_id) DO UPDATE SET value, updated_at`.
   - EXECUTE: authenticated + service_role.
3. **`session_reaction_tally(p_session_ids uuid[]) → (session_id, up, down)`**: STABLE SECURITY DEFINER.
   - `NOT_ALLOWED` unless `is_leader()` in the caller's active department.
   - Only sessions **and** votes in that department count.
   - **Only votes whose voter still has a roll row count.**
   - `HAVING count(*) >= 3`, applied **after** that roll filter.
   - Counts only; it never returns a member id.
   - EXECUTE: authenticated + service_role.

Nothing else changes: no existing function, policy, trigger, constraint, grant or row.

## Calls for the gate (each is a one-line change if you'd rather go the other way)
- **An id from another department, or an unknown id, in the tally returns no row; it doesn't raise.** That's the same
  answer as "under 3 votes", so it leaks nothing and the past-sessions list can pass whatever it has.
- **A vote can't be cleared.** The directive says the value is ±1. The Step 0 had offered clearing as optional; it isn't
  built.
- **The tally ignores `done` and `status`.**
  - A reopened session keeps showing its tally, since its existing votes stay.
  - A cancelled session can't have collected votes, because the vote requires done and not cancelled. Live has 0
    done-and-cancelled sessions.
- **"Still on the roll" means a `session_attendance` row exists.** A member who later goes Inactive but stays on the
  roll still counts. Removal via Correct is what drops a vote.
- **The value CHECK is pinned structurally:**
  - the contype/column list, plus "the deparse contains -1", because deparse text varies across PG versions;
  - and behaviourally, in RETEST R7 (an owner's raw insert of 0 → `check_violation`).
  - Table privileges are proven with `has_table_privilege` and `aclexplode`, not an exact `relacl` string. Same reason:
    the aclitem order differs after a revoke.

## Preflight (refuses and changes nothing)
- **Already applied:** the table, either function, or the policy name exists → refuse.
- **md5 pins on all 15 captured functions,** including the post-T guard, correct and finalizes, the ledger pair,
  `is_leader`, `my_member_id`, `my_department_id` and the attendance membership-window trigger function.
- **Pinned structure:**
  - both tables' **trigger** and **constraint** definitions (`COLLATE "C"`, NOT NULL rows excluded);
  - **every public policy** (md5);
  - both tables' **column lists**.

## In-transaction proof (any miss → RAISE → everything rolls back)
- **The ledger:**
  - for every department, `attested_training` and `dept_iso_hours_for` (all time) are byte-identical before and after;
  - `training_sessions` and `session_attendance` rows are byte-identical;
  - verified presence is unchanged.
- **The table is exactly as intended:**
  - columns and defaults;
  - constraints: pk, unique (session, member), 3 FKs with `confdeltype = c`, and the value CHECK;
  - RLS on, with exactly the one policy (name, cmd, roles, qual, no with_check, permissive);
  - authenticated SELECT only, with no column-level write grant either;
  - anon and PUBLIC hold nothing;
  - it's empty, has no trigger, and no view reads it.
- **Both functions are exactly as intended:**
  - the generated `prosrc`;
  - SECURITY DEFINER, `proconfig = {search_path=public}`, 0 defaults;
  - ACL `{postgres, authenticated, service_role}` with anon unable to execute;
  - the tally is STABLE.
- **Nothing else changed:**
  - every other public function (definition + ACL), with the count exactly +2;
  - every other policy, with the count exactly +1;
  - relations exactly +1;
  - both tables' triggers and constraints;
  - the guard, correct and the ledger pair, re-checked against their pins.

## RETEST (rolled back) — acting as real people through the API path
**Who it acts as:**
- a real DA with a unique email, whose department has ≥ 4 other active members, all with unique emails and inside their
  membership window for the oldest synthetic date (`membership_window_allows`);
- four of those members, non-leaders first.

**What it sets up:** synthetic sessions and rolls are written as the owner, then finalized by the DA through the shipped
length-only finalize.

| | proves |
|---|---|
| S0 | table, RLS, the one policy, privileges, both RPCs SECURITY DEFINER and not executable by anon |
| R1 | a member votes 1, then reads back their own row and nobody else's |
| R2 | re-vote -1 updates the same row; no duplicate |
| **R3** | **with 4 votes on a session, the real DA's raw SELECT returns 0 rows of anyone else's, while the tally returns up 2 · down 2** |
| **R4** | **a 2-vote session returns no tally row; the 4-vote one in the same call does** |
| **R5** | **a member not on the roll → `NOT_PRESENT`** |
| **R6** | **15 days after → `CLOSED`; 14 days → accepted** |
| R7 | not finalized · 0 · 2 · NULL · unknown session refused by the RPC; a raw 0 refused by the CHECK |
| R8 | a member's raw INSERT, UPDATE or DELETE → permission denied |
| R9 | removed from the roll via Correct → the vote stops counting (2 / 1); one more removed → below 3 → no row; the votes stay stored |
| R10 | a non-leader calling the tally → `NOT_ALLOWED` (SKIPs only if all four picked are leaders) |
| R11 | a reopened session refuses new votes and keeps the existing ones |

**Expected on live: 12 passed / 0 failed / 0 skipped.** A `SKIPALL` happens only if no DA qualifies (capture: 12
qualify) or the synthetic roll is refused.

## ROLLBACK
- It refuses unless the slice is applied.
- **It refuses while the table holds any vote.**
- It drops both functions and the table, then proves:
  - every other function and policy is byte-identical to just before;
  - both tables' triggers and constraints are on their pins;
  - the ledger pair is on its pins.

## Dry run — `docs/review/e1e3_sliceR_DRYRUN.txt`: **49 passed, 0 failed** (PGlite, a mock built FROM the capture)
- **Pins reproduce:**
  - all 15 functions' md5s and ACLs, created from the live text;
  - 17 constraints and 5 triggers deparse exactly as live;
  - the migration's own preflight passes;
  - the ledger is non-trivial.
  - **The only substitution:** the md5 of every live policy (labelled).
- **Apply and re-run:** applies; the state row is as intended; a re-run refuses.
- **RETEST: 12/0/0**, and it leaves nothing behind.
- **Mock-only cases:**
  - another department's 3-vote session: its own DA sees up 3; Alpha's DA gets no row; Alpha's member gets `NOT_FOUND`;
    Alpha's DA reads 0 raw rows;
  - a cancelled finalized session → `CANCELLED`;
  - anon is denied the table, the vote and the tally.
- **Rollback:**
  - refuses with 3 votes present;
  - a full round trip works on an empty table;
  - a second rollback refuses;
  - re-apply works.
- **Post-apply drift caught by the RETEST:**
  - the threshold lowered to 2 (R4);
  - a leadership read policy (S0 + R3);
  - INSERT granted plus an insert policy (S0 + R8);
  - the roll check removed (R5).
- **12 drift refusals:**
  - the guard, correct, `attested_training`, `is_leader`, `my_member_id`, and the attendance trigger function;
  - an attendance trigger, an attendance constraint, a policy, the attendance columns;
  - already applied (the table, or a function).
- **17 mutations caught and rolled back:**
  - the ledger moved; a roll row changed;
  - an insert policy; a leadership read policy; RLS off;
  - INSERT granted to authenticated; SELECT granted to anon; a column-level UPDATE;
  - a member FK without cascade; the unique missing;
  - the RPC not DEFINER; the tally granted to anon; the threshold edited;
  - a seeded vote; a view on the table;
  - another function changed; a policy added elsewhere.

## Tests and invariants
- `docs/review/e1e3_sliceR_db_test.mjs`, which covers regenerate byte-identical + the dry run + fences: **5/0**.
- The full suite: **41 files, 1073 PASS, 0 FAIL**. ESLint clean.
- No client, `api/`, `shared/` or `vercel.json` change. Verified 132/32/14. Notify held.
- **I ran no production SQL apart from the two read-only captures.**
