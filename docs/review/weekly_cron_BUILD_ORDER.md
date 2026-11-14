# Weekly Training Content, slice 7: the weekly cron: build order and hand-back

**Status:** for gate. **Not reviewed, not promoted.** Branch `feat/weekly-drill-cron`, off `b9faa42`.
- `b9faa42` is main `027bed8` (slice 6, "GATE PASS @ 027bed8") plus its tests-only fence pin, which rides this merge.
- **Contains the gated `vercel.json` exception:** one added line. The Step 0 ruling requires Ashlea's explicit go at ship.
- No SQL to apply: slice 4's functions are live (RETEST 15/0/0). No native, package or `api/_cron.js` change.
- Ships to the web on merge. The client flag flip reaches phones in the next native build (see "Native" below).

**Design:** `docs/design/training_content_step0.md` §4 (the digest's "waiting" line), §5.2 (a new endpoint, `0 0-5 * * 1`), §5.3 (the WS-2 gate translated for a cron), §5.4, §5.5 (the seed), §5.6 (honesty), §5.7 (cost). Gate PASS @2a0768c; rulings @4cfe29f (R1 yes; the `vercel.json` exception for slice 7 only: one line, digest and pulse byte-identical, Ashlea's go).

## Files
| File | What |
|---|---|
| `api/weekly-drill.js` (new) | the cron endpoint |
| `shared/weekly-drill.js` (new) | the pure parts: week key, season, category pick, seed, user turn, put arguments |
| `shared/training-due.js` (new) | the due-clock, moved out of `App.jsx`'s `dueInfo` (WD-2) |
| `shared/cron-outcome.js` | + `weeklyDrillOutcome`; `digestOutcome` gains the `weekly-read` step |
| `api/digest.js` | + the "waiting for an officer's review" line |
| `src/App.jsx` | `dueInfo` uses the shared clock; `WEEKLY_DRAFT_RUN_LIVE = true` |
| `vercel.json` | **+1 line:** `{ "path": "/api/weekly-drill", "schedule": "0 0-5 * * 1" }` |
| `docs/review/weekly_cron_test.mjs` (new), plus two older tests adjusted | see Tests |

## What the cron does
**Schedule:** hourly 00:00–05:00 UTC Monday (Sunday 18:00–23:00 Central). That's six chances, finished before the Monday 12:00 UTC digest. Vercel crons don't retry, so the slots are the retry.

**Auth and spend gate (§5.3):**
- `requireCron`, imported; `_cron.js` is untouched. This file never reads the secret.
- **Who:** departments with `weekly_drill_draft_enabled`. The toggle is re-checked again in the DB at write time.
- **Input caps:** `inputProblem`, imported from `api/claude.js`, before any spend.
- **Backstop:** `record_dept_ai_call(dept, 'claude')` before the model, the same 1,500/day ceiling a member meets.
- **Provider call:** `callAnthropic` (slice 6's helper) with `logTag: "api/weekly-drill"`.
- **Reply parser:** `parseDrillPlanReply`, fail-closed and shared with the client.
- **Write:** `put_weekly_drill_draft`, service-role only. It always writes a draft, with source `ai_weekly`, no author, and `ON CONFLICT DO NOTHING`.
- Nothing here can approve. The human-approval trigger refuses a memberless approval (slice 4).

**Each slot:**
1. Read the opted-in departments, then this week's existing drafts. A department that's already done is "exists" and costs nothing more: no seed read, no backstop count, no model call.
2. Seed the rest with one read per table for the whole slot. Only these columns are read:
   - `training_plans(name, cadence, last_iso)`;
   - `training_sessions(title, date)`, last 8 weeks;
   - `drill_plans(title, created_at)`, last 8 weeks;
   - `members(id, access, status)`, for the rounded count only;
   - `departments(id, city)`.

   No names, emails, notes, certs, hours, attendance or addresses are ever read. That is exactly the DA confirm's list.
3. For each department, up to 4 at a time and 12 per slot:
   - check the input caps;
   - count against the backstop;
   - call the model and parse the reply;
   - write the draft.

**The user turn (`composeWeeklyUser`):**
- It covers:
  - "Week of Nov 16, late autumn, Granbury.";
  - the topic: a seasonal drill for the chosen category. The pick goes **overdue first**, using the app's own due rule;
  - "about 20" members, rounded to 5;
  - a fenced, labelled data block holding the category names with their state and the recent titles, as data, not instructions.
- Department text is made one line, capped, and stripped of the fence markers.
- `DRILL_PLAN_SYSTEM` is unchanged.

**Honesty (`weeklyDrillOutcome`):**
- `db` → 503: any read failed, and nothing was spent.
- `gen:<n>` → 500: a provider error, network failure, malformed or array reply, or input refusal.
- `write` → 500: the write errored.
- `cap` → 500: the backstop refused or errored, failing closed, and the model was not called.
- **Not failures:** "disabled" (toggled off at write time), "exists", "deferred", and a slot with nothing to do (200, no model call).
- **Body:** counts and step names only. **Logs:** `[weekly-drill] dept=<id> step=<step> status=<code>`.
- `?dry=1` returns each pending department's composed prompt by id. It spends and writes nothing.

## The digest's line (§4)
- **The line:** "This week's AI-drafted drill is waiting for an officer's review in Training Plans." No title, no content.
- **Who gets it:** only a department that has this week's `ai_weekly` draft still in draft. That's one `drill_plans` read (`department_id` only) per run, keyed by the cron's own `weeklyKeyFor`.
- **Not a flag** (R4's rule): a quiet department is not mailed about it.
- **If the read fails:** the run reports 500 `weekly-read`, and every email still goes, without the line. Same as `library-read`.

## Judgment calls for the gate
- **WD-1, the draft's title.** `DRILL_PLAN_SYSTEM`'s schema has no title, because the client takes it from the officer's topic and a weekly draft has no officer.
  - The prompt stays unchanged (one definition). The **user turn** asks for one extra `"title"` field.
  - A missing or non-string title falls back to "<category> drill — week of Nov 16".
  - The category is the department's own chosen category name. Audience is left empty.
- **WD-2, the due-clock moved to `shared/training-due.js`.** Step 0 §5.5 assumed "the shared due-clock (the Library Step 0's L10 move to `shared/`)", but that move never happened. Copying `dueInfo`'s arithmetic into the cron would break "imported, not copied".
  - So the arithmetic moved, and `dueInfo` keeps its labels and colours.
  - The test runs the OLD and NEW `dueInfo` side by side: **1,810 cases byte-identical** across every cadence, a sweep of dates, one-off, never logged and an unknown cadence.
- **WD-3, `db` covers every read the run needs, not only the departments read.** If the existence check or a seed read fails, the run answers 503 and spends nothing. That means no half-seeded prompt and no paying for a week that may already be done. The next slot retries.
- **WD-4, a backstop RPC error fails closed as `cap`.** The model isn't called when the ceiling can't be checked.
- **WD-5, the week key.** It's the Central date's ISO week, with **Sunday counted as the coming week**, so the Sunday-evening slots and the Monday digest compute the same key. Any other day is its own week. It's tested across ISO 53-week years and both DST changes.
- **WD-6, the "waiting" line keys on the row, not the toggle.** A draft for this week that's still in draft is waiting whether or not the DA has since turned the toggle off. That's the truthful reading. It adds one step name to `digestOutcome`, `weekly-read`, on the `library-read` precedent.
- **WD-7, the per-slot limit is 12 departments, 4 calls at a time.** That keeps a slot well inside the function timeout.
  - Departments over the limit are "deferred" to the next slot, which is not a failure.
  - Only past about 70 opted-in departments could the 05:00 slot leave some without a draft. Today 0 are opted in, and there are 4 pilot departments.
- **WD-8, the `vercel.json` line is inserted first, as a one-line object.** The diff is exactly **+1 / −0**. No existing line changes, not even a comma. The test proves the digest and pulse entries and everything outside `crons` (headers, CSP, rewrites) byte-identical.

## Tests
- **`docs/review/weekly_cron_test.mjs`: 90/90, exit 0.**
  1. The `dueInfo` OLD-vs-NEW differential: 1,810 cases.
  2. The shared rules:
     - the week key: the slots, the digest, mid-week, Saturday, ISO years, DST;
     - seasons and the category pick;
     - the seed: only its fields; caps; de-duplication; the rounded count. Fixtures plant names, emails, notes, an address and the department name, and none reaches the prompt;
     - fence-marker stripping;
     - the capped worst case passes `inputProblem`;
     - the put arguments.
  3. The real handler, with a fake Supabase client and a stubbed provider:
     - auth: no bearer, wrong secret, `?secret=`, no `CRON_SECRET`;
     - a missing env var;
     - none opted in; everyone done (no backstop, no model call); two inserted, in backstop → model → put order;
     - the exact columns read;
     - the provider body equal to `messagesBody({DRILL_PLAN_SYSTEM, user})`;
     - disabled, a racing exists, cap refused, cap error, one department capped;
     - provider error, garbage, array and network replies, each with its log line;
     - the provider detail kept to the log;
     - write error, an unknown write answer;
     - each of the 5 reads failing (503, nothing spent);
     - dry and `dry=0`;
     - the per-slot limit;
     - input caps before any spend.
  4. The digest line:
     - no drafts → byte-identical to BASE;
     - only the department with a draft gets the line, and its email is BASE's plus exactly that block;
     - the one read's filters;
     - not a flag;
     - a failed read → `weekly-read`, emails still sent.
  5. The rules and fences:
     - `pulseOutcome` byte-identical;
     - only this slice's files changed;
     - `_cron.js`, `_anthropic.js`, `claude.js`, `pulse.js`, `_auth.js`, `drill-prompt.js`, `members.js`, sql, native and packages untouched;
     - `vercel.json` +1/−0, with everything else in it byte-identical;
     - the cron imports rather than copies (no `fetch` of its own, no approve, insert, update or delete, no `?to=`);
     - verified 132/32/14, Notify held, `SEND_WHEN_NOTHING_FLAGGED` false.
- **Mutations: 22/22 caught, each by a named assertion.**
  - **In the cron:**
    - the existence check ignored;
    - a backstop refusal ignored; a backstop error treated as allowed;
    - a malformed reply written;
    - names and emails read;
    - the input caps skipped;
    - the dry run spending;
    - the per-run limit ignored;
    - a db failure answering 200;
    - the log tag borrowed from `/api/claude`.
  - **In the shared rules:**
    - Sunday counted as the ending week;
    - the category pick reversed;
    - fence markers not stripped;
    - an exact member count sent;
    - the due-soon window drifting;
    - cap not reported as a failure.
  - **In the digest:**
    - the line sent to every department;
    - approved drafts called waiting;
    - a failed weekly read blocking the emails. At first this was caught only by a crash, so the harness now catches a thrown handler and a named check catches it.
  - **In `vercel.json` and the client:**
    - the schedule widened;
    - the digest entry changed;
    - the client flag not flipped.
- **Older tests adjusted, tests only:**
  - **`anthropic_helper_test`:** its "untouched" checks read the working tree, so they went red on this slice's ruled `vercel.json` and `digest.js` changes. They now read at its released REV `027bed8`. Still 58/58.
  - **`weekly_ui_test`:** the "not started yet" note is now checked against the flag (shown exactly while it's false). Still 38/38.
  - **`l1_cron_secret_test`: unchanged.** Its "no other route reads `CRON_SECRET`" grep matched a comment in the new file, so the comment was reworded. The rule it guards holds.
- **Suite:** 72 files, all exit 0.
- **Build and lint:** both exit 0. The build used placeholder env vars only, as a compile check.

## Invariants
- verified: App.jsx 132 · digest 32 · assistant 14, unchanged;
- Notify held;
- `api/_cron.js` untouched;
- `vercel.json`: the one ruled line, nothing else;
- no SQL, RLS or grant change;
- officer approval stays a DB law (nothing here approves);
- provenance: `ai_weekly`, no author.

## Open items for the gate and Ashlea
- **The service-role check on the live key.** `put_weekly_drill_draft` and `record_dept_ai_call` require `auth.role() = 'service_role'`. The server key is `sb_secret_`, which Supabase maps to the service_role role, but no test here can prove the live mapping.
  - **Today 0 departments are opted in,** so Sunday's first run will answer 200 "nobody opted in", with no spend and no RPC.
  - The RPCs first run when a DA turns the toggle on. A deliberate first proof: Ashlea turns it on for one pilot department, then (on her go) one manual run, or the next Sunday's slots. Then check the draft lands as "Drafted by B4C's weekly AI".
- **Pricing.** Step 0 §5.7 asked for current pricing to be re-checked before this slice ships. I haven't checked it. The model is the one pinned in `api/_anthropic.js`. At most 6 attempts per department per week, and 1 when the first succeeds.
- **Native.** Phones keep showing "B4C's weekly run hasn't started yet" until the next native build carries the flipped flag. That's harmless (the switch works and the cron covers them), but the note is stale until then.

## After gate PASS (on Ashlea's explicit go, which the `vercel.json` ruling requires, with the PASS sha quoted verbatim from the relayed message)
1. Pin this test's `REV` to the passed sha, then merge to main and push.
2. Served-verify `version.json`. Check the deployment lists the new cron in Vercel (Settings → Cron Jobs).
3. Optional: a `?dry=1` call (CRON_SECRET bearer) shows 0 pending, since none are opted in yet.
4. After the first Sunday with a department opted in: the Monday digest shows the "waiting" line for it, and Training Plans shows the draft labelled "Drafted by B4C's weekly AI".
