# B4C — Cert Catalog (option 4) DB — BUILD ORDER for CC

**Scope (locked Oct 20):** per-department cert **types**, each with a **"doesn't expire"** flag, and any type can **gate readiness** in #5. Existing cert names stay as-is (nullable link). Built on the live definitions in `docs/review/cert_catalog_STEP0_OUTPUT.md` + `..._STEP0B_OUTPUT.md`; reviewer rulings in [[B4C_CertCatalog_Step0_Review]]. **F1 (cert write-gate) is LIVE**, so the re-gated functions are the baseline. Additive; `verified` never touched; standard discipline.

**Two DB slices — draft A first, I gate-review PASS before apply, then B.** Each is a single all-or-nothing DO block pinning the current md5 of every function it touches and snapshotting every other function/policy byte-identical.

---

## SLICE A — catalog foundation + "doesn't expire" (the Indian Harbor / Tommy pain)

### A1. New table `cert_types`
`id uuid PK = gen_random_uuid()` · `department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE` · `name text NOT NULL` · `never_expires boolean NOT NULL DEFAULT false` · `created_at/by`, `updated_at/by`. RLS **ON**; a UNIQUE index on `(department_id, lower(btrim(name)))`. One SELECT policy `{authenticated}` USING `department_id = my_department_id()` (dept members read the catalog); **no write policy** — all writes via the RPCs below.

### A2. Link `certs.cert_type_id`
`ALTER TABLE certs ADD COLUMN cert_type_id uuid REFERENCES cert_types(id) ON DELETE SET NULL` — **nullable**. Existing certs stay null → behave exactly as today. (No column GRANT needed — same as the event-details migration; `certs` has full table grants, RLS is the gate. Confirm in the migration with `has_column_privilege`.)

### A3. RPCs (all `SECURITY DEFINER`, `search_path=public`, dept-scoped)
- `set_cert_type(p_id uuid, p_name text, p_never_expires boolean)` — `is_dept_admin()`; upsert within `my_department_id()`; unique name (friendly error on clash); returns the row.
- `delete_cert_type(p_id uuid)` — `is_dept_admin()`, dept-scoped; the `ON DELETE SET NULL` FK clears referencing certs' `cert_type_id` (certs are NOT deleted).
- `dept_cert_types()` — read the department's catalog (dept members).
- `assign_cert_type(p_cert_id uuid, p_cert_type_id uuid)` — `is_dept_admin()`; sets `certs.cert_type_id`, validating **both** the cert and the type are in `my_department_id()`; `p_cert_type_id = NULL` un-assigns. **Do NOT overload `update_cert`** — leave F1's reviewed `update_cert(uuid,text,text)` (md5 `08ec5f34…`) untouched; the type link is its own action.

### A4. "Doesn't expire" in the cert READERS — where `never_expires` lands (pin each md5)
A cert linked to a `never_expires` type must read as **satisfied / no-expiry**, never as a `no_date` gap or `expired`. Touch exactly these, each pinned to its live md5 and each change minimal:
- **`expiration_rows(uuid,uuid)`** (md5 `3223629e…`): left-join the cert to its type; when `never_expires`, emit the cert row with `expires_on = NULL` but a **new `bucket = 'no_expiry'`** (not `no_date`), ranked with `current` (satisfied), not with the attention items. A cert with no type, or an expiring type, keeps today's YYYY-MM/`no_date` logic. This feeds #4 Expirations, `my_expirations`, and the scorecard's certs list.
- **`readiness_window(text,date)`** (md5 `35a62755…`, G3): pass `no_expiry` through like `expired`/`no_date` stand today (`when p_bucket in ('expired','no_date','no_expiry') then p_bucket`), so it never collapses to `no_date`.
- **`dept_cert_readiness()`** (md5 `808e173f…`, G5): a `never_expires` cert counts as **satisfied/current** (its own `no_expiry` tally or folded into `current`), NOT `no_date`. Decide one: I'll take **a distinct `no_expiry` count surfaced as satisfied**, excluded from the "needs a date" nudge. (Keep the existing F2 lax-vs-strict behavior otherwise — do not re-fight F2 here beyond what `never_expires` needs.)
- **`probation_item_states(uuid,uuid)`** (md5 `bbe66fca…`, G4): the `kind='cert'` item's "current" check passes if the matched cert is `never_expires` (regardless of date), in addition to today's strict-YYYY-MM-in-future test. (Keeping the name match is fine for A; the optional `cert_type_id` match is Slice B / later.)
- **Confirmed no change for A:** `my_department_rollup()` + `pa_department_radar()` count only **dated** certs, so an undated `never_expires` cert is simply uncounted (never read as expired) — leave them as-is. `my_expirations()` delegates to `expiration_rows`, so it inherits A for free.

### A5. Discipline + proof
Pin the live md5 of every function A touches (above) + `is_dept_admin()` `c692e44f…`; snapshot **every other** function + policy byte-identical; precondition that no catalog table/column exists yet (re-run-safe); post-conditions assert the new table (RLS on, the one SELECT policy, the unique index), `certs.cert_type_id` nullable FK, the touched functions carry exactly the intended change (and nothing else's md5 moved), `verified` untouched, `total_policies` delta = expected. **PGlite dry run with mutations** (never_expires not passed through readiness_window → caught; a reader left on `no_date` → caught; a collateral function change → caught; the unique index missing → caught). **Live RETEST (SENTINEL-rolled-back):** a DA creates a `never_expires` type, assigns it to a blank-exp cert → that cert reads `no_expiry` (not red/not `no_date`) in `expiration_rows`/dashboard/probation; a DA of another dept can't set/assign; a plain member can't manage types.

---

## SLICE B — cert-gated readiness (a cert type can gate "Ready")
After A is applied. Adds the `cert_type` requirement kind:
- **`readiness_requirements_kind_check`** + **`set_readiness_requirement`** (md5 `5ac03cd7…`): add `'cert_type'` to the kind list; `cert_type` carries a non-null `ref_id` (the cert_type id) — it fits `readiness_requirements_ref_chk` as-is (non-credential kinds require `ref_id`); validate the ref_id is a `cert_type` in the dept. The `readiness_requirements_uq` index (live, `NULLS NOT DISTINCT`) covers it.
- **`readiness_items(uuid,uuid)`** (md5 `2a0bca8b…`): add explicit `cert_type` branches to the label, `satisfied`, `status`, `expires_on`, and order-by CASE chains (Step 0b F5 — without them a `cert_type` kind falls through to "Fit test" + reads "missing"). Satisfied when the member holds a cert of that type that is `never_expires` (holding it satisfies) OR current (not expired / not `no_date`); label = the cert type's name; status `qualified`/`missing`/`expiring` accordingly.
- `member_scorecard` / `readiness_verdict` call `readiness_items`, so the kind propagates; the 'certs' visibility list is unchanged.
- Same discipline: pin the touched md5s, snapshot the rest, dry run + RETEST (a dept requires a cert type; a member with a current/never-expires cert of it reads satisfied; without → "Not ready" naming the cert type; the honest default — no_date/expired never satisfies — preserved).

---

## Then the UI slice(s)
Manage cert types (DA/PA: name + "doesn't expire"), assign a type on a member's cert, and add a cert type as a readiness requirement in #5's configurator — delivered as a reviewed diff, then promote. Scope that after Slice A's DB PASS.

**Draft Slice A first; deliver the migration + dry run + RETEST for gate review before apply.**

---

## Amendment (Ashlea, Oct 21) — applies to Slice A
- **`cert_types.category`** — `text NOT NULL DEFAULT 'certification'`, CHECK `category IN ('certification', 'continuing_education')`, so the UI can group the two buckets. `set_cert_type` takes it (optional, defaults to `certification`); `dept_cert_types()` returns it.
- **No seed list in Slice A.** The standard-cert list (SFFMA / TCFP / EMS) is a later follow-on — Slice A creates the table empty; departments add their own types.
- Everything else above stands as written.
- **Carry to the catalog UI slice (reviewer, Oct 21):** it must update `shared/expiry.js` (`expiryBucket` + `BUCKET_RANK`) and `certStatus()` to handle `no_expiry` — otherwise an assigned never-expires cert still shows "No date" on the roster and the Expirations dashboard.
