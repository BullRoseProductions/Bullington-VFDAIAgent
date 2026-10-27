# B4C — WS-4a draft: the quick client slice (for gate review)

**CC, 2026-10-27. DRAFT — not merged, nothing applied.**

- **Branch:** `feat/ws4a-quick`, off main `dfd9866`.
- **Rulings:** [[B4C_WS4_Metrics_Step0]] §9, as ruled by Ashlea: G-1, G-2, H-1 (high bar), and A-2 for the email.
- **Runtime:** `src/App.jsx`, `api/digest.js`, `shared/shift-span.js` (new). No DB change.
- **Review files:**
  - diff: `docs/review/ws4a_quick_DIFF.patch`
  - test: `docs/review/ws4a_quick_test.mjs`, **31/0**, output in `docs/review/ws4a_quick_TEST_OUTPUT.txt`
  - full suite: 27 tests, 0 red, 720 PASS
  - build: OK
  - `shared/` differential tests: green

## What changed

| Ruling | Change | Where |
|---|---|---|
| **G-1 · Voided** | A voided shift now reads **"Voided"**, its times struck through, instead of "0.0 h (11:47 PM – 11:47 PM)". Marker: `checked_out_at = checked_in_at`, the zero-length record `void_auto_closed_shift` writes. There is no void flag. | `shared/shift-span.js` → `shiftSpan` / `shiftHoursText`, used at all four shift-row sites: StationHoursReport day detail + shift log; StationHours recent + full list |
| **G-2 · < 1 min** | A real check-out under a minute stays visible and reads **"< 1 min"**, not "0.0 h". | same helper |
| **G · client end > start** | **closeOpenShift** and **confirmOut** refuse out ≤ in, or out > now, **inline** ("Out-time outside the shift"), before any RPC. This is checkOut's existing rule and the window the server enforces. | StationHoursReport |
| **H-1 · Cert leader** | The spotlight is renamed **"✦ CERT LEADER" / "Highest cert compliance"**. It highlights only at **≥ 75%** current; below that it reads "No one at 75%+ yet". | RosterMembers |
| **H · Showing up strong** | Requires **pct > 0** and **never lists anyone on "Needs a nudge"**. Empty state: "No one's turnout stands out yet." | RosterAttendance |
| **A-2 · email** | The digest's apparatus read gains `.is("deleted_at", null)`, the App's own filter. A retired rig (soft-deleted, still `in_service=true`) no longer counts in the email's "Apparatus x/y". | `api/digest.js` |

**Helper pin (the slice's fence).** The test asserts:
- App.jsx imports `shiftSpan` + `shiftHoursText` from `../shared/shift-span.js`;
- each of the four listed sites prints hours through `shiftHoursText`;
- no shift row still prints raw `h1(…hours)`.

**Invariants:**
- the `verified` literal counts are unchanged (App.jsx 132 · digest.js 32 · assistant.js 14);
- no `station_presence` reference added;
- Notify held.

## Deliberately NOT in 4a (flags for the reviewer)

1. **Voided shifts still count in "N shifts".** Counts come from `shared/station-hours.js` (`totals.shifts`), which also feeds the email and the reports. Dropping zero-length rows there touches the hours rollup, so it belongs with 4b's shared helpers, not a quick slice. 4a is display-only; hours are untouched.
2. **approveOffsite's optional out-time correction** shares the queue's out-time input but isn't one of the two ruled close forms. The server still validates it. I left it alone; say the word and it gets the same inline check.
3. **Retired rigs' maintenance tasks.** `retire_apparatus` is a soft delete, so its `apparatus_maintenance` rows survive. The email (`detectMaintenance`) and the app (as "Unknown unit") both still list them. They agree with each other, so this is not a 4a divergence. It fits F-2 (4b, the app adopting `shared/maint-due.js`): filter both on the rig's `deleted_at`.

## ⚠ The meetings check (D-2), done before building, as asked

**Today a meeting earns TRAINING hours, not standby.** Read from the live definitions on 2026-10-27:
- `dept_iso_hours_for` / `dept_iso_hours` credit session time through `attested_training()`, as `is_training = true`.
- `attested_training()` takes any **done**, **timed** (`duration_min` set) session. It excludes only **board**-audience, **off-site** and **optional** sessions, and caps each at 90 minutes.
- **It never reads `is_meeting`.**
- A member who QR/geofence-checks into the session gets a `station_presence` row with `kind = 'training'`. That observed row wins over the attestation, and it is training too.
- `is_meeting` today affects only the minutes guard (`guard_ai_outputs_session_id`).

**So "meetings count as standby, not training" is a behavior change, not a consistency fix.** It reclassifies credited hours between the two buckets: the ISO **total** is unchanged and the training/standby **split** moves. It needs:
- a DB change to `attested_training()`, or to its callers' `is_training`, keyed on `is_meeting`;
- the same for `kind='training'` check-in rows tied to a meeting session.

Both are credited-hours functions, so this wants its own reviewed DB slice, like F-3. It is not part of 4b's client work.

**Live today: 0 sessions are flagged `is_meeting`**, so no current number would move. The question is the rule going forward.

The client-side half of D-2 is pure 4b: meetings stay in attendance % and come out of "drills held / this month". It doesn't touch hours.
