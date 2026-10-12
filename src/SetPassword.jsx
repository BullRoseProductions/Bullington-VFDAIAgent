import { useState } from "react";
import { supabase } from "./supabaseClient";
import { AUTH } from "./theme.js";

/* THE SET-PASSWORD SCREEN, and the password rules it enforces.
 *
 * Extracted from main.jsx so it can have two callers. That is not tidiness: main.jsx runs code at
 * IMPORT time — checkForUpdate(true) fires and a visibilitychange listener is registered — so
 * anything importing from it would trigger a version check and a possible page reload as a side
 * effect. A future "change your password" screen in Settings can import from here safely.
 *
 * TWO MODES, one component:
 *   default    — after a Forgot-password link (PASSWORD_RECOVERY)
 *   firstTime  — the onboarding gate, for an invited member who has never set a password
 * Only the wording differs. The rules, the live checklist, the error translation and the save path
 * are shared, so the two screens cannot drift into disagreeing about what a valid password is.
 */

/* Password rules — ONE source of truth, used by both the live checklist and the Save gate, so the
   hints can never show all-green while save() still refuses (or the reverse).
   The symbol class is the explicit set Supabase's own policy uses rather than "any non-alphanumeric":
   a lone space would pass a /[^A-Za-z0-9]/ test here and still be rejected server-side, which is
   exactly the contradiction this screen exists to avoid. */
export const PASSWORD_RULES = [
  { id: "len",    label: "At least 8 characters",        test: (p) => p.length >= 8 },
  { id: "upper",  label: "One uppercase letter (A–Z)",   test: (p) => /[A-Z]/.test(p) },
  { id: "lower",  label: "One lowercase letter (a–z)",   test: (p) => /[a-z]/.test(p) },
  { id: "digit",  label: "One number (0–9)",             test: (p) => /[0-9]/.test(p) },
  { id: "symbol", label: "One symbol (! ? # $ …)",       test: (p) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(p) },
];
export const unmetRules = (p) => PASSWORD_RULES.filter((r) => !r.test(p || ""));

// Supabase can still refuse a password our checklist accepts — notably `pwned`, a breach-list hit we
// cannot test client-side. Turn every one of those into plain language; never surface the raw string.
export function friendlyPasswordError(error) {
  const reasons = Array.isArray(error?.reasons) ? error.reasons : [];
  const weak = error?.code === "weak_password" || reasons.length > 0;
  if (!weak) return error?.message || "Something went wrong saving your password. Please try again.";
  if (reasons.includes("pwned")) return "That password has shown up in a known data breach, so it isn't safe to use. Please pick a different one.";
  if (reasons.includes("length")) return "That password is too short. Use at least 8 characters.";
  if (reasons.includes("characters")) return "That password needs a wider mix — check the list above and add what's missing.";
  return "That password isn't strong enough yet. Check the list above and add what's missing.";
}

/* Built for the lowest common denominator: ONE field plus a Show-password toggle — no confirm
   field, because a confirm-mismatch is the exact dead-end that loses non-technical users. Letting
   them SEE what they typed is safer than making them type it twice. On success they are already in
   a live session, so onDone drops them straight into the app — no second login. */
export function SetNewPassword({ hasSession, onDone, firstTime = false }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // The recovery screen shows the instant we spot type=recovery, but the token
  // validates a beat later (a network round-trip). Gate Save on the live session so a
  // fast typer can't fire updateUser before it lands — a disabled-then-enabled button
  // beats an error our audience would have to decode and retry.
  const ready = hasSession && !loading;

  const missing = unmetRules(password);

  async function save() {
    setErr("");
    if (!ready) return;
    // Save stays CLICKABLE even when the rules aren't met — a dead button with no explanation is the
    // same dead-end this screen was built to avoid. Clicking names what's missing instead.
    if (missing.length) {
      setErr(password ? "Your password still needs: " + missing.map((r) => r.label.toLowerCase()).join(", ") + "." : "Pick a password that meets the list below.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setLoading(false); setErr(friendlyPasswordError(error)); return; }

    /* MARK THE FLAG HERE, not in the gate's onDone — so the FORGOT-PASSWORD path marks it too.
       A member who arrives via a reset link has unquestionably set a password; if only the
       onboarding gate marked the flag, they would be gated later for no reason.

       A failure here is logged, never surfaced. The password IS set, which is what the member came
       to do, and blocking them on a bookkeeping error would be the worse outcome. The cost of the
       failure is bounded: they meet the gate once more and setting a password again fixes it. */
    const { error: markErr } = await supabase.rpc("mark_password_set");
    if (markErr) console.warn("[b4c] mark_password_set failed:", markErr.message);

    setLoading(false);
    onDone(); // session is already live → straight into the app, signed in
  }

  return (
    <div style={AUTH.page}>
      <style>{AUTH.css}</style>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={AUTH.card}>
          <img src="/b4c-logo.png" alt="B4C — Before the Call" style={AUTH.logo} />
          <div style={AUTH.brandLine}>Before the Call</div>

          <div style={AUTH.heading}>{firstTime ? "Create your password" : "Set a new password"}</div>
          <div style={AUTH.body}>
            {firstTime
              ? "Before you continue, choose a password. You'll use it to sign in from now on."
              : "Type a new password and you're in."}{" "}
            Turn on “Show password” so you can see what you type.
          </div>

          <input
            className="b4c-input"
            type={show ? "text" : "password"}
            placeholder={firstTime ? "Choose a password" : "New password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoFocus
            style={{ ...AUTH.input, marginBottom: 10 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: AUTH.muted, cursor: "pointer", marginBottom: 14, userSelect: "none" }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
          </label>

          {/* Live requirements — every rule visible from the start (never a surprise on submit) and
              ticking green as it's satisfied. aria-live so a screen reader announces each one passing. */}
          <div aria-live="polite" style={{ ...AUTH.panel, margin: "0 0 14px", padding: "11px 12px" }}>
            <div style={{ fontSize: 12, color: AUTH.muted, fontWeight: 600, marginBottom: 7 }}>Your password needs:</div>
            {PASSWORD_RULES.map((r) => {
              const met = r.test(password);
              return (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, lineHeight: 1.7, color: met ? AUTH.ok : AUTH.muted }}>
                  <span aria-hidden="true" style={{ width: 14, textAlign: "center", fontWeight: 700 }}>{met ? "✓" : "○"}</span>
                  <span>{r.label}</span>
                  <span style={{ position: "absolute", left: -9999 }}>{met ? " — met" : " — not yet met"}</span>
                </div>
              );
            })}
          </div>

          {err && <div style={{ fontSize: 13, color: AUTH.err, marginBottom: 12 }}>{err}</div>}

          <button
            onClick={save}
            disabled={!ready}
            style={{ ...AUTH.primary, cursor: ready ? "pointer" : "default", opacity: ready ? 1 : 0.7 }}
          >
            {loading ? "Saving…" : !hasSession ? "Preparing…" : firstTime ? "Save password & continue" : "Save password & sign in"}
          </button>
        </div>

        {/* AN EXIT, for the onboarding gate only. This screen renders INSTEAD of the app, and the
            normal Sign-out control lives inside the app — so without this, somebody on the wrong
            device or fighting a password manager is stuck with nowhere to go. It does not weaken
            the gate: they still cannot reach the app without setting a password.
            Not shown on the recovery variant, where signing out would throw away a live recovery
            session and force them to request a fresh link. */}
        {firstTime && (
          <button
            onClick={() => supabase.auth.signOut()}
            style={{ ...AUTH.link, display: "block", margin: "16px auto 0", fontSize: 13, cursor: "pointer" }}
          >
            Sign out instead
          </button>
        )}
      </div>
    </div>
  );
}
