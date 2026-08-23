import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import Login from "./Login.jsx";
import { supabase } from "./supabaseClient";
import { SetNewPassword } from "./SetPassword.jsx";

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

function Root() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState(IS_RECOVERY); // seeded from URL; event is a backup
  /* null = still checking. The THIRD state matters: rendering <App/> while the answer is in flight
     would flash the whole app at somebody who is about to be told to set a password. */
  const [pwOk, setPwOk] = useState(null);

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

  /* THE SET-PASSWORD GATE. An invited member arrives by magic link, which establishes a real
     session — so without this they land in the app having never chosen a password, and cannot get
     back in once the link expires.

     DEPENDS ON THE USER ID, NOT THE SESSION OBJECT. onAuthStateChange replaces `session` on every
     TOKEN_REFRESHED, roughly hourly and forever; depending on it would re-run this RPC for the life
     of the session.

     FAILS OPEN. If the check errors — function missing, PostgREST cache stale, network gone — we
     let them through. A detector that locks the entire roster out of the app is a far worse
     outcome than the gap it exists to close, and this is a UX gate rather than a security
     boundary. */
  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId) { setPwOk(null); return; }
    let cancelled = false;
    supabase.rpc("has_password").then(({ data, error }) => {
      if (!cancelled) setPwOk(error ? true : data === true);
    });
    return () => { cancelled = true; };
  }, [userId]);

  /* After a successful save. updateUser() already returned success, so the password IS set — that
     is authoritative and we proceed on it. The re-check runs anyway, but only to WARN: gating again
     on a disagreeing read would loop a member who has done everything asked of them. */
  function proceedAfterSet() {
    setPwOk(true);
    supabase.rpc("has_password").then(({ data, error }) => {
      if (!error && data !== true) console.warn("[b4c] password saved but has_password() still false");
    });
  }

  const loading = (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", color: "#6A7178" }}>
      Loading…
    </div>
  );

  if (!ready) return loading;

  /* RECOVERY STAYS FIRST. A Forgot-password link must reach the reset screen even for a member who
     is also gated.

     onDone CLEARS THE GATE TOO, and that is not belt-and-braces. The pwOk effect keys on the user
     id, which does not change when `recovery` flips — so a member who arrived here with
     password_set = false already has pwOk cached as false, and dropping only the recovery flag
     would hand them straight to the firstTime gate seconds after they successfully set a password.
     save() has already marked the flag; proceedAfterSet is the same "we just set one, go" path the
     gate itself uses, so there is one definition of it rather than two. */
  if (recovery) {
    return <SetNewPassword hasSession={!!session}
                           onDone={() => { setRecovery(false); proceedAfterSet(); }} />;
  }

  if (!session) return <Login />;

  if (pwOk === null) return loading;                    // never flash <App/> mid-check
  if (pwOk === false) return <SetNewPassword firstTime hasSession={!!session} onDone={proceedAfterSet} />;

  return <App />;
}

/* LAST RESORT, below the per-screen boundary in App.jsx.
   That one keeps the nav alive when a single screen throws, which covers the common case. It
   cannot help if the throw is in the shell ITSELF — the sidebar, the topbar, the auth gate above —
   because those render outside it. This catches that, and deliberately offers only a reload: there
   is no menu left to navigate with, so pretending otherwise would be a dead end.

   Styles are inline literals rather than the FIRE tokens: those live in App.jsx, and importing
   them here would mean this fallback depends on the very module most likely to be the thing that
   just failed to evaluate. A last resort should have no interesting dependencies. */
class RootBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("[RootBoundary]", error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#0E1014", color: "#F7F8FA", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif" }}>
        <div style={{ maxWidth: 460 }}>
          <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>B4C couldn't load.</div>
          <div style={{ fontSize: 14, color: "#A8B0BC", lineHeight: 1.55, marginBottom: 16 }}>
            Something went wrong starting the app. Your data is safe. Reloading usually clears it.
          </div>
          <button onClick={() => window.location.reload()}
                  style={{ background: "#B11E2A", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Reload</button>
          <details style={{ marginTop: 14 }}>
            <summary style={{ fontSize: 12, color: "#7C8798", cursor: "pointer" }}>Technical details</summary>
            <div style={{ fontSize: 12, color: "#7C8798", marginTop: 6, fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-word" }}>
              {String(this.state.error?.message || this.state.error)}
            </div>
          </details>
        </div>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RootBoundary>
      <Root />
    </RootBoundary>
  </React.StrictMode>
);
