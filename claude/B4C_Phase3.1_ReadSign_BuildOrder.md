# B4C Phase 3.1 · Build Order #1 — Read & Sign (document acknowledgment)

**For:** CC (coding agent) · **Repo:** BullRoseProductions/Bullington-VFDAIAgent · Supabase `ifeptqnlucmvhlvadcpj`
**Branch:** build on `theme/industrial-noir` (normal feature flow), promote per usual with "Notify crew" held back — **NOT** `release-3.0` and **NOT** straight to `main`.
**Mock (approved):** `claude/mocks/B4C_Phase3.1_ReadSign_Mock.html` (this folder)
**Concept:** `claude/B4C_Phase3.1_MemberReadiness_Concept.md` (claude.ai project)
**Why first:** cleanest piece, zero PII, the plumbing already exists (mirrors the shipped onboarding sign-off). This is the compliance piece Tommy @ Indian Harbor asked for.

**STATUS: DB layer APPLIED + TESTED LIVE.** Migration `sql/read_sign_2026-10-17.sql` (commit `36eed83`); RETEST **51 passed / 0 failed / 2 skipped** (Demo/Granbury skip — no DA + 2 unique-email members). Review pass on file. **The remaining work is the UI (§5)** on `theme/industrial-noir`, then the §6 real-login acceptance gate. The RPCs below are LIVE — wire the UI to them exactly as in §3-AS-APPLIED.

---

## 0. HARD CONSTRAINTS (still apply to the UI)

1. **No PII, ever.** B4C stores the *acknowledgment trail only*: member · series · version · file fingerprint · timestamp. No personal documents, nothing a member signs about themselves.
2. **Never write `verified`.**
3. **RLS-locked, RPC-only writes.** (Done at the DB layer — the UI only calls the five RPCs; it never writes the tables directly.)
4. **No feature flag. No cron. No background job.** The feature is live the moment the UI deploys — there is nothing to switch on. Do **not** add a `VITE_*_ENABLED` gate. The per-document "requires acknowledgment" switch is a normal admin data action.
5. **Department scope / gating** is enforced in the RPCs already (live `is_canmanage_ops()` / `is_canmanage()`, both department-scoped + status-aware). The UI just shows/hides controls by role to match.
6. **America/Chicago** for any date display logic, to match the server.
7. **Workflow:** build on `theme/industrial-noir` → verify → push → Vercel. Screenshot-verify. The §6 gate uses REAL logins in separate browsers, never "View as."

---

## 1. Step 0 findings (CONFIRMED live)

- Table is **`public.documents`**: `id, department_id, name, type, storage_path, uploaded_by (text), created_at, deleted_at/deleted_by, supersedes, archived_at, content_text, plan_id`. `name` is the file name; no `created_by` uuid.
- Members already read every dept document (`authenticated can read documents`, `department_id = my_department_id()`).
- `is_canmanage_ops()` (DA+Officer) and `is_canmanage()` (Board+DA+Officer) are both **department-scoped + status-aware** (Active/Probationary only) — used directly.
- `content_text` is empty for scanned files (4 of North Hood's 5 docs) → the member reads the **actual file**, and the fingerprint comes from the file, not the text.
- Onboarding "SOG" item label differs by dept — "…acknowledgment signed" (North Hood, Lipan) vs **"SOG Policy Review"** (Indian Harbor); match both when the later onboarding link-up happens.

---

## 2. Schema (AS BUILT)

`documents` gained `series_id uuid NOT NULL` (backfilled to each supersedes-chain root; a trigger keeps it on insert/replace). Three new tables, all RLS-on, SELECT-only to `authenticated`, zero write policies:
- **`document_series`** — `series_id pk, department_id, requires_ack, required_roles text[], annual_resign, current_version, title, updated_at`. The config lives here (NOT on `documents`), because doc rows get replaced.
- **`document_versions`** — immutable published versions; `(series_id, version)` unique; `content_hash`, `document_id`, `title`, `storage_path`, `effective_on`, `published_by`.
- **`document_acknowledgments`** — append-only trail; `(member_id, series_id, version)` unique; an UPDATE/DELETE trigger refuses every change, even for the DB owner.

---

## 3-AS-APPLIED. Live RPC signatures — the UI calls THESE exactly

All are SECURITY DEFINER, `authenticated`-only, dept-scoped internally. **Note they take `p_document_id` (the `documents` row id), not a series id** — the function derives the series.

- **`set_document_ack_config(p_document_id uuid, p_requires boolean, p_required_roles text[], p_annual boolean) → jsonb`**
  DA/Officer of the doc's dept. Turning `requires_ack` on for the first time auto-publishes v1. `required_roles` empty/NULL = every (non-inactive, non-PA, non-former) member; else a subset of `('Member','Officer','Board Member','Department Admin')` matched against `members.access`. Returns `{series_id, requires_ack, current_version}`.
- **`publish_document_version(p_document_id uuid) → jsonb`**
  DA/Officer. The deliberate "everyone re-signs" action (requires_ack must already be on). Returns `{series_id, current_version}`.
- **`acknowledge_document(p_document_id uuid, p_version integer, p_content_hash text) → jsonb`**
  The member signs the CURRENT version; refuses a stale version or a mismatched fingerprint; idempotent; wording built server-side. Returns `{series_id, version, status:'current', signed_at}`. Pass the `version` and `content_hash` the queue handed you.
- **`my_read_sign_queue() → setof`** `(series_id, document_id, title, version, content_hash, storage_path, effective_on, annual_resign, required_roles, status, signed_version, signed_at, resign_due)`
  The caller's required docs. `status` ∈ `needs | resign | current`. **This is the member screen's data source** — group by `status`.
- **`dept_read_sign_compliance() → setof`** `(series_id, title, version, required_roles, annual_resign, audience, current_count, outstanding jsonb)`
  Board/DA/Officer only. `audience = 0` means "not applicable" — the UI must never render that as 100%. `outstanding` is a jsonb array of `{member_id, name}`.

---

## 5. UI to build (web first; rides next native build)

**5.1 Member — "Read & Sign" screen** (the mock, phone-width Industrial Noir)
- Data source: `my_read_sign_queue()`. Group by `status`: **Needs your signature** (`needs`) · **New version — re-sign needed** (`resign`) · **Signed & current** (`current`).
- "Read the full policy" → **opens the actual file** in the existing document viewer (PDF via `storage_path`), falling back to `content_text` when there's no file — scanned SOPs must still be readable + signable.
- Attestation checkbox → **Sign now** → `acknowledge_document(document_id, version, content_hash)` using the row's own `version`/`content_hash`. On success the row moves to Signed & current.
- Signed rows: "Signed v{version} · {signed_at}" (America/Chicago). Re-sign rows: "your v{signed_version} signature no longer current." Show `effective_on`, annual tag, and `resign_due` where present.

**5.2 Member dashboard card + nav badge**
- Mirror the onboarding card: "Read & Sign — X outstanding" (count of `needs` + `resign` from the queue) + nav badge; hide when all `current`.

**5.3 DA / Officer**
- Per document (on the Station Documents screen): "Requires acknowledgment" toggle + required-audience picker by `members.access` (empty = all) + annual toggle → `set_document_ack_config(...)`. **"Publish new version (requires re-sign)"** → `publish_document_version(...)`, behind a confirm that says everyone will be prompted to re-sign.
- **Dept compliance view**: `dept_read_sign_compliance()` — per doc "X of Y signed current" (`current_count` / `audience`), expandable to the `outstanding` names. **Honest denominator:** `audience = 0` renders as "not applicable," never 100%.
- **Audience note:** v1 targets by `members.access` (all / officers / etc.). The mock's "Required · drivers" is qualification-based — that's build #3, deferred. Show access-based audiences only for now.

Role visibility: show 5.1/5.2 to members; 5.3 config/publish/compliance to DA + Officer (Board may read compliance). The RPCs enforce this regardless — the UI just mirrors it.

---

## 6. ACCEPTANCE GATE — "working from the get go"

The DB is live but **unused** — no document needs a signature until a DA switches one on, and they can't until the screens exist. **Deploying the UI is shipping the feature — no flag, no job.**

Pass every box with REAL logins in SEPARATE browsers (a DA and a member in a doc-having dept — North Hood / Lipan / Indian Harbor), never "View as":

1. DA flags a real SOP `requires_ack` for all members → v1 auto-published (a `document_versions` row with a fingerprint).
2. Member (separate browser) sees it under **Needs your signature**; opens the real file, attests, **Signs**.
3. SQL: exactly one `document_acknowledgments` row (member, series, version, hash, `signed_at`). Member flips to **Signed & current**; badge clears.
4. DA **Publish new version** → member flips to **Re-sign needed**; v1 row still there (append-only); re-sign adds a v2 row.
5. **Replace vs publish:** replacing the file (not Publish) does NOT force re-sign and does NOT orphan signatures (series carried).
6. Compliance view shows the honest denominator (unsigned = not-compliant; audience 0 = n/a).
7. **RLS proof:** member reads only own acks; another member can't see theirs; a non-admin / out-of-dept admin can't config/publish.
8. **`verified` untouched** — grep the diff.
9. Prod web deploy confirmed.

Only when 1–9 pass on prod with real logins is Read & Sign **live**. Until then it's "built," not "on."

---

## 7. Settled calls
- Publish-only re-sign (replace/typo-fix never forces it). · Default wording "I have read and understand {name} (v{n}) and agree to comply." · Annual re-sign in for v1 (computed at read, America/Chicago). · **Push nudge deferred** — adding a pulse type means updating BOTH pulse gates (write path AND drain filter) and re-proving written→drained→pushed; in-app badge + queue only for v1.

## 8. Out of scope
- Qualification-based required reading (drivers must sign the driving policy) — build #3. · Letting a real acknowledgment satisfy the onboarding "SOG" item — cross-link after #1+#2 (mind the dept label difference). · Any personal-paperwork / credential storage — never.
