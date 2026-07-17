import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import Login from "./Login.jsx";
import { supabase } from "./supabaseClient";

/* ---------------- Password-recovery URL capture ----------------
 * A reset link lands with `#...type=recovery` in the hash. The auth SDK's
 * onAuthStateChange PASSWORD_RECOVERY event is unreliable here: it's emitted from
 * the SDK's auto-initialize() at module import via setTimeout(0) and races React's
 * useEffect subscription — if the emit wins, the event hits zero listeners and is
 * lost, and the SDK then wipes the hash (window.location.hash = ''), so a later read
 * finds nothing. So we read the marker SYNCHRONOUSLY at module scope, on the import
 * stack, BEFORE the SDK's async initialize() clears it. Seeds `recovery` below. */
const IS_RECOVERY =
  typeof window !== "undefined" &&
  (window.location.hash.includes("type=recovery") ||
    new URLSearchParams(window.location.search).get("type") === "recovery");

/* ---------------- Stale-bundle guard (no service worker) ----------------
 * index.html points at a content-hashed bundle. Installed PWAs — iOS standalone especially —
 * keep the OLD index.html (and old bundle) cached until the app is force-quit, so deployed
 * fixes silently never reach the phone. We bake BUILD_ID into this bundle (vite define) and
 * compare it to a freshly-fetched /version.json on load AND on every foreground (the iOS
 * home-screen resume trigger). Mismatch => a newer deploy exists: reload on cold start
 * (loop-guarded), or surface an "Update now" banner mid-session. Cache-Control headers in
 * vercel.json make the reload actually fetch the new index.html. */
const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
async function fetchDeployedBuild() {
  try {
    const res = await fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;                         // dev (no file) or transient error -> skip
    const data = await res.json();
    return data && typeof data.build === "string" ? data.build : null;
  } catch { return null; }
}
function showUpdateBanner() {
  if (document.getElementById("b4c-update-banner")) return;
  if (!document.body) { document.addEventListener("DOMContentLoaded", showUpdateBanner, { once: true }); return; }
  const bar = document.createElement("div");
  bar.id = "b4c-update-banner";
  bar.setAttribute("role", "status");
  bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:#0F1B33;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.4)";
  bar.appendChild(Object.assign(document.createElement("span"), { textContent: "A new version of B4C is available." }));
  const btn = Object.assign(document.createElement("button"), { textContent: "Update now" });
  btn.style.cssText = "background:#fff;color:#0F1B33;border:none;border-radius:999px;padding:8px 16px;font:700 14px system-ui,sans-serif;cursor:pointer";
  btn.onclick = () => location.reload();
  bar.appendChild(btn);
  document.body.appendChild(bar);
}
async function checkForUpdate(isColdStart) {
  const deployed = await fetchDeployedBuild();
  if (!deployed || deployed === BUILD_ID) return;     // current (or can't tell) -> nothing to do
  const alreadyTried = sessionStorage.getItem("b4c_reloaded_for");
  if (isColdStart && alreadyTried !== deployed) {
    sessionStorage.setItem("b4c_reloaded_for", deployed);   // guard: one auto-reload per deploy id (avoids loops during CDN propagation)
    location.reload();
  } else {
    showUpdateBanner();                               // mid-session resume, or we already auto-reloaded once -> let the user choose
  }
}
checkForUpdate(true);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(false); });

// Set-new-password screen. Only shown after a reset link lands and Supabase fires
// PASSWORD_RECOVERY (see Root). Built for the lowest common denominator: ONE field
// plus a Show-password toggle — no confirm field, because a confirm-mismatch is the
// exact dead-end that loses non-technical users. Letting them SEE what they typed is
// safer than making them type it twice. On success they're already in a live session,
// so onDone drops them straight into the app — no second login.
function SetNewPassword({ hasSession, onDone }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // The recovery screen shows the instant we spot type=recovery, but the token
  // validates a beat later (a network round-trip). Gate Save on the live session so a
  // fast typer can't fire updateUser before it lands — a disabled-then-enabled button
  // beats an error our audience would have to decode and retry.
  const ready = hasSession && !loading;

  async function save() {
    setErr("");
    if (!ready) return;
    if (!password || password.length < 6) { setErr("Pick a password with at least 6 characters."); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) { setErr(error.message); return; }
    onDone(); // recovery session is already live → straight into the app, signed in
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg, #0A0E1A 0%, #0B0D14 45%, #080A10 100%)", fontFamily: "system-ui, sans-serif", padding: 20 }}>
      <style>{`.b4c-input:focus{outline:none;border-color:#2E6FC7;box-shadow:0 0 0 3px rgba(46,111,199,.25)} .b4c-input::placeholder{color:#5D6B85}`}</style>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <img src="/B4C-Main.png" alt="Before the Call" style={{ display: "block", width: "100%", maxWidth: 360, height: "auto", margin: "0 auto 24px" }} />
        <div style={{ background: "#0E1220", borderRadius: 16, border: "1px solid rgba(90,130,200,.14)", padding: 26, boxShadow: "0 12px 34px rgba(0,0,0,.5)" }}>
          <div style={{ fontSize: 16, color: "#EAEEF5", fontWeight: 700, textAlign: "center", margin: "0 0 6px" }}>Set a new password</div>
          <div style={{ fontSize: 13, color: "#8FA3C4", textAlign: "center", margin: "0 0 18px", lineHeight: 1.5 }}>
            Type a new password and you're in. Turn on “Show password” so you can see what you type.
          </div>

          <input
            className="b4c-input"
            type={show ? "text" : "password"}
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoFocus
            style={{ width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 15, borderRadius: 10, border: "1px solid rgba(90,130,200,.22)", background: "#10141F", color: "#EAEEF5", colorScheme: "dark", marginBottom: 10 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: "#8FA3C4", cursor: "pointer", marginBottom: 14, userSelect: "none" }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
          </label>

          {err && <div style={{ fontSize: 13, color: "#E58A90", marginBottom: 12 }}>{err}</div>}

          <button
            onClick={save}
            disabled={!ready}
            style={{ width: "100%", padding: "11px", fontSize: 15, fontWeight: 700, color: "#fff", background: "#2E6FC7", border: "none", borderRadius: 10, cursor: ready ? "pointer" : "default", opacity: ready ? 1 : 0.7, boxShadow: "0 4px 16px rgba(46,111,199,.35)" }}
          >
            {loading ? "Saving…" : !hasSession ? "Preparing…" : "Save password & sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Root() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState(IS_RECOVERY); // seeded from URL; event is a backup

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // A reset link establishes a real session AND fires PASSWORD_RECOVERY. Flag it so
      // we show the set-new-password screen instead of silently dropping them in the app.
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", color: "#6A7178" }}>
        Loading…
      </div>
    );
  }

  if (recovery) return <SetNewPassword hasSession={!!session} onDone={() => setRecovery(false)} />;

  if (!session) return <Login />;

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
