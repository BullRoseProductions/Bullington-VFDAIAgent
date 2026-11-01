/* SENDING SOMEONE THEIR WAY IN — two calls, one cooldown.

   The app emails a link from four places: the login screen ("email me a login link"), the roster
   when a member is added, a Project Admin's new department (its first DA), and an admin resending
   one from a member's file or the PA's department list. Since signup closure (H-2) they split:
     · the LOGIN SCREEN asks Supabase directly for a sign-in link — for an EXISTING account only
       (sendLoginLink, shouldCreateUser:false). It can no longer create anybody.
     · every ADMIN send goes through /api/invite (sendInvite), which checks the caller is that
       department's admin and the address is on the roster, then invites a new account or sends an
       existing one a sign-in link. That endpoint is the only thing left that creates accounts.
   Both still draw on one Supabase email allowance — capped per hour per project (30, measured
   empirically during the Indian Harbor import) — so the cooldown below stays shared by every
   button. A cooldown defined twice is a cooldown that protects half of it. */

import { supabase, APP_URL } from "./supabaseClient";
import { authedFetch } from "./apiBase";

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

/* The LOGIN SCREEN's link. Returns Supabase's own { error } shape so the screen surfaces the real
   message rather than inventing one — except "no account", which gets the explicit sentence below.

   shouldCreateUser:false — THIS IS THE SIGNUP CLOSURE ON THE CLIENT. Before it, typing any address
   here created an account for it (the open door 28 roster-less accounts came through). Now an
   address with no account is refused by Supabase whether or not public signups are switched on, so
   the screen behaves the same before and after the dashboard flip.

   `redirect` overrides where the link lands — the login screen passes a scanned-QR URL so a check-in
   survives the round trip (see pendingScan.js). Everything else wants the app root. */
export async function sendLoginLink(email, { redirect } = {}) {
  const to = normalizeLoginEmail(email);
  if (!to) return { error: { message: "No email address on file." } };
  return supabase.auth.signInWithOtp({
    email: to,
    options: { emailRedirectTo: redirect || APP_URL, shouldCreateUser: false },
  });
}

/* Ashlea's ruling: the sign-in screen says plainly that there's no account, rather than a vague
   "if that address exists…". The roster is the only way in, so the useful next step is the admin. */
export const NO_ACCOUNT_MESSAGE = "No account yet — ask your department admin to add you.";
// Supabase's refusal of a sign-in link for an address with no account: "Signups not allowed for otp"
// (otp_disabled) while signups are on, signup_disabled / user_not_found shapes once they're off.
export const isNoAccountError = (error) => !!error && (
  ["otp_disabled", "signup_disabled", "user_not_found"].includes(error.code) || /signups? not allowed|user not found/i.test(error.message || ""));

/* An ADMIN send — add member, a new department's DA, Resend. Same { error } shape as the Supabase call
   it replaces, so each caller keeps its own success / failure toasts. The endpoint answers in step
   names, never prose, so the words here are ours — and honest about which thing went wrong.
   `data.sent` is "invite" (a new account was created and invited) or "login-link" (they already had one). */
const INVITE_FAILURE = {
  "email": "That doesn't look like a valid email address.",
  "not-authorized": "Only a Department Admin can send invites.",
  "not-on-roster": "That email isn't on your roster — add the member first, then send their invite.",
  "rate-limit": "The hourly email limit was reached. Wait a few minutes and try again.",
};
export async function sendInvite(email) {
  const to = normalizeLoginEmail(email);
  if (!to) return { error: { message: "No email address on file." } };
  let res, body = null;
  try {
    res = await authedFetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: to }) });
    body = await res.json().catch(() => null);
  } catch (e) {
    return { error: { message: e?.message?.startsWith("You're signed out") ? "You're signed out. Sign back in to send invites." : "Couldn't reach the invite service. Check your connection and try again." } };
  }
  if (res.ok && body?.ok) return { data: { sent: body.sent }, error: null };
  const step = body?.failed?.[0];
  if (res.status === 401) return { error: { message: "Your session expired — sign in again, then resend." } };
  if (INVITE_FAILURE[step]) return { error: { message: INVITE_FAILURE[step], step } };
  if (typeof body?.error === "string") return { error: { message: body.error } };   // requireMember's own 403 / 503 sentence
  return { error: { message: `The invite service couldn't send it just now${step ? ` (${step})` : ""}. Please try again in a minute.`, step } };
}
