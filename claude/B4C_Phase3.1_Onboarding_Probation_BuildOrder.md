# B4C Phase 3.1 · Build Order #2 — Onboarding → Cleared-to-Run + Probation Lifecycle

**For:** CC · **Repo:** BullRoseProductions/Bullington-VFDAIAgent · Supabase `ifeptqnlucmvhlvadcpj` · branch `theme/industrial-noir`
**Mock (approved):** `claude/mocks/B4C_Phase3.1_Probation_Mock.html`
**Concept:** `claude/B4C_Phase3.1_MemberReadiness_Concept.md` §A/§B
**Depends on:** the shipped onboarding work (commit `7110570`; self-sign block committed `fab8c55`). This **EXTENDS** it — do not rebuild it.

**One-line:** turn the existing onboarding checklist into a full path-to-active — a cleared-to-run gate, probation tasks with a 6-month target, 30/60/90 + final milestone reviews, a supervised-hours log, and an auto-surfaced "ready for the vote" state that drives the Probationary→Active flip.

**Status:** Step 0 + live check DONE (findings §1, resolved in §7/§10). The `members` cross-dept hole found in Step 0 is **FIXED + review-passed** (`B4C_Security_MembersCrossDept_Fix.md`, commit `d72aed2`, RETEST 21/0/0). Still open from that: the role-anywhere **family sweep** (§9). CC can draft the #2 migration + test + dry run for review.

---

## 0. HARD CONSTRAINTS

1. **EXTENDS shipped onboarding — don't rebuild.** `onboarding_items` (category, label, is_mentor, sort_order; DA-editable via direct insert), `onboarding_progress` (member_id, department_id, item_id, done, checked_by, checked_at), and `set_onboarding_item(p_member_id, p_item_id, p_done)` (SECURITY DEFINER, `is_canmanage()`, dept-scoped, **self-sign block confirmed live**, refuses the mentor item — whose "done" IS `members.mentor_id`) are LIVE. Build alongside them.
2. **Respect the transition state.** `onboarding_progress` still has a direct `insert/update` grant to `authenticated`, restricted by policy to **DAs of that department** (the deferred REVOKE). **Do NOT reapply that revoke in this build**, and don't break DA ticking on the installed app.
3. **No PII, ever.** Personal-paperwork items are a **status-only** sign-off. Never a file, number, license, or medical detail. Milestone notes are short officer notes — not personal records.
4. **Never write `verified`.**
5. **Custody rule.** Every sign-off/evaluation is signed by an officer/leader, never self — mirror `set_onboarding_item`'s self-sign block on every new write RPC.
6. **RLS-locked, RPC-only** for the new tables (zero direct write grants). Dept-scoped via the live `is_canmanage()` / `is_canmanage_ops()` — both confirmed department-scoped + status-aware. **Do not use `is_leader()`** (NOT department-scoped — see the security fix doc).
7. **America/Chicago** date math. **Honest denominator** for any "ready" / "cleared" / "compliant" count (exclude Inactive, former `member_separation`, PA/test accounts). **Honest defaults** — an unconfigured gate reads "not configured," never "cleared" (§10).
8. **No feature flag. No cron. No background job.** "Auto-flag the board" is a computed, read-time state on a screen. Live the moment the UI deploys.

---

## 1. Step 0 findings (CC — CONFIRMED live)

- **Self-sign block IS live** (committed `fab8c55`): `set_onboarding_item` refuses self-sign and only leaders of the member's own department can call it.
- **Transition state intact** — direct writes to `onboarding_progress` still open, policy restricts to DAs of that department. #2 leaves it as is.
- **Legacy sign-offs have no attribution.** IH 89/93 done items, NH 27/28, have no `checked_by` — ticked directly by DAs, not the RPC. UI shows those as **"Done — sign-off not recorded"** (honest; do NOT backfill). New sign-offs via the RPC are stamped.
- **No usable probation start date.** `members` has only `created_at` (often an import), `joined` (a year as text), `status`. DA-only join date covers 2 of IH's 7 probationary + both of NH's 2. → **new `member_probation` table, §2.0.**
- **Status change is DA-only.** The `members` UPDATE policy requires the DA role in that department → D6: Board **sees** "ready for the vote," a **DA** makes the Probationary→Active change.
- **Checklists vary.** IH 42 items ("Before the Call", "Driving", "Probationary Period", "Structure fire check off"); Lipan 14, NH 15 on the default template. → phase pre-set, §10.
- **apparatus exists**; the two new table names are free; **certs** have no type column (name / exp `YYYY-MM` / proof) → cert items match by `certs.name`.

---

## 2. Schema additions

**2.0 NEW `member_probation`** — the probation start anchor (RPC-only)
- `member_id uuid pk, department_id uuid, started_on date null, note text, set_by uuid, updated_at`. RLS-locked; member SELECT own, leaders dept-read; write only via `set_member_probation(...)` gated to **DA of the dept**.
- **Backfill** `started_on` from `member_private.joined_date` where present; DA enters the rest in Edit-member.
- **When `started_on` is null**, the member's path shows **"Probation start not set"** — never a made-up day count.

**2.1 Extend `onboarding_items`** (DA-editable, additive, defaulted):
- `clears_to_run boolean not null default false` — the cleared-to-run gate set. **Defaults false = empty gate** (§10).
- `phase text default 'onboarding'` — `'onboarding'` (gate) vs `'probation'` (6-month tasks).
- `kind text not null default 'manual'` — `manual` · **`ack` (satisfied only when a #1 document acknowledgment is signed-current)** · `hours` (attended/logged ≥ target) · `cert` (a current cert by name). Config: `ack_series_id uuid`, `hours_target numeric`, `hours_source text` (`'training_night'` → `session_attendance`; `'supervised'` → `supervised_sessions`), `cert_name text` (vs `certs.name`). Auto-kinds computed at read; `manual` unchanged.
  - **Required-reading → cleared-to-run (Ashlea, confirmed).** An `ack` item marked `clears_to_run` is satisfied **only while that document is signed-current**. So an unsigned (or lapsed/needs-resign) required policy keeps the member **not cleared to run** and **counts them non-compliant** in the readiness picture. This is **Level 1** (a real compliance *status*, surfaced everywhere). **Level 2** — physically blocking the live duty roster / LOSAP hour-crediting until signed — is a **staged follow-up** (touches station-presence/crediting; its own review), NOT this build. §7-D1.

**2.2 NEW `probation_milestones`** — officer-signed evaluations
- `id, department_id, member_id, kind ('30day'|'60day'|'90day'|'final'), due_on date, status ('pending'|'on_track'|'needs_work'|'done'), note, signed_by, signed_at`. Unique `(member_id, kind)`. `due_on` from `member_probation.started_on` (America/Chicago). RLS-locked, RPC-only.

**2.3 NEW `supervised_sessions`** — supervised ride-along / drive log (the only genuinely new hours store)
- `id, department_id, member_id, kind ('ride_along'|'drive'|'shift'…), apparatus_id uuid null, hours numeric, occurred_on date, supervisor_id uuid, counts_toward text, note, created_by, created_at`. RLS-locked, RPC-only. **Built here, reused by build #3.** Training nights come from `session_attendance`, not here.

Cleared-to-run and "ready for the vote" are **computed**: cleared-to-run = all `clears_to_run` items satisfied (and ≥1 configured, else "not configured"); ready = all `phase='probation'` items + all milestones `done`.

---

## 3. Write path — RPCs (SECURITY DEFINER, dept-scoped, custody, verified untouched)
- **Reuse `set_onboarding_item`** for manual item sign-off (no change).
- **`set_member_probation(p_member_id, p_started_on, p_note)`** — **DA of the dept**, stamps `set_by`.
- **`set_probation_milestone(p_member_id, p_kind, p_status, p_note)`** — `is_canmanage()`, not-self, dept-scoped, stamps `signed_by`/`signed_at`.
- **`log_supervised_session(...)`** — leader logs (custody), dept-scoped, stamps `created_by`.
- **Reads (SECURITY DEFINER, honest counts):**
  - `my_probation_status()` — day-N-of-180 (or "start not set"), cleared-to-run gate + **compliance (cleared / not cleared)**, probation items, milestones, hours-vs-target; auto-kinds resolved (ack reads `document_acknowledgments`).
  - `dept_probation_board()` — Board/DA/Officer: each member's progress, `cleared_to_run`, `ready_for_vote`. Honest denominator.

No new write grants; execute-grant the RPCs; each self-gates.

---

## 4. RLS
- New tables: member SELECT own; leaders SELECT dept-wide (`is_canmanage()` + dept). No write policies (RPC-only). Verify with `pg_policies`; watch duplicate SELECTs.

---

## 5. UI (the mock; web first, rides native)
- **Member "Your path to active"** (read-only; officers sign): day-N (or "Probation start not set"); the gate banner — **"Gate not configured"** when no `clears_to_run` items, else **"Cleared to run"** / **"Not cleared to run — N required items left"** (unsigned required reading shows here as a blocking item, linking to Read & Sign); items grouped **Before you run calls** / **Probation tasks**, each showing the officer sign-off, **"Done — sign-off not recorded"** for legacy ticks, or auto status; milestone rail; hours-vs-target. Extend the existing onboarding member view + dashboard card. A not-cleared member reads **non-compliant** wherever compliance is shown.
- **Officer/DA:** sign a milestone, log a supervised session, sign items. DA configures `clears_to_run` + phase + kind (incl. pointing an `ack` item at a required document), and sets the probation start. Item editing stays DA/PA.
- **Board/DA "ready for the vote" surface:** members who've cleared everything; Board **sees** it, a **DA** flips to Active via Edit-member (D6). Card disappears on Active.

---

## 6. ACCEPTANCE GATE — real logins, no flag/cron
Ashlea's manual pass, REAL logins in separate browsers (a DA + a member in IH / NH, her test account), never "View as":
1. A probationary member with a start set sees the correct day-N; one without shows "Probation start not set."
2. Officer signs a 30-day milestone / logs a ride-along → member's view + board update; a member can't sign their own.
3. **Required-reading gate:** an `ack` gate item pointed at a required document shows the member **not cleared to run** while unsigned; the moment they sign it current, the item satisfies and (if it's the last one) they go cleared. Publishing a new version flips them back to not-cleared until re-signed.
4. An **empty gate** reads "Gate not configured" — nobody shows cleared by default.
5. All-clear → `ready_for_vote`; a **DA** flipping to Active hides the card.
6. **RLS proof:** member reads only own rows; a second member can't; direct writes denied.
7. Honest denominator; legacy ticks read "sign-off not recorded." `verified` untouched. Prod deploy confirmed.

---

## 7. Decisions — RESOLVED
- **Start anchor:** new **`member_probation`** table (§2.0), backfilled from the join date, DA-set otherwise, "not set" when absent.
- **D1 — Cleared-to-run / required reading (Ashlea, confirmed):** **Level 1 IN this build** — cleared-to-run is a real computed **compliance status**; an unsigned/lapsed required-reading `ack` item keeps the member **not cleared to run** and **non-compliant**, surfaced on their dashboard and the officer compliance/readiness view. **Level 2 (staged follow-up, NOT now)** — hard-blocking the live duty roster / LOSAP hour-crediting until signed; touches station-presence/crediting, gets its own careful review.
- **D2 Milestones:** fixed 30/60/90/final from the anchor. **D3 Hours:** shared `supervised_sessions` + `session_attendance` for training nights. **D4:** officer/leader logs. **D5:** board flag screen-only, no push. **D6:** Board sees "ready," **DA** flips.
- **Legacy attribution:** "Done — sign-off not recorded"; don't backfill.
- **Empty gate:** no `clears_to_run` items → "Gate not configured," never "cleared."

## 8. Out of scope
- **Level 2 gate enforcement** — hard roster/LOSAP-crediting block (staged follow-up, §7-D1). · Push nudges (two-gate). · Qual matrix + driver check-offs (#3) — but the shared hours log is built here. · Any personal-paperwork file/number storage — never.

## 9. Pre-flight / order
1. `members` cross-dept hole: **DONE** (fixed + RETEST 21/0/0 + review PASS). Remaining from it: the **role-anywhere family sweep** (find any other write policy using `is_leader()`/`is_canmanage*` without an explicit dept predicate; record it; the fundraiser fix is the known next one) — do this before or alongside #2, its own small reviewed change.
2. #1 Read & Sign UI is the shipping priority (its DB is live but unused). The `ack` gate items here depend on #1 being live.
3. #2 SQL can be drafted now (all decisions resolved) and applied after review — independent of #1's UI, so it can run in parallel.

## 10. Phase pre-set + empty-gate default (honest-by-default)
- `clears_to_run` defaults **false** for every item → the gate starts **empty**; banner reads "Gate not configured" until a DA marks items. Never show "cleared" against an empty set.
- `phase` defaults `'onboarding'`; **pre-set Indian Harbor's "Probationary Period" category items to `'probation'`**. DAs can re-assign any item afterward.
