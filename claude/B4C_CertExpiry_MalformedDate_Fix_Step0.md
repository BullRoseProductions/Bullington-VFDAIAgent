# B4C — Cert expiry: malformed date — SQL STEP 0 (for gate review, no SQL yet)

Order: [[B4C_CertExpiry_MalformedDate_Fix_BuildOrder]]. Read from **live** (read-only, 2026-10-24 —
`docs/review/cert_expiry_malformed_STEP0_OUTPUT.json`: every public function whose source references both `certs` and `exp`,
with full bodies + md5s; the malformed-row audit as **counts only**, no data touched). Baselines: **173 policies**,
**17 locked-token functions**, **179 certs**. `certs.exp` is `text` with **no CHECK constraint**.

The client half ships in the same commit: one shared rule, `validExpYM(exp)` in `shared/expiry.js` — shape `YYYY-MM`
**and** month 01–12 **and** year ≥ 1900 — used by `certStatus`, `expPhrase`, the three save validators, the cert sort
(App.jsx) and the assistant's `certStatus` (api/assistant.js). The SQL must match **that** rule exactly.

## The readers — how each validates today

| Function (md5) | Sites | Validity test today | `"0000-00"` | `"0000-01"` (year 0) | Verdict |
|---|---|---|---|---|---|
| `dept_cert_readiness()` (d0d54de6) | 1 `case` (no_date / expired / expiring) | shape only `^\d{4}-\d{2}$` | **expired** | **expired** | **LEAKS — the reported bug's SQL twin** (the readiness % the client mirrors) |
| `pa_department_radar()` (224f9ec3) | 2 counts (expired, expiring) | shape only | counted **expired** | counted **expired** | **LEAKS** (PA radar's per-dept expired / expiring counts) |
| `my_department_rollup()` (7b12e359) | 5 predicates (dept counts + "mine" counts) | shape only | counted **expired** | counted **expired** | **LEAKS** (the multi-department rollup) |
| `expiration_rows(uuid,uuid)` (27645093) | 1 (`expires_on`) | month 01–12, **no year** | no date ✓ | **expired** ✗ | **partial** — needs only the year bound |
| `probation_item_states(uuid,uuid)` (c663eb8a) | 1 (cert-type probation item: "is there a CURRENT cert?") | month 01–12, **no year** | not satisfied ✓ | not satisfied ✓ (a year-0 date is in the past; past and undated both fail a "must be current" item) | **safe** — outcome can't differ; repoint only so one rule lives everywhere (optional) |
| `update_cert(uuid,text,text)` (08ec5f34) | writer | none — stores any non-blank text | — | — | writer (see below) |
| `approve_cert_submission(uuid)` (5a1a89ee) | writer | none — copies `cert_submissions.exp` verbatim into `certs` | — | — | writer (see below) |

No views reference `certs`.

## What's actually in the data (counts, read-only)
- **North Hood: 1** row — `"0000-00"` (the reported Boaters Ed Cert). Shape-valid, month-invalid: today it reads **expired** in
  `dept_cert_readiness` / the radar / the rollup, **no date** in `expiration_rows` — the client↔SQL disagreement is real.
- **B4C Demo Department: 6** rows stored as full dates (`2026-09-15`, `2026-12-31`, `2027-03-01`, `2027-05-01`, `2027-06-01`,
  `2028-01-01`). Every reader and the client already treat these as **no date** (the anchored `$` rejects the `-DD`), so they
  agree — but they're probably *meant* as real dates (demo seed data). Cleanup candidate, not a hardening issue.
- **Pre-1900 years: 0.** **`cert_submissions` with a malformed `exp`: 24** — `approve_cert_submission` would copy them into
  `certs` as-is.

## Recommendation — the minimal complete SQL fix (lockstep with `validExpYM`)
1. **One helper**, `public.valid_exp_ym(text) RETURNS boolean` — `LANGUAGE sql IMMUTABLE`, no definer needed:
   `select $1 ~ '^\d{4}-(0[1-9]|1[0-2])$' and left($1, 4)::int >= 1900` (null → false). The SQL twin of `validExpYM`, so the
   rule lives once on each side. EXECUTE authenticated (revoke PUBLIC / anon) like the other helpers.
2. **Repoint the readers' validity predicates to it — nothing else in their bodies.** Required (they disagree with the client
   today): `dept_cert_readiness` (1 site) · `pa_department_radar` (2) · `my_department_rollup` (5) · `expiration_rows` (1 —
   the year bound). Optional, consistency only (its outcome can't change): `probation_item_states` (1). **Recommend all
   five, 10 sites**, so the rule lives in one helper and can't drift; the reviewer may drop probation to shrink the diff. Each re-created with `CREATE OR REPLACE` from its **live** body with only the validity test
   swapped (`c.exp ~ '^\d{4}-\d{2}$'` / `c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'` → `public.valid_exp_ym(c.exp)`, and in
   `dept_cert_readiness` `c.exp !~ …` → `not public.valid_exp_ym(c.exp)`); post-conditions require each to equal its
   pre-image with exactly that swap (the Training Officers method). `CREATE OR REPLACE` keeps the grants — no ACL replay
   (the Slice A `dept_cert_readiness` grant lesson).
   Note `pa_department_radar` has been lost-and-re-applied before ([[migrations-applied-by-hand]]) — the migration pins the
   **live** md5 above and builds from the live text, never the repo file.
3. **Writers — recommend in the same migration, small:** `update_cert` refuses a non-blank `exp` that fails
   `valid_exp_ym` with the client's message ("Expiration must be a real month as YYYY-MM (e.g. 2027-06)."), so the server
   can't store new garbage even if a client skips validation. **`approve_cert_submission`: needs Ashlea's call** — the 24
   malformed submissions would either be refused on approval (an officer then fixes the date) or approved with `exp` nulled
   (reads "No expiration date"). Recommend **refuse with the message** (no silent data loss); flag it.
4. **No CHECK constraint on `certs.exp`** in this slice — it would fail on the 7 existing rows; add it after a cleanup if wanted.

**Expected dry-run / RETEST proof:** a `0000-00`, `2026-00`, `2026-13`, `0000-01` cert reads no date / not expired in all five
readers (readiness, radar, rollup, expiration_rows, probation); a real past month still expired; a never-expires type still
wins (`expiration_rows` / readiness); a full-date (`2026-09-15`) row unchanged (no date, as today); `update_cert` refuses
garbage and accepts `2027-06`; every other function / policy / trigger byte-identical; `total_policies` 173 and the
locked-token count 17 unchanged.

## Optional — data cleanup (Ashlea's call, not part of the fix)
The hardening makes all 7 rows read "No expiration date" correctly. Separately: null North Hood's `0000-00` (or set the real
date), and convert Demo's 6 full dates to `YYYY-MM` (`2026-09-15` → `2026-09`) so they read as the dates they look like. A
scoped, reviewed `UPDATE` — nothing touched without sign-off.
