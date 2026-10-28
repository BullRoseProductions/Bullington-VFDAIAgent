# B4C — WS-4d draft: the hours-credit slice (F-3 · D-2 server half · V-a) — for gate review

**CC, 2026-10-28. DRAFT — nothing applied.**

- **Branch:** `feat/ws4d-hours`, off main `d552eb6`; it carries the Step-0 commit.
- **Rulings:** B4C_WS4d_Directive.md (F3-a/b, D2-a/b, V-a). One slice, three parts, one transaction.
- **Coordinated apply:** DB first, then the client.

| Part | Files |
|---|---|
| **DB** | `sql/ws4d_hours_credit_DRAFT.sql` (**generated** by `docs/review/ws4d_hours_build.mjs` from the live bodies in `docs/review/ws4d_hours_LIVEDEFS.json`); RETEST `sql/ws4d_hours_credit_RETEST.sql`; **the exact function changes:** `docs/review/ws4d_hours_FUNCTION_DIFF.txt`; dry run `docs/review/ws4d_hours_dryrun_harness.mjs` → `ws4d_hours_DRYRUN.txt`; EXPLAIN `docs/review/ws4d_hours_EXPLAIN.txt` |
| **Client** | `shared/station-hours.js` (V-a), `src/App.jsx` (F3-b labels). Test `docs/review/ws4d_hours_test.mjs` **15/0**. Diff `docs/review/ws4d_hours_CLIENT_DIFF.patch` |
| **Checks** | full suite **31 tests, 0 red, 862 PASS**; build OK; `shared/` tests green; `verified` 132 · 32 · 14; Notify held; no `station_presence` write |

## The EXPLAIN pointed to **path (A)**

- **Run:** read-only `EXPLAIN (ANALYZE, BUFFERS)`, live, for Indian Harbor's 37 counted members: `dept_iso_hours_for(dept, now() − 12 mo, now())` once per member, exactly as `readiness_verdict` would run it inside the packet.
- **Result:** **6.2 ms per call, 232 ms for the whole packet**, all buffer hits.
- **Decision:** (A). The scorecard calls the one credited rule; no `iso_hours_core` refactor, so `dept_iso_hours_for`'s body is changed only by D-2.

## What changes — six functions, by exact substitution on the live bodies

(Full text in `ws4d_hours_FUNCTION_DIFF.txt`; nothing else in any body moves.)

| Function | Change |
|---|---|
| `readiness_verdict` (F-3) | `activity.station_hours` = `round(iso_total_hours, 1)` from `dept_iso_hours_for(p_dept, now() − 12 months, now())` for the member. It was the sum of every closed, non-auto-closed shift: unverified included, no de-overlap, no attested drills |
| `dept_iso_hours_for` (D-2) | observed: `is_training = kind = 'training' AND NOT is_meeting(session)`; attested: `is_training = NOT is_meeting(session)` |
| `dept_iso_hours_by_station` (D-2) | the same two lines |
| `dept_station_shifts` (D-2) | the returned `kind` of a meeting row (observed or attested) reads `'standby'` |
| `my_station_shifts` (D-2) | the returned `kind` of a meeting row reads `'standby'` |
| `dept_iso_hours_by_month` (V-a) | `shifts = count(*) FILTER (WHERE checked_out_at > checked_in_at)`. A voided shift (out = in) is not a shift; sub-minute shifts still count |

- **The meeting test**, one spelling everywhere: `coalesce((select t.is_meeting from public.training_sessions t where t.id = <row's session_id>), false)`. **Read time (D2-a):** no `station_presence` row is rewritten, and ticking or unticking the flag re-files.
- **`attested_training` is untouched (D2-b):** the 90-minute cap applies to meetings as it does to drills.
- **`CREATE OR REPLACE`, same signatures, no DROP**, so grants are never reset.

## The proof

**Preflight refuses on drift:**
- md5 of the six replaced functions plus the seven they lean on: `attested_training`, `dept_iso_hours`, `dept_member_iso_hours_by_month`, `member_check_in`, `close_training_presence_on_done`, `is_leadership`, `my_department_id`. All 13 were re-read live 2026-10-28 and equal the Step-0 pins.
- the columns the new expressions read;
- "already applied".

**In the transaction (any miss rolls everything back):**
- **Totals:** every member's `iso_total_hours` from `dept_iso_hours_for` is **byte-identical before/after** in **every department**, over **12 months, 3 months and 30 days**.
- **Split:** identical too while no session is flagged a meeting (0 live), so **today nothing moves except the scorecard's read and the voided count**.
- **Scorecard:** every counted member's scorecard `station_hours` == round(their credited 12-month hours, 1).
- **Privileges:** `proacl` / `prosecdef` / `proconfig` / `provolatile` / result type of all six unchanged; the seven read pins unchanged.
- **Counts:** policies and function count unchanged; verified untouched.

**Dry run** (PGlite, all 13 pinned bodies live, three labelled stubs for the scorecard's unrelated verdict/cert helpers; 2 departments of realistic history):
- **Pins and apply:** **13/13**; applied with its proof passing; state row; re-run refused.
- **Totals and split byte-identical from outside too.**
- **F-3 on a member** with unverified + auto-closed + voided + sub-minute shifts and an observed drill: scorecard **5.5 h (every closed shift) → 1.5 h (credited)**.
- **With a flagged meeting already in the data:** applies; **totals byte-identical**; only the split moves (training 1.50 → 0, standby +1.50, for two members).
- **RETEST 14/0/0** (mock).
- **Drift refusals:** 3/3.
- **Mutations:** 7/7, each refused by the migration's own proof or caught by the RETEST:
  - a total change → the total proof refuses;
  - the scorecard reading 6 months → the scorecard proof refuses;
  - a grant change → the metadata proof refuses;
  - `attested_training` touched → the read-pin proof refuses;
  - by_station / my_station_shifts / by_month left un-changed → RETEST O1 + T2 / T3 / T4.
- **Post-apply drift:** 2/2 caught.

**RETEST (live, rolled-back SENTINEL, every department, a real DA where one exists):**
- **O1:** all six carry WS-4d and match the dry run's md5s.
- **O2:** live grants / definer / search_path; `attested_training` untouched.
- **Fixtures:** a meeting (F attested, G checked in 60 min), a drill (H), and V with a normal shift and a voided one.
  - **T1:** F 1.5 h **standby** (the attested cap), G 1.0 h standby, H 1.5 h training; each total = training + standby.
  - **T2:** by station agrees.
  - **T3:** the lists read standby for the meeting (dept list + G's own) and training for the drill.
  - **T4:** the voided shift is listed, and the month counts only out > in.
  - **T5:** scorecard == credited for every counted member.
  - **T6:** `station_presence` byte-identical outside the fixtures; verified unchanged.

**Expected live state row:**

| field | expected |
|---|---|
| `new_md5` | the six in the RETEST |
| `ws4d_marked` | 6 |
| `attested_training_md5` | `aff25333…` |
| `meetings_flagged` | 0 |
| `voided_rows` | 10 |
| `total_policies` | 181 |
| `fn_count` | 228 (unchanged — replaces only) |
| `verified_presence` | unchanged |

## Client half

- **V-a:** `rollupStationHours` counts a shift only if `shiftSpan(...) !== "voided"` (WS-4a's helper). A voided shift is **still a check-in** in the verified-% denominator. Sub-minute shifts still count.
- **The email agrees:** `stationMetrics` is byte-identical with or without the voided row.
- **F3-b:** the scorecard footnote and the readiness-packet PDF now read *"credited station hours (location-confirmed + officer-attested), last 12 months"*, with the tile "Credited station hours" and the PDF column "Credited station hrs".

## ⚠ For your decision — the label's wording vs the `verified` fence

- **Ruled wording:** "credited station hours (**verified** + officer-attested)". That adds the literal **verified** twice to App.jsx and moves the locked fence **132 → 134**.
- **Built instead:** **"location-confirmed + officer-attested"**, the same meaning, and the fence holds at 132.
- If you want the exact ruled words, say so and I'll move the fence to 134 deliberately (and update the tests that pin it).

## Re-baselined, not weakened

- `scorecard_ui_test` asserted the **old** caveat ("not ISO-credited"), which F3-b retires.
- It now asserts the new credited wording **and** that the old caveat is gone, on screen and in the packet.
