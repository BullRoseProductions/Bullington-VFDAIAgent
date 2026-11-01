# B4C — Signup closure (H-2) Slice 1: the invite endpoint + client migration — DRAFT. NOT deployed.

**Branch:** `feat/signup-invite`, off live main `f10383f` (industrial-noir-55). Built to the Step 0 (`a9a94e8`) with Ashlea's
four rulings.
**Changed:**
- `api/invite.js` (new);
- `src/authLinks.js`, `src/Login.jsx`, `src/App.jsx` (the three admin sites + one dead import);
- `docs/review/signup_invite_test.mjs`, this note.

**Unchanged:** `api/_auth.js` / `_cors.js` / `_cron.js`, `vercel.json` (the enforced CSP already admits same-origin
`/api/invite`), no SQL, no dashboard change.

## api/invite.js
POST `{ email }` with the caller's Bearer token. CORS uses the AI routes' allowlist, which includes the native origins.

1. **`requireMember`** (WS-2): the token is checked with the anon key, and the caller must be an Active or Probationary member
   of their active department → 401 / 403 / 503.
2. **Authorization, as the caller** (their JWT; the same functions and RLS as the app):
   - **DA path:** `is_dept_admin()` **and** the address is on the roster. The roster read is
     `members.eq(department_id, my_department_id()).ilike(email)`, with the ilike `%`/`_` escaped and an exact compare after
     normalizing. It goes through the "leaders read members base table" RLS, so it can only ever be the caller's own
     department.
   - **PA path:** `is_project_admin()` **and** the address is an `admin_email` in `pa_department_radar()` (DAs only).
   - **Not an admin** → 403 `not-authorized`. **An admin, but the address isn't on the roster / isn't a DA** → 404
     `not-on-roster`. **A check that can't run** → 503 `authorize`.
   - The department is **never** read from the request.
3. **Only then** the service client (`SUPABASE_SERVICE_ROLE_KEY`, the `sb_secret_` value):
   `auth.admin.inviteUserByEmail(email, { redirectTo: APP_ORIGIN })`.
   - `APP_ORIGIN = VITE_APP_URL || "https://app.b4thecall.com"`, never the request's Origin.
   - → 200 `{ ok:true, sent:"invite" }`.
4. **`email_exists`** (current code, or the older "already been registered" message) → a Supabase-sent sign-in link from an
   **anon** client: `signInWithOtp({ shouldCreateUser:false, emailRedirectTo: APP_ORIGIN })` → 200 `sent:"login-link"`. That
   call can't create an account.
5. **Failures:** `{ ok:false, failed:[step] }`, with steps `email` 400, `rate-limit` 429, `config` 500, `invite` /
   `login-link` 502.
   - The detail goes to `console.error("[invite] FAILED <step>: …")`: Supabase's status, code and message, the caller's member
     id, and the target address **as `*@domain` only**.
   - The key is never in a body or a log.

## The client
- **A, add member** (`App.jsx` `add()`): after the row insert, `sendInvite(email)`.
  - Success still reads "Member added & invited".
  - Failure still reads "Member added — login link didn't send", now carrying the real reason and "Try again from their file
    with Resend". The old advice "They can request one at sign-in" is dropped, because it isn't true for a brand-new person
    after the flip.
- **B, a new department's DA** (PA): `sendInvite(created.adminEmail)` takes the PA path, since `pa_create_department` has
  just written that DA's row. The toasts are unchanged.
- **C, `ResendLink`** (a DA in a member's file; a PA on the department list): `sendInvite(email)`. The confirmation and the
  shared cooldown are unchanged.
- **`authLinks.sendInvite`:**
  - returns the same `{ error }` shape the Supabase call did, so every caller's toasts stay as they were;
  - maps step names to honest words: not on your roster / only a Department Admin / the hourly email limit / "the invite
    service couldn't send it just now (step)" / couldn't reach the service / session expired;
  - passes `requireMember`'s own sentence through.
- **D, the sign-in screen** (`Login.jsx`): `sendLoginLink` now passes **`shouldCreateUser: false`**.
  - An unknown address is refused by Supabase (`otp_disabled`, "Signups not allowed for otp") **whether signups are on or
    off**, and the screen says **"No account yet — ask your department admin to add you."**
  - So it behaves the same **before and after** the dashboard flip, and it stops self-signup through the app immediately on
    deploy.
  - Existing accounts get their link as before.
  - The pending-QR redirect is kept.

## Tests: `docs/review/signup_invite_test.mjs`, 48/0
- **The endpoint** (bundled against a recording fake supabase-js):
  - **Refusals, with no service client built and nothing sent:**
    - no token 401;
    - not a member 403;
    - **non-DA/PA 403**;
    - **DA, address not on their roster 404**; on another department's roster 404, even with `department_id` in the body;
    - `a_b@` vs `axb@` 404;
    - **PA, non-DA address 404**;
    - radar error 503.
  - **DA and PA happy paths** each call `inviteUserByEmail` once, with the service key and `{ redirectTo: APP_ORIGIN }`,
    after the as-caller checks.
  - **Existing account** → the sign-in link with `shouldCreateUser:false` on the anon key; no createUser, signUp or second
    invite.
  - 429 / 502 / 500 bodies are terse; the log has the detail but no full address and no key; 400 / 405 / CORS preflight.
- **The client:**
  - `sendLoginLink` sends `shouldCreateUser:false`;
  - every `sendInvite` mapping;
  - **D in the real `Login.jsx`** (happy-dom): an unknown address shows the ruling's sentence, and the only auth call made was
    `signInWithOtp` with `shouldCreateUser:false` (nothing that creates). An existing account still gets "Sent — check your
    email".
- **Source / fences:**
  - no `signInWithOtp` left in `App.jsx`;
  - A / B / C call `sendInvite`;
  - only the files above changed; no SQL;
  - `_auth` / `_cors` / `_cron` / `vercel.json` untouched;
  - verified 132/32/14; Notify held.

## After the gate (not in this slice)
1. **Promote, then served-verify:**
   - `/api/invite` without a token → 401;
   - a DA inviting a test address on a test department's roster → the email arrives, the link lands, and the set-password gate
     shows;
   - Resend to an existing account → a sign-in link;
   - the sign-in screen with an unknown address → the sentence.
   - Also confirm whether `inviteUserByEmail` re-sends to one of the 20 **unconfirmed** accounts or answers `email_exists`.
     Either way the endpoint handles it.
2. **Build 18** carries this to native.
3. **Ashlea's dashboard flip:** only after build 18 is rolled out.
