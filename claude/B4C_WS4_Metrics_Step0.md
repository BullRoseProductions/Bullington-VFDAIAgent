# B4C — WS-4 Step 0: make the numbers agree

**CC, 2026-10-27. READ-ONLY — no code.** For Claude's review and **Ashlea's rulings on the definitions** (section 7). The build is then sliced per metric.

- **Directive:** [[B4C_ReviewFixes_Wave1_Directives]] (WS-4).
- **Source:** main @ `99a15b0`: `src/App.jsx`, `api/digest.js` / `pulse.js`, `shared/`, `sql/`. Line numbers are main's.
- An inventory pass was cross-checked by CC at the load-bearing sites: `countsInStats` `:3228`, the Roster spotlight `:11477–11486`, `useApparatusReadiness` `:14366–14396`, the digest apparatus read `digest.js:644`, and `void_auto_closed_shift` `sql/early_catch_open_shifts_2026-09-09.sql:371`.

## 1. Why the numbers disagree (three root causes)

1. **No shared definition of "a counted member".** Five populations are in use:
   - **all statuses**: `countsInStats`, the default everywhere;
   - Active + Probationary;
   - **Active only**;
   - the server's readiness/probation functions: Active + Probationary, not PA, **not separated**;
   - **raw `members`**.

   **The client can't see `member_separation`**, so a separated member still counts on every client screen.
2. **Attendance % is computed three ways under the word "readiness".**
   - The app's `deptAttendance` applies a join-date cutoff and includes Inactive members.
   - The weekly email's copy (`digest.js:292–308`) has **no join-date cutoff**.
   - The Readiness page's **"3/3" isn't attendance at all**: it's requirements satisfied.
3. **Apparatus "ready" has two definitions and two scopes.**
   - Dashboards and reports: ready = in service + `Pass`, **including never-checked rigs**, department-wide.
   - Apparatus page: "Ready to roll" = Pass **and checked**, scoped to the **active station**.
   - The digest counts **retired (deleted) rigs**.

**There is no `shared/` helper for any of these.** The precedents to copy are `shared/station-hours.js` (hours) and `shared/maint-due.js`. Note that the app **doesn't use** `maint-due.js`, so even that one has drifted (F-2 below).

---

## 2. Metric A — Apparatus ready / in service / out of service / never checked

| Site | Definition today | Scope |
|---|---|---|
| `useApparatusReadiness` `App.jsx:14366–14396`, used by the dashboard bar (`:27916–27940`), BoardStats (`:13691`, `:13725`), ReportsHub "Apparatus ready x/y" (`:13554`, `:13595`), RosterReports + AI prompt (`:13089`, `:13268`, `:13400`), the Agenda drafter (`:20705`, `:20740`, `:20831`) | `inService = in_service !== false`; **ready = inService ∧ status='Pass'** (never-checked included); flagged = inService ∧ ¬Pass; oos = ¬inService; total = all | department, `deleted_at is null` |
| Apparatus page `:16564–16597`, `:16831–16851` | Chips: "In service" = inService/all; **"Ready to roll" = Pass ∧ `last_check_at` set**, with never-checked split out; "Needs attention" = flagged (overdue checks shown only as a sub-line) | **active station only** (`:16570`) |
| Rig card label `:16662`, `:16700–16703` | OOS → "Out of service"; else Pass → **"In service"** (the word means *Pass* here, *availability* on the chip); else "Needs attention" | — |
| Weekly email `digest.js:644`, `:760–763`, `:482` | `in_service` count / total, **no `deleted_at` filter**: a retired rig keeps `in_service=true` and still counts | department |
| PA radar `sql/pa_department_radar_profile_missing.sql:62` | `apparatus_count`, no `deleted_at` filter | department |
| "Never checked" | Apparatus page: `!last_check_at` (`:16676`, `:16836`); ApparatusChecksReport: no finalized `apparatus_checks` row (`:13944`, `:14157`); the dashboards and email don't count it | — |

- **The "OOS counted as in service" report:** no client path counts `in_service=false` as in service. The plausible sources are:
  1. the card label "In service" meaning *Pass*;
  2. the email counting retired rigs (still `in_service=true`);
  3. station vs department scope.
- **Also:** adding a rig as "Ready" writes `status:'Pass'` with no check on file (`:16617`), so a brand-new rig is "ready" on the dashboard. `resolve_apparatus_failure` sets Pass without looking at `in_service`.

**Proposal: `shared/apparatus-status.js` → `rigStatus(rig, { now })`, returning one of `retired | out_of_service | needs_attention | never_checked | ready`:**
- `retired` = `deleted_at` set. It's excluded from **every** count and denominator.
- `out_of_service` = `in_service = false`.
- `ready` = in service ∧ `status='Pass'` ∧ `last_check_at` set (and not overdue? — **A-3**).
- `never_checked` = in service ∧ `last_check_at` null.
- `needs_attention` = everything else in service (failed, open failure, or overdue per A-3).

Every screen and the email then show the same buckets, over one denominator (all non-retired rigs), and the card label stops saying "In service" for *Pass*.

## 3. Metric B — Member count (30 / 29 / 28)

| Site | Population |
|---|---|
| Dashboard Members tile `DeptHealthCharts` `:28339–28344`, `:28366`; `RosterBreakdown` `:28257`; BoardStats hero `:13656`, `:13781`; Attendance Report `:15704`; last-drill turnout ring denominator `:25043–25046` | `countsInStats`: **every status, Inactive included** (excludes 3 hard-coded ids + Project Admins) |
| Roster chip "Members" `:11457`, `:11555` | every status; the sub-line lists only Active + Probationary |
| Roster "Showing N of Y" `:11468`, `:11623` | N hides Inactive by default; Y includes them |
| Cert-coverage tiles (`certCoverage(…, {includeProbationary:true})` `:11109–11111`) | Active + Probationary |
| Readiness packet `dept_readiness_packet` (`sql/scorecard_2026-10-19.sql:341–345`) | Active + Probationary, not PA, **not separated**; the demo account **is** counted (the server has no id list) |
| RosterAttendance "recent events" denominator `:12867`, `:12879` | **Active only**: Probationary excluded from the denominator while their check-ins still count as present |
| RosterAttendance expected/heatmap `:12833`, `:12840` | raw `members`, not Inactive; **PA and the owner not excluded** |
| PA radar `member_count` (radar sql `:58–59`) | every status, not PA; owner/test counted |
| Weekly email (`digest.js:76–81`, a **copy** of `countsInStats`) | every status |

- **30 / 29 / 28** = all statuses / one of the mixed rows / Active + Probationary (or the packet's not-separated count).
- The client loads the roster from `members_view`, which doesn't carry separation (`sql/membership_window_2026-10-16.sql:25`, `:254`).

**Proposal: `shared/members.js` → `isCountedMember(m)` and `headcount(members)`:**
- **counted** = not a Project Admin ∧ not a test/owner id ∧ status ∈ {Active, Probationary} ∧ not separated;
- Inactive is shown separately ("+ 2 inactive"), never inside the headcount;
- the test-id list moves into `shared/` so the email and the client stop carrying two copies.
- **Separation needs a DB touch** (B-4): `members_view` gains a `separated` boolean (or an `is_counted` computed column), so the client can apply the same rule the server already uses.

## 4. Metric C — Training "readiness" % (54% vs 3/3 vs 51%)

| Site | Definition |
|---|---|
| `deptAttendance` `App.jsx:3247–3263`, used by DeptHealthCharts (year form `:28329`), ReportsHub `:13535`, BoardStats `:13666`, RosterReports `:13067`, the Attendance Report `:15630`, the trend series `:27753`, the roster 90-day/quarter views `:12826`/`:12830`, the member file `:11703` | mean of **per-member %**. Sessions: done ∧ roll taken ∧ `countsTowardRate` (not leadership/board, not optional); **no cancelled guard**; `is_meeting` business meetings count (deliberate, `:19980–19983`). Members: `countsInStats` (**Inactive included**) with the **join-date cutoff**. `avg` returns **0** when nobody is rated |
| Weekly email `trainingCompliancePct` `digest.js:292–308` | same session filter, **no join-date cutoff** (each member's denominator is every eligible session of the year); every status. **The likely 51% vs the app's 54%.** |
| Personal `memberAttendance` `:27735–27742` (MemberDashboard ring + trend `:4982–4986`) | as above, plus leaders count restricted events they're eligible for |
| Readiness page **"3/3"** `RdScorecard :21315` ← `readiness_verdict()` (`sql/scorecard_2026-10-19.sql:196–232`) | **requirements satisfied / required** (certs, qualifications, documents). Not attendance. Its `activity.trainings` counts any attended session in 12 months, including board/optional/meetings |

**Proposal: `shared/attendance.js` → `deptAttendance(sessions, members, range)` + `memberAttendance(…)`.**
- These are moved out of App.jsx **verbatim**, then imported by both the client and `digest.js`. The email gets the join-date cutoff and the counted-member rule for free.
- Rule: per-member % over **counted members** (B); sessions done ∧ roll taken ∧ countsTowardRate ∧ **not cancelled**; join-date cutoff.
- **Show "—", not 0%, when nobody is rated.**
- **Rename so the two concepts stop colliding:** "Attendance %" (this) vs "Readiness x/y" (the requirements verdict).

## 5. Metric D — "Drills this month"

| Site | Definition |
|---|---|
| MemberDashboard `trainingsThisMonth` `:4987` (label "N scheduled" `:5056`) | **every** session in the calendar month, including **cancelled**, not-done, leadership/board, meetings |
| MemberDashboard ring `:4983`, `:5054` | `memberAttendance` for the month |
| Training "Completed · this month" `:24805–24816` | every `done` session, including restricted/optional/meetings and **sessions with no roll** |
| "Drills held" / "Training sessions" (RosterReports `:13068`/`:13324`, BoardStats `:13744`/`:13792`, Attendance Report `:15702`, dashboard `:28348`) | `deptAttendance().doneThisYear` over the chosen range: done ∧ roll ∧ countsTowardRate; meetings included; no cancelled guard |
| Range "This month" `RANGES.month :14627` | local 1st → now |

**Proposal (same `shared/attendance.js`):**
- `drillsHeld(sessions, range)` = done ∧ **not cancelled** ∧ countsTowardRate ∧ (meetings per D-2) over the **local calendar month**.
- `drillsScheduled` (for "N scheduled") = not cancelled, any state.
- Two explicitly named numbers instead of four unnamed ones.

## 6. Metric E — Onboarding open items

| Site | Definition |
|---|---|
| `OnboardingCardPlain` `:22585–22605` | raw `onboarding_items` + own `onboarding_progress` (`onboardingDone :22461`: a mentor item is done when a mentor is set). **Ignores** the auto items (ack/hours/cert) that `my_probation_status` resolves |
| "Your path to active" `:22480`, `:22520` | `my_probation_status` (computed, server) |
| Onboarding admin overview `:22751–22792` | population = assignable + Probationary, **separated included**; `progressOf` = `dept_probation_board` when probation is on, else raw ticks. Tile **"Awaiting sign-off" (`:22967`) = open manual items** |
| `OnbSignoffQueue` `:22382–22400` ← `onboarding_signoff_queue()` | items members **marked ready**. A different number from the tile with the same name |
| `dept_probation_board` (`sql/probation_2026-10-18.sql:510–515`) | Probationary, not PA, **not separated** |

**Proposal:**
- **open items** = `probation_status` unsatisfied items (the server already computes them; every card reads that).
- **"Awaiting sign-off"** = `onboarding_signoff_queue` rows only. The tile and the queue then agree by construction.
- The raw-ticks path goes, including when probation is off (E-1).

## 7. Siblings found in passing (not in Bret's list — for ruling on scope)

- **F-1 Cert currency, five definitions:**
  - `certCoverage` (per member, ≥1 live cert, Active + Probationary, `:11109`);
  - Roster `avgCompliance` (per member, share current, **Inactive included**, `:11463–11465`);
  - email `certsCurrentPct` (**per cert**, expiring = *not* current, hard-coded `<=3` instead of `EXPIRING_MONTHS`, `digest.js:275–286`);
  - `readiness_verdict` (expiring = satisfied);
  - PA radar (regex only, ignores `no_expiry` / status / PA).
- **F-2 Maintenance due, two definitions:**
  - App `maintStatus` `:17979–17986`: never-done = "Due soon"; window = last 20% of the interval.
  - `shared/maint-due.js` (email / pulse): never-done = **Overdue**; 14-day window; local midnight.
  - **The shared file exists; the app just doesn't use it.**
- **F-3 Station hours:** scorecard `station_hours` (scorecard sql `:219–222`) sums **every** closed shift in 12 months, unverified included. The app and email credit **verified** time only (`dept_iso_hours` + `shared/station-hours.js`). This one touches the `verified` invariant's meaning; recommend aligning the scorecard to verified-only in a reviewed DB slice.
- **F-4 Equipment "needs attention":**
  - the page uses `condition ≠ Serviceable` (`:19454`), and `servPct` uses condition only (`:19762`);
  - the pill and `useEquipmentReadiness` use **open issues** (`:19645`, `:14305–14324`);
  - the memory rule says the flag is *derived from open issues*, so the condition-based ones are the stragglers.
- **Leave alone:** duties "done" (period-relative vs ever-completed is deliberate, per memory); action items open (consistent everywhere).

## 8. The two quick bugs

**G · The "0.0-hour shift (11:47 PM → 11:47 PM)".**
- **It's by design, not a validation hole:** `void_auto_closed_shift` sets `checked_out_at = checked_in_at` ("zero duration: kept, credits nothing", `sql/early_catch_open_shifts_2026-09-09.sql:371`), called from "Void shift" `App.jsx:14867–14874`.
- **The server already refuses end ≤ start** on the human-entered paths: `resolve_auto_closed_shift` and `close_open_shift`, both `p_checked_out_at <= checked_in_at` → refused. The client (`confirmOut` / `closeOpenShift` `:14748–14753`, `:14822–14830`) only checks that a value is present, so the user gets a server error instead of an inline nudge.
- `station_check_out` has no minimum, so a check-out seconds after check-in shows 0.0h.
- **Proposal:**
  - (a) show a voided shift as **"Voided"** (struck through, no hours) instead of a 0.0h row, and leave it out of shift counts;
  - (b) add client-side end > start (and ≤ now) on the two close forms, mirroring the server;
  - (c) G-2 decides whether a sub-minute check-out is hidden.
- **No DB change for (a) and (b).**

**H · A 0% "readiness leader".**
- The Roster crew spotlight "✦ READINESS LEADER" (`:11477–11486`) only skips `null`. A member with certs on file at **0%** current wins when nobody is above 0.
- RosterAttendance "Showing up strong" top-3 (`:12845–12846`, `:12944–12947`) includes 0%, and a member can appear in both "strong" and "nudge" (< 75).
- "Top responder" correctly requires `n > 0`.
- **Proposal:** no highlight unless the score is **> 0** (H-1 may set a higher floor). "Showing up strong" requires pct > 0 and excludes anyone in the nudge list. Rename the spotlight "**Cert leader**", since it's cert compliance, not the Readiness verdict.

---

## 9. Rulings needed (Ashlea)

| # | Question | CC rec |
|---|---|---|
| A-1 | Is a **never-checked** rig "ready"? | **No.** Its own bucket, "never checked" |
| A-2 | Apparatus denominator | All non-retired rigs. Retired excluded everywhere, including the email |
| A-3 | Does an **overdue check** make a rig "needs attention"? | Yes (otherwise "ready" can be months stale) |
| A-4 | Apparatus numbers: station-scoped or department-wide? | Department-wide everywhere; the Apparatus page keeps a station filter but labels it ("Station 2 · 3 of 5") |
| B-1 | Are **Inactive** members in the headcount? | **No.** Shown separately |
| B-2 | Are **Probationary** members in the headcount? | **Yes** |
| B-3 | Project Admins / owner / test / demo accounts | Excluded everywhere (the list moves to `shared/`) |
| B-4 | **Separated** members (status still Active): counted? | **No.** Needs `members_view` to expose separation (small reviewed DB slice) |
| C-1 | Attendance % denominator | Counted members (B), with the join-date cutoff, in the app **and** the email |
| C-2 | Rename: "Attendance %" vs "Readiness x/y" | Yes |
| C-3 | Nobody rated → "—" (not 0%) | Yes |
| D-1 | "Drills this month" = **held** (done, not cancelled, countsTowardRate) plus a separate "N scheduled" | Yes |
| D-2 | Do **business meetings** (`is_meeting`) count as drills? | No for "drills"; they stay in attendance % (today's deliberate rule) — confirm |
| D-3 | A held session with **no roll taken**: count it as held? | No. Show it as "needs roll" |
| E-1 | Onboarding "open items" from `probation_status` only (auto items included), even with probation off | Yes |
| E-2 | "Awaiting sign-off" = items members **marked ready** (the queue) | Yes |
| F-1…F-4 | Include the siblings (cert currency, maintenance due, scorecard hours, equipment) in this wave? | F-2 + F-4 yes (client-only); F-1 yes, with C; F-3 a separate reviewed DB slice |
| G-1 | Voided shift shows as "Voided", not 0.0h; client validates end > start | Yes |
| G-2 | Hide sub-minute check-outs? | No (true record); label "< 1 min" |
| H-1 | Spotlight floor: > 0, or a higher bar (e.g. ≥ 50%)? | > 0 plus at least one cert; rename "Cert leader" |

## 10. Proposed slicing (after rulings)

1. **WS-4a (client, quick):**
   - G (void label + client end > start);
   - H (floors + rename);
   - A's **digest retired-rig filter** (one line in `digest.js`).
2. **WS-4b (client + `shared/`):**
   - `shared/apparatus-status.js`, `shared/attendance.js` (C + D), with the email importing both;
   - F-2 (the app adopts `shared/maint-due.js`);
   - F-4 (equipment from open issues).
3. **WS-4c (tiny DB + client):** separation exposed on `members_view` → `shared/members.js` headcount (B), plus E (onboarding from `probation_status` / the queue).
4. **WS-4d (DB):** F-3, scorecard hours = verified-only. Touches the `verified` meaning, so it gets its own review.

**Each slice ships a test that pins its shared helper and asserts every listed call site imports it.** That fence is what stops the next screen from growing its own copy.
