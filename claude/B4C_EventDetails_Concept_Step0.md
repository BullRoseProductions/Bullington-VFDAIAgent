# B4C — Fundraising & Community Events: one calendar + event details — Concept + Step 0 — for CC

**What Ashlea asked for (Oct 21):** two changes that ship together on the Funding area:
1. **Combine into one calendar.** Rename the **Funding** page to **"Fundraising & Community Events"** and show ONE calendar that unions the fundraiser events (`funding_events`) with the community/outreach events (`recruitment_events`, today on the Recruitment page). **No data migration** — the two tables stay separate underneath; the UI unions them for display and the add form routes to the right table by a type toggle.
2. **Event details.** Every event (both kinds) gains a **start time, end time, location, and description/notes** — today the add form is only Title · Day · Color (· Fundraiser).

Content/social calendar stays out of scope.

**Why the DB side is low-risk:** these events are written **directly to the table** by the client (`supabase.from("funding_events"/"recruitment_events").insert(...)`), governed by RLS + column grants — not definer RPCs. The combine is **UI-only** (no table change); the details are **additive nullable columns**. All new columns nullable → every existing event unaffected (no time = all-day, as today). The calendar is already time-aware (the chip uses `it.startTime`, the dashboard "next event" shows `fmtTime(startTime)` for training), so a start time slots in.

---

## STEP 0 — pull live before the migration + UI (schema.sql is ~5 months stale)

Read-only, paste back:
1. **`funding_events` + `recruitment_events`** — full live columns/types/constraints, RLS on?, every policy (SELECT/INSERT/UPDATE/DELETE), and **column-level grants for `authenticated`** (which columns are insertable/updatable — the cert Step 0 showed per-column grants here, so I need to know if a new column is client-writable by default or needs an explicit GRANT). Confirm `funding_events` has no time/location/notes columns and `recruitment_events` already has `notes`.
2. **The two pages' UI structure** (so the UI slice can union + rename cleanly):
   - The **Funding page**: how its calendar is built/rendered, the `addEvent` insert + the event detail view, the "part of a fundraiser" wiring, and the "Event ideas" block.
   - The **Recruitment page**: its `recruitment_events` calendar + `addEvent`/detail, AND its recruitment-PLAN generator / outreach tools (what else lives on that page that must stay when its events move to the combined calendar).
   - How a calendar **chip** maps an event into `{ startTime, label, color, ... }` (App.jsx ~7961) and the **detail modal**, so both event types render consistently with a time.
3. **How a training event's time flows** — the `training_sessions` time column name (`start_time`? `starts_at`?) and where it becomes `it.startTime`, so the new columns match the app's convention.
4. **Any edit path** for these events today (looks like add + delete only — confirm).

---

## Proposed design (sketch — finalize after Step 0)

**DB (additive, nullable; no table merge):**
- `funding_events` → add `start_time time`, `end_time time`, `location text`, `notes text`.
- `recruitment_events` → add `start_time time`, `end_time time`, `location text` (**`notes` exists** — reuse).
- Keep `date date` as-is (the calendar reads `.date`); time is a **separate nullable `time`**, matching training. Ensure `authenticated` can INSERT/UPDATE the new columns (per-column GRANT if Step 0 shows restrictive column grants). RLS row policies unchanged. `verified` untouched. Standard discipline (preconditions: columns absent; post-conditions: exactly the new columns + types, policies/grants correct, re-run-safe).

**UI — the combine:**
- Rename the page/nav label **Funding → "Fundraising & Community Events"**.
- One calendar that **unions** `funding_events` + `recruitment_events`, each event visually tagged by kind (color already distinguishes; add a small "Fundraiser"/"Community" label on the detail). Reads both sources; nothing merges in the DB.
- **Add-event form gains a type toggle:** *Fundraiser* (→ `funding_events`, keeps "Part of a fundraiser") or *Community event* (→ `recruitment_events`). Plus the new fields for both: **Start time, End time, Location, Notes** (all optional — a quick date-only add still works).
- **Chip** shows the start time; **detail** shows kind + time range + location + notes.
- **OPEN DECISION (flag to Ashlea):** what happens to the **Recruitment page's** events calendar once community events live on the combined calendar? Proposed default: the Recruitment page keeps its recruitment-plan/outreach tools, and its events calendar becomes either a filtered view of the same `recruitment_events` or a link to the combined calendar — so there's **one place to add/see events**, no duplicate source. Confirm before the UI build.
- **Editing (sub-decision):** these events have no edit path today (add + delete only). Recommend a small **edit** affordance so a time/location can be put on an *existing* event — otherwise the feature only helps new ones. Confirm scope.
- End-time validation: if both set, end ≥ start.

## Sequence
1. **Step 0** (read-only) — CC pulls the items above.
2. **DB migration** — additive columns + grants; I write it from Step 0, CC drafts, I gate-review PASS before apply.
3. **UI slice** — the combined "Fundraising & Community Events" calendar + type toggle + new fields + detail (+ edit, if confirmed), delivered as a diff for review, then promote. (The combine resolves the Recruitment-page open decision above first.)
