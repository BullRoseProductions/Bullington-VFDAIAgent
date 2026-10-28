// CRON_SECRET gate for the scheduled endpoints (digest, pulse). Not an endpoint — the leading underscore
// stops Vercel routing it.
//
// HEADER ONLY. Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` on its own; that is the only place
// the secret is read. The old `?secret=` query form is gone (security review L-1): a secret in a URL ends up
// in browser history, the Vercel request log and anything a link is pasted into — and this one also unlocks
// digest's ?to= (send a full digest) and ?dry= (rendered HTML + admin addresses). A request that still
// carries ?secret= is refused with a note saying where the secret goes now, so a stale bookmark reads as
// a moved door rather than a broken endpoint. Its value is never compared, even when it is right.
//
// CONSTANT-TIME. Both sides are hashed to 32 bytes first, so timingSafeEqual always compares equal lengths
// and neither the secret's length nor a matching prefix shows up in response time.
import { createHash, timingSafeEqual } from "crypto";

const digest = (s) => createHash("sha256").update(String(s)).digest();

/* Returns true, or false having ALREADY sent the response.
   Call as:  if (!requireCron(req, res)) return; */
export function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Missing CRON_SECRET" });   // fail closed — no secret configured, nothing runs
    return false;
  }
  if (req.query?.secret != null) {
    res.status(401).json({
      error: "Unauthorized",
      note: "?secret= is no longer accepted. Send it as an Authorization: Bearer header.",
    });
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || "").trim());
  if (!match || !timingSafeEqual(digest(match[1]), digest(secret))) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}
