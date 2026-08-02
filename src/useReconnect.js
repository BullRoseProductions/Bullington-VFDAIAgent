import { useEffect, useRef } from "react";

/* Auto-recovery for one-shot data loads.
   The bug this exists for: a loader runs once in an empty-deps useEffect, the device is offline, the
   read fails, and nothing ever retries — the screen stays blank until the app is killed and reopened.

   Two signals, both built into the WebView — no native plugin, no @capacitor/network:
     • window 'online'          — fires when the OS regains connectivity
     • visibilitychange→visible — fires when the app returns to the foreground, which is the common
                                  recovery path: the user unlocks the phone after signal came back.
   The second is the important one on iOS. WKWebView's 'online' event can be missed if the app was
   suspended at the moment the network came back, so resume is the reliable backstop. main.jsx already
   relies on visibilitychange for the stale-bundle check and token refresh, so it's proven on device.

   Callers pass a callback that should decide whether a refetch is warranted (typically: only if the
   last load failed), so a routine app-resume while healthy doesn't restampede every query. */
export function useReconnect(onReconnect) {
  const cb = useRef(onReconnect);
  cb.current = onReconnect;   // always invoke the latest closure without re-registering listeners

  useEffect(() => {
    let lastFired = 0;
    const fire = (why) => {
      // Unlocking a phone that just regained signal fires BOTH events within milliseconds.
      // Collapse the burst so we issue one refetch, not two.
      const now = Date.now();
      if (now - lastFired < 1500) return;
      lastFired = now;
      cb.current?.(why);
    };
    const onOnline = () => fire("online");
    const onVisible = () => { if (document.visibilityState === "visible") fire("resume"); };

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

// navigator.onLine is only trustworthy in the negative: false reliably means no network, true just
// means an interface is up. Used for wording only — never to decide whether to attempt a fetch.
export const looksOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
