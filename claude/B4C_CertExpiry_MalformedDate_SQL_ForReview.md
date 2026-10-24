# B4C — Cert expiry malformed date: the SQL migration + data cleanup (for gate review, NOT applied)

Order [[B4C_CertExpiry_MalformedDate_Fix_BuildOrder]] · Step 0 PASS [[B4C_CertExpiry_MalformedDate_Fix_ClientAndStep0_ReviewRecord]].
Client half live in `9e2b170` (noir-25). Branch `fix/cert-expiry-malformed`.

## Files
| File | What |
|---|---|
| `sql/cert_expiry_valid_ym_DRAFT.sql` | the code migration — helper + 7 functions, one DO block |
| `sql/cert_expiry_valid_ym_RETEST.sql` | SENTINEL RETEST (rolls back) — run after the code migration |
| `sql/cert_expiry_data_cleanup_DRAFT.sql` | the sibling data cleanup — the 7 rows; refuses to run before the code migration |
| `docs/review/cert_expiry_valid_ym_DRAFT_DIFF.patch` | every live body → new body (26 changed lines: 10 reader sites, 2 writer lines) + the helper |
| `docs/review/cert_expiry_valid_ym_dryrun_harness.mjs` / `_DRYRUN.txt` | PGlite dry run + its output |
| `docs/review/cert_expiry_malformed_STEP0B_OUTPUT.json` | Step 0b (read-only, live): the cleanup rows by id, the submissions' shapes, triggers, policies |

## What it does — as approved
1. **`public.valid_exp_ym(text)`** — `coalesce(p_exp OPERATOR(pg_catalog.~) '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$', false)`.
   NULL → **false** (your coalesce note). Same rule as `validExpYM`; the dry run compares the two on 30 inputs (incl. NULL,
   full-width and Arabic-Indic digits): **agree on all**.
   **Two deliberate departures from the Step 0 sketch (`… and left($1,4)::int >= 1900`), please confirm:**
   - **One regex, no `::int` cast**: year ≥ 1900 is `(19|[2-9][0-9])[0-9]{2}`. The sketch's cast can raise on its own: SQL
     doesn't guarantee `AND` order, so `'TBD'` could reach `left('TBD',4)::int`. `[0-9]` rather than `\d`, because Postgres
     `\d` can match non-ASCII digits and JS `\d` doesn't.
   - **Inlinable**: IMMUTABLE, `LANGUAGE sql`, **no `SET search_path`**, not definer (the operator is schema-qualified, so no
     search_path is needed). This one is load-bearing. `pa_department_radar` / `my_department_rollup` test validity in a
     WHERE next to `split_part(c.exp,…)::int` arithmetic, and the planner orders WHERE quals by cost. Inlined, the helper is
     the same cheap regex it replaces, so it is still evaluated first. A normal function call (COST 100) gets ordered after
     the cast. **Mutation (c2) proves it:** with `SET search_path`, the RETEST's `'TBD'` row makes the rollup and the radar
     raise `invalid input syntax for type integer: "TBD"`. The migration checks inlining in a real plan (`EXPLAIN` shows
     `Filter: COALESCE((c.exp ~ '…'::text), false)`).
   - EXECUTE: authenticated + service_role, no anon/PUBLIC. Asserted equal to the cert functions' own grants.
   - Supabase's linter will flag "mutable search_path" on it. That's expected and harmless for a table-less function with a
     qualified operator.
2. **The 5 readers, 10 sites**: each re-created from its **live** text with exactly one token swapped (table in the DRAFT
   header). Post-condition: the new body equals `replace(live, old, new)`, the old test is gone, its reviewed md5 matches,
   and identity / grants / definer / search_path / owner are unchanged. `probation_item_states` is included, per one rule
   everywhere.
3. **`update_cert`** refuses a non-blank invalid exp with the client's message, `Expiration must be a real month as YYYY-MM
   (e.g. 2027-06).`. Blank or NULL still clears the date.
4. **`approve_cert_submission`** (Ashlea's call): approves, but writes `case when valid_exp_ym(sub.exp) then sub.exp end`, so
   a malformed exp becomes NULL ("No expiration date") and a valid one is copied as before. **Live impact today: none**.
   Step 0b shows 0 pending malformed submissions. The 24 malformed ones are all already approved: 23 have a bad month
   (YYYY-00 / YYYY-13 style), 1 is a full date. They stay as history; nothing touches `cert_submissions`.
5. **Everything else is byte-identical**: every other function (md5 + grants), every policy, every trigger, function count
   +1, total_policies, the locked-token count, and **every certs / cert_submissions row** (this migration touches no data).

## The data cleanup (sibling file, applied second)
The 7 rows are pinned by id, department, current value and target value, read from live (Step 0b):
- Demo, 6 rows: `2026-09-15`→`2026-09`, `2026-12-31`→`2026-12`, `2027-03-01`→`2027-03`, `2027-05-01`→`2027-05`,
  `2027-06-01`→`2027-06`, `2028-01-01`→`2028-01`.
- North Hood, 1 row: `0000-00`→NULL.

The checks:
- The cleanup refuses to run without the helper at its reviewed md5, if any row has drifted or moved department, or if it's
  already applied.
- Each UPDATE is scoped by department + id + old value, and its row count is asserted (6, 1).
- Post-conditions: every other cert row is byte-identical, the 7 rows' other columns are unchanged, the certs count is
  unchanged, and malformed certs drop by exactly 7.

**Heads-up — Demo's numbers move.** As of 2026-10, `2026-09` reads EXPIRED, `2026-12` EXPIRING, and the other four CURRENT.
In the dry-run mock, Demo's readiness went to current 5 · expiring 1 · expired 1 · no_date 0.

## Dry run (PGlite, mock rebuilt from live: all 7 live md5s reproduce byte-identically)
- **Probe of the reported bug**, North Hood's `0000-00` row:
  - before: readiness expired **1**, rollup expired **1**, `expiration_rows` reads `0000-01` as **expired**;
  - after: expired **0**, no_date +1, `0000-01` → no_date.
- **RETEST before the fix:** fails (no helper).
- **Apply:** state row `helper_ok · helper_inlinable · grants_ok true · sites_repointed 10 · old_tests_left 0 ·
  update_refuses · approve_clears true · helper_md5 51b8cde1`. A re-run is refused ("already applied").
- **RETEST after: 24 passed, 0 failed, 0 skipped** across 3 departments (S0, S1, L1, then G1–G5, U1 and A1 each). It rolls
  back with certs byte-identical.
- **Cleanup:** the state row reads demo_fixed 6 · north_hood_exp NULL · malformed_certs 0. A re-run is refused. Running it
  before the code migration is refused. The RETEST still reads 24/0/0 afterwards.
- **Code mutations, all refused.** Each of these is refused, and with post-conditions stripped the RETEST catches it:
  - (a) no year bound;
  - (b) no coalesce;
  - (c) SET search_path / not inlined — this one raises on 'TBD';
  - (f) readiness made month-only;
  - (g) update_cert keeps the old message;
  - (h) approve copies verbatim.

  These are refused outright:
  - (d) SECURITY DEFINER; (e) anon grant;
  - (i) an extra body edit; (j) a collateral function change;
  - (k) a policy change; (l) a trigger change;
  - (m) data touched in the block;
  - (n), (o) live drift;
  - (p) already applied.
- **Cleanup mutations, all refused with certs untouched:** a target drifted; a target moved department; an unscoped Demo
  UPDATE (touched 7, not 6); NH set to `''`; another column changed; a non-target row changed; already applied.

## Live RETEST — what to expect
Per department it needs a DA with a unique email and an auth user (else SKIP). G3 runs as a Project Admin (live PAs are also
DAs, which is fine here because the radar is cross-department). G5 and A1 insert a synthetic onboarding item and submission;
if a live constraint refuses either, it **SKIPS with the reason** and the dry run is the proof. Some departments may SKIP
entirely if their DAs share an email with another membership.

## Apply sequence (after PASS)
1. `sql/cert_expiry_valid_ym_DRAFT.sql` — expect the state row: helper_ok / helper_inlinable / grants_ok true ·
   sites_repointed 10 · old_tests_left 0 · update_refuses / approve_clears true · helper_md5 51b8cde1 · malformed_certs 7 ·
   certs_total 179 · total_policies 173 · locked_token_fns 17.
2. `sql/cert_expiry_valid_ym_RETEST.sql` — the passed / failed / skipped report.
3. `sql/cert_expiry_data_cleanup_DRAFT.sql` — expect demo_fixed 6 · demo_values 2026-09,2026-12,2027-03,2027-05,2027-06,2028-01 ·
   north_hood_exp NULL · malformed_certs 0 · certs_total 179 · total_policies 173 · locked_token_fns 17.
