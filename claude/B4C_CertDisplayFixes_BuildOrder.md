# B4C — Cert display fixes (Step 0b G1 + G2) — BUILD ORDER for CC

Two live, customer-visible cert display bugs CC surfaced in Step 0b (`docs/review/cert_catalog_STEP0B_OUTPUT.md`). Both are small, safe, and independent of the catalog feature — worth fixing now rather than waiting on the catalog. Neither is a write-path or security issue.

## G2 — `my_department_rollup()` cert counts are dead (doubled backslash)
Live `my_department_rollup()` (md5 `058316de93cfdde8fbe732121c4b903f`) carries **`'^\\d{4}-\\d{2}$'`** (two backslashes) in all five cert-count regexes (`expiring_certs_count`, `expired_certs_count`, `my_certs_current`, `my_certs_expiring`, `my_certs_expired`). Under `standard_conforming_strings = on` that matches "a literal backslash then dddd", so it never matches a real date → **all five read 0 for every caller** (member cert card + the leaders' rollup figures), while its sibling `pa_department_radar` (single backslash) counts correctly.

**Fix:** correct the five regexes to the single-backslash form **`'^\d{4}-\d{2}$'`** — matching `pa_department_radar` and `dept_cert_readiness` (its siblings). Nothing else in the function changes.
- Migration discipline: single DO block, `CREATE OR REPLACE` the one function. Precondition pins the current md5 `058316de…` (refuse on drift) and refuses a second apply. **Post-condition (the clincher):** the new `prosrc` must equal the old live body with exactly the five `'^\\d{4}-\\d{2}$'` → `'^\d{4}-\d{2}$'` substitutions applied — nothing else moved (owner/definer/search_path/grants unchanged; every other function + policy byte-identical; `verified` untouched). State check: the five counts are non-backslashed.
- RETEST (SENTINEL-rolled-back): seed a member with one current, one expiring (≤3mo), one expired, one blank-exp cert; call as that member; assert `my_certs_current/expiring/expired` now read 1/1/1 (not 0/0/0) and the blank is uncounted. For a leader, `expiring_certs_count`/`expired_certs_count` count the dept's dated certs.

## G1 — 21 Indian Harbor `0000-00` placeholders read red EXPIRED
Indian Harbor's 21 malformed certs are all the literal **`0000-00`** (an import placeholder for "no date"). It passes the lax `^\d{4}-\d{2}$` and month 0 is in the past, so `certStatus` (roster badge), `dept_cert_readiness` (dashboard %), and `pa_department_radar` all read them **EXPIRED (red)** — while `expiration_rows`/scorecard read them "no date". 21 real certs showing a false red.

**Fix: normalize the placeholder to NULL** — `update public.certs set exp = null where exp = '0000-00';`. A blank `exp` reads "no date" in every reader (consistent), so the false red disappears immediately with no reader changes. `0000-00` is a meaningless placeholder; nulling it is strictly correct and reversible.
- Guard it: assert **exactly 21 rows** match `exp = '0000-00'` before the update and the update touches exactly those (all Indian Harbor); abort otherwise. Don't touch Demo's 6 malformed rows (they're full `YYYY-MM-DD` ISO dates — handle those date-recoveries, if wanted, in the catalog; they're Demo/low-stakes and already read "no date").
- This is a one-statement data fix — deliver it as its own small reviewed script (or the same migration as G2, clearly sectioned). Assert the after-count: 0 rows with `exp = '0000-00'`.

## Deliver both drafts for my gate review before apply.
These don't touch the catalog's deeper work. The remaining Step 0b findings — **G3** (`readiness_window` needs a no-expiry passthrough), **G4** (`probation_item_states` cert match by name + strict date), **G5** (the dashboard readers' own cert logic) — are where `never_expires` has to land, and I handle those in the **catalog DB migration** (next), now that I have every reader body. Do NOT fold them here.
