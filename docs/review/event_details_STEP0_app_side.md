# Event details / combined "Fundraising & Community Events" — Step 0, app side (items 2–4), 2026-10-21

Order: `claude/B4C_EventDetails_Concept_Step0.md`. Read from **origin/main** `src/App.jsx` (theme's App.jsx differs only by the
held-back Notify Crew code, which sits after these sections — the line numbers below match on both). The DB half (item 1,
the live schemas + per-column grants, plus training's columns and any function reading these tables) is
`sql/event_details_STEP0_CHECK.sql` — Ashlea runs it, output to follow. Read-only; nothing drafted.

## Headline answers
- **No edit path today — confirmed.** Across `src/`, `api/` and `shared/` the only writes to either table are `.insert(...)`
  and `.delete()`. No `.update(` on `funding_events` or `recruitment_events` anywhere; no other file than App.jsx touches them.
- **No detail view on the Funding or Recruitment pages.** On both page calendars a chip tap **is delete** (behind
  `confirmDestructive`), for Dept Admin / Project Admin only; nobody else gets a tap action. The only detail modal these
  events reach is the **dashboard Station calendar's** (`DashboardCalendar` ~7974), which shows kind + date only.
- **`notes` is already read but never shown or written** on BOTH tables: both page calendars `select(... notes ...)` and
  carry `notes` on the item; no form writes it and no view renders it. (So `funding_events.notes` already exists per the
  app — Step 0's SQL confirms the live column; the concept doc assumed only `recruitment_events` had it.)
- **Training's time convention: `training_sessions.start_time` (a `time`, nullable) + `duration_min` (int)** — there is
  **no `end_time` on training**. Mapped `startTime: r.start_time || null` and rendered with `fmtTime(t)`
  (~22799: `new Date("1970-01-01T" + t)` → "7:00 PM"; unset → ""). So a new `start_time time` matches exactly; the concept's
  `end_time` would be the first end time in the app (training expresses length as `duration_min`) — a reviewer choice.

## 2a. The Funding page (nav key `funding`, label "Funding", LEADERSHIP — ~1783)
`Funding` (~9970) is a **hub**: `useRestorableView("funding")` → `null` = hub, `"fundraisers"` → `<Fundraisers>`,
`"donations"` → `<Donations>`. The hub is "Money in, and where it came from" (FundingOverview for donation-viewers; a
single "Fundraisers" tile otherwise). **The funding calendar is NOT on the hub** — it lives one level down inside
`Fundraisers` (~9411), titled "Plan fundraisers, write the appeals, line up sponsors". Top to bottom:
1. `FundraiserIndex` (~9154) + `FundraiserHQ` (~8246) — the fundraisers themselves (canManage only).
2. The AI **Fundraiser planner** (mode "Plan a fundraiser" → Get ideas → Build the plan → Create fundraiser) + saved drafts.
3. **EVENT IDEAS** (`FUNDRAISER_IDEAS` ~8077, collapsed; each "Plan this" seeds the planner; a "DONE <date>" pill from the log).
4. **FUNDING CALENDAR** — `<FundingCalendar key={fundingReloadKey} …/>` (~9707). The key bumps when the HQ adds dates.
5. **RECENT FUNDRAISERS** — `fundraiser_log` ("Log it").

`FundingCalendar` (~7720):
- Reads `funding_events` `id, date, title, color, notes, fundraiser_id` (failed read keeps last-known + Retry) and
  non-archived `fundraisers` (`id, name, target_date, color`) for the picker + live colour.
- Item → `{ id, y, m, d, title, c: color, notes, fundraiserId }`.
- **Add form** (canEdit = `CANMANAGE_OPS_ROLES` = Department Admin / Officer): Title · Day (of the shown month) ·
  **Part of a fundraiser** (None or a fundraiser — picking one nudges the colour to the fundraiser's) · Color swatches.
  Insert: `{ department_id: my_department_id(), title, date, color, fundraiser_id }`.
- **Chip**: colour = the fundraiser's live colour if tagged (else stored), label = title, tooltip = title + " — <fundraiser>"
  + " (tap to remove)" when canEdit; onClick = remove only when canEdit **and** canDeleteShared. (Nit: an Officer sees
  "(tap to remove)" in the tooltip but the tap does nothing — canDeleteShared is DA/PA only.)
- todayColor `#9A6B12` (amber). Footer: "N events in <Month> · tap an event to remove it".

**Other writers of `funding_events`** (all inside `FundraiserHQ`): "Add to this fundraiser" from an AI plan inserts many
rows (~8605, `{ department_id, title, date, color: frColor(fr), fundraiser_id }`); "Key dates" `addDate` (~8634) inserts
one; `removeDate` (~8646) deletes. The HQ's Key dates list is a filtered read of the same rows
(`select id, date, title … eq fundraiser_id`, ~8321). **These two writers would need the new fields too if the reviewer
wants a time/location on a fundraiser's key dates** — or they keep writing date-only rows (all-day), which stays valid.

## 2b. The Recruitment page (nav key `recruit`, label "Recruitment", LEADERSHIP — ~1782)
`Recruitment` (~6072), "Build a recruitment plan — not just a post". Top to bottom — **everything except item 4 must
stay** when its events move:
1. Three-phase framework cards (Foundation / Outreach / Convert).
2. **AI Recruitment Planner** (town, size, plan start date, what you need, key local dates → a 60-day plan rendered by
   `RecruitmentPlanView`; canManage can **Save draft** → `ai_outputs` feature `recruitment`).
3. **Ways to Recruit** idea grid (collapsed).
4. **RECRUITMENT CALENDAR** — `<RecruitmentCalendar …/>` (~6176).
5. `GraphicStudio` (the recruitment graphics tool).
6. **Saved drafts** list + open/edit modal (`ai_outputs` `current_text` edits; `ai_text` pristine).

`RecruitmentCalendar` (~7624): the twin of FundingCalendar minus the fundraiser link. Reads `recruitment_events`
`id, date, title, color, notes`; add form Title · Day · Color (canEdit = DA / Officer); insert
`{ department_id, title, date, color }`; chip label = title, tap = remove (canEdit && canDeleteShared); todayColor
green. Nothing on the page generates `recruitment_events` rows — the AI plan does **not** write events (it schedules
posts in its text only).

## 2c. Every reader of the two tables (so the combine doesn't strand one)
| where | reads | uses |
|---|---|---|
| `OfficerDashboard` snap (~4397–4400) | both: `id, date, title` | next-upcoming tiles: "Recruitment" (→ nav `recruit`) and "Fundraising" (→ nav `funding`) (~4422–4424) |
| `MemberDashboard` upcoming (~4964–4973) | both: `title, date` | upcoming list, typed "Fundraiser" / "Recruitment"; sorted by date then `startTime` (only training has one today) |
| `DashboardCalendar` (~7863–7864) | both: `id, date, title` | Station calendar sources `funding` (amber pill) and `recruit` (green pill); filter chips "Recruitment" / "Funding"; detail modal |
| `RecruitmentCalendar` / `FundingCalendar` | as above | the page calendars |
| `FundraiserHQ` key dates (~8321) | `funding_events` by `fundraiser_id` | the fundraiser's dates |
| `my_department_rollup()` (SQL) | both: `date, title` | `my_next_event_*` across training / funding / recruitment / content |
SQL item 4 lists any other function reading them.

## 2d. The chip → `{ startTime, label, color }` mapping and the detail modal (DashboardCalendar, ~7863–7995)
- Load: `mapRows(res, source, labelOf, extraOf)` → `{ source, id: "<source>-<id>", y, m, d, label, color: SOURCE_COLORS[source], tier: SOURCE_TIER[source], ...extra }`.
  Only **training** passes `extraOf` (`title`, `startTime: r.start_time || null`, `audience`, `plans`). Recruit + funding
  get `label = title` and nothing else (no `startTime`, no notes).
- Chip (~7961): `label: (it.startTime ? fmtTime(it.startTime) + " · " : "") + it.label` — **already time-aware for any
  source**: give funding/recruit rows a `startTime` via an `extraOf` and the time appears with no chip change. Colour is
  the fixed source colour (amber funding / green recruit), not the event's own stored colour. onClick → `setDetailEvent`.
- Detail modal (~7969–7995): kind label from `SRC_LABEL` (`recruit: "Recruitment"`, `funding: "Funding"`), title,
  `dateStr` + `" · " + fmtTime(startTime)` if set; training-only rows (restricted badge, View plan). **No location / notes
  / end time rendered for any source** — the new fields need lines here (and an `extraOf` for the two sources).
- `SOURCE_COLORS`: training blue, actionitem violet, recruit green, funding amber, social red; `SOURCE_RANK` / `SOURCE_TIER`
  rank funding above recruit, both "pill".

## 3. Training time flow
`training_sessions.start_time` → `startTime: r.start_time || null` at every reader (~2584 Training, ~4971 MemberDashboard,
~7884 DashboardCalendar) → `fmtTime()` / `fmtSess()` / `sessSort` (unset time sorts first). Written as
`start_time: newTime || null` (~5878, ~23388, ~23438) and **edited** via `.update({ title, date, start_time, … })` (~23575)
— the existing pattern an event edit path would mirror. Length is `duration_min`, not an end time. Training also has
`is_offsite` + `location_lat` / `location_lng` (geofence), not a free-text `location` — SQL item 3 lists the live columns.

## 4. Edit path
**None.** Add + delete only, on both tables, in every writer (the two page calendars, the HQ plan import, the HQ key
dates). An existing event cannot get a time / location / notes without a new edit affordance — the concept's
sub-decision stands.

## Notes for the reviewer (no action taken)
- The rename target: the nav label (~1783) and the `Funding` hub title live one level ABOVE the calendar. "Fundraising &
  Community Events" as a page name fits the `Fundraisers` sub-view (where the calendar is) better than the money hub —
  the hub also holds Donations. Worth deciding which surface is renamed.
- Both calendars' `canEdit` is `CANMANAGE_OPS_ROLES` (DA / Officer — Board excluded); delete additionally needs
  canDeleteShared (DA / PA). The DB side (RLS / grants, item 1) decides whether Board/PA can write directly regardless.

## Reviewer rulings (relayed 2026-10-21) — binding for the migration + UI build
- **Rename:** the calendar on the **Fundraisers** page becomes "Fundraising & Community Events". The **Funding hub keeps
  its name** (it holds Donations) — nav label "Funding" (~1783) unchanged.
- **Tap behaviour:** no more tap-to-delete. Tapping an event opens a **detail view for everyone**; **Edit + Delete live
  inside the detail, DA / PA only**. The "(tap to remove)" tooltip hint goes.
- **notes:** already on both tables — the migration adds **no** notes column; the UI starts writing + showing it.
- **end_time:** add `end_time` (nullable `time`) on both, even though training has none (a 6–9 PM range reads better).
- **location:** new nullable `text` on both (training's GPS point is not reused).
- **Editing:** in scope, in the new detail view.
- **Other writers stay date-only:** FundraiserHQ's AI-plan date import (~8605) and Key dates (~8634) keep inserting
  `{ department_id, title, date, color, fundraiser_id }` — the new fields stay optional / null there.
Next: Ashlea runs `sql/event_details_STEP0_CHECK.sql` → reviewer writes the DB migration build order → CC drafts it for
review before apply. No migration drafted, no UI touched yet.
