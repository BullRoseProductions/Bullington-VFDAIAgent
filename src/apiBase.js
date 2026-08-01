import { Capacitor } from "@capacitor/core";

// WHERE THE SERVERLESS FUNCTIONS LIVE, depending on where the app is running.
//
// On the web, /api/claude and /api/image are same-origin paths on the Vercel deployment — a relative
// fetch is correct and must stay relative so preview deploys hit their OWN functions, not production.
//
// In a native Capacitor build the web assets are loaded from the local bundle, so the page origin is
// capacitor://localhost (iOS) or http://localhost (Android). A relative /api/... resolves against THAT
// origin, where no serverless function exists — every AI call would 404. Native therefore needs the
// absolute deployment origin.
//
// The base comes from VITE_APP_URL (already the production origin used for auth-email links) so a
// domain change updates this and the auth redirects together, rather than silently breaking one of them.
// The literal is only a fallback for a native build made without that var set.
const API_BASE = import.meta.env.VITE_APP_URL || "https://app.b4thecall.com";

export const isNative = () => Capacitor.isNativePlatform();

// apiUrl("/api/claude") → "/api/claude" on web, "https://app.b4thecall.com/api/claude" on device.
export function apiUrl(path) {
  if (!isNative()) return path;                       // web: unchanged, exactly as it behaves today
  return `${API_BASE.replace(/\/$/, "")}${path}`;     // tolerate a trailing slash on the env var
}
