# B4C — Step 0: Funding / Events redesign (read-only audit + design options)

**CC, 2026-10-27. NO SQL applied, NO code.** For Claude's review; nothing is built until Ashlea rules. Concept: [[B4C_FundingEvents_Redesign_Concept_ForStep0]] (supersedes [[B4C_FundingCalendar_Surface_BuildOrder]] — not built). Post-3.2; does not gate the no-length card fix or build 17.

Evidence:
- Code: main @ `65249db` (`src/App.jsx`, `shared/roles.js`).
- Live DB, two read-only queries run 2026-10-27:
  - `docs/review/funding_events_STEP0_audit.sql` → `funding_events_STEP0_OUTPUT.json`
  - `docs/review/funding_events_STEP0_audit2.sql` → `funding_events_STEP0_OUTPUT2.json`
- Baselines for later migrations: **total_policies 175 · verified_presence 957**. Gate md5s are in OUTPUT.json → `gate_fns`.

---

## 1. What exists today (facts)

### 1a. The Funding page
- **Who can reach it.** Nav `funding` is `roles: LEADERSHIP` (PA / DA / Board / Officer) — `App.jsx:1784`. **Members never reach the Funding page.**
- **`Funding` (`:10074`)** is a hub with three views: `null` (the hub), `fundraisers` and `donations`.
  - `canManage` roles (Board / DA / Officer) see `FundingOverview` (`:9904`). It contains:
    - 4 stat chips;
    - a **Funds** card;
    - a **Fundraisers** card, whose header link "Funding calendar ›" just runs `setView("fundraisers")` (`:9996`);
    - a **Donation tracker** card.
  - PA sees a single tile instead.
- **There is no calendar on the hub.** `EventsCalendar` has exactly one mount, inside the `Fundraisers` sub-view (`:9811`), under "FUNDRAISING & COMMUNITY EVENTS".
  - It is remounted by `fundingReloadKey`, which the HQ bumps when Plan-to-work adds dates.

### 1b. `EventsCalendar` (`:7738`) — one calendar over two tables (bf2716f)
- **Kinds.** `EVENT_KINDS` (`:7686`) maps the two kinds to the two tables:

  | Kind | Table | Accent |
  |---|---|---|
  | `fundraiser` | `funding_events` | amber |
  | `community` | `recruitment_events` | green |

- **Reads.**
  - Both tables are read in parallel with the same columns (`id, date, title, color, notes, start_time, end_time, location_label`, plus `fundraiser_id` on funding).
  - Each row is tagged with its kind and keyed `${kind}-${id}`.
  - Non-archived `fundraisers` are read for the "Part of a fundraiser" picker.
  - On error it keeps the last-known rows and offers Retry.
- **The type toggle today.**
  - `blank()` **defaults to `kind:"fundraiser"`** (`:7796`).
  - `kindToggle` (`:7854`) is a 2-button segmented control at the top of the add form.
  - **The kind can't be changed on edit**, because a change would mean moving the row to the other table.
- **Gates.**
  - Add and edit: `CANMANAGE_OPS_ROLES` (DA / Officer), which matches live `is_canmanage_ops()`.
  - Delete: additionally needs `useCanDeleteShared()` (in practice, DA).
  - Edit and delete both check the row count (0 rows = a refusal, not silent).
- **Other readers of the two tables:**
  - `DashboardCalendar` (`:7954`) reads `id, date, title` only. It is mounted on **every** dashboard: Board `:4019`, DA `:4171`, Officer `:4492`, Member `:5140`. **This is where members see community events today.**
  - The dashboard tiles (`:4431`, `:4457`, `:4999`).
  - The HQ Key dates (`:8425`).

### 1c. Live tables (2026-10-27)

| Table | Rows | Shape | Read | Write |
|---|---|---|---|---|
| `funding_events` | 1 (Indian Harbor) | title, date, color, notes, source_label, **fundraiser_id** → fundraisers (SET NULL), start/end_time, location_label | dept members | `dept AND is_canmanage_ops()` (I/U/D) |
| `recruitment_events` | 6 (North Hood 5, Lipan 1) | title, date, color, notes, start/end_time, location_label. **No type, no FK in or out** | dept members | `dept AND is_canmanage_ops()` (I/U/D) |
| `fundraisers` | 2 (1 active, 1 archived) | name, description, target_date, goal_amount, status (planning/active/done/archived), point_person_id, campaign_id, proceeds, color, shared_with_station; UNIQUE(id, department_id) | **canmanage only** (`fundraisers_leadership` FOR ALL, `dept AND is_canmanage()`) | same |
| `fundraiser_sponsors` | 0 | composite FK (fundraiser_id, department_id) → fundraisers, CASCADE | canmanage | canmanage |
| `action_items` | 16 (14 from minutes, 2 no source; **0 with fundraiser_id**) | text, assigned_to, due_date, status (open/done/cancelled; no CHECK), source_label, source_output_id → ai_outputs, **fundraiser_id** → fundraisers, station_visible, completed/cancelled audit | leaders (`is_leader() AND dept`) + **own assigned** (`assigned_to = my_member_id()`) | INSERT `is_canmanage() AND dept`; **no UPDATE/DELETE policy**, so status changes go through DEFINER RPCs `complete_ / reopen_ / cancel_action_item` (all `is_canmanage()` + dept) |
| `session_registrations` | 27 | session_id → **training_sessions** (CASCADE), member_id, status coming/maybe/not_coming, UNIQUE(session, member) | own row + dept leaders (`session_reg_is_leader()`) | **no table grants**; only `set_my_session_registration()` (self-only DEFINER) |
| `events` (legacy) | 3, all Demo dept | name, date *text*, type, present, total | dept | none. **Unrelated** — old attendance summaries. Avoid the name `events` for anything new |

- **Live gate functions — all four are department-scoped.** `is_leader`, `is_canmanage` (Board/DA/Officer), `is_canmanage_ops` (DA/Officer) and `session_reg_is_leader` all require `members.department_id = my_department_id()`. This confirms the [[fundraiser-rls-role-anywhere-fastfollow]] memory: the "role-anywhere" note in `station_fundraiser_2026-10-15.sql` is stale.
- **Station sharing.**
  - `set_fundraiser_shared` and `set_fundraiser_step_visible` are DEFINER writes, dept-scoped, Board/DA/Officer.
  - `set_fundraiser_step_visible` **refuses any item without a fundraiser_id**.
  - `get_station_fundraisers()` is what `StationFundraiserCard` (`:3892`) reads. It gives members counts plus at most 3 ticked open steps, and never money, donors or sponsors.

### 1d. FundraiserHQ (`:8350`) — what "running like a fundraiser" actually means

| Fundraiser has | Stored as |
|---|---|
| A container with status, a point person, goal and proceeds | `fundraisers` row |
| **Jobs** (owner, due, done/cancel/reopen) | `action_items.fundraiser_id` — direct `.insert` (`:8469`, `:8705`) + the 3 lifecycle RPCs |
| **Key dates** | `funding_events.fundraiser_id` (`:8727`) |
| **Docs** (AI letter / CTA, pasted or uploaded plan) | `ai_outputs` feature `fundraiser` + `fundraiser_id` |
| Sponsors | `fundraiser_sponsors` |
| **Plan to work** (AI) | `OPERATIONALIZE_SYS` (`:8262`) returns `{action_items[{task, suggested_owner, suggested_due_date}], calendar_events[{title, date}]}`. After review, `addWork` (`:8689`) inserts both. It sets `fundraiser_id` + `source_label`, **not** `source_output_id` |
| Share with the station | `shared_with_station` + `station_visible` steps |

> **The premise needs a correction.** The concept says community events should gain sign-ups and needs "the way a fundraiser already works". **Fundraisers have no sign-ups and no needs either.**
> - There is no volunteer, slot, shift, claim or coverage structure anywhere in the code or DB.
> - `PLAN_SYS` only asks the AI to *mention* "roles/volunteers needed" in the plan text.
> - The only people fields are `point_person_id` and `action_items.assigned_to`.
>
> So what a community event can reuse from fundraisers is **jobs (action items), sharing and the HQ layout**. **Needs + sign-ups are new for both**, and should be designed so a fundraiser's event day can use them too (see FE5).

### 1e. Sign-up primitives
- **The only one is `session_registrations`. It isn't reusable as a table** for three reasons:
  1. It has a hard FK to `training_sessions`.
  2. Its status set is attendance *intent* (coming / maybe / not_coming), not a commitment to a role.
  3. Its RLS hides other members' rows.
- **What should be reused is its pattern:**
  - no table write grants;
  - a self-only DEFINER RPC that checks dept + eligibility + "not past/closed";
  - the `useSessionRegistrations` hook shape (`:23526`): `rows, err, busyId, setMine, mine`.

---

## 2. Design options + recommendations

### FE1 — Calendar on the Funding landing page (UI only)
- **Rec: move the single `EventsCalendar` mount to the top of the hub, directly under the stat chips and above the Funds / Fundraisers / Donation tracker cards.**
  - Use a compact month grid by default.
  - Show it for **everyone who reaches Funding**, including PA's tile layout. Both event tables are dept-readable, and add/edit stays DA/Officer.
- **Remove it from the `Fundraisers` sub-view.** One mount, so the bf2716f one-calendar design holds.
  - The `fundingReloadKey` remount becomes free, because the hub remounts when you come back from an HQ.
  - Keep the bump for an HQ opened *from* the hub.
- **Retire the "Funding calendar ›" link.** The Fundraisers card link becomes "All fundraisers ›".
- **Performance.** The calendar does 3 small unbounded reads (live: 2 fundraisers, 1 + 6 events), which is fine today.
  - Recommend a ±13-month date window as a cheap follow-up, not a blocker.
  - Rows are cached across the month nav, so there's no refetch per month.
- **Alternative (not recommended):** keep the calendar in `Fundraisers` and add a compact "next 3 events" strip on the hub. That doesn't meet Ashlea's ask "visible on the page".
- **Naming (ruling).** The page now hosts community events, which are not funding. Options:
  - (a) rename the nav "Funding & Events";
  - (b) keep "Funding" and give the calendar the header "Fundraising & community events" (today's label).
  - **Rec (a).** It's a label change only; the nav key `funding` stays, so restored views don't break.

### FE2 — Event-type picker on add
- **Options:**
  - (a) A first-step **type picker that routes between the two existing tables**. No DB change.
  - (b) (a) plus **community subtypes**: a nullable `recruitment_events.event_type` with a CHECK list, so it stays one table.
  - (c) Merge the tables into one `events` table with a type. **Rejected**: it breaks bf2716f's "nothing merges in the DB" and the HQ's `funding_events.fundraiser_id` Key dates, collides with the legacy `events` table, and needs a data move for no user-visible gain.
- **Rec: (a) now; (b) only if Ashlea wants subtypes to *do* something** (filter, colour, a default needs template). Labels alone can live in the title.
- **Picker shape (a).** "Add an event" opens 2–3 large tiles instead of the segmented toggle. There is **no default kind** (today it silently defaults to Fundraiser).
  1. **Fundraiser event** — a dated event that is part of a fundraiser. Shows the "Part of a fundraiser" select. (Ruling FE2.1: required, or optional as today? **Rec optional**, as today — a one-off fundraising date shouldn't need a fundraiser created first.)
  2. **Community event** — open house, booth, school visit, parade…; green.
  3. *(Optional)* **Start a new fundraiser ›** — this isn't an event row; it hands off to the fundraiser create flow. It makes clear that a fundraiser is a *container*, not a date.
- **Proposed subtype list for (b):** open_house · booth · school_visit · parade · community_safety · other. Ashlea to confirm or edit. CHECK-constrained, nullable (existing 6 rows stay NULL = "Community event").
- **Changing kind on edit stays unsupported**, since it's a cross-table move. Show a one-line hint: "Wrong type? Delete it and add it again." A move RPC is a later option if asked for.

### FE3 — What a community event must gain (the matrix)

| Capability | Fundraiser today | Community event today | Proposal |
|---|---|---|---|
| Container / detail view | `fundraisers` + HQ | a modal with edit/delete | **Event detail panel** ("Event HQ-lite"): details, Needs & coverage, Jobs. The **event row itself is the container**, with no new parent table (FE4) |
| Jobs | `action_items.fundraiser_id` | none | **Reuse `action_items`**: + `recruitment_event_id` FK (FE6) |
| Needs / staffing | none | none | **New** `event_needs` (FE5) |
| Sign-ups | none | none | **New** `event_need_claims` + RPCs (FE5) |
| Docs / AI plan | `ai_outputs` + Plan to work | none (Recruitment planner = social-post text only, `:6120`) | Later slice (FE7) |
| Share with station | shared flag + visible steps | already dept-readable; on every dashboard calendar | Needs are visible to members by design (FE8); no share flag needed |
| Sponsors / money | yes | n/a | no |

### FE4 — Container: event row vs a new parent
- A fundraiser is a multi-date container; a community event is a single dated occurrence.
- **Rec: hang needs and jobs directly off the event row** (`recruitment_events.id`). There is no "community campaign" table.
- If a multi-day outreach series is ever wanted, it's a later container, like fundraisers.

### FE5 — Needs + sign-ups (the heart of the ask) — proposed data model

**`event_needs`** (new)
- Columns:
  - `id uuid PK`, `department_id uuid NOT NULL`
  - `recruitment_event_id uuid NULL`, `funding_event_id uuid NULL`, with **CHECK exactly one non-null** (ruling FE5.1, below)
  - `role_label text NOT NULL` (e.g. "Engine crew for display", "Kids' table", "Setup")
  - `slots_needed int NOT NULL CHECK (slots_needed BETWEEN 1 AND 50)`
  - `start_time time NULL`, `end_time time NULL` (a shift inside the event day; NULL = the whole event)
  - `notes text`, `sort int DEFAULT 0`, `created_by uuid`, `created_at timestamptz`
- FK each parent with `ON DELETE CASCADE`.
  - Dept integrity follows the `fundraiser_sponsors` composite-FK pattern: `(event_id, department_id) → event(id, department_id)`.
  - **That needs `UNIQUE(id, department_id)` added to `recruitment_events` and `funding_events`.** This is additive and harmless, and `fundraisers` already has it.
- RLS:
  - SELECT: `dept` (members must see what's needed).
  - INSERT / UPDATE / DELETE: `dept AND is_canmanage_ops()`, which **mirrors the event tables' own write gate exactly**, so no policy is wider than its parent.
  - Grants to `authenticated` only (no anon).

**`event_need_claims`** (new — the sign-ups)
- Columns: `id`, `department_id`, `need_id → event_needs ON DELETE CASCADE`, `member_id → members`, `claimed_by uuid` (self vs a leader assigning), `created_at`, `UNIQUE(need_id, member_id)`.
- **No table write grants. Writes go through DEFINER RPCs only** (the session_registrations pattern; REVOKE from anon/public, GRANT to authenticated, per [[anon-execute-revoke-pattern]]):
  - **`claim_event_need(p_need_id)`** — self only.
    - Checks: dept match; caller is an Active/Probationary member; event date ≥ today (America/Chicago, the same clock as `get_station_fundraisers`); not already claimed.
    - **Capacity:** take the need row `FOR UPDATE`, count claims, refuse `FULL:` when `claims >= slots_needed`. This makes the last slot race-safe.
  - **`unclaim_event_need(p_need_id)`** — self; refused after the event date.
  - **`assign_event_need(p_need_id, p_member_id)` / `remove_event_need_claim(p_claim_id)`** — `is_canmanage_ops()` + dept; the assignee must be in the dept. Leaders can fill a slot for someone who isn't on the app.
- **Coverage = computed, not stored.**
  - Per need: `claims / slots_needed`. Per event: Σclaims capped per need / Σslots → **"3 of 5 covered"**, with states red (0), amber (partial) and green (full).
  - Rec: compute it on the client from two reads (needs + claims for visible events). A view or RPC is only worth adding if the dashboard needs coverage for many events at once.
  - Over-claim is impossible by RPC, so capping is a display safeguard only.
- **Who sees names (ruling FE5.2).**
  - Options: (a) **every member sees who claimed what** (rec — crews coordinate, and it's the point of "who's covering"); or (b) leaders + own row only (the session_registrations choice).
  - **Rec (a)**: SELECT `dept` on claims.
- **Ruling FE5.1 — fundraiser event days get needs too?** Rec **yes**, via the `funding_event_id` arm.
  - The fundraiser BBQ day is exactly where volunteers are needed.
  - It costs one nullable column + one CHECK, and it avoids a second needs table later.
  - The alternative is community-only now, adding the arm later (an additive migration).
- **Deliberately not proposed:**
  - an event-level "I'm coming" RSVP (a "General help ×N" need covers it);
  - waitlists;
  - claim-time notifications (Notify stays held; see FE9);
  - any link to attendance / `station_presence` (**`verified` untouched**: community-event sign-ups are *not* attendance).

### FE6 — Action items on community events
- **Options:**
  - (a) **`action_items.recruitment_event_id uuid → recruitment_events ON DELETE SET NULL`**, mirroring `fundraiser_id`. The client inserts directly, and the existing lifecycle RPCs work unchanged (they key on id + dept, not on the parent).
  - (b) Link through `source_label` text only. Weak: no reliable "jobs for this event" query.
  - (c) Generic `(parent_type, parent_id)`. No FK, and it breaks the existing `fundraiser_id` readers.
- **Rec (a).**
- **Gate mismatch to rule on (FE6.1).**
  - `action_items` INSERT is `is_canmanage()` (**Board** / DA / Officer). Community-event writes are `is_canmanage_ops()` (DA / Officer).
  - So, at the DB, a Board member could add a job to an event they can't edit.
  - **Rec: no policy change.** Gate "Add job" on the client at `CANMANAGE_OPS_ROLES` for event jobs. Board already writes fundraiser jobs, so the DB gate is consistent with the existing action-items model.
- **Members** see a job only when it's assigned to them (existing RLS). Their task push already fires via `trg_action_item_assigned` (it exists and is not Notify-crew).
- **Station-visible event jobs:** not proposed. `set_fundraiser_step_visible` refuses non-fundraiser items, and widening it is an RPC change with no ask behind it.

### FE7 — AI "operationalize" for events
- **Rec: hand-added needs and jobs in the first slices.**
- A later slice can add "Plan this event" reusing `OPERATIONALIZE_SYS`, extended with `needs:[{role, count}]`, and the same review-then-write screen.
- Note: AI calls only work on the deployed site ([[ai-calls-fail-on-localhost]]).

### FE8 — Where members sign up
- Members can't reach Funding (LEADERSHIP nav), but **every dashboard already shows community and fundraiser events** via `DashboardCalendar`.
- **Rec:**
  - (1) The `DashboardCalendar` event detail gains the needs list + Sign up / Can't make it.
  - (2) A **"Needs hands"** dashboard card, modelled on `StationFundraiserCard`: the next upcoming events with open slots, coverage, and one-tap claim.
- Leaders get the same, plus the editor, in the Funding hub's event detail.

### FE9 — Invariants + policy flags
- **No existing policy is widened.** The new tables' write gates equal their parent's (`is_canmanage_ops`); claims are RPC-only.
- **Additive DDL only:**
  - 2 new tables;
  - `action_items.recruitment_event_id` (+ `funding_event_id` arm on needs only);
  - `UNIQUE(id, department_id)` on the 2 event tables;
  - optional `recruitment_events.event_type`.
- Migration discipline: pinned md5s for the gate fns + `my_department_rollup`, PGlite dry run, SENTINEL role-switched RETEST, ending with `NOTIFY pgrst,'reload schema'`.
- **`verified` untouched; Notify held** (no `api/notify-session.js`, no claim pushes).
- **Pre-existing, not for this effort** (for the RLS-normalization pass, [[session-attendance-select-policy-roles]]):
  - `anon` holds full table grants on `funding_events`, `recruitment_events`, `action_items`, `events` and `fundraiser_log`.
  - RLS still blocks anon, since every policy needs `my_department_id()`. But `leaders can read action_items` and the `events` SELECT policy are `{public}`, not `{authenticated}`.
  - The new tables must not copy this.
- **Stale repo docs found:**
  - `schema.sql:1260-1279` still shows role-array policies on `recruitment_events`; live is `is_canmanage_ops()`.
  - `schema.sql:1054` shows a "leaders can read fundraisers" policy; live has only `fundraisers_leadership`.
  - The `fundraiser_hq_slice1_schema.sql` header says "NOT YET APPLIED", but it is live.

---

## 3. Proposed slicing (each: Step 0 ✓ → DB → UI → gate review → coordinated ship)

| Slice | Contents | DB? |
|---|---|---|
| **FE-A** (UI) | FE1 calendar on the hub (+ optional nav rename) · FE2(a) type picker tiles, no default kind | none — can ship first |
| **FE-B-DB** | `event_needs`, `event_need_claims`, the 4 RPCs, `action_items.recruitment_event_id`, the `UNIQUE(id, department_id)` pair, optional `event_type` | yes |
| **FE-B-UI** (leaders) | Event detail: Needs editor + coverage chip · Jobs list (insert + the existing lifecycle RPCs) · coverage on calendar chips · delete confirm names the sign-ups it removes | — |
| **FE-C-UI** (members) | DashboardCalendar detail sign-up · "Needs hands" card | — |
| FE-D (later) | Plan-this-event AI · notifications once Notify is unblocked · ±13-month read window | — |

## 4. Rulings needed from Ashlea

| # | Question | CC rec |
|---|---|---|
| FE1 | Calendar at the top of the Funding hub, single mount (removed from the Fundraisers sub-view)? | Yes |
| FE1.n | Rename the nav "Funding & Events"? | Yes (label only) |
| FE2 | Picker routes between the 2 tables; community subtypes as a column only if they drive behaviour? | (a) now; subtypes optional |
| FE2.1 | "Part of a fundraiser" required for fundraiser events? | Optional |
| FE2.2 | Subtype list, if (b) | open_house · booth · school_visit · parade · community_safety · other |
| FE4 | Needs and jobs hang off the event row (no new container)? | Yes |
| FE5.1 | Fundraiser event days get needs too (the `funding_event_id` arm)? | Yes |
| FE5.2 | Every member sees who signed up for what? | Yes |
| FE5.3 | Leaders can assign a member to a need? | Yes |
| FE5.4 | Sign-up / withdraw closes on the event date (Chicago)? | Yes |
| FE6 | `action_items.recruitment_event_id`; event "Add job" client-gated to DA/Officer, DB gate unchanged? | Yes |
| FE7 | AI plan-this-event deferred to FE-D? | Yes |
| FE8 | Member sign-up on the dashboard calendar + a "Needs hands" card? | Yes |
