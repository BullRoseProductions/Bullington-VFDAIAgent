# B4C — Phase 3.1 #4 Expirations — DB BUILD ORDER (for CC)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir` · Supabase `ifeptqnlucmvhlvadcpj`
**This order = the DB slice only.** UI build order follows after this passes gate review + is applied (same rhythm as #2/#3). Concept: B4C_Phase3.1_MemberReadiness_Concept. Approved mock: B4C_Phase3.1_Expirations_Mock.
**Decisions (Ashlea, Oct 19):** v1 carries all three domains — member credentials + turnout gear lifecycle + apparatus annual testing. Writes are **DA/Officer only** (`is_canmanage_ops()`), same ops-gate as apparatus and quals. The readiness "required set" is department-configurable — but that config + the scorecard verdict are **#5's job**, not this slice. #4 ranks *every* expiration by date regardless of "required."

## The guardrail (non-negotiable — carries the whole module's legal posture)
**Dates, class, and pass/fail status ONLY. B4C never stores the credential number, the scan, or any medical detail.** Concretely, for this slice:
- `member_credentials` gets a short **`label`** (which credential) and an optional short **`cls`** (class text like "Class C" / "DOT" — NEVER a number). It gets **NO** `number`, `document`, `scan`, `file`, `image`, or free-text `notes` column. Do not add one "to be safe" — the absence is the safety.
- Gear and apparatus-test rows carry a short label/type and a pass/fail-style `result`, dates only.
- If any of this makes you want a notes field, STOP and raise it — we decide deliberately, we don't default it in.
`verified` is never referenced or written anywhere in this migration.

## 0. STEP 0 — DONE (CC ran it Oct 19). Findings + decisions below.
1. **Certs model — RESOLVED.** Two tables: `certs` (approved credentials) + `cert_submissions` (the pending/approved/rejected approval workflow; approving copies into `certs` via `approve_cert_submission`). **Decision: the dashboard UNIONs `certs` ONLY** — a pending submission isn't a credential yet, so it stays in the approval queue, out of expirations. `certs.exp` is **text 'YYYY-MM'** (month precision; can be blank or malformed); the app's `certStatus()` already treats a non-YYYY-MM value as "NO DATE." See §3 for the normalization.
2. **Gate + identity helpers** confirmed: `is_canmanage_ops()`, `my_member_id()`, `my_department_id()`, `is_dept_admin()` (bodies captured in the Step 0 output).
3. **Honest denominator** confirmed: `members.status` + `member_separation` — exclude Inactive and separated members, same as the probation/qual reads.
4. **Apparatus** confirmed: PK, `department_id`, `deleted_at`, `in_service` — `apparatus_tests` FKs to it; the dashboard hides tests for retired/deleted rigs.
5. **The five new names are free**, and total policy count captured for the before/after state check.

## 1. Schema — three RLS-locked, department-scoped, RPC-only tables
All three: RLS ON, **zero write policies** (writes go only through the SECURITY DEFINER RPCs below), a dept-scoped SELECT policy for authenticated users, `department_id` NOT NULL, created/updated audit columns.

**`member_credentials`** — member-scoped, date-only credentials that aren't certs.
- `id` uuid pk, `department_id` fk, `member_id` fk, `kind` text check in ('license','med_card','fit_test','other'), `label` text (short, required), `cls` text (short, nullable — class only, NEVER a number), `issued_on` date null, `expires_on` date null, `created_by`/`created_at`/`updated_by`/`updated_at`. **No number/scan/notes column.**

**`gear_items`** — turnout gear / PPE lifecycle (NFPA 1851: 10-yr life + annual inspection).
- `id` uuid pk, `department_id` fk, `member_id` fk **nullable** (pool/unassigned gear allowed), `label` text (e.g. "Turnout coat"), `in_service_on` date (manufacture/in-service → 10-yr life), `last_inspected_on` date null, `next_inspection_on` date null, `retired_at` timestamptz null (soft-retire), audit columns. The dashboard's "expiry" for a gear row = the nearer of `next_inspection_on` and (`in_service_on` + 10 years); compute in the read, don't store a derived column.

**`apparatus_tests`** — annual pump / ladder / hose testing beyond the daily truck check.
- `id` uuid pk, `department_id` fk, `apparatus_id` fk → apparatus, `test_type` text check in ('pump','ladder','hose','other'), `tested_on` date, `next_due_on` date null, `result` text (short, pass/fail-style status only), audit columns.

## 2. Writes — SECURITY DEFINER RPCs, every one gated `is_canmanage_ops()` + dept-scoped
No self-exemption needed (these are admin records, not self-sign-offs), but every RPC must check the target row is in the **caller's** department (`department_id = my_department_id()`), and for member-scoped rows that the member is in that department; for apparatus-tests that the apparatus is in that department and not deleted. DA/Officer only — a plain member calling any of these is refused.
- `set_member_credential(p_id?, p_member_id, p_kind, p_label, p_cls, p_issued_on, p_expires_on)` — insert or update (p_id null = insert). Refuses a `kind` outside the check set. Never accepts a number/scan arg.
- `delete_member_credential(p_id)` — hard delete is fine (no trail requirement here) OR soft; match the app's convention for similar admin records — CC picks and states which, consistently.
- `set_gear_item(p_id?, p_member_id?, p_label, p_in_service_on, p_last_inspected_on, p_next_inspection_on)`, `retire_gear_item(p_id)` (sets `retired_at`), `log_gear_inspection(p_id, p_inspected_on)` (sets last_inspected_on + rolls next_inspection_on +1yr).
- `set_apparatus_test(p_id?, p_apparatus_id, p_test_type, p_tested_on, p_next_due_on, p_result)`, `delete_apparatus_test(p_id)`.
All: `SECURITY DEFINER`, `search_path` pinned, dept-scope checked inside, `verified` never touched.

## 3. Reads
- `dept_expirations()` — the dashboard. UNION across: `certs` (see normalization below), `member_credentials`, `gear_items` (expiry = nearer of next inspection / 10-yr retire), `apparatus_tests` (`next_due_on`). Each row: `scope` ('member'|'gear'|'apparatus'), `subject` (member name or rig name), `kind`/`type` label, `cls` where relevant, `expires_on`, `days_until`, `bucket` ('expired' | 'soon' ≤30d | 'current' | **'no_date'**). **Honest denominator:** exclude Inactive + separated members and retired/deleted gear & apparatus. Ranked expired → no_date → soon → current, then by soonest date. Dept-scoped.
- **Certs normalization (decided Oct 19):** UNION `certs` only, never `cert_submissions`. `certs.exp` text 'YYYY-MM' → treat as the **last day of that month** for `expires_on`/`days_until` (a cert marked "2026-10" is good through Oct 31, not expired mid-month). A blank or malformed `exp` → **`bucket='no_date'`** — a distinct status surfaced **with the attention items** (NOT counted 'current', NOT 'expired'); mirrors the app's `certStatus()` "NO DATE" so members see consistent language. An undated required cert is a data gap the DA should fix, so it stays visible. The three new tables use real `date` columns, so only legacy certs need this text-month handling.
- `my_expirations()` — the caller's own upcoming credential/cert/gear expirations, for their profile + the #5 scorecard. Same date logic, member-scoped to `my_member_id()`.

## 4. Reminders — NOT in this DB slice (confirmed push path, for the UI order)
The mock's "Send reminders to flagged members" is a **UI + push** concern, not a table. **Confirmed path (CC, Oct 19):** `api/_push.js` — `insertNotifications()` + `sendPush(sb, notifications, tokensByMember)` via FCM, behind `PUSH_ENABLED === "1"`, device tokens from `member_devices`; `api/pulse.js`'s drain already uses it. The reminders button in the UI order **reuses the `_push.js` helpers** scoped to flagged members, DA/Officer-triggered — **NOT** `api/notify-session.js` (that's the held-back Notify Crew). Honest caveat into the UI copy: push reaches only members on 2.2+ who allowed notifications — don't imply everyone gets pinged.

## 5. Migration discipline (same as every prior slice)
Single all-or-nothing DO block (or one idempotent script), re-run-safe (drop-if-exists guards / `create ... if not exists` + precondition that refuses if already applied). Preconditions: the helpers exist and are dept-scoped; the three tables don't already exist (or match exactly). Post-conditions: the three tables exist with RLS ON and **zero write policies**; exactly the intended SELECT policies; all RPCs `SECURITY DEFINER`; **no column named** number/scan/document/file/image/notes on `member_credentials` (assert it); every other table's policies byte-identical (snapshot before/after); `verified` untouched. State check at the end: new table count, policy delta, `total_policies` before/after.

## 6. Prove it — PGlite dry run (with mutation testing) + a live RETEST
- **Dry run (PGlite):** seed two departments, a DA, an Officer, two plain members, an apparatus, and a couple of `certs` rows (one good 'YYYY-MM', one blank `exp`). Exercise: a DA sets a license (class only), a med card, a fit test; sets gear with a 10-yr-old in-service date (→ expiring/expired on the 10-yr rule); logs a gear inspection (rolls next inspection); sets an apparatus pump test with a past `next_due_on` (→ expired bucket). Assert `dept_expirations()` buckets + ranking are right, **the blank-`exp` cert lands in `no_date` (not current, not expired) and the 'YYYY-MM' cert ranks at month-end**, `my_expirations()` is member-scoped, and the honest denominator holds (an Inactive/separated member's rows don't inflate "current").
- **Mutations, each must be caught:** (a) a plain member calling any write RPC → refused; (b) a DA writing a credential for **another department's** member → refused; (c) an apparatus test for a deleted rig → refused or hidden from the dashboard; (d) a `kind`/`test_type` outside the check set → refused; (e) a `cert_submissions` row leaking into `dept_expirations()` → must NOT appear (UNION is `certs` only); (f) attempting a number/scan/notes column on `member_credentials` → the §5 post-condition assertion fails the migration.
- **RETEST (run on live, separately, SENTINEL-rolled-back):** per department with a DA + Officer + two members + a rig — the member-blocked writes, the DA/Officer-allowed writes, cross-dept refusal, the dashboard buckets incl. a `no_date` cert, and `verified` untouched.

## 7. Deliverables for gate review (BEFORE apply)
`docs/review/expirations_db_DIFF.patch` (or the DRAFT sql) + the RETEST script + the PGlite dry-run output, for line-by-line gate review. **Do not apply or deploy.** After review PASS: Ashlea applies + runs the RETEST; then the UI build order. It's web/DB — RLS is enforced for every client the moment it's applied.

---

## What #5 will add (so the shape is visible — NOT this order)
#5 = the readiness scorecard + the ISO/audit packet, built on #4's data:
- **`readiness_requirements`** (department-configurable) — a DA marks which quals / certs / credentials / acknowledgments are *required* for "ready to respond." Small config table + DA-only RPC + guard, same pattern as the probation toggle.
- **`member_scorecard(p_member_id)`** read — aggregates quals (live), certs + credentials + gear (from #4), acknowledgments (Read & Sign, live), activity (calls/train hrs/drives, existing) into the one "is this person current" verdict; green only when every *required* item is current. Honest states throughout (nothing "current" by default).
- **ISO / audit packet export** in the Reports hub — the department-wide night-before-the-visit report. Likely a `.docx`/PDF built off `dept_expirations()` + the matrix + acknowledgment compliance. Format TBD — we'll decide when we spec #5.
