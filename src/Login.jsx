import { useState } from "react";
import { supabase } from "./supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

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
    if (!email.trim()) { setErr("Please enter your email."); return; }
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setSent(true);
  }

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

          <div style={{ borderTop: "1px solid rgba(90,130,200,.14)", paddingTop: 14 }}>
            {sent ? (
              <div style={{ fontSize: 13.5, color: "#76C98D", lineHeight: 1.5 }}>
                Check your email — we sent a sign-in link to <b>{email}</b>.
              </div>
            ) : (
              <button
                onClick={sendLink}
                disabled={loading}
                style={{ width: "100%", padding: "9px", fontSize: 13.5, fontWeight: 600, color: "#8FA3C4", background: "rgba(90,130,200,.06)", border: "1px solid rgba(90,130,200,.20)", borderRadius: 10, cursor: "pointer" }}
              >
                Or email me a login link instead
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
