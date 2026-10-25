# B4C — Training Overhaul Slice 6-DB — DRAFT for gate review (NOT applied)

**Status:** this is a draft. It is **not** applied, and it isn't final until you run it yourself.

| File | What it is |
|---|---|
| `sql/training_slice6_corrections_DRAFT.sql` (SHA-256 `99e98211…`) | the migration: one all-or-nothing DO block, then a read-only state row |
| `sql/training_slice6_corrections_RETEST.sql` (SHA-256 `da818ae8…`) | the RETEST: SENTINEL fixtures; nothing persists; the error **is** the report |
| `docs/review/training_slice6_db_dryrun_harness.mjs` | the PGlite dry run |
| `docs/review/training_slice6_db_DRYRUN.txt` | its output |
| `docs/review/training_slice6_db_LIVEDEFS.json` | the live function bodies the mock uses verbatim |

Built to the rulings in [[B4C_TrainingOverhaul_Slice6_Step0_ReviewRecord]]. The binding brief is
[[B4C_Training_Hours_From_Attendance_Brief]]:
- nothing here writes `station_presence`;
- nothing touches `verified`;
- attested hours stay derived.

## Dry run (PGlite — not the live database)

**The mock** has 2 departments. It is built from the **live `pg_get_functiondef` bodies, verbatim**:
- the identity/gate functions;
- both membership-window triggers;
- close-on-done;
- `attested_training`, `dept_station_shifts`, `dept_iso_hours` / `_for`.

It also carries the live policy text and Supabase-style default grants.

**Pins:**
- 13 of the 15 pinned md5s are reproduced **byte-for-byte** by the mock. This is a check that the pins were taken
  correctly.
- 2 hours readers are stubs in the mock: `dept_iso_hours_by_station` and `dept_member_iso_hours_by_month`. Only for those
  two was the pin swapped to the stub's md5 for the run, and the output says so.

**Results:**

| Step | Result |
|---|---|
| Fresh apply | OK; the state row is right |
| Re-run | refused (`training_session_audit already exists`) |
| **RETEST** | **46 passed, 0 failed, 0 skipped**: 4 once-checks, plus 21 checks in each department. One mock department acts as a **real** training officer, the other as a fixture one. |
| Pre-flight drift | each of the 6 drift cases is refused: a gate function changed, `attested_training` changed, the UPDATE policy text changed, a second UPDATE policy, a `station_presence` SELECT policy (R2 premise), an extra trigger |
| Mutations | **13 of 13 caught**: 11 turn the named RETEST line(s) red; 2 (policy without the `done` term, an INSERT grant on the log) are refused by the migration's own post-conditions |

**The RETEST covers every item in the order:**
- a correction succeeds, with one audit row, old→new correct and attendees intact;
- a date outside a member's window → `MEMBERSHIP_WINDOW`, nothing written;
- a direct UPDATE of a finalized session → 0 rows (policy);
- a direct date UPDATE of an attended, open session → `LOCKED_SESSION`;
- finalize still works, including length null→value; sign-in fields still writable;
- Reopen without a reason → refused;
- a roster delta moves `attested_training`;
- **`station_presence` is byte-identical before and after every RPC call, and the `verified` count is unchanged**;
- Officer-not-TO, Board, PA and Member are refused on all 4 RPCs; anon has no EXECUTE; a foreign-department session is
  refused;
- the audit table has no write path (and is append-only even for the owner);
- the hours readers' md5s are unchanged.

**On live, the RETEST:**
- uses a real active training officer where one exists (Lipan, Indian Harbor, North Hood) and a rolled-back fixture
  officer elsewhere;
- uses fixture Officer, Board, PA and Member personas everywhere. Live has **no** non-DA Project Admin and only one
  board-only member, so the fixtures are what make the role matrix complete.

## Decisions the record didn't spell out — please confirm or overrule

| # | Decision | Why |
|---|---|---|
| **D1** | The "DA-only after 14 days" branch checks the **`Department Admin` role**, not `is_dept_admin()` | Live `is_dept_admin()` **also admits Project Admin**, and a PA must never rewrite a finalized attendance record. RETEST T8b proves a PA who is also a training officer is refused (the mutation using `is_dept_admin()` is caught). |
| **D2** | "Older than 14 days" uses the **earlier** of the current and the corrected date (Central time) | Moving a recent drill back into the past rewrites an old record too |
| **D3** | **Reopen gets the same 14-day hybrid** | Otherwise Reopen → re-mark → Finalize is a way around C1 |
| **D4** | **Two extra columns:** `roster_snapshot` (Reopen) + `seq` (an identity, for ordering) | `toggleAttend` writes the roll directly while a session is reopened. Finalize logs exactly who was added/removed since the Reopen, so the close → reopen → correct history has no gap (T13). |
| **D5** | `actor_id` has **no FK** (`actor_name` is the snapshot); `department_id` has NO ACTION; `session_id` has RESTRICT (as ruled) | Removing a member must neither be blocked by, nor erase, the log. A department with a log can't be deleted without deliberately clearing it. |
| **D6** | The R4 recompute is the latest done, attended drill's date in that category; with **no evidence, the stored value is left as is** (never nulled) | It **can move backward**: that's how a Sep-24 → Sep-3 correction un-stamps a wrong Sep-24. Finalize itself uses `greatest(existing, drill date)` as ruled. |
| **D7** | Finalize refuses while the QR sign-in is open, and refuses a length different from one already recorded (`USE_CORRECT`) | The client already closes the QR first; changing a recorded length is a correction |

**Also added (not asked for):** an **append-only trigger** on `training_session_audit` that refuses UPDATE/DELETE even from
the owner. A SQL-editor slip can't rewrite history.

## ⚠ Apply timing
- The new policy term means **today's client Reopen** (a direct `update({done:false})` on a done row) **affects 0 rows
  silently** until 6-UI ships the `reopen_training_session` call.
- Everything else the current client does keeps working (finalize incl. first length, sign-in, roster on open sessions,
  normal edits of unlocked sessions; T11).
- **Recommend applying 6-DB in the same window as the 6-UI promote.** The alternative is splitting the lock enforcement
  (policy + guard) out to apply with 6-UI, if you'd rather land the table and RPCs first.

## Noticed, not changed
- `session_attendance` has **two identical unique indexes** on `(session_id, member_id)`: `…_session_id_member_id_key`
  and `…_session_member_uniq`. Harmless; a housekeeping drop for later.
- The two briefs (`B4C_Training_Attendance_Capture_Gap.md`, `B4C_Training_Hours_From_Attendance_Brief.md`) exist only as
  **untracked** files in the main checkout's `claude/`. They aren't on main or on any branch yet.
