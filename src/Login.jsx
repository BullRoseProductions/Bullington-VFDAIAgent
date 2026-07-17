import { useState, useEffect } from "react";
import { supabase, APP_URL } from "./supabaseClient";

const RESEND_COOLDOWN = 30; // seconds — protects Supabase's auth-email rate limit from repeat taps

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
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: APP_URL },
    });
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
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg, #0A0E1A 0%, #0B0D14 45%, #080A10 100%)", fontFamily: "system-ui, sans-serif", padding: 20 }}>
      <style>{`
        .b4c-input { transition: border-color .15s ease, box-shadow .15s ease; }
        .b4c-input:focus { outline: none; border-color: #2E6FC7; box-shadow: 0 0 0 3px rgba(46,111,199,.25); }
        .b4c-input::placeholder { color: #5D6B85; }
      `}</style>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <img
          src="/B4C-Main.png"
          alt="Before the Call — Keeping Responders Prepared"
          style={{ display: "block", width: "100%", maxWidth: 360, height: "auto", margin: "0 auto 24px" }}
        />
        <div style={{ background: "#0E1220", borderRadius: 16, border: "1px solid rgba(90,130,200,.14)", padding: 26, boxShadow: "0 12px 34px rgba(0,0,0,.5)" }}>
          <div style={{ fontSize: 13, color: "#8FA3C4", textAlign: "center", margin: "0 0 18px" }}>Sign in to continue.</div>

          <input
            className="b4c-input"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 15, borderRadius: 10, border: "1px solid rgba(90,130,200,.22)", background: "#10141F", color: "#EAEEF5", colorScheme: "dark", marginBottom: 10 }}
          />
          <input
            className="b4c-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && signInPassword()}
            style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 15, borderRadius: 10, border: "1px solid rgba(90,130,200,.22)", background: "#10141F", color: "#EAEEF5", colorScheme: "dark", marginBottom: 12 }}
          />

          {err && <div style={{ fontSize: 13, color: "#E58A90", marginBottom: 12 }}>{err}</div>}

          <button
            onClick={signInPassword}
            disabled={loading}
            style={{ width: "100%", padding: "11px", fontSize: 15, fontWeight: 700, color: "#fff", background: "#2E6FC7", border: "none", borderRadius: 10, cursor: "pointer", opacity: loading ? 0.7 : 1, boxShadow: "0 4px 16px rgba(46,111,199,.35)", marginBottom: 14 }}
          >
            {loading ? "Working…" : "Sign in"}
          </button>

          <button
            onClick={resetPassword}
            disabled={busy}
            style={{ display: "block", width: "100%", margin: "0 0 14px", padding: "2px 0", fontSize: 13, fontWeight: 600, color: "#8FA3C4", background: "none", border: "none", cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1, textDecoration: "underline", fontFamily: "inherit" }}
          >
            {cooldown > 0 && sent === "reset" ? `Resend in ${cooldown}s…` : "Forgot password?"}
          </button>

          <div style={{ borderTop: "1px solid rgba(90,130,200,.14)", paddingTop: 14 }}>
            {sent && (
              <div style={{ fontSize: 13.5, color: "#76C98D", lineHeight: 1.5, marginBottom: 12 }}>
                Sent — check your email. We sent a {sent === "reset" ? "password-reset" : "sign-in"} link to <b>{email}</b>.{sent === "reset" ? " Tap it, then pick a new password." : ""}
              </div>
            )}
            <button
              onClick={sendLink}
              disabled={busy}
              style={{ width: "100%", padding: "9px", fontSize: 13.5, fontWeight: 600, color: "#8FA3C4", background: "rgba(90,130,200,.06)", border: "1px solid rgba(90,130,200,.20)", borderRadius: 10, cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}
            >
              {cooldown > 0 && sent === "link" ? `Resend in ${cooldown}s…` : "Or email me a login link instead"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
