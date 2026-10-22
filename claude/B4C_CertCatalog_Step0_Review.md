# B4C — Cert Catalog Step 0: reviewer rulings + Step 0b request

Reviewed by Claude (gate reviewer) 2026-10-21 from the actual live definitions in `docs/review/cert_catalog_STEP0_OUTPUT.md` (CC's `ddce30a`), not the summary. CC's Step 0 was thorough and the findings check out against the real bodies. Build order the catalog follows: [[B4C_CertCatalog_Concept_Step0]].

## Rulings on the findings
- **F1 (cross-department cert write/delete) — CONFIRMED, fix standalone first.** `update_cert` + `delete_cert` gate on the unscoped `is_department_admin()` and skip the dept check. Shipped as its own fix: [[B4C_CertWriteGate_Fix_BuildOrder]]. Not folded into the catalog — it's a security fix, independent, and `delete_cert` isn't otherwise touched by the feature.
- **F2 (three YYYY-MM rules) — handle in the catalog, not the F1 fix.** `update_cert`/`dept_cert_readiness`/`certStatus` accept any 2 digits (2026-13 passes); `expiration_rows` requires 01–12; `approve_cert_submission` copies with no check; no CHECK on either `exp` column. Align the write-side validation (and consider a CHECK) when the catalog touches the cert date logic. The F1 fix leaves the regex as-is on purpose (pure security change).
- **F3 (dashboard vs Expirations drift) — the real design fork; I settle it with Step 0b.** `dept_cert_readiness` = ≤3 months + counts every cert; `expiration_rows` = ≤30 days + honest roster (excludes Inactive/PA/separated). `never_expires` has to land in both plus the scorecard, consistently. I decide "own `no_expiry` bucket vs excluded from `total_dated`" once I've seen `readiness_window` and the rollup/radar readers (below) — so the dashboard %, Expirations, and the scorecard can't disagree.
- **F5 — split.** The `{public}` `Leaders read all certs` policy and the email-match-no-dept `Members read own certs` read go in a **future RLS-normalization pass**, not this feature (noted, not fixed here). But the **`readiness_items` label/satisfied CASE gap is in scope**: a new `cert_type` kind with no explicit branch falls through to "Fit test" + judged against `best_cred` (NULL) → reads "missing". The catalog migration adds explicit `cert_type` branches to label, satisfied, status, the expires_on line, and the order-by — confirmed necessary from the body (line ~517–548).
- **Confirmed-clean items accepted:** no catalog exists; no triggers on `certs`/`cert_submissions`; `certs` is SELECT-policy-only so only the 3 definer RPCs write; anon can't run any cert fn; `is_dept_admin()` md5 `c692e44f…` dept-scoped. Good foundation — the catalog is purely additive.

## Step 0b — read-only, needed before I write the catalog migration
`never_expires` changes how a cert reads, so I must see every place a cert is read before modifying `expiration_rows`/`dept_cert_readiness`. Paste the full `pg_get_functiondef` for:
1. **`readiness_window(text, date)`** — maps bucket+expires_on → status word (used by `readiness_items` and `readiness_verdict`'s cert list). I need its exact mapping to decide how a no-expiry cert reads.
2. **`my_expirations()`** — confirm it delegates to `expiration_rows` (so it inherits the change) or has its own cert logic.
3. **`my_department_rollup()`** — does it count certs / cert status? If so, `never_expires` must land here too.
4. **`pa_department_radar()`** — same question (the PA cross-dept dashboard).
5. **`probation_item_states(uuid,uuid)`** and **`is_muted(uuid,text)`** — both showed up in the certs-touching scan; paste them so I can confirm `never_expires` doesn't perturb them.
6. **`qualification_cells(uuid,uuid)`** — the pattern `readiness_items` uses to resolve a `qualification_type` requirement; I'll mirror its shape for the `cert_type` branch.
7. **The `readiness_requirements_uq` index** — `select indexdef from pg_indexes where indexname = 'readiness_requirements_uq'`. Confirm it's live and `NULLS NOT DISTINCT` over `(department_id, kind, ref_id)` — the catalog's `cert_type` kind carries a **non-null** `ref_id` (the cert_type id), so the `ON CONFLICT (department_id, kind, ref_id)` upsert needs this index present and covering non-null ref_ids.
8. **The 27 malformed `exp` values** (21 Indian Harbor + 6 Demo), distinct, no PII — just the raw strings — so I can see what the F2 cleanup is actually dealing with.

Once Step 0b is back I write the catalog DB migration build order (cert_types table, nullable `cert_type_id` on certs, the `never_expires` behavior landed consistently across the readers, the `cert_type` readiness kind with its `readiness_items` branches), you draft it, I gate-review PASS before apply — then the UI slice.

## Sequence
1. **F1 cert write-gate fix** (standalone security fix) — build, review, apply, RETEST. [[B4C_CertWriteGate_Fix_BuildOrder]]
2. **Step 0b** (read-only) — CC pulls the 8 items above.
3. **Catalog DB migration** — I write it from Step 0b, CC drafts, I review, apply.
4. **Catalog UI** — manage types, pick a type on a cert, add a cert type as a readiness requirement.
