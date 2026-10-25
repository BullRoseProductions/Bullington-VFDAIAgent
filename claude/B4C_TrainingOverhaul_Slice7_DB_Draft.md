# B4C — Training Overhaul Slice 7-DB (cancel / restore, two-person, status) — DRAFT for gate review (NOT applied)

**Status:** a draft for your gate review. It is **not applied**, and it isn't final until you run it yourself.

| File | What it is |
|---|---|
| `sql/training_slice7_cancel_DRAFT.sql` (SHA-256 `8333df0b…`) | the migration: one all-or-nothing DO block, then a read-only state row. **Generated:** don't hand-edit it. |
| `sql/training_slice7_cancel_RETEST.sql` (SHA-256 `49419c32…`) | the RETEST: SENTINEL fixtures; nothing persists |
| `docs/review/training_slice7_db_build.py` + `…_template.sql` | the generator: builds the migration from the **live bodies** in `docs/review/training_slice7_db_LIVEDEFS.json` |
| `docs/review/training_slice7_db_READER_DIFFS.patch` | each repointed reader, live → Slice 7. **Pure insertions only.** |
| `docs/review/training_slice7_db_dryrun_harness.mjs` | the PGlite dry run |
| `docs/review/training_slice7_db_DRYRUN.txt` | its output |
| `sql/training_slice6_corrections_2026-10-25.sql` + `…_RETEST.sql` | **the applied Slice 6 migration, now recorded on a branch headed for main**. Byte-identical to what ran live (`99e98211…`); it was only on `feat/training-slice6-db`. The dry run applies it to build the mock. |

Built to the rulings in [[B4C_TrainingOverhaul_Slice7_Step0_ReviewRecord]]:
- scope is **Cancel + Restore only**;
- no reschedule kind;
- **date / start_time are NOT added to the guard.**

## What the migration does
- **`training_sessions.status`:** `text NOT NULL DEFAULT 'scheduled'`, CHECK `scheduled | cancelled`.
- **`training_session_requests`:**
  - contents: kind (`cancel | restore`), reason (≥ 10), initiator id / name / **signature**, approver id / name /
    **signature**, `decision_reason`, state (`pending | approved | withdrawn | rejected | expired`), timestamps;
  - **one pending request per session**, enforced by a partial unique index and an RPC check;
  - a CHECK that an approved row has an approver who **≠ the initiator**, with a signature;
  - RLS on, with no write grant;
  - **column grants exclude both signatures**, so they're unreadable to `authenticated` except through
    `session_change_signatures(request_id)`.
- **`training_session_audit` action CHECK:** a pinned drop + re-add, adding `cancel | restore`. The entry is written on
  approval, with `status` old→new, the `request_id`, the initiator, and the approver as the actor.
- **The lock guard:**
  - `status` changes **only under the RPC flag**, on any row;
  - an INSERT must be `scheduled` (the trigger is now `BEFORE INSERT OR UPDATE`);
  - a **cancelled row is locked** like a finalized one;
  - date / start_time on an upcoming, unattended row stay free (plain Edit).
- **The RPCs** (SECURITY DEFINER, `search_path=public`, anon/public revoked, authenticated granted, department-checked):

  | RPC | Does |
  |---|---|
  | `request_session_change(session, kind, reason, signature)` | Files the request. |
  | `approve_session_change(request, signature)` | A **different**, signed-in training manager approves. The status flips under the flag and the audit row is written. |
  | `reject_session_change(request, reason)` | Declines a pending request. |
  | `withdraw_session_change(request)` | The initiator takes back their request. |
  | `session_change_signatures(request)` | The on-demand signature read. |

- **The 8 R7 readers + `my_department_rollup`:**
  - each is the **verbatim live body plus one inserted block** (`READER_DIFFS.patch`);
  - the post-condition proves it: `md5(new body − that block) = live md5`, for all nine;
  - 7 readers raise `CANCELLED`; `current_signin_token` returns no code; the rollup's next-event union skips cancelled.
- **Housekeeping:** `swap_week_dates` + `move_week` revoked and dropped.
  - **Both were executable by `anon`** (live ACL).
  - The pre-flight refuses if anything has started calling them.
- **Pre-flight pins:**
  - **34 md5s**, among them: every unchanged-after function (gates / identity, membership triggers, close-on-done, the hours
    readers + `attested_training`, `pa_department_radar` / `readiness_verdict` / `probation_item_states`, the 4 untouched
    Slice 6 functions), the guard, the 9 repointed, the 2 dropped;
  - the audit CHECK text;
  - all 4 `training_sessions` policies;
  - the trigger set;
  - double-apply refusals (`status` column, requests table, 5 RPC names).
- **Post-conditions:**
  - the unchanged pins are re-checked;
  - the 9 diffs are proven;
  - the drops are confirmed;
  - guard / trigger / grants / column grants / policy text / audit CHECK are all correct;
  - every existing session is `scheduled`;
  - `NOTIFY pgrst`.

## Dry run (PGlite — not the live database)

**The mock:**
1. the Slice 6 mock (live bodies verbatim);
2. **then the applied Slice 6 migration**;
3. then the 9 readers + `swap_week_dates` / `move_week` as **live bodies verbatim**.

**Pins: 29 of 34 reproduce byte-for-byte.** That covers every Slice 6 function as built from the recorded migration, all 9
readers (the 14.7 KB rollup included), and both functions being dropped. It proves the pins and that the recorded Slice 6
file *is* what's live. The 5 re-pinned are mock stubs; the output names them.

| Step | Result |
|---|---|
| Migration | OK; the state row is right |
| Re-run | refused |
| **RETEST** | **37 passed / 0 failed / 0 skipped**: 7 once-checks plus 15 per department. One department acts as a **real** training officer + DA, the other as fixtures. |
| **Slice 6 RETEST re-run after 7-DB** | **46 / 0 / 0**: no regression to corrections / reopen / finalize / the lock |
| Pre-flight drift | 6 / 6 refused: a reader body, `attested_training`, the audit CHECK, a policy, a new caller of `swap_week_dates`, a pre-existing `status` |
| Mutations | **13 / 13 caught**: 10 turn the named RETEST lines red; 3 are refused by the migration's own post-conditions (signatures column-selectable, `open_signin` left unrepointed, `swap_week_dates` kept). M1 (self-approve) is caught twice: by the RPC **and** by the table's CHECK. |

**The RETEST covers every item in the order:**
- **The two-person flow:**
  - file → pending, untouched;
  - self-approve → `SAME_PERSON`;
  - a second pending → `PENDING`;
  - the second manager approves → cancelled, the QR closed, one `cancel` row (old→new, `request_id`, actor = approver);
  - restore the same way → scheduled + a `restore` row.
- **The 8 readers refuse a cancelled session**, and the rollup's next event skips it.
- **The guard:** a raw `status` UPDATE (owner **and** authenticated) or a cancelled INSERT → `STATUS_LOCKED`; a cancelled row
  can't be edited.
- **Refusals:** `ATTENDED`, `FINALIZED`, `NOT_UPCOMING`, `NOT_CANCELLED`, `BAD_KIND`, `REASON_REQUIRED`, `BAD_SIGNATURE`
  (typed name; > 200 KB).
- **Reject / withdraw / lazy expiry.**
- **Role matrix:** Officer-not-TO / Board / PA / Member are refused on all four write RPCs.
- **Cross-department:** `NOT_FOUND`.
- **Table access:**
  - Board and a **plain-Member training officer** read requests (own department only); a Member can't;
  - signatures come only via the RPC;
  - no INSERT.
- **`station_presence` is byte-identical across every call, and `verified` is unchanged.**

**On live, the RETEST:**
- uses a real active TO (Lipan, Indian Harbor, North Hood) and a real DA where they exist; fixtures elsewhere;
- **T6 (rollup) may SKIP** in a department where another event sorts ahead of the fixture on the same day. It ran (PASS) in
  both mock departments.

## Decisions the record didn't spell out — please confirm or overrule

| # | Decision |
|---|---|
| **D1** | "Upcoming" = the drill date ≥ today (Central); same-day counts. A pending request that's no longer valid (date passed / attended / finalized / already in the target state) is **expired by the approve call and returned, not raised**: a raise would roll the expiry back (mutation M7 proves it). |
| **D2 ⚠ deviates from the order's "SELECT to `is_leadership()`"** | Requests are readable by `is_leadership()` **OR `is_training_manager()`** (department-scoped). A training officer who is a plain Member is an approver but isn't "leadership". Leadership-only would hide the very request they must sign (M6 shows T14 going red). **Revert = one line** if you want it strictly leadership. |
| **D3** | A cancelled session is **locked** (its protected fields change only under the flag) until restored. |
| **D4** | `session_change_signatures(request_id)` is the only signature read for `authenticated` (column grants). It's a 5th RPC beyond the order's four. |
| **D5** | Approving a cancel also **closes an open QR sign-in** (`signin_open=false`, token cleared). |
| **D6** | "Never a Project Admin" holds through `is_training_manager()` itself (its DA arm is the DA *role*). A PA who is **also a registered training officer** counts as a TO. |
| **D7** | `current_signin_token` returns **NULL** for a cancelled session rather than raising: the officer page polls it for every session it shows. |
| **D8** | Reject = any **other** training manager, reason ≥ 10. Withdraw = the initiator only. |
| **D9** | Signature = `data:image/png;base64,…`, ≤ 204 800 characters. |

## ⚠ A correction to my Slice 7 Step 0
**`my_department_rollup` has NO AND/OR precedence slip.** The live body wraps the `OR` in parentheses (lines 89–90, 97–98,
155–156).

My Step 0 claim came from a line-filtered extract that dropped the line carrying the opening parenthesis. **The follow-up
[[B4C_DeptRollup_Precedence_Followup]] the review record opened can be closed: there's nothing to fix.** The Slice 7 rollup
change is the single term `and coalesce(ts.status, 'scheduled') <> 'cancelled'` on the next-event union, and the
post-condition proves that's the only diff.

## Apply timing
**Same window as 7-UI**, applied first; the same choreography as Slice 6.
- Until a session is actually cancelled, the column is inert: every row is `scheduled`.
- But the current client has no cancel UI, and the new guard refuses a raw `status` write, so nothing can break before 7-UI
  ships.
- The real reason to pair them is the §6 readers (Up-next, pulse, NeedsAttention, the overdue clock): they need to learn
  `status` *before* the first cancel.
