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

/* WS-2 (H-1) — THE MEMBER GATE for the AI routes. A valid session is not enough: the caller must be an Active or
   Probationary member of their active department — my_member_id() AND my_department_id() non-null, the same resolution
   every RLS policy already uses (ruling D-1). Inactive / terminated members lose AI the moment they lose everything else.
   Runs AS THE CALLER (anon key + their JWT) — no service-role key, here or in any AI route.
   Returns { user, memberId, deptId, sb } (sb = the as-caller client), or null having ALREADY sent the response:
   401 (no / bad session, from requireUser) · 403 (not a member) · 503 (couldn't check — fail safe, the model is not called).
   Call as:  const ctx = await requireMember(req, res); if (!ctx) return; */
export async function requireMember(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (!SUPABASE_URL || !ANON_KEY) {
    res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" });
    return null;
  }
  const jwt = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || "").trim())?.[1];
  const sb = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  try {
    const [m, d] = await Promise.all([sb.rpc("my_member_id"), sb.rpc("my_department_id")]);
    if (m.error || d.error) {
      res.status(503).json({ error: "Couldn't check your membership just now — please try again." });
      return null;
    }
    if (!m.data || !d.data) {
      res.status(403).json({ error: "Your login isn't linked to an active member of a department — ask your Department Admin." });
      return null;
    }
    return { user, memberId: m.data, deptId: d.data, sb };
  } catch {
    res.status(503).json({ error: "Couldn't check your membership just now — please try again." });
    return null;
  }
}

/* WS-2 — THE DAILY CAP, charged before a cent is spent (record_ai_call, sql/ws2_ai_call_usage). Per member per day
   (America/Chicago): claude 150 (+ 1,500 per department), concepts 30, assistant 60, image 20 (rulings D-2 / D-3).
   FAIL SAFE: anything but a clear { allowed: true } — a refusal, an RPC error, a missing function — means the model is
   NOT called: 429 for a refusal, 503 for anything else. Returns the usage object, or null having ALREADY responded. */
export async function chargeAiCall(ctx, route, res) {
  let usage;
  try {
    const { data, error } = await ctx.sb.rpc("record_ai_call", { p_route: route });
    if (error || !data) {
      res.status(503).json({ error: "Couldn't check today's AI limit — please try again." });
      return null;
    }
    usage = data;
  } catch {
    res.status(503).json({ error: "Couldn't check today's AI limit — please try again." });
    return null;
  }
  if (usage.allowed !== true) {
    const who = usage.scope === "department" ? "Your department has" : "You've";
    res.status(429).json({ error: `${who} reached today's AI limit — it resets at midnight.`, used: usage.used, ceiling: usage.ceiling });
    return null;
  }
  return usage;
}
