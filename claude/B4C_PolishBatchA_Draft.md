# B4C: Bret/Tommy polish batch A (DRAFT, web only, NOT deployed)

**Branch:** `polish/batch-a`, off main `459dd61` (industrial-noir-61).
**Changed:** `src/App.jsx`, a new `src/phone.js`, `docs/review/polish_batch_a_test.mjs`, and this note.
No SQL, api, shared, native or `vercel.json` changes. **No data written:** the hygiene inventory below was read-only SELECTs.

## Built

| Item | What changed |
|---|---|
| **Resend login link** | A light confirm before the send: "Email a sign-in link to *address*?", with the body "It uses one of this hour's sign-in emails…" and a **Send link** button. Cancel sends nothing. |
| **Clear all checkmarks · roster card ✕** | **Already guarded on main.** Clear all has a `noirConfirm` ("Clear N checkmarks?"; this is on Station Duties, not onboarding). The roster card ✕ uses the typed-phrase `confirmDestructive`. Both landed after Bret's pass. Unchanged; the test now asserts both so a regression shows. |
| **end > start** | Station out-times were **already** checked client-side (WS-4a G: out-time ≤ check-in is refused in all three closers). The hole was `eventTimesInvalid`: it allowed **end = start**, so an 11:47→11:47 event shift was accepted. It is now `<=`, with clearer wording, across event shifts and event times. Times are still optional. |
| **Empty states** | **Expirations:** "Add the first credential" (DA/officer) opens Manage records on a new credential and scrolls to it. **Qualifications:** "Add the first qualification" (DA/PA) opens Manage qualifications on a new type. Both use the existing empty card with a primary button. |
| **Send reminders** | Now a normal button (it was a dashed red banner). It is disabled at zero flagged, with the reason in both the label ("nobody's flagged") and the hover title; when anyone is flagged it is enabled and shows the count. |
| **Phone display** | One formatter, `src/phone.js` `fmtPhone`, for display only: stored numbers are untouched and `tel:` links still use `telDigits`. A US number reads "(817) 555-0199"; extensions, international numbers, words, "—" and anything else show exactly as stored. It covers all 7 places a phone is shown: Your Six, donor, sponsor, roster card, roster export, and the member file ×2. |
| **Chaplin → Chaplain** | **There is no "Chaplin" anywhere in the code;** the code already says "chaplain". The typo is **only in data** (see the inventory). Nothing was written. |
| **Study Session dropdown** | A search box above the existing grouped list (153 tracks, 14 group headings). It narrows the list by track or heading, shows "N of 153 match", picks a single hit for you ("rope res" picks Rope Rescue), and always keeps the current track listed so the select never holds a value it doesn't show. |
| **Station Hours + Capital cards** (deferred from noir-61) | The **table** scrolls, not the card. 4 Station Hours cards and 2 Capital cards (each year, plus Not yet planned) are now plain cards, and each table sits in its own `ScrollX`. The header, explainer and filter chips stay put, and the fade no longer dims the ISO explainer. Real Chrome at 360: only the two wide tables scroll (349 / 173px), each scroller holds only its table, fade and hint are there, page overflow is 0. At 1000: fade only. |
| **Giver countdown tint** | `secs` starts at null and `null <= 10` is true in JS, so a fresh code painted red for one frame. The tint now comes from the same number the text prints. The receiver's countdown also guards null. |
| **Pickers exclude Inactive** | `isPickable` / `pickable()`: not Inactive and not separated. A NULL status means "masked for this viewer", not inactive, so it is kept. The row's **current** person stays listed, so an edit never silently re-points. Applied to the 5 pickers that offered Inactive: Reach-out person, action-item Owner ×2 (fundraiser review, minutes review), and duty Assign-to ×2. Mentor, supervisor ×2 and sign-off approver **already** excluded Inactive. The duty "Who did it" log is a record, not an assignment, so it is unfiltered. |

## Judgment calls: proposals, not built
**1. Board-only events hidden from general members.**
- **Definition from the data:** "board-only" is `training_sessions.audience = 'board'`, set by the schedule form's Audience toggle. Nothing else carries an audience; calendar posts and funding events have none.
- **Proposed rule:** on every member-facing calendar and list (Training calendar, Dashboard, Upcoming, Feed), a board event shows **only** to Board Members plus DA/PA, who administer the calendar. General members don't see it at all; today they see it as a dashed blue chip.
- **Questions:**
  - Should Officers who aren't on the Board see board events?
  - Should "Leadership only" events get the same treatment for plain members?
- **Note:** this is UI-only, the same as minutes visibility. `training_sessions` is readable department-wide under RLS, so a DB-level rule would be its own slice.

**2. The dead-end Department page.** The PA-only "Department" nav item, opened with no department chosen, shows "Open a department from the Program overview…". **Recommendation: give it content.** List the PA's departments from the same `pa_department_radar` read the Program overview uses, and tapping one opens the existing page. The alternative is to drop the nav item and redirect to Program overview. Content keeps the nav honest and costs one read.

**3. Tommy's picker** (plus Bret's packet "Schedule this / Attach to a session", which uses the same plumbing).
- **The picker:** the schedule-a-session form gets a **"Plan (optional)"** selector next to Training. It lists the department's **approved** drill plans, from the read Training Plans already does; drafts can't be attached. Picking one sets the existing **"With plan"** chip, and on save the existing `attachWithPlan` → `attach_drill_plan_to_session` runs. No plan is created, there's no AI call and no new RPC; "Draft a new plan" stays as the separate path.
- **Packet buttons:** on a Library packet whose department copy is approved, add **Schedule this** (the same prefill as "Schedule with this plan") and **Attach to a session** (Training Plans with that plan's attach panel open). While the copy is still a draft, the packet says "In your plans — waiting on officer approval".

**4. Probationary members in pickers.** The roadmap line said "inactive/probationary"; this directive said Inactive. Today the probation supervisor, qualification-drive supervisor and sign-off approver pickers allow **Probationary** members. Should they?

## Data hygiene inventory (read-only, live, 2026-11-01). Nothing written
**Test / demo rows in REAL departments:**

| Row | Department | Status / access | What points at it |
|---|---|---|---|
| Apparatus **"Test"** (Pumper, live) | North Hood County VFD | not deleted | 1 `aftercall_runs` row |
| Member **"Test"** | North Hood County VFD | Active · Member | **holds a real equipment item** (`equipment.current_holder_id` 1, `equipment_custody` 1, `equipment_issue_batch` 1); notifications 5, document acknowledgments 2, session_attendance 1, member_private 1 |
| Member **"Demo Account"** (`fc4a1a0f…`, already stats-excluded) | North Hood County VFD | **Inactive** · DA | **ai_outputs 5** (the "drafts"); member_devices 14; apparatus_photos uploaded 5 / deleted 2; apparatus_service_periods back_by 2; duty_log done_by 2; session_attendance 2; notification_prefs 2; member_private 1; station_presence 1 |
| Member **"Test Admin"** | Lipan VFD | Inactive · DA | documents uploaded 2, deleted_by 1 |
| Member **"Test Five"** | Granbury Fire Station | **Active** · DA | station_presence 2, member_private 1 |

- **Out of scope:** B4C Demo Department's "Demo Chief" / "Test Admin" are the intended demo department, so they are left as is.
- **Stale exclusion id:** the "test account" id in `STATS_EXCLUDED_IDS` (`02c4a728…`) has **no member row**, so that list entry is now dead.

**Proposed cleanup, each on Ashlea's go:**
- **North Hood "Test":** return or transfer the equipment item first, through the app's custody flow so the ledger stays honest. Then delete its 1 attendance row (it counts toward rates) and remove the member.
- **"Demo Account":** review the 5 `ai_outputs` one by one; they may be real documents drafted during a demo, so keep or reassign rather than bulk-delete. Its 2 attendance rows and 1 station_presence row come out of the department's figures. The apparatus photos and service periods are real rig records, so keep them and leave the "who" as is or null it. Then remove the member.
- **"Test Five" (Granbury, Active DA):** an active admin login in a real department. Remove it, or set it Inactive first if anyone still uses it. Its 2 station_presence rows affect hours.
- **"Test Admin" (Lipan):** the 2 documents it uploaded may be the department's real files, so keep them; remove the member.
- **Apparatus "Test":** soft-delete it (the app's own "Remove") after confirming the 1 after-call run is test data.

**"Chaplin" in data:**
- `members.role` "Chaplin/FF": 1 row in North Hood.
- `resources.name` "Chaplin *name*": 1 Your Six resource in North Hood.
- Proposed fix, on her go: two one-row text updates to "Chaplain".
- `documents.content_text`: 2 rows of the extracted text of Indian Harbor's own uploaded SOP PDF. That is their document's wording, so leave it.

## Proof
- **`polish_batch_a_test.mjs`: 35/35** on the real bundled App, with the app's own dialog host and a faked backend. It covers:
  - the confirm blocks the send until confirmed (Cancel → 0 sends, Send → exactly 1);
  - end = start is refused;
  - both empty-state CTAs open their add forms;
  - Send reminders is disabled at zero and enabled and counted otherwise;
  - the Study search narrows, auto-picks, keeps the picked track, and clears;
  - the pickers exclude Inactive and keep the current person;
  - `fmtPhone` cases, the countdown tint, the table-scoped structure, no clip added;
  - fences, counts 132/32/14, Notify held.
- **Mutations caught:** dropping the confirm, reverting `<=`, un-filtering one picker, un-formatting a phone.
- **The test cannot prove layout.** The table-scoped scrolling was checked in real Chrome with the `docs/review/phone_layout_sweep/` harness and a temporary Station Hours fixture that was reverted and not committed.

## Follow-up (rulings on the gate's PASS @88b559f): built
| Ruling | What changed |
|---|---|
| **Board-audience events → Board + DA + PA only** | `sessionVisibleTo(s, role)`: a board event shows to Board Member, Department Admin and Project Admin, **not** Officers. It is applied where sessions reach calendars and upcoming lists: the Dashboard and Training get `visibleSessions`, and every `DashboardCalendar` filters its own training read by the viewer's role. All 4 dashboards pass `role`. It keys on the app's `role`, so "View as" previews it. |
| **"Leadership only" hidden from plain members** | The same helper: a leadership event shows to leadership (PA / DA / Board / Officer) and never to a plain member. |
| (both) | **Display only.** `training_sessions` stays department-readable under RLS, the same as minutes. The record screens (Roster, Minutes, Reports, Board stats) still receive every session; Training's writes are all functional updates on the full list, so nothing hidden is dropped from state. `rollFor` (who's on the roll) is unchanged. |
| **Probationary out of the onboarding approver picker** | The sign-off approver ("A specific person") is now **Active only**. An item already naming a probationary approver keeps them listed, marked "(probationary — pick someone else)". The probation and qualification-drive supervisor pickers are unchanged; the ruling named approvers. |
| **The Department page** | With no department chosen it is now the PA's **department list**. It uses the same `pa_department_radar` read as the Program overview, sorts A–Z, and shows station · city. A tap opens that department's page via `go("department", {id, name})`. A failed read shows Retry and is never shown as an empty list. |
| **Tommy's picker** | The schedule form gets **"Plan (optional)"**, listing the department's **approved** drill plans (`dept_drill_plans`, read the first time the form opens). Picking one only sets the existing **With plan** chip and fills a blank length. On save, the existing `attachWithPlan` → `attach_drill_plan_to_session` runs. No plan is created and there's no AI call; "Draft a new plan" is untouched. |
| **Bret's packet buttons** | The catalog's existing `drill_plans` read now also returns the department copy's `id, status, title, duration_min, category`; it is the same query with more columns. **Approved copy:** "Schedule this" (Training's schedule form through the same With-plan prefill as "Schedule with this plan") and "Attach to a session" (Training Plans with that plan selected and its attach panel open). **Draft copy:** "In your plans — waiting on officer approval", with no buttons. The hand-off is applied once and then cleared, so coming back to Training doesn't replay it. |

**Proof:** `polish_batch_a_test.mjs` is now **59/59**; 24 new checks pin the follow-up:
- **10:** the visibility table per role; the real `DashboardCalendar` rendered as Member / Officer / Board / DA shows exactly the allowed events; source checks that all 4 dashboards pass `role` and that the record screens keep the full list.
- **11:** the real `OicItemConfig` lists Active only, and a current probationary approver is marked.
- **12:** the real `PADepartmentList` sorts and shows station · city; a tap calls `go`; a failed read shows Retry.
- **13:** the **real Training screen end to end**. The picker offers only the approved plan; picking it sets the chip; Save inserts the session and calls `attach_drill_plan_to_session` with that plan and the new session's id, with no `drill_plans` write, no pull and no AI call.
- **14:** the real `Packet` with an approved copy shows both buttons, each handing that copy on; with a draft copy, it shows the waiting note and neither button.

**Mutations caught:** letting Officers see board events, offering draft plans, and re-allowing Probationary approvers each turn the matching checks red.

**Two earlier slice tests re-ruled, assertions only:**
- `library_s1_ui_test`: the `drill_plans` read now also returns the copy's id and status.
- `onboarding_item_config_ui_test`: the approver picker is Active-only.

Both were changed deliberately by the rulings; each edit carries a comment saying so. Suite: 57 files, 1,444 passed, 0 failed.
