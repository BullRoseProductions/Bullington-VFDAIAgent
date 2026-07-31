// Vercel serverless function — email digest send pipe (Slice 1: proves Resend + domain + key).
// Set RESEND_API_KEY and CRON_SECRET in Vercel → Settings → Environment Variables.
// Called two ways: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`;
// a browser test can pass `?secret=${CRON_SECRET}` instead.
const DEFAULT_TO = "ashlea@bullroseproductions.com";
const FROM = "B4C <notifications@b4thecall.com>";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "Missing CRON_SECRET" });   // fail closed — no secret configured, no sends
  }
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const provided = bearer || req.query?.secret || "";
  if (provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing RESEND_API_KEY" });
  }
  const to = req.query?.to || DEFAULT_TO;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: "B4C digest — test",
        html: "<p>If you're reading this, the B4C digest pipe works — Resend, the domain, and the key are all good.</p>",
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ ok: false, status: r.status, error: data });   // surface Resend's own detail — usually names the bad from-address/domain
    }
    return res.status(200).json({ ok: true, id: data?.id });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e?.message || e) });
  }
}
