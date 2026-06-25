import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import Login from "./Login.jsx";
import { supabase } from "./supabaseClient";

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

  return (
    <>
      <button
        onClick={() => supabase.auth.signOut()}
        style={{ position: "fixed", top: 10, right: 10, zIndex: 9999, fontSize: 12, padding: "6px 10px", borderRadius: 8, border: "1px solid #D9D5E2", background: "#fff", color: "#3A4750", cursor: "pointer" }}
      >
        Sign out
      </button>
      <App />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
