# B4C — PII scrub of the repo (working tree only): DRAFT for gate. NOT deployed, nothing applied.

**Branch:** `chore/pii-scrub`, off main `5b26d28` (industrial-noir-57).
- No history rewrite and no force-push. The SQL isn't applied, and no database rows changed.
- Verified 132/32/14; Notify held.

## ⚑ Read first: what a working-tree scrub can and can't do
- **Git history keeps every name, email and id below.** Anyone given a full clone (`.git` included) can recover them with
  `git log -p`.
- This branch makes **the current snapshot** clean. So **share a snapshot, never the repository**: `git archive HEAD` or a
  fresh single-commit copy, after the Part 3 decisions.
- If the repo itself must ever be shared, history needs rewriting (`git filter-repo`). That's a separate, explicit,
  destructive step: not proposed.

**How the sweep was done (read-only):**
- The live roster's names, emails, phones and member ids, plus the 28 memberless auth accounts, were matched against all **581
  tracked files** (everything but `ios/`, `android/` and binaries). Literals were extracted locally (68 UUIDs, 66 emails, 16
  phone-shaped numbers) and resolved against the database.
- **Phones:** 0 real.
- **Member-row emails:** 2 Ashlea's + 1 demo.
- **Member ids:** 3 (Josh Merritt, Ashlea, Demo).
- **Full names:** 12 real members.

## Part 1: member-named SQL files: BUILT on this branch
**Renames** (git mv, history follows):

| was | now |
|---|---|
| `sql/josh_merritt_cert_reset_2026-10-13.sql` | `sql/cert_submissions_reset_2026-10-13.sql` |
| `sql/jared_allen_window_CHECK.sql` | `sql/membership_window_join_date_CHECK_2026-10-16.sql` |
| `sql/paul_proof_files_CHECK.sql` | `sql/membership_window_proof_files_CHECK_2026-10-16.sql` |

The one record citing them by filename (`docs/review/membership_window_REVIEW.md`) is updated: filenames only.

**Comment-only redactions** in 14 applied / historical SQL files:
- Labels are stable across the repo: Member A Chase Thomas · B Spencer Sampler · C Kai Newton · D Mike Bell · E Kenny Bell ·
  F Paul Stetzel · G Jared Allen · H Matt Hohon · J Jeff Harper · K Josh Merritt · L Roger Gaines · M Randy Little · N the owner (shared/members.js). **This
  key lives only here, in this note, not in the SQL.** Delete this line before any share.
- Only `--` comments were touched; a trailing `-- …` after code had only its comment edited.
- **Proof:** every one of the 14 files is **byte-identical with comments stripped** (`sed 's/--.*$//' | shasum`, before vs
  after). The SQL's meaning is unchanged.
- **No recorded hash breaks.** No test or review record pins these files' bytes (grepped); the live function md5 pins come from
  the database, not files.

**Left on purpose (code, not comments: changing them would change what the record ran). ⚑ Flagged:**

| file:line | what | why left |
|---|---|---|
| `close_forgotten_shifts_2026-10-15.sql` :30, 35-37, 55, 71 · `…_PREVIEW.sql` :11, 14, 16 | `lower(btrim(m.name)) IN ('kai newton', …)` / VALUES | the selector the applied record ran by |
| `membership_window_cleanup_2026-10-16.sql` :41-43, 83-90 · `…_PREVIEW.sql` :18, 44-67 · `…_PREVIEW_compact.sql` :6-55 | `= 'paul stetzel'`, report strings | selector + output labels |
| `membership_window_join_date_CHECK_2026-10-16.sql` :6, 8 · `…_proof_files_CHECK_2026-10-16.sql` :4 | `= 'jared allen'` / `'paul stetzel'` | the check's selector |
| `cert_submissions_reset_2026-10-13.sql` :27, 29, 44, 46 · `cert_submissions_dept_scope_RETEST.sql` :26, 29 | member id `019d1fd0…`, reviewer auth id `819dd88d…`; aliases `all_josh_submissions` / `josh_certs_unchanged`; format string "Josh Merritt: %s pending…" | selector / output |
| **`geofence_replay_guard_and_cap.sql:437`** | "Matt Hohon, Granbury, 2026-08-30" | **inside the `geofence_depart` function body**, so it's in the LIVE function's source too, readable to anyone with function-definition access. Removing it is a DB change (CREATE OR REPLACE + a re-pin of anything that md5-pins `geofence_depart`). Recommend: next time that function is touched for real, drop the name from the comment. Not worth a migration alone. |

## Part 2: api/digest.js: BUILT (production diff, for gate)
- **The only personal datum compiled into `api/digest.js` was `DEFAULT_TO = "ashlea@b4thecall.com"`.** It never reached a real
  broadcast: real runs mail each department's DAs (`deptAdminEmails`); `to` is used only when `?to=` is set. Its single job was
  the **fallback test allow-list** when `DIGEST_TEST_TO` is unset.
- **Change:** the constant is gone. `TEST_TO = (process.env.DIGEST_TEST_TO || "")…`. Unset → **no** test send is allowed (400
  before any read: the safe direction). Real runs are untouched.
- **⚑ The member UUIDs are NOT in `api/digest.js`.** WS-4c moved them to **`shared/members.js`** (`STATS_EXCLUDED_IDS`: owner,
  test, demo). That **one** list is imported by **both** the digest **and the client** (`App.jsx` counts / pickers), and
  `ws4c_members_test` pins it there. Moving it to configuration is therefore a client change:
  - **(a) Env:** `VITE_STATS_EXCLUDED_IDS`, read by `shared/members.js` from `import.meta.env` in the browser and `process.env`
    in functions (Vercel exposes VITE_ vars to functions too). Caveats:
    - Vite **inlines it into the served bundle**, so the ids stay public on the web; only the repo is cleaned.
    - **Every native build needs it in `.env`** (memory: worktree builds have no `.env`).
    - If missing, owner/test/demo silently join every count. Needs a loud guard.
  - **(b) Database:** a flag on the member (e.g. `members.excluded_from_stats`), read where `members_view` is read. Nothing in
    code or bundle; survives native builds. Needs a small SQL slice + the client/digest reads.
  - **(c) Leave it:** two of the three ids are test/demo accounts, and the third is the owner's own row.
  - **Recommend (b)** if the goal is "nothing personal ships", **(c)** if it's only "the repo snapshot". **Not built:** gate
    call. Note `02c4a728…` ("test account") **no longer exists** live, whichever way: a dead id.
- **Tests:**
  - `l1_cron_secret_test` (the L-1 gate's test) asserted the old fallback. Its two "default address passes" checks now assert the
    new contract: unset → that address is refused 400 before any read. The send-to-that-address-only check moved under
    `DIGEST_TEST_TO` set. It uses a fake `owner@test.fd` instead of the real address; 35/0 (was 34; one check split).
  - **Clean-run byte-identity:** `cron_honesty_test` (vs `09f7755`) and `digest_members_decouple_test` (vs `575a362`) compare a
    real run's body **and the email sends** byte-for-byte against older main handlers. Both still pass, so the broadcast email is
    unchanged.
  - **Suite: 52 files, 1291 PASS, 0 FAIL.** Lint + build clean. **digest's own count stays 32**; App 132; assistant 14.

**Env for Ashlea before this promotes** (names only; Vercel → Settings → Environment Variables → Production):
- **`DIGEST_TEST_TO` = `ashlea@b4thecall.com`** (comma-separate to add more). It's **not set today** (checked: `vercel env ls`).
  Without it, test sends (`?to=`) are refused after the promote; the Monday broadcast is unaffected.
- **Order:** (1) add the variable, (2) promote this, (3) **Redeploy**. Env binds per deployment: a deployment built before the
  variable existed won't see it, so if the variable is added after the merge's build, redeploy the production deployment.

## Part 3: the rest of the sweep: REPORT ONLY (nothing touched without your gate)
| # | where | what | recommend |
|---|---|---|---|
| 1 | `src/App.jsx:512` `SUPPORT_EMAIL = "ashlea@b4thecall.com"` | owner's **work** support contact, shown in Settings & Support | **KEEP**: load-bearing, it's the product's support address. (Optionally a `support@` alias later.) |
| 2 | `src/App.jsx:27803` placeholder `scott@northhood.org` + `:27802`/`:28327` "e.g. Scott Miller" | example text on PA "Add a department" / add-member forms | **REDACT** → `chief@example.org` / "e.g. Alex Rivera". Not in the DB, but it reads like a real North Hood address; hint text shouldn't. |
| 3 | `src/App.jsx:11366` placeholder `dale@harrishardware.com` | donor/sponsor form hint | **REDACT** → `owner@example.com`: a real-looking business address. |
| 4 | `api/digest.js:333`, `shared/station-hours.js:97`, `shared/digest.station-hours.test.mjs:17` | "Chase Thomas read 38.42 credited…" in **comments** | **REDACT** → "a member (Member A) read…". Comment-only, zero behavior. |
| 5 | `tests/assistant.e2e.test.mjs:14`, `docs/review/ask_b4c_phase1_DIFF.patch:573` | **"Kai Newton"** used as a **test fixture** name | **REDACT** the test (→ "Pat Example"); the `.patch` is a historical diff (see 8). |
| 6 | `docs/review/membership_window_REVIEW.md:18, 23, 25` | Kai Newton / Jared Allen / Paul (Stetzel) with join / termination / cert facts | **REDACT** to the Part 1 labels: a personnel record about named people. |
| 7 | `docs/review/ws4d_LIVEDEFS.json:135` | captured `geofence_depart` definition incl. "Matt Hohon" | **KEEP + flag**: a byte capture of the live function; it goes when the function's comment does (Part 1 ⚑). |
| 8 | `docs/review/*_DIFF.patch` (ws4c_members ×9, ws4b_shared, cert_dates_sliceB, pa_radar_rollup_fit `Author:` line, ask_b4c_phase1) | owner/test/demo ids, `DEFAULT_TO`, the owner's email in a commit header, a fixture name | **EXCLUDE from any share** (they're copies of history) rather than edit them. Same reasoning as git history. |
| 9 | `shared/members.js:25-27`, `docs/review/ws4c_members_test.mjs:30` | owner / test / demo member ids (+ "test@b4c.com") | **Part 2 gate call (a/b/c)**; the test follows whichever. |
| 10 | `claude/B4C_L1_CronSecret_Draft.md:20,31,35`, `claude/B4C_3.0_Email_SendOrder.md:67` | owner's **work** email in runbooks / notes | **KEEP** in the internal notes; **exclude `claude/` from a share** (it's working notes, full of operational detail). |
| 11 | `sql/apparatus_photos_rls_fix.sql:29`, `sql/close_forgotten_shifts_2026-10-15.sql:3` | `ashlea@bullroseproductions.com` (a comment: "applied as …" / a probe) | **REDACT** comment → "the owner". Comment-only; same byte-identity proof as Part 1. |
| 12 | department names and UUIDs (5 live departments) throughout `sql/`, `docs/`, `claude/` | organizational, not personal | **KEEP**. |
| 13 | fake fixtures: `*.test`, `*.invalid`, `example.*`, `555-01xx` numbers, `00000000-…`/`1111…` UUIDs, "Pat/Test/Demo" | clearly fake | **KEEP**. |

Not found anywhere: any member's **personal** (gmail/yahoo/…) address, any member phone number, any of the 28 memberless
accounts' emails.

**If approved,** items 2-6 and 11 are one small follow-up: comment / placeholder / fixture text only, plus that test's own
assertion, with the same byte-identity proof for the SQL comments.

## Follow-up (gate PASS @f46c6c9, rulings applied)
Built on this branch, text only:
- `src/App.jsx` placeholders `scott@northhood.org` → `chief@example.org`, "e.g. Scott Miller" ×2 → "e.g. Alex Rivera",
  `dale@harrishardware.com` → `owner@example.com`;
- the three "Chase Thomas" comments → Member A;
- `tests/assistant.e2e.test.mjs` fixture "Kai Newton" → "Pat Example";
- `docs/review/membership_window_REVIEW.md` → Member C / F / G (pronouns neutral);
- the owner's bullroseproductions address in two SQL comments → "the owner". **Comment-strip proof:** both files are
  byte-identical without comments.
- `shared/members.js`: "Ashlea (owner)" → "the owner (Member N)". **The ids stay (ruling c; the DB flag is backlogged).**
- **Rider, unchanged by ruling:** the Matt Hohon comment in `geofence_depart`'s live body (and its capture in
  `ws4d_LIVEDEFS.json`).

**Re-sweep:** the 12 names now appear only in SQL code (flagged in Part 1), the captured function body (rider), the `_DIFF.patch`
history copies, and this note's label key.

**⚑ Found, not caused:** `tests/assistant.e2e.test.mjs` (outside the suite loop) **fails identically before and after** this
change (FAIL "answer returned", FAIL "meter recorded BEFORE the first model call", `TypeError … 'lastMsg'`). It's a stale test, not
this slice.

**Promote order (held):** (1) Ashlea adds `DIGEST_TEST_TO=ashlea@b4thecall.com` to Vercel **Production**, (2) pin + merge +
push, (3) **Redeploy**: env binds per deployment.
