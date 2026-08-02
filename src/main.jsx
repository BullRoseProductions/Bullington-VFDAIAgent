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

// Proactively re-auth a resumed phone BEFORE the user acts, so a stale access token never reaches
// a write. A locked/backgrounded phone suspends the SDK's auto-refresh timer; on resume the token
// may be expired or about to be. Refresh if it's expired or expiring within 2 min. This PREVENTS
// the stale-token race; authFetch in supabaseClient is the safety net that RECOVERS from it.
async function refreshAuthIfStale() {
  try {
    const { data } = await supabase.auth.getSession();
    const s = data && data.session;
    if (!s) return;
    const secsLeft = (s.expires_at || 0) - Math.floor(Date.now() / 1000);
    if (secsLeft < 120) await supabase.auth.refreshSession();
  } catch { /* the next request's authFetch guard will still handle a stale token */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { checkForUpdate(false); refreshAuthIfStale(); }
});

/* Password rules — ONE source of truth, used by both the live checklist and the Save gate, so the
   hints can never show all-green while save() still refuses (or the reverse).
   The symbol class is the explicit set Supabase's own policy uses rather than "any non-alphanumeric":
   a lone space would pass a /[^A-Za-z0-9]/ test here and still be rejected server-side, which is
   exactly the contradiction this screen exists to avoid. */
const PASSWORD_RULES = [
  { id: "len",    label: "At least 8 characters",        test: (p) => p.length >= 8 },
  { id: "upper",  label: "One uppercase letter (A–Z)",   test: (p) => /[A-Z]/.test(p) },
  { id: "lower",  label: "One lowercase letter (a–z)",   test: (p) => /[a-z]/.test(p) },
  { id: "digit",  label: "One number (0–9)",             test: (p) => /[0-9]/.test(p) },
  { id: "symbol", label: "One symbol (! ? # $ …)",       test: (p) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(p) },
];
const unmetRules = (p) => PASSWORD_RULES.filter((r) => !r.test(p || ""));

// Supabase can still refuse a password our checklist accepts — notably `pwned`, a breach-list hit we
// cannot test client-side. Turn every one of those into plain language; never surface the raw string.
function friendlyPasswordError(error) {
  const reasons = Array.isArray(error?.reasons) ? error.reasons : [];
  const weak = error?.code === "weak_password" || reasons.length > 0;
  if (!weak) return error?.message || "Something went wrong saving your password. Please try again.";
  if (reasons.includes("pwned")) return "That password has shown up in a known data breach, so it isn't safe to use. Please pick a different one.";
  if (reasons.includes("length")) return "That password is too short. Use at least 8 characters.";
  if (reasons.includes("characters")) return "That password needs a wider mix — check the list above and add what's missing.";
  return "That password isn't strong enough yet. Check the list above and add what's missing.";
}

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
    setLoading(false);
    if (error) { setErr(friendlyPasswordError(error)); return; }
    onDone(); // recovery session is already live → straight into the app, signed in
  }

  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg, #0A0E1A 0%, #0B0D14 45%, #080A10 100%)", fontFamily: "system-ui, sans-serif", padding: 20, paddingTop: "calc(20px + env(safe-area-inset-top))", paddingBottom: "calc(20px + env(safe-area-inset-bottom))" }}>
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

          {/* Live requirements — every rule visible from the start (never a surprise on submit) and
              ticking green as it's satisfied. aria-live so a screen reader announces each one passing. */}
          <div aria-live="polite" style={{ margin: "0 0 14px", padding: "11px 12px", background: "rgba(90,130,200,.06)", border: "1px solid rgba(90,130,200,.14)", borderRadius: 10 }}>
            <div style={{ fontSize: 12, color: "#8FA3C4", fontWeight: 600, marginBottom: 7 }}>Your password needs:</div>
            {PASSWORD_RULES.map((r) => {
              const met = r.test(password);
              return (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, lineHeight: 1.7, color: met ? "#76C98D" : "#8FA3C4" }}>
                  <span aria-hidden="true" style={{ width: 14, textAlign: "center", fontWeight: 700 }}>{met ? "✓" : "○"}</span>
                  <span>{r.label}</span>
                  <span style={{ position: "absolute", left: -9999 }}>{met ? " — met" : " — not yet met"}</span>
                </div>
              );
            })}
          </div>

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
