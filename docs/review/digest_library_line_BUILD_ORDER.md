# Weekly Training Content, slice 3: the digest's "New in the B4C library this week" line: build order and hand-back

**Status:** for gate. **Not reviewed, not promoted.** Branch `feat/digest-library-line`, off `4176cba`.
- `4176cba` is main `8dbb398` (Library S2 UI, gate PASS) plus its tests-only fence pin. The pin rides this merge.
- **Changed:** `api/digest.js` and `shared/cron-outcome.js` only.
- **Not touched:** `api/_cron.js`, `api/pulse.js`, `vercel.json`, `src/` and `sql/`.
- No SQL to apply. Server-side only, so nothing is native.

**Design:** `docs/design/training_content_step0.md` §4 and §6 row 3 (gate PASS @2a0768c; rulings @4cfe29f, R4).

## What it does
- **One read per run**, the same for every department, after the duties read:
  - `library_drills` columns `title, state, published_at`, where `state = 'published'` and `published_at` falls in the digest's own week window. That's `digestWeekWindow`, `[Mon 00:00, Mon 00:00)` Central, the same window as Station Duties.
  - `newLibraryTitles` repeats the filter in code: published only, inside the window, newest first, trimmed, de-duplicated case-insensitively, blanks dropped. The line can never name a drill from outside the week, or one that's submitted or withdrawn.
- **The line:** a "B4C library" block after Station Duties: *"New in the B4C library this week: Mayday Operations, Primary Search & Rescue (+1 more) — add them from Training → Library."*
  - It shows two titles and "(+N more)", following the Step 0 example. The wording is "add it" for one title.
  - Titles are HTML-escaped. Titles only: no content, no origin.
  - A week with nothing new renders **nothing**. A quiet-library digest is byte-identical to BASE.
- **Not a flag (R4).** The line never seeds `byDept` and never counts toward `n`, the subject or headline, or the notification rows. A department with nothing flagged still gets no email. `SEND_WHEN_NOTHING_FLAGGED` stays `false`.
- **Cron honesty:** a failed library read is a *degraded* read, handled like `metrics-read`:
  - every email still goes, without the line;
  - the run answers **500 `library-read`**;
  - the database message goes to the log and never into the body.

  `digestOutcome` gains `libraryError`, which maps to the `library-read` step. A clean run's outcome is unchanged.

## ⚑ Live check before merge (read-only, on Ashlea's go)
- **The question:** can the digest's server key read `library_drills`?
  - Slice 1 revoked `INSERT, UPDATE, DELETE, TRUNCATE` from `service_role`, but **never SELECT**. Supabase grants service_role ALL on public tables by default, so SELECT should still be there. That's expected, not proven on live.
  - If it weren't there, every Monday run would answer 500 `library-read`. It would be loud, not silent, but still wrong.
- **The query:** one read-only line in the SQL editor, SHA-checked before Run as usual:
  ```sql
  select has_table_privilege('service_role', 'public.library_drills', 'SELECT') as svc_select,
         has_column_privilege('service_role', 'public.library_drills', 'published_at', 'SELECT') as svc_published_at;
  ```
  Expect `true / true`. (Service role bypasses RLS, so the published-only policy doesn't matter here.)
- **After deploy:** a `?dry=1` run (curl with the cron secret, which Ashlea runs) shows the line in each department's html, or none in a quiet week. It sends nothing and writes nothing.

## Tests
- **`docs/review/digest_library_line_test.mjs`: 18/18, exit 0.** It bundles the real `api/digest.js` and BASE's against the switchable fake Supabase and counted fetch from `digest_members_decouple_test`. It checks:
  1. a quiet library: body and sends byte-identical to BASE;
  2. the line: exact text, escaping, the right drills excluded, subject unchanged, certs intact, one read with three columns, no writes;
  3. not a flag: nothing flagged plus new drills mails nobody;
  4. a failed read: 500 `library-read`, both admins still mailed without the line, the message logged and not in the body;
  5. the helpers, the rule, and the fences (verified 132/32/14, Notify held).
- **Suite:** 69 files, red counted by exit code. See the hand-back.

## Invariants
- verified counts: App.jsx 132 · digest 32 · assistant 14, unchanged;
- Notify held;
- `api/_cron.js`, `api/pulse.js` and `vercel.json` byte-identical to BASE;
- no RLS, grant or SQL change.

## After gate PASS (on Ashlea's go)
1. Run the read-only live check above.
2. Pin this test's `REV` to the passed sha, then merge and push.
3. Served-verify `version.json`.
4. Optionally, a `?dry=1` digest run.
5. The first real Monday run is the proof: a 200, and the line present if anything was published that week.
