# B4C: Test accounts → skip list (DRAFT, NOT deployed)

**Ruling (Ashlea, 2026-11-02):** the test accounts STAY. They are her windows into the pilot stations. They are skip-listed, not deleted, and their existing attendance and hours rows stay as history.

**Branch:** `fix/test-accounts-skiplist`, off main `3c28f86`.
**Changed:** `shared/members.js` (the list), `docs/review/ws4c_members_test.mjs` (the fixture), and this note.

## The change
`STATS_EXCLUDED_IDS` in `shared/members.js` is the one list, imported by `src/App.jsx` and `api/digest.js`.

| Id | Account | Department | Change |
|---|---|---|---|
| `0ad3dc98…` | the owner | — | unchanged |
| `fc4a1a0f…` | "Demo Account" | North Hood County | **already on the list** (unchanged) |
| `6c926026…` | "Test" | North Hood County | **added** |
| `045f4d7a…` | "Test Five" (Department Admin) | Granbury | **added** |
| `1daddf8e…` | "Test Admin" | Lipan | **added** |
| `02c4a728…` | the old "test account" | — | **removed** (no member row) |

The ids come from the read-only live inventory of 2026-11-01. `ws4c_members_test` (33/33) now pins:
- all three test accounts are out of the count and the list, whatever their status or role;
- the list is exactly those five ids;
- the stale id is gone;
- no id appears in `App.jsx` or `digest.js`.

## ⚑ Side effect to accept: skip-listed means unlisted too, not only uncounted
The list is read through `isListedMember`, and that predicate does **more than counting**. After this lands, the four accounts disappear from:
- **the Roster screen** (its list and its "of Y"). A Granbury DA can't open "Test Five" from Roster any more. Ashlea still reaches every account through the PA Department view, which uses its own server read (`pa_department_members`).
- **every assignee picker:** duties, tasks, equipment issue and handoff targets, mentors, supervisors, equipment managers, training officers, the maintenance "done by" picker, and so on. You can't assign work or issue gear **to** a test account from a real account.
- **birthdays / anniversaries** (celebrations), and the client-side cert and expiry figures.

**What still works, checked:**
- **Signing in as a test account:** the accounts are untouched; nothing reads the list at sign-in.
- **The account's own screens:** its own attendance, hours, certs and My Equipment use the member's own rows.
- **The equipment return:** "Mark returned" on the holder's My Equipment, then the managers' **Pending returns** queue, which is a direct `equipment_custody` read with no list filter, then **Confirm return**.
- **The test account's own pickers:** one small effect. The maintenance log's "done by" defaults to "someone else" rather than to the signed-in test account.

## Which counts honour the list, and which still don't
**Honour it** (through `isListedMember` / `isCountedMember` / `headcount()`):
- **The weekly digest:** recipients, the duty and hours people lists and their totals (credits are list-filtered), and the attendance %.
- **The shared headcount:**
  - the Members hero and Roster chip;
  - Board stats segments;
  - the dashboard's member total;
  - cert coverage;
  - the expired-cert figure;
  - the Reports headcount.
- **Attendance per member:**
  - `deptAttendance` (its rows and the department average % are over counted members only);
  - the "attendance gaps" insight;
  - Board accountability.
- **Lists:** Roster, pickers, celebrations.

**Do NOT honour it** (they read raw rows, so a test account's existing check-ins and shifts still count). This is what remains polluted:
1. **Session-level present counts:**
   - "N present" on session rows;
   - Reports' average per session;
   - the last-8 attendance chart (Reports and the dashboard);
   - the dashboard's last-session ring.

   Each counts `session.attendance.length`. ⚑ The ring and the dashboard "ready" % divide that raw count by the skip-listed headcount, so a test check-in now slightly over-states them, e.g. 6 present of 5 counted.
2. **The Station Hours report** (`StationHoursReport`: `dept_station_shifts` + `dept_iso_hours`) and the monthly credited-hours tiles. Department totals include the test accounts' shifts.
3. **Every server-side people count.** The database has no copy of this list:
   - `pa_department_radar`;
   - `dept_on_station_now(_all)`, `dept_open_shifts`;
   - `dept_qualification_matrix`, `dept_expirations`;
   - `dept_readiness_packet`, `dept_read_sign_compliance`, `dept_probation_board`;
   - the ISO/LOSAP figures (`dept_iso_hours*`).

   Their exports (ISO/LOSAP PDFs) therefore still carry test-account hours.

Closing 1 and 2 is a client slice: filter `attendance` ids and shift rows through `isListedMember` before counting, behind the same list. Closing 3 needs the list in the database, for example an `excluded_from_stats` flag on `members` that the RPCs read. That is a DB slice and a ruling on where the list lives. **Neither is in this slice.**

## Not code (the revised runbook, `docs/test-data-cleanup`)
- **Equipment** comes home through the app. Ashlea signs in as the North Hood "Test" account, marks the item returned, and a North Hood manager confirms. No SQL.
- **"Test Five" stays a Department Admin:** Ashlea's accepted risk, recorded there.
- **The "Test" pumper** is taken out of the fleet in-app (reversible). Apparatus counts can't be skip-listed.
- **Chaplin → Chaplain** through the app's member and Your Six editors; Indian Harbor's SOP text is untouched.
- **The test accounts' attendance and hours rows stay put.**
