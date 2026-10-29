# B4C — E1 / E3 (training time + reactions) — STEP 0: investigation + design. NOTHING BUILT, NO SQL RUN EXCEPT ONE READ.

**Branch:** `design/e1e3-step0` off main `1fc6059`.
**Live capture:** `sql/e1e3_STEP0_CAPTURE.sql`, a single read-only SELECT run 2026-10-29 05:14 UTC →
`docs/review/e1e3_STEP0_LIVEDEFS.json`. It holds every function that reads `duration_min` or writes
`training_sessions` / `session_attendance` (full definitions plus md5), both tables' triggers, columns and policies, and
a data profile.

## 0. What's live today (the facts the design rests on)
- **A session already stores its actual length.** `training_sessions.duration_min smallint` is the "FIRST length"
  that `finalize_training_session(p_session_id, p_duration_min)` (md5 `3f31142b`) sets once at finalize.
  - A later change needs **Correct**: `USE_CORRECT` if a different length is passed.
  - The range is 1–1440, and every change is logged in `training_session_audit`.
  - Data: 176 sessions; **34 finalized, 31 with a length, 3 without**; 166 with a scheduled `start_time`. The
    length range is 9..540 minutes.
- **A plan's length is a separate column:** `drill_plans.duration_min`, set by `set_drill_plan(... p_duration_min ...)`.
  - **E1 therefore needs no DB change.** The plan's number is already its own estimate, never read by hours.
- **The hours ledger reads the session's `duration_min`, and nothing else for length.** `attested_training` (INVOKER,
  `aff25333`) credits each present member, for a session that is done, has a length, isn't board and isn't off-site,
  the window **`[date + coalesce(start_time,'00:00')` (America/Chicago)`, + least(90 min, duration_min)]`**.
  - It feeds `dept_iso_hours_for` (`705c9a9b`), `dept_station_shifts` and `dept_iso_hours_by_station`.
  - `drill_window_presence` and `open_signin` also window on `date + start_time` with `duration_min` as the length.
- **The lock guard is a named-column list.** `tg_training_session_lock_guard` (`47918d20`, BEFORE INSERT/UPDATE) lets a
  session that is done, cancelled, or has anyone on the roll change only the columns it doesn't list.
  - `duration_min` is listed, with a one-time exception: it may be set while `OLD.duration_min is null and OLD.done is
    not true`.
  - Correct bypasses the guard via `set_config('b4c.session_correction','on', true)` inside
    `correct_training_session` (`ec6b3c29`). Its `p_changes` accepts a fixed key list that includes `start_time` and
    `duration_min`.
  - **⚑ Any new column NOT added to that list would be raw-writable** on a not-yet-finalized session with attendance.
    RLS `leaders update training_sessions` only requires `done IS NOT TRUE`. So the guard must grow with the columns.
- **Reactions:** nothing exists. `session_attendance` rows are the presence record (423 rows); read is department-wide,
  and writes are training managers only.

## 1. Schema + migration plan
### Slice T (time, DB): `sql/e1e3_session_times_DRAFT.sql` (+ RETEST, ROLLBACK), modelled on `training_start_time.sql` / the is_meeting migration
- **Columns** (all nullable; existing rows untouched):
  - `actual_start time`
  - `actual_end time`
  - `setup_min smallint`

  They're wall-clock times on the session's date, like `start_time`, with no timezone work.
- **CHECKs, which make divergence impossible by construction:**
  - `actual_start` and `actual_end` are both null or both set.
  - `actual_end <> actual_start`.
  - When set, **`duration_min` = the span** in minutes: `(actual_end − actual_start)`, plus 24 h if the end is at or
    before the start, i.e. a session that runs past midnight (7 pm–1 am).
  - `setup_min` is null or between 0 and 600.
  - Existing rows have no actuals, so every CHECK passes on them.
- **`duration_min` stays the one length column the ledger reads.** The actual times *derive* it (DB-enforced). There
  is no second length to drift or double-count.
- **New finalize overload:**
  `finalize_training_session(p_session_id uuid, p_actual_start time, p_actual_end time, p_setup_min integer)`
  (named args; it can't collide with the `(uuid, integer)` length-only one, which is **kept unchanged** as the "I only
  know the length" fallback).
  - It applies the same gates as today: training manager, own department, not done, not cancelled, sign-in closed.
  - It derives the length. If a length already exists and differs, it raises `USE_CORRECT`.
  - It sets `done`, the actuals, the setup time and `duration_min` in **one UPDATE**, and logs the same audit row
    (diff includes the new keys).
  - It follows the **anon EXECUTE pattern:** `REVOKE … FROM anon, public; GRANT … TO authenticated`.
- **Lock guard (`CREATE OR REPLACE`; it's a trigger function, so the ACL is kept):**
  - Add `actual_start`, `actual_end` and `setup_min` to the locked list.
  - They get the same one-time exception as `duration_min` (settable while `OLD.<col> is null and OLD.done is not
    true`), which is exactly the finalize UPDATE.
  - After that, only Correct can change them.
- **`correct_training_session` (`CREATE OR REPLACE`, same signature):**
  - Add `actual_start`, `actual_end` and `setup_min` to the allowed keys, with validation.
  - If the times are set, `duration_min` is **recomputed from them**. A `duration_min` sent alongside that disagrees →
    `BAD_VALUE`.
  - Sending only `duration_min` while times exist → `BAD_VALUE: change the times`.
  - Clearing both times returns the session to a length-only one.
  - Every change goes in the existing diff and audit.
- **Untouched:** `reopen_training_session`, `open_signin`, `drill_window_presence`, `attested_training`,
  `dept_iso_hours_for`, every policy, and `start_time`. The scheduled time stays the scheduled time.
- **Discipline:**
  - One all-or-nothing DO block, generated from a live capture.
  - Preflight pins (refusing on drift): `finalize_training_session` `3f31142b`, `correct_training_session` `ec6b3c29`,
    `tg_training_session_lock_guard` `47918d20`, `attested_training` `aff25333`, `dept_iso_hours_for` `705c9a9b`.
  - It refuses if already applied.
  - **In-transaction proof:**
    - md5 of `attested_training(dept, -infinity, infinity)` and of `dept_iso_hours_for(…)` for **every department**,
      byte-identical before and after. No row has actuals yet, so the ledger must not move.
    - Every other function and policy unchanged; counts; verified unchanged.
  - `NOTIFY pgrst`, a state row, a PGlite dry run with mutations, and a rolled-back SENTINEL RETEST.
  - **RETEST cases:** finalize 19:00–22:26 → `duration_min` 206; 22:00–01:30 → 210; a raw UPDATE of an actual on a
    locked session → `LOCKED_SESSION`; a raw `duration_min` that disagrees with the times → CHECK violation; Correct of
    the times → length recomputed and logged; finalize with times on a session that already has a different length →
    `USE_CORRECT`; the length-only overload still works.

### Slice R (reactions, DB): `sql/e1e3_session_reactions_DRAFT.sql` (+ RETEST, ROLLBACK)
- **Table `training_session_reactions`:**
  - `id uuid pk`
  - `department_id uuid not null`
  - `session_id uuid not null references training_sessions on delete cascade`
  - `member_id uuid not null references members`
  - `value smallint not null check (value in (-1, 1))`
  - `created_at` and `updated_at timestamptz not null default now()`
  - **`unique (session_id, member_id)`**, so it's one vote per present member.
- **RLS on, own-row read only:** the single policy is `SELECT TO authenticated USING (member_id = public.my_member_id())`.
  - There is **no** INSERT, UPDATE or DELETE policy, and no leadership read policy. Nobody, a DA or PA included, can
    read anyone else's row through the API.
  - Grants: revoke all from anon; authenticated gets SELECT only.
- **Write: `set_session_reaction(p_session_id uuid, p_value integer)`** (SECURITY DEFINER, `search_path=public`).
  - Allowed only for the caller's own member row (`my_member_id()`), on a session in `my_department_id()`, that is
    **`done = true` and not cancelled**, where **the caller is present** (a `session_attendance` row for them).
  - It's an upsert `ON CONFLICT (session_id, member_id) DO UPDATE SET value, updated_at`, so a vote can be changed.
  - `p_value` must be -1 or 1. Clearing a vote via null is optional; see decisions.
  - Anon EXECUTE pattern.
- **Read for leadership: `session_reaction_tally(p_session_ids uuid[])`** (SECURITY DEFINER, STABLE,
  `search_path=public`).
  - Gated by `is_leader()`, the department-scoped leadership gate (PA/DA/Board/Officer), and every id must be in
    `my_department_id()`.
  - It returns **`(session_id, up int, down int)` only: counts, never member ids**.
  - It **counts only votes from members still present**. It joins `session_attendance`, so someone later removed from
    the roll via Correct drops out of the tally.
  - It takes an array, so the past-sessions list fetches all its tallies in one call.
- **Proof:**
  - As a real member, a vote reads back their own row and nothing else.
  - As a real DA, a SELECT returns **0** rows of others' votes, while the tally returns counts.
  - Refusals: a vote by a non-present member, on a not-done session, on another department's session, or with a value
    outside ±1.
  - Re-voting changes, not duplicates.
  - The tally excludes votes from removed members.
  - All in a rolled-back SENTINEL with synthetic votes; every other object unchanged.

## 2. The hours pipeline: resolution
- **Recommendation (A): the actual times derive `duration_min`, and the ledger is unchanged.**
  - `attested_training` keeps reading `duration_min` and keeps anchoring at `date + start_time` (scheduled).
  - The DB CHECK makes `duration_min` equal the actual span whenever times exist. That gives **one length, one
    source, no double count**, and every existing credit byte-identical, which the migration proves for every
    department.
  - Credit stays capped at 90 minutes per session, as today. A 3 h 26 m drill still credits 90 minutes; the actual
    window is for the record and the UI.
  - **What A does not do:** move the credited window to the *actual* start. A drill scheduled for 7:00 that ran
    7:20–10:46 is still credited from 7:00. That's identical to today, so nothing diverges. It only matters at the
    edge of a report range, or for the overlap with a station shift that day.
- **(B), offered as a follow-up only:** anchor the credit at `coalesce(actual_start, start_time)`.
  - That changes `attested_training`, a pinned WS-4d function, and moves credited windows for every session finalized
    with times.
  - It deserves its own slice with an hours-diff proof (before and after per member and month). Not proposed for T.
- **`setup_min`: display only, never credited.** Prop and staging time isn't attendance at training. If Ashlea wants
  setup credited, that's a hours-ledger change, so it gets its own slice and proof.

## 3. Reactions: RLS and anonymity
- There's no path from the API to who voted:
  - base RLS shows each member only their own row;
  - writes go only through the RPC;
  - the tally returns counts only;
  - there's no view, and no audit row names voters.
- The service role (backend) can read the table, as with every table. Nothing in `api/` reads it.
- **⚑ The small-count problem** (needs Ashlea's call): with 2 present and "👍 1 · 👎 1", one leader who attended can
  work out the other's vote.
  - Recommendation: show the tally only once **≥ 3 votes** are in ("Not enough responses yet" until then), enforced
    in the tally RPC so the API can't bypass it.
- **Changeable:** a member can change their vote at any time after the session is done. Proposal: they can also clear
  it.
- **Reopened session:** existing votes stay, and new votes are refused until it's finalized again.

## 4. UI plan
### Slice U1 (E1 + E3), client only, after T is live
- **E1:**
  - The plan builder's "Duration" becomes **"Estimated length"**.
  - The plan editor's "Duration (minutes)" becomes **"Estimated length (minutes)"**.
  - Plan meta reads "est. 2 hrs". Still editable.
- **Finalize screen** (the three "Length (min, optional)" boxes, ~App.jsx 25846 / 26026 / 26049):
  - **Start** and **End** time inputs (Start pre-filled from the scheduled time) with a live **"7:00–10:26 PM ·
    3h 26m"** preview. A past-midnight end shows "(next day)".
  - Plus **Setup (min, optional)**.
  - "I only know the length" falls back to the existing minutes box and the length-only overload.
- **Past session:** **Planned ~2 hrs (estimate) · Actual 7:00–10:26 PM · 3h 26m · Setup 20 min**, side by side. The
  planned figure comes from the attached plan.
- **Correct form:** the new fields join `S6_FIELDS`, with labels in the diff/audit display.

### Slice U2 (E3c), client only, after R is live
- **On a finalized session**, a present member sees 👍 / 👎, with their own vote highlighted and changeable.
  - Optional: a "How was Tuesday's training?" dashboard card for sessions from the last 7 days.
- **Leadership** sees "👍 7 · 👎 1" on past sessions, or "Not enough responses yet". It never shows names.

## 5. Slice split (each a separate reviewable chunk)
| # | slice | kind | depends on |
|---|---|---|---|
| T | session times (columns + CHECKs, finalize overload, lock guard, correct keys) | DB | — |
| R | reactions (table, RLS, `set_session_reaction`, `session_reaction_tally`) | DB | — (independent of T) |
| U1 | E1 relabel + finalize start/end/setup + side-by-side | client | T live |
| U2 | 👍/👎 + leadership tally | client | R live |

**Invariants for every slice:**
- verified untouched;
- pinned-md5 single all-or-nothing DO block;
- PGlite dry run + rolled-back SENTINEL RETEST;
- `NOTIFY pgrst`, state row;
- new SECURITY DEFINER functions REVOKE anon/public;
- no production SQL run by me; I draft, Ashlea or the gate applies.

## 6. Decisions needed (Ashlea / gate)
1. **Hours anchoring:** (A) recommended, ledger unchanged; (B) later, as its own slice.
2. **`setup_min`:** display only (recommended), or credited?
3. **Finalize:** start + end **required**, or optional with the length-only fallback? Recommended: optional, so an
   officer who didn't note the times can still finalize.
4. **Reactions:** the ≥ 3 threshold (recommended), and whether a vote can be cleared.
5. **Who sees the tally:** `is_leader()` (PA/DA/Board/Officer, recommended), or training managers only?
6. **Reaction window:** open indefinitely after finalize, or close after N days?
