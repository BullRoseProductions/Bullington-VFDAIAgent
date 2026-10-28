# B4C — WS-4d Step 0: the hours-credit slice (F-3 · D-2 server half · voided out of "N shifts")

**CC, 2026-10-27. READ-ONLY — no SQL drafted, nothing applied.** For Claude's review and Ashlea's rulings (§5). Queued in [[B4C_WS4d_Queue]].

**Source:**
- the **live** definitions of all 35 public functions whose bodies mention `station_presence`, `attested_training`, `station_hours` or `iso_hours`: read-only, md5s pinned in `docs/review/ws4d_LIVEDEFS.json`;
- main @ `f854a82` (industrial-noir-39) for the client.

**Live counts, 2026-10-27:**

| | |
|---|---|
| `station_presence` kinds | standby 1,116 · training 39 |
| sessions flagged `is_meeting` | **0** (0 done-and-timed, 0 meeting check-in rows) |
| voided shifts (out = in) | **10**, all in the last 12 months |
| sub-minute shifts | 57 |
| scorecard hours, last 12 mo (every closed, non-auto-closed shift) | **4,716.2 h**, of which **673 h unverified** |
| callers of `readiness_verdict` | `dept_readiness_packet`, `member_scorecard` |
| verified | 965 (organic) |

**None of the 35 functions reads `is_meeting`.**

---

## 1 · F-3 — scorecard "station hours" = credited only

**Today.** `readiness_verdict(p_dept, p_member)` (`e72e2042…`) → `activity.station_hours`:
```sql
sum(checked_out_at − checked_in_at) over station_presence
 where member/dept, checked_out_at is not null, not auto_closed, checked_in_at ≥ now() − 12 months
```
That is **every** closed shift:
- **unverified included** (673 h across all departments in 12 months);
- **no de-overlap** (a drill inside a standby shift counts twice);
- **no officer-attested drill time**;
- `kind` unfiltered.

**The credited rule everywhere else** is `dept_iso_hours_for(p_dept, from, to)` (`91ceb031…`). It counts:
- verified, closed, not auto-closed shifts of kind standby/training;
- **plus** `attested_training()` (not optional, ≤ 90 min, observed wins);
- `range_agg` de-overlapped per member.

The Station Hours screen, the email (`dept_iso_hours_for`) and the reports all read that rule.

**Proposal:** `activity.station_hours` = the member's `iso_total_hours` from the credited rule, over the same 12-month window. Two ways to get it — **ruling F3-a**:
- **(A) Call `dept_iso_hours_for(p_dept, now() − 12 mo, now())` and pick the member.**
  - One rule, zero new copies.
  - **Cost:** `dept_readiness_packet` calls `readiness_verdict` once per counted member, so the packet would compute the whole department's credited hours N times (Indian Harbor: 40×).
  - I'd EXPLAIN ANALYZE it live (read-only) before choosing.
- **(B) Refactor the credited rule into one internal core with an optional member filter**, `iso_hours_core(p_dept, p_member, from, to)`. `dept_iso_hours_for` becomes a one-line call to it with `p_member := null`, and the scorecard calls it with the member.
  - Still one rule, and O(1) per member.
  - But it rewrites the body of the most-audited function. The slice would have to prove `dept_iso_hours_for`'s output **byte-identical** before/after for every department and several windows.
- **My recommendation: (A)**, unless EXPLAIN shows the packet goes slow. Then (B) with the byte-identical proof.

**The client half (needed either way).** The scorecard says so in words today: `App.jsx` scorecard PDF, *"Information only — activity does not change readiness. Station hours are closed station shifts as logged (auto-closed shifts excluded), not ISO-credited hours."*, plus the on-screen activity line. Both become *"credited station hours (verified + officer-attested), last 12 months"*. It ships with the slice (coordinated: DB first, then client).

**What moves:** every member's scorecard "station hours" drops to the credited figure. Across all departments that is ≈ 673 h of unverified time out, plus or minus de-overlap and attested drills. It's information-only on the scorecard (it never changes the verdict), but it **is** the number on the ISO/audit packet. This is the point of F-3.

## 2 · D-2 server half — business meetings credit STANDBY, not TRAINING

**Today (unchanged from my 4a finding, re-read live):**
- **Attested:** `attested_training()` (`aff25333…`, not definer) takes done, timed, non-board, non-off-site sessions and returns `session_id`; every reader treats its rows as **training**.
- **Observed:** a QR check-in writes `station_presence(kind = 'training', session_id)` (`member_check_in` `8151098e…`), closed by the `close_training_presence_on_done` trigger. Training by `kind`.
- **The split is decided in four readers:**
  - `dept_iso_hours_for` (`is_training = kind = 'training'` / attested ⇒ true);
  - `dept_iso_hours_by_station` (`5a895ed7…`, same);
  - `dept_station_shifts` (`894bbaa8…`, returns `kind`; attested rows hard-code `'training'`);
  - `my_station_shifts` (`ee7077f8…`, returns `kind`).
  - `dept_iso_hours` / `_by_month` / `dept_member_iso_hours_by_month` only wrap them.

**Proposal — classify at READ time, by the session's flag.** In the four readers, a row is training only if:
```sql
kind = 'training' AND NOT coalesce(t.is_meeting, false)
```
where `t` is the row's `session_id` session (attested rows carry `session_id` too). Otherwise it's standby. The returned `kind` of a meeting row reads `'standby'`, so the Station Hours lists and the client rollup agree without a client change.
- `CREATE OR REPLACE` with the **same signatures**: no DROP, so no grant reset (memory: anon-execute-revoke-pattern). `attested_training` is untouched.
- **Rows are never rewritten.** `station_presence.kind` stays what the check-in wrote.
- **Totals don't move:** `range_agg` de-overlaps the union either way, so a member's `iso_total_hours` is identical. Only the training/standby split moves. The slice proves this (total byte-identical, split moved) on a fixture meeting in every department, rolled back.

**What moves today: nothing.** 0 sessions are flagged.

**Rulings:**
- **D2-a, read-time vs as-of.** Read-time means ticking or unticking "This is a meeting" on a past session re-files its hours retroactively, both ways. The alternative is write-time: the check-in writes `kind = 'standby'` for a meeting; `attested_training` gets a kind column (that one is a DROP+CREATE, which resets grants). It freezes history, but then the flag and the hours can disagree. **Recommend read-time**: one source of truth, reversible, no history rewrite.
- **D2-b, the 90-minute cap.** The attested 90-minute cap applies to meetings too: a 2-hour meeting credits 1.5 h standby to attested attendees, 2 h to members who checked in. That matches today's drills. Keep?

## 3 · Voided shifts out of "N shifts"

**Today.** A voided shift (`void_auto_closed_shift` sets out = in; there are 10 live) is a real row with 0 hours. It's counted as a shift in **two** places:
- **server:** `dept_iso_hours_by_month` (`c9cef038…`), `shifts = count(*) from dept_station_shifts(...)`. Feeds the monthly bars / tooltips.
- **client:** `shared/station-hours.js` `rollupStationHours`, `m.n += 1` for every row. Feeds "N shifts" on Station Hours, ReportsHub "Station shifts", Chief's Report "N records", the Agenda.

The email prints no shift count.

**Proposal:**
- Keep the rows (WS-4a G-1 shows them as "Voided" in the lists; G-2 keeps sub-minute rows, 57, as true records).
- **Leave them out of the shift count** in both places:
  - server: `count(*) filter (where checked_out_at > checked_in_at)`;
  - client: `m.n` skips `shiftSpan(...) === "voided"` (`shared/shift-span.js`, the 4a helper).
- Hours are unchanged (they're 0).
- **Ruling V-a:** does a voided shift still count as a **check-in** in the verified-% denominator? It *was* a real punch with a guessed stop time. **Recommend yes** (keep `checkins`), out of `shifts` only.

## 4 · How I'd slice and prove it

**One DB slice, three parts, one transaction.** All three touch the hours-credit meaning, so one review.

**The pins:**
- every function it replaces, by md5:
  - `readiness_verdict` (+ `dept_iso_hours_for` if F3-b);
  - `dept_iso_hours_for`, `dept_iso_hours_by_station`, `dept_station_shifts`, `my_station_shifts`;
  - `dept_iso_hours_by_month`;
- every function it reads, by md5: `attested_training`, `dept_iso_hours`, `member_check_in`, the close-on-done trigger.
- Preflight refuses on drift.

**The post-conditions (in-transaction):**
- grants and `prosecdef` unchanged on every replaced function;
- `iso_total_hours` per member **byte-identical** before/after for every department over the last 12 months (D-2 can't move totals; 0 meetings today means the split can't move either);
- verified untouched.

**Dry run:** PGlite with the live bodies (`ws4d_LIVEDEFS.json`).

**RETEST, rolled-back SENTINEL, every department:**
- a fixture meeting with a check-in plus an attested attendee → its hours file as standby; the total is unchanged; the drill next to it stays training;
- a voided shift is listed but not counted in `_by_month` shifts;
- the scorecard station_hours equals the member's `dept_iso_hours_for` total;
- `station_presence` byte-identical.

**Client half (rides the same coordinated apply):**
- the two scorecard labels;
- `rollupStationHours` `n` skips voided, with `shared/digest.station-hours.test.mjs` extended so the screen and the email still agree.
- A helper-pin test, as every WS-4 slice.

## 5 · Rulings needed

| # | Question | CC rec |
|---|---|---|
| F3-a | Scorecard credited hours: (A) call `dept_iso_hours_for` per member, or (B) refactor into a member-filterable core | **A**, after a read-only EXPLAIN; B only if the packet is slow (and then with a byte-identical proof) |
| F3-b | Label: "credited station hours (verified + officer-attested), last 12 months" on the scorecard + PDF | Yes |
| D2-a | Meetings → standby at **read time** (retroactive with the flag) or **write time** (as-of) | **Read time** |
| D2-b | The attested 90-minute cap applies to meetings as it does to drills | Yes |
| V-a | A voided shift: out of "N shifts", still a check-in in the verified-% denominator | Yes / yes |
| — | One slice for all three | Yes; all three are the hours-credit meaning |

**Out of scope, noticed in passing:**
- `shared/maint-due.js` reads the date prefix of a UTC `last_done_at`, so a task logged after ~7 pm Central counts as done the next day (the email, and the app since 4b). A client/shared fix, not this slice.
- `pa_department_radar` (`eb835b33…`) reads `station_presence` for its own activity figures. Not in WS-4's list; flagged for whoever owns the radar.
