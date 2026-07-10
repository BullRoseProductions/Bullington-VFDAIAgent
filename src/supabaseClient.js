import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Stable base URL for auth email links (magic link / invite). Must be the
// PRODUCTION origin, NOT window.location.origin — otherwise a link sent from a
// Vercel preview/deploy URL bakes in that protected URL and users land on
// Vercel's login wall instead of B4C. Falls back to the current origin for
// local dev (where VITE_APP_URL is unset).
export const APP_URL = import.meta.env.VITE_APP_URL || window.location.origin;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
