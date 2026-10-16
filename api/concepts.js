// Vercel serverless function — the Image Generator's ART DIRECTOR (Phase A, backend only).
// Claude (claude-sonnet-4-6 — the same model, headers and auth gate as api/claude.js) turns an occasion + the
// department's brand into N distinct poster concepts: [{ headline, mood, imagePrompt }]. The imagePrompt is a
// SCENE-ONLY brief for /api/image (gpt-image-1); B4C adds the headline and crest itself afterwards, so every
// imagePrompt must end with "No text, no logos." — enforced here even if the model forgets.
import { cors } from "./_cors.js";
import { requireUser } from "./_auth.js";

const MODEL = "claude-sonnet-4-6";
const NO_TEXT = "No text, no logos.";
const MAX_COUNT = 6;

// The art-director system prompt, as specified (straight quotes; the spec's typographic quotes were normalised so
// the JSON shape the model is shown is real JSON).
export function buildSystemPrompt({ count, brandName, colors, voice, tagline }) {
  return `You are a senior art director creating social-media graphics for a volunteer fire/EMS department. Given an occasion and the department's brand, produce ${count} DISTINCT creative concepts for a single vertical poster-style graphic. Return ONLY valid JSON: an array of objects, each {"headline": string, "mood": string, "imagePrompt": string}. No prose, no markdown, no code fences. For each concept: headline = a short punchy 2–6 word headline in the department's VOICE, varied across concepts; mood = one short phrase for the feel; imagePrompt = a detailed, cinematic, PHOTOREAL art-direction prompt describing the SCENE ONLY — subject, composition, lighting, lens/mood — with clear NEGATIVE SPACE where a headline will be added later. Vary subject/angle/time-of-day. HARD RULES for every imagePrompt: a GENERIC scene — never a real named person, never a real/recognizable logo, never a real incident or identifiable real place; photoreal editorial poster quality; and it MUST END with the exact words "No text, no logos." (The department adds its own text and crest afterward — never ask the model to render words.) Keep it safe: no gore, no people in danger, no minors in distress. Department brand — name: ${brandName}; colors: ${colors}; voice/tone: ${voice}; tagline: ${tagline}. Match the voice in headlines and the color mood in scenes.`;
}

// Model text -> [{headline, mood, imagePrompt}]. Tolerates stray fences/prose around the array; drops malformed
// entries; guarantees every imagePrompt ends with "No text, no logos.". Returns null when nothing usable came back.
export function parseConcepts(text, count) {
  if (typeof text !== "string") return null;
  const t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  let arr = null;
  try { arr = JSON.parse(t); } catch {
    const m = t.match(/\[[\s\S]*\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch { arr = null; } }
  }
  if (!Array.isArray(arr)) return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const out = arr
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ headline: str(c.headline), mood: str(c.mood), imagePrompt: str(c.imagePrompt) }))
    .filter((c) => c.headline && c.imagePrompt)
    .map((c) => ({ ...c, imagePrompt: c.imagePrompt.endsWith(NO_TEXT) ? c.imagePrompt : `${c.imagePrompt} ${NO_TEXT}` }))
    .slice(0, count);
  return out.length ? out : null;
}

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
  const b = req.body || {};
  const clip = (v, n) => String(v ?? "").trim().slice(0, n);
  const purpose = clip(b.purpose, 200), occasion = clip(b.occasion, 300), details = clip(b.details, 1200);
  if (!purpose && !occasion) {
    return res.status(400).json({ error: "Say what the graphic is for — a purpose or an occasion." });
  }
  const count = Math.min(MAX_COUNT, Math.max(1, Number.parseInt(b.count, 10) || 3));
  const system = buildSystemPrompt({
    count,
    brandName: clip(b.brandName, 120) || "the department",
    colors: clip(b.colors, 200) || "the department's colors",
    voice: clip(b.voice, 400) || "warm, plain-spoken, community-minded",
    tagline: clip(b.tagline, 200) || "(none)",
  });
  const user = [`Purpose: ${purpose || "(not given)"}`, `Occasion: ${occasion || "(not given)"}`, `Details: ${details || "(none)"}`, `Concepts wanted: ${count}`].join("\n");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Anthropic API error" });
    }
    const text = (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("").trim();
    const concepts = parseConcepts(text, count);
    if (!concepts) return res.status(502).json({ error: "Couldn't read the concepts — please try again." });
    return res.status(200).json({ concepts });
  } catch (e) {
    return res.status(500).json({ error: "Concept request failed" });
  }
}
