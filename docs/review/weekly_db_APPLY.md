# Weekly Training Content slice 4 (Weekly DB): apply record

**Applied live 2026-11-14** on Ashlea's go, at the gate's "Weekly DB: gate PASS @25979b3" (relayed verbatim in Ashlea's pasted message; WK-1 through WK-4 approved). Applied through the Supabase SQL editor (project `ifeptqnlucmvhlvadcpj`).

## Migration: `sql/weekly_drill_db_DRAFT.sql` (as committed at 25979b3)
- **SHA-check before Run:** the editor text was hashed in-page (`crypto.subtle`, SHA-256): **`2122168e6c6166389c84a69e684de000f0ebab78dce7fcad5fd1bfd89e050eea`**, MATCH (28,046 characters; the file is 28,084 bytes because of multi-byte dashes). The hash check and Run were separate steps.
- **Preflight:** passed on live, so all 14 md5 pins held, along with the source-CHECK text, the policy text, the "no triggers" check and the "no approved plan without an approver" check.
- No destructive-confirm dialog appeared.
- **State row:**
  ```
  {"weekly_fns":["put_weekly_drill_draft(uuid,text,text,text,integer,text,jsonb)","record_dept_ai_call(uuid,text)",
                 "set_weekly_drill_draft_enabled(boolean)","tg_departments_weekly_drill_draft_guard()","tg_drill_plans_human_approval()"],
   "triggers":["departments.departments_weekly_drill_draft_guard","drill_plans.drill_plans_human_approval"],
   "source_check":"CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text, 'library'::text, 'ai_weekly'::text])))",
   "departments_on":0,
   "plans_by_status_source":{"approved/ai":1,"approved/manual":1},
   "verified_presence":1234}
  ```
  Every department is OFF, the plans are unchanged, and verified is unchanged from the 2026-11-14 capture (1,234).

## RETEST: `sql/weekly_drill_db_RETEST.sql` (as committed at 25979b3)
- **SHA-check:** `50a8de9d0bfa178393bc62f5f0e548b54df9163295c5928ecb67d25b10f23f2a`, MATCH (28,161 characters).
- **Result: 15 passed / 0 failed / 0 skipped**, matching the dry run.
  - G0 · T1 · W1 · W2 · W3 · W4 · W5 · A1 · A2 · A3 · A4 · A5 · A6 · R1 · V. All PASS, including R1's ceiling half (no skip).
  - "Fixtures rolled back": no `ZZ RETEST` or `2099-*` rows remain.
- The actors were chosen live from one department: a single-membership DA and a plain member. No email or name is in the file, the report or this record.
- The SENTINEL rolled back every write: the fixture department's toggle, the fixture weekly draft, the approval fixtures and the usage counters.

## Housekeeping (the gate's "at next touch" item)
- `docs/review/weekly_db_dryrun_harness.mjs` now redacts uuids **inside its own output** (`log()`), so the dry run is deterministic.
- Two consecutive runs are byte-identical, and both equal the committed `weekly_db_DRYRUN.txt`. The SQL files are unchanged.

## Invariants
- verified untouched (1,234 before and after);
- Notify held;
- no `src/`, `api/`, `shared/`, native or `vercel.json` change.
- **Nothing calls the new functions yet.** The weekly cron is slice 7; the DA toggle and the `ai_weekly` labels are slice 5.

## Next
**Slice 5 (Weekly UI + shared prompt):**
- the DA toggle beside probation;
- the `ai_weekly` labels ("Drafted by B4C's weekly AI", never a member's name, never plain "Draft");
- `DRILL_PLAN_SYSTEM` and its parser moved to `shared/` (byte-identical).
