# B4C — Event details DB migration (fundraiser + community events) — BUILD ORDER for CC

Off the live Step 0: `docs/review/event_details_STEP0_OUTPUT.md` + `docs/review/event_details_STEP0_app_side.md`. Concept: [[B4C_EventDetails_Concept_Step0]]. Purely additive — three nullable columns on each of two tables. No table merge (the "combine" is UI-only), no notes column (exists on both), no GRANT (Step 0 E2: no column ACLs, table grants full for `authenticated`), no policy change (Step 0 E4: UPDATE policies already exist, dept-scoped + `is_canmanage_ops()`).

## The change
Add to **both** `funding_events` and `recruitment_events`, all nullable:
- `start_time time` — a time-of-day (matches `training_sessions.start_time`).
- `end_time time` — new (training has none; Ashlea asked for an end time).
- `location_label text` — reviewer ruling E3: use `location_label` to match training's existing free-text location field name.

Do NOT add `notes` — it exists on both already (Step 0 confirmed), just unused by the UI. Keep `date date` as-is. Every existing event (7 total) reads all-day / no-location afterward, as intended.

## Migration discipline (same as every slice)
Single all-or-nothing DO block, re-run-safe.
- **Preconditions (refuse on drift / double-apply):** both tables exist with RLS on; `notes` exists on both; **none** of `start_time` / `end_time` / `location_label` exists on either (the "columns absent" start-state); the two tables' policy set is the expected four each (`members read` SELECT, `leaders write` INSERT, `leaders update` UPDATE, `leaders delete` DELETE — all `department_id = my_department_id()` [+ `is_canmanage_ops()` on the writes]); snapshot the full policy + grant state. Refuse if the three columns already exist.
- **The add:** `ALTER TABLE ... ADD COLUMN ...` for the three on each table (nullable, no default).
- **Post-conditions:** exactly those three columns now exist on each table with the right types (`time`, `time`, `text`), all nullable; no other column added/changed; no constraint/index/trigger change; RLS still on; **every policy byte-identical** (snapshot before/after) and the policy count unchanged; **table + column grants unchanged** (no new ACL); the one reader `my_department_rollup()` byte-identical (md5 `7b12e359bf7af9343565435658253a23` unchanged); `verified` appears nowhere and is untouched. State check: the new column count per table = 3.

## Dry run + RETEST (CC: a PGlite dry run + a live SENTINEL-rolled-back RETEST)
- **Dry run (PGlite) with mutations:** seed both tables; apply; assert the three columns exist nullable on each and an existing row reads NULL for all three. Mutations each caught: (a) a column added to only one table; (b) a wrong type (e.g. `text` for a time); (c) a NOT NULL slipped in; (d) a policy changed; (e) `my_department_rollup()` altered.
- **Live RETEST (rolled back):** per department, as a real DA/Officer, INSERT a fundraiser event and a community event **with** `start_time`/`end_time`/`location_label` set, read them back (columns persisted); as the same leader UPDATE an existing event to set a time + location, read back; as a **plain member**, attempt the same INSERT/UPDATE → refused by the existing `is_canmanage_ops()` policy (0 rows / policy error). This proves the new columns are writable under the existing gate and still refused for non-leaders — no GRANT regression.

## Carry to the UI slice (not this migration — recorded so it isn't lost)
- **E1 gate:** Edit + Delete live in the new detail view, shown to **DA + Officers** (match the DB `is_canmanage_ops()`), NOT PA-only. **And** the edit/delete calls must read back the affected row count (`.select()` / `count: "exact"`) so a refused write shows an error instead of the current silent no-op. *(Pending Ashlea's veto — she may narrow to DA-only.)*
- Tap an event → detail view (everyone); edit/delete inside it (DA+Officers). Kills the old tap-to-delete + the "(tap to remove)" hint.
- The combined calendar unions both tables; the add form's type toggle routes to the right table; the AI-plan import + Key dates writers leave the new fields null.

**Deliver the migration draft + dry run + RETEST for my gate review before apply.** Then the UI slice.
