# B4C — Onboarding Item Config — UI BUILD ORDER (for CC)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir`.
**DB layer is LIVE** (DRAFT `fb9d9c9` applied; RETEST 16/0/2 skipped, `b84a2e2`). Build the UI against the shipped RPCs. DB build order: [[B4C_Onboarding_ItemConfig_DB_BuildOrder]]. DB review record: [[B4C_Onboarding_ItemConfig_DB_ReviewRecord]]. This extends the LIVE onboarding/probation screens (#2) — additive; an unconfigured item looks and behaves exactly as today.

**The shipped RPCs (use these; never a direct table write for the new behavior):**
- `set_onboarding_item_config(p_item_id, p_requires_doc, p_approver_kind, p_approver_role, p_approver_member_id)` — DA/PA. The document toggle + approver. **Must go through this RPC**, NOT a direct `onboarding_items` update — the four approver columns are RPC-only now. The existing `setItemConfig` path (clears_to_run / phase / kind / hours_* / cert_name / ack_series_id) keeps its direct-update; only the approver + doc config moves to the RPC.
- `mark_onboarding_ready(p_item_id)` — the member, own item only (no member arg).
- `sign_off_onboarding_item(p_member_id, p_item_id, p_doc_checked)` — the approver / tier / DA.
- `onboarding_signoff_queue()` — the sign-off list (returns `can_sign` per row; leadership sees all, a person/tier approver sees theirs).
- Member path states come through the existing path read (`probation_item_states` via its wrapper) — manual items now also read `approver_not_set` / `awaiting_check` / `awaiting_approval`.

## Guardrail posture (carry it into every pixel)
- **No upload control anywhere.** A document item has NO file input, no attach button, no camera. The cadet presents the document in person; the approver attests. If a file picker shows up in this diff, it's wrong.
- **Scoped disclaimer, not app-wide.** On a doc-required item (config panel + the sign-off step), show: "B4C doesn't store this document — an officer checks it in person and records the sign-off." Do NOT write an app-wide "we never store sensitive info" claim (the cert flow does store proof).
- **Honest states throughout** (see the state map below). Nothing reads "done"/"ready" unless it is.
- No new hex; Industrial Noir tokens only; phone-width; `verified` count unchanged; `toggle()` untouched.

## 1. Admin item-config panel (Manage onboarding · DA/PA · manual, non-mentor items only)
Extend the existing Manage-onboarding editor. For each **manual, non-mentor** item add:
- A **"Requires a document check"** toggle.
- An **approver picker**: "Any officer/leadership (default)" · a **command tier** (Officer / Department Admin / Board Member) · or **a specific person** (active members of the department). Person and tier are mutually exclusive — the RPC refuses both; the UI offers one control that resolves to either a tier or a person.
- Saving the doc toggle and/or approver calls `set_onboarding_item_config`. Surface the RPC's friendly errors inline (e.g. "That approver isn't an active member of your department," "Only a checklist item an officer checks off can have an approver").
- Show the resulting routing on the item row: "Signs off: D. Kerr" / "Signs off: any Officer" / "Needs document checked in person."
- Do NOT offer these controls on `ack` / `hours` / `cert` / mentor items (the RPC refuses them — don't present a control that will error).

## 2. Cadet — "Mark ready for sign-off" (own path)
On the probationary member's "Your path to active," for each **manual, non-mentor** item that isn't signed yet, add a **"Mark ready for sign-off"** action → `mark_onboarding_ready(item_id)`. It does not complete the item. After marking, the row reads the honest state (below). A doc item shows the scoped disclaimer so the cadet knows to bring the document. A member only ever sees/acts on their own path.

## 3. Approver — the sign-off list
A new **"Awaiting sign-off"** surface for leadership/approvers, reading `onboarding_signoff_queue()`:
- Each row: member, item, the approver label, whether a document check is required, `ready_at`, and `can_sign`.
- Only render the sign-off control where `can_sign` is true (the RPC enforces it regardless; don't offer what will be refused). Leadership sees the whole department's; a person/tier approver sees only theirs.
- Signing calls `sign_off_onboarding_item(member, item, doc_checked)`. For a `requires_doc` item, the sign-off requires ticking **"I checked the required document in person"** (sends `p_doc_checked=true`) and shows the scoped disclaimer; without the tick, don't send / show the RPC's refusal.
- An officer can also sign an item a cadet hasn't marked ready (they saw it in person) — if you surface a direct sign-off from the member's record, it's the same RPC; the queue is just the convenience list.
- Never offer sign-off on the caller's own item (the DB blocks it; hide it).

## 4. Honest state map (drive labels off the path read's `state`)
- `approver_not_set` → **"Approver not set"** (muted; a DA fixes it in config) — never a silent pass.
- `awaiting_approval` → **"Awaiting approval · {person name | tier}"**.
- `awaiting_check` → **"Awaiting officer check"** (doc items).
- `signed` → **"Signed by {name} · {date}"**.
- `done_unrecorded` / `open` / the mentor + ack/hours/cert states → unchanged from today.

## 5. Reskin / promote discipline (same as the live releases)
- Clean `npm run build` + eslint 0 before the diff. No new hex; honest states; phone-width.
- Deliver **`docs/review/onboarding_item_config_ui_DIFF.patch`** for gate review **before** promote. No apply/deploy.
- After PASS + Ashlea's preview acceptance (sign in as a DA: configure an item with a person approver + document check; as the cadet mark it ready; as the approver sign it with the in-person-check tick; confirm an unconfigured dept/item is untouched and an unresolvable approver reads "Approver not set"), it rides a **normal small web release, Notify Crew held back**.
- **Served-bundle verify** must confirm: the four RPC names (`set_onboarding_item_config`, `mark_onboarding_ready`, `sign_off_onboarding_item`, `onboarding_signoff_queue`) + the new strings ("Mark ready for sign-off", "I checked the required document in person", "B4C doesn't store this document", "Approver not set", "Awaiting officer check") in the served bundle; **no file-upload control** in the onboarding UI; and `POST /api/notify-session` still **404**. Web only — installed-app users get it via a later native build / OTA.

## 6. Mock
No new full mock required — this extends the existing onboarding/probation screens in their established Industrial Noir style. If helpful, share a quick preview of the two new surfaces (the config panel's approver picker + the sign-off list) with Ashlea before promote; not a gate requirement.
