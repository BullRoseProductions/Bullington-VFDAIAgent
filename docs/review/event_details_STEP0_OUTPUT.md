# Event details — Step 0 live output (item 1 + training / readers / counts), 2026-10-21

Source: Ashlea ran `sql/event_details_STEP0_CHECK.sql` on live (read-only, one result set). The app side (items 2–4) and the
reviewer's rulings are in `docs/review/event_details_STEP0_app_side.md`. Nothing drafted.

## Findings, ranked

### E1 — the delete/edit role the ruling names doesn't match the DB gate: a Project Admin's delete would be a SILENT no-op
- **DB:** UPDATE and DELETE on both tables = `department_id = my_department_id() AND is_canmanage_ops()`. `is_canmanage_ops()`
  is the DA / **Officer** gate (client twin `CANMANAGE_OPS_ROLES = ["Department Admin", "Officer"]`, shared/roles.js:29 —
  "Board EXCLUDED + no PA").
- **UI today / the ruling:** delete is behind `useCanDeleteShared()` = `isDeptAdmin` = **Department Admin or Project Admin**
  (shared/roles.js:27); the ruling puts Edit + Delete in the detail for "DA/PA only".
- **The gap:** a Project Admin without DA or Officer at that department passes the UI gate, but RLS filters the UPDATE /
  DELETE to **0 rows — PostgREST returns no error**, and both page calendars' `removeEvent` only checks `error`. So the
  event stays, the list reloads, nothing is said. An edit would do the same. (Officers are the mirror image: the DB lets
  them edit/delete, the UI won't — narrower, safe.)
- **For the reviewer:** either gate Edit/Delete on the intersection that actually works (DA — in both sets), or on the
  DB's set (DA / Officer); and either way have the edit/delete read back the row count (`.select()` / `count: "exact"`)
  so a refused write says so. No change made.

### E2 — new columns are client-writable by default; no GRANT needed
- **0 of 9** (`funding_events`) and **0 of 7** (`recruitment_events`) columns carry a column-level ACL. Table grants:
  `authenticated` and `anon` both hold full `arwdDxtm` (the Supabase default). So `ADD COLUMN` columns are insertable /
  updatable by `authenticated` with no extra GRANT — the RLS policies are the only gate.
- `anon` has full table privileges too, but every policy is `{authenticated}` and RLS is on (not forced), so anon gets
  nothing. Unchanged by the migration.

### E3 — training already has a free-text location column: `location_label`
`training_sessions` live: `start_time time` · `duration_min smallint` · `location_label text` · `location_lat` / `location_lng`
double · `location_radius_m` int. The ruling said "training's location is a GPS point — don't reuse it"; it also carries
a **text label** (`location_label`, written only for off-site sessions, ~23395). Not a reason to share a column across
tables — just a naming question for the reviewer: new column `location` (as ruled) or `location_label` (the app's
existing name for the same idea).

### E4 — an edit path needs no policy change
Both tables already have UPDATE policies (USING + CHECK, department-scoped + `is_canmanage_ops()`). They have simply never
been exercised — no client `.update()` exists (app-side item 4). The CHECK pins `department_id` to the caller's
department, so an edit can't move an event to another department.

### Schema facts the migration should pin
| | funding_events | recruitment_events |
|---|---|---|
| columns | id uuid PK = gen_random_uuid() · department_id uuid NOT NULL · date date NOT NULL · title text NOT NULL · color text NOT NULL = '#9A6B12' · notes text · fundraiser_id uuid · **source_label text** · created_at timestamptz NOT NULL = now() | id uuid PK = gen_random_uuid() · department_id uuid NOT NULL · date date NOT NULL · title text NOT NULL · color text NOT NULL = '#1F4E79' · notes text · created_at timestamptz NOT NULL = now() |
| constraints | pkey · `funding_events_fundraiser_id_fkey` → fundraisers(id) ON DELETE SET NULL | pkey only |
| indexes | pkey · `funding_events_fundraiser_idx` (fundraiser_id) | pkey |
| RLS | on, not forced | on, not forced |
| triggers | none | none |
- **Neither table has a `department_id` FK** to departments (unlike certs / readiness_requirements). Note only.
- **`notes` exists on both** (ruling confirmed). **No** `start_time` / `end_time` / `location` on either — the additive
  columns are all absent, so "columns absent" is a valid precondition.
- `funding_events.source_label` exists and nothing in origin/main writes or reads it. Note only.
- Policies (identical shape on both): `members read <t> [SELECT] {authenticated}` USING `department_id = my_department_id()`
  · `leaders write <t> [INSERT]` CHECK `department_id = my_department_id() AND is_canmanage_ops()` · `leaders update <t> [UPDATE]`
  USING + CHECK the same · `leaders delete <t> [DELETE]` USING the same.

### Readers + blast radius
- **Only one function reads either table: `my_department_rollup()`**, md5 `7b12e359…` — the G2-fixed version, which
  incidentally re-confirms G2 is live. It reads `date, title` only (`my_next_event_*`), so additive columns don't touch it.
  (If the reviewer wants the next-event line to show a start time, that's a separate, optional change.)
- **Rows: 7 events in all** — Indian Harbor 1 funding · Lipan 1 recruitment · North Hood 1 funding + 4 recruitment · Demo /
  Granbury 0. Every existing event reads "all-day, no location" after the migration, as intended.

## Raw rows (as pasted)
**Columns** — as in the table above.
**Column grants** — every column of both tables, for both `authenticated` and `anon`: `select true · insert true · update
true · column acl none`.
**Table grants** — both tables, both roles: `SELECT INSERT UPDATE DELETE · relacl {postgres=arwdDxtm/postgres,
anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}`.
**Training columns (item 3)** — `counts_toward_attendance boolean NOT NULL = true` · `created_at timestamptz NOT NULL = now()`
· `date date NOT NULL` · `duration_min smallint` · `location_label text` · `location_lat double precision` ·
`location_lng double precision` · `location_radius_m integer` · `start_time time without time zone`.
**Functions (item 4)** — `my_department_rollup()` DEFINER · md5 7b12e359bf7af9343565435658253a23 · writes false · members exec true.
