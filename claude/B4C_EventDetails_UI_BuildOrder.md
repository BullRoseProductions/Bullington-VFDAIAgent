# B4C — Fundraising & Community Events: the UI slice — BUILD ORDER for CC

The web-layer half of the event feature. DB columns are **live** (`start_time`, `end_time`, `location_label` on both `funding_events` + `recruitment_events`; `notes` already existed). Concept: [[B4C_EventDetails_Concept_Step0]]; DB record: [[B4C_EventDetails_DB_ReviewRecord]]; Step 0 app-side: `docs/review/event_details_STEP0_app_side.md`. Deliver as a diff for gate review, then promote (web deploy; installed apps get it on a later native build).

## 1. Combine the two calendars into one
- On the **Fundraisers page** (where the funding calendar lives — NOT the "Funding" money hub, which keeps its name + Donations), rename the calendar section to **"Fundraising & Community Events."**
- That one calendar now **unions** `funding_events` + `recruitment_events`. Load both (they're already loaded separately today), merge into one item list, each item tagged with its **kind** (`fundraiser` | `community`). Nothing merges in the DB.
- The **Recruitment page** keeps its 3-phase planner, Ways to Recruit, Graphic Studio and saved drafts — only its **events calendar moves here**. Remove the duplicate calendar from Recruitment (or replace it with a one-line link to the combined calendar) so there's a single place to add/see events and no second source that can drift. The AI recruitment plan creates no events, so it's unaffected.

## 2. Add-event form — type toggle + the new fields
- Add a **type toggle: Fundraiser | Community event** at the top of the add form. It routes the insert to the right table:
  - *Fundraiser* → `funding_events`, and keeps the existing **"Part of a fundraiser"** select.
  - *Community event* → `recruitment_events`, and **hides** "Part of a fundraiser" (it has no meaning there).
- Add these optional fields to the form (both kinds): **Start time**, **End time**, **Location** (writes `location_label`), **Notes** (writes the existing `notes`). A quick date-only add still works — all four stay empty when untouched.
- Validation: if both times are set, **end ≥ start**; otherwise allow either alone or neither.

## 3. Tap → detail view (net-new), with edit + delete inside
Today tapping an event **deletes** it (DA/PA, after a confirm) and officers see a "(tap to remove)" hint they can't use. Replace that:
- **Tap an event → a detail view** (everyone can open it): shows kind, title, date, **time range** (`fmtTime(start_time)`–`fmtTime(end_time)`, or just the start, or "All day"), **location**, and **notes**.
- **Edit + Delete live inside the detail view, shown only to DA + Officers** — the `CANMANAGE_OPS_ROLES = ["Department Admin","Officer"]` client twin of the DB's `is_canmanage_ops()` (shared/roles.js:29). **NOT** `isDeptAdmin`/PA — that's the E1 bug (a PA-only user would see buttons the DB silently refuses). Remove the old tap-to-delete and the "(tap to remove)" hint.
- **Edit** writes the fields back with a direct `.update()` on the right table by id. **Delete** is `.delete()` by id.

## 4. The silent-failure fix (E1) — REQUIRED on both edit and delete
The DB gates UPDATE/DELETE on `department_id = my_department_id() AND is_canmanage_ops()`, and PostgREST returns **no error** when RLS filters the write to 0 rows. The current `removeEvent` only checks `error`, so a refused write looks like it worked. **Every edit and delete must read back the affected row count** — use `.select()` on the mutation (or `{ count: "exact" }`) and treat **0 rows changed as a failure**, showing an error ("Couldn't save — you may not have permission for this department's events"). This makes a refusal loud instead of a silent no-op, and future-proofs against any gate drift.

## 5. Chip + don't-strand-readers
- The calendar **chip** shows the start time when set — map each event's `start_time` into the item's `startTime` as it loads (the chip at ~7961 already renders `it.startTime`).
- These events are also read by: the officer dashboard tiles, the member dashboard upcoming, the **Station calendar** modal, each fundraiser's **Key dates**, and `my_department_rollup()`'s next-event. They read the two tables directly, so the union in this one view **must not change their queries** — leave those readers alone (optionally, a later change could surface the time in them, but not here).
- **Don't break the other writers:** the **AI-plan date import** and each fundraiser's **"Key dates"** also insert `funding_events` — leave them date-only (the new columns are nullable; just don't require them there).

## Review hooks (what I'll check on the diff)
- Edit/Delete gated on `CANMANAGE_OPS_ROLES` (DA+Officers), not PA; both do the **row-count check**.
- The type toggle routes inserts to the correct table; "Part of a fundraiser" only on Fundraiser.
- The union doesn't alter the other readers' queries; the AI-plan/Key-dates writers still work date-only.
- No new hex outside the brand tokens; the detail view matches the Industrial Noir look.
- `verified` token untouched (it's a UI diff, but confirm no stray literal).

*(Optional: if Ashlea wants to see the combined calendar + detail layout before the build, I can mock it first — say the word.)*
