# B4C — E1/E3 Slice T (training time, DB) — DRAFT. NOT APPLIED.

**Branch:** `feat/e1e3-slice-t-db`, on top of the Step 0 (`design/e1e3-step0` @ `813ed0e`, off main `1fc6059`).
**Rulings (Ashlea):** Option A (the actual times derive `duration_min`); start/end optional with the length-only
fallback; `setup_min` recorded only, never credited.
**Apply:** waits on Ashlea's explicit go after gate review. Same as every migration.

## Provenance
Two read-only captures were run on live 2026-10-29 at 23:03 UTC (no writes):
- `sql/e1e3_sliceT_CAPTURE_A_fns.sql` → `docs/review/e1e3_sliceT_LIVE_fns.json`: 14 functions, definition + md5 + ACL.
  All md5s are identical to the Step 0 capture.
- `sql/e1e3_sliceT_CAPTURE_B_meta.sql` → `docs/review/e1e3_sliceT_LIVE_meta.json`:
  - triggers, constraints and columns;
  - the md5 of every public policy (`a9947383…`);
  - counts: 228 functions, 181 policies, 176 sessions, 31 finalized with a length, verified 991;
  - the per-department ledger baseline.

The first, single-row capture froze the browser tab on its huge result cell. It was split into these two and re-run in
a fresh tab; nothing else changed.

`docs/review/e1e3_sliceT_build.mjs` generates everything from those two files, rewriting the live function text with
exact-match edits. `--check` regenerates all 4 outputs byte-identical.

## Files
- `sql/e1e3_sliceT_session_times_DRAFT.sql`: one all-or-nothing `DO $migrate$` block, then `NOTIFY pgrst`, then the
  state row.
- `sql/e1e3_sliceT_session_times_RETEST.sql`: rolled back via `SENTINEL`. S0 + T1–T11.
- `sql/e1e3_sliceT_session_times_ROLLBACK.sql`.
- `docs/review/e1e3_sliceT_CHANGE_LIST.md`.
- **`docs/review/e1e3_sliceT_FUNCTION_DIFFS.txt`:** the three function changes as unified diffs (live → DRAFT).
- `docs/review/e1e3_sliceT_DRYRUN.txt`.

## What it does
1. **Columns** on `training_sessions`: `actual_start time`, `actual_end time`, `setup_min smallint`. All nullable;
   existing rows are untouched (proven).
2. **CHECKs** (all validated at apply):
   - `actual_pair`: start and end are both set or both null.
   - `actual_whole_minutes`: whole minutes, and end ≠ start.
   - `actual_length`: **`duration_min IS NOT DISTINCT FROM span(start, end)` when times are present.** `IS NOT DISTINCT`
     means a NULL length with times is refused too.
   - `setup_range`: 0–600.
   - **The span:** `((extract(epoch from (end − start)) / 60)::integer + case when end <= start then 1440 else 0 end)`.
     It's one formula, used by the CHECK and both RPCs; an end at or before the start ran past midnight.
   - Length-only rows (the 31 today, and every future fallback) have no times, so they pass.
3. **New `finalize_training_session(p_session_id, p_actual_start, p_actual_end, p_setup_min)`, with NO defaults** (see the
   overload section below).
   - Built from the live length-only finalize, with only the length handling changed.
   - It derives the length; `USE_CORRECT` if a length or times already exist and differ.
   - SECURITY DEFINER, `search_path=public`. `REVOKE … FROM PUBLIC, anon`, then `GRANT EXECUTE TO authenticated,
     service_role`, which matches the live finalize ACL.
   - **The length-only `(uuid, integer)` finalize is not touched** (md5-pinned before and after).
4. **`correct_training_session`** (`CREATE OR REPLACE`, same signature, ACL kept):
   - It accepts `actual_start`, `actual_end` and `setup_min`.
   - With times present, `duration_min` is **recomputed** from them. A `duration_min` sent that disagrees →
     `BAD_VALUE: the length comes from the actual start and end (N minutes) — change the times instead.`
   - Clearing both times leaves a length-only session with the length kept.
   - Each change goes in the existing diff and audit.
5. **`tg_training_session_lock_guard`** (`CREATE OR REPLACE`, ACL kept):
   - The three columns follow `duration_min`'s rule exactly: settable once on a not-yet-finalized row (Finalize's
     UPDATE), and only through Correct after that.
   - **Without this they would be raw-writable on a locked session.**

Nothing else changes: no policy, no grant, no data, no other function. The diffs are in `e1e3_sliceT_FUNCTION_DIFFS.txt`.

## The finalize overload: no call shape can match both (addendum)
- PostgREST picks an overload by the **set of argument names** in the request. The two functions are:
  - the existing `finalize_training_session(uuid, integer)`, which answers only `{p_session_id, p_duration_min}`;
  - the new one, which answers only `{p_session_id, p_actual_start, p_actual_end, p_setup_min}`.
- **Neither has a default.** The first draft's `p_setup_min DEFAULT NULL` is removed, so no partial set matches either
  one, and the two sets can't overlap.
- Today's web and the installed native app call `rpc("finalize_training_session", { p_session_id, p_duration_min })`.
  Both keys are always sent, with `p_duration_min` possibly null, so they keep resolving to the old function until U1
  ships.
- **The proof is a post-condition.** The overloads' argument-name sets and default counts must be exactly
  `p_session_id,p_duration_min/0 | p_session_id,p_actual_start,p_actual_end,p_setup_min/0`, or the migration rolls
  back. The state row prints them.
- **Dry run:**
  - each PostgREST shape matches exactly one function;
  - partial shapes match none;
  - named `{p_session_id, p_duration_min => NULL}` and positional `(uuid, NULL)` SQL calls resolve, with no "not
    unique";
  - a 3-argument times call does not resolve;
  - putting the default back is caught by the post-condition.
- **RETEST T8** calls the old function by name, exactly as the shipped clients do.
- **A pre-existing length** that disagrees with the supplied times' span → `USE_CORRECT`. It never overwrites, and it
  never writes a pair that would trip the CHECK (T9).

## Preflight (refuses and changes nothing)
- **Already applied:** any of the three columns, four CHECKs or the new overload exists → refuse.
- **md5 pins** on 12 functions: the length-only finalize, correct, the guard, `attested_training`,
  `dept_iso_hours_for`, `open_signin`, `drill_window_presence`, `reopen_training_session`, `my_department_id`,
  `my_member_id`, `is_training_manager`, `recompute_training_plan_last_iso`.
- **Pinned structure:**
  - the four `training_sessions` **trigger definitions**;
  - its **constraints** (excluding NOT NULL rows, which only newer Postgres records; NOT NULL is pinned via the column
    list);
  - **every public policy** (md5);
  - the **column list** (name, type, nullability).

## In-transaction proof (any miss → RAISE → everything rolls back)
- **THE LEDGER (the one you'll weigh hardest).** For **every department**, the md5 of
  `attested_training(dept, 1900–2200)` **and** of `dept_iso_hours_for(dept, 1900–2200)` (training, standby and ISO
  hours per member) is computed before and after inside the transaction, and **must be byte-identical**.
  - Both functions are also md5-pinned unchanged.
  - The dry run proves the check has teeth: a mutation that changes the 90-minute cap fails "the credited-hours ledger
    moved for department …" and rolls back.
- **Session rows:** every `training_sessions` row is byte-identical, ignoring the three new columns, which must all be
  NULL.
- **`setup_min` (and the times) are display-only:** the set of public functions whose source names a new column, after
  the migration, is **exactly the set before plus the three** (finalize overload, correct, the guard). No view reads
  them, and `attested_training` / `dept_iso_hours_for` are unchanged.
  - The dry run proves it: making the ISO-hours function read `setup_min` is refused.
  - So is creating a view that reads it.
- **Bodies and ACLs:**
  - each new body is exactly the generated text;
  - the guard and correct keep their ACLs;
  - the new overload is SECURITY DEFINER and **not executable by anon**.
- **Everything else unchanged:**
  - every other public function (md5 of definition + ACL);
  - every policy, trigger and pre-existing constraint;
  - the function count +1 exactly;
  - verified presence.

## Live ledger baseline (capture B, 2026-10-29 23:03 UTC) — for reference
The migration doesn't pin these: it compares before and after within its own transaction, because the data moves day
to day.

| dept (prefix) | attested md5 | ISO md5 |
|---|---|---|
| 5bc40678 | d41d8cd9 (empty) | e9644ac6 |
| 6d51b00a | dada3111 | 8b9ad8ee |
| 6fbb2d91 | 7d11f87c | c61d7dbf |
| 94667450 | d41d8cd9 (empty) | d41d8cd9 (empty) |
| a8dbabd1 | f7fd7efe | da4f1cf5 |

## RETEST (rolled back, as a real DA through the API; as the table owner where the point is that the guard / CHECK stop every writer)
- **S0:** the slice is in place, and the ledger functions don't read the new columns.
- **T1:** times 19:00–22:26 + setup 20 → **206 min**, and the audit diff has all five keys.
- **T2:** **22:00–01:30 → 210.**
- **T3:** a raw UPDATE of each new column on a finalized session → `LOCKED_SESSION`.
- **T4:** a disagreeing length under the correction flag → refused by the **CHECK**.
- **T5:** Correct `actual_end` 23:00 → **240, recomputed**.
- **T6:** Correct length-only while times exist → `BAD_VALUE`.
- **T7:** clearing the times → length-only, 240 kept.
- **T8:** the length-only finalize still works (45, no times).
- **T9:** refused: start = end · one time missing · setup 700 · an existing different length → `USE_CORRECT`.
- **T10:** the ledger credits **min(90, 206) = 90** from `date + start_time`, and a `setup_min` of 300 has no effect.
- **T11:** after Reopen (with its roll), a raw UPDATE of the stored times → `LOCKED_SESSION`.
- On live, T10 and T11 need a synthetic roll entry that the membership-window trigger might refuse. If so they SKIP
  with that reason, and the dry run carries them.

## ROLLBACK
- It refuses unless the slice is applied.
- **It refuses while any session holds times or a setup time**, because dropping the columns would destroy them.
- It drops the new overload, restores correct and the guard from their **captured** definitions, drops the four CHECKs
  and the three columns, and proves every pin is back.

## Dry run — `docs/review/e1e3_sliceT_DRYRUN.txt`: **39 passed, 0 failed** (PGlite, a mock built FROM the capture)
- **Pins reproduce:** all 14 functions' md5s and ACLs, the 8 constraints and 4 triggers deparse exactly as live, and
  the migration's own preflight passes.
  - The **only** substitution is the md5 of every live policy (the mock can't hold the live DB's 181 policies). It's
    labelled.
  - `training_session_audit.seq` gets a mock identity (live fills it outside the column default).
- **Ledger:** the mock's ledger is non-trivial: 3 attested rows, and a 120-minute drill capped at 90.
- **Apply and re-run:** applies, the state row is as intended, and a re-run refuses.
- **RETEST: 12/0/0**, and it leaves nothing behind.
- **Rollback:** a full round trip works. Rollback **refuses while a session holds times**, and a second rollback
  refuses too.
- Post-apply drift (the old guard put back) → **RETEST fails T3**.
- **10 drift refusals:** correct, the guard, `attested_training`, `dept_iso_hours_for`, the length-only finalize, a
  trigger, a constraint, a policy, the columns, already applied.
- **The overload shapes:** each resolves to exactly one function; partial shapes resolve to none.
- **11 mutations caught and rolled back:**
  - the ledger moved;
  - a session row changed (guard bypassed);
  - a backfilled new column;
  - a dropped length CHECK;
  - the old guard left in place;
  - anon granted;
  - another function changed;
  - a view reading `setup_min`;
  - the ISO function reading `setup_min`;
  - an added policy;
  - the default put back on `p_setup_min`.

## Tests and invariants
- `docs/review/e1e3_sliceT_db_test.mjs` (regenerate byte-identical + dry run + fences): **5/0**. The full suite is **40
  files, 1068 PASS, 0 FAIL**. ESLint clean.
- No client, `api/`, `shared/` or `vercel.json` change. verified 132/32/14. Notify held.
- **I ran no production SQL apart from the two read-only captures.**
