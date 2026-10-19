# B4C — Phase 3.1 #4 Expirations — UI BUILD ORDER (for CC)

**For:** CC · Repo BullRoseProductions/Bullington-VFDAIAgent · branch `theme/industrial-noir`.
**DB layer is LIVE** (commit `9f9ac94`, RETEST 25/0/2) — build the UI against the shipped RPCs. DB review record: B4C_Phase3.1_Expirations_DB_ReviewRecord. Build order: B4C_Phase3.1_Expirations_BuildOrder. **Approved mock:** `claude/mocks/B4C_Phase3.1_Expirations_Mock.html` (materialized to disk alongside this order).
**Settled rulings (Ashlea, Oct 19):**
1. **"Expiring soon" uses the EXISTING cert-badge window, not the mock's "30 days."** Find the exact threshold the roster/cert badge already uses (`certStatus()` — likely ~3 months) and drive the dashboard's "soon" bucket + summary count off `days_until` with that **same** number, so one cert never reads two different ways. The DB read returns `days_until` raw for exactly this. Update the section header/summary label to match (e.g. "Expiring soon," not "30 days").
2. **"Send reminders" reuses `api/_push.js`** (`insertNotifications()` + `sendPush()`, behind `PUSH_ENABLED==="1"`, tokens from `member_devices`) — NOT `api/notify-session.js` (held-back Notify Crew). The button's copy says plainly it only reaches members on 2.2+ who allowed notifications.

## Honest-by-default (carry the whole module's posture into the UI)
- Nothing reads "current" by default. A row with no date reads **"No date"** and sits in its own attention group near the top (it's a gap to fix, not a pass). This matches `dept_expirations()`'s `no_date` bucket.
- Guardrail microcopy on every credential form: **"Class and dates only — never a license or card number."** The DB refuses 5+ digits in the class/label with a friendly error — surface that error inline, don't swallow it.
- No license numbers, scans, medical detail, or free-text notes anywhere in the credential UI. There's no field for them and there must not be one.

## 1. The dashboard screen (leadership)
- New **"Expirations"** screen, shown only to Board/DA/Officer (mirror `dept_expirations()`'s `is_canmanage()` gate — a plain member never sees the nav entry or the screen). Place it in the Reports hub / admin area consistent with where compliance views already live.
- Reads `dept_expirations()`. Build to the approved mock, Industrial Noir, phone-width: hero with the three summary counts, the "Send reminders to flagged members" action, then sections in this order — **Expired · act now → No date → Expiring soon (the cert-badge window) → Current** — each row: avatar, subject (member or rig), type chip, label, the date + days. Honest-empty when the department has recorded nothing ("Nothing's expiring — add credentials, gear and apparatus tests to track them").
- Summary counts must agree with the sections (expired count = expired rows, etc.); don't hardcode the mock's 2/4/38.

## 2. The management forms (DA/Officer only)
The mock shows the dashboard; a DA/Officer also needs to add/edit/remove the underlying records. Build add/edit/delete for all three, each gated to DA/Officer (the RPCs already refuse everyone else — the UI just shouldn't offer the controls):
- **Member credentials** → `set_member_credential` / `delete_member_credential`. Fields: member, kind (license/med card/fit test/other), label, class (optional), issued (optional), expires (optional). Guardrail microcopy as above.
- **Gear** → `set_gear_item` / `log_gear_inspection` / `retire_gear_item`. Fields: member (optional — blank = pool gear), label, in-service date, last-inspected; a "Log inspection" action that rolls the next inspection +1yr; retire is a soft action. Hide retired gear from the active lists.
- **Apparatus tests** → `set_apparatus_test` / `delete_apparatus_test`. Fields: apparatus (hide deleted/retired rigs from the picker — the RPC refuses them too), test type (pump/ladder/hose/other), tested date, next due, result (pass / fail / pass with repairs — a fixed choice, never free text).

## 3. The member's own view
Surface `my_expirations()` as a small read-only "Your upcoming expirations" list on the member's profile / readiness area — their own certs, credentials and gear, same date logic. A member only ever sees their own; they can't edit (no controls).

## 4. Send-reminders action (adds an api/ endpoint — note for promote)
- A new authenticated endpoint (e.g. `api/expiration-reminders.js`) that: verifies the caller is a Board/DA/Officer in their department, reads the flagged (expired + expiring-soon) rows for that department, and sends through the **`_push.js` helpers** — `insertNotifications()` + `sendPush()`. No new notification channel; reuse the existing one. It must **not** import or resurrect `api/notify-session.js`.
- Because this adds an `api/` file, the promote verification must confirm the new endpoint is live AND that `POST /api/notify-session` still 404s (Notify stays held back) — call it out in the release notes so the served check covers both.
- Copy on the button + confirmation: name the reach honestly — "Reminds members on app 2.2+ who turned notifications on." No implication that everyone gets pinged.

## 5. Reskin / promote discipline (same as the live releases)
- Industrial Noir tokens only, no new hex, phone-width, matches the mock. Honest states throughout.
- `verified` count unchanged by this UI; `toggle()` untouched; the write path unchanged. Clean `npm run build` + eslint 0 before the diff.
- Deliver `docs/review/expirations_ui_DIFF.patch` for gate review **before** promote. After PASS it rides a normal small web release (served-bundle verify, **Notify Crew held back**), then the served check confirms the dashboard strings + the new endpoint live and notify-session still 404.

## 6. After #4 UI ships
#5 (readiness scorecard + ISO/audit packet) is next and reads #4's data. Its DB build order comes after the #4 UI is live — `readiness_requirements` (department-configurable "what's required"), `member_scorecard()`, and the ISO packet export. Scorecard mock already approved: B4C_Phase3.1_Scorecard_Mock.
