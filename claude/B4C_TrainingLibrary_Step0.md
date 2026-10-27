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

## 6. Proposed slicing (each with the standard discipline)
1. **Library-DB:** `library_drills` + RLS / column grants; `share_` / `pull_` / `curate_` RPCs; `drill_plans.library_id` +
   `source 'library'` (pinned CHECK); the counts-only "used" RPC.
   - Plus: pins, PGlite dry run, SENTINEL retest, every department policy byte-unchanged, `verified` untouched.
2. **Library-UI:** the catalog view (L0 / L1), Pull, Share (with the scrub preview), the curator queue, Notify held.
3. **Library-Drop:** the cron route (dry-run first, `CRON_SECRET`, service role, `submitted` only) + the shared prompt
   module.
4. **Seed migration:** the 6 `SEED` packets → `library_drills` (or retire), and remove the in-memory Admin publish.

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
