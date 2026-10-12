import { useState, useEffect } from "react";
import { supabase, APP_URL, APP_ORIGIN } from "./supabaseClient";
import { readFreshPendingScan, scanRedirectUrl } from "./pendingScan";
// The cooldown and the sender are shared with the admin-side resend in App.jsx: all of these
// buttons draw on ONE project-wide auth-email allowance, so the guard has to be one definition.
import { RESEND_COOLDOWN, sendLoginLink } from "./authLinks";
import { AUTH } from "./theme.js";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(null); // null | "link" | "reset"
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0); // seconds left before an email can be re-sent

  // Tick the resend cooldown down once per second. Both email buttons share it — they
  // hit the same auth-email rate limit — so a confused user can't tap 5 times and trip it.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function signInPassword() {
    setErr("");
    if (!email.trim() || !password) { setErr("Enter your email and password."); return; }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);
    if (error) { setErr(error.message); return; }
    // success — main.jsx will detect the session and show the app
  }

  async function sendLink() {
    setErr("");
    if (!email.trim()) { setErr("Enter your email first."); return; }
    setLoading(true);
    /* SEND THEM BACK TO THE CODE THEY SCANNED, not to a bare dashboard.
       A member who scanned a drill QR and was stopped by this screen has a pending scan stashed
       (see pendingScan.js). Returning them to APP_URL drops it from the URL entirely, which is
       half of why the check-in was being lost.
       This is HARDENING, not the mechanism: the replay in App.jsx performs the check-in from
       localStorage wherever they land. It matters because the emailed link often opens a new tab,
       and because it is the one path that still works if the returning tab cannot read storage.
       ONLY when a fresh stash exists — an ordinary login is untouched. */
    const scan = readFreshPendingScan();
    const redirect = (scan && scanRedirectUrl(APP_ORIGIN, scan)) || APP_URL;
    const { error } = await sendLoginLink(email, { redirect });
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setSent("link");
    setCooldown(RESEND_COOLDOWN);
  }

  // Forgot password: Supabase emails a reset link back to APP_URL (the same proven
  // redirect the magic link uses). Clicking it fires a PASSWORD_RECOVERY event that
  // main.jsx catches to show the set-new-password screen. Supabase owns the token,
  // expiry, and verification — we only kick off the email.
  async function resetPassword() {
    setErr("");
    if (!email.trim()) { setErr("Enter your email first, then tap “Forgot password?”"); return; }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: APP_URL });
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setSent("reset");
    setCooldown(RESEND_COOLDOWN);
  }

  // Both email buttons are locked while a request is in flight OR during the shared cooldown.
  const busy = loading || cooldown > 0;

  return (
    <div style={AUTH.page}>
      <style>{AUTH.css}</style>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={AUTH.card}>
          <img src="/b4c-logo.png" alt="B4C — Before the Call" style={AUTH.logo} />
          <div style={AUTH.brandLine}>Before the Call</div>

          <div style={AUTH.body}>Sign in to continue.</div>

          <input
            className="b4c-input"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ ...AUTH.input, marginBottom: 10 }}
          />
          <input
            className="b4c-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && signInPassword()}
            style={{ ...AUTH.input, marginBottom: 12 }}
          />

          {err && <div style={{ fontSize: 13, color: AUTH.err, marginBottom: 12 }}>{err}</div>}

          <button
            onClick={signInPassword}
            disabled={loading}
            style={{ ...AUTH.primary, cursor: "pointer", opacity: loading ? 0.7 : 1, marginBottom: 14 }}
          >
            {loading ? "Working…" : "Sign in"}
          </button>

          <button
            onClick={resetPassword}
            disabled={busy}
            style={{ ...AUTH.link, display: "block", width: "100%", margin: "0 0 14px", padding: "2px 0", fontSize: 13, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}
          >
            {cooldown > 0 && sent === "reset" ? `Resend in ${cooldown}s…` : "Forgot password?"}
          </button>

          <div style={{ borderTop: AUTH.divider, paddingTop: 14 }}>
            {sent && (
              <div style={{ fontSize: 13.5, color: AUTH.ok, lineHeight: 1.5, marginBottom: 12 }}>
                Sent — check your email. We sent a {sent === "reset" ? "password-reset" : "sign-in"} link to <b>{email}</b>.{sent === "reset" ? " Tap it, then pick a new password." : ""}
              </div>
            )}
            <button
              onClick={sendLink}
              disabled={busy}
              style={{ ...AUTH.secondary, cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}
            >
              {cooldown > 0 && sent === "link" ? `Resend in ${cooldown}s…` : "Or email me a login link instead"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
