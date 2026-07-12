import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import Login from "./Login.jsx";
import { supabase } from "./supabaseClient";

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

function Root() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
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

  if (!session) return <Login />;

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
