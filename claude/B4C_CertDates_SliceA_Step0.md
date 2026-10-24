# B4C — Cert dates (achieved_on + per-cert no_expiry) — Slice A (DB) STEP 0 (for gate review, no SQL yet)

Concept [[B4C_CertDates_AchievedOn_NoExpiry_Concept]]. Read from **live**, read-only, 2026-10-24:
`docs/review/cert_dates_STEP0_OUTPUT.json`. It holds every public function touching `certs` / `cert_submissions` /
`cert_types` / `never_expires` (20, with full bodies and md5s), plus the three tables' columns, constraints, indexes,
policies, triggers and grants, and the counts. The client and `api/` were audited from `main` @ `2a94baa`.

## Live baseline
- **179 certs**, of which **137 have no `exp`** (NULL/blank) and **0 are malformed** (after this morning's cleanup).
- **`cert_types`: 0 rows.** No cert has a type, so **no cert is never-expires today**. The new per-cert flag will be the
  first never-expires path anyone actually uses. Every reader change below therefore moves **no live number** on the
  day it's applied: 0 flags and 0 types.
- `cert_submissions`: 3 pending · 215 approved · 18 rejected.
- 173 policies · 17 locked-token functions.
- No triggers on any of the three tables. No views reference them.
- The 5 readers + 2 writers are **exactly this morning's reviewed post-migration md5s**, with no drift:
  - readiness 6a550331 · radar 5093693f · rollup f46794cc · expiration_rows 4ccf41b4 · probation 677b005d
  - update_cert 232cd2f1 · approve 01c1c75c
- Grants: authenticated + service_role on 5 of the 7. `expiration_rows` / `probation_item_states` are internal (service_role
  only).
- `certs` columns: `id, department_id, member_id, name, exp text, created_at, proof_path, cert_type_id`.
  `cert_submissions` columns: `… name, exp text, status, source, note, proposed_by, reviewed_by, reviewed_at, created_at,
  proof_path`.
- Neither table has a CHECK on `exp`. `certs.cert_type_id` → `cert_types` is `ON DELETE SET NULL`.

## 1. How each reader derives never-expires today
| Reader | How never-expires is decided | Where `exp` is read |
|---|---|---|
| `dept_cert_readiness()` | `left join cert_types t on t.id = c.cert_type_id and t.department_id = c.department_id`; then the **first CASE arm** is `when coalesce(t.never_expires, false) then 'no_expiry'`, ahead of `no_date` / expired / expiring / current | CASE arms 2–4 |
| `expiration_rows(uuid,uuid)` | a **lateral flag** per row: `nx.flag = r.source = 'cert' and exists (select 1 from certs c join cert_types t on t.id = c.cert_type_id where c.id = r.item_id and t.department_id = p_dept and t.never_expires)`. When the flag is set, `expires_on` / `days_until` are nulled, the bucket is `'no_expiry'`, and it sorts last | `raw` CTE: `case when valid_exp_ym(c.exp) then <last day of month>` |
| `probation_item_states(uuid,uuid)` | inside the cert item's `exists`: `left join cert_types t … and t.department_id = p_dept` and `(coalesce(t.never_expires, false) or (valid_exp_ym(c.exp) and <month ≥ this month>))` | the same predicate |
| `pa_department_radar()` | **not at all.** Two counts, `expiring_certs_count` and `expired_certs_count`, are `valid_exp_ym(c.exp) and <month arithmetic>`. There is no type join | 2 sites |
| `my_department_rollup()` | **not at all.** Leadership `expiring` / `expired` (2) and the caller's `my_certs_current` / `_expiring` / `_expired` (3) are all `valid_exp_ym(c.exp) and <month arithmetic>` | 5 sites |

**Downstream inherits — no edits needed.** `readiness_items` and `readiness_verdict` read cert currency only through
`expiration_rows` (`readiness_items` already ranks `no_expiry` with `current`). `my_expirations()` and `dept_expirations()`
wrap it, and `api/expiration-reminders.js` calls `dept_expirations()`. Once `expiration_rows` folds the flag in, all of
these follow.

**Pre-existing gap (found here, not caused by this feature).** The radar and the rollup ignore `never_expires`. A cert of a
never-expires type that still carries an old `exp` reads `no_expiry` in readiness / expiration_rows / probation / the
client, but **counts as expired** in the PA radar and the multi-department rollup. It's invisible today only because there
are 0 types.

## 2. How the writers build their rows
- **There is no INSERT/UPDATE policy on `certs`.** Every `certs` write goes through a definer RPC:
  - `approve_cert_submission` inserts; `update_cert` updates name/exp; `assign_cert_type` updates the type;
    `delete_cert` deletes.
  - The client never writes `certs` directly.
- **`cert_submissions` is written directly by the client** under two INSERT policies:
  - "members propose own" (`CertProposals`, App.jsx:4682, `source 'self'`, proof required);
  - "Leaders propose" (`ProposeCert`, App.jsx:12149).
  - The policies check member, department, status, `proposed_by` and proof, but **not columns**, so new columns can be
    inserted with **no policy change**.
- **`approve_cert_submission(uuid)`** (DA-gated) copies a pending submission into `certs`:
  `insert … (id, department_id, member_id, name, exp, proof_path, created_at) values (…, sub.name, case when
  valid_exp_ym(sub.exp) then sub.exp end, sub.proof_path, now())`. That's Ashlea's clear-don't-refuse rule.
- **`update_cert(cert_id, new_name, new_exp)`** (DA-gated, `is_dept_admin()`) refuses a non-blank invalid exp with the
  client's message, and stores blank as NULL. The client calls it from `MemberDetail` (App.jsx:11769) with **three named
  args**.

## 3. Recommendation — `achieved_on` type: **`YYYY-MM` text + `valid_exp_ym`** (your lean)
- **It's the same entry and the same rule as `exp`.** Every cert form enters expiry as typed `YYYY-MM` text: CertProposals
  :4703, MemberDetail :11842, ProposeCert :12160. A matching "Earned (YYYY-MM)" field next to it keeps the forms uniform,
  and one validator governs both dates, client and SQL (`validExpYM` / `valid_exp_ym`).
- **It's display-only.** No reader or logic needs day precision.
- **Against a full `date`:** day precision would add a third date convention to the cert row (month-text `exp`, a date
  picker for `achieved_on`), and `valid_exp_ym` couldn't validate it. (Credentials use `type="date"`, but they're a
  separate table.)
- **Server rules (recommended):**
  - a CHECK `certs_achieved_on_valid CHECK (achieved_on IS NULL OR valid_exp_ym(achieved_on))`. The helper is IMMUTABLE,
    so it can back a CHECK, and the column starts all-NULL;
  - `update_cert` **refuses** an `achieved_on` that is invalid, **in the future** (after this Chicago month), or **later
    than `exp`**;
  - `approve_cert_submission` **clears** such a value rather than refusing it, the same rule as for `exp`.
  - **Decision (D1):** is "not in the future / not after exp" wanted, or shape-only?

## 4. Recommendation — `no_expiry` and the invariant that makes it safe everywhere
- `certs.no_expiry boolean NOT NULL DEFAULT false`, plus the same column on `cert_submissions` (default false) so a
  proposal can carry it.
- **The invariant: `CHECK (NOT no_expiry OR exp IS NULL)`.** "Doesn't expire" means there is no expiry date. The writers
  enforce it (setting `no_expiry` clears `exp`), and the CHECK makes it impossible to violate. **Why it matters:**
  - **Legacy consumers degrade safely.** `api/digest.js` (`detectCerts`, `certsCurrentPct`), the assistant's
    `certStatus(x.exp)`, and any stale client ignore the flag. With `exp` NULL they read a flagged cert as "no date",
    **never expired or expiring**: no false alarms, no double count.
  - **The radar and rollup are already correct for the flag with zero edits.** Every one of their 7 sites requires
    `valid_exp_ym(c.exp)`, which is false for NULL.

## 5. The smallest change to each reader — effective never-expires = `c.no_expiry OR coalesce(t.never_expires, false)`
Each reader decides one bucket per cert. Both conditions are ORed into **one** boolean at the place the type is decided
today, so a cert with the flag **and** a never-expires type is still counted **once**.

| Reader | Swap (exact pre-image + swap, as in the cert-expiry migration) | Why it can't double-count |
|---|---|---|
| `dept_cert_readiness()` | 1 site: `when coalesce(t.never_expires, false) then 'no_expiry'` → `when c.no_expiry or coalesce(t.never_expires, false) then 'no_expiry'` | the CASE is first-match; one bucket per row |
| `expiration_rows(uuid,uuid)` | 1 site, the lateral flag: `exists (select 1 from public.certs c join public.cert_types t on t.id = c.cert_type_id where c.id = r.item_id and t.department_id = p_dept and t.never_expires)` → `exists (select 1 from public.certs c left join public.cert_types t on t.id = c.cert_type_id and t.department_id = p_dept where c.id = r.item_id and (c.no_expiry or coalesce(t.never_expires, false)))` | `exists` is boolean; there is one raw row per cert; the type's department condition moves into the join so an untyped flagged cert still matches |
| `probation_item_states(uuid,uuid)` | 1 site: `(coalesce(t.never_expires, false)   -- cert catalog: …` → `(c.no_expiry or coalesce(t.never_expires, false)   -- …` | it sits inside `exists` ("is there a current cert?") |
| `pa_department_radar()` | **for the flag: no change needed**, because the invariant keeps `exp` NULL. **Decision (D2), below** | — |
| `my_department_rollup()` | **for the flag: no change needed** for `expired` / `expiring`. **Decision (D2)** covers `my_certs_current` and the type gap | — |

**D2 — the radar and rollup (recommend B):**
- **A. Minimal (flag only).** Leave both untouched, which is correct by the invariant. But a flagged cert doesn't count
  toward the rollup's `my_certs_current`, while the client ranks it 2 ("counts like current"). And the pre-existing type
  gap stays open.
- **B. Lockstep (recommended).**
  - Add one STABLE helper, `public.cert_never_expires(p_no_expiry boolean, p_type_id uuid, p_dept uuid)` =
    `p_no_expiry or coalesce((select t.never_expires from cert_types t where t.id = p_type_id and t.department_id =
    p_dept), false)`. It is the single rule, the twin of `enrichCerts`' `neverExpires`.
  - Use it at the 7 radar/rollup sites:
    - the 6 expired/expiring predicates gain `and not public.cert_never_expires(c.no_expiry, c.cert_type_id,
      c.department_id)`;
    - `my_certs_current` becomes `(cert_never_expires(…) or (valid_exp_ym(c.exp) and <month diff> > 3))`.
  - This closes the type gap and puts the rollup in step with the client's rank 2. It moves **no live number**: 0 types,
    0 flags.
  - **Qual-order note:** the helper holds a sub-select, so it won't inline. In the WHERE it's ordered after the cheap
    inlined `valid_exp_ym`, which still runs before the `::int` cast, so it's safe. The `'TBD'` / `''` rows go in the
    RETEST.
  - Optionally, readiness / expiration_rows / probation could call the same helper instead of their joined `t`. The
    recommendation keeps them to the 1-token swaps above (smallest diff), but the reviewer may prefer one helper
    everywhere.

## 6. The writers — the smallest change
- **`approve_cert_submission(uuid)`:** 1 site, the insert's column and value lists. It adds `achieved_on, no_expiry`, with
  values `case when <valid achieved> then sub.achieved_on end, coalesce(sub.no_expiry, false)`. `exp` becomes
  `case when not coalesce(sub.no_expiry, false) and valid_exp_ym(sub.exp) then sub.exp end`, so a "doesn't expire"
  proposal lands with `exp` NULL and satisfies the CHECK. Nothing else changes, and Ashlea's clear-don't-refuse rule
  extends to `achieved_on`.
- **`update_cert`** needs two more inputs, so its signature changes. **Decision (D3), recommend (a):**
  - **(a) Replace with one defaulted signature.** `update_cert(cert_id uuid, new_name text, new_exp text, new_no_expiry
    boolean DEFAULT NULL, new_achieved_on text DEFAULT NULL)`, with NULL meaning "leave unchanged".
    - Legacy 3-arg calls (today's client, and any stale native build) resolve to it unchanged. One update path; no
      PostgREST overload ambiguity.
    - Cost: it's a DROP + CREATE (new signature), so the md5 pre-image method doesn't apply. The migration pins the old
      md5, creates the new body (reviewed in full), and re-applies the grants explicitly with REVOKE PUBLIC/anon and GRANT
      authenticated + service_role (the anon-revoke lesson: a DROP + CREATE re-opens anon). Then `NOTIFY pgrst`.
    - Semantics:
      - `new_no_expiry = true` → `exp` NULL;
      - a non-blank `new_exp` → `no_expiry = false` (a date means "expires");
      - blank/NULL `new_exp` with `new_no_expiry` NULL → `exp` NULL and `no_expiry` unchanged;
      - `achieved_on`: NULL = unchanged, `''` = clear, otherwise validated per D1.
  - **(b) Add a 5-arg overload with no defaults** and keep the 3-arg byte-identical. There's no DROP, but there are two
    update paths. The 3-arg would also need one line (`no_expiry = false` when a date is set), or a stale client could
    trip the CHECK by dating a flagged cert.
- **The member/leader proposal inserts** (`CertProposals`, `ProposeCert`): no DB change beyond the two
  `cert_submissions` columns. The policies don't restrict columns. Slice B adds the fields.

## 7. Outside the DB slice — lockstep items for Slice B (listed so nothing is missed)
- **Client:**
  - `enrichCerts` → `neverExpires: !!c.no_expiry || !!t?.never_expires`. That flows into `certStatus` / `expPhrase` and
    every caller: roster, coverage, reports, the dashboard tiles, Pulse.
  - The two cert SELECTs (App.jsx:2404, :2495) add `no_expiry, achieved_on`.
  - The three forms add the "Doesn't expire / Expires — YYYY-MM" choice and "Earned (YYYY-MM)".
  - `update_cert` gains the two named args.
- **`api/assistant.js` `my_certs`:** select `no_expiry` and pass it through, so it says "doesn't expire". With the
  invariant it already reads "no date", not expired.
- **`api/digest.js` — a separate pre-existing bug the malformed-date fix missed:**
  - `certExpiryEnd` and `certRank` still use the loose `/^(\d{4})-(\d{2})$/`. A `0000-00` would become Dec 1899 there:
    flagged as an **urgent expired** cert, and counted against "certs current %".
  - There's no live impact (0 malformed, and `update_cert` / approve now block new ones), but it should use
    `validExpYM` like the app and the assistant.
  - Recommend a small web-layer fix, in Slice B or as its own one-liner. Like the others, it should also exclude
    effective never-expires.

## 8. Migration shape (for when Step 0 passes)
One all-or-nothing DO block, the same discipline as cert-expiry:
- **Columns:** `certs.achieved_on text`, `certs.no_expiry boolean NOT NULL DEFAULT false`, and the same two on
  `cert_submissions`.
- **CHECKs:** `achieved_on` valid, and `no_expiry → exp IS NULL`. Both validate against the current rows: all
  `achieved_on` NULL, all `no_expiry` false.
- **Readers:** the 3 one-token swaps (pinned md5s, exact pre-image + swap), plus the D2 choice.
- **Writers:** `approve` (pre-image + swap) and `update_cert` per D3.
- **Snapshots:** every other function, policy and trigger byte-identical; policies 173, locked-token 17; certs data
  unchanged apart from the two new default columns. `NOTIFY pgrst`.
- **Dry run:** PGlite from the live bodies.
- **SENTINEL RETEST:**
  - a flagged cert reads no_expiry in all 5 readers;
  - flag + never-expires type is counted once;
  - flag with an old date is refused by the CHECK;
  - `update_cert` 3-arg legacy and 5-arg paths;
  - approve carries both fields and clears invalid ones;
  - **live outputs identical before/after**, since 0 flags and 0 types: the "no live number moves" proof.
- `verified` untouched.

## Decisions for you / Ashlea
- **D1** `achieved_on` rules: shape-only, or also not-in-future and not-after-exp (recommended)?
- **D2** radar/rollup: A (minimal, flag-only by invariant) or **B (lockstep helper; closes the type gap; recommended)**?
- **D3** `update_cert`: **(a) one defaulted signature, DROP + CREATE (recommended)** or (b) a 5-arg overload alongside the
  3-arg?
- (Noted, not this slice) the `api/digest.js` loose-regex bug, and whether to fix it now as its own one-liner.
