# B4C — E1/E3 Slice U2 (reactions UI) — built, for review. NOT promoted.

**Branch:** `feat/e1e3-u2-ui`, off live `origin/main` `f65886a` (industrial-noir-50). **Client only: `src/App.jsx`, +96 / −0.**
**Depends on:** Slice R, live 2026-10-31. There's no DB change.
**Design:** the Step 0 §3–4 plus `B4C_E1E3_SliceR_DB_ReviewRecord` plus the gate's U2 directive.

## Where it shows
The Training screen has two views (`memberView = !isLeader(role) && !isTrainingOfficer`, unchanged).
- **Plain members (the member view):** a new **"How was training?"** card, between "Where you stand" and "Catch up".
  - It lists the finished sessions they were on the roll for, from the last 30 days, newest first, up to 5.
  - The card's header reads "Anonymous · leaders see totals only".
- **Leaders and training officers (the leader view's session list):** a reactions line under each finished row's date.
  - If you're on that session's roll, you get the vote buttons.
  - If you're a leader (`isLeader` = PA/DA/Board/Officer, the same list as the DB's `is_leader()`), you get the tally.
- **Both views render the same `renderReact(s)` helper.** So the rules below hold in both.

## The vote (someone on the roll)
- **"How was it?"** with 👍 / 👎 and your own vote lit (`aria-pressed`).
- A click → `set_session_reaction({p_session_id, p_value: 1 | -1})`.
- Changing your vote is just the other button. The DB upserts the same row. Clicking the vote you already have sends nothing,
  since there's no clearing (Slice R: ±1 only).
- **Your own votes are read** with `from("training_session_reactions").select("session_id, value")`. The table's only policy
  is own-row SELECT, so it can't return anyone else's.
  - A failed read keeps the last-known votes; it's never treated as "no votes".
- **The window:** open while (today in America/Chicago) − the session's date ≤ 14, which is the RPC's own rule. After that the
  buttons are **disabled**, your vote stays lit, "Your vote", and a quiet **"Voting closed"** shows.
- **The DB stays the authority.** If it says `CLOSED` (the boundary raced past midnight), the row says: **"Voting has closed.
  Votes are open for 14 days after a session — thanks for wanting to weigh in."** No code is shown and no vote is lit.
  - The other refusals (`NOT_PRESENT`, `NOT_FINALIZED`, `CANCELLED`, `NOT_FOUND`, `BAD_VALUE`, `NOT_ALLOWED`) get plain
    titles plus the DB's sentence.
- **Who sees no control:** anyone not on the session's roll, and any upcoming or cancelled session.

## The tally (leadership)
- **ONE batched call:** `session_reaction_tally({p_session_ids: [every finished, non-cancelled session id]})`, sorted.
  - It's re-run only when that id set changes, or after the viewer votes.
  - It never makes per-session calls.
- **What it shows:**
  - **"👍 7 · 👎 1"** for a session the RPC returned;
  - **"Not enough votes yet"** (quiet, italic) for one it was asked about and didn't return. That's the under-3 rule; it's
    **never shown as zero**;
  - **nothing at all** until the read lands, or if it fails (the last-known is kept).
- **No ids, no names:** each reply row is reduced to `{ up, down }` keyed by `session_id`. Nothing else is kept or rendered.
  The test feeds a hostile reply carrying `member_id` and a voter name and proves neither reaches the screen.
- A plain member never calls the tally.

## Calls for the gate
1. **The member card's 30-day / 5-row scope.** Votes close at 14 days. The extra 16 days show recent closed ones (your vote
   lit, disabled) so "Voting closed" is visible rather than the row just vanishing. Easy to trim to 14.
2. **Meetings aren't excluded.** The DB lets anyone on a finished session's roll vote, including an "everyone" meeting. If you
   want trainings only, add `!isMeeting(s)` in the two spots (one line each).
3. **A training officer who is a plain Member** (leader view, but not `is_leader()`) can vote on their rows and sees no tally.
   That's correct per the DB gate, but noting it.

## Tests
- **`docs/review/e1e3_u2_ui_test.mjs`: 38/0.** It drives the real Training screen. Fixtures are dated from today in
  America/Chicago, with no fixed days, and the leader rows navigate months by the header, so month ends are safe.
  - **Member view:**
    - the card lists exactly dv, d14, d15, dc (not dx, which they weren't on, nor upcoming or cancelled);
    - **vote 👍** → `{p_session_id, p_value: 1}` (exactly two args), lit;
    - **change to 👎** → `-1`, lit;
    - a repeat click sends nothing;
    - no tally call.
  - **The window:**
    - **day 14 is open, day 15 is disabled with "Voting closed"**, and a click sends nothing;
    - a closed session I voted on shows "Your vote" with 👍 lit;
    - **the DB's CLOSED is said kindly.**
  - **Leader view:**
    - **not on the roll → no buttons**, only the tally line;
    - upcoming and cancelled sessions have no line.
  - **DA and Officer:**
    - **ONE tally call**, args `{p_session_ids}` only, the 5 finished ids;
    - **"👍 2 · 👎 1" at ≥ 3**, and "👍 7 · 👎 1" on a closed session;
    - **"Not enough votes yet" below 3, never "👍 0"**;
    - **no member id or name on any reactions line** (from the hostile reply).
  - **A DA on the roll:** both the vote and the tally; voting refreshes the tally with one batched call.
  - **A failed tally read shows nothing.**
  - **Source:**
    - **the only new RPC names are Slice R's two;**
    - the tally keeps only session_id/up/down (with no `member_id` in its path);
    - one own-vote table read and no table write;
    - client only vs `f65886a`;
    - verified 132/108;
    - Notify held.
- **The full suite:** **43 files, 1147 PASS, 0 FAIL.** ESLint is clean.
