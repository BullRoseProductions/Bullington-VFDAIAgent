# B4C — WS-2 draft: lock the AI routes to real members (H-1) — for gate review

**CC, 2026-10-27. DRAFT — nothing applied, nothing deployed.**

- **Branch:** `feat/ws2-ai-gate`, off main `f854a82`.
- **Rulings:** [[B4C_WS2_AIGate_Step0]] §6 (D-1..D-6), as Ashlea ruled.
- **Shape:** the **DB applies before the API deploys**. The API calls `record_ai_call`; until it exists, every AI call fails safe with a 503.

| Part | Files |
|---|---|
| **DB** | `sql/ws2_ai_call_usage_DRAFT.sql`; RETEST `sql/ws2_ai_call_usage_RETEST.sql`; dry run `docs/review/ws2_ai_call_usage_dryrun_harness.mjs` → `ws2_ai_call_usage_DRYRUN.txt`; live reads `docs/review/ws2_LIVEDEFS.json` |
| **API** | `api/_auth.js` (`requireMember`, `chargeAiCall`), `api/claude.js`, `api/concepts.js`, `api/assistant.js`, `api/image.js`. **No client change.** Harness `docs/review/ws2_api_gate_test.mjs` **48/0** → `ws2_api_gate_TEST_OUTPUT.txt`. Diff `docs/review/ws2_api_gate_DIFF.patch` |
| **Checks** | full suite **30 tests, 0 red, 845 PASS**; build OK; `verified` 132 · 32 · 14; Notify held; no `station_presence` |

## ⚠ One deviation from the rulings — please decide (D-6, the turn count)

The ruled `messages` cap of **40 turns would break the cert tutor's 20-question quiz** (lengths 5/10/20).
- It sends 4 turns per question: hidden prompt · question · answer · verdict. That's **77–79 turns** by question 20, so the quiz would be refused at about question 10.
- Station Q&A conversations also grow without a client cap.
- My Step 0 sized "turns" from `assistant.js` and missed this.

**Built instead:**
- **≤ 100 turns, each ≤ 20,000, and ≤ 800,000 chars in total.** 800,000 is exactly the ruled worst case (40 × 20,000), so the **per-call cost bound is unchanged**; only the turn count is wider.
- The harness proves both: a 79-turn quiz passes, and 41 × 19,999 (> 800k) is a 413.
- If you'd rather keep 40, the quiz needs a client change (send only the last N turns), which is outside "no client change".

## 1 · DB slice — `ai_call_usage` + `record_ai_call(p_route)`

**Live reads (read-only, 2026-10-27):**
- the four pins: `my_member_id` `3f66369c…`, `my_department_id` `87f54665…`, `record_assistant_turn` `fc69fdaf…`, `record_image_generation` `668c0a92…`. All are anon=false and authenticated=true.
- `assistant_usage`, the pattern: RLS on, 0 policies, ACL postgres + service_role only.
- `record_ai_call` does not exist yet.

**`ai_call_usage`:**
- columns `(member_id → members, department_id → departments, day, route CHECK ∈ claude|concepts|assistant|image, count ≥ 0, updated_at)`;
- PK `(member_id, day, route)`, plus an index on `(department_id, day, route)` for the backstop's sum;
- RLS on, **no policies**, `REVOKE ALL FROM PUBLIC, anon, authenticated`.

**`record_ai_call(p_route) → {allowed, used, ceiling[, scope, dept_used, dept_ceiling]}`:**
- SECURITY DEFINER, `search_path=public`, REVOKE PUBLIC/anon, GRANT authenticated.
- **Gate (D-1):** `my_member_id()` and `my_department_id()` non-null, else it raises.
- **Route allowlist**, else it raises.
- **Day:** the Chicago day.
- **Caps (D-2 / D-3):**
  - per member/day: claude **150** · concepts **30** · assistant **60** · image **20**;
  - claude per department/day: **1,500**.
- **Mechanics:**
  - the member cap is the `record_assistant_turn` shape: atomic `INSERT … ON CONFLICT DO UPDATE … WHERE count < cap`;
  - **the department backstop runs under a transaction-scoped advisory lock** on (department, day, route), so two concurrent calls can't both read 1,499 and pass. The dry run shows 1,499 → exactly one more allowed.
- The monthly department ceilings are **untouched** (pinned and proven byte-identical).

**Preflight refuses on drift:** the four pins, "already applied", and the column types. **Post-conditions prove:**
- RLS on, 0 policies, no anon/authenticated privilege;
- definer + `search_path` + authenticated-only;
- the four pins unchanged;
- policies unchanged, functions +1;
- verified unchanged.

**Expected live state row:**

| field | expected |
|---|---|
| table | true |
| rls | true |
| policies | 0 |
| table_acl | postgres + service_role only |
| auth_select | false |
| rows | 0 |
| fn | `record_ai_call anon=false auth=true definer=true` |
| total_policies | 181 |
| fn_count | 228 (227 + 1) |
| verified | unchanged |

**Dry run (PGlite, the four live bodies, no stubs):**
- pins 4/4; state row; re-run refused;
- **RETEST 21/0/0** (2 mock departments);
- backstop concurrency check passes;
- drift refusals 3/3;
- mutations 8/8: refused by the migration, or caught by the RETEST;
- post-apply drift 3/3 caught.

**RETEST (live, rolled-back SENTINEL, every department):**
- **O1–O3:** the table's seal; the function's privileges; the four pins.
- **Per department:**
  - **T1:** under the cap, allowed (used 1 → 2 of 150).
  - **T2:** over the member cap → refused (scope member), count unchanged.
  - **T3:** the department at 1,500 → refused (scope department) even under the member cap.
  - **T4:** no member row / Inactive → raises "could not match" (403 at the API).
  - **T5:** an unknown route raises.
  - **T6:** the ruled ceilings (30 / 60 / 20).
  - **T7:** anon can't execute.
  - **T8:** the table is unreadable by authenticated.
  - **T9:** `station_presence` byte-identical; verified unchanged; the monthly-ceiling tables untouched.

## 2 · API slice

- **`requireMember(req, res)`** (`api/_auth.js`):
  1. `requireUser`, as before (validates the JWT).
  2. An **anon-key client carrying the caller's JWT**, with no service role, calls `my_member_id` + `my_department_id` in parallel.
  3. Either is null → **403** *"Your login isn't linked to an active member of a department — ask your Department Admin."* An RPC error → **503**, fail safe.
  4. It returns `{ user, memberId, deptId, sb }`.
- **`chargeAiCall(ctx, route, res)`:** calls `record_ai_call`.
  - `allowed:false` → **429** with `used` / `ceiling`; the message says whether it's "You've" or "Your department has" reached today's limit.
  - An RPC error, or the function missing → **503**.
  - **The model is never called on either.**

**Per route — the order is gate → validate → charge → (monthly ceiling) → model:**

| Route | Change |
|---|---|
| `claude` | `requireMember`; **D-6 input caps → 413, checked before the cap is charged** (system ≤ 310k as a string or the sum of its text blocks; user ≤ 120k; messages as above); `chargeAiCall("claude")`; provider error → **502** generic, detail to the server log (L-5) |
| `concepts` | `requireMember`; the existing clipping; `chargeAiCall("concepts")`; provider error → 502 generic |
| `assistant` | `requireMember` replaces `requireUser`, its own client set-up and its own member lookup → **403 instead of 503** for a non-member. `chargeAiCall("assistant")` (60/day), then the **unchanged** monthly ceiling and its `200 {limited}` reply. Its existing `ctx` (the tool context) keeps its name; the gate's result is `member` there |
| `image` | `requireMember` (403, not 503); `chargeAiCall("image")` (20/day), then the unchanged monthly ceiling |

- **Unchanged:** CORS, the method checks, success response shapes, every client caller.
- Every client reads `data.error` on a non-2xx, so the new 403 / 413 / 429 messages show as written.

**Harness (48/0), no network:**
- **Every route:** no token → 401; non-member → 403 with the model **and** the cap untouched; membership RPC error → 503; member → 200, charged for that route **with the caller's JWT**; over cap → 429; cap RPC missing/erroring → 503. The model is never called on a refusal.
- **claude:** 11 kinds of 413, each before the cap; at-limit / Station Q&A (300k) / the 79-turn quiz pass.
- **claude + concepts:** a provider error → 502, and the raw provider text never reaches the response.
- **Fences:** no service-role key anywhere in the five files; all four routes use `requireMember` + `chargeAiCall`; the runtime diff is exactly the five api files.

## 3 · D-5 — the member-less accounts (read-only; nothing changed)

The read-only look was done live on 2026-10-27, and **reported to the reviewer and Ashlea directly — not recorded in
this repo**, since it describes individual accounts. Nothing was changed. After WS-2 these accounts can do nothing
(no AI, no data); pruning stays a separate decision (D-4 / D-5).

## 4 · Flags

1. **D-6 turn count:** see the top.
2. **`api/image.js` still echoes the provider's raw `error.message`** on an OpenAI error. Ruling L-5 named claude/concepts only, so I left it. It's a one-line change in the same file, if you want it in.
3. **Charge order on assistant/image:** the daily cap is charged before the monthly ceiling. A call refused by the *monthly* ceiling has therefore used one of the member's daily calls. Both are fail-safe, and the monthly ceiling sits far above real use (assistant 18, image 9 this month).
4. **Rollout ordering:** if the API deploys before the DB applies, every AI call returns a 503 ("Couldn't check today's AI limit"), which fails safe. Hence DB first.
