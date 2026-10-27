# B4C — Training Library (self-updating, cross-department) — STEP 0 (read-only audit + design options; no code)

Direction: [[B4C_TrainingLibrary_Concept_ForStep0]] (Ashlea, Oct 27). **Nothing is built until Ashlea rules.**

**Sources:**
- the code on **main `65249db`**;
- one **read-only** live query: `docs/review/training_library_STEP0_audit.sql` (SHA-256 `aeacebe0…`), output in
  `docs/review/training_library_STEP0_OUTPUT.json`.
- The repo has **no SQL** for `drill_plans` or its RPCs (they came from AI-drafting Slice A, applied by hand). Everything
  below about them is read from the live database, not from files.

---

## TL;DR — what the audit found

1. **A "Training Library" screen already exists, and it's a facade.**
   - It's the nav item `library` (`App.jsx:1773`), rendered by `Library` (5165) and `Packet` (5248): spotlight, track
     shelves, search.
   - Its content is **6 hard-coded packets** (`SEED`, 434; tracks Fire / EMS / Leadership / Operations), held in
     `useState(SEED)` (2381).
   - **Content Admin → "Publish a packet"** (`Admin`, 26836; Project Admin only) **only prepends to in-memory React
     state.** Nothing is persisted, and a "published" packet vanishes on reload.
   - "Request a custom packet" promises "the next **monthly drop**", which has no mechanism behind it.
   - So Ashlea's "Training Library" collides with a name, and a promise, the app already makes. **Ruling L0.**
2. **The department drill library is built but empty.**
   - `drill_plans` holds **0 rows in all 5 departments**, and **no session has ever been attached from it**
     (`session_plans.drill_plan_id` set on **0** of 39 rows).
   - So there's **no "used" data for library drills yet**.
   - The real plan usage today is **`session_plans`**: 39 rows (30 AI text, 9 uploads), **22 of them on finalized,
     attended sessions**. Those were attached directly, not through the library.
3. **Every training table is department-scoped, and there's exactly one global-catalog precedent to copy.**
   - `drill_plans`, `session_plans` and `training_plans` all read `department_id = my_department_id()`.
   - The repo snapshot's "`training_plans` is a shared library across departments" comment is **stale**: live, it's
     department-only.
   - The **only** cross-department read is **`standard_cert_types`**: a global table with **no `department_id`**, RLS
     `SELECT … USING (true)`, no write policy (seed-only), and a SECURITY DEFINER `add_standard_cert_type()` that **copies
     a row into the caller's own department** as an independent row.
   - **That is the shape the shared library should take:** a separate catalog + "pull a copy", never a widened
     department policy.
4. **The scheduled AI drop has half a precedent.**
   - **Vercel cron precedent:** `/api/digest` (weekly, Mon 12:00 UTC) and `/api/pulse` (hourly), both behind
     `CRON_SECRET`, using the service-role client, looping departments in code.
   - **Server-side Anthropic precedent:** `/api/claude.js`, `api/assistant.js`, `api/concepts.js` (`claude-sonnet-4-6`,
     `ANTHROPIC_API_KEY`), but all are **user-session-gated**. **No scheduled job calls the AI today.**
   - **`pg_cron` is enabled** (one job, `auto-close-stale-shifts`, every 20 min). But there's **no `pg_net` / `http`
     extension**, so **the database can't call Anthropic.**
   - The AI drop therefore belongs in a **new Vercel cron route**, not `pg_cron`.
5. **Item 3 (schedule-aware recommendations, §7): the metadata to match "overdue → packet" doesn't exist yet. Tagging
   is new.**
   - Packets have only a coarse `track`.
   - `drill_plans.category` is the category's *name* as free text.
   - Most live categories are buckets ("Fire Training", "Meeting"), not topics.
   - The overdue clock (`dueInfo` + `reconcile`) is client-only. Live it flags **0 of 15** categories, and only 10
     finalized sessions are category-linked.
   - **Recommendation:** a small shared topic taxonomy + a topic clock, rules-first; user-initiated AI drafts only for
     uncovered gaps.

---

## 1. `drill_plans` as it is live

**Columns:**
- `id`, `department_id` NOT NULL (FK → departments, cascade), `title` NOT NULL, `category` (free text, not an FK),
  `duration_min`, `audience` (free text), `content` jsonb NOT NULL;
- `status` (`draft | approved`, default draft), `source` (`ai | manual`, default ai);
- `created_by`, `approved_by`, `approved_at`, `updated_by`, timestamps.
- CHECKs: title non-blank, content is an object, duration > 0, plus the two enums.

**`content`** (from the UI): `summary`, `objectives[]`, `run_of_show[{t,d}]`, `materials[]`, `safety[]`.

**RLS:** on, with **one** policy, `members read drill_plans`: SELECT to authenticated USING
`department_id = my_department_id()`.
- No write policy. Table grants are the Supabase default (ALL to anon / authenticated), but RLS with no write policy
  blocks every direct write.

**The RPCs** (all SECURITY DEFINER, anon no / authenticated yes):

| RPC | Gate | Does |
|---|---|---|
| `dept_drill_plans()` | department only | Lists the department's plans + `attached_sessions` = count of `session_plans.drill_plan_id = p.id` (**any** session state). |
| `set_drill_plan(p_id, …, p_source)` | `is_training_manager()` + own department | Create (draft) / edit (keeps status + source). |
| `approve_` / `unapprove_` / `delete_drill_plan` | `is_training_manager()` + own department | Delete sets `session_plans.drill_plan_id` to null via the FK; attached copies keep their text. |
| `attach_drill_plan_to_session` | `is_training_manager()` + own department; Slice 7 refuses a cancelled session | Writes a **copy** (`session_plans` row, `source='ai'`, `ai_text` serialized, `drill_plan_id` set). |

**Plans vs the Library, as the code stands:**
- **Training Plans** (the toggle's second tab) = the department's **own, editable** recurring categories (`training_plans`)
  + its drill plans (`drill_plans`): draft → approve → attach.
- That's a **workspace**, owned by the department. The new Library is best defined as the opposite: a **read-only
  catalog you pull *from***.

## 2. What "used" means — Ruling L3
- **The real signal:** a library drill **attached to a session that was finalized and attended**:
  `session_plans.drill_plan_id = X` joined to `training_sessions.done`, `status <> 'cancelled'`, and ≥ 1
  `session_attendance` row.
- `attached_sessions` today counts **any** attachment, including upcoming and later-cancelled ones, so it overstates
  "used". **Recommend "used" = held (done + attended + not cancelled).**
  - Alternatives: "attached" (cheaper, noisier); "held N times across M departments" (for the shared pool).
- **For the shared pool,** usage has to survive the copy. A pulled drill becomes the department's **own** `drill_plans`
  row, so the catalog needs a link from that copy back to its catalog row.
  - That means a nullable `drill_plans.library_id` (new column), mirroring how `cert_types` relate to
    `standard_cert_types`.
  - "Used by N departments" is then a SECURITY DEFINER **count** over held sessions grouped by department. It returns
    **counts only**, never which department or who.
- **Data reality:** 0 library drills are used today, so the "shared, used" feed starts **empty** and fills only as
  departments run drills from the library.
  - The 22 attended sessions with directly attached plans aren't library drills. Back-filling them would mean
    harvesting other departments' attached text without consent, which I don't recommend.

## 3. Cross-department sharing — the hard part (Rulings L4–L6)

**Recommended shape: a separate global catalog + snapshot copies.** No department policy changes; `drill_plans`,
`session_plans` and `training_plans` RLS stay byte-identical.

**`library_drills`** (global; no `department_id`), following the `standard_cert_types` pattern:

| Part | Detail |
|---|---|
| Columns | `id`, `title`, `category`, `duration_min`, `audience`, `content` (a **snapshot**, never a live link), `origin` (`ai_drop` / `shared` / `seed`), `origin_department_id` (nullable; **not exposed** unless the department opts into credit), `credit_name` (opt-in display), `state` (`submitted` / `published` / `withdrawn`), curator id / time, a `content_hash` (dedupe) |
| Read | RLS `SELECT TO authenticated USING (state = 'published')`. `origin_department_id` stays unexposed via a column grant (the Slice 7 signature trick). |
| Writes | RPC-only |

**Flows:**
- **Share (opt-in, per drill)** — `share_drill_plan(p_id)`:
  - gated `is_training_manager()` + own department + the plan **approved**;
  - submits a **scrubbed snapshot** as `submitted`;
  - the UI shows the officer exactly what will be shared, and warns about local names, addresses and apparatus IDs in
    the text.
- **Curate** — a **platform curator** publishes, edits or withdraws.
  - Recommend **Project Admin** (it already owns the global "Content Admin" surface); only published drills are
    readable.
- **Pull** — `pull_library_drill(p_id)`:
  - gated `is_training_manager()`;
  - copies the drill into the caller's `drill_plans` as a **draft** (their officer approves before use), with
    `library_id` set.
  - **`drill_plans.source` would gain `library`** (a pinned CHECK change), so pulled drills stay distinguishable from
    `ai` / `manual`.
- **Dedupe:** a `content_hash` on normalized title + content refuses an exact re-share; the curator merges near-duplicates.
- **Attribution:** "Shared by <department>" only when the department opts in (`credit_name`). "Held N times in M
  departments" from the counts-only RPC.

**Rulings:**
- **L4 — who curates:** Project Admin (recommended). Alternative: any DA can publish their own share directly; faster, but
  no cross-department quality gate.
- **L5 — what's shared:** a snapshot at share time (recommended). Edits in the sharing department don't propagate; they
  re-share. Alternative: a live link, which needs per-version history and is messier.
- **L6 — attribution:** opt-in department credit (recommended) vs always anonymous vs always credited.

**Risks:**
- Touches **no** existing policy and **nothing** `verified`-related; no `station_presence`.
- The one new global surface is `library_drills`, and it's **read-only, published-only**.
- The `origin_department_id` column must never be selectable.

## 4. The auto AI drop — cadence + mechanism (Ruling L7)

**Mechanism: a new Vercel cron route** (say `/api/library-drop`) on the `digest` / `pulse` pattern:
`CRON_SECRET` bearer, the service-role client, `?dry=1`.
- It calls Anthropic **server-side** with `ANTHROPIC_API_KEY`, using the existing `DRILL_PLAN_SYSTEM` prompt. Move that
  into `shared/` so the client and the cron use one copy.
- It writes **`library_drills` rows as `submitted`**, never `published`.
- **Not `pg_cron`:** there's no `pg_net` / `http` extension, so the database can't reach Anthropic. Adding one is a
  heavier change than a route.

**Into whose library:** recommend **the shared pool, unpublished**. One generation per drop, reviewed **once** by the
curator, then visible to everyone.
- Alternative: a per-department drop into each department's `drill_plans` as `source='ai'`, `draft` (each department's
  officers review). That's five times the AI cost, five review queues, and five copies of the same drill.

**Cadence:** recommend **monthly**, which matches the "monthly drop" the existing Request-a-packet screen already
promises.
- E.g. 4 drills on the 1st, one per track, with topics rotated by a curator-editable list.
- Alternative: weekly. More content, more review load.

**Trust gate:**
- **Nothing AI-generated is ever readable before a curator publishes it.**
- Pulled drills land as **drafts** in the pulling department, so their own officer approves before use. That's two gates.

## 5. The UI shape (Rulings L0–L2)
- **L0 — the existing "Training Library" nav screen.** Options:
  - (a) **Recommended:** **replace its fake backing with `library_drills`**:
    - the nav item and the Training tab both open the same real catalog;
    - the 6 `SEED` packets become `origin='seed'` rows (or are retired);
    - "Content Admin → Publish" becomes the real curator flow;
    - "Request a custom packet" feeds the curator queue.
  - (b) A new third Training tab, plus retiring the old nav screen.
  - (c) Keep both. **Not recommended:** two "Training Library"s, one of them fake.
- **L1 — placement.** A third segment in the Training `viewToggle` (`Schedule | Training Plans | Library`;
  `App.jsx:24102`, mounted lazily like Plans). The Library is browse + "Pull into my plans"; managing stays in Training
  Plans.
- **L2 — who sees it.** Read: every member (the catalog is generic). Pull / Share: training managers. Curate: the
  platform curator.

## 7. Item 3 — schedule-aware recommendations (added 2026-10-27; Rulings L9–L14)

**The ask (Claude, Oct 27):** the Library reads the department's existing cadence data and **proactively surfaces the
right packet or drill for what's overdue** ("you haven't run Hose Ops in 90 days — here's a drill").
- **Rules first:** overdue → matching packet.
- **AI only to draft a drill for a gap no packet covers.**
- *Note:* the concept file on disk (`claude/B4C_TrainingLibrary_Concept_ForStep0.md`, 14:09) doesn't contain item 3 yet;
  this section works from the directive's own wording.
- **Evidence:** read-only `docs/review/training_library_STEP0_item3.sql` → `_item3_OUTPUT.json` (category names /
  cadence / dates only), plus main `99a15b0`.

### 7a. The cadence machinery as it is

| Piece | Where | What it does |
|---|---|---|
| Categories | `training_plans` (`name`, `cadence`, `last_iso`, `color`, `starts_on`), department-scoped | One row per recurring training "category". Cadences live: Monthly 7 · Quarterly 2 · One-off 3 · Weekly 1 · Bi-weekly 1 · Semi-annual 1 |
| `last_iso` | `recompute_training_plan_last_iso(uuid)` (Slice 6; called by the finalize / correct / reopen RPCs, **no trigger**) | Date of the category's latest **finalized** session (`training_sessions.plan_id`) |
| The overdue clock | `dueInfo(item)` `App.jsx:23212` + `CADENCE_DAYS` `:23149` | next = `last_iso` + cadence days. Then: **Overdue** if past; **Due soon** within min(25% of the interval, 30 days); **Not logged** if never run; One-off = Done / Not logged |
| Reconcile | `reconcile(p)` `App.jsx:24447` | **Any future scheduled (not cancelled) session in the category overrides "overdue" → "On track"** ("no overdue while sessions sit on the calendar") |
| Where it shows | `TrainingSchedule`'s category list (`planView`, `:24453`), sorted Overdue → Due soon → On track | **Client-only.** There's no server copy and no shared helper, and the email doesn't use it |

**Live, today:**
- **Overdue: 0 of 15 categories.**
- 7 are "scheduled (reconciled)", 5 are "never logged" (Demo ×3, Lipan ×2), 2 are on track, and 3 are one-off.
- Only **10 finalized sessions** are linked to a category (`plan_id`), out of 122 linked sessions and 176 total.

### 7b. The audit question: is there enough metadata to match "overdue category → packet"? **No. Tagging is new.**

- **Categories are mostly *buckets*, not *topics*.**
  - Lipan: "Fire Training" (weekly), "Meeting", "Officer Meeting", "Work Night".
  - North Hood: "Fire Training" (bi-weekly), "Monthly Board Meeting", "Monthly Business Meeting".
  - Only Indian Harbor (and Demo) name topics: "Pump Operations", "First 5 Minutes", "RIT", "Ropes", "Vehicle Extrication…".
  - So for most departments, "haven't run **Hose Ops**" **isn't representable as an overdue category at all.** The topic
    lives in the session *title* ("Fire Training — hose advancement"), and nothing structured records it.
  - **Meetings are categories too**, so a recommender has to exclude them (`is_meeting`, or a category flag).
- **Packets carry no topic.** The 6 `SEED` packets have `track` (Fire / EMS / Leadership / Operations), `level`, `time`,
  `code`, and free text (objective / steps / safety…). There are no topic tags and no category link.
- **Drills carry a fragile link.** `drill_plans.category` is **free text holding the category's *name*** (the planner's
  select stores `x.name`, `App.jsx:23872`), not `training_plans.id`.
  - A category rename silently orphans every drill under it, and the name can't cross departments (names are local).
  - Live: 0 drill plans, so 0 linked.
- **Sessions carry `plan_id` (the category) and a free-text title.** The topic is never stored; an attached drill would be
  the only structured topic source.

**Conclusion:** rules-first matching needs **one shared topic vocabulary** that packets/drills, categories and (through
their attached drill) sessions can all point at. Department category names can't be that vocabulary: they're local,
renameable and mostly buckets.

### 7c. Proposed design (rules-first)

**1. A shared topic taxonomy** (global, curated, small): `training_topics`.
- Shape: `id`, `slug`, `label`, `track`, optional `default_interval_days`.
- Seed ~20–25 fire-service topics, e.g.:
  - hose ops, pump ops / water supply, tanker shuttle;
  - search & rescue, RIT / Mayday, SCBA / air management;
  - ladders, ventilation, forcible entry;
  - vehicle extrication, ropes, hazmat awareness, wildland, driver / EVOC, incident command;
  - EMS: CPR / BLS, stroke, peds, trauma.
- Global and read-only for authenticated users, curated by Project Admin. Same pattern as `standard_cert_types` /
  `library_drills` (§3); no department policy is touched.

**2. Tags.**
- **`library_drills.topics`** (required, 1–3), **`drill_plans.topics`** (optional, defaulting from a pulled library drill).
- A department maps **each category to the topics it covers** (`training_plan_topics`, many-to-many, optional). "Fire
  Training" might cover hose ops + ladders + search; "Pump Operations" = pump ops.
- Plus **`drill_plans.category_id`** (FK to `training_plans`, nullable) **replacing the name-string link**, back-filled
  by name. Live, there are 0 rows to back-fill.

**3. Two clocks, both rules.**
- **Category clock (exists):** `dueInfo` + `reconcile`, unchanged in meaning. **Move it to `shared/cadence.js`** (the
  WS-4 pattern), so the Library, the Training list and any future server reader agree.
- **Topic clock (new): "last ran topic T"** = latest **finalized, not-cancelled** session whose attached drill carries T,
  **or** whose category is mapped to T.
  - The interval is the mapped category's cadence, else the topic's `default_interval_days`, else 90.
  - This is what "haven't run Hose Ops in 90 days" means. It works for "Fire Training" departments once their categories
    are mapped or their sessions carry tagged drills.

**4. The recommender (pure function, client-side, no new RPC to start):**
- **Input:** the department's categories + sessions (already loaded by Training), its drill plans, and the published
  library (§3).
- **Output:** a ranked list of `{ reason, topic or category, suggestions[] }`:
  - **Overdue / not-logged / due-soon category** → drills whose topics overlap the category's mapped topics. The
    department's **own approved drills first**, then **library drills**, ranked by "held N times" (counts-only, §2).
    It **skips any drill the department ran in the last cycle**, so it doesn't re-suggest last month's drill.
  - **Topic past its interval** → same matching on that topic.
  - **Suppressed** when `reconcile` says a session is already scheduled (respects today's rule), and for meeting
    categories / `is_meeting`.
- **No match → the gap card offers "Draft a drill for <topic>".** That opens the existing AI planner (`AIDrillPlanner`)
  **pre-filled** (topic, category, typical duration from the cadence). It's **user-initiated**, lands as a **draft** in
  the department's own library (the existing Slice-5 path), and needs officer approval as today.
  - **No unprompted AI, and no auto-drop for gaps.** The monthly shared-pool drop (§4) is separate, and could use
    "most common uncovered topics across departments" as its topic list (counts only).

**5. Where it shows:**
- A **"Recommended" strip at the top of the Library tab** for training managers.
- A **"Here's a drill" action on each overdue / not-logged row** of the Training category list (`planView`).
- Both are read-only suggestions. Picking one goes through the existing "attach to a session" / "schedule this" paths.
- **No push or notification (Notify held).** Members don't see recommendations; this is planning.

**6. Data-quality honesty:**
- With 0 overdue categories and 10 linked finalized sessions live, the category clock alone would **rarely recommend
  anything today**.
- The topic clock plus category→topic mapping is what makes item 3 useful for the "Fire Training" departments.
- Consider a gentle nudge in the schedule form to pick a category / attach a drill, since sessions without a category or
  drill are invisible to both clocks.

**Invariants:**
- Read-only over sessions; no `station_presence`, nothing `verified`-related.
- No department policy widened. The new global tables follow the §3 catalog pattern, and the department tags are
  department-scoped under the existing `is_training_manager()` write gate.
- Notify held.

### 7d. Rulings for item 3

| # | Question | Recommendation | Trade-off |
|---|---|---|---|
| L9 | Matching vocabulary | A **shared curated topic taxonomy** (`training_topics`), tagged on library + department drills; categories map to topics | Department category names: zero setup, but local and mostly buckets ("Fire Training") — can't match packets |
| L10 | Which clock drives a recommendation | **Both:** the existing category clock (`dueInfo` + `reconcile`, moved to `shared/`) + a new topic clock | Category-only = almost nothing fires today (0 overdue live) |
| L11 | Respect `reconcile` (no "overdue" while a session is scheduled)? | **Yes.** Never nag about something already on the calendar | Ignoring it would suggest drills for already-planned training |
| L12 | Gap with no matching drill | **User-initiated AI draft** (pre-filled planner → department draft → officer approval); **no automatic AI per gap** | Auto-drafting per gap = cost + unreviewed content |
| L13 | Who sees recommendations / where | **Training managers;** Library "Recommended" strip + "Here's a drill" on overdue category rows | A member-facing version invites "why haven't we…" noise |
| L14 | `drill_plans.category` (name string) → `category_id` FK | **Yes** (0 rows live = free back-fill) | Keep the name: renames silently orphan drills |

## 6. Proposed slicing (each with the standard discipline)
1. **Library-DB:** `library_drills` + RLS / column grants; `share_` / `pull_` / `curate_` RPCs; `drill_plans.library_id` +
   `source 'library'` (pinned CHECK); the counts-only "used" RPC.
   - Plus: pins, PGlite dry run, SENTINEL retest, every department policy byte-unchanged, `verified` untouched.
2. **Library-UI:** the catalog view (L0 / L1), Pull, Share (with the scrub preview), the curator queue, Notify held.
3. **Library-Drop:** the cron route (dry-run first, `CRON_SECRET`, service role, `submitted` only) + the shared prompt
   module.
4. **Seed migration:** the 6 `SEED` packets → `library_drills` (or retire), and remove the in-memory Admin publish.
5. **Recommend-DB (item 3):** `training_topics` (global, seeded, Project-Admin-curated); `topics` on `library_drills` +
   `drill_plans`; `training_plan_topics` (department map); `drill_plans.category_id` FK (L14). Same discipline; every
   existing policy pinned and unchanged.
6. **Recommend-UI (item 3):**
   - `shared/cadence.js` (`dueInfo` / `reconcile` / `CADENCE_DAYS` moved verbatim) + `shared/recommend.js` (the pure
     recommender);
   - the Library "Recommended" strip; "Here's a drill" on overdue category rows;
   - the pre-filled AI-draft hand-off;
   - category→topic mapping in Training Plans.
   - The test pins the recommender (overdue → match → skip-recent → suppressed-when-scheduled → meetings excluded → gap
     → draft) and that both screens import `shared/cadence.js`.

## Rulings needed

| # | Question | Recommendation | Trade-off |
|---|---|---|---|
| L0 | The existing nav "Training Library" (6 hard-coded packets, fake publish) | Back it with the real catalog; one Library | Two libraries confuse; retiring loses the packet format |
| L1 | Where it lives | Third Training tab + the existing nav entry, same view | A tab only = a less discoverable global catalog |
| L2 | Who reads / pulls / shares / curates | All read; managers pull + share; Project Admin curates | DA-curated = no cross-department quality gate |
| L3 | "Used" | Held = attached + done + attended + not cancelled | "Attached" overstates (today's `attached_sessions`) |
| L4 | Curator | Project Admin | Self-publish is faster, unreviewed |
| L5 | Shared content | Snapshot at share | A live link needs versioning |
| L6 | Attribution | Opt-in department credit; counts-only usage | Always-credited exposes departments |
| L7 | AI drop | Monthly Vercel cron → shared pool as `submitted` (curated) | Per-department drafts = 5× cost and 5 review queues |
| L8 | Back-fill from today's 22 attended direct attachments | No (consent) | Faster start, but publishes text departments never shared |
| L9–L14 | Item 3 — schedule-aware recommendations | See §7d | — |
