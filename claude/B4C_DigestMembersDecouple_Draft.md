# B4C — Digest: read the member list on its own (decoupling) — DRAFT (API only). NOT deployed.

**Branch:** `feat/digest-members-decouple`, off live main `575a362` (industrial-noir-52, cron honesty).
**Target:** ship before Monday's digest, **2026-11-02 12:00Z**.
**Changed:** `api/digest.js` (+22/−7), `shared/cron-outcome.js` (+5/−2), the new test, and one assertion in
`cron_honesty_test` that this deliberately moves.
**Unchanged:** `api/_cron.js`, `api/pulse.js`, `vercel.json`, and no SQL.

## The bug (found in the cron-honesty Step 0)
- The digest's "non-fatal" metrics block read `members` in the **same `Promise.all`** as `training_sessions`,
  `session_attendance`, `certs` (metrics), `apparatus` and `station_presence`.
- So **any** of those failing threw, and `mi` kept its empty default `members: []`.
- The member list is who the email goes **to** (`deptAdminEmails`). Every department therefore landed in `skipped` ("member
  read failed") and **no digest went out**.
- That's the opposite of the block's own comment: "If this block fails the summary degrades to '—' and the digest still goes
  out".

## The fix
- `members` is read **first, on its own** (the same columns, `id, department_id, access, email, status, joined`) into
  `memberRows`, with its own `membersError`. `mi.members` is always `memberRows`.
- The metrics `Promise.all` now holds only the five metric reads. If one fails, `mi.error` is set and the **tiles dash out**
  ("—"). **Recipients, notification targets and every per-department denominator keep the real member list.**
- **A failed member read is honestly fatal:** there's no one to send to. Every department lands in `skipped` with
  `member read failed: …`, and the run answers **500 `members-read`**. It's a new step in `shared/cron-outcome.js`, ordered
  before `metrics-read`.
- Cron honesty still applies: a failed metrics read **still answers 500 `metrics-read`** (the DB failed). The difference is
  that **the emails now actually go**.
- **A clean run is byte-identical to main:** body and sends, proven against `575a362`.

## Tests
- **`docs/review/digest_members_decouple_test.mjs`: 13/0.** It bundles the real handler and main's, uses the same fake
  Supabase client and counted `fetch` as cron honesty, and captures each email's html.
  - **A clean run** → 200, byte-identical to main's; both departments mailed.
  - **Each metric read failing in turn** (`training_sessions`, `session_attendance`, `apparatus`, `station_presence`) →
    **both admins are still mailed, with the flagged cert in each email**, and the run answers 500 `metrics-read`.
    **Main mails nobody** in every case.
  - The certs metric read can't fail alone in this fake: certs is also a core detection read, which 502s first.
  - **The tile degrades:** a clean email's Attendance tile shows `100%`; with `training_sessions` failing it shows `—`, and
    the cert is still there.
  - **The member read failing** → 500 `members-read`, nothing sent, the reason logged, and nothing internal in the body.
  - Bad auth → 401. The rule unit is covered.
  - **Fences:**
    - the changed files are exactly as listed;
    - `_cron.js`, `pulse.js`, `vercel.json` and SQL are untouched;
    - verified 132/32/14;
    - Notify held.
- **`cron_honesty_test`: 29/0.** Its "failed metrics read" assertion is updated: still 500, and now 2 sends where main at
  `09f7755` sent 0.
- **The full suite:** 48 files, 1193 PASS, no nonzero exits. ESLint is clean.

## Before Monday
**This doesn't fix the key.** If the service-role credential is still bad, Monday's run fails at the **core detection read →
502 `detection-read`**, before any of this matters. Now that cron honesty is live, that will be visible: a red cron and a
logged message.
