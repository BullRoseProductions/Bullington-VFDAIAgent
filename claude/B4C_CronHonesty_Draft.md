# B4C — Cron honesty: pulse + digest fail loudly when the work fails — DRAFT (API only). NOT deployed.

**Branch:** `feat/cron-honesty`, off live main `09f7755`.
- **Changed:** `api/pulse.js` (+18/−3), `api/digest.js` (+18/−1), new `shared/cron-outcome.js` (the rules), and
  `docs/review/cron_honesty_test.mjs`.
- **Unchanged:** `api/_cron.js` / `requireCron` is **byte-identical**, as are `vercel.json` (the crons) and the SQL. No SQL
  was run apart from three read-only checks.
- **Shipping** rides a normal web deploy on Ashlea's go.

## ⚑ Read first: this isn't two bad runs. Pulse has done nothing since about 2026-10-17 20:00Z
- **Pulse logs.** Every pulse run in Vercel's retained logs (2026-10-26 10:00Z → 10-31 04:00Z, **101 of 101**) logged
  `db=unreachable` with an **empty** message, `deliverable=0`, and HTTP 200.
- **The notifications table (read-only):**
  - pulse's families wrote steadily until **2026-10-17**: event 310 rows (last 07:00Z), maint (last 05:00Z), duty (last
    13:00Z), shift (last **19:00:37Z**);
  - **since then they've written zero rows in 13+ days**, with sessions on the calendar the whole time;
  - the app's own onboarding notifications are still being written (last 10-31 00:41Z), so **the database is fine**.
- **What the evidence points to.** Only **pulse, digest and expiration-reminders** use `SUPABASE_SERVICE_ROLE_KEY`.
  - pulse's probe is a HEAD request. An HTTP error there has no body, which matches the empty message.
  - That pattern fits a **service-role credential that stopped working around 2026-10-17 19:00–20:00Z** (a 401). Two
    examples: legacy JWT keys disabled or the JWT secret rotated in Supabase, or the Vercel variable changed.
  - **Unverified:** I can't read the key (and won't), and Vercel's CLI shows only "created 128d ago", not when it was last
    updated.
  - The members cross-department fix applied at 19:34Z that day is **not** it: it only changed two RLS policies, and the
    service role bypasses RLS.
- **For Ashlea to check (her action, not mine):**
  - Supabase → Project Settings → API keys: are the legacy JWT `service_role` keys still enabled, or was the JWT secret
    rotated?
  - Does Vercel's Production `SUPABASE_SERVICE_ROLE_KEY` match the current one?
  - After fixing, redeploy. Pulse's log will show `db=ok` and its families start writing again.
- **When this change ships, pulse answers 503 every hour until the key is fixed.** That's the point of the change, but
  know it before shipping. The log line now names the HTTP status, e.g. `db=unreachable: status 401`.

## Step 0
### Why each handler still returned 200
- **`api/pulse.js`:**
  - Every step catches its own failure into a list and carries on: `detectErrors` (per family), `muteErrors` (failed
    closed), `writeError`, `pushErrors` (drain / stamp / FCM).
  - The final service-role probe sets `report.db = "unreachable: …"`.
  - Then the handler ends with an **unconditional `return res.status(200).json(report)`** (old line 982). The failures only
    ever lived in the JSON body, which Vercel's cron monitoring doesn't read.
- **`api/digest.js`:**
  - A failed **core detection read** (certs / equipment / apparatus_maintenance / departments) already returned 502.
    But it **echoed the raw DB message in the body and logged nothing**.
  - Everything after that is caught and folded into the body: the metrics / duties / hours reads, each department's
    notification rows and push, and **each department's email send**.
  - Then an unconditional `return res.status(200)`. So "every admin's email failed" answered 200.

### The 2026-10-26 12:00:44Z digest 502: what failed
- **The 502 can only be the core-read catch.** It's the digest's only 502, and Vercel's log record for it holds nothing but
  Node's `url.parse` deprecation warning, with no body, error code or duration. The DB message lived only in the response
  body, which nothing logged, so **the exact message can't be recovered**. This change fixes that.
- **Not schema.** A read-only check today shows every column those four reads select exists, and each PostgREST embed
  (`certs→cert_types`, `certs→members`, `equipment→equipment_type`, `apparatus_maintenance→apparatus`) has exactly one FK
  path. The columns the Oct 24 cert-dates change added (`no_expiry`, `cert_types`) were live from 10-24 / 10-21.
- **The same root cause as pulse.** Pulse logged `db=unreachable` every hour that morning, including **12:00:33Z**, eleven
  seconds before the digest's 502. With the same service-role key, the digest's core reads almost certainly failed the same
  way. **So it isn't a digest-specific problem: it's the credential.**
- **The next scheduled digest is Mon 2026-11-02 12:00Z. It will 502 again unless the key is fixed first.**

## The fix
**`shared/cron-outcome.js`** turns what a run observed into `{ status, failed[] }`.
- On a 5xx the handler **logs the details** (Vercel logs: DB messages, HTTP status, which departments) and answers a
  **terse body**: `{ ok:false, failed:[step names], … }`. That's a fixed step vocabulary, with no secrets, stack traces, DB
  messages, emails or member ids.
- **A clean run returns exactly what it returned before.** The test compares the body and the side effects byte for byte
  against `origin/main`'s handlers.
- Auth is untouched. `requireCron` answers 401 / 500 before any work; only **work** failures become a 5xx.

### pulse: any failed step fails the run
| observed | status | step |
|---|---|---|
| the service-role probe fails | **503** | `db` (even alongside others) |
| a family's detection read fails | 500 | `detect:events` / `detect:tasks` / `detect:duties` / `detect:maint` / `detect:shifts` |
| a mute read fails (treated as muted) | 500 | `mute-check` |
| the notification write fails | 500 | `write` |
| the drain read, the pushed_at stamp, or FCM auth fails | 500 | `drain` / `stamp` / `push` |
| push is ON but FCM credentials are missing | 500 | `push-config` |
| `PULSE_ENABLED` off; per-device FCM rejections; a quiet hour | 200 | (not failures: unchanged) |

Body: `{ ok:false, failed, done:{ written, pushed } }`. Pulse is hourly and idempotent (writes de-dupe), so the next tick
retries everything. A partial run is still a 5xx, because the families that failed sent nothing.

### digest: the proposed rule, including the partial case
| observed | status | step |
|---|---|---|
| a core detection read fails | **502** (unchanged code) | `detection-read`; body is now `{ ok:false, failed:["detection-read"] }`, the message is logged, not echoed |
| **any department's email fails to send, even if others went** | **500** | `send`; body: `sent: N`, `notSent: [department names]` |
| the metrics / duties / hours reads fail | 500 | `metrics-read` / `duties-read` / `iso-hours` |
| a department's notification rows or FCM auth fail; push ON with no FCM creds | 500 | `notify` / `push` / `push-config` |
| a department skipped for having no active DA email; a quiet week; per-device FCM rejections; a dry run's unsent mail | 200 | (not failures: unchanged) |

**Why a partial send is a 5xx:**
- A Department Admin who didn't get their weekly digest *is* the job failing for them.
- The digest is weekly and nothing retries it, so a green check would hide it for seven days.
- The departments that did get it still got it; nothing is re-sent automatically. Vercel crons don't retry, so a 5xx can't
  cause a duplicate.
- The body names who was **not** mailed, so a re-send can be targeted.
- **Gate call:** there's no `?dept=` parameter today, so a manual re-send goes to everyone. If you want targeted re-sends,
  that's a small follow-up.

### Found, not changed: the digest's "non-fatal" metrics block isn't non-fatal for recipients
- Its comment says a failed metrics read degrades to "—" tiles and "the digest still goes out".
- But `members` is read in the **same `Promise.all`** as the metric reads. Any one of them failing blanks `mi.members`, and
  recipients come from `mi.members`, so **no department gets an email**; each lands in `skipped` as "member read failed".
- Main does the same thing today (the test proves the sends are identical). The difference is that this run now answers
  **500 `metrics-read`** instead of 200.
- **Proposed follow-up:** read `members` on its own, outside the tolerant block.

## Tests
- **`docs/review/cron_honesty_test.mjs`: 29/0.** It bundles the real handlers *and* `origin/main`'s versions against a
  switchable fake Supabase client and a counted `fetch`, and captures the logs.
- **pulse:**
  - **clean → 200, body and DB writes byte-identical to main's**;
  - **the probe unreachable (HEAD → 401, empty message: the live signature) → 503 `{ok:false, failed:["db"]}`**, with
    `status 401` in the log and nothing internal in the body. Main answers the same run 200;
  - a detection read failing → 500 `detect:events`, the message logged and not echoed;
  - **bad / missing auth → still 401, no client**;
  - `PULSE_ENABLED` off → the same 200 as main.
- **digest:**
  - **clean → 200, body and sends byte-identical to main's**;
  - **a core read failing (the 10-26 path) → 502 `{ok:false, failed:["detection-read"]}`**, with the message logged.
    Main's body echoed it and logged nothing;
  - **partial: Alpha mailed, Bravo failed → 500 `{failed:["send"], sent:1, notSent:["Bravo FD"]}`**, and Alpha's mail
    still went. Main answers 200;
  - every send failing → 500, sent 0;
  - a failed metrics read → main's exact sends but 500;
  - **bad auth → 401**.
- **Rule units:** each pulse step; 503 precedence; `push-config` only when push is on; the digest partial counts;
  detection-read alone; dry runs never "unsent".
- **Fences:**
  - **`api/_cron.js` byte-identical to main**;
  - `vercel.json` and `sql/` untouched;
  - the changed files are exactly the five;
  - verified 132/32/14;
  - Notify held.
- **`l1_cron_secret_test`: 34/0** (the L-1 gate, unchanged).
- **The full suite:** 47 files, 1180 PASS, 0 FAIL. `shared/digest.station-hours.test.mjs` prints a "FAILED HOURS READ"
  section heading and passes. ESLint is clean.

## Also seen, not investigated
`/api/claude` answered **403 five times** at 2026-10-30 20:12Z, with one 204 preflight. It's out of scope here, but if
someone hit "AI draft" then and got refused, that's where to look.
