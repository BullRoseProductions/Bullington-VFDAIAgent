// Shared CORS allowlist for the AI endpoints.
// Not an endpoint — the leading underscore keeps Vercel from routing it.
//
// WHY THESE ENDPOINTS NEED IT: in a native Capacitor build the web assets load from the local bundle,
// so the page origin is capacitor://localhost (iOS) or https://localhost (Android). A request to
// app.b4thecall.com is therefore cross-origin and the browser preflights it. On web the app is
// same-origin and none of this is exercised.
//
// EXPLICIT ALLOWLIST, NEVER "*": these endpoints spend real money on the Anthropic and OpenAI APIs.
// A wildcard would let any website on the internet drive them from a visitor's browser.
const APP_ORIGIN = process.env.VITE_APP_URL || process.env.APP_URL || "https://app.b4thecall.com";

const ALLOWED_ORIGINS = new Set([
  "capacitor://localhost",   // iOS native WebView
  "https://localhost",       // Android native WebView (Capacitor's default scheme)
  APP_ORIGIN.replace(/\/$/, ""),
]);

// Sets the response headers when the caller's Origin is allowed, and answers the preflight.
// Returns true when the request has been fully handled and the caller should return immediately.
export function cors(req, res) {
  const origin = req.headers?.origin;
  const allowed = !!origin && ALLOWED_ORIGINS.has(origin);

  if (allowed) {
    // Echo the specific origin rather than "*" — required anyway once credentials are involved,
    // and Vary tells caches the response differs per origin.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    if (!allowed) {
      res.status(403).end();     // no ACAO header → the browser blocks the real request too
      return true;
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");   // cache the preflight for a day
    res.status(204).end();
    return true;
  }

  return false;   // not a preflight — carry on with the actual request
}

export const __test = { ALLOWED_ORIGINS, APP_ORIGIN };
