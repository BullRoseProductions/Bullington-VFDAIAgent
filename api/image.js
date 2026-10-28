// Vercel serverless function — AI image generation (OpenAI gpt-image-1).
// OFF until IMAGE_API_KEY is set in Vercel → Settings → Environment Variables (an OpenAI key), then redeploy.
// Each generated image costs money on the provider's side, so every call is counted against a per-department
// monthly SAFETY CEILING (sql/image_gen_usage — record_image_generation) BEFORE OpenAI is called.
// Returns a base64 data URL so the browser can use it without CORS/taint issues.
//
// The model renders scenes well but garbles small/factual text and adds stray lettering even on "no text"
// prompts — so B4C layers all real text (headline, crest, details) itself, on top of the returned image.
import { cors } from "./_cors.js";
import { requireMember, chargeAiCall } from "./_auth.js";

const QUALITIES = ["medium", "high"];                       // medium is the default: ~1/4 the cost, near-identical for social
const SIZES = ["1024x1536", "1024x1024", "1536x1024"];       // portrait poster is the default
const PROMPT_MAX = 1800;

export default async function handler(req, res) {
  if (cors(req, res)) return;   // preflight answered; also sets ACAO on the real request
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const ctx = await requireMember(req, res);   // WS-2: a member of the caller's department — 401 / 403 (was a 503) / 503 already sent
  if (!ctx) return;
  const key = process.env.IMAGE_API_KEY;
  if (!key) {
    return res.status(501).json({ error: "AI image generation isn't set up yet. Add IMAGE_API_KEY in Vercel to enable it." });
  }
  const { prompt, quality = "medium", size = "1024x1536" } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: "Add a prompt describing the image." });
  }
  if (!QUALITIES.includes(quality)) return res.status(400).json({ error: "Quality must be medium or high." });
  if (!SIZES.includes(size)) return res.status(400).json({ error: `Size must be one of ${SIZES.join(", ")}.` });

  /* THE CEILING, CHECKED AS THE CALLER — before a cent is spent. The RPC is department-scoped (my_department_id()
     from the caller's own JWT), atomic, and anon-revoked; this function holds no service-role key for it. Anything
     other than a clear "allowed" — a denial, an RPC error, a missing config — FAILS SAFE: OpenAI is not called. */
  // WS-2: the per-member DAILY cap (20) first, then the department's MONTHLY ceiling — both as the caller (ctx.sb).
  if (!await chargeAiCall(ctx, "image", res)) return;   // 429 / 503 already sent — OpenAI is not called
  const asUser = ctx.sb;
  let usage;
  try {
    const { data, error } = await asUser.rpc("record_image_generation", { p_tier: quality });
    if (error || !data) {
      return res.status(503).json({ error: "Couldn't check this month's image limit — please try again." });
    }
    usage = data;
  } catch {
    return res.status(503).json({ error: "Couldn't check this month's image limit — please try again." });
  }
  if (usage.allowed !== true) {
    return res.status(429).json({ error: "You've hit this month's image limit.", used: usage.used, ceiling: usage.ceiling });
  }

  try {
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-image-1", prompt: String(prompt).slice(0, PROMPT_MAX), size, quality, n: 1 }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Image provider error" });
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: "No image was returned." });
    return res.status(200).json({ image: `data:image/png;base64,${b64}`, quality, size, used: usage.used, ceiling: usage.ceiling });
  } catch (e) {
    return res.status(500).json({ error: "Image generation failed." });
  }
}
