/* THE ROUTER (R1): real URLs over the app's existing `screen` state. Hand-written by ruling; there's no library, because
   the app already has one navigation choke point (`go` in App.jsx) and a router library would mean re-plumbing 30 screens.

   WHAT IT OWNS: the path for each top-level screen, push / replace / popstate, and the main panel's scroll on navigation.
   WHAT IT NEVER TOUCHES:
     • /checkin and /handoff, the one-shot QR links (printed codes in the wild point at them). They are outside the route
       table; routeDeepLink in App.jsx still owns them, their parameters and their URL clear.
     • The HASH. Supabase delivers sign-in, invite and reset tokens in it (#access_token=…, #type=recovery), and main.jsx
       reads it at module scope before the SDK clears it. Every URL written here carries `location.hash` through
       verbatim; nothing here reads or parses it.
     • The app-update place-restore (src/appUpdate.js), which is unchanged; App decides how a restored place and the URL
       agree.

   Paths are user-facing, readable kebab-case; the keys stay internal. Ids in paths are dot-free ([A-Za-z0-9_-]): the
   native WebView's local server only falls back to index.html for a path whose last segment has no ".". */

export const ROUTES = [
  ["dashboard", "/"],
  ["notifications", "/notifications"],
  ["training", "/training"],
  ["library", "/training/library"],
  ["roster", "/roster"],
  ["onboarding", "/onboarding"],
  ["apparatus", "/apparatus"],
  ["qualifications", "/qualifications"],
  ["equipment", "/equipment"],
  ["myequipment", "/my-equipment"],
  ["stationhours", "/station-hours"],
  ["duties", "/duties"],
  ["recruit", "/recruitment"],
  ["funding", "/funding"],
  ["visibility", "/public-relations"],
  ["minutes", "/meetings"],
  ["reports", "/reports"],
  ["expirations", "/expirations"],
  ["readiness", "/readiness"],
  ["study", "/study"],
  ["qanda", "/station-qa"],
  ["documents", "/documents"],
  ["readsign", "/read-sign"],
  ["resources", "/your-six"],
  ["settings", "/settings"],
  ["admin", "/admin"],
  ["adddept", "/add-department"],
  ["department", "/department"],
];
const PATH_OF = new Map(ROUTES);
const KEY_OF = new Map(ROUTES.map(([k, p]) => [p, k]));
const PACKET_PREFIX = "/training/library/";       // + a library drill id → the "packet" screen
export const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;   // never a ".", never a "/"
export const ONE_SHOT_PATHS = ["/checkin", "/handoff"];

const norm = (p) => { const s = String(p || "/").replace(/\/+$/, ""); return s === "" ? "/" : s; };
export const isOneShotPath = (pathname) => ONE_SHOT_PATHS.includes(norm(pathname));

/* The path for a screen, or null when it has none: checkin / handoff (one-shot), the retired "ai", an unknown key, or a
   packet without a safe id. */
export function pathFor(screen, { packetId } = {}) {
  if (screen === "packet") return SAFE_ID.test(String(packetId ?? "")) ? PACKET_PREFIX + packetId : null;
  return PATH_OF.get(screen) || null;
}

/* A pathname → { screen, packetId } or null. Null = "not ours": an unknown path, or a one-shot path (routeDeepLink's).
   Search and hash are never looked at. */
export function parsePath(pathname) {
  const p = norm(pathname);
  if (isOneShotPath(p)) return null;
  if (p.startsWith(PACKET_PREFIX)) {
    const id = p.slice(PACKET_PREFIX.length);
    return SAFE_ID.test(id) ? { screen: "packet", packetId: id } : null;
  }
  const k = KEY_OF.get(p);
  return k ? { screen: k, packetId: null } : null;
}

// ---- writing the address bar: the hash rides through untouched ----
const canWrite = () => typeof window !== "undefined" && !!window.history && typeof window.history.pushState === "function";
const urlFor = (path, keepSearch) => path + (keepSearch ? window.location.search : "") + window.location.hash;

/* The main panel ([data-b4c-scroll="main"]) is the app's scroller, not the window. */
export const mainScroller = () => (typeof document === "undefined" ? null : document.querySelector('[data-b4c-scroll="main"]'));

/* Remember where the person was scrolled on the entry they're LEAVING, so Back can put them there. Called just before a
   screen change (go / openPacket), while the old screen is still on the page. */
export function saveOutgoingScroll() {
  if (!canWrite()) return;
  try {
    const el = mainScroller();
    const st = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
    window.history.replaceState({ ...st, scroll: Math.round(el ? el.scrollTop : 0) }, "", urlFor(window.location.pathname, true));
  } catch { /* best-effort */ }
}

/* A new screen: a new history entry. A different path drops the old page's search (it belonged to that page). */
export function pushRoute(path, state) {
  if (!canWrite()) return;
  try { window.history.pushState({ ...state, b4c: 1 }, "", urlFor(path, false)); } catch { /* best-effort */ }
}

/* The same entry, rewritten: a redirect, a role switch, sign-out, or a state change on the same screen. The search is
   kept when the path doesn't change. */
export function replaceRoute(path, state) {
  if (!canWrite()) return;
  try { window.history.replaceState({ ...(state || {}), b4c: 1 }, "", urlFor(path, norm(path) === norm(window.location.pathname))); } catch { /* best-effort */ }
}

export function scrollMainTo(y) { const el = mainScroller(); if (el) el.scrollTop = y; }

/* Back / Forward: put the panel back where it was. The screen's content arrives over a few frames as its data loads,
   so retry until the position is reachable (or ~1 s passes), and stop the moment the person scrolls or taps. */
export function restoreMainScroll(y) {
  const target = Math.max(0, Math.round(Number(y) || 0));
  let tries = 0, stopped = false;
  const stop = () => { stopped = true; };
  if (typeof window !== "undefined") { window.addEventListener("wheel", stop, { once: true, passive: true }); window.addEventListener("touchstart", stop, { once: true, passive: true }); }
  const step = () => {
    if (stopped) return;
    const el = mainScroller();
    if (el) {
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) <= 1 || target === 0) return;
    }
    if (++tries < 60 && typeof requestAnimationFrame === "function") requestAnimationFrame(step);
  };
  step();
}

/* ---------------- THE PENDING PATH: a deep URL held across the magic-link round-trip ----------------
   Same shape and reasons as src/pendingScan.js. Someone signed out opens app.b4thecall.com/reports; main.jsx shows
   <Login/>. A password login re-renders on the same URL, so nothing is needed. A magic link returns to the bare APP_URL
   ("/"), usually in a new tab, so the path would be lost. So the path is captured at module scope (main.jsx, before the
   gate), held in localStorage (shared across tabs) for 30 minutes, and consumed once by App on its first mount, only when
   it landed on "/" and no QR scan is in play. Every access is guarded; on any failure it no-ops. */
export const PENDING_PATH_KEY = "b4c_pending_path";
export const PENDING_PATH_TTL_MS = 30 * 60 * 1000;
function store(storage) {
  if (storage) return storage;
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}
export function capturePendingPath(pathname, storage) {
  const s = store(storage);
  if (!s) return null;
  try {
    const p = norm(pathname);
    if (p === "/" || !parsePath(p)) return null;   // only a real, non-root, routable path (never a one-shot one)
    s.setItem(PENDING_PATH_KEY, JSON.stringify({ path: p, ts: Date.now() }));
    return p;
  } catch { return null; }
}
/* Read AND delete (delete first; see pendingScan.consumePendingScan). The path if fresh and still routable; else null. */
export function consumePendingPath(storage) {
  const s = store(storage);
  if (!s) return null;
  let v = null;
  try { v = JSON.parse(s.getItem(PENDING_PATH_KEY) || "null"); } catch { v = null; }
  try { s.removeItem(PENDING_PATH_KEY); } catch { /* nothing more to do */ }
  const ok = v && typeof v.path === "string" && typeof v.ts === "number" && v.ts <= Date.now() && Date.now() - v.ts < PENDING_PATH_TTL_MS;
  return ok && parsePath(v.path) ? v.path : null;
}
