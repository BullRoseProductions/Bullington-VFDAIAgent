/* SENDING A LOGIN LINK — one definition, three callers.

   The app emails a sign-in link from three places: the login screen ("email me a login link"), the
   roster when a member is added, and an admin resending one from a member's file. All three are
   the same Supabase call with the same rate limit behind them, and the rate limit is the reason
   this is shared rather than repeated: Supabase caps auth emails per hour per project (30, measured
   empirically during the Indian Harbor import), and that ceiling is shared across every one of
   these buttons. A cooldown defined twice is a cooldown that protects half of it. */

import { supabase, APP_URL } from "./supabaseClient";

/* THIRTY SECONDS BETWEEN SENDS, from any of the buttons.

   Not a UI nicety — it is the guard on a project-wide hourly ceiling. Without it an admin working
   down a roster of new members, or a member who did not see the email arrive, can burn the hour's
   allowance in a minute and lock out everyone else trying to sign in, with no feedback that they
   have done so. */
export const RESEND_COOLDOWN = 30;

/* Trim and lowercase, matching how the roster's add-member form normalizes before it writes.

   The member row's email is what an admin resends TO, and it was typed by a human at some point —
   so it can carry a trailing space from a paste or a capital from a phone keyboard. Supabase
   lowercases addresses internally, so this rarely changes the outcome; it matters because the
   normalized value is what gets shown back in the confirmation, and a confirmation that reads
   " Scott@Example.com " undermines confidence in a screen whose whole job is to reassure. */
export const normalizeLoginEmail = (email) => String(email || "").trim().toLowerCase();

/* The one call. Returns Supabase's own { error } shape so callers surface the real message rather
   than inventing one.

   signInWithOtp IS CORRECT FOR BOTH CASES and needs no branching: for a member who already has an
   auth user it sends a sign-in link; for a member row that has never had one it sends an invite.
   Both are exactly what "send them their login link" should do, so asking which case we are in
   would add a question whose answers are the same.

   `redirect` overrides where the link lands — the login screen passes a scanned-QR URL so a check-in
   survives the round trip (see pendingScan.js). Everything else wants the app root. */
export async function sendLoginLink(email, { redirect } = {}) {
  const to = normalizeLoginEmail(email);
  if (!to) return { error: { message: "No email address on file." } };
  return supabase.auth.signInWithOtp({
    email: to,
    options: { emailRedirectTo: redirect || APP_URL },
  });
}
