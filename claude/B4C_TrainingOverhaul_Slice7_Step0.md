# B4C — Training Overhaul Slice 7 (reschedule / cancel, two-person, drawn signature) — STEP 0 (concept + live audit; no SQL, no code)

Greenlit per [[B4C_TrainingOverhaul_Spec_Step0]] decision 5: reschedule / cancel with a reason, **two-person authentication**,
and a **drawn** signature (reuse `SignaturePad`).

**Sources:**
- the code on **main `12888fc`**, which has Slice 6 live: lock guard, `training_session_audit`, correct / reopen / finalize RPCs;
- two **read-only** live queries:
  - `docs/review/training_slice7_STEP0_audit.sql` (SHA-256 `36ed777c…`);
  - `…_audit2.sql` (`c229639f…`);
  - output in `docs/review/training_slice7_STEP0_OUTPUT.json`.

**Scope: DB + UI → 7-DB then 7-UI**, with standard discipline (pins, PGlite dry run, SENTINEL RETEST, `verified` untouched,
Notify held).

---

## TL;DR — what the audit changes about the brief

1. **There is no cancel or status concept for training sessions today.** No `status` / `cancel*` column, no cancelled-looking
   titles, and the Slice 6 audit `action` CHECK is `correct | reopen | finalize`.
   - "Cancel" today means a DA **deletes** the session. That's only allowed while it's unfinalized with an empty roll, and
     it cascades its RSVPs away.
   - **9** past, unfinalized, empty sessions are sitting on the calendar: drills that silently didn't happen.
2. **A date change on an *upcoming* session is unguarded and unlogged today**, through the plain Edit form. The Slice 6 lock only
   protects *attended / finalized* rows.
   - So "reschedule needs two people" means nothing unless the plain Edit loses its date field (**Ruling 3**).
3. **There's a live, unlogged reschedule path nobody uses: `swap_week_dates(a, b)`.**
   - It's SECURITY DEFINER, EXECUTE is granted to `authenticated`, it's gated `is_admin()`, and it swaps two sessions' dates with
     raw UPDATEs.
   - It isn't in the repo and isn't called by the app.
   - Its sibling **`move_week` is already broken**: it writes `training_sessions.week_number`, a column that doesn't exist.
   - **Recommend 7-DB revokes and drops both** (they're residue). The Slice 6 guard already stops them on locked rows, but not
     on upcoming ones.
4. **The "two-person" precedent in the app is weaker than it looks.**
   - Equipment self-issue (`issue_equipment_batch`) takes a **witness who draws on the same device**. The witness never signs
     in; the server only checks they're a different, same-department equipment manager or DA (**or Project Admin**).
   - It has been used **0 times**.
   - For a cancel, that's one person holding the phone. **Recommend real two-person: a second, separately signed-in approver
     (Ruling 4).**
5. **Signatures are big.** They're inline base64 PNG data-URLs, averaging **37 KB** (max **81 KB**; 8 equipment rows).
   - Two per cancel would bloat every Corrections-history read if they lived on `training_session_audit` rows.
   - **Recommend they live on a request record, read only on demand (Ruling 2).**
6. **Who the two can be is constrained by real staffing.**

   | Department | DAs | Training officers |
   |---|---|---|
   | Demo | 2 | **0** |
   | Granbury | 2 | **0** |
   | Lipan | 2 | 2 |
   | Indian Harbor | 7 | **1** |
   | North Hood | 3 | 5 |

   - "Two training officers" is **impossible in 3 of 5 departments**.
   - "Any two different training managers" works everywhere (**Ruling 5**).

---

## 1. The lifecycle today

- **States:**
  - **scheduled** (`done=false`);
  - **in progress** (`signin_open` / attendance; locked since Slice 6);
  - **finalized** (`done=true`, via `finalize_training_session`);
  - **reopened** (`done=false` again, via `reopen_training_session`).
  - Nothing else.
- **"Didn't happen" has no representation:**
  - it stays a scheduled row forever, or a DA deletes it;
  - delete is refused once anyone is on the roll or it's finalized; it cascades `session_registrations`.
- **Rows hang off a session:**
  - `session_attendance` and `session_registrations` cascade on delete;
  - `session_plans`, `station_presence.session_id` and `ai_outputs.session_id` are set null;
  - `training_session_audit` restricts delete.
  - **So a session with any Slice 6 log row can no longer be deleted at all.** That's one more reason "cancel" must be a status,
    not a delete.
- **Nothing reads a status** (there isn't one). **Every reader** today treats a row as either a future, schedulable drill or a past
  one judged by `done` + attendance. The full list of readers is in §6.

**What makes "cancelled" / "rescheduled" distinguishable:**
- **cancelled:** a stored state on the row. Every reader must be able to tell "cancelled" from "scheduled" without reading the log.
- **rescheduled:** **not** a state. A rescheduled drill *is* a normal scheduled drill at its new date. What's distinctive is its
  history ("moved from Oct 3", with a reason), which the log already models.

## 2. The record + status model — **Rulings 1 & 2**

**Ruling 1 — status: recommend a `status` column, `'scheduled' | 'cancelled'` only, plus a "Cancelled" filter bucket in the
Slice 3 Show filter.**
- **Column, not a filter-only bucket.** A bucket needs something to filter *on*; deriving "cancelled" from the log in every reader
  (calendar, Up-next, rates, digest, assistant, SQL rollups) is the fragile path.
- **No `'rescheduled'` status.** Every reader would then have to treat it exactly like `'scheduled'`. That's a trap for each new
  reader, for no information the log doesn't already hold.
  - The UI derives a small "Moved from Oct 3" note from the latest `reschedule` log entry instead.
- **Alternatives:**
  - a boolean `cancelled_at timestamptz`: equivalent, slightly less extensible;
  - a 3-value status: rejected above.

**Ruling 1b — how a cancelled session shows. Recommend: it stays, struck through ("tombstoned").**
- **Leader calendar + Sessions list:** shown struck through with a "Cancelled" pill and the reason. It counts in no rate or stat.
- **Member Up-next:**
  - an upcoming cancelled drill shows **struck through, with the reason**, until its date passes, so nobody turns up to an empty
    station;
  - then it drops out of the member's lists;
  - it **never** appears in the catch-up / missed list.
- The Slice 3 Show filter gains **"Cancelled"**.
- **Trade-off:** removing it from the calendar entirely is cleaner-looking, but members who RSVP'd lose the signal.

**Ruling 1c — what a cancelled session keeps. Recommend: everything** (plans, RSVPs, audit history, series membership). It's
never deleted, and the RESTRICT on the log enforces that.
- **Restore (un-cancel): recommend allowed, under the same two-person rule, logged** (`restore`). It's the honest fix for "we
  cancelled the wrong week".

**Ruling 2 — where the reason + two signatures live. Recommend BOTH a new `training_session_requests` table and new
`training_session_audit` actions.**
- **`training_session_requests`** holds one row per proposed change. It has a lifecycle, so it **can't** live in the
  append-only audit table (its trigger refuses UPDATE). Columns:
  - `id`, `department_id`, `session_id`;
  - `kind`: `cancel | reschedule | restore`;
  - for a reschedule, `new_date` / `new_start_time`;
  - `reason`;
  - **`initiator_id/name` + `initiator_signature`**;
  - **`approver_id/name` + `approver_signature`**;
  - `state`: `pending | approved | withdrawn | rejected | expired`;
  - timestamps.
  - It's written only by SECURITY DEFINER RPCs (no write grant), and read by leadership (dept-scoped, like the log).
- **`training_session_audit`** gets `cancel | reschedule | restore` actions. The `action` CHECK is extended by
  drop + re-add, a pinned change. The entry is written **when the change takes effect** (approval), with old→new in `changes`
  and the `request_id` in `changes`.
  - The Slice 6 "Corrections (N)" history then shows the whole story in one place.
  - Signatures are fetched only when someone taps "View signatures" (they never ride along in the history list's explicit
    column select).
- **Alternative: audit-only, with signature columns.** It works only for the co-present model (Ruling 4b), because there is no
  pending state, and it puts about 80–160 KB on every cancel row.

## 3. Reschedule semantics — **Ruling 3**

**Recommend: reschedule *moves the existing session*** (same `id`, new `date` / `start_time`). The alternative, cancel + create,
would orphan the plans and RSVPs, double the calendar clutter, and break `series_id` dedupe.
- **Only upcoming, unattended, unfinalized sessions can be rescheduled.** Once anyone is on the roll the drill happened, and a
  wrong date is a **Correct** (Slice 6). That's what Sep-24→Sep-3 was.
  - So the **membership-window** trigger never fires on a reschedule (no attendees),
  - and **attested hours can't move** (`attested_training` reads `done` sessions only).
- **RSVPs** (`session_registrations`): **recommend keep them, but flag "date changed — please re-confirm"** on the member's card.
  - Alternative: clear them, which forces a re-RSVP but loses the signal entirely.
- **Series:** reschedule one occurrence; `series_id` kept. Moving onto a date where the same category already has a session →
  refused, the same rule as `scheduleRecurring`'s dedupe.

**Ruling 3b — the plain Edit's date field. This is the real decision behind "reschedule".**
- Today any training manager can change an upcoming session's date in Edit, unlogged.
- **Recommend: the date (and start time) leave the plain Edit form once a session exists. Changing them is always
  *Reschedule*:** logged, with a reason and the initiator's drawn signature.
  - The DB enforces it by **extending the Slice 6 guard**: `date` / `start_time` changes on **any** row need the RPC flag
    (INSERT is untouched).
  - A typo right after scheduling becomes a 10-second Reschedule.
- **Alternatives:**
  - (a) keep Edit's date: the reschedule log is then voluntary and the two-person rule ceremonial;
  - (b) Edit's date stays free for N hours after creation or until the first RSVP: more rules to explain.

## 4. Two-person authentication — **Rulings 4 & 5**

**Ruling 4 — how the second person authenticates. Recommend 4a, request → approve.**
- **4a (recommended): two signed-in people.**
  1. The **initiator** (a training manager) files the request with a reason + **their drawn signature**.
  2. The session shows **"Cancellation pending — needs a second sign-off"**. Nothing changes yet.
  3. A **different** training manager, **signed in on their own account** (the server checks `auth.email()` → `my_member_id()`
     ≠ initiator, same department), opens it, sees the reason and the first signature, and **approves with their own drawn
     signature**.
  4. The change takes effect in that same transaction.
  - They can also **reject** (with a reason); the initiator can **withdraw**.
  - A pending request whose drill date passes is **expired** by the next RPC that touches it. Lazy, no cron.
  - **Surfacing without Notify:** a "Needs your sign-off (N)" card on the Schedule for other training managers, plus the
    pending marker on the row. (Push/email waits for Notify.)
  - **Trade-off: it's asynchronous.** A same-evening weather cancel needs a second manager to open the app. In a 2+-manager
    department that's minutes.
- **4b (the equipment precedent): co-present witness.**
  - The second person picks their name and draws on the **same device**; the server checks role + "not the initiator".
  - It's instant, but **not authentication**: the initiator holds the phone, and nothing proves the second person was there.
  - Acceptable for a low-stakes action; weak for "two-person authentication".

**Ruling 5 — who the two are. Recommend: any two *different* training managers** (`is_training_manager()`: a DA or an active
training officer, **never a Project Admin**, checking the DA *role* as Slice 6's D1 does).
- This works in all five departments today (each has ≥ 2 DAs).
- **Alternatives:**
  - **TO + DA (one of each):** stronger separation, but Demo / Granbury have no TOs, so it would need a DA + DA fallback;
  - **two TOs:** impossible in Demo, Granbury and Indian Harbor today.

**Ruling 6 — which actions need two people.**

| Action | Recommendation |
|---|---|
| **Cancel** | **two-person** |
| **Restore** | two-person |
| **Reschedule** | **one person + reason + drawn signature**, logged (it's reversible and less destructive) |

- Alternative: two-person for both. The friction lands on the most common operation.
- Middle option: two-person only when rescheduling **within 48 h** of the drill, or across months.

## 5. Gates + DB discipline (7-DB)

**New SECURITY DEFINER RPCs.** Each has `SET search_path=public`; REVOKE from anon/public, GRANT to authenticated; department
check on the session; `NOTIFY pgrst`.

| RPC | Does |
|---|---|
| `request_session_change(p_session_id, p_kind, p_new_date, p_new_start, p_reason, p_signature)` | Initiator = `is_training_manager()`. Session upcoming, not done, empty roll, not already cancelled (for cancel / reschedule) or cancelled (for restore). One pending request per session. **With Ruling 6 as recommended, a `reschedule` applies immediately** (one person), so no pending row. |
| `approve_session_change(p_request_id, p_signature)` | Approver = `is_training_manager()`, **≠ initiator**, same department, the request still pending and still valid (the session not since attended / finalized / moved). Applies the change under the Slice 6 flag; writes the `training_session_audit` entry. |
| `reject_session_change(p_request_id, p_reason)` / `withdraw_session_change(p_request_id)` | Close a pending request without applying it. |

- **Signature validation:** non-blank, `data:image/png;base64,` prefix, and a size cap (e.g. ≤ 200 KB).
- **Lock guard / policy:**
  - `status` (and, with Ruling 3b, `date` / `start_time` on any row) join the guard's protected fields. A raw UPDATE can't
    cancel, restore or move a session; only the RPCs (flag) can.
  - The `done IS NOT TRUE` policy term stays.
- **Every refusal path the existing RPCs need:**
  - `open_signin`, `member_check_in`, `current_signin_token`, `finalize_training_session`, `correct_training_session`,
    `set_my_session_registration` and `set_session_location` **refuse a cancelled session**;
  - `attach_drill_plan_to_session`: allowed or refused (**Ruling 7**; recommend refused).
  - Each change is a pinned CREATE OR REPLACE with the live body diffed first, the Slice 6 discipline.
- **Housekeeping in the same migration:** revoke + drop `swap_week_dates` and `move_week` (finding 3); widen the audit `action`
  CHECK.
- **`verified` untouched; nothing writes `station_presence`. Notify stays held.**

## 6. Every reader a status touches (main `12888fc`; App.jsx line numbers)

**Today, a cancelled session would be treated exactly like a live one by every reader.** The rows marked **⚠** would visibly
misbehave if 7-DB shipped without 7-UI. That makes **7-DB + 7-UI ship in one window, like Slice 6.** Until a session is
actually cancelled the column is inert, but every reader below must learn `status` first.

**A. The loader:** `loadSessions` (2578–2617). It uses an explicit column list (2580), so **`status` must be added** to the
select and the mapper (`cancelled: r.status === 'cancelled'`). Shared predicates sit beside `isOptionalEvent` / `countsTowardRate`
(402–409): **add `isCancelled(s)`**, and use it everywhere below.

**B. Up-next / "next event" pickers.** Each uses `!done && date >= today`, so each must exclude cancelled, or show it struck
through where Ruling 1b says so:
- PersonalView upcoming (3424);
- NextLeadershipEventTile (3828);
- NextTrainingCard (3854);
- DeptAdminDashboard `nextEvent` (4059);
- OfficerDashboard `nextSession` (4411, 4453);
- **⚠ MemberDashboard `loadUpcoming`** (4997, its **own query, no `done` filter**);
- Member Training Up-next (24765–24769);
- leader hero `nextSession` (24938–25038);
- RosterReports / BoardStats / **MeetingAgenda `upcoming`** (13158, 13673, 20689; the last feeds the **AI agenda prompt**, 20732);
- the Register prefetch (24723).

**C. Calendars.**
- `monthSessions` (24669) → both MonthCalendars' `renderChip` (24744, 25129): branch on cancelled (struck through, grey).
- The leader `renderSessionRow` (25186): a "Cancelled" pill; no Complete / QR / Attach / Correct; a "Restore" control.
- **⚠ `DashboardCalendar`** (7953, its **own query** at 7965, no filter).

**D. The overdue clock.** **⚠ `upcomingFor` / `reconcile`** (24365–24366): a cancelled future session would mark its category
"On track" and **hide a real overdue**. It must skip cancelled. (`dueInfo` reads `last_iso` only, so it's unaffected; cancel
never touches `last_iso`.)

**E. To-do surfaces.** **⚠ `NeedsAttention`** (3309): past and not done → "roll still open". A cancelled past session would nag
forever, so exclude it. (This is also where today's **9 silent "didn't happen" drills** surface; cancel finally gives them an
honest end state.)

**F. Pickers.**
- TrainingPlans attach `upcoming` (23841; no date filter today) and AIDrillPlanner (5952): exclude cancelled.
- The recurring-schedule dedupe (24450): **a cancelled occurrence must not block re-adding that date** (exclude cancelled from
  `existing`). It matters for rescheduling too.
- The Minutes meeting picker (20053): exclude, or label.

**G. Rates / stats / reports.** These need **no change** if Ruling 3's rule holds (only empty, unfinalized sessions can be
cancelled): every rate requires `done` plus a non-empty roll.
- deptAttendance 3246, boardAttendance 3268, memberAttendance 27538;
- member 90-day 24737; MemberDetail 11815; Top responder 11479;
- doneTraining / doneYTD 24929 / 24983; reports 12868 / 13071;
- `drillsHeld`; `computeInsights` 4200 (attendance-based).
- Add a defensive `!isCancelled` anyway: it's one term in the shared predicate.

**H. Server readers.**
- **⚠ `api/pulse.js`** reminders (262–345: `done=false`, yesterday … +2 days) **would push a reminder for a cancelled drill.**
  Filter `status <> 'cancelled'`.
  - Its `subject_ref = id:date` already re-reminds after a reschedule, which is the right behaviour.
- `api/assistant.js` `my_schedule` (162–173): exclude cancelled, or say "cancelled". `my_attendance`: unaffected (`done`).
- `api/digest.js` `trainingCompliancePct` (292): unaffected (`done`).

**I. SQL readers** (live `pg_proc`, 22 functions reference `training_sessions`):
- **Must refuse a cancelled session:** `open_signin`, `member_check_in`, `current_signin_token`, `set_session_location`,
  `set_my_session_registration`, `finalize_training_session`, `correct_training_session`, `attach_drill_plan_to_session`
  (Ruling 7).
- **Unaffected (`done`- or attendance-based):** `attested_training`, `readiness_verdict`, `probation_item_states`,
  `set_member_termination`, `drill_window_presence`, `recompute_training_plan_last_iso`, `reopen_training_session`, the
  membership-window trigger.
- **Needs one term:**
  - `my_department_rollup`'s **upcoming** union (`ts.date >= current_date`) must exclude cancelled. Its counts carry the
    precedence slip noted at the end;
  - `pa_department_radar`: raw counts, fine as is.
- **Drop:** `swap_week_dates`, `move_week` (finding 3).

**Repo hygiene noticed while auditing:** the **applied** Slice 6 migration (`sql/training_slice6_corrections_DRAFT.sql`) and its
RETEST live only on `feat/training-slice6-db`, **not on main**, so main's `sql/` has no definition of the live correct / reopen /
finalize RPCs. Recommend landing them on main as `sql/training_slice6_corrections_2026-10-25.sql` (applied) + RETEST, the same
way earlier applied migrations were recorded.

## Rulings needed

| # | Question | Recommendation | Trade-off |
|---|---|---|---|
| 1 | Status model | `status` column `scheduled \| cancelled` + a "Cancelled" Show-filter bucket; "rescheduled" = log history, not a status | A 3-value status burdens every reader |
| 1b | How a cancelled session shows | Kept, struck through + reason (leader + member Up-next until its date); out of all stats and catch-up | Hiding it loses the "don't turn up" signal |
| 1c | Keep history / allow restore | Keep everything; restore allowed under the two-person rule | No restore = recreate by hand |
| 2 | Where reason + signatures live | New `training_session_requests` (lifecycle + both signatures) + new audit actions | Audit-only can't hold "pending"; fat rows |
| 3 | Reschedule = move or cancel+create | Move the same session; only upcoming, unattended, unfinalized; RSVPs kept + "re-confirm" flag | Clearing RSVPs is simpler, loses signal |
| 3b | The plain Edit's date | Removed after creation; all date / time changes = Reschedule (guard-enforced) | Keeping it makes the log voluntary |
| 4 | How person #2 authenticates | Request → approve, each signed in on their own account, each drawing | Co-present is instant but not authentication |
| 5 | Who the two are | Any two different training managers (DA role or active TO; never PA) | TO+DA needs a fallback in 2 departments; two TOs impossible in 3 |
| 6 | Two-person for which | Cancel + restore; reschedule single-person (reason + signature) | Two-person reschedule = friction on the common case |
| 7 | Plans attachable to a cancelled session | Refused | Allowing it is harmless but pointless |
| 8 | Housekeeping | Drop `swap_week_dates` + `move_week` in 7-DB | Leaving them keeps an unlogged date path |

**Noticed, not in scope:** `my_department_rollup`'s "done this month" counts have an AND/OR precedence slip:
`… and ts.done and <this month> and counts_toward_attendance <> false OR audience not in ('leadership','board')`. The unparenthesised
`OR` lets any every-audience session through, regardless of department / month / done. Worth its own small fix; a status column
would add one more term to the same expression.
