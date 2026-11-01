# B4C — Memberless logins: neutral sample brand + a "not attached yet" screen — DRAFT (web only). NOT deployed.

**Branch:** `feat/memberless-screen`, off live main `7b44c65` (industrial-noir-56).
**Changed:** `src/App.jsx` only, plus `docs/review/memberless_screen_test.mjs` and this note. No SQL, no api/, no native,
no `vercel.json`.

## 1. DEFAULT_BRAND → a clearly-sample identity
**Grep first** (`git grep -i "North Hood Country|Neighbors helping neighbors|Station 20"`):
- **The two exact old strings** ("North Hood Country VFD", "Neighbors helping neighbors.") appeared **only** in
  `DEFAULT_BRAND` (`src/App.jsx`). No test, snapshot or doc keyed off them.
- **"Station 20"** also appears as **example placeholders**:
  - `App.jsx:548`: "e.g. Station 20";
  - the event form: "e.g. Pancake breakfast at Station 20" / "e.g. Station 20 bay";
  - the Graphics details: "e.g. Sat Nov 8 · 7–11am · Station 20 · $8 plates".
- Elsewhere: `event_details_ui_test`'s fixture "Station 20 bay", old `docs/review/*.patch` files, and two SQL comments
  recording real history.
- **None of these were changed** (one-constant rule). Whether the placeholders should drop "20" is a gate call. They're
  inputs' hint text, not an identity.

**The constant** (same shape; colours and font unchanged):
- name **"Sample Fire Department"**, station **"Station 1"**;
- tagline "Serving our community.";
- voice "Warm, clear and plain-spoken — proud of our members, never boastful."

**⚑ Blast radius, measured read-only.** `DEFAULT_BRAND` isn't only the Graphics sample. It's App's initial `brand` and the
**per-column fallback** in `setBrand` (`App.jsx` ~2541) for any department column that's NULL.
- Live: **4 of the 5 departments have NULL `tagline` and NULL `voice`**; no NULL station, primary or font.
- So those 4 have been showing North Hood County's tagline and writing their recruitment / visibility drafts in its voice. After
  this, they get the generic sample tagline and voice until a DA fills in their Brand Kit.
- That's the leak this closes, but it's a visible change for them.

## 2. The memberless state
- **Before:** an account with **no members row** landed in the empty app shell. That's the 28 self-signups, and anyone whose
  row is removed.
- **How "confirmed empty" is decided:** the identity effect's existing lookup (`members … ilike(email) .single()`) is
  **unchanged**. `.single()` reports zero rows as an **error** (PostgREST `PGRST116`), the same channel as a network failure,
  so on any non-row result it asks once more:
  ```js
  supabase.from("members").select("id", { count: "exact", head: true }).ilike("email", authEmail)
  ```
  **Only `!error && count === 0`** sets `memberless`.
  - An error on that read keeps today's behavior exactly.
  - So does one email on several rows (count ≥ 2, which `.single()` also refuses).
  - It resets on every auth change; a reload re-asks.
- **Why the count can be trusted:** own-row RLS is `email = auth.email()`, which is case-sensitive.
  - Read-only check: **0** members emails aren't lowercase-trimmed, **0** differ from their login exactly, and **0** login
    emails aren't lowercase.
  - So a real member can't look memberless through case today. App and imports lowercase on write.
- **The screen** (`NotAttached`, after every hook, before the shell): the login-screen card style (`AUTH`), with the B4C mark,
  then:
  - *"You're signed in, but you're not attached to a department yet. Ask your department admin to add you to the roster —
    they'll use this same email."*
  - "Signed in as **<email>**";
  - **Sign out**: the same handler as the sidebar's (unregister push, then `signOut`).
  - Nothing else: no nav, no links, no data.
- **Not added:** a "check again" button. A reload re-runs the lookup and a newly added row gets the normal app (tested). Say
  if you want the button.

## Tests: `docs/review/memberless_screen_test.mjs`, 19/0
The **real `App`** is rendered whole in happy-dom against a fake client that sets the two identity reads per case.
1. **A member:** the shell, and the confirming count never runs.
2. **Confirmed empty:**
   - the screen with the exact sentence and the email;
   - exactly one control, Sign out, which calls `signOut`;
   - no shell or nav.
3. **Read error (both reads fail):** the shell, not the screen. Likewise `.single()` refusing with the count erroring, and one
   email on two rows.
4. **A row appearing on reload:** the app.
5. **`DEFAULT_BRAND`:** it's the sample, with the same keys. None of the five live departments' names, nor "Station 20" / the
   old tagline, appear in it, and the old strings are gone from the code.
6. **Fences:** only `src/App.jsx` (+ test, note); no SQL / api / native / `vercel.json` / `Login.jsx` / `main.jsx`; verified
   132/32/14; Notify held.
