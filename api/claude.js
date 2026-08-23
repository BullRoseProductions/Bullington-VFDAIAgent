// Vercel serverless function — keeps your Anthropic API key on the server.
// Set ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables.
import { cors } from "./_cors.js";
import { requireUser } from "./_auth.js";
export default async function handler(req, res) {
  if (cors(req, res)) return;   // preflight answered; also sets ACAO on the real request
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!await requireUser(req, res)) return;   // 401 already sent — the handler must not run
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });
  }
  const { system, user, messages } = req.body || {};
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
      return res.status(r.status).json({ error: data?.error?.message || "Anthropic API error" });
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
