// Bearer-token gate for the AI endpoints. Not an endpoint — the leading underscore stops Vercel routing it.
//
// WHY: CORS only constrains browsers. `curl` ignores it entirely, so without this anyone with the URL
// can spend Anthropic/OpenAI credits. This makes a valid Supabase session the price of entry.
//
// The ANON key is deliberately used here, not the service-role key: validating a user's token needs no
// elevated privilege, and getUser() returns only the user behind the token they already hold. Handing a
// service-role key to a public-facing endpoint would be a much bigger blast radius for zero benefit.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
// SUPABASE_ANON_KEY is the intended name. VITE_SUPABASE_ANON_KEY is accepted as a fallback because
// Vercel injects every project env var into the function runtime — the VITE_ prefix only governs what
// gets inlined into the browser bundle at build time, not what functions can read.
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// Module scope: reused across warm invocations so we're not rebuilding a client per request.
let cached = null;
function anonClient() {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  if (!cached) {
    cached = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },   // stateless server: nothing to persist or refresh
    });
  }
  return cached;
}

/* Returns the authenticated user, or null having ALREADY sent the response.
   Call as:  const user = await requireUser(req, res); if (!user) return; */
export async function requireUser(req, res) {
  const raw = String(req.headers?.authorization || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) {
    res.status(401).json({ error: "Sign in to use AI features." });
    return null;
  }

  const sb = anonClient();
  if (!sb) {
    // Config problem, not the caller's fault — don't report it as 401 or we'd send people to re-login forever.
    res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" });
    return null;
  }

  try {
    // getUser(token) asks Supabase to validate the JWT — signature, expiry, and that the user still
    // exists and isn't banned. A locally-decoded JWT would miss the last two.
    const { data, error } = await sb.auth.getUser(match[1]);
    if (error || !data?.user) {
      res.status(401).json({ error: "Your session has expired — sign in again." });
      return null;
    }
    return data.user;
  } catch {
    res.status(401).json({ error: "Couldn't verify your session — sign in again." });
    return null;
  }
}
