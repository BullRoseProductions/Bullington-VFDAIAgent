// Vercel serverless function — optional AI image generation (beta).
// This is OFF until you add an image provider key. To enable:
//   1. Set IMAGE_API_KEY in Vercel → Settings → Environment Variables
//      (an OpenAI key works with the default provider below).
//   2. Redeploy. Each generated image costs money on the provider's side.
// Returns a base64 data URL so the browser can use it without CORS/taint issues.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const key = process.env.IMAGE_API_KEY;
  if (!key) {
    return res.status(501).json({ error: "AI image generation isn't set up yet. Add IMAGE_API_KEY in Vercel to enable it." });
  }
  const { prompt } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: "Add a prompt describing the image." });
  }
  try {
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-image-1", prompt: String(prompt).slice(0, 800), size: "1024x1024" }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Image provider error" });
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: "No image was returned." });
    return res.status(200).json({ image: `data:image/png;base64,${b64}` });
  } catch (e) {
    return res.status(500).json({ error: "Image generation failed." });
  }
}
