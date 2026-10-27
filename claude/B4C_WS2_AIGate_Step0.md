# B4C — WS-2 Step 0: lock the AI routes to real members (H-1) without breaking invites

**CC, 2026-10-27. READ-ONLY — no code, no SQL applied.** For Claude's review. The build follows the rulings.

- **Directive:** [[B4C_ReviewFixes_Wave1_Directives]] (WS-2).
- **Source finding:** H-1 in `claude/B4C_CC_Security_Audit.md`.
- **Evidence:** main @ `99a15b0` (`api/*.js`, `src/`); live read `docs/review/ws2_STEP0_sizes.sql` → `_OUTPUT.json` (lengths and counts only); function bodies from the regenerated live `schema.sql` (audit branch).

## 1. The four routes today

| Route | Auth today | Membership check | Spend ceiling | Input caps | What a non-member gets |
|---|---|---|---|---|---|
| `/api/claude` (`claude.js`) | `requireUser` (valid JWT) | **none** | **none** | **none**: caller-chosen `system` (string or array) + `messages` (any length/count); fixed `max_tokens 2000` | **a working Sonnet proxy** |
| `/api/concepts` (`concepts.js`) | `requireUser` | **none** | **none** | clipped: purpose 200 · occasion 300 · details 1200 · brand fields ≤ 400; count ≤ 6 | **works** |
| `/api/assistant` (`assistant.js`) | `requireUser` | **yes, indirectly:** `record_assistant_turn()` raises unless `my_department_id()` and `my_member_id()` are non-null | **500 turns / department / month** (`record_assistant_turn`, Chicago month) | history ≤ `MAX_HISTORY` turns, each ≤ `MAX_TURN_CHARS` | **503** "couldn't start" (should be a 403) |
| `/api/image` (`image.js`) | `requireUser` | **yes, indirectly:** `record_image_generation()`, same check | **500 images / department / month** | prompt ≤ 1800; quality/size allowlists | **503** (should be 403) |

**So the real hole is `claude` + `concepts`.** `assistant` and `image` are already effectively gated, just by the ceiling function's exception, and report it as a 503.

- Live usage this month: assistant **17 + 1** turns (two departments); image **9** (one department).
- The 500/month ceilings are far above real use.

## 2. How accounts are created, and why a membership gate is safe for invites

- **Supabase:** "Allow new users to sign up" is ON. `signInWithOtp` creates an auth user for any email it's given.
- **Three client paths call it:**

| Path | Who | Member row exists first? |
|---|---|---|
| `src/authLinks.js:42` `sendLoginLink` ← **Login screen** (`Login.jsx`) | **anyone** | **no** — this is the open door |
| `src/authLinks.js:42` ← `ResendLink` (`App.jsx:27566`), from a **member's file** (DA) or the PA department list | DA / PA | **yes** — the link is sent *from* the member row |
| `App.jsx:26927` `sendLink` after `pa_create_department(p_admin_email …)` | PA | **yes** — the RPC creates the admin's member row first |

- **Every legitimate invite creates the `members` row before the account exists.** On first sign-in, `my_member_id()` resolves the account by `lower(email)`, with status Active/Probationary, in `my_department_id()`. That's the same resolution all RLS already depends on.
- **A membership gate therefore cannot lock out an invited member:** if they can see their department's data at all, they pass the gate.
- **Live:** **115 auth users; 28 have no `members` row at all, and 36 have no *active* one.**
  - The 28 are exactly who the gate shuts out: strays, removed members, typos, or self-sign-ups.
  - I didn't identify them (counts only). Reviewing or pruning them is a separate decision (D-5).

## 3. Proposed build

### 3a · The gate: `requireMember` in `api/_auth.js` (API-only, no DB)
1. `requireUser` as today (it validates the JWT with `getUser`).
2. With an **anon-key client carrying the caller's JWT** (exactly how `assistant.js` / `image.js` already do it), call `rpc('my_member_id')` and `rpc('my_department_id')`. **No service role.**
3. If either is null → **403** "Your login isn't linked to an active member of a department — ask your Department Admin." Otherwise it returns `{ user, memberId, deptId, sb }`.

- **Apply to all four routes.** `assistant` and `image` then get an honest 403 instead of a 503, and can drop their own repeated client set-up. Their ceiling functions keep their own member check as a second layer.
- **Cost:** two extra RPC round-trips per AI call, in parallel, ~30–60 ms against a multi-second model call.
- **What doesn't change:** CORS, method checks, response shapes on success, every client caller. The client already sends the Bearer token through `authedFetch`.
- **Inactive / terminated members lose AI**, the same moment they lose everything else (RLS). I believe that's intended (D-1).

### 3b · The per-user/day cap on `claude` + `concepts` — **needs a small DB slice** (deviation from "no DB expected")
- A cap has to be counted somewhere durable and shared. Vercel functions are multi-instance and stateless, so an in-memory or module-scope counter would reset per instance and is **not a real cap**.
- The existing pattern is a **counted, atomic, definer function called as the caller** (`record_assistant_turn`). Mirroring it is the smallest correct thing:
  - **Table** `ai_call_usage (member_id, department_id, day date, route text, count int ≥ 0, updated_at)`:
    - PK `(member_id, day, route)`;
    - RLS on, **no policies**, **no anon/authenticated grants** (like `assistant_usage`).
  - **Function** `record_ai_call(p_route text) → jsonb {allowed, used, ceiling}`. It is SECURITY DEFINER, `search_path=public`, REVOKE anon/PUBLIC, GRANT authenticated, and works like this:
    - it requires `my_member_id()`;
    - the route must be in an allowlist (`claude`, `concepts`);
    - "day" is the **Chicago** calendar day, matching the other ceilings (F-3 notwithstanding);
    - it does an atomic `INSERT … ON CONFLICT DO UPDATE … WHERE count < ceiling`, the same pattern as the existing ceilings;
    - anything other than `allowed:true` **fails safe**: the model isn't called, and the caller gets a 429 with `used` / `ceiling`.
- **Proposed ceilings (ruling D-2):**
  - **`claude` 150/member/day.** The busiest legitimate pattern is Station Q&A, plus the cert tutor chat (several calls per question), plus the planners and drafts.
  - **`concepts` 30/member/day.** Each call returns up to 6 concepts.
  - Plus a department/day backstop of **1,500** on `claude`, so a compromised leader account can't run up the bill unchecked.
  - No live per-call telemetry exists, so these are deliberately generous. They're constants in the function, raised by a one-line migration.
- **"Align" `assistant` / `image` (D-3):** they keep their **500 / department / month**, which is sound for spend. Option: also route them through `record_ai_call` with per-member/day caps (assistant 60, image 20), so one person can't burn the department's month. CC's recommendation is yes, since it's the same function and two more routes.
- **Full DB discipline:** pinned md5s for `my_member_id` / `my_department_id` / both existing ceilings; PGlite dry run; SENTINEL RETEST (member under cap ✓ · over cap 429 · non-member refused · anon can't execute · the table unreadable by authenticated); `verified` untouched.

### 3c · Input caps on `/api/claude` (sized to real usage)
- **`system`:** Station Q&A stuffs every SOP into it, and the client caps that at **300,000** chars (`App.jsx:5590`).
  - Live, Indian Harbor's SOP text is **307,617** chars, so it already sits at the client cap (2 documents, the largest 161,901). North Hood is 63,420; Lipan 77,365.
  - **Cap: 310,000 chars** (string, or the total of text blocks if an array). That's above the client cap plus framing, so Station Q&A is unaffected; anything larger is not a real caller.
- **`user` (single-shot):** the plan import sends a **whole saved or pasted plan** (`extractFromDoc`, `App.jsx:8659`), and Minutes attaches agendas. **Cap: 120,000 chars.**
- **`messages`:** ≤ **40 turns**, each ≤ **20,000** chars, roles `user`/`assistant` only, string content only, ending on `user`. That's the `assistant.js` validation, reused.
- **Over a cap → 413** with a plain message. The current behaviour (silently passing anything) goes.
- `max_tokens` stays **2000**. The model stays as is; it's out of scope.
- These caps bound **cost per call** (≈ the Station Q&A ceiling); 3b bounds **calls per day**.

### 3d · Small things in the same files
- Stop echoing the provider's raw `error.message` (L-5): `claude.js:42` and `concepts.js:73` return a generic message and log the detail server-side.
- No change to `pulse` / `digest` / `expiration-reminders`. They're secret- or caller-scoped and out of this slice (L-1 is queued separately).

## 4. Public sign-up — flagged, NOT changed in this slice (D-4)
- **Closing sign-up today would break every invite.** All three paths rely on `signInWithOtp` auto-creating the account.
- To close it later:
  1. Add a server route (`/api/invite`) that a DA/PA calls with a member id. It verifies the caller (leader in that member's department), then uses `auth.admin.inviteUserByEmail` with the service role, scoped to that one email.
  2. Point `ResendLink` + `pa_create_department`'s link at it.
  3. Set `shouldCreateUser:false` on the Login screen's `signInWithOtp`, so an unknown email gets "ask your Department Admin" instead of a new account.
  4. Only then turn off "Allow new users to sign up".
- After 3a + 3b, open sign-up yields an account that can do **nothing**: no AI, no data (RLS), only the global `departments` / `standard_cert_types` reads (L-2). So D-4 is about **hygiene and email abuse**, not spend.

## 5. Tests the build will carry (no network)
- **`api` unit harness** (Node, fetch + Supabase client stubbed):
  - each of the four routes: no token → 401; valid JWT with no member → **403**, model never called; member → passes;
  - `record_ai_call` → `allowed:false` → **429**, model never called; RPC error → 503 fail-safe, model never called;
  - `claude` `system` over 310k / `user` over 120k / 41 turns / a 20,001-char turn / a non-string content → **413**, model never called; Station Q&A-sized payload (300k system) → passes.
- **Source fences:** no service-role key in the four routes; `requireMember` used by all four; no raw provider error echoed.
- **Plus the DB slice's dry run and RETEST** (3b).

## 6. Rulings needed

| # | Question | CC rec |
|---|---|---|
| D-1 | The gate = an **Active/Probationary member in the caller's active department** (`my_member_id()`), so Inactive/terminated members lose AI too | Yes |
| D-2 | Daily caps: `claude` **150/member** + **1,500/department**; `concepts` **30/member** | Yes, as constants, raise later |
| D-3 | Also give `assistant` / `image` per-member/day caps (60 / 20) on top of their monthly department ceilings | Yes |
| D-4 | Public sign-up stays open in this slice; the server invite route + `shouldCreateUser:false` + turning sign-up off is a **separate** slice | Yes (separate) |
| D-5 | The **28 auth accounts with no member row**: leave, or run a read-only look (created / last sign-in / confirmed) to decide on pruning | Read-only look first |
| D-6 | Input caps: system 310k · user 120k · 40 turns × 20k → 413 | Yes |
| — | **Shape:** WS-2 = **API slice** (3a + 3c + 3d) + **a tiny DB slice** (3b: `ai_call_usage` + `record_ai_call`), drafted together, API deployed after the DB applies (the API calls the new function) | Yes |
