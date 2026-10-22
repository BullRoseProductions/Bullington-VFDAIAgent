# B4C — Review Record: Fundraising & Community Events UI slice

**Verdict: PASS — safe to promote.** Reviewed by Claude (gate reviewer) 2026-10-21 from the actual diff (`docs/review/event_details_ui_DIFF.patch`, commit `bf2716f`, theme only), not CC's summary. Order: [[B4C_EventDetails_UI_BuildOrder]]; DB record (columns live): [[B4C_EventDetails_DB_ReviewRecord]]. Web-layer (`src/App.jsx` only) — ships on the next `main` deploy; installed apps get it on a later native build. Not customer-live until promoted + served-verified.

## The delete-gate decision (CC's flag) — ACCEPTED: DA-only delete
My order said Edit + Delete for DA + Officers. CC built **Edit** DA+Officer (correct) but **Delete** lands DA-only, because every delete routes through the app-wide typed-phrase `confirmDestructive` gate (`useCanDeleteShared` = DA/PA, added after the Sept plan-deletion incident) AND the DB gate (`is_canmanage_ops()` = DA/Officer). The only role both allow is **Department Admin**. **Accepted** — the alternative (widening the typed-phrase gate to Officers) would loosen *every* delete in the app, a disproportionate, risky change for an events feature. Officers add + edit events; a DA removes them. If Officers deleting events is ever wanted, that's a separate, deliberate call on the global delete gate. CC also, correctly, shows no Delete button to anyone who can't use it.

## Verified from the diff
- **Union, no DB merge.** `loadItems` does `Promise.all([funding_events, recruitment_events])`, both selecting the new `start_time, end_time, location_label` (+ `notes`, `fundraiser_id` on funding); maps each with its `kind` (`fundraiser`/`community`); one item list. "Both-or-neither" read guard so a half-load never reads as "no community events". Every other reader still hits its own table — the union is local to this view.
- **Routing.** Add/edit/delete go through `EVENT_KINDS[kind].table`; `fundraiser_id` is included only for the fundraiser kind; "Part of a fundraiser" renders only for fundraisers.
- **E1 row-count fix (required) — present on BOTH edit and delete.** `.update(...).eq("id").select("id")` / `.delete().eq("id").select("id")`; `!data || data.length === 0` → an error ("Nothing was changed/removed — you may not have permission…"), never a silent success. This is the whole reason E1 mattered, and it's done.
- **Gates (tests confirm):** `canWrite = hasAny(role, CANMANAGE_OPS_ROLES)` (DA/Officer) for add+edit; `canDelete = canWrite && canDeleteShared` → DA. Tests: DA add/edit/delete ✓; Officer add/edit, delete false ✓; PA-without-DA/Officer all false ✓; Board all false ✓. Never `isDeptAdmin` for the write controls.
- **Detail view** replaces tap-to-delete: tap opens a modal (kind, date, `eventTimeRange`, location, fundraiser, notes); Edit/Delete inside, gated; "(tap to remove)" hint gone. Chip leads with the start time; time-less events read "All day".
- **Combine + rename.** "FUNDING CALENDAR" → "FUNDRAISING & COMMUNITY EVENTS" on the Fundraisers page; the Funding money hub keeps its name. `RecruitmentCalendar` deleted; the Recruitment page gets a one-line pointer and keeps its planner, Ways to Recruit, Graphic Studio, saved drafts.
- **No collateral.** Tests assert `OfficerDashboard`, `MemberDashboard`, `DashboardCalendar` (Station calendar) and `FundraiserHQ` byte-unchanged vs origin/main — so the dashboard tiles, Station modal, Key dates, and the AI-plan import / Key-dates writers (still date-only) are untouched. No hex outside brand tokens; no `verified` literal.
- **Validation:** end-before-start refused on add + edit; `evHHMM` normalizes `18:00:00`→`18:00` for the time input.
- **33 interaction tests** (happy-dom + fake Supabase): 33 passed / 0 failed — union, chips, gates per role, add routing, 0-row edit/delete = failure, detail rendering, old calendars gone, the four readers unchanged.

## Non-blocking nit (eyeball on preview)
The detail modal uses `zIndex: 60`. Confirm the toast/notify system renders above it (so an error from a refused save/delete is visible over the open modal). Tests pass; just worth a glance on the preview.

## Toast-z follow-up (`ef74047`) — PASS
My "non-blocking nit" was a real bug: the detail modal and the toast both sat at `zIndex: 60`, and since the toast renders earlier in the DOM, at an equal z the modal covered it — a refused-save error would have been hidden behind the backdrop. CC dropped the detail modal to **`zIndex: 55`** (above the other overlays at 46/50, below the toast at 60) and added a test asserting it. Verified from the diff: scoped to that one value + the test; tests now 34/0. *(CC noted ~25 other app modals share the 60 tie — pre-existing, flagged not fixed; a global toast-z pass is a separate, optional cleanup.)*

## Promote candidate `b04b58d` ("Release industrial-noir-19") — VERIFIED from git
Release branch `release/events` = production `7279705` + theme merged, Notify Crew held back. Confirmed from the objects (not CC's summary):
- **Based on current prod:** `7279705` is an ancestor.
- **Notify Crew held back:** `api/notify-session.js` **absent**; `NotifyCrewModal` **0** refs in `src/App.jsx`.
- **= the reviewed slice, nothing else:** candidate `App.jsx` vs theme `ef74047` differs by **exactly** the Notify Crew removal (all 79 lines = `NotifyCrewModal` + its call sites; `api/` diff = only `notify-session.js` −208). So vs production the only code change is the events slice (bf2716f + ef74047).
- **No collateral:** `EventsCalendar` present, `FundingCalendar`/`RecruitmentCalendar` gone; `verified` token count 73 = prod 73; only `src/App.jsx` changed under code (the rest are inert `docs/review/` + `sql/` reference files riding along, no runtime effect).

## Promote (reviewer-cleared)
Ashlea eyeballs the preview (`theme ef74047` URL — the calendar, add one of each kind with a time/location/notes, the end-before-start toast appearing above the detail, the Recruitment pointer), then CC pushes `b04b58d` to `main`. **Built ≠ live:** customer-live only after it's on `main`, Vercel-deployed, and **served-verified** (version.json = the main commit, the new calendar + no Notify in the served bundle) — the truth doc flips then. Installed apps get it on a later native build. Rollback: the prior `main` (`7279705`).
