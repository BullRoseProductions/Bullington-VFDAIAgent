import { useState } from "react";
import { supabase } from "./supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

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
        <div style={{ fontSize: 14, color: "#6A7178", marginBottom: 20 }}>Sign in with your email to continue.</div>

        {sent ? (
          <div style={{ fontSize: 14.5, color: "#2E7D52", lineHeight: 1.5 }}>
            Check your email — we sent a sign-in link to <b>{email}</b>. Open it on this device to log in.
          </div>
        ) : (
          <>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendLink()}
              style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 15, borderRadius: 10, border: "1px solid #D9D5E2", marginBottom: 12 }}
            />
            {err && <div style={{ fontSize: 13, color: "#B11E2A", marginBottom: 12 }}>{err}</div>}
            <button
              onClick={sendLink}
              disabled={loading}
              style={{ width: "100%", padding: "11px", fontSize: 15, fontWeight: 700, color: "#fff", background: "#B11E2A", border: "none", borderRadius: 10, cursor: "pointer", opacity: loading ? 0.7 : 1 }}
            >
              {loading ? "Sending…" : "Email me a login link"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
