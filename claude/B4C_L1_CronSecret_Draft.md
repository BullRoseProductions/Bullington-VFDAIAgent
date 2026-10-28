# B4C — Security L-1 · Cron secret — DRAFT (api only)

**Branch:** `feat/l1-cron-secret` off main `8f9474a` (industrial-noir-43). **Not reviewed, not promoted.**
**Finding** (audit `B4C_CC_Security_Audit.md` L-1 / plan S-5): `api/digest.js` and `api/pulse.js` accept the secret as
`bearer || req.query.secret` with a plain `!==`. The same secret also unlocks digest **`?to=`** (a full digest mailed to
any address) and **`?dry=1`** (rendered HTML + every admin's address). A secret that leaks through a URL or a log
grants all of that.

## What changed — 3 api files, no client, no DB, no vercel.json
- **`api/_cron.js` (new)** — `requireCron(req, res)`, the one gate both routes use:
  - **Header only.** `Authorization: Bearer <secret>`, which Vercel Cron already sends. The scheme is case-insensitive.
  - **`?secret=` is refused** with 401 and a note: "?secret= is no longer accepted. Send it as an Authorization: Bearer header."
    It is refused **even when it's right, and even alongside a valid header**. Its value is never compared.
  - **Constant-time compare.** Both sides go through sha256, then `timingSafeEqual` (always 32 vs 32 bytes), so
    response time leaks neither the length nor a matching prefix.
  - Still **fails closed** (500) when `CRON_SECRET` is unset.
- **`api/digest.js`**
  - Gates with `requireCron`.
  - **`?to=` must be on a test allow-list.** `DIGEST_TEST_TO` is optional and comma-separated; when it's unset, only
    `DEFAULT_TO` (ashlea@b4thecall.com) is on the list. Matching is case- and space-insensitive.
  - An unlisted address gets a **400 before any read**: no service-role client, no send. It is never silently swapped
    for the default. That includes a real admin's address; the list is explicit, not "any member".
  - `?dry=` is unchanged. It now sits behind the header-only secret, which is the lock the audit asked for.
- **`api/pulse.js`** — gates with `requireCron`. `?dry=` and `?only_member=` are unchanged.

## Decisions for you
- **D-1 · Manual runs move from the browser to curl.** Anything bookmarked with `?secret=` stops working, and it
  fails visibly (401 + the note). Equivalents:
  ```
  curl -H "Authorization: Bearer $CRON_SECRET" "https://app.b4thecall.com/api/digest?dry=1"
  curl -H "Authorization: Bearer $CRON_SECRET" "https://app.b4thecall.com/api/digest?to=ashlea@b4thecall.com"
  curl -H "Authorization: Bearer $CRON_SECRET" "https://app.b4thecall.com/api/pulse?dry=1"
  ```
  The secret now appears only in your shell, not in browser history or the Vercel request log's URL column.
- **D-2 · Test list = ashlea@b4thecall.com only, unless you set `DIGEST_TEST_TO`.** Recommend leaving it unset.
- **D-3 · Rotate `CRON_SECRET` after this ships (recommended).** The current value has travelled in `?secret=` URLs,
  so assume it's in browser history and logs. To rotate: Vercel → Settings → Env → `CRON_SECRET` (Production) → new
  random value → redeploy. Cron picks it up automatically. Do it after the promote, not before, or manual runs on the
  old code would need the new value in a URL.
- **D-4 · `?dry=` still returns admin addresses.** That's the point of the preview (`wouldSendTo`). With the
  secret off URLs I'd leave it as is; say if you want those addresses masked.

## Tests — `docs/review/l1_cron_secret_test.mjs`: 34 PASS, 0 FAIL
- The test bundles the **real** digest and pulse routes, with a fake Supabase client that counts `createClient` and
  `fetch` stubbed so each Resend send is counted.
- For both routes:
  - Unset secret → 500.
  - No header, a wrong Bearer, a one-char-off same-length secret, or the right secret without "Bearer " → 401.
  - **The right secret in `?secret=` → 401 with the note**, and still 401 alongside a valid header.
  - The right Bearer → 200.
  - No refusal opens a client or sends.
- Digest `?to=`:
  - Off-list → 400 before any read, with or without `dry`.
  - The default address → renders and sends for that address only.
  - A real admin who isn't on the list → 400.
  - A real run with no `?to=` still mails the department's admins.
  - `DIGEST_TEST_TO` widens and replaces the list.
- Source fences: no `!==` compare and no `query.secret` read left; only `_cron.js`, digest and pulse read
  `CRON_SECRET`; locked tokens 132/32/14; Notify held; only the expected files changed vs `8f9474a`.
- **Full suite: 34 files, 954 PASS, 0 FAIL**, using the test-only jsdom 30.1.2, happy-dom and PGlite in
  `HAPPY_DOM_DIR` / `JSDOM_DIR` / `PGLITE_DIR`. ESLint is clean on the three files.

## After promote — live check
- `curl -sI https://app.b4thecall.com/api/digest` → 401.
- `curl -s "https://app.b4thecall.com/api/digest?secret=x"` → 401 with the note.
- `curl -s -H "Authorization: Bearer $CRON_SECRET" ".../api/digest?dry=1"` → 200 `dryRun:true`.
- Monday's 12:00 UTC cron run shows 200 in the Vercel log.
