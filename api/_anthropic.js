// The one place B4C's server calls the Anthropic Messages API.
// Not an endpoint — the leading underscore keeps Vercel from routing it (like _auth.js and _cors.js).
//
// WHY ONE HELPER (Training Content Step 0 §5.3): /api/claude and the weekly drill cron (slice 7) must send the same
// model, the same max_tokens and the same caching, and must handle a provider error the same way: the provider's own
// message goes to the server LOG, never to a caller. Copying the fetch would let those drift.
//
// Moved out of api/claude.js unchanged (slice 6). The request body is built in the same key order with the same
// expressions, so the bytes sent to the provider are identical; docs/review/anthropic_helper_test.mjs proves it by
// running the old and new /api/claude side by side.
//
// What stays in the caller: who may spend (requireMember / requireCron), the input caps, the daily cap, the key check
// and the HTTP status the caller answers. This helper only talks to the provider.

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const MODEL = "claude-sonnet-4-6";
export const MAX_TOKENS = 2000;

// The request body, exactly as api/claude.js built it.
export function messagesBody({ system, user, messages }) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // PROMPT CACHING on the system prompt. Station Q&A stuffs every department SOP into it, so
    // the same very large block is re-sent on every turn of a conversation; cached, it is read
    // back cheaply instead of re-billed as input each time.
    //
    // Backward compatible on purpose: only a non-empty STRING system is wrapped in the block
    // form. Callers that pass an array (already block-shaped) or nothing at all fall through
    // untouched, so the drill planner and every other caller behave exactly as before.
    system: typeof system === "string" && system.trim()
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system,
    messages: Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: user }],   // multi-turn if `messages` given; else the existing single-shot path
  };
}

// One call. → { ok: true, text } on success, { ok: false, status } when the provider answered with an error.
// The provider's error type and message are logged here, under `logTag`, and never returned.
// A network failure or a non-JSON reply THROWS, exactly as the inline fetch did; the caller's catch decides the answer.
export async function callAnthropic({ key, system, user, messages, logTag }) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(messagesBody({ system, user, messages })),
  });
  const data = await r.json();
  if (!r.ok) {
    // WS-2 (L-5): the provider's own message goes to the server log, never to the caller.
    console.error(`${logTag}: Anthropic error`, r.status, data?.error?.type, data?.error?.message);
    return { ok: false, status: r.status };
  }
  const text = (data.content || [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();
  return { ok: true, text };
}
