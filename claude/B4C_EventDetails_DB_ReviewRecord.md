# B4C — Review Record: Event details DB migration (fundraiser + community events)

**Verdict: PASS — safe to apply.** Reviewed by Claude (gate reviewer) 2026-10-21 from the actual draft, not CC's summary. DRAFT `5504b18` (`sql/event_details_cols_DRAFT.sql` + `sql/event_details_cols_RETEST.sql` + PGlite dry run in the diff patch). Unreviewed/unapplied at review time. Order: [[B4C_EventDetails_DB_BuildOrder]]; Step 0: `docs/review/event_details_STEP0_OUTPUT.md` + `_app_side.md`. Additive only — live on web AND native the moment applied; the UI that uses the columns is the next slice (so "event details" isn't customer-visible until that ships).

## The change (confirmed from the draft)
Two `ALTER TABLE` adding `start_time time`, `end_time time`, `location_label text` — all **nullable, no default** — to **both** `funding_events` and `recruitment_events`. No `notes` (exists on both). No GRANT. No policy change. No table merge (the "combine" is UI-only).

## Verified
- **Preconditions pin the start state hard.** Per table: exists, RLS on, `notes` (text) present, the three new columns **absent** (3 present → "already applied" refuse; 1–2 → "partial" refuse), and the **four policies pinned verbatim** against `POL_SHAPE` (`members read` SELECT · `leaders write` INSERT · `leaders update` UPDATE · `leaders delete` DELETE, each `department_id = my_department_id()` [+ `is_canmanage_ops()` on the writes]). Plus `my_department_rollup()` md5 `7b12e359…` (the G2-fixed reader). Refuses on any drift.
- **Exactly the three columns, right shape.** Post-condition (1) reconstructs the expected column list (old set + the three new, `time`/`time`/`text`, `attnotnull` false, no default) and compares — so a wrong type, a slipped NOT NULL, a default, or a column on only one table all abort.
- **Nothing else moved.** Constraints/indexes/triggers byte-identical; table + column ACLs and RLS unchanged; **every policy byte-identical** + count unchanged; **every public function byte-identical** (incl. the rollup, re-pinned); split-token `verified` count unchanged; `verified` never referenced.
- **The new columns are app-writable with no GRANT (confirms E2).** A `has_column_privilege('authenticated', …, 'INSERT'/'UPDATE'/'SELECT')` post-condition proves it directly — no column ACL was needed.
- **Existing data untouched:** post-condition (3) asserts all 7 events read NULL for the three new fields.
- **Fail-safe:** one all-or-nothing DO block; any exception rolls back both ALTERs.
- **RETEST is genuine, role-switched, SENTINEL-rolled-back.** Per department, for each of **L-DA (Department Admin)** and **L-OF (an Officer who is not DA/PA)**: inserts a fundraiser + a community event *with* a time range + location, and updates two date-only fixtures — all 1 row, values persisted. **M1 (plain member):** both inserts refused by RLS, both updates 0 rows, fixtures unchanged, no member event created. Dry run: 7 passed / 0 failed / 3 skipped (Demo/Granbury + a dept with no Officer), all 15 mutations caught.
  - **Bonus:** the L-OF leg proves an **Officer** can write these events at the DB — which is exactly why the UI's edit/delete gate (E1) is **DA + Officers**, not DA/PA.

## Apply (after this PASS)
Ashlea runs `sql/event_details_cols_DRAFT.sql` (single DO block; refuses drift/double-apply). Confirm the state row: **funding_new_cols 3 · recruitment_new_cols 3 · nullable_new_cols 6 · event_policies 8 · rollup_md5_ok true · total_policies 169 · locked_token_fns 17**. Then run `sql/event_details_cols_RETEST.sql` separately (SENTINEL-rolled-back). Rollback if ever needed: `ALTER TABLE … DROP COLUMN start_time, end_time, location_label` on both (nothing reads them yet).

## Next
The UI slice: the combined "Fundraising & Community Events" calendar (union both tables, type toggle), the new fields in the add form, a detail view (tap opens it; **edit + delete inside, DA + Officers, with a row-count check** so a refusal isn't silent — E1), and the notes field wired in. The Recruitment page keeps its planner; only its calendar moves. Built as a reviewed diff, then promote.
