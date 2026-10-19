# B4C — Phase 3.1 #5 Readiness Scorecard + ISO packet — DB BUILD ORDER (for CC)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir` · Supabase `ifeptqnlucmvhlvadcpj`.
**This order = the DB slice only.** UI order follows after this passes gate review + is applied (same rhythm as #2/#3/#4). Concept: B4C_Phase3.1_MemberReadiness_Concept. Approved mock: B4C_Phase3.1_Scorecard_Mock (materialized to disk alongside this order). #4 Expirations is LIVE — this reads its data.
**Settled decisions (Ashlea, Oct 19):**
- The readiness "required set" is **department-configurable by type/category** — a DA ticks which qualification types, which credential kinds (license/med card/fit test), and which documents count toward "ready." **Nothing is pre-seeded.**
- The ISO/audit packet is an **in-app printable report** (rendered in-app, browser-print, like Signed-records) — NO .docx/PDF generation pipeline in v1. So the DB only needs a read that assembles the packet data; the printable is the UI order.

## Honest-by-default (the spine of this feature — get it exactly right)
The scorecard's whole value is that "Ready to respond" means something. So:
- **A department with no requirements configured reads "Readiness standard not set" — NOT "Ready" and NOT "Not ready."** An empty standard can't certify anyone. (Mirrors "Gate not configured" / "No qualifications set up yet.")
- Green **"Ready" only when every REQUIRED item is satisfied** right now. A required item that is missing, expired, or `no_date` makes the member **"Not ready,"** and the scorecard names what's outstanding. `no_date`/unknown is never counted as satisfied.
- **One window, shared.** "Current" for certs/credentials uses the SAME expiry rule as #4 (`shared/expiry.js` / the cert-badge window) — reuse the existing `expiration_rows` / `my_expirations` logic, don't re-derive — so a member can't read "Ready" here while a cert reads "Expiring" on the dashboard.
- The verdict is **display-only in v1** — it informs, it does not block any action.
- `verified` is never referenced or written.

## 0. STEP 0 — CC confirms BEFORE writing (read-only, paste the rows)
1. **The inputs the scorecard aggregates, and their existing reads** — so the scorecard reuses them, not re-implements:
   - Quals: `my_qualifications` / `dept_qualification_matrix` + `qualification_types` (per-dept). How "qualified vs in progress" is expressed; the type id.
   - Certs + credentials + gear: `dept_expirations()` / `my_expirations()` / the internal `expiration_rows` (from #4) and `shared/expiry.js`.
   - Acknowledgments: the Read & Sign reads (`my_read_sign_queue` / `dept_read_sign_compliance`) + how a document/series id and "signed & current" are expressed.
   - Activity (informational only, not the verdict): calls / training hours / drives — the existing reads.
   Paste each one's shape + the id columns the requirements table will reference.
2. **Gate + identity helpers** confirmed: `is_dept_admin()` (DA/PA), `is_canmanage()` (Board/DA/Officer), `my_member_id()`, `my_department_id()`; the honest denominator (`members.status` + `member_separation` + Project-Admin exclusion).
3. **Total policy count** now, and confirm the new table name is free.
- If certs have no stable "type" to mark required (the #4 finding: `certs.exp` is free text, certs aren't typed), **STOP and report** — we decide how "required cert" is expressed (e.g. a named cert requirement vs skipping cert-level requirements in v1) before building the config table.

## 1. Schema — one RLS-locked, department-scoped, RPC-only config table
**`readiness_requirements`** — what a department requires for "ready." RLS ON, zero write policies, dept-scoped SELECT for authenticated, `department_id` NOT NULL, audit columns.
- `id` uuid pk, `department_id` fk, `kind` text check in ('credential_license','credential_med_card','credential_fit_test','qualification_type','document'), `ref_id` uuid null (the `qualification_type` id or the document/series id; NULL for the credential-kind rows — the kind itself is the requirement), `required` boolean not null default true, audit columns. Unique (`department_id`, `kind`, `ref_id`). A row present + `required=true` = required; the config RPC can set `required=false` or remove it to drop a requirement.
- (If Step 0 resolves a "required cert" representation, add the matching kind; otherwise v1 omits cert-level requirements and the scorecard treats required certs as out of scope — state which.)

## 2. Writes — one config RPC (SECURITY DEFINER, `is_dept_admin()`, dept-scoped)
- `set_readiness_requirement(p_kind, p_ref_id, p_required)` — upsert; gated `is_dept_admin()` (DA/PA — same as `set_qualification_type`, since this is defining the department's standard, not an ops action); validates the kind, and that a non-null `ref_id` names a `qualification_type` / document in the **caller's** department. `SECURITY DEFINER`, `search_path` pinned, `verified` never touched.
- (No other writes — this slice adds no per-member writes; the scorecard is all reads over data that already has its own write RPCs.)

## 3. Reads (all SECURITY DEFINER, honest verdict)
- `dept_readiness_requirements()` — the configured standard for the caller's department (for the config UI + the scorecard). Dept-scoped.
- `member_scorecard(p_member_id)` — one member's verdict + breakdown. Gated: **own row (`p_member_id = my_member_id()`) OR `is_canmanage()`**. Returns: the overall state ('not_set' | 'ready' | 'not_ready'), and per-required-item rows (kind, label, satisfied bool, status detail — qualified/current/expired/no_date/missing/unsigned), plus the informational activity counts. "not_set" when the department has no requirements. Reuses the qual / expiration / read-sign logic so it stays in lockstep with those screens.
- `dept_readiness_packet()` — the ISO/audit printable's data. Gated `is_canmanage()` (leadership). Department-wide, honest denominator (exclude Inactive / separated / Project-Admin): every active member's verdict + the outstanding items, plus the three rollups the packet shows — qualification matrix summary, expirations summary (expired / no_date / expiring / current counts), and acknowledgment compliance. One call that assembles what the printable needs; the UI renders + browser-prints it, no file generation.

## 4. Migration discipline (same as every prior slice)
Single all-or-nothing DO block, re-run-safe (precondition refuses if the table/reads already exist). Preconditions: helpers exist + dept-scoped; the inputs from Step 0 exist. Post-conditions: `readiness_requirements` exists with RLS ON, zero write policies, exactly one dept-scoped SELECT policy; the config RPC + all reads `SECURITY DEFINER`, `is_dept_admin()` on the write and `is_canmanage()`/own-row on the leadership/member reads, no `is_leader()`; every pre-existing policy byte-identical (snapshot before/after); `verified` untouched; `total_policies` +1. State check at the end.

## 5. Prove it — PGlite dry run (mutations) + a live RETEST
- **Dry run (PGlite):** seed two departments, a DA, a member with a mix (one required qual qualified, one required credential expired, one required document unsigned), and a department with NO requirements. Assert: the no-requirements dept → `not_set` (never ready/not-ready); the member with an expired required credential → `not_ready` with that item named; a member meeting every requirement → `ready`; `member_scorecard` own-or-leadership gating; `dept_readiness_packet()` leadership-only, honest denominator (Inactive/separated/PA excluded); the shared expiry window matches #4 (a credential that is "expiring soon" on the dashboard is not counted "current/ready" here).
- **Mutations, each caught:** a plain member calling `set_readiness_requirement` → refused; a member reading another member's scorecard → refused; a member calling `dept_readiness_packet()` → refused; a requirement `ref_id` from another department → refused; an unconfigured dept scored as "ready" → the honest-empty assertion fails; counting a `no_date`/expired item as satisfied → assertion fails.
- **RETEST (live, separate, SENTINEL-rolled-back):** per department — the config write gated to DA/PA, the member/leadership read gates, the honest verdict on real data, `verified` untouched.

## 6. Deliverables for gate review (BEFORE apply)
`docs/review/scorecard_db_DIFF.patch` (or DRAFT sql) + the RETEST + the PGlite dry-run output, for line-by-line gate review. **Do not apply or deploy.** After PASS: Ashlea applies + runs the RETEST; then the #5 UI order (the scorecard screen, the requirements config, the in-app printable ISO packet).
