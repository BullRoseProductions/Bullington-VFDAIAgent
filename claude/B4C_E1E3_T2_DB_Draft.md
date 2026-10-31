# B4C — E1/E3 T2 (at finalize, actual times replace a pre-finalize estimate) — DRAFT. NOT APPLIED.

**Branch:** `feat/e1e3-t2-db`, on top of `feat/e1e3-slice-r-db` @ `57453b1` (Slices T + R are live).
- **Ruling:** Ashlea's, from flag 1 of `B4C_E1E3_U1_UI_ReviewRecord`. "Schedule with this plan" pre-fills `duration_min` with
  the plan's estimate. A session that isn't finalized has no recorded length, only an estimate, so the times' span replaces
  it.
- **Apply:** on Ashlea's explicit go. U1 promotes after.

## Provenance
Two read-only captures were run on live 2026-10-31 at 02:30 UTC. They're the Slice R capture queries, renamed:
- `sql/e1e3_T2_CAPTURE_A_fns.sql` → `docs/review/e1e3_T2_LIVE_fns.json`: 17 functions.
  - Every md5 equals the Slice R capture, plus R's two new functions as applied (`6c6004eb`, `4ae1d747`).
  - The times finalize is **`b702ad77`**.
- `sql/e1e3_T2_CAPTURE_B_meta.sql` → `docs/review/e1e3_T2_LIVE_meta.json`:
  - triggers, constraints and columns are identical to the R capture;
  - the policy md5 is `c9815df7…`, which differs only by R's one policy;
  - counts: 231 functions, 182 policies, verified 1026;
  - the per-department ledger.

`docs/review/e1e3_T2_build.mjs` generates everything from those two files. `--check` regenerates byte-identical.

## What it does: ONE function, `CREATE OR REPLACE`, same signature, ACL kept
**Changed:** `finalize_training_session(uuid, time, time, integer)`, from `b702ad77` to **`f3ef2eb6`**.
1. **Removed:** the 3-line `USE_CORRECT: this drill already has a length` refusal. The span replaces an existing
   `duration_min`.
2. **Kept:**
   - the finalize audit diff's `duration_min` old → new, so the replacement is logged;
   - `USE_CORRECT` for **existing actual times** and an **existing setup time**, so a reopen → re-finalize with different
     times is still a Correct;
   - every `BAD_VALUE` check;
   - the CHECK, which holds because the length = the span in the same UPDATE.
3. **⚑ Added because the dry run showed it's needed: the correction flag around the one UPDATE.**
   - Removing the refusal alone just trades `USE_CORRECT` for **`LOCKED_SESSION`**. Once anyone is on the roll, the live
     lock guard (`c1af95df`, untouched) lets `duration_min` change only *from NULL*. Replacing a length is the change it
     reserves for the transaction-local `b4c.session_correction` flag.
   - That means the directive's "plain Edit can already change it" holds only while the roll is empty. At finalize the
     roll normally isn't empty.
   - So the function sets `v_lift := s.duration_min is not null and s.duration_min <> v_dur`. Only then does it
     `set_config('b4c.session_correction','on', true)` around its own UPDATE, and it clears the flag right after. That's
     exactly the pattern `correct_training_session` uses.
   - The UPDATE writes only validated values (`done`, the span, the times, setup).
   - **The guard stays byte-identical**, and the scope stays one function.
   - RETEST U7 proves the flag doesn't leak. A post-apply drift that leaves the flag on is caught.

**Not touched (all byte-identical after, proven):**
- the length-only finalize `3f31142b`;
- correct `8c000665`;
- the guard `c1af95df`;
- `attested_training` `aff25333`;
- `dept_iso_hours_for` `705c9a9b`;
- every other function (count unchanged), every policy, trigger, constraint and column, and all data.

## ⚑ For the gate: the reopened length-only session
- **The case:** a drill finalized length-only (say 60, a *recorded* length), then reopened to fix the roll, then
  re-finalized **with times**.
- **What T2 does:** 206 replaces 60, logged 60 → 206 in the finalize diff. That's what the ruling as written does. The dry
  run documents it.
- **What doesn't change:** a session reopened after a times finalize still refuses different times (U3).
- **The alternative, if you'd rather keep a recorded length a Correct:** add one condition to the same function. It would
  refuse when the session has a prior `finalize` audit row and `duration_min` differs. That's one `exists (…)` line and
  needs no other object. Not drafted; your call.

## Preflight (refuses and changes nothing)
- Already applied: the times finalize = `f3ef2eb6`.
- md5 pins on all 17 captured functions.
- Both tables' trigger and constraint definitions and columns.
- Every public policy (md5).

## In-transaction proof (any miss → rollback)
- The per-department ledger, both functions, all time: byte-identical.
- `training_sessions` + `session_attendance` rows: byte-identical.
- **The times finalize is exactly the generated body:**
  - md5 `f3ef2eb6…`, which equals the md5 of the DRAFT's own CREATE text (the dry run checks this);
  - SECURITY DEFINER, `search_path=public`, VOLATILE;
  - the ACL unchanged, and anon cannot execute.
- Both overloads' named-argument sets are unchanged, with 0 defaults.
- **The five pins are byte-identical:** the guard, correct, the length-only finalize, and the ledger pair.
- Every other public function (definition + ACL) is byte-identical, and the count is unchanged.
- Policies, triggers and constraints are unchanged. Verified presence is unchanged.

## RETEST (rolled back) — a real DA through the API path; expect **8 passed / 0 failed / 0 skipped**
| | proves |
|---|---|
| S0 | T2 is in place (`f3ef2eb6`); both overloads unchanged; the 5 pins hold |
| **U1** | **a plan-scheduled session (estimate 120) finalized 19:00–22:26 → 206 replaces 120; the audit logs 120 → 206** |
| U2 | the ledger credits it min(90, 206) = 90 (it reads the replaced length; the ledger itself is unchanged) |
| U7 | the flag U1 lifted is cleared: a raw change to that session in the same transaction → `LOCKED_SESSION` |
| **U3** | **existing actual times still refuse:** reopen → different times → `USE_CORRECT`; the same times re-finalize |
| U4 | an existing setup time still refuses: setup 30 over 20 → `USE_CORRECT` |
| **U5** | **the length-only finalize is exactly as today:** estimate 120 + 90 → `USE_CORRECT`; NULL keeps 120; no length + 45 → 45 |
| U6 | the times finalize still refuses end = start, a missing time, and setup 700 |

## ROLLBACK
- It refuses unless T2 is applied.
- It restores the **captured** pre-T2 body (`CREATE OR REPLACE`, ACL kept) and proves `b702ad77` is back, with the ACL,
  overloads, every other function and the count all unchanged.
- No data consequence: sessions finalized under T2 have length = span, which T accepts.

## Dry run — `docs/review/e1e3_T2_DRYRUN.txt`: **37 passed, 0 failed** (PGlite, mock from the capture)
- **Pins reproduce:**
  - 17 functions plus their ACLs;
  - 17 constraints and 5 triggers;
  - the preflight passes;
  - the ledger is non-trivial.
  - **The only substitution:** the live policy md5 (labelled).
- **Apply and RETEST:**
  - applies; the state row reports md5 = the generated text;
  - a re-run refuses;
  - **RETEST 8/0/0**, and it leaves nothing behind.
- **Rollback:**
  - a full round trip back to `b702ad77`;
  - after the rollback the RETEST fails exactly at S0 and U1 with `USE_CORRECT`;
  - a second rollback refuses; re-apply works.
- **The reopened length-only case:** documented, as described above.
- **Post-apply drift caught by the RETEST:**
  - the pre-T2 body put back (S0, U1);
  - **the flag left on** (U7);
  - the existing-times refusal removed (U3).
- **10 drift refusals:**
  - the times finalize, the length-only finalize, the guard, correct, `attested_training`;
  - a trigger, a constraint, a policy, the columns;
  - already applied.
- **10 mutations caught and rolled back:**
  - the ledger moved; the length-only finalize changed; `is_leader` changed;
  - the length refusal left in; the times refusal dropped;
  - anon granted; a default added;
  - a session row changed; an extra function; a policy added.

## Tests and invariants
- `docs/review/e1e3_T2_db_test.mjs`: **5/0**. ESLint is clean.
- No client, `api/`, `shared/` or `vercel.json` change. Verified 132/32/14. Notify held.
- **I ran no production SQL apart from the two read-only captures.**
