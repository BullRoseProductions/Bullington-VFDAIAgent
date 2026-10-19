# B4C — Phase 3.1 #5 Readiness Scorecard + ISO packet — DB BUILD ORDER (for CC)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir` · Supabase `ifeptqnlucmvhlvadcpj`.
**This order = the DB slice only.** UI order follows after this passes gate review + is applied. Concept: B4C_Phase3.1_MemberReadiness_Concept. Approved mock: B4C_Phase3.1_Scorecard_Mock. #4 Expirations is LIVE — this reads its data.
**Settled decisions (Ashlea, Oct 19):**
- Required set is **department-configurable by type/category**; nothing pre-seeded.
- ISO/audit packet is an **in-app printable report** (browser-print, like Signed-records) — no .docx/PDF pipeline in v1.
- **Cert requirement — RULED OPTION 3 (Claude, Oct 19, from the Step 0 evidence):** there is **no `cert` requirement kind** in v1. Requirements are qualification types, credential kinds, and documents only. Certs still **show** on the scorecard (and the Expirations screen) so they're visible, but they **do not affect the verdict.** A department that needs a cert to gate readiness expresses it as a **qualification type** (exact, officer-signed-once) until the option-4 cert catalog exists.
  - *Why:* Step 0 §3 — only Indian Harbor (and Demo) hold certs; IH has ~100 distinct names for 37 members, with **semantic** variants a spelling list can't collapse (IS-100 / ICS 100 / NIMS ICS 100 / FEMA IS 100 = one credential; Firefighter I has 6+ names; etc.), AND **many certs never expire** (IS/ICS/NIMS, L-180, Courage to be Safe). Under the honest rule `no_date` is never "satisfied," so a required non-expiring cert would keep even holders permanently "Not ready." That's a data-model gap, not a spelling one — it belongs to option 4.

## Honest-by-default (the spine — get it exactly right)
- A department with **no requirements configured reads "Readiness standard not set"** — NOT "Ready" and NOT "Not ready."
- Green **"Ready" only when every REQUIRED item is satisfied** now; a missing / expired / `no_date` required item → **"Not ready,"** naming what's outstanding. `no_date`/unknown is never satisfied.
- **One window, shared:** "current" for credentials uses the same `shared/expiry.js` / cert-badge window as #4 — reuse `expiration_rows` / `my_expirations`, don't re-derive.
- Verdict is **display-only in v1**.
- `verified` is never referenced or written.

## 0. STEP 0 — DONE (CC ran it Oct 19). Findings:
- **Reuse reads all exist and are SECURITY DEFINER:** quals (`my_qualifications` / `dept_qualification_matrix` / `qualification_types`), #4 expirations (`dept_expirations` / `my_expirations`; `expiration_rows` internal, members can't call it), Read & Sign (queue + compliance reads; `rs_member_in_audience` internal). Reuse them; don't re-implement.
- **Requirement targets:** `qualification_types.id` for a qualification; `document_series.series_id` for a document (a document's id maps to its series via `documents.series_id`). Credential kinds need no ref.
- **Helpers:** `is_dept_admin()` (DA/PA) and `is_canmanage()` are department-scoped; `my_member_id()` / `my_department_id()` honour the multi-station active department and only Active/Probationary members.
- **Honest denominator:** `members.status` Active/Probationary; exclude the 1 separated member and 2 Project Admins.
- **Activity (informational only):** station hours, `session_attendance` + `training_sessions` (training nights), `supervised_sessions` (drives). **No calls/incident table exists — "calls run" can't be counted in v1**; the activity row is hours, trainings, drives (the mock's "Calls run" tile is dropped or relabelled in the UI order).
- **Housekeeping:** all 5 new names free; `total_policies` 168 → **169** after the new table.

## 1. Schema — one RLS-locked, department-scoped, RPC-only config table
**`readiness_requirements`** — RLS ON, zero write policies, dept-scoped SELECT for authenticated, `department_id` NOT NULL, audit columns.
- `id` uuid pk, `department_id` fk, `kind` text check in **('credential_license','credential_med_card','credential_fit_test','qualification_type','document')** — **no `cert`**, `ref_id` uuid null (`qualification_types.id` or `document_series.series_id`; NULL for the credential-kind rows), `required` boolean not null default true, audit columns. Unique (`department_id`, `kind`, `ref_id`). Row present + `required=true` = required.

## 2. Writes — one config RPC (SECURITY DEFINER, `is_dept_admin()`, dept-scoped)
- `set_readiness_requirement(p_kind, p_ref_id, p_required)` — upsert; `is_dept_admin()` (DA/PA, like `set_qualification_type`); validates the kind and that a non-null `ref_id` names a `qualification_type` / `document_series` in the **caller's** department. `SECURITY DEFINER`, `search_path` pinned, `verified` never touched.

## 3. Reads (all SECURITY DEFINER, honest verdict)
- `dept_readiness_requirements()` — the configured standard (dept-scoped).
- `member_scorecard(p_member_id)` — own row OR `is_canmanage()`. Returns overall state ('not_set' | 'ready' | 'not_ready') + per-required-item rows (kind, label, satisfied, status: qualified/current/expired/no_date/missing/unsigned) + the informational activity counts (hours, trainings, drives — no calls). **Certs are listed for visibility but are NOT required items and never change the verdict.** 'not_set' when the dept has no requirements. Reuses the qual / expiration / read-sign logic for lockstep.
- `dept_readiness_packet()` — `is_canmanage()`, department-wide, honest denominator (exclude Inactive / separated / Project-Admin): every active member's verdict + outstanding items + the three rollups (qualification matrix summary, expirations summary, acknowledgment compliance). One call for the in-app printable; the UI renders + browser-prints, no file generation.

## 4. Migration discipline
Single all-or-nothing DO block, re-run-safe. Post-conditions: `readiness_requirements` RLS ON, zero write policies, one dept-scoped SELECT policy; config RPC + reads `SECURITY DEFINER`, `is_dept_admin()` on the write, `is_canmanage()`/own-row on the reads, no `is_leader()`; the `kind` check set contains no `cert`; every pre-existing policy byte-identical (snapshot before/after); `verified` untouched; `total_policies` 168 → 169. State check at the end.

## 5. Prove it — PGlite dry run (mutations) + live RETEST
- **Dry run:** two depts, a DA, a member with a mix (required qual qualified, required credential expired, required document unsigned), and a dept with NO requirements. Assert: no-requirements dept → `not_set`; the expired-required-credential member → `not_ready` naming it; a fully-satisfied member → `ready`; **a cert (dated or not) never changes the verdict** (it's not a requirement kind); own-or-leadership gating on `member_scorecard`; `dept_readiness_packet()` leadership-only + honest denominator; shared expiry window matches #4.
- **Mutations, each caught:** a member calling `set_readiness_requirement` → refused; a member reading another's scorecard → refused; a member calling `dept_readiness_packet()` → refused; a `ref_id` from another department → refused; a `kind='cert'` (or any kind off the set) → refused by the check; an unconfigured dept scored "ready" → honest-empty assertion fails; a `no_date`/expired required item counted satisfied → assertion fails.
- **RETEST (live, separate, SENTINEL-rolled-back):** per dept — the config write gated to DA/PA, the member/leadership read gates, the honest verdict on real data, `verified` untouched.

## 6. Deliverables for gate review (BEFORE apply)
`docs/review/scorecard_db_DIFF.patch` (or DRAFT sql) + RETEST + PGlite dry-run output, for line-by-line review. Do not apply or deploy. After PASS: Ashlea applies + runs the RETEST; then the #5 UI order (scorecard screen, requirements config, in-app printable ISO packet; drop/relabel the mock's "Calls run" tile since there's no calls source).

## Deferred — the cert catalog (option 4, its own project, NOT #5)
A per-department cert catalog (cert types, existing certs mapped onto them) with a **"doesn't expire" status** so non-expiring certs (IS/ICS/NIMS, L-180, Courage to be Safe) read correctly instead of as a `no_date` gap. This is what would let a cert gate readiness honestly, and it also improves the #4 Expirations screen's treatment of certs that genuinely never expire. Scope it as its own build order when Ashlea wants it.
