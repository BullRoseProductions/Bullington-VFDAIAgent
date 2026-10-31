# B4C — E1/E3 Slice U1 (training time UI) — built, for review. NOT promoted.

> **Amended (T2):** Ashlea ruled on flag 1 of `B4C_E1E3_U1_UI_ReviewRecord` — at finalize the actual times replace a
> pre-finalize (estimated) length. The DB side is **T2** (`feat/e1e3-t2-db` @ `5045fad`, a draft; it applies on Ashlea's go).
> **U1 promotes after T2 is live.**
> - **Dropped:** the client's "This drill already has a length" pre-catch. A plan-scheduled drill now finalizes with times
>   straight through the times overload.
> - **Added:** the lock confirm's window line says "· replaces the 2 hrs set before it ran" when it does. The DB logs
>   duration_min old → new.
> - **Rebased:** onto live `origin/main`, which is still `1fc6059` (no-op).
> - **Results:** test **46/0**; suite **42 files, 1109 PASS, 0 FAIL**; verified 132/108; Notify held.
> - **Until T2 is live, don't promote U1.** On today's DB that finalize gets USE_CORRECT, then LOCKED_SESSION. It surfaces
>   via the existing notify, but the drill wouldn't finalize with times.

**Branch:** `feat/e1e3-u1-ui`, off live `origin/main` `1fc6059`. **Client only: `src/App.jsx`.**
**Depends on:** Slice T, live 2026-10-30 (and R, live 2026-10-31, which U1 doesn't touch).
**Design:** the Step 0 §4 (`claude/B4C_E1E3_TrainingTime_Reactions_Step0.md`) plus the gate's U1 directive.

## What changed
- **E1 relabel** (same field, same `p_duration_min`):
  - the plan builder's "Duration" → **"Estimated length"**;
  - the plan editor's "Duration (minutes)" → **"Estimated length (minutes)"**;
  - its error toast reads the same way.
  - The plan card's meta ("· 2 hrs") is **left as is**; see the calls below.
- **Finalize:** the close-out panel (Complete → the roll → "Finalize & lock attendance") gains an **Actual time** block.
  - **Start** is pre-filled from the scheduled time, then **End** and **Setup (min, optional)**.
  - A live preview reads **"7:00–10:26 PM · 3h 26m"**, or past midnight **"10:00 PM–1:30 AM (next day) · 3h 30m"**.
  - **An End (or a setup time) typed →** `finalize_training_session({p_session_id, p_actual_start, p_actual_end,
    p_setup_min})`, the times overload.
    - It sends exactly that argument set, with `p_setup_min: null` when blank, and never a length: the DB derives it.
    - The one lock confirm's Length tile shows the span, and a line under it shows the window and setup.
  - **Nothing typed** (Start is only the pre-filled schedule) → **exactly today's path**: the length prompt when
    there's no length, then `{p_session_id, p_duration_min}`.
  - **"I only know the length"** swaps the times for the minutes box (or "Length X is already recorded"). It sends the
    old shape with no prompt when a length is typed, and the prompt when it's blank.
  - **Friendly checks before any dialog or call**, mirroring the DB:
    - both times or neither;
    - whole minutes;
    - end ≠ start;
    - setup is whole minutes 0–600;
    - setup without times;
    - ~~a different length already recorded~~: **removed in the T2 amendment**. The span replaces it server-side.
  - The DB stays the authority: any refusal still surfaces through the existing `s6Err` notify.
- **Past session** (the roll's summary line), for a session **with** times:
  - **Estimated ~2 hrs** (the attached plan) · **Actual 7:00–10:26 PM · 3h 26m** · **Setup 20 min**, side by side.
  - Estimated and Setup appear only when present.
  - **A length-only session shows exactly what it showed** ("Length 2.0 hrs").
- **Correct:**
  - **Actual start**, **Actual end** and **Setup (min, optional)**, pre-filled, with the preview "… — the length
    follows the times".
  - The diff sends only the changed keys (`actual_start` / `actual_end` / `setup_min`). Clearing both sends nulls, which
    gives a length-only session, and the DB keeps the length.
  - Client checks: both or neither, end ≠ start, setup 0–600.
  - **The DB's "length comes from the times" refusal** (BAD_VALUE, when a length is typed over the times) is shown as
    **"The length comes from the actual times. This session has an actual start and end, so its length is worked out
    from them (3h 26m). To change the length, change the start or end — or clear both times to type a length."**
  - The corrections log labels the new fields "Actual start / Actual end / Setup (min)", with times as clock times.
- **Reads:** `loadSessions` also selects `actual_start, actual_end, setup_min`. Those are Slice T's columns, already
  live and readable under the same policy.

## Calls for the gate
1. **[RESOLVED by T2.]** **⚑ A drill that already has a length can't be finalized with different times.** The DB answers `USE_CORRECT`,
   which is Slice T's addendum ruling.
   - **This will be common.** "Schedule with this plan" pre-fills the session's **Length** from the plan's estimate
     (`schedulePrefill → sDur`). So those sessions carry the *estimate* in `duration_min` before they run.
   - U1 catches it first, in plain words: *"This drill already has a length. 2 hrs is recorded for it (set before it
     ran), and 7:00–10:26 PM is 3h 26m. Finalize with 'I only know the length', then enter the actual times with
     Correct — the length follows the times."*
   - Times that match the recorded length go straight through.
   - **The clean fix is not client-only.** Either:
     - a DB follow-up letting the times finalize replace a not-yet-finalized length (it's an estimate until finalize);
       or
     - stop pre-filling the session Length from the plan, which is a client change, but the plan-scheduled sessions
       already in the DB keep theirs.
   - Your call; nothing here forecloses either.
2. **"Estimated" comes from the attached plan's text**: the `Total time: N min` line that both the server attach
   (`attach_drill_plan_to_session`) and the client serializer write. That means no new read. A session with no attached
   plan, or a plan with no length, shows no Estimated.
3. **The plan card meta is not changed to "est. 2 hrs".** `ai_drafting_sliceB_test` asserts the meta string, and the
   directive says relabel only. It's a one-word change if you want it.
4. **An End typed means "finalize with times".** Start alone (the pre-fill) doesn't count, so the untouched panel is
   byte-for-byte today's finalize. This is what keeps every existing finalize test green unchanged.

## Tests
- **`docs/review/e1e3_u1_ui_test.mjs`: 44/0.** It bundles the real `src/App.jsx` and drives the real Training screen.
  - **The preview:**
    - 19:00–22:26 = 3h 26m;
    - **22:00–01:30 = 10:00 PM–1:30 AM (next day) · 3h 30m**;
    - across noon;
    - under an hour.
  - **Finalize with times:** the exact 4-key argument set, past midnight included, and no prompt.
  - **The client checks:** 6 refusals, nothing sent.
  - **The recorded-length case:** refused in plain words; matching times pass.
  - **The fallback:** prompt → `{p_session_id, p_duration_min: 45}`; typed 90; a bad length; an already-recorded length
    → `p_duration_min: null`.
  - **The past-session view:** Estimated · Actual · Setup; past midnight; **a length-only session unchanged**.
  - **Correct:**
    - prefill + preview;
    - `{actual_end: "23:00"}` only;
    - **the BAD_VALUE refusal in plain words**;
    - 3 client refusals;
    - clearing both times;
    - **a length-only correction unchanged** (`{duration_min: 90}`);
    - the log labels.
  - **E1 and the fences:**
    - the E1 labels;
    - only `src/App.jsx` vs `1fc6059`;
    - no new RPC name;
    - verified 132/108;
    - Notify held.
- **Existing tests, unchanged and green:** `training_slice6_ui_test` (41), `training_nolength_onetap_test` (23),
  `training_slice7_ui_test` (50), `ai_drafting_sliceB_test`.
- **The full suite:** **42 files, 1107 PASS, 0 FAIL.** ESLint is clean.
- **Invariants:**
  - no SQL, `api/`, `shared/` or `vercel.json` change;
  - verified 132 case-insensitive / 108 raw;
  - `api/notify-session.js` absent.
