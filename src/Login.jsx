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
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F4F3F7", fontFamily: "system-ui, sans-serif", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 380, background: "#fff", borderRadius: 16, border: "1px solid #E7E5EE", padding: 28, boxShadow: "0 6px 24px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#16181C", marginBottom: 4 }}>Department Login</div>
        <div style={{ fontSize: 14, color: "#6A7178", marginBottom: 20 }}>Sign in to continue.</div>

        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 15, borderRadius: 10, border: "1px solid #D9D5E2", marginBottom: 10 }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && signInPassword()}
          style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 15, borderRadius: 10, border: "1px solid #D9D5E2", marginBottom: 12 }}
        />

        {err && <div style={{ fontSize: 13, color: "#B11E2A", marginBottom: 12 }}>{err}</div>}

        <button
          onClick={signInPassword}
          disabled={loading}
          style={{ width: "100%", padding: "11px", fontSize: 15, fontWeight: 700, color: "#fff", background: "#B11E2A", border: "none", borderRadius: 10, cursor: "pointer", opacity: loading ? 0.7 : 1, marginBottom: 14 }}
        >
          {loading ? "Working…" : "Sign in"}
        </button>

        <div style={{ borderTop: "1px solid #EFEDF3", paddingTop: 14 }}>
          {sent ? (
            <div style={{ fontSize: 13.5, color: "#2E7D52", lineHeight: 1.5 }}>
              Check your email — we sent a sign-in link to <b>{email}</b>.
            </div>
          ) : (
            <button
              onClick={sendLink}
              disabled={loading}
              style={{ width: "100%", padding: "9px", fontSize: 13.5, fontWeight: 600, color: "#3A4750", background: "#fff", border: "1px solid #D9D5E2", borderRadius: 10, cursor: "pointer" }}
            >
              Or email me a login link instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
