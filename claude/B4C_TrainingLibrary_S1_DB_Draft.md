# B4C — Training Library slice 1-DB DRAFT: the real catalog + "pull into my plans"

**CC, 2026-10-27. DRAFT — NOT APPLIED, NOT REVIEWED.** This is the first slice of the plan in
[[B4C_TrainingLibrary_Step0_ReviewRecord]] ("Library-as-tab + real catalog"). This doc is that slice's Step 0 addendum
and the DB draft. The UI half follows once this passes.

## Scope of slice 1

| In | Not yet (later slices) |
|---|---|
| A real **global catalog table** (`library_drills`), published-only reads | Departments **sharing** their drills + the **PA curator queue** + opt-in credit + dedupe UI (slice 2) |
| The **6 hard-coded `SEED` packets moved into it** (L0: the nav "Training Library" gets a real backing) | The **monthly AI drop** cron (slice 3) |
| **Pull into my plans** → a draft in the department's own `drill_plans` | **Topics / recommendations** (`training_topics`, the topic clock, the recommender; slice 4) |
| **"Used"** counts (L3), counts only | Any curator write path. The 6 seed rows are the whole catalog until slice 2 |

## Files (branch `feat/training-library-s1-db`)

| File | What |
|---|---|
| `sql/library_s1_catalog_DRAFT.sql` (sha256 `e71cf453…`) | **Generated.** One all-or-nothing DO block → `NOTIFY pgrst` → state row |
| `docs/review/library_s1_template.sql` + `library_s1_build.mjs` | The template and generator. The 6 seed packets are **evaluated straight out of `src/App.jsx`'s `SEED`** (no retyping), and the pins come from the live read |
| `sql/library_s1_catalog_RETEST.sql` (sha256 `63cb5adb…`) | SENTINEL, role-switched |
| `docs/review/library_s1_LIVEDEFS.sql` → `.json` | Live read 2026-10-27 |
| `docs/review/library_s1_dryrun_harness.mjs` → `library_s1_DRYRUN.txt` | PGlite dry run |

## The change

**`library_drills`** — global; no `department_id` (the `standard_cert_types` precedent):

| Column(s) | Notes |
|---|---|
| `code` UNIQUE, `title`, `track` ∈ Fire / EMS / Leadership / Operations, `level`, `duration_min` (1–1440), `audience` | |
| `content` jsonb | The `drill_plans` shape (`summary`, `objectives`, `run_of_show`, `materials`, `safety`) + packet-only keys (D1) |
| `origin` ∈ seed / ai_drop / shared | |
| `origin_department_id` | **Not selectable** by authenticated: column grants, the Slice 7 signature technique |
| `credit_name` | Opt-in, used from slice 2 |
| `state` ∈ submitted / published / withdrawn | |
| `content_hash` | **Generated**, UNIQUE: dedupe from day one |
| `published_at` / `published_by` | |

**Access:**
- RLS: **one policy**, `SELECT TO authenticated USING (state = 'published')`.
- **anon: nothing.** Supabase's default grants are revoked first.
- authenticated: column SELECT on everything except `origin_department_id`.
- **No INSERT / UPDATE / DELETE for anyone but the owner.** That includes `service_role`'s writes, so curation must come through slice 2's reviewed function.

**Seed:**
- The 6 `SEED` packets go in as `origin='seed'`, `state='published'`: FIRE-203, FIRE-118, EMS-114, EMS-203, LEAD-140, OPS-120.

**`drill_plans` changes:**
- **+ `library_id`** → `library_drills` ON DELETE SET NULL (the copy's link back, for "used").
- **`source` CHECK widened** `ai|manual` → `ai|manual|library`. This is a pinned drop + re-add, and the only change to an existing object.
- **+ CHECK** `library_id IS NULL OR source = 'library'`.

**Functions** (SECURITY DEFINER, `search_path=public`, REVOKE anon/PUBLIC, GRANT authenticated):
- **`pull_library_drill(id)`**
  - Gate: `is_training_manager()` (DA or training officer, department-scoped).
  - Copies a **published** drill into the caller's `drill_plans` as a **draft** (`source='library'`, `library_id` set), so their own officer still approves before it can be attached.
  - A second pull of the same drill → `ALREADY_PULLED`. An unpublished one → `NOT_FOUND`.
- **`library_drill_usage()`** → `(library_id, held, departments)`.
  - "Used" per L3: a copy attached to a **finalized, not-cancelled, attended** session.
  - **Integers only**: never which department, never who.
  - Returns nothing for a login without a member row.

**Deliberately unchanged:**
- `set_drill_plan` already ignores `source` on edit, so a pulled draft edits normally and keeps `source='library'`. The RETEST proves it (T3).
- `dept_drill_plans`, the approve / unapprove / delete functions and `attach_drill_plan_to_session` are all pinned and byte-identical.
- Every existing policy, table grant, trigger and constraint (apart from the one CHECK) is proven unchanged by snapshot post-conditions, including the **storage** policies WS-3 just applied.
- `verified` is untouched (a before = after count in the post-conditions + RETEST T7). Notify held.

## Evidence (PGlite, `docs/review/library_s1_DRYRUN.txt`)

- **Pins: 10/10 mock bodies md5-equal to the live pins, all live bodies, no stubs:** `my_department_id`, `my_member_id`, `is_training_officer`, `is_training_manager`, `dept_drill_plans`, `set_drill_plan`, approve / unapprove / delete, `attach_drill_plan_to_session`.
- **Migration:** applies with the expected state row (6 codes, both functions `anon=false auth=true`). **A re-run is refused.**
- **RETEST: 18 passed, 0 failed:**
  - once-checks O1–O4;
  - T1–T7 × 2 departments, one with a REAL DA and one with a fixture DA:
    - a member reads only published drills, can't select `origin_department_id`, and anon is refused;
    - DA and training officer pull drafts; a second pull and an unpublished pull are refused; Officer-not-TO, Board, PA and Member get NOT_ALLOWED;
    - the pulled draft edits and approves, keeping its link;
    - "used" counts only finalized + attended sessions (1 held, 1 department), and a non-member gets nothing;
    - another department can't see the copy and pulls its own;
    - delete → re-pull works;
    - `verified` unchanged.
- **3 drift refusals:** `is_training_manager` drifted, a write policy added to `drill_plans`, the source CHECK already widened.
- **10 mutations, all caught:**
  - **refused by the migration:** M1 anon read, M2 origin selectable, M10 a pre-existing function touched;
  - **turn the RETEST red:** M3 unpublished readable, M4 pull open to all, M5 pull lands approved, M6 duplicates, M7 unpublished pull, M8 unattended counted, M9 usage for non-members.
- **4 post-apply drifts, all caught by the RETEST alone:** anon granted later, policy loosened, a seed withdrawn, the source CHECK reverted.

## Decisions for the review

- **D1 — seed content mapping:**
  - objective → `summary`;
  - evaluation → `objectives`;
  - steps → `run_of_show` ("`<step> — N min`", the planner's own format);
  - equipment → `materials`;
  - safety → `safety`;
  - instructorGuide / scenario / discussion / debrief / evaluation / updated are kept as extra keys (`instructor_guide`, `scenario`, `discussion`, `debrief`, `evaluation`, `revised`), so the packet view loses nothing and an attached copy serializes the core keys as today.
  - `audience` is NULL; the packet's level label lives in `level`.
- **D2 — no catalog write path in this slice.** The catalog is the 6 seeds until slice 2 adds PA curation and sharing. Content Admin's in-memory "Publish" becomes that flow there.
- **D3 — duplicate pulls:** a second pull is refused, but deleting your copy lets you pull again.
- **D4 — `content_hash`** = md5(lower(btrim(title)) ‖ '|' ‖ content), generated and UNIQUE.
- **D5 — `library_drill_usage()` counts across all departments** (that's the "held N times in M departments" ruling, L6) but returns only integers per catalog row.

## The UI half of slice 1 (next, after this passes — for orientation)

- A third Training tab, **`Schedule | Training Plans | Library`** (L1), and the existing nav "Training Library" opens the **same** view (L0).
- Both read `library_drills` with **explicit columns** (never `select("*")`; `origin_department_id` isn't grantable).
- **"Add to my plans"** (training managers) → `pull_library_drill` → it lands in Training Plans as a draft labelled "From the library".
- **"Held N times in M departments"** from `library_drill_usage()`.
- `SEED` and the in-memory Admin publish are retired (the packet view renders the same fields from `content`).

## Apply (only after PASS + Ashlea's go)

1. Run `sql/library_s1_catalog_DRAFT.sql`.
2. Expected state row:
   - `library_drills` {seed/published: 6}, codes = the six;
   - library_policies 1; origin_dept_selectable **false**;
   - `drill_plans_source_chk` = ai|manual|library;
   - both functions `anon=false auth=true`;
   - total_public_policies **176** (175 + 1); fn_count **222** (220 + 2);
   - verified_presence unchanged.
3. Run `sql/library_s1_catalog_RETEST.sql` separately (O1–O4, then T1–T7 per department).

- **Rollback** (nothing reads it until the UI ships):
  1. `DROP FUNCTION pull_library_drill(uuid), library_drill_usage()`
  2. `ALTER TABLE drill_plans DROP CONSTRAINT drill_plans_library_source_chk, DROP COLUMN library_id`
  3. Restore `drill_plans_source_chk` to `ai|manual`
  4. `DROP TABLE library_drills`
  5. `NOTIFY pgrst`
