# B4C — Cert dates Slice A (DB): migration + dry run + RETEST (for gate review, NOT applied)

Step 0 PASS [[B4C_CertDates_SliceA_Step0_ReviewRecord]] (D1 reject a nonsense achieved_on · D2 fix the radar + rollup now ·
D3-a one `update_cert` with optional args). Branch `feat/cert-dates-step0`.

## Files
| File | What |
|---|---|
| `sql/cert_dates_sliceA_DRAFT.sql` | one all-or-nothing DO block |
| `sql/cert_dates_sliceA_RETEST.sql` | SENTINEL RETEST (rolls back) |
| `docs/review/cert_dates_sliceA_DRAFT_DIFF.patch` | every changed body, live → new (dumped from the applied mock, not hand-written), plus the **full new `pa_department_radar` and `my_department_rollup` bodies** and the helper |
| `docs/review/cert_dates_sliceA_dryrun_harness.mjs` / `_DRYRUN.txt` | PGlite dry run + its output |

## What it does
1. **Columns.**
   - On `certs`: `achieved_on text NULL` and `no_expiry boolean NOT NULL DEFAULT false`, plus two CHECKs:
     - `certs_achieved_on_valid (achieved_on IS NULL OR valid_exp_ym(achieved_on))`;
     - `certs_no_expiry_clears_exp (NOT no_expiry OR exp IS NULL)`.
   - On `cert_submissions`: the same two columns, **without CHECKs**. A proposal carries what was typed, and approval clears
     what's invalid (clear-don't-refuse). A CHECK there would refuse the member's own submission instead. The two INSERT
     policies don't restrict columns, so there's no policy change, and the RETEST's P1 proves a member's own proposal
     persists both fields through RLS.
2. **`public.cert_never_expires(no_expiry, cert_type_id, department_id)`** is the effective rule: the flag OR the
   same-department type's `never_expires`.
   - It's the twin of Slice B's `enrichCerts`.
   - STABLE, invoker, `search_path public`; authenticated + service_role, no anon.
   - It reads `cert_types`, so it doesn't inline. In the radar/rollup WHERE clauses it sits behind the cheap inlined
     `valid_exp_ym`, which still runs before the `::int` cast. The RETEST's `'TBD'` / `''` rows raise no error.
3. **Readers — all five honour `cert.no_expiry OR type.never_expires`.** Each is the live body with exact swaps, md5-pinned
   before and after:
   - readiness, 1 site: the first CASE arm gains `c.no_expiry or`;
   - expiration_rows, 1 site: the flag's `exists` goes from `join` to `left join` (the type's department moves into the
     ON), and gains `c.no_expiry or`;
   - probation, 1 site: gains `c.no_expiry or`;
   - **the radar, 2 sites, and the rollup, 5 sites (D2):** expired / expiring gain
     `and not cert_never_expires(…)`, and `my_certs_current` becomes `cert_never_expires(…) or (valid month and > 3
     months out)`. Full bodies are in the patch.
   - The flag is ORed into the **one** boolean each reader already uses, so a cert with the flag **and** a never-expires
     type is counted **once** (RETEST N1: B "both" counts once).
4. **`update_cert(cert_id, new_name, new_exp, new_no_expiry boolean DEFAULT NULL, new_achieved_on text DEFAULT NULL)`**
   (D3-a) is a DROP + CREATE: the old body is md5-pinned, and the grants are re-applied and asserted equal to the old ones.
   - NULL = unchanged, so **today's 3-arg named call resolves to it and behaves as before**. The dry run checks this with
     a named 3-arg call.
   - "Doesn't expire" clears the date, and a non-blank date means "expires" (it clears the flag).
   - `achieved_on`: NULL leaves it unchanged; `''` clears it. It's refused if it isn't a real month, is **in the future**,
     or is **after the expiry** (D1).
5. **`approve_cert_submission`** copies both fields. A "doesn't expire" proposal lands with no date. An `achieved_on` that
   isn't a real month, is in the future, or is after the expiry is **cleared**, not refused.
6. **Nothing else moves:**
   - every other function (md5 + grants), every policy and every trigger are byte-identical; the function count goes up by
     exactly 1 (`update_cert` is replaced 1-for-1); total policies and the locked-token count are unchanged;
   - every existing certs, `cert_submissions` and `cert_types` row is unchanged, with the new columns at their defaults;
   - **the five readers' outputs on the live data are byte-identical before and after**. Captured inside the block: every
     department's `expiration_rows`, every member's probation items, each department's readiness and rollup as its DA, and
     the radar as a PA. With 0 flags and 0 types today, nothing moves, and mutation (p) proves this check bites.
   - `verified` is not touched.

## Dry run (PGlite; mock rebuilt from the live bodies — all 7 live md5s and `valid_exp_ym` 51b8cde1 reproduce byte-identically)
- **Type-gap probe** (a never-expires type with an old date, and after the fix a no_expiry cert too):
  - **before:** the radar shows expired **1**, and the member's rollup shows expired **1**, while readiness says no_expiry;
  - **after:** expired **0** everywhere; readiness no_expiry 2; rollup current 3.
- **RETEST before:** fails (no helper). **Apply:** the state row matches (below). A re-run is refused ("already applied").
- **RETEST after: 24 passed, 0 failed, 0 skipped** across 3 departments: S0 shape/md5s/helper department rule · S1 CHECKs
  bite · L1 existing rows · per department N1 (readiness / rollup / radar / expiration_rows) · N2 probation · U1 update_cert
  (9 paths) · A1 approve (5 cases) · P1 member proposal via RLS. It rolls back with certs byte-identical.
- **Mutations, all caught.** Each of these is refused; with post-conditions stripped, the RETEST catches it:
  - (a) readiness flag missing;
  - (b) radar exclusion missing;
  - (c) rollup current without never-expires;
  - (d), (e) either CHECK missing;
  - (f) update_cert grants not re-applied (anon re-opened);
  - (g) future `achieved_on` accepted;
  - (h) approve keeps an invalid `achieved_on`;
  - (i) the helper ignores the type's department.

  These are refused outright:
  - (j) `no_expiry` DEFAULT true;
  - (k) a collateral function change; (l) a policy change; (m) a trigger change;
  - (n) an existing cert changed; (o) a cert type added;
  - (p) a reader's live output changed, with the md5 pin stripped so only the read-identity check stands;
  - (q), (r) live drift;
  - (s) already applied.

## Live RETEST — what to expect
- Per department it needs a DA with a unique email and an auth user (else SKIP all). N1-radar needs a PA with an auth user.
  P1 needs a plain member with a unique email and an auth user (else SKIP).
- **N2 probation** now clones an existing onboarding item instead of hand-writing one. That's why the cert-expiry RETEST
  had to skip it (`category` is NOT NULL live). If live has no item to clone, or a kind-specific constraint refuses the
  clone, it SKIPS with the reason.

## Apply (after PASS) — expected state row
```
columns_ok true · checks_ok true · helper_ok true · update_cert_args 5 · update_cert_old_gone true · grants_ok true ·
no_expiry_sites dept_cert_readiness() 1 · expiration_rows(uuid,uuid) 1 · my_department_rollup() 5 · pa_department_radar() 2 ·
probation_item_states(uuid,uuid) 1 · update_cert_md5 88ae9180 · helper_md5 7c4083b5 · existing_defaults 0 · certs_total 179 ·
total_policies 173 · locked_token_fns 17
```
Then `sql/cert_dates_sliceA_RETEST.sql`, which reports passed / failed / skipped.

## Notes for Slice B
- The client calls `update_cert` with named args. Add `new_no_expiry` / `new_achieved_on` only when the form sets them.
- `enrichCerts` → `neverExpires: !!c.no_expiry || !!t?.never_expires`.
- The two cert SELECTs add `no_expiry, achieved_on`.
- `api/digest.js` `certExpiryEnd` + `certRank` → the shared rule (plus effective never-expires).
- `api/assistant.js` `my_certs` passes `no_expiry` through.
