# B4C — Training Overhaul Slice 3 (Sessions date-range filters) — STEP 0 (audit + plan, no code)

The ask (Tommy): named filters on the leader Sessions list — **completed this year / last month / this month / custom range**.
Audited from the live code on **main `63fcc1c`** (`src/App.jsx`, line numbers are main's) plus one read-only live count.

**Scope: UI-only.** No schema change, no new RPC, `verified` untouched, Notify crew held back. Every session this filter
needs is **already loaded client-side** (see "Data" below), so it needs no new or wider read.

## How the Sessions list is scoped today
**Where it reads from:**
- `const monthSessions = sessions.filter((s) => s.y === cur.y && s.m === cur.m).sort((a, b) => a.d - b.d)` (24504).
- `cur` is the calendar's selected month (`useState({ y: today, m: today })`, 24061).
- The same `monthSessions` feeds both the **MonthCalendar** chips (24905) and the **Sessions card** (24926–…).
- The card title is `Sessions · <Month> <Year>`, with a count (24928). Empty state: "No sessions scheduled in <Month>."

**Grouping and order — two corrections to the brief:**
- **There is no done / upcoming split today.** It's **one flat list of the calendar month, ordered by day of month**
  (`a.d - b.d`).
  - A done session shows a green **"Done" pill** beside its title (and its action cluster changes: Reopen instead of
    Mark complete, no Register / QR).
  - Nothing groups or sorts by status.
- **Each row prints the month from the calendar, not from the session:**
  - the date badge is `TRAIN_MONTHS[cur.m]` (24949), and the sub-line is `TRAIN_MONTHS[cur.m] {s.d}` (24955);
  - that's harmless while the list is pinned to `cur`. **But any cross-month list would label every row with the
    calendar's month.** Slice 3 must switch both to `s.m` (and show the year when it isn't this year). That's a required
    fix, not optional.

**What scrolls into the list (`#ts-<id>` anchors, 24946):**
- **The hero** (`goToNext`, 24775): `setCur(next session's month)`, then scrolls to `#ts-<nextSession.id>`. Used by
  "QR sign-in" when it falls back to the row's inline panel (off-site with no location / an unrestorable live code).
  "Who's planning to come" and "View plan" open in place.
- **The status strip's Schedule** (`scheduleFor`, 24264): `setCur(the category's next due month)`, then opens the
  schedule form in the calendar card (`#tr-schedule`). It moves the month; it doesn't scroll to a row.
- **The member view's "View session"** (`viewSession`, 24566) sets `cur` on the member calendar. It's a different view,
  unaffected.

**Data — already all client-side, with one ceiling to know about:**
- `loadSessions` (App, 2578) reads **every** `training_sessions` row the department can see, with **no date range,
  order or limit**. It reads every `session_attendance` row and every `session_plans` row the same way.
- So "this year" or any custom range filters what's already in memory: **no new fetch, no wider read.**

Live, read-only, Oct 25:

| Department | Sessions | Done | First | Attendance rows | Plan rows |
|---|---|---|---|---|---|
| North Hood | 71 | 22 | 2026-07-09 | 271 | 21 |
| Indian Harbor | 12 | 10 | 2026-09-03 | 127 | 6 |
| Lipan | 89 | 1 | 2026-08-18 | 25 | 0 |
| Demo | 4 | 1 | 2026-08-01 | 0 | 2 |
| Granbury | 0 | 0 | — | 0 | 0 |

**The ceiling (pre-existing, app-wide, not Slice 3's):**
- Supabase's API returns at most its configured max rows per request (1000 by default), and `loadSessions` doesn't page.
- North Hood is adding about 75 attendance rows a month, so `session_attendance` passes 1000 around **mid-2027**.
  From then, every attendance figure in the app (not just this filter) would silently drop the oldest rows.
- Recommend a separate follow-up: page the read, or scope attendance to a window. That would be its own slice, and
  probably a DB-side aggregate. It's flagged so a "this year" view isn't trusted past that point.

## The key tension — the filters span months/years, the list is pinned to the calendar
**Option A (recommended): a filter detaches the list from the calendar.**
- The Sessions card gets a **"Show"** control:
  - **Calendar month** — the default and today's behaviour: the list follows `cur`, and the title stays
    `Sessions · <Month Year>`;
  - **Completed this month / Completed last month / Completed this year / Custom range…**
- While a named filter is on:
  - the **list** shows that filter's sessions, grouped under month headers (newest month first), and the title becomes
    e.g. `Completed · this year (14)`;
  - the **calendar** keeps showing `cur` independently. It's still the scheduling surface, and the "Schedule a session"
    form still opens there.
- **Snap back to "Calendar month"** whenever something needs the month view:
  - the hero's `goToNext` (its row must be in the DOM to scroll to);
  - `scheduleFor`;
  - navigating the calendar's month (← / →).

  One rule: touching the calendar means "I'm looking at a month". So `#ts-<id>` scroll targets always resolve.
- **Trade-off:** the calendar and the list can briefly show different periods, but the card title always says what the
  list is showing. Snapping back on calendar navigation could surprise someone flipping months while reviewing "this
  year"; the alternative is option C.

**Option B (layer the filter on top of `cur`): not recommended.** "Completed this year" inside a single month is just
"completed this month", so the named filters lose their meaning.

**Option C (detach, but don't snap back on calendar navigation):** same as A, except only `goToNext` / `scheduleFor`
reset the filter.
- **Trade-off:** the list stays put while the calendar moves, which suits reviewing a year. But the calendar's month
  label and the list then disagree until the user resets, and a "Back to calendar month" link is needed in the card.

## "Completed" semantics
Tommy's wording, "**completed** this year / last month / this month", reads as done sessions only.

**Recommend: the named filters (and custom range) show `done` sessions only**, newest first, each with its existing
attendance figure. That makes them history views; upcoming sessions are what the calendar and the default "Calendar
month" view are for.
- Restricted (leadership / board) events are included, exactly as the leader list includes them today. Should a filter
  be training-only? See ruling 4.
- **Trade-off:** "Completed this month" hides this month's upcoming sessions, while the default view shows the whole
  month. That's deliberate: the label says "completed". The alternative, "all sessions in range", gives custom range a
  second meaning ("what's scheduled in Dec–Feb"), which the calendar already answers.

**Period definitions** (local time, the same basis as `sessDate`):
- this month = the current calendar month;
- last month = the previous calendar month;
- this year = Jan 1 – today;
- custom = inclusive from–to.

## The control and the custom-range UI
- **Where:** the Sessions card header, left of "Edit sessions": a compact **dropdown** labelled "Show". Five options on a
  phone are too many for a segmented control, and the card head already carries a button.
  - **Trade-off:** a dropdown hides the options behind a tap, while a segmented control shows them but wraps on a phone.
- **Default:** "Calendar month", so nothing changes until someone picks a filter. Session-only state; nothing persisted.
- **Custom range (recommended):** **From / To date inputs** (`type="date"`, inclusive). The app already uses these for
  credential expiry, and they open the native picker on iOS and Android.
  - They appear inline under the card head when "Custom range…" is picked, with **Apply** disabled until From ≤ To.
  - **Trade-off vs two month pickers (Month + Year selects):** month pickers match how the named filters think (whole
    months) and can't produce a partial month, but they can't do "since the 15th". Date inputs are more flexible and
    native, at the cost of one more tap to reach whole months.
- **Empty states:** "No completed sessions this year." / "…between <from> and <to>."
- **A summary line under the head (optional):** "14 completed · average attendance 61%". It reuses the row figure. Nice
  for Tommy's purpose, but it's an extra number to verify; skip it unless wanted.

## What the build would touch (all in `TrainingSchedule`, `src/App.jsx`)
- a `listFilter` state (+ the custom from/to) and a `listSessions` derived from `sessions`. **The calendar keeps
  `monthSessions`**;
- the Sessions card maps `listSessions` (month headers in filter mode), and the row's month label moves to
  `TRAIN_MONTHS[s.m]` (plus the year when not this year);
- `goToNext`, `scheduleFor`, and the calendar's month navigation (`setCur` via `MonthCalendar`) reset the filter, per
  option A or C;
- registrations stay keyed as today (`monthSessions` + the next 40 upcoming). Completed rows don't show Register, so
  filter mode needs no extra read;
- tests: a happy-dom test (filters, the semantics, snap-back, month labels, the role matrix unchanged), with structural
  checks pinned to the release in the promote push (per the test-hygiene rule).

## Rulings needed
1. **Calendar interaction:** **A** (detach; snap back on hero / Schedule / calendar navigation) — recommended — or **C**
   (detach; snap back only on hero / Schedule, plus a "Back to calendar month" link)?
2. **Semantics:** named filters + custom range = **done only** (recommended), or all sessions in range?
3. **Control:** a **dropdown** in the card head (recommended) or a segmented control? Default "Calendar month"?
4. Include **leadership / board events** in the completed views (as the list does today — recommended), or training only?
5. **Custom range:** **From / To dates** (recommended) or From / To months?
6. The optional summary line ("N completed · avg attendance X%"): yes or no?
7. (Not Slice 3) Schedule the attendance-read paging follow-up before North Hood nears the 1000-row cap (~mid-2027)?
