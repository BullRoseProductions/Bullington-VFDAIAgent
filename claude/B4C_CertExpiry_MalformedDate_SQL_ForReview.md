# B4C — Cert expiry malformed date: the SQL migration incl. the data cleanup (for gate review, NOT applied)

Order [[B4C_CertExpiry_MalformedDate_Fix_BuildOrder]] · Step 0 PASS [[B4C_CertExpiry_MalformedDate_Fix_ClientAndStep0_ReviewRecord]].
Client half live in `9e2b170` (noir-25). Branch `fix/cert-expiry-malformed`.

## Files
| File | What |
|---|---|
| `sql/cert_expiry_valid_ym_DRAFT.sql` | ONE all-or-nothing DO block: helper + 5 readers + 2 writers + the 7-row data cleanup |
| `sql/cert_expiry_valid_ym_RETEST.sql` | SENTINEL RETEST (rolls back) — run after the migration |
| `docs/review/cert_expiry_valid_ym_DRAFT_DIFF.patch` | every live body → new body (26 changed lines: 10 reader sites, 2 writer lines) + the helper |
| `docs/review/cert_expiry_valid_ym_dryrun_harness.mjs` / `_DRYRUN.txt` | PGlite dry run + its output |
| `docs/review/cert_expiry_malformed_STEP0B_OUTPUT.json` | Step 0b (read-only, live): the 7 rows by id, the submissions' shapes, triggers (none), policies |

## What it does — as ordered
1. **`public.valid_exp_ym(text)`**: IMMUTABLE, null/blank → **false**, EXECUTE authenticated (+ service_role, matching every
   cert function's grants), no anon/PUBLIC.
   **One deliberate departure from the order's literal expression — please confirm or overrule.** The ordered
   `coalesce($1 ~ '^\d{4}-(0[1-9]|1[0-2])$' and left($1,4)::int >= 1900, false)` is written instead as
   `coalesce(p_exp OPERATOR(pg_catalog.~) '^(19|[2-9][0-9])[0-9]{2}-(0[1-9]|1[0-2])$', false)`. It accepts and rejects
   exactly the same strings, but it can't raise an error and it inlines:
   - **No `::int` cast.** SQL doesn't guarantee `AND` order, and once the helper is inlined into a WHERE the planner orders
     the parts by cost. `'TBD'` reaching `left('TBD',4)::int` would raise.
   - **`[0-9]`, not `\d`.** Postgres `\d` can match non-ASCII digits; JS `\d` (validExpYM) can't.
   - **Inlinable**: no `SET search_path` (the operator is schema-qualified), not definer. This one is load-bearing.
     `pa_department_radar` / `my_department_rollup` test validity in a WHERE next to `split_part(c.exp)::int`. Inlined, the
     test is the same cheap regex as today and still runs first; a normal function call (COST 100) gets ordered after the
     cast. **Mutation (c2) proves it**: with `SET search_path`, the RETEST's `'TBD'` row makes the rollup and the radar raise
     `invalid input syntax for type integer: "TBD"`. The migration checks inlining in a real `EXPLAIN`.
   - Supabase's linter will flag "mutable search_path" on it. That's expected and harmless for a table-less function with a
     qualified operator.
2. **The 5 readers, 10 sites**: each is `CREATE OR REPLACE` from its **live** text (live md5 pinned) with only the validity
   test swapped. Post-conditions: the new body equals `replace(live, old, new)`, the old test is gone, the reviewed md5
   matches, and identity / grants / definer / search_path / owner are unchanged.
3. **`update_cert`** refuses a non-blank invalid exp: `Expiration must be a real month as YYYY-MM (e.g. 2027-06).`
   Blank or NULL still clears the date.
4. **`approve_cert_submission`** approves with a malformed exp nulled (`case when valid_exp_ym(sub.exp) then sub.exp end`), so
   there's no refusal. Live impact today: none. Step 0b shows 0 pending malformed submissions. The 24 malformed ones are all
   already approved history, and `cert_submissions` is md5-checked unchanged.
5. **The data, in the same block**: the 7 rows are pinned by id + department + current value.
   - Demo: `2026-09-15`→`2026-09`, `2026-12-31`→`2026-12`, `2027-03-01`→`2027-03`, `2027-05-01`→`2027-05`,
     `2027-06-01`→`2027-06`, `2028-01-01`→`2028-01`.
   - North Hood: `0000-00`→NULL.
   - Each UPDATE is scoped by department + id + the old shape, with row counts 6 and 1 asserted.
   - Post-conditions: the 7 rows hold their targets; every other cert row and the 7 rows' other columns are byte-identical;
     the certs count is unchanged; malformed certs drop by exactly 7.
   - **Heads-up: Demo's numbers move.** As of 2026-10, `2026-09` reads EXPIRED, `2026-12` EXPIRING, and the rest CURRENT.
     In the dry run, Demo's readiness went to current 5 · expiring 1 · expired 1 · no_date 0.
6. Every other function, policy and trigger is byte-identical, and the function count goes up by exactly 1.
   total_policies and the locked-token count are unchanged. `verified` is not touched.

## Dry run (PGlite, mock rebuilt from live: all 7 live md5s reproduce byte-identically)
- **Client ↔ SQL, the validator:** `validExpYM` vs `valid_exp_ym` agree on all 30 inputs, including NULL, `''`,
  `2026-09-15`, `0000-00`, `1899-12`, and full-width and Arabic-Indic digits.
- **Client ↔ SQL, status per cert:** the real `certStatus()` (bundled from `src/App.jsx`) agrees with `dept_cert_readiness()`
  and `expiration_rows()` on all 32 certs (16 values, plain and never-expires):
  - **NULL and `2026-09-15`**, along with `''`, `0000-00`, `0000-01`, `2026-00`, `2026-13`, `1899-12` and `TBD`, read
    **no_date on both sides, never expired**;
  - **a real past month reads expired on both**;
  - this month and +1/+3 read expiring, +4 and +24 read current;
  - **a never-expires type wins over every one of the 16, past months and garbage included: no_expiry everywhere**.
- **Probe of the reported bug** (North Hood's `0000-00`):
  - before: readiness expired 1, rollup expired 1, `expiration_rows` reads `0000-01` as expired;
  - after: 0 expired, and both read no_date.
- **RETEST before the fix:** fails (no helper).
- **Apply:** state row `helper_ok · helper_inlinable · grants_ok true · sites_repointed 10 · old_tests_left 0 ·
  update_refuses · approve_clears true · helper_md5 51b8cde1 · demo_values 2026-09,2026-12,2027-03,2027-05,2027-06,2028-01 ·
  north_hood_exp NULL · malformed_certs 0`. A re-run is refused ("already applied").
- **RETEST after: 35 passed, 0 failed, 0 skipped** across 4 departments:
  - S0 helper, S1 md5s, L1 live consistency;
  - per department: G1 readiness, G2 rollup, G3 radar, G4 expiration_rows, G5 probation, **G6 never-expires wins**,
    **U1 update_cert refuses 7 garbage values and accepts 2027-06**, A1 approve clears malformed dates.
  - It rolls back with certs byte-identical.
- **Code mutations, all refused.** Each of these is refused, and with post-conditions stripped the RETEST catches it:
  - (a) no year bound;
  - (b) no coalesce;
  - (c) SET search_path / not inlined — this one raises on 'TBD';
  - (f) readiness made month-only;
  - (g) old update_cert message;
  - (h) approve copies verbatim.

  These are refused outright:
  - (d) SECURITY DEFINER; (e) anon grant;
  - (i) an extra body edit; (j) a collateral function change;
  - (k) a policy change; (l) a trigger change;
  - (m) a non-target cert changed;
  - (n), (o) live drift;
  - (p) already applied.
- **Data mutations, all refused with certs untouched:**
  - (c1) a target drifted; (c2) a target moved department; (c3) a target already hand-fixed;
  - (c4) an unscoped Demo UPDATE (touched 7, not 6);
  - (c5) NH set to `''`; (c6) another column changed;
  - (c7) a cert_submissions row changed.

## Live RETEST — what to expect
Per department it needs a DA with a unique email and an auth user (else SKIP). G3 runs as a Project Admin (live PAs are also
DAs, which is fine here because the radar is cross-department). G5, G6 and A1 insert a synthetic onboarding item, cert type
and submission; if a live constraint refuses one, it **SKIPS with the reason** and the dry run is the proof. L1 runs over the
live data after the cleanup (0 malformed left).

## Apply sequence (after PASS)
1. `sql/cert_expiry_valid_ym_DRAFT.sql` — expect the state row: helper_ok / helper_inlinable / grants_ok true · sites_repointed 10 ·
   old_tests_left 0 · update_refuses / approve_clears true · helper_md5 51b8cde1 ·
   demo_values 2026-09,2026-12,2027-03,2027-05,2027-06,2028-01 · north_hood_exp NULL · malformed_certs 0 · certs_total 179 ·
   total_policies 173 · locked_token_fns 17.
2. `sql/cert_expiry_valid_ym_RETEST.sql` — the passed / failed / skipped report.
