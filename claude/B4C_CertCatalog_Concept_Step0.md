# B4C — Cert Catalog (option 4) — Concept + Step 0 — for CC

**What Ashlea asked for (scope locked Oct 20):** the **minimal** catalog — per-department **cert types**, each with a **"doesn't expire"** flag, and any type can be made a **readiness requirement** in #5. This fixes non-expiring certs reading as "No date" gaps AND lets a cert gate "Ready." **Existing cert names stay as-is** — no bulk mapping/merge of Indian Harbor's ~100 name variants in v1 (that's the deferred "full" scope).

**Why it exists:** today `certs` is free-text `name` + nullable `exp` ('YYYY-MM' string), no catalog, no FK. A cert with blank `exp` buckets as `no_date` in #4 Expirations — correct for a cert that *should* have a date, wrong for one that genuinely never expires (IS/ICS/NIMS, L-180, Courage to be Safe). And #5 Readiness deliberately shipped with **no cert requirement kind** (Option 3, Oct 19) precisely because a required non-expiring cert would read permanently "Not ready" under the honest `no_date`-never-satisfied rule. The catalog is the data-model fix that makes both honest. Prior context: [[B4C_Compliance_Scoring_Brief]] (Phase 2 "required-cert catalog" note), [[B4C_Phase3.1_Scorecard_DB_ReviewRecord]] (the Option-3 ruling), [[B4C_Phase3.1_Expirations_DB_ReviewRecord]] (cert normalization).

---

## STEP 0 — investigate live BEFORE any migration (paste the real definitions; I design off these, not off memory)

Run read-only on live and paste back:
1. **`certs` table** — full column list + types + constraints, RLS enabled?, every policy on it, and the client grants. (Confirm the columns are what the docs say: `name` text, `exp` text nullable, `member_id`, `department_id` — plus anything else actually there.)
2. **The cert write/read path** — `pg_get_functiondef` for every RPC that writes or reads certs: `update_cert`, `delete_cert`, and whatever **inserts** a cert from the member file (find it — grep the app for the add-cert call), plus any cert read RPC. I need to see exactly how a cert row is created/edited today so the type link is additive.
3. **`expiration_rows(uuid,uuid)`** — the full body (this is the internal fn `dept_expirations()`/`my_expirations()` call that normalizes `certs.exp` → month-end / `no_date`). This is the one I'd modify for the "doesn't expire" behavior, so I need its exact current logic.
4. **Readiness machinery** — full bodies of `readiness_requirements` table def + its `kind` CHECK/constraint, `set_readiness_requirement`, and `member_scorecard()`. This is where a new `cert_type` requirement kind plugs in.
5. **Confirm no catalog exists** — no `cert_types` / `required_certs` / `cert_catalog` / requirements-for-certs table already present (the Compliance brief warned discovery was file-based; check `information_schema` for real).
6. **The app's cert read** — the client `certStatus()` logic + where certs render on the member file / Certifications tab (so the UI slice matches the server buckets and one cert never reads two ways).
7. **Sample (no PII needed):** per department, count of distinct `certs.name` values and how many rows have blank/malformed `exp` — just to confirm the "leave existing as-is" call is sane and see the non-expiring volume.

Confirm `is_dept_admin()` is still the dept-scoped body (md5 `c692e44f62923d2bf4c1a39a21a87bf7`) — the catalog writes gate on it.

---

## Proposed design (sketch — I finalize the migration after Step 0)

Additive only; nothing existing changes behavior unless a cert is explicitly linked to a type.

**New table `cert_types`** (per-department catalog): `id`, `department_id`, `name`, `never_expires boolean not null default false`, `created_at`. RLS ON, RPC-only writes, `unique (department_id, lower(name))`. Readable by the department's members (visibility); writable DA/PA only.

**Link, nullable:** add `cert_type_id uuid references cert_types(id)` to `certs`, **nullable**. A cert with `cert_type_id = null` behaves exactly as today (free-text, month-end/`no_date` logic unchanged) — that's how "existing stay as-is" holds. Assigning a cert to a type is done on the member's cert edit (the existing write RPC gains an optional `p_cert_type_id`).

**RPCs:** `set_cert_type(p_id?, p_name, p_never_expires)` (DA/PA, upsert, dept-scoped, unique name), `delete_cert_type(p_id)` (DA/PA — on delete, set referencing certs' `cert_type_id` to null, don't delete the certs), `dept_cert_types()` (read the catalog). Extend the cert write RPC to accept `p_cert_type_id`.

**"Doesn't expire" behavior (the #4 fix):** in `expiration_rows`, a cert whose `cert_type.never_expires = true` → NOT `no_date` even with blank `exp`; it reads as a distinct satisfied status (e.g. `no_expiry` / "No expiration") surfaced as current, never as a gap. A cert linked to an expiring type, or unlinked, keeps today's logic.

**Readiness gating (the #5 fix):** add `cert_type` to the `readiness_requirements.kind` set + `set_readiness_requirement`; in `member_scorecard()` a `cert_type` requirement is **satisfied** when the member holds a cert of that type that is either (a) a `never_expires` type (holding it satisfies), or (b) an expiring type that is current (not expired / not `no_date`). Honest default preserved: `no_date`/expired never satisfies.

**Guardrails (same as every slice):** `verified` never touched; single all-or-nothing DO block, re-run-safe; preconditions (helpers exist + dept-scoped, no catalog table yet, `is_dept_admin` md5 pinned); post-conditions (new table RLS ON + exactly the intended policies; `certs` gains only the nullable FK; every other policy byte-identical snapshot; `readiness_requirements.kind` gains only `cert_type`; `total_policies` delta as expected). PGlite dry run with mutations + a live SENTINEL-rolled-back RETEST. **Do not break** unlinked-cert behavior in #4 or any existing requirement kind in #5 — both get explicit regression cases.

**Deliver Step 0 first.** I review the live definitions, finalize the migration as a DB build order, you build the draft, I gate-review PASS before apply. Then the UI slice (manage the catalog, pick a type on a cert, add a cert type as a readiness requirement).
