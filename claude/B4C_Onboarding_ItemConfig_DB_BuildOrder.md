# B4C — Onboarding Item Config (per-item proof · approver · assignment) — DB BUILD ORDER (for CC)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir` · Supabase `ifeptqnlucmvhlvadcpj`.
**This order = the DB slice only.** UI order follows after this passes gate review + is applied (same rhythm as every Phase 3.1 slice). This extends the **LIVE** onboarding/probation module (#2) — it is additive, and existing onboarding items must keep working unchanged until an admin configures them.

**Where this came from (Ashlea relaying a department's feedback, Oct 19):** a chief wants onboarding items that (a) a cadet can mark done but that an approver must sign off, (b) can require the cadet to *present documentation* that the approver checks, and (c) can be routed to a specific person (e.g. the medical officer signs the Medical Statement) or to a command tier (any Officer signs the first items). "Can the admin set, per item, whether it needs documentation and who can approve it."

**TOKEN CONSTRAINT (read first):** do NOT introduce the literal token `verified` into any SQL, app code, or UI string — the codebase guards that token's occurrence count (it tracks the locked verification column). Use **"checked" / "checked in person" / "confirmed"** in all column names, RPC params, and microcopy. The post-condition that asserts the locked verification column is untouched references it without writing the bare literal (split-token, as CC already does).

**Settled decisions (Ashlea, Oct 19):**
1. **Documentation is CHECKED, never STORED.** When an item requires a document, the cadet presents it (in person / however the department already does it); the approver attests they checked it in person, recorded as who + when. **B4C uploads nothing and keeps nothing** — no file field, no storage bucket, no `proof_path` on anything in this slice. The absence is the safety, exactly like the #4 credentials tables. Do NOT add an upload path "to be safe" — if anything in the build pulls you toward storing a file, STOP and raise it.
2. **The disclaimer is SCOPED to these items, not app-wide.** Microcopy on a doc-required item reads like "B4C doesn't store this document — an officer checks it in person and records the sign-off." It must NOT claim B4C never stores sensitive info app-wide, because the existing **cert-submission flow does store uploaded proof** (`certs.proof_path`, `cert_submissions.proof_path`, storage path `{dept}/cert-proofs/{member}/`). Keep the promise true where it's shown.
3. **Approver per item = a specific person OR a command tier.** `person` → a named roster member (the medical officer, a training officer) who is notified; `tier` → a role level (Officer / Department Admin / Board). Unconfigured item → today's behavior (any Officer/DA, i.e. `is_canmanage()`), so legacy items don't break. **No new "Medical Officer" role** — a person-assignment covers it.
4. **Two-signature ("two officers") is NOT in v1.** The approver model above subsumes Tommy's three examples; dual sign-off is a deferred follow-on if a department actually needs it.
5. **Cadet marks ready; approver signs off; never self-approve.** A new "ready for approval" state the cadet sets on their OWN item; the existing self-sign block on *approval* stays (a cadet can never sign off / approve their own item).

## Honest-by-default (carry the module's posture)
- An item whose approver can't be resolved reads **"Approver not set,"** never a silent auto-pass.
- A cadet marking an item ready does **NOT** complete it — it reads **"Awaiting approval · [person or tier]"** until the approver signs.
- A doc-required item that's been marked ready but not signed reads **"Awaiting officer check,"** not "done."
- Completion records the approver's member id + timestamp, and (for doc items) the check attestation. The locked verification column is never referenced or written anywhere in this migration (and the literal token stays out of code/SQL/UI — see the token constraint above).

## 0. STEP 0 — DONE (CC ran it, `sql/onboarding_item_config_STEP0_CHECK.sql`, commit `faaa1e6`, read-only). Paste the live rows back before drafting. It must confirm:
1. **`onboarding_items` columns today** — the Phase-3.1 additive set (`clears_to_run`, `phase`, `kind` in manual/ack/hours/cert, `is_mentor`, `hours_target`, `hours_source`, `cert_name`) + the full column list, so the new columns are purely additive and don't collide. **No existing `proof`/`path`/`file`/`upload` column** on either table (the check is in the Step 0 output; the draft asserts none).
2. **`onboarding_progress` columns + every `set_onboarding_item` version** — its gate, security, the whole-function md5, AND the self-sign block text with its own md5, so the ready/approve split preserves the self-sign block byte-identical.
3. **Other onboarding functions** — each, whether it writes, and an md5.
4. **`action_items` assignment trigger** — the full body of the assignment-and-notify trigger (fires on a real owner change, skips self, respects `is_muted(..,'tasks')`). The person-approver notification reuses this pattern — don't add a second channel.
5. **Access** — policies, RLS state, roles on the three tables; the helper functions + whether each is department-scoped; the role/access values as they actually appear.
6. **Totals** — the locked verification column value (checked, never touched), the storage buckets, onboarding rows per department, and `total_policies`.

## 1. Schema — additive config on `onboarding_items`, additive state on `onboarding_progress`
All additive, re-run-safe, dept-scoped where a row references a member. No new table unless Step 0 shows items aren't already dept-addressable.

**`onboarding_items` — per-item config (admin-set):**
- `requires_doc` boolean NOT NULL default false — cadet must present documentation the approver checks (never stored).
- `approver_kind` text NOT NULL default 'tier' check in **('tier','person')**.
- `approver_role` text NULL — the command tier when `approver_kind='tier'`; check against the real role set (Officer / Department Admin / Board Member). NULL + `tier` = default `is_canmanage()` (today's behavior).
- `approver_member_id` uuid NULL FK → members — the specific approver when `approver_kind='person'`; must be in the item's department.
- Constraint: `approver_kind='person'` ⇒ `approver_member_id` NOT NULL AND `approver_role` NULL; `approver_kind='tier'` ⇒ `approver_member_id` NULL. (A person-approver is also the assignee that gets notified.)

**`onboarding_progress` — additive state (do NOT drop/rename existing columns):**
- `ready_at` timestamptz NULL, `ready_by` uuid NULL — the cadet marked it ready for approval (does not complete).
- `doc_checked_at` timestamptz NULL, `doc_checked_by` uuid NULL — the approver attested the required document was checked in person (only meaningful when the item `requires_doc`).
- Keep the existing completion/sign-off columns as the authoritative "approved" state (approver id + timestamp already recorded there — confirm from Step 0; add `approved_by`/`approved_at` only if they don't already exist under another name).

## 2. Writes — SECURITY DEFINER RPCs, search_path pinned, dept-scoped, locked verification column untouched
- `set_onboarding_item_config(p_item_id, p_requires_doc, p_approver_kind, p_approver_role, p_approver_member_id)` — **`is_dept_admin()`**, item in caller's department. Validates the constraint in §1 and that a `person` target is an active member in the department and a `role` is in the real set. On a person-approver, reuse the `action_items` assignment-notify shape so that member is pinged (don't duplicate a second channel).
- `mark_onboarding_ready(p_item_id)` — **the cadet, on their OWN item only** (`my_member_id()`); the ONE place self-action is allowed. Sets `ready_at`/`ready_by`; never sets completion. Refuses marking ready on another member's item. Idempotent.
- `sign_off_onboarding_item(p_member_id, p_item_id, p_doc_checked boolean)` — the approver signs off. Must satisfy the item's approver config: `person` ⇒ caller = `approver_member_id` (or `is_dept_admin()` override); `tier` ⇒ caller holds the role (or `is_canmanage()` for the NULL default). **Never self** — preserve the existing `p_member_id <> my_member_id()` self-sign block verbatim (prove byte-identical via the Step 0 md5). If `requires_doc`, `p_doc_checked` MUST be true (records `doc_checked_at`/`by`); if false → raise, don't silently complete. Records approver + timestamp. This supersedes / wraps the current `set_onboarding_item` completion path — keep a compatible signature or migrate call sites in the UI slice; do NOT change the self-block.
- (Optional, if Step 0 shows a need) `reopen_onboarding_item` for correcting a mistaken sign-off — `is_dept_admin()`, audit the actor.

## 3. Reads
- The member's onboarding/probation path read must now surface per item: `requires_doc`, the resolved approver label (person name OR tier), the assignee, and the honest state — **not ready → awaiting approval (· person/tier) → awaiting officer check (doc items) → approved (by X, date)** — plus the scoped disclaimer flag for doc items. Reuse the existing path read; don't fork a second source of truth.
- Leadership view: an approver (person, or anyone in the tier) can see the items awaiting their sign-off across cadets, dept-scoped, honest denominator (exclude Inactive/separated). A plain member only ever sees their own path.

## 4. Migration discipline
Single all-or-nothing DO block, re-run-safe (additive guards / `add column if not exists`), precondition that refuses a double-apply. Post-conditions: the new columns + checks exist; `onboarding_items`/`onboarding_progress` keep RLS ON with zero new write policies (writes only through the RPCs); the three RPCs `SECURITY DEFINER` with pinned search_path; the self-sign block on sign-off is byte-identical to Step 0's md5; **no storage bucket, no `proof_path`/`document`/`file`/`scan` column added anywhere in this slice** (assert it); the literal token `verified` count is unchanged (assert without writing the bare literal — split-token); every pre-existing policy byte-identical (snapshot before/after); the locked verification column untouched; `total_policies` before/after recorded. State check at the end.

## 5. Prove it — PGlite dry run (mutations) + live RETEST
- **Dry run:** two depts; a cadet, an officer, a DA, and a named "medical officer" member. Configure: an item `tier=Officer` no doc; an item `person=`the medical officer, `requires_doc=true`; an item left unconfigured (default canmanage). Assert: cadet marks each ready → state "awaiting approval," NOT complete; the officer signs the tier item → approved; the medical-officer person signs the doc item **with `p_doc_checked=true`** → approved + check attestation recorded; the default item signs by any canmanage. Shared honest states hold; the disclaimer flag is set on the doc item only.
- **Mutations, each caught:** a cadet calling `sign_off_onboarding_item` on their own item → refused (self-block); an officer signing a `person`-approver item they're not assigned to and aren't DA → refused; signing a `requires_doc` item with `p_doc_checked=false` → refused (no silent complete); `set_onboarding_item_config` by a non-DA → refused; a `person` approver from another department → refused; an item configured `person` with a NULL member, or `tier` with a member set → refused by the constraint; **any attempt to add a stored file / proof path → the §4 post-condition fails the migration.**
- **RETEST (live, separate, SENTINEL-rolled-back):** per dept — the DA-only config write, the cadet-ready self-scope, the person/tier approver gates, the doc-check requirement, the self-approval block, and the locked verification column untouched.

## 6. Deliverables for gate review (BEFORE apply)
`docs/review/onboarding_item_config_DIFF.patch` (or the DRAFT sql) + the RETEST script + the PGlite dry-run output, for line-by-line gate review. **Do not apply or deploy.** After PASS: Ashlea applies + runs the RETEST; then the UI build order.

## What the UI slice will add (so the shape is visible — NOT this order)
- **Admin item-config panel** (Manage onboarding, `is_dept_admin()`): per item — a "needs documentation" toggle, an approver picker (person from the roster *or* a command tier), and the resulting assignment. Where the picker is a person, show it signs to that member.
- **Cadet path:** a "Mark ready for sign-off" action on the cadet's own items; a doc item shows the **scoped disclaimer** ("B4C doesn't store this document — an officer checks it in person and records the sign-off") and no upload control.
- **Approver sign-off:** the approver sees items awaiting them; signing a doc item requires ticking "I checked the required document in person" (the attestation), which records who + when. Never self.
- Industrial Noir tokens only, no new hex, phone-width, honest states throughout. The locked verification column unchanged; no storage. Rides a normal small web release (Notify held back), served-bundle verified.
