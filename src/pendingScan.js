/* THE SCANNED CODE, HELD ACROSS THE LOGIN WALL.

   THE BUG THIS EXISTS FOR. A member scans the drill sign-in QR with their phone camera. A camera
   scan does not fire a Universal Link, so the OS opens app.b4thecall.com/checkin?checkin=…&t=… in
   Safari rather than the app — and in Safari they usually have no session. main.jsx answers
   `if (!session) return <Login/>` BEFORE <App/> renders, and routeDeepLink lives inside <App/>. So
   the parameters are never read: the member sees "Sign in to continue", signs in, lands on the
   dashboard, and the check-in is simply lost. They believe they signed in at the drill. The roll
   says they were not there.

   The magic-link path was worse: emailRedirectTo pointed at the bare APP_URL, so even a successful
   login returned them to a root URL with the parameters already gone.

   THE SHAPE OF THE FIX. Capture the scan before the gate, carry it through login, replay it once
   there is a real member to attribute it to. This module owns the stash itself — the key, the TTL
   and the record shape — because three files touch it (main.jsx writes, Login.jsx reads to build
   the redirect, App.jsx consumes) and three copies of a TTL is how they come to disagree about
   what "fresh" means.

   localStorage, NOT sessionStorage, and that is the whole reason the magic-link path works: the
   emailed link often opens in a NEW TAB, and sessionStorage is per-tab. localStorage is shared
   across tabs of the same origin, so the stash written by the scan survives the round-trip through
   the mail app.

   EVERY ACCESS IS GUARDED. Private mode, disabled storage and quota errors all throw on plain
   property access, and this runs at module scope on the critical path — an uncaught throw here
   would mean a blank app, which is far worse than a lost check-in. On failure every function
   no-ops, and the already-authed same-tab path still works straight off the URL exactly as before.

   NATIVE IS A NO-OP BY CONSTRUCTION. On native the WebView loads from the local bundle, so
   window.location.search is empty at load and nothing is ever captured. The native path continues
   to arrive through deeplink.js into routeDeepLink, untouched. */

export const PENDING_SCAN_KEY = "b4c_pending_scan";

/* THIRTY MINUTES, and the bound is what makes this safe rather than tidy.

   The stash outlives the page that wrote it, so without an expiry a code scanned at Tuesday's
   drill could still be sitting in localStorage on Thursday and fire the moment that member next
   signed in — recording attendance at a drill they were not at, from a screen that gave them no
   reason to expect it. A scan-to-login round-trip, including waiting for an email, is minutes; a
   half hour is generous for the real case and short enough that the phantom case cannot reach a
   different day. */
export const PENDING_SCAN_TTL_MS = 30 * 60 * 1000;

// Injectable so the logic can be tested in node, where there is no window. Callers pass nothing.
function store(storage) {
  if (storage) return storage;
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

/* Read the scan out of a query string. Exported separately from the storage write so the parsing
   rule has one definition and can be tested without a DOM.

   PRECEDENCE MATCHES routeDeepLink: checkin is examined first, then handoff. Two routers that
   disagree about which parameter wins is exactly the divergence routeDeepLink's own comment warns
   about, so the order is copied deliberately rather than re-derived.

   A code with no token is still captured. The token is validated server-side by member_check_in,
   which already fails gracefully with "see your training officer" — and a stash that silently
   dropped half a scan would produce the same invisible nothing this whole module exists to stop. */
export function parseScan(search) {
  const p = new URLSearchParams(search || "");
  const cid = p.get("checkin");
  if (cid) return { kind: "checkin", id: cid, token: p.get("t") };
  const hid = p.get("handoff");
  if (hid) return { kind: "handoff", id: hid, token: p.get("t") };
  return null;
}

/* Called synchronously at module scope in main.jsx, before the auth gate renders — so the scan is
   captured whether or not the member is signed in.

   DOES NOT CLEAR THE URL. routeDeepLink still owns that, and only after it has matched something:
   the already-authed same-tab case must keep reading the parameters from the address bar exactly
   as it does today. Clearing here would break the path that currently works in order to fix the
   one that does not. */
export function capturePendingScan(search, storage) {
  const s = store(storage);
  if (!s) return null;
  try {
    const scan = parseScan(search);
    if (!scan) return null;
    s.setItem(PENDING_SCAN_KEY, JSON.stringify({ ...scan, ts: Date.now() }));
    return scan;
  } catch { return null; }
}

/* The stash if it is present, parseable and fresh; null otherwise.

   CLEARS WHAT IT REJECTS. An expired or corrupt record is removed on read rather than left to be
   re-examined on every future login — it can never become valid again, and leaving it behind means
   carrying a small permanent lie about there being a scan in flight. */
export function readFreshPendingScan(storage) {
  const s = store(storage);
  if (!s) return null;
  try {
    const raw = s.getItem(PENDING_SCAN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const okShape = v && (v.kind === "checkin" || v.kind === "handoff") && typeof v.id === "string" && v.id
      && typeof v.ts === "number" && Number.isFinite(v.ts);
    // A ts in the FUTURE is treated as stale too. Clocks move — a device whose time was wrong when
    // the scan happened would otherwise hold a stash that never expires.
    const fresh = okShape && Date.now() - v.ts < PENDING_SCAN_TTL_MS && v.ts <= Date.now();
    if (!fresh) { try { s.removeItem(PENDING_SCAN_KEY); } catch { /* nothing more to do */ } return null; }
    return v;
  } catch {
    try { s.removeItem(PENDING_SCAN_KEY); } catch { /* nothing more to do */ }
    return null;
  }
}

export function clearPendingScan(storage) {
  const s = store(storage);
  if (!s) return;
  try { s.removeItem(PENDING_SCAN_KEY); } catch { /* nothing more to do */ }
}

/* Read AND delete, in that order, for the replay site.

   THE DELETE COMES FIRST and that ordering is the guarantee. The caller then drives a check-in
   that may fail, retry, or re-render under StrictMode's double-invoke; if the key were removed
   afterwards, any of those could fire the same scan twice. Removing before returning means the
   stash is spent the instant it is looked at, so a replay happens exactly once — and a scan lost
   to a failed check-in is recoverable by scanning again, while a duplicate attendance record
   written from a stale stash is not something the member would ever see to correct. */
export function consumePendingScan(storage) {
  const v = readFreshPendingScan(storage);
  if (v) clearPendingScan(storage);
  return v;
}

/* The URL a magic link should return to, so the parameters survive the mail round-trip.

   SECONDARY, not the primary carrier. The replay in App.jsx is what actually performs the
   check-in, and it works off localStorage regardless of where the member lands. This exists
   because the redirect is what makes the RETURN look right — the member arrives on /checkin rather
   than a bare dashboard — and because it is the one path that still works if localStorage is
   unavailable in the returning tab. */
export function scanRedirectUrl(origin, scan) {
  if (!scan) return null;
  const path = scan.kind === "handoff" ? "handoff" : "checkin";
  const q = new URLSearchParams();
  q.set(path, scan.id);
  if (scan.token) q.set("t", scan.token);
  return `${origin}/${path}?${q.toString()}`;
}
