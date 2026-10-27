# B4C — WS-4d queue: the hours-credit slice (DB, its own review)

**CC, 2026-10-27. QUEUED — not drafted, nothing applied.**

Claude's instruction: queue the meetings-as-standby DB slice (the D-2 server half) alongside F-3, as its own reviewed slice, since both touch the hours-credit meaning. Each item gets a Step 0 against the **live** definitions before any SQL; see [[migrations-applied-by-hand]].

## 1 · F-3 — scorecard station hours = credited only

- **Today:** `readiness_verdict` / the scorecard's `station_hours` (`sql/scorecard_2026-10-19.sql:219–222`) sums **every closed shift** in 12 months, including uncredited ones and auto-closed shifts.
- The app and the email credit only location-checked / officer-attested time, through `dept_iso_hours` + `shared/station-hours.js`.
- **Change:** the scorecard reads the same credited figure. Prefer calling the existing credited-hours function over re-deriving the filter.
- **Proof needed:**
  - the live scorecard before/after per member on one department, rolled back;
  - the `verified` literal counts unchanged;
  - no `station_presence` write.

## 2 · D-2 server half — business meetings credit STANDBY, not TRAINING

- **Ashlea's ruling:** "meetings count as standby hours but not training hours."
- **Today (read live, 2026-10-27):**
  - `attested_training()` credits any done, timed session as **training** (`is_training = true` in `dept_iso_hours_for` / `dept_iso_hours`). It excludes only board-audience, off-site and optional sessions, and **never reads `is_meeting`**.
  - A check-in to the session lands as `station_presence.kind = 'training'`, also training.
- **So this is a reclassification, not a consistency fix:**
  - the ISO **total** is unchanged;
  - the **training / standby split** moves for any flagged meeting.
  - Live today: **0 sessions are flagged `is_meeting`**, so no current number moves.
- **Scope to decide in the Step 0:**
  - (a) `attested_training` emits meeting rows with a kind that `dept_iso_hours_for` sums as standby. It needs a column, or a sibling function, so the existing `optional` contract isn't overloaded.
  - (b) For OBSERVED check-ins to a meeting (`kind='training'` rows with that `session_id`): either the readers classify by the session's `is_meeting` at read time (no row rewrite), or the check-in path writes `kind='standby'` for meetings going forward. Read-time is preferred: no history rewrite, and un-ticking "This is a meeting" reverses it cleanly.
  - Every reader of `is_training` / `kind` must agree: `dept_iso_hours(_for)`, `dept_iso_hours_by_month`, `dept_member_iso_hours_by_month`, `dept_station_shifts`, `my_station_shifts`, `shared/station-hours.js` and the scorecard. The Step 0 inventories them live.
- **Proof needed:**
  - a flagged meeting moves from training to standby with the per-member total unchanged;
  - an unflagged drill doesn't move;
  - the RETEST runs in every department, rolled back.

## 3 · Voided shifts out of "N shifts" (from 4a flag 1)

- `shared/station-hours.js` `totals.shifts` counts a voided (zero-length) shift. It feeds the reports' "N shifts / records" and the email.
- This is a client/shared change, not DB. It's queued here because it sits in the credited-hours rollup and wants the same review lens.
- **Proof needed:** `shared/digest.station-hours.test.mjs` extended so the email and the screen still agree.
