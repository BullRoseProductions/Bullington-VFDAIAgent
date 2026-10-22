# B4C — Review Record: Cert write-gate fix (Step 0 F1)

**Verdict: PASS — safe to apply.** Reviewed by Claude (gate reviewer) 2026-10-21. DRAFT `c6931d1` (`sql/cert_write_gate_fix_DRAFT.sql` + `sql/cert_write_gate_fix_RETEST.sql` + the diff patch). Unreviewed/unapplied at review time. Order: [[B4C_CertWriteGate_Fix_BuildOrder]]; Step 0: `docs/review/cert_catalog_STEP0_OUTPUT.md`. DB functions only — live on web AND native the moment applied, no deploy.

**How I reviewed it:** read the actual DRAFT line by line and the RETEST, not CC's summary. Confirmed the gap from the live Step 0 bodies.

## The gap (confirmed)
`update_cert` and `delete_cert` gate on `is_department_admin()` (the unscoped role-anywhere gate, md5 `99570e17…`) and act on `where id = cert_id` with no department term — a DA of any department could rename/re-date/delete any department's cert given its id. Latent (cert ids are uuids; the `certs` SELECT policies only reveal own-department ids). The correct pattern is `approve_cert_submission`'s `is_dept_admin()` + dept check.

## Verified
- **Exactly the two substitutions, nothing else.** Each function: gate `is_department_admin()` → `is_dept_admin()`, and `where id = cert_id` → `where id = cert_id and department_id = public.my_department_id()`. The name/exp validation (incl. the lax `^\d{4}-\d{2}$` regex — F2, deferred), comments, error texts, `SECURITY DEFINER`, `search_path`, owner and grants are untouched.
- **The byte-equality post-condition is the clincher.** Post-condition (1) asserts each new `prosrc` is *identical* to the old live body with exactly those two string substitutions applied (`replace(replace(old, GATE_OLD, GATE_NEW), WHERE_OLD, WHERE_NEW)`). So the hand-written body in the migration cannot smuggle in any other change — if it did, the DO block raises and rolls back. Fail-safe by construction (single all-or-nothing block).
- **Pins + drift guards.** Preconditions pin both current md5s (`5cd098a1…`, `8d0a006c…`), `is_dept_admin()` = `c692e44f…`, `is_department_admin()` = `99570e17…`; refuse a second apply (NEW md5s) and refuse if any edit anchor doesn't occur exactly once. Post-conditions pin the new md5s, assert no `is_department_admin` remains + `is_dept_admin()` + `my_department_id()` present, owner/definer/search_path/grants unchanged, every other function byte-identical, every policy byte-identical, policy count and the split-token `verified` count unchanged. `verified` never touched.
- **Non-leaky scope.** A cross-department id and a nonexistent id both match 0 rows → the existing `if not found` raises "Certification not found" — never reveals the id exists elsewhere.
- **RETEST is genuine, role-switched (not self-certifying).** Per department, with a real DA here, a plain member here, and a DA of another department (unique emails), on a self-created fixture cert, SENTINEL-rolled-back:
  - **X1** — DA of another dept (that dept active): the pre-fix gate was true (`v_old`), now `update_cert` + `delete_cert` both "Certification not found", cert unchanged. The regression-catch (the new dept-scope blocks the cross-dept write).
  - **X1b** — same DA given a plain-member row here, this dept active: refused on **authority** ("Not authorized…"). Proves the **gate swap** is load-bearing (with this dept active the WHERE would match; the gate stops it).
  - **X2** — the real DA: renames (with trim) + re-dates, then deletes. Legit use intact.
  - **X3** — the plain member (owner): both refused on authority.

## Apply (after this PASS)
Ashlea runs `sql/cert_write_gate_fix_DRAFT.sql` (single DO block; refuses a second apply or any drift). Confirm the state row: **regated 2 · role_anywhere_left 0 · dept_scoped 2 · total_policies 169 · locked_token_fns 17**. Then run `sql/cert_write_gate_fix_RETEST.sql` live, separately (SENTINEL-rolled-back) — expect the multi-member departments to pass X1/X1b/X2/X3; Demo/Granbury skip if they lack the two-member shape. Rollback if ever needed: restore the two functions to the pre-fix bodies (recorded in Step 0).
