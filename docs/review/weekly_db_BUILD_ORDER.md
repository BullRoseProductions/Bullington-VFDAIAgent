# Weekly Training Content, slice 4: the weekly AI draft's database: build order and hand-back

**Status:** DRAFT for gate. **Not applied, not reviewed.** Branch `feat/weekly-drill-db`, off `0df9c1e`.
- `0df9c1e` is main `6742304` (Library S3, gate PASS) plus its tests-only fence pin, which rides this merge.
- DB only. No `src/`, `api/`, `shared/`, native, package or `vercel.json` change. **Nothing calls the new functions yet.** The weekly cron is slice 7, and the UI that labels `ai_weekly` is slice 5.

**Design:** `docs/design/training_content_step0.md` §5.1, §5.3 and §5.4 (gate PASS @2a0768c; rulings @4cfe29f).
- R1: yes, opt-in, default OFF, never auto-approved, labelled as AI.
- R3: the toggle is DA-owned.
- The service-role-only grants on `put_weekly_drill_draft` and `record_dept_ai_call` were gate-approved **with** the human-approval trigger and CHECK as compensating controls.

## Files

| File | What |
|---|---|
| `sql/weekly_drill_db_DRAFT.sql` | the migration: one all-or-nothing DO block, then `NOTIFY pgrst`, then a read-only state row |
| `sql/weekly_drill_db_RETEST.sql` | SENTINEL RETEST: every write rolled back; the final RAISE is the report |
| `docs/review/weekly_db_dryrun_harness.mjs` | the PGlite dry run, built from the live capture |
| `docs/review/weekly_db_DRYRUN.txt` | its output (uuids stripped) |
| `docs/review/weekly_db_LIVEDEFS.json` | **the live capture of 2026-11-14:** 13 function bodies plus the `drill_plans`, `departments` and `ai_call_usage` catalog and counts, read-only. Two more bodies (`is_training_officer`, `is_training_manager`) come from Library S1's live capture. No member data. |

**About the live capture:** it ran on Ashlea's go. The query was sha256 `a173e3fb…`, and the editor text was hash-checked (MATCH) before Run. The bodies came out base64 through the clipboard, and each was md5-checked.
- All 13 equal the md5s Library S1 and S2 pinned, so nothing has drifted.
- `drill_plans` holds 2 rows, both approved, both with an approver. There are no triggers. The only policy is the department-scoped SELECT. service_role has full table grants: that's the hole the approval law closes.
- None of the new names is taken. verified = 1,234.

## What the migration does
1. **`departments.weekly_drill_draft_enabled boolean NOT NULL DEFAULT false`.** Every department starts OFF.
   - `set_weekly_drill_draft_enabled(bool)`: a real Department Admin of the caller's own department only. It's byte-for-byte the `set_probation_enabled` check, so the Project-Admin support path can't use it.
   - A guard trigger stops any direct client UPDATE of the column (the probation guard's shape).
2. **Provenance.**
   - The `drill_plans.source` CHECK gains `ai_weekly` (a pinned drop and re-add, same name).
   - New `weekly_key text`, shaped like `YYYY-Www`. It's set **if and only if** `source = 'ai_weekly'` (a CHECK), and unique per department (a partial unique index). That makes **at most one weekly draft per department per week**.
3. **The human-approval law: "never auto-approves" as a database rule.**
   - A trigger allows a plan to *become* approved, be *inserted* approved, or *change approver* while approved, only when `approved_by = my_member_id()` and that's not NULL.
   - A service-role or SQL-editor session has no member, so it can never approve by any path. Only `approve_drill_plan`, run by a person, can.
   - Plus `CHECK (status <> 'approved' OR approved_by IS NOT NULL)`. It holds on today's 2 rows, and the preflight checks that before adding it.
4. **`put_weekly_drill_draft(dept, week, title, category, length, audience, content)`.**
   - EXECUTE is granted to **service_role only**, and the body also checks `auth.role() = 'service_role'`.
   - It re-checks the toggle at write time, so turning it off wins. It always writes a draft with source `ai_weekly`, created and updated by NULL (no person wrote it), and `ON CONFLICT DO NOTHING`.
   - It returns `{result: inserted | exists | disabled, id}`.
5. **`record_dept_ai_call(dept, 'claude')`.** service_role only, with the same role check. It counts a memberless AI call in a **new** table, `ai_dept_call_usage`: RLS on, no client grants, and service_role can't read it directly either. It refuses once the department's members' calls plus cron calls reach the existing **1,500/day** ceiling.

**Not touched:**
- every existing function: the 7 `drill_plans` writers, the probation pair, `record_ai_call`, `my_member_id`/`my_department_id`, `is_training_*`. All are md5-pinned and snapshot-compared;
- `drill_plans`' policy and grants, and `ai_call_usage`;
- every other policy, ACL, constraint and trigger;
- `station_presence.verified`.

## Decisions for the gate (beyond the Step 0 text)
- **WK-1, the cron's backstop counter is a new table.** `ai_call_usage`'s key is `(member_id, day, route)` with `member_id NOT NULL`, and a cron call has no member.
  - `record_dept_ai_call` sums members' calls plus cron calls against the same 1,500 ceiling.
  - `record_ai_call` (members) is **unchanged**, so it doesn't see the cron's at most 6 attempts a week.
  - Route is `'claude'` only, the only route with a department ceiling.
- **WK-2:** the `weekly_key` format (an ISO week) is pinned in the CHECK as well as the RPC.
- **WK-3:** `put_weekly_drill_draft` returns `{result, id}`, not a bare uuid, so the cron can tell "already done this week" and "toggled off" apart from a write. Neither is a failure (Step 0 §5.6).
- **WK-4, the approval trigger also fires on INSERT and on an approver change while approved.** A plan can't be born approved, or re-credited to someone else, without that person doing it. An approved plan *edited* through `set_drill_plan` keeps its status and approver and is untouched, so today's flows don't change. That's proven by A3.

## Dry run (`docs/review/weekly_db_DRYRUN.txt`)
- **Pins:** 14/14 equal the live-captured md5 **and** the mock body.
- **Migration:** it applies. The state row shows the 5 new functions and 2 triggers, the widened source CHECK, 0 departments switched on, and verified unchanged.
- **Re-run:** refused.
- **RETEST: 15 passed / 0 failed / 0 skipped:**
  - G0 shape and rights;
  - T1 the toggle;
  - W1–W5: disabled, inserted, exists, validation, callers;
  - A1–A6: no memberless approval; a person approves; edit keeps approval; no re-crediting; unapprove; the provenance CHECKs;
  - R1 the backstop, at the 1,500 ceiling;
  - V verified.
- **Pre-apply drift: 7/7 refused:** `approve_drill_plan` drifted · `record_ai_call` drifted · source CHECK already widened · policy loosened · an unaudited trigger · an approved plan with no approver · a slice-4 name taken.
- **Mutations: 20/20 caught.**
  - 5 by the migration's own post-conditions: put callable by authenticated · backstop callable by authenticated · usage table readable · a pre-existing function touched (×2 shapes).
  - 15 by the RETEST: put's role check removed · toggle ignored · wrong source · an author recorded · overwrite on conflict · the approval trigger weakened three ways or missing · weekly_key not required · no unique week · the toggle RPC open to any member · the guard missing · default ON · the backstop ignoring members' calls · the approval CHECK dropped.
  - One mutation (M11) at first "passed" only because the harness built invalid SQL: JS `replace` treats `$'` in a replacement string as a special pattern. It was fixed with a function replacer, and the RETEST now catches it (A6).
- **Post-apply drift: 6/6 caught by the RETEST alone:** EXECUTE granted later · approval trigger disabled · guard dropped · source CHECK reverted · usage table opened · approval CHECK dropped.

## Apply (on Ashlea's explicit go with a gate PASS sha only)
1. SHA-check the editor text against `sql/weekly_drill_db_DRAFT.sql`, then Run.
   - sha256 `2122168e6c6166389c84a69e684de000f0ebab78dce7fcad5fd1bfd89e050eea`, 28,084 bytes.
2. Check the state row:
   - 5 functions and 2 triggers;
   - the source CHECK with `ai_weekly`;
   - `departments_on = 0`;
   - `plans_by_status_source` as before;
   - verified unchanged.
3. Run `sql/weekly_drill_db_RETEST.sql` and expect **15/0/0**.
   - sha256 `50a8de9d0bfa178393bc62f5f0e548b54df9163295c5928ecb67d25b10f23f2a`, 28,175 bytes.
   - Its actors are chosen live: a single-membership DA and a plain member of one department. No email is in the file or the report.
   - It may show "SKIP R1 ceiling half" only if that department already made 1,500 claude calls that day.
4. Put a docs-only apply record on the branch.

## Next
- **Slice 5 (Weekly UI + shared prompt):**
  - the DA toggle beside probation;
  - `ai_weekly` labels everywhere `source` is read ("Drafted by B4C's weekly AI", never a member's name);
  - `DRILL_PLAN_SYSTEM` moved to `shared/`.
- **Slice 6:** the `_anthropic.js` extraction.
- **Slice 7:** the cron, with its one-line `vercel.json` exception.
