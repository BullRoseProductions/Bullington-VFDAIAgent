# Ask B4C — Phase 1 review record

**Verdict: PASS for both files.** Reviewed 2026-10-16 by Claude via Ashlea, and checked against the code rather than the build report.

| File | Commit |
|---|---|
| `api/assistant.js` | `7ded2df`, plus the panel fix `09a28db` |
| `sql/assistant_usage_DRAFT.sql` and its RETEST | `ad0c4f2` |

## Verified

**Reads stay with the member.** Each request builds its own Supabase client from the caller's JWT, and every tool read goes through that client. There is no service-role key anywhere in the file.

**No tool can be pointed at someone else.**
- No tool's input schema takes a member or department id.
- The member and department are resolved on the server, from the self-scoped `my_member_id()` and `my_department_id()` RPCs.

**The usage meter runs first, and fails safe.**
- `record_assistant_turn()` is called before the model.
- If the RPC errors, the endpoint returns a 503 and never calls the model.
- At the monthly limit, it returns a friendly message and never calls the model.

**Phase 1 writes nothing except that meter.** `verified` is read to compute credited hours and is never written.

**The tool reads match the read catalogue one to one.**

**The SQL repeats the `image_gen_usage` pattern.**
- The table is locked.
- The RPC takes no arguments, so it can only touch the caller's own department row.
- Each increment is atomic, and a denied turn does not count.
- Post-conditions check that the change did nothing it shouldn't.
- RETEST dry run: 13 passed, 0 failed, 0 skipped. Every deliberately broken version was caught.

## Departure from the build order — signed off by Ashlea as a conscious choice

**What changed:** above 60k characters, `search_sops` sends the best-matching passages (up to 24k characters) instead of the whole library.

**The trade-off:** on a large library it can miss a relevant section. That costs recall, not safety.

**Why it's still safe:**
- When nothing matches, the tool returns `found:false`, which tells the model to answer as general guidance and say so.
- The system prompt forbids inventing department protocols.

Station Q&A still reads the full library and remains the deeper SOP tool. Embedding-based retrieval is a possible v1.1.

## Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Monthly limit | **500 turns per department per month**, confirmed. Raise later through a reviewed `CREATE OR REPLACE`. |
| 2 | Where to test | **Preview first.** Ashlea adds the keys to Vercel Preview. Do not promote and then test on production. |
| 3 | Placement | The reviewer recommends **also adding a persistent nav entry**. **Ashlea's call — still open.** |
| 4 | Scope | Read, SOPs and navigation only. Clock-in and clock-out stay in Phase 2. |

## Minor polish

`reports` and `minutes` are now refused **on the server** for a plain member. The model gets "for department leadership" and nothing navigates. The client still checks the nav as well.

The end-to-end test now covers this: 15 of 15 pass.

## ⛔ Gate before promoting

The model has never been called — all tests use fake stand-ins. Do not promote an AI feature that has never produced a real answer.

- [ ] Ashlea adds `ANTHROPIC_API_KEY`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` to Vercel **Preview**.
- [x] Applied `sql/assistant_usage_2026-10-16.sql` (2026-10-16; state check clean, 157 policies unchanged). RETEST on live: 31 passed, 0 failed, 0 skipped.
- [ ] On the signed-in preview, viewing as a member, ask real questions and check that each answer is correct and shows its grounding:
  - my hours this month
  - which certs are expiring
  - my next drill
  - an SOP question
  - "open my hours"
- [ ] Promote. Notify crew stays held; rollback is `6cf154f`.

## Promoted 2026-10-16 as `c8acbe7` ("Release industrial-noir-9")

Promoted by **Ashlea's decision**, which deviates from the gate above: it went to production without first being tested on Preview. Notify crew is still held back: `/api/notify-session` returns 404, and `/api/assistant` with no session returns 401. **Rollback = `6cf154f`.**

### The five real questions, on production as Ashlea

Each answer was checked against her records, read independently in the same session.

| # | Question | Her records | Answer | Source tag |
|---|---|---|---|---|
| 1 | Hours this month | 1 shift, unconfirmed; 0.0 credited | **Correct.** 0.0 credited, 1 shift not yet confirmed | "From your records · hours" ✓ |
| 2 | Expiring certs | No certs, none pending | **Correct** | "From your records · certs" ✓ |
| 3 | Next drill | Fire Training Week 4, Thu Oct 22, 7:00 PM | **Correct** (calls it "mandatory" — see below) | "From your records · schedule" ✓ |
| 4 | SOP: how often to inspect PPE | VFIS PPE checklist: upon issuance and after each use | **Correct.** Cites the document and quotes NFPA 1851 | **"General guidance" ✗** — should have been "From your SOPs" |
| 5 | "open my hours" | — | **Correct.** Opened Station Hours | — |

No answer was wrong and nothing errored, so the rollback condition was not met.

### Defects found

1. **Wrong source tag on #4.** The answer named the document without its `.pdf` extension and trailing token, and the tag check compares names exactly. Station Q&A uses the same exact match, so it has the same flaw.
2. **Markdown shows as raw asterisks.** The model writes `**bold**` and the panel prints it literally.
3. **"Mandatory" is an overstatement.** The record only says the drill counts toward attendance.

### Fix — prepared on the branch, NOT deployed

Diff: `docs/review/ask_b4c_cite_fix_DIFF.patch`

- **`citedDocs()`** matches document names regardless of case, file extension, and `_` / `-` / `.`. It also accepts a name with its trailing number token dropped, but only when what remains is at least 12 characters.
- **System prompt** now asks for plain text with no markdown, and says to report only what the record says ("counts toward attendance", not "mandatory").
- **Tests:** helpers 17/17 (4 new citation tests), end-to-end 15/15.

## Fix shipped 2026-10-16 as `574aef8` ("Release industrial-noir-10")

Shipped before the announcement, at Ashlea's direction. This was a server-only change and had no separate review.

Re-checked on production, as Ashlea:

| # | Question | Result |
|---|---|---|
| 4 | SOP: how often to inspect PPE | **Correct.** Now tagged **"From your SOPs · Document_308_VFIS-PPERoutineInspectionChecklist_02021.pdf"**. Plain text, no raw `**`. |
| 3 | Next drill | **Correct.** Fire Training Week 4, Thu Oct 22, 7:00 PM. Tagged "From your records · schedule". The answer no longer says "mandatory". |

**Rollback:** `c8acbe7` restores the previous Ask B4C. `6cf154f` removes Ask B4C entirely.

## Clear-on-close (`d9d3036`) — review PASS (2026-10-16)

Diff: `docs/review/ask_b4c_clear_on_close_DIFF.patch`. Client-only; the gate count is flat.

The reviewer confirmed:
- `forgetSavedAsk()` drops only the `ask` part of the saved place. The auto-update machinery is untouched.
- `closeAsk()` and the `askGen` guard clear the conversation and drop late answers. `endAppRequest` still runs in `finally`.
- Open-panel persistence is intact.
- The sign-out wipe is intact.

**Preview tests:**
- Closing with ✕, Esc or the handle gives a blank panel on the next open.
- A late answer arriving after close is dropped.
- A refresh while the panel is open restores the chat and the draft.
- Closing removes the chat from any saved place.

**Live on production 2026-10-16** as `541df2f` ("Release industrial-noir-11"). Notify crew is still held back (`/api/notify-session` returns 404). Rollback is `574aef8`.
