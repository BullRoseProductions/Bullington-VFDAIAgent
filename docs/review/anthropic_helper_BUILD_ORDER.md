# Weekly Training Content, slice 6: the `_anthropic.js` extraction: build order and hand-back

**Status:** for gate. **Not reviewed, not promoted.** Branch `feat/anthropic-helper`, off `195feec`.
- `195feec` is main `2a621b4` (slice 5, "GATE PASS @ 2a621b4") plus its tests-only fence pin, which rides this merge.
- Server only: `api/claude.js` plus the new `api/_anthropic.js`. No `src/`, `shared/`, `sql/`, native, package or `vercel.json` change, and no SQL to apply.
- It ships to the web on merge. Native builds call the same `/api/claude`, so they need no rebuild.

**Design:** `docs/design/training_content_step0.md` §5.3, the "Provider call" row: one shared helper used by `/api/claude` and the weekly cron, shipped as its own slice "with a byte-identical behaviour test" (gate PASS @2a0768c; rulings @4cfe29f).

## What it does
- **`api/_anthropic.js` (new, not a route: the leading underscore, like `_auth.js`).** The fetch that lived inside `claude.js`, moved unchanged:
  - `messagesBody({system, user, messages})` builds the request body with the same key order and the same expressions (model, `max_tokens`, the cached-string-system wrap, the multi-turn / single-shot choice). The prompt-caching comment moved with it.
  - `callAnthropic({key, system, user, messages, logTag})` makes one call:
    - success → `{ok: true, text}`, with text blocks joined, other blocks dropped, trimmed;
    - a provider error → `{ok: false, status}`. The provider's type and message go to `console.error` as `"<logTag>: Anthropic error"` and are **never returned**;
    - a network failure or a non-JSON reply **throws**, as the inline fetch did, so the caller's `catch` decides the answer.
  - Constants: `MODEL = "claude-sonnet-4-6"`, `MAX_TOKENS = 2000`, `ANTHROPIC_VERSION`, `ANTHROPIC_URL`.
  - It reads no env, no Supabase, no auth. **The caller passes the key**, and keeps who may spend, the input caps, the daily cap and its own HTTP answers.
- **`api/claude.js`:** the `try` block now calls `callAnthropic({..., logTag: "api/claude"})` and maps the result to the same 200 / 502 answers. Everything before the `try` (cors → POST → `requireMember` → key check → `inputProblem` → `chargeAiCall`) is byte-identical, and so are the input caps.

## Judgment calls for the gate
- **AX-1, the log tag is a parameter.** `/api/claude` passes `"api/claude"`, so its log line is unchanged byte for byte. The cron will pass its own tag (`"api/weekly-drill"`), so its errors are told apart in the log without the helper knowing who called it.
- **AX-2, the key is passed in, not read from env inside the helper.** `claude.js` must refuse a missing key (500) *before* the input caps and the daily charge, and that order is part of the reviewed gate. Keeping the env read in the caller keeps that order and keeps the helper free of config.
- **AX-3, `api/assistant.js` and `api/concepts.js` keep their own fetches.** Step 0 names `claude.js` and the cron only. Those two send different bodies (assistant: tools, `max_tokens` 1200, a tool loop; concepts: no caching), so moving them would be a behaviour change, not an extraction. They are fenced as untouched here and can be a later slice if wanted.

## Tests
- **`docs/review/anthropic_helper_test.mjs`: 58/58, exit 0.**
  1. **Differential: 36 cases, all byte-identical.** The OLD `/api/claude` (BASE's `api/`, via `git archive`) and the NEW one are both bundled with their real `_auth.js` and `_cors.js`; only the Supabase client is faked and `fetch` stubbed. Each case runs through both in an identical world, comparing the URL, method, headers and **exact request-body string** sent to the provider; the caller's status, body and headers; the `console.error` lines; and the RPCs with their JWTs. 22 provider calls were compared.
     - 11 request shapes: string / whitespace / empty / block / missing / null system, multi-turn, an empty `messages` array, unicode and quotes, Station Q&A size, exactly at the limits.
     - 11 provider outcomes: text, mixed blocks (including a non-text block carrying a `text` field), no content, null content, a null body, an error with detail, a bare 529, an error with a null body, non-JSON on success and on error, a network failure.
     - 14 gate paths: 405, preflight, no token, bad token, no member, membership error, missing key, no body, three 413s, the member cap, the department backstop, a cap RPC error.
  2. **Spot checks** so an empty comparison can't pass: the request is the WS-2 one (model, 2000, the cache block, version, key order); a provider error is a 502 with the fixed sentence and the detail only in the log; a network failure or non-JSON is a 500 with nothing logged.
  3. **The helper's contract for slice 7:** the exports and constants; `{ok: false, status}` only, logged under the caller's tag; `{ok: true, text}`; a network failure throws; no env, Supabase or auth in the helper.
  4. **Fences:** only these 4 files changed in `195feec..REV`; the input caps and the handler's gate byte-identical to BASE; `_auth.js`, `_cors.js`, `_cron.js`, `vercel.json`, `assistant.js`, `concepts.js`, `digest.js` untouched; verified 132/32/14; Notify held.
- **Mutations: 15/15 caught.**
  - In the helper: `max_tokens`, model, body key order, caching dropped, a whitespace system wrapped, the log line reworded, the provider message dropped from the log, no trim, non-text blocks leaking, an extra header, a non-JSON reply swallowed.
  - In `claude.js`: the log tag, the provider status leaked to the caller, the 200 body shape, the daily cap not enforced.
  - The first run missed one (non-text blocks leaking), because the fixture's `tool_use` block had no `text` field. The fixture now carries one, and it's caught. Test-only fix; no app code changed.
- **Suite:** 71 files, all exit 0 (including `ws2_api_gate_test` and `step_regen_test`, which read `api/claude.js`).
- **Build and lint:** both exit 0. The build used placeholder env vars only, as a compile check.

## Invariants
- verified counts: App.jsx 132 · digest 32 · assistant 14, unchanged;
- Notify held;
- `api/_cron.js` and `vercel.json` untouched;
- no SQL, RLS or grant change; the WS-2 gate's order and caps unchanged.

## After gate PASS (on Ashlea's go, with the PASS sha quoted verbatim from the relayed message)
1. Pin this test's `REV` to the passed sha, then merge to main and push.
2. Served-verify `version.json`.
3. A live smoke check: any AI feature that goes through `/api/claude` (for example, a drill draft in Training Plans) answers as before.

## Next
**Slice 7, the weekly cron:** `api/weekly-drill.js` (`requireCron` imported, `inputProblem` imported, `callAnthropic` from this helper with `logTag: "api/weekly-drill"`, `parseDrillPlanReply` from `shared/`), `weeklyDrillOutcome()` in `shared/cron-outcome.js`, the one-line `vercel.json` exception (digest and pulse entries byte-identical), and flipping `WEEKLY_DRAFT_RUN_LIVE`.
