import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Stable base URL for auth email links (magic link / invite). Must be the
// PRODUCTION origin, NOT window.location.origin — otherwise a link sent from a
// Vercel preview/deploy URL bakes in that protected URL and users land on
// Vercel's login wall instead of B4C. Falls back to the current origin for
// local dev (where VITE_APP_URL is unset).
export const APP_URL = import.meta.env.VITE_APP_URL || window.location.origin;

// App-registered handler, fired when a token refresh FAILS (dead refresh token). Lets the app
// surface an actionable "your session expired — sign back in" instead of a dead-end write error.
let onSessionExpired = null;
export const setOnSessionExpired = (fn) => { onSessionExpired = fn; };

// Transport-level auth guard wrapping EVERY Supabase request (read + write) at the one chokepoint
// they all share — no per-call-site changes. Fixes the backgrounded-phone stale-token race: a
// locked phone suspends the auto-refresh timer, the access token lapses, and the next tap sends an
// expired JWT → PostgREST 401 → a dead-end error the user can't clear by retrying.
//
// On a 401 (auth failure — note RLS *violations* are 403 and are deliberately NOT retried), refresh
// the session ONCE (deduped across a burst) and retry the original request with the fresh token.
// Safe to retry: a 401 is rejected BEFORE the request executes, so no mutation happened — no risk of
// a double write. We do not touch 5xx/network errors (those may have applied). If the refresh itself
// fails, the session is truly dead → hand off to the app to prompt a re-login.
let refreshInFlight = null;
function authFetch(input, init = {}) {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (url.includes("/auth/v1/")) return fetch(input, init);   // never intercept auth endpoints — prevents refresh recursion
  return fetch(input, init).then(async (res) => {
    if (res.status !== 401) return res;
    if (!refreshInFlight) refreshInFlight = supabase.auth.refreshSession().finally(() => { refreshInFlight = null; });
    const { data, error } = await refreshInFlight;
    const token = data?.session?.access_token;
    if (error || !token) { if (onSessionExpired) onSessionExpired(); return res; }   // refresh dead → app prompts re-login
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });   // retry ONCE with the fresh token
  });
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  global: { fetch: authFetch },
});
