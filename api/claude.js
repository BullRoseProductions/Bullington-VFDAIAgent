// Vercel serverless function — keeps your Anthropic API key on the server.
// Set ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables.
import { cors } from "./_cors.js";
import { requireMember, chargeAiCall } from "./_auth.js";

/* WS-2 (D-6) INPUT CAPS — sized to the real callers, so no legitimate request is refused:
   · system ≤ 310,000 chars (string, or the total of its text blocks). Station Q&A stuffs every SOP in, capped by the
     client at 300,000 (Indian Harbor sits right there today, 307,617 of SOP text before the client's cut).
   · user (single-shot) ≤ 120,000 — the plan import sends a whole pasted plan; Minutes attaches agendas.
   · messages: each turn ≤ 20,000, roles user/assistant, string content, ending on the user (assistant.js's rules);
     ≤ 100 turns and ≤ 800,000 chars in total. ⚠ DEVIATION FROM D-6 (40 turns), flagged for review: the cert tutor's
     20-question quiz sends 4 turns per question (hidden prompt · question · answer · verdict) — 77–79 turns by question
     20 — so a 40-turn cap would refuse it at about question 10. 800,000 total = the ruled worst case (40 × 20,000), so
     the per-call cost bound is unchanged; only the turn COUNT is wider.
   Anything over → 413, BEFORE the daily cap is charged and before the model is called. */
export const SYSTEM_MAX = 310_000, USER_MAX = 120_000, TURNS_MAX = 100, TURN_MAX = 20_000, MESSAGES_TOTAL_MAX = 800_000;

// → null when the body is acceptable, else the 413 message.
export function inputProblem({ system, user, messages }) {
  if (system !== undefined && system !== null) {
    const len = typeof system === "string" ? system.length
      : Array.isArray(system) && system.every((b) => b && b.type === "text" && typeof b.text === "string") ? system.reduce((t, b) => t + b.text.length, 0)
      : -1;
    if (len < 0) return "The system prompt must be text.";
    if (len > SYSTEM_MAX) return `The system prompt is too long (${len.toLocaleString("en-US")} characters; the limit is ${SYSTEM_MAX.toLocaleString("en-US")}).`;
  }
  if (Array.isArray(messages) && messages.length) {
    if (messages.length > TURNS_MAX) return `Too many turns (${messages.length}; the limit is ${TURNS_MAX}).`;
    for (const m of messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return "Each turn must be a user or assistant message with text content.";
      if (m.content.length > TURN_MAX) return `A turn is too long (${m.content.length.toLocaleString("en-US")} characters; the limit is ${TURN_MAX.toLocaleString("en-US")}).`;
    }
    if (messages[messages.length - 1].role !== "user") return "The conversation must end with a user message.";
    const total = messages.reduce((t, m) => t + m.content.length, 0);
    if (total > MESSAGES_TOTAL_MAX) return `The conversation is too long (${total.toLocaleString("en-US")} characters; the limit is ${MESSAGES_TOTAL_MAX.toLocaleString("en-US")}).`;
    return null;
  }
  if (typeof user !== "string") return "The message must be text.";
  if (user.length > USER_MAX) return `The message is too long (${user.length.toLocaleString("en-US")} characters; the limit is ${USER_MAX.toLocaleString("en-US")}).`;
  return null;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;   // preflight answered; also sets ACAO on the real request
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const ctx = await requireMember(req, res);   // WS-2: a member of the caller's department — 401 / 403 / 503 already sent
  if (!ctx) return;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });
  }
  const { system, user, messages } = req.body || {};
  const problem = inputProblem({ system, user, messages });
  if (problem) return res.status(413).json({ error: problem });
  if (!await chargeAiCall(ctx, "claude", res)) return;   // WS-2: the daily cap — 429 / 503 already sent, the model is not called
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
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
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      // WS-2 (L-5): the provider's own message goes to the server log, never to the caller.
      console.error("api/claude: Anthropic error", r.status, data?.error?.type, data?.error?.message);
      return res.status(502).json({ error: "The AI service couldn't answer just now — please try again." });
    }
    const text = (data.content || [])
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: "AI request failed" });
  }
}
