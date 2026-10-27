# B4C — WS-4b draft: shared/ helpers (apparatus + attendance), F-2, F-4 (for gate review)

**CC, 2026-10-27. DRAFT — not merged, nothing applied, no DB change.**

- **Branch:** `feat/ws4b-shared`, off main `734dc71` (industrial-noir-37 = WS-4a).
- **Rulings:** [[B4C_WS4_Metrics_Step0]] §9 as Ashlea ruled:
  - A-1..A-4 STRICT;
  - C-1..C-3;
  - D-1..D-3, where **D-2 = meetings count in attendance %, not as drills**;
  - F-2, F-4.
- **Runtime:**
  - changed: `src/App.jsx`, `src/report.js` (the Chief's Report PDF), `api/digest.js`, `api/pulse.js`;
  - new: `shared/apparatus-status.js`, `shared/attendance.js`.
- **Review files:**
  - diff: `docs/review/ws4b_shared_DIFF.patch`
  - test: `docs/review/ws4b_shared_test.mjs`, **45/0**, output in `ws4b_shared_TEST_OUTPUT.txt`
  - full suite: 28 tests, 0 red, 765 PASS
  - build: OK
  - `shared/` differential tests (maint-due, digest station-hours, duty-period): green
- **Invariants:** `verified` 132 · 32 · 14; no `station_presence` line added; Notify held.

## A — `shared/apparatus-status.js`: one strict "ready"

**`rigStatus(rig)` →**
- `retired`: `deleted_at` set; out of every count.
- `out_of_service`
- `never_checked`: in service, no `last_check_at`.
- `needs_attention`: not Pass, **or its scheduled check is overdue** (A-3).
- `ready`: in service ∧ Pass ∧ checked ∧ not overdue.

Overdue mirrors the page's `checkDue`: only a rig with `check_interval_days` can be overdue; no schedule means never overdue. `apparatusCounts(rigs)` gives buckets that sum to the non-retired total (A-2). The helper accepts both raw rows (the email) and the app's camelCase rigs; the test proves they read identically.

| Call site | Change |
|---|---|
| `useApparatusReadiness` (dashboard bar, BoardStats, ReportsHub, Chief's Report + PDF + AI prompt, Agenda) | Reads `last_check_at, check_interval_days`; buckets come from `rigStatus`. `totals.flagged` keeps its name (= needs attention). New `totals.neverChecked` and `neverCheckedRigs`. Every consumer now names "never checked": bar segment, rig lists, report line, PDF table, prompts, the Agenda's attention count, the ReportsHub tone. |
| Apparatus page | Card pill and detail line come from `rigLook` → `rigStatus`. **"In service" no longer means Pass:** a passed, checked, on-schedule rig reads **"Ready"**. The "Ready to roll" chip is strict (x / total). An **overdue check now counts in "Needs attention"** (it used to be only a sub-line), with a sub-line saying how many of those are overdue. |
| **A-4** | Dashboards and the email stay department-wide. On **one house of a multi-house department**, the page says "**Station 2** · 3 of 5 ready · department-wide figures are on the dashboard". `useStationList` now also loads in single-house mode (one `my_stations` read) so it can name the house. |
| Weekly email | Tile **"Apparatus ready" = ready / total** by `apparatusCounts`. It was "Apparatus" = in_service / total. |

## C + D — `shared/attendance.js`: one attendance rule

**What moved.** `deptAttendance`, `memberAttendance`, `joinCutoff` / `expectedAfterJoin`, and `isRestrictedEvent` / `isOptionalEvent` / `countsTowardRate` were **lifted verbatim**. App imports them, and so does the email. The test pastes the **original** App code and proves the shared version returns the same rows, counting sessions and average on **3,000 random fixtures**. The member version is checked on the same 3,000.

**Only the ruled changes:**
- **Cancelled sessions never count.**
- **C-3:** `avg` is **null ("—")** when nobody is rated (it was 0). Every consumer now prints "—": ReportsHub, BoardStats, the Attendance Report (stat, trend label and its average line), DeptHealthCharts captions, the Chief's Report (screen, AI prompt, PDF).
- **D-1 / D-2:** `drillsHeld` = the counting sessions **minus business meetings**. The **%** keeps meetings. Every "Drills held" count now reads `drillsHeld`: ReportsHub, BoardStats, Attendance Report, Chief's Report, DeptHealthCharts, trend tooltips.
- **D-1:** the member dashboard's "**N scheduled**" = `drillsScheduled`: not cancelled, counts toward the rate, not a meeting, over the full calendar month. It used to count every session, cancelled and leadership-only included.
- **D-3:** `needsRoll` = finalized, not cancelled, no roll taken. The Attendance Report names them ("N finalized drills … need a roll — not counted as held until attendance is recorded").
- **Who is counted (C-1)** stays the caller's: the App passes `countsInStats` through a one-line wrapper. **WS-4c** swaps it for `shared/members.js` in that one place (B-1..B-4: Inactive out, separated out).

**C-2 rename:**
- The email's "Training" tile is now **"Attendance"**. It sat under "Readiness at a glance", which is where 54%-as-"readiness" came from.
- The PDF's "AVG PARTICIPATION" is now **"AVG ATTENDANCE"**.
- The Readiness verdict (RdScorecard) already reads "Your readiness x/y"; unchanged.

**The email (C-1).** `trainingCompliancePct` is now only an **adapter**: DB rows → the app's shapes → `deptAttendance`. So the email gains the **join-date cutoff** (the 51%-vs-54% cause) and the cancelled guard.

⚠ **New read, please look.**
- Join dates in the app come from the `celebrations` **view**, which is `member_private … WHERE department_id = my_department_id()`. The email's service-role caller has no department, so that view returns **nothing**.
- The email therefore reads **`member_private` directly, selecting only `member_id, department_id, joined_date`** (never birthday).
- The read is **tolerant**: on failure the cutoff falls back to the `joined` year (Jan 1). It does not blank the email.
- Also added to the existing reads: `members.joined`, and `training_sessions.is_meeting, status`.

## F-2 — the app adopts `shared/maint-due.js`

- The app's `maintStatus` now calls the shared rule that the email and the daily push already use:
  - **never done = Overdue** (was "Due soon");
  - **due soon = within 14 days** (was the last 20% of the interval);
  - local midnight.
- Display labels are unchanged.
- **Also A-2 for maintenance**, the 4a flag: a task on a **retired rig** is dropped in the app (it showed as "Unknown unit"), the **weekly email** and the **daily push** (`api/pulse.js`). All three join `apparatus(deleted_at)`. A rig-less "All units" task stays.

## F-4 — Equipment "need attention" from open issues

- The chip sub-line and the per-category line now count **units with an open issue**. That is the same rule as the per-unit "Needs attention" pill and `useEquipmentReadiness`, and memory's "flag is derived" rule.
- They used to use condition ≠ Serviceable.
- Issues are read only for managers and DAs (unchanged), so for anyone else the count is **unknown, not 0**, and the line just says "by condition".
- **"Serviceable %" stays condition-based.** That's the manager's inspection grade, labelled "by condition".
- The per-category fallback text "all serviceable" became "nothing flagged".

## Re-baselined, not weakened

`ws4a_quick_test`'s digest fence asserted the exact apparatus select string. 4b widens it with the columns the strict rule needs, so the fence now asserts what 4a cared about: the select still starts `department_id, in_service` and still carries `.is("deleted_at", null)`.

## For the reviewer — flags

1. **The member file has a third "Readiness"**: a ring that is the *mean of cert % and 90-day participation*, titled "Readiness". It isn't in the rulings, so I left it. It collides with the Readiness verdict (x/y). Rename it, e.g. "Cert & attendance"? One word from you.
2. **The Training page's "Completed · this month" filter** is a session *browser* (every completed session, any kind). It isn't a drills metric, so it's unchanged. D-3's "needs roll" lives on the Attendance Report.
3. **Apparatus page "In service" chip** keeps meaning *available* (in service / total). That's the one place the words now mean what they say.
4. **Station-hours "N shifts" still counts voided shifts** (4a flag 1). It's in `shared/station-hours.js`'s rollup, which feeds the credited-hours figures. That is next to the hours-credit meaning, so I've queued it with WS-4d rather than slipping it in here.

## Queued: WS-4d (DB, its own reviewed slice) — see `claude/B4C_WS4d_Queue.md`

- F-3: scorecard hours → credited-only.
- D-2 server half: meetings → standby, not training.
- The voided-shift count.

All three touch the hours-credit meaning.
