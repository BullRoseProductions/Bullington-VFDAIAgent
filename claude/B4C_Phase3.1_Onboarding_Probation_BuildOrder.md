# B4C Phase 3.1 · Build Order #2 — Onboarding → Cleared-to-Run + Probation Lifecycle

**For:** CC · **Repo:** BullRoseProductions/Bullington-VFDAIAgent · Supabase `ifeptqnlucmvhlvadcpj` · branch `theme/industrial-noir`
**Mock (approved):** `claude/mocks/B4C_Phase3.1_Probation_Mock.html`
**Concept:** `claude/B4C_Phase3.1_MemberReadiness_Concept.md` §A/§B
**Depends on:** the shipped onboarding work (commit `7110570` + `onboarding_selfsign_block.sql`). This **EXTENDS** it — do not rebuild it.

**One-line:** turn the existing onboarding checklist into a full path-to-active — a cleared-to-run gate, probation tasks with a 6-month target, 30/60/90 + final milestone reviews, a supervised-hours log, and an auto-surfaced "ready for the vote" state that drives the Probationary→Active flip.

---

## 0. HARD CONSTRAINTS

1. **EXTENDS shipped onboarding — don't rebuild.** `onboarding_items` (category, label, is_mentor, sort_order; DA-editable), `onboarding_progress` (member_id, department_id, item_id, done, checked_by, checked_at), and `set_onboarding_item(p_member_id, p_item_id, p_done)` (SECURITY DEFINER, `is_canmanage()`, dept-scoped, self-sign blocked, refuses the mentor item) are LIVE. Build alongside them.
2. **Respect the transition state.** `onboarding_progress` still has a direct `insert/update` grant to `authenticated` (the planned REVOKE was deferred until native 2.2.3 is adopted, so DAs on the installed app can still tick). **Do NOT reapply that revoke in this build**, and don't break DA ticking on the installed app.
3. **No PII, ever.** Personal-paperwork items are a **status-only** sign-off (complete → verified → dated). Never a file, number, license, or medical detail. Milestone notes are short free-text officer notes — not a place for personal records.
4. **Never write `verified`.**
5. **Custody rule.** Every sign-off/evaluation is signed by an officer/leader, never self — mirror `set_onboarding_item`'s self-sign block on every new write RPC.
6. **RLS-locked, RPC-only** for the new tables (zero direct write grants). Dept-scoped via the live `is_canmanage()` (Board/DA/Officer) / `is_canmanage_ops()` (DA/Officer) — both confirmed department-scoped + status-aware.
7. **America/Chicago** for all date math (probation start + 30/60/90/180). **Honest denominator** for any "ready" count (exclude Inactive, former `member_separation`, PA/test accounts).
8. **No feature flag. No cron. No background job.** "Auto-flag the board" is a **computed, read-time** state surfaced on a screen — NOT a scheduled job. Live the moment the UI deploys.

---

## 1. Step 0 — CC read-only, report before any change
Confirm with evidence:
- `onboarding_items` / `onboarding_progress` exact columns, grants, RLS, and `set_onboarding_item` signature/gates (verify the transition-state grant is still in place).
- **Is there a probation START date per member?** (`members.created_at`? a `joined_at` / `status_changed_at` / a date the member went Probationary?) The 30/60/90/180 math needs an anchor — report what's available.
- **How is member status set** (Active / Probationary / Inactive)? Is there a `set_member_status` RPC or is it a direct update? The vote→Active flip rides this — report the path.
- **Any existing attendance/hours source** the mock's "training nights attended (11 of 10)" could auto-count from (station hours / training register / attendance). Report what exists so we reuse, not duplicate.
- `member_separation` present (for the honest denominator).
- Any existing cert linkage we can read for "cert prerequisite" items.

---

## 2. Schema additions

**2.1 Extend `onboarding_items`** (keep DA-editable, all additive, nullable/defaulted):
- `clears_to_run boolean not null default false` — marks the item as part of the **cleared-to-run gate** (the "before you run calls" set).
- `phase text` — `'onboarding'` (gate) vs `'probation'` (6-month tasks) for the mock's two groups; default `'onboarding'`. (Or reuse `category` if cleaner — CC's call, report it.)
- `kind text not null default 'manual'` — `manual` (officer signs, today's behavior) · `ack` (satisfied by a #1 document acknowledgment being current) · `hours` (satisfied when logged hours ≥ target) · `cert` (satisfied by a current cert). Plus optional config columns: `ack_series_id uuid`, `hours_target numeric`, `cert_type text`. Auto-kinds are computed at read; `manual` stays the existing sign-off.

**2.2 NEW `probation_milestones`** — officer-signed evaluations
- `id, department_id, member_id, kind text ('30day'|'60day'|'90day'|'final'), due_on date, status text ('pending'|'on_track'|'needs_work'|'done'), note text, signed_by uuid, signed_at timestamptz`. Unique `(member_id, kind)`. `due_on` computed from the probation start (America/Chicago). RLS-locked, RPC-only.

**2.3 NEW `supervised_sessions`** — the shared supervised-hours / ride-along / drive log
- `id, department_id, member_id, kind text ('ride_along'|'drive'|'shift'…), apparatus_id uuid null, hours numeric, occurred_on date, supervisor_id uuid, counts_toward text, note text, created_by uuid, created_at`. RLS-locked, RPC-only.
- **Built here, reused by build #3** (driver drive log) — one hours ledger, not two. (See decision D3.)

Cleared-to-run status and "ready for the vote" are **computed** (not stored): cleared-to-run = all `clears_to_run` items satisfied for the member; ready = all `phase='probation'` items + all milestones `done`.

---

## 3. Write path — RPCs (SECURITY DEFINER, dept-scoped, custody, verified untouched)
- **Reuse `set_onboarding_item`** for manual item sign-off (exists; no change).
- **`set_probation_milestone(p_member_id, p_kind, p_status, p_note)`** — `is_canmanage()`, not-self, dept-scoped, stamps `signed_by`/`signed_at`.
- **`log_supervised_session(p_member_id, p_kind, p_hours, p_occurred_on, p_apparatus_id?, p_supervisor_id?, p_note?)`** — leader logs (custody); dept-scoped, stamps `created_by`. (See D4 on member self-log.)
- **Reads (SECURITY DEFINER, server-side honest counts):**
  - `my_probation_status()` — the caller's day-N-of-180, cleared-to-run gate (items left), probation items, milestones, hours-vs-target; auto-kinds resolved (ack via #1, hours via sessions, cert via certs).
  - `dept_probation_board()` — Board/DA/Officer: each probationary member's progress + a **ready_for_vote** boolean (all clear). Honest denominator.

No new write grants on any table; execute-grant the RPCs to `authenticated`; each self-gates.

---

## 4. RLS
- New tables: member SELECT own (`member_id = my_member_id()`); leaders SELECT dept-wide (`is_canmanage()` + dept). No write policies (RPC-only).
- Verify with `pg_policies` after; watch for duplicate SELECTs.

---

## 5. UI (the mock; web first, rides native)
- **Member "Your path to active"** (read-only; officers sign): day-N-of-180 + progress bar; the **Cleared to run calls** gate banner (N required items left); items grouped **Before you run calls** / **Probation tasks**, each showing the sign-off (officer name/date) or auto status; the **milestone rail** (30/60/90 → final → vote); hours-vs-target. Extend the existing onboarding member view + dashboard card (already Probationary+incomplete).
- **Officer/DA:** sign a milestone, log a supervised session, sign items (existing). DA configures which items are `clears_to_run` + phase + kind (item editing stays DA/PA).
- **Board/DA "ready for the vote" surface:** members who've cleared everything, with a prompt to vote them off probation → flips Probationary→Active via the existing status path (D6). The card disappears on Active (existing behavior).

---

## 6. ACCEPTANCE GATE — real logins, no flag/cron
Pass with REAL logins in separate browsers (Indian Harbor / North Hood), never "View as":
1. A probationary member sees their path, the cleared-to-run gate, and the correct day-N.
2. Officer signs a 30-day milestone / logs a ride-along → member's view + the board surface update; a member cannot sign their own (custody).
3. Auto-kind proof: an item linked to a #1 document goes satisfied when that doc is signed current; an hours item satisfies at target.
4. When all clears → the member shows **ready_for_vote** on the board surface; flipping them to Active hides the onboarding card.
5. **RLS proof:** member reads only their own milestones/sessions; a second member can't; direct writes to the new tables are denied.
6. Honest denominator (Inactive/former/PA excluded). `verified` untouched (grep). Prod web deploy confirmed.

---

## 7. Decisions to confirm (defaults = my recommendation)
- **D1 — Gate enforcement.** DEFAULT: v1 is **status + display only** — the cleared-to-run banner shows the member's state; it does **not** yet block them from the response roster or duty crediting. Actually enforcing it touches the station-presence/LOSAP crediting code (the sensitive area the learnings warn about), so I'd do that as a deliberate follow-up. Flip to "enforce" only if Tommy needs the hard block now.
- **D2 — Milestones.** DEFAULT: fixed `30/60/90/final` template, `due_on` computed from the probation start; officer signs each. Needs a start-date anchor (Step 0). Alternative: DA-configurable milestones — more build, defer.
- **D3 — Shared hours log.** DEFAULT: build `supervised_sessions` here and have build #3 reuse it (one ledger). Alternative: minimal probation-only hours now — but then #3 rebuilds it.
- **D4 — Who logs hours.** DEFAULT: an officer/leader logs (custody). Alternative: member self-logs → officer verifies (more build, closer to a true FTO log).
- **D5 — Auto-flag the board.** DEFAULT: surface-only (a screen shows "ready for the vote"), **no push** (push = the two-gate pulse work; deferred). 
- **D6 — Vote → Active.** DEFAULT: the flip stays the existing member-status change (manual, after the board votes); #2 only surfaces readiness. Confirm the status path from Step 0.

## 8. Out of scope here
- Response-roster / crediting enforcement of the gate (D1 follow-up). · Push nudges (two-gate pulse work). · The qualification matrix + driver check-offs (build #3) — but the **shared hours log is built here** for #3 to reuse. · Any personal-paperwork file/number storage — never.
