import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { anEditorIsOpen } from "./useReconnect";
import { writesInFlight } from "./supabaseClient";
import { noirConfirm } from "./NoirDialogs.jsx";
import { FIRE } from "./theme.js";

/* ---------------- Pick up new web builds without anyone refreshing — and without losing their place ----------------

   THE DETECTOR (unchanged in kind from the old stale-bundle guard in main.jsx, which this replaces).
   vite bakes BUILD_ID into the bundle and emits /version.json with the same id; vercel.json serves version.json
   no-store and index.html must-revalidate (hashed /assets stay immutable). deployed !== running = a newer deploy
   exists. Checked on load, on every return to the foreground, and every CHECK_EVERY_MS while visible. No service
   worker, and none is to be added for this.

   APPLYING IT. New JS needs a reload — there is no safe hot-swap of app code. So "keep them on their page" means:
   persist the place (screen, packetId, navArg, the restorable sub-views, scroll) to sessionStorage, reload, and
   restore it on boot (takeRestoredPlace in App). When:
     • at a NAVIGATION BOUNDARY (applyAtBoundary, called from go()): they are leaving this view anyway, so the reload
       lands them on the screen they were heading to — the seamless default;
     • if they linger: a dismissible banner, "A new version is ready · Update" — one tap = persist, reload, restore;
     • on a COLD START, only before the person has touched anything (the page they see is seconds old).
   NEVER AUTOMATICALLY WHILE IT IS UNSAFE (isSafeToReload): an editor/form is open (the useEditorOpen registry), a
   write is in flight (POST/PATCH/DELETE through the Supabase client — saves, RPCs, station clock-in/out), or a modal
   dialog is up. It defers; the next boundary or check tries again.

   GUARDS. One deploy id gets at most MAX_ATTEMPTS automatic reloads per tab, with exponential back-off between them,
   so CDN/edge lag can never cause a reload loop — after that it goes quiet. A dismissed banner stays away for
   DISMISS_COOLOFF_MS unless the running build has been stale for STALE_ESCALATE_MS. Every storage access is wrapped:
   in a private window the worst case is a plain reload to the dashboard, never a crash.

   WEB ONLY. On native, /version.json is read from the SAME local bundle as BUILD_ID, so it always matches — and
   native web-layer updates are Capgo's job (src/liveUpdate.js, autoUpdate "atBackground"). Everything here is inert
   on native by construction, and startUpdateWatch() returns before wiring anything. */

export const BUILD_ID = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
const CHECK_EVERY_MS = 10 * 60 * 1000;
const RESTORE_KEY = "b4c.restore.v1";             // sessionStorage: the place to land on after the reload
const ATTEMPT_KEY = "b4c.update.attempts.v1";     // sessionStorage: { id, n, at } — automatic reloads for one deploy id
const DISMISS_KEY = "b4c.update.dismissed.v1";    // localStorage:  { id, at } — banner dismissed
const FIRST_SEEN_KEY = "b4c.update.firstSeen.v1"; // localStorage:  { id, at } — when this tab first saw the deploy
const MAX_ATTEMPTS = 3;
const DISMISS_COOLOFF_MS = 4 * 60 * 60 * 1000;
const STALE_ESCALATE_MS = 24 * 60 * 60 * 1000;
const RESTORE_MAX_AGE_MS = 2 * 60 * 1000;         // a saved place older than this is not "the reload we just did"

const isNative = () => { try { return Capacitor.isNativePlatform(); } catch { return false; } };
const readJSON = (store, key) => { try { const v = store.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeJSON = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch { /* private mode — degrade to a plain reload */ } };
const removeKey = (store, key) => { try { store.removeItem(key); } catch { /* private mode */ } };
const ss = () => { try { return window.sessionStorage; } catch { return null; } };
const ls = () => { try { return window.localStorage; } catch { return null; } };

let deployed = null;          // the newer deploy id, once seen; null = current (or can't tell)
let interacted = false;       // has the person touched the page since load?
let placeGetter = () => null; // App registers () => ({ screen, packetId, navArg })
let reloadingForUpdate = false; // set by applyUpdate: its own saved place (e.g. a boundary swap's DESTINATION) must not be overwritten on the way out

export const updateReady = () => !!deployed;
export function registerPlaceGetter(fn) { placeGetter = typeof fn === "function" ? fn : () => null; }
export const clearPlaceGetter = () => { placeGetter = () => null; };   // App unmount (sign-out): don't carry a stale screen

/* ---- restorable sub-views (e.g. Settings & Support's card -> sub-screen) ----
   A drop-in for useState(initial) on a hub's `view`. Records the current value during render (idempotent, like
   useEditorOpen) so a reload can carry it, and starts from the carried value once after a reload. */
const liveSubviews = new Map();
let restoredSubviews = null;
export function useRestorableView(key, initial = null) {
  const [view, setView] = useState(() => {
    if (restoredSubviews && Object.prototype.hasOwnProperty.call(restoredSubviews, key)) {
      const v = restoredSubviews[key]; delete restoredSubviews[key]; return v;
    }
    return initial;
  });
  liveSubviews.set(key, view);
  return [view, setView];
}

async function fetchDeployedBuild() {
  try {
    const res = await fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;                         // dev (no file) or transient error -> skip
    const data = await res.json();
    return data && typeof data.build === "string" ? data.build : null;
  } catch { return null; }
}

/* NON-SUPABASE REQUESTS THAT MUST NOT BE CUT OFF. writesInFlight() only sees requests through the Supabase client; a
   call to one of our own /api/* functions (e.g. Ask B4C's /api/assistant) goes through plain fetch and would be
   invisible. Callers bracket such a request with beginAppRequest()/endAppRequest() (endAppRequest in a finally). Held
   at module level so it outlives the component that started it — closing the Ask B4C drawer mid-answer still defers. */
let appRequestsInFlight = 0;
export const beginAppRequest = () => { appRequestsInFlight += 1; };
export const endAppRequest = () => { appRequestsInFlight = Math.max(0, appRequestsInFlight - 1); };

export function isSafeToReload() {
  if (anEditorIsOpen()) return false;                 // a form / editor with input is on screen
  if (writesInFlight() > 0) return false;             // a save, an RPC, a clock-in/out is mid-flight
  if (appRequestsInFlight > 0) return false;          // an /api/* request we started (Ask B4C's answer) is mid-flight
  if (typeof document !== "undefined" && document.querySelector('[aria-modal="true"]')) return false;   // a modal is up
  return true;
}

function canAttempt(id) {
  const a = readJSON(ss(), ATTEMPT_KEY);
  if (!a || a.id !== id) return true;
  if (a.n >= MAX_ATTEMPTS) return false;              // gone quiet for this deploy id in this tab
  return Date.now() - (a.at || 0) > Math.pow(2, a.n) * 60 * 1000;   // back-off: 2, 4 min…
}

function persistPlace(place, keepScroll) {
  const p = place || {};
  writeJSON(ss(), RESTORE_KEY, {
    screen: p.screen || null, packetId: p.packetId ?? null, navArg: p.navArg ?? null,
    subviews: keepScroll ? Object.fromEntries(liveSubviews) : {},    // a boundary swap is going somewhere new
    scrollY: keepScroll && typeof window !== "undefined" ? Math.round(window.scrollY || 0) : 0,
    at: Date.now(), from: BUILD_ID,
  });
}

/* Persist → reload. Returns false (and does nothing) if there is no newer build or the attempt cap is spent. */
function applyUpdate(place, { keepScroll = true, automatic = true } = {}) {
  if (!deployed) return false;
  if (automatic && !canAttempt(deployed)) return false;
  const a = readJSON(ss(), ATTEMPT_KEY);
  writeJSON(ss(), ATTEMPT_KEY, { id: deployed, n: a && a.id === deployed ? (a.n || 0) + 1 : 1, at: Date.now() });
  persistPlace(place, keepScroll);
  reloadingForUpdate = true;
  window.location.reload();
  return true;
}

/* Called from App's go() BEFORE it changes screen. True = a reload has started toward `dest`; go() should stop. */
export function applyAtBoundary(dest) {
  if (!deployed || !isSafeToReload()) return false;
  return applyUpdate(dest, { keepScroll: false });
}

/* Read once on boot (App's state initialisers). Returns { screen, packetId, navArg } or null, and removes the key.
   A deep link in the URL always wins — the caller checks for one; this only refuses stale or foreign entries. */
let bootPlace;   // memoised: StrictMode runs initialisers twice
export function takeRestoredPlace() {
  if (bootPlace !== undefined) return bootPlace;
  const r = readJSON(ss(), RESTORE_KEY);
  removeKey(ss(), RESTORE_KEY);
  bootPlace = r && Date.now() - (r.at || 0) < RESTORE_MAX_AGE_MS ? r : null;
  if (bootPlace) {
    restoredSubviews = { ...(bootPlace.subviews || {}) };
    const y = Number(bootPlace.scrollY) || 0;
    if (y > 0) restoreScroll(y);
  }
  return bootPlace;
}
/* Best-effort: the page grows as its data loads, so retry briefly until the target is reachable. */
function restoreScroll(y) {
  const started = Date.now();
  const tick = () => {
    if (interacted) return;                           // they've started using the page — leave it alone
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max >= y - 4) { window.scrollTo(0, y); return; }
    if (Date.now() - started < 4000) setTimeout(tick, 150);
    else window.scrollTo(0, Math.max(0, max));
  };
  setTimeout(tick, 120);
}

/* ---- the banner (Industrial Noir; plain DOM so it never depends on which screen is mounted) ---- */
function bannerSuppressed(id) {
  const d = readJSON(ls(), DISMISS_KEY);
  if (!d || d.id !== id || Date.now() - (d.at || 0) > DISMISS_COOLOFF_MS) return false;
  const f = readJSON(ls(), FIRST_SEEN_KEY);
  return !(f && f.id === id && Date.now() - (f.at || 0) > STALE_ESCALATE_MS);   // very stale -> show anyway
}
function hideBanner() { document.getElementById("b4c-update-banner")?.remove(); }
function showBanner() {
  if (!deployed || bannerSuppressed(deployed) || document.getElementById("b4c-update-banner")) return;
  if (!document.body) { document.addEventListener("DOMContentLoaded", showBanner, { once: true }); return; }
  const bar = document.createElement("div");
  bar.id = "b4c-update-banner";
  bar.setAttribute("role", "status");
  bar.style.cssText = `position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483646;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:9px 10px 9px 16px;background:${FIRE.card2Noir};border:1px solid ${FIRE.line2Noir};border-radius:999px;color:${FIRE.textPrimary};font:600 13.5px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45)`;
  bar.appendChild(Object.assign(document.createElement("span"), { textContent: "A new version is ready" }));
  const btn = Object.assign(document.createElement("button"), { textContent: "Update" });
  btn.style.cssText = `background:${FIRE.red};color:${FIRE.white};border:none;border-radius:999px;padding:7px 14px;font:700 13px system-ui,sans-serif;cursor:pointer`;
  btn.onclick = async () => {
    // Their tap, their terms — but say so if it would discard something.
    if (!isSafeToReload() && !(await noirConfirm({ title: "Update now?", body: "Anything you haven't saved on this screen will be lost. You'll land back on this page.", confirmLabel: "Update" }))) return;
    if (!applyUpdate(placeGetter(), { keepScroll: true, automatic: false })) hideBanner();
  };
  const x = Object.assign(document.createElement("button"), { textContent: "✕", title: "Not now" });
  x.setAttribute("aria-label", "Dismiss");
  x.style.cssText = `background:transparent;color:${FIRE.textMuted};border:none;padding:4px 6px;font:600 14px system-ui,sans-serif;cursor:pointer`;
  x.onclick = () => { writeJSON(ls(), DISMISS_KEY, { id: deployed, at: Date.now() }); hideBanner(); };
  bar.append(btn, x);
  document.body.appendChild(bar);
}

async function check(reason) {
  const d = await fetchDeployedBuild();
  if (!d || d === BUILD_ID) { deployed = null; hideBanner(); return; }   // current, or can't tell
  deployed = d;
  const f = readJSON(ls(), FIRST_SEEN_KEY);
  if (!f || f.id !== d) writeJSON(ls(), FIRST_SEEN_KEY, { id: d, at: Date.now() });
  // Cold start, untouched page: reload now (the place is wherever routing put them, carried by the getter).
  if (reason === "load" && !interacted && isSafeToReload() && applyUpdate(placeGetter(), { keepScroll: false })) return;
  showBanner();
}

/* MANUAL REFRESH KEEPS THEIR PLACE TOO. Save the same place the pill path saves (screen/packetId/navArg + sub-views +
   scroll) whenever the page is going away: `pagehide` fires right before a refresh, so the timestamp is seconds old when
   takeRestoredPlace() checks its 2-minute window; `visibilitychange -> hidden` covers mobile Safari, which doesn't
   reliably fire pagehide when an installed app is backgrounded and then reloaded. Same RESTORE_KEY, NO new key.
   DELIBERATELY OUTSIDE THE UPDATE MACHINERY: never touches ATTEMPT_KEY / canAttempt, so a person refreshing by hand
   can never use up the 3-reload loop cap. Skipped while an update reload is under way (that already saved its own
   place, which for a navigation swap is the destination, not this screen). The restore-side guards are unchanged:
   a deep link still wins, the one-shot scan screens are never restored, every storage access is try/caught. */
function saveCurrentPlace() {
  if (reloadingForUpdate) return;
  const place = placeGetter();
  if (!place || !place.screen) return;              // not signed in / App not mounted — nothing worth carrying
  persistPlace(place, true);
}

let started = false;
export function startUpdateWatch() {
  if (started || typeof window === "undefined" || isNative()) return;
  started = true;
  const touched = () => { interacted = true; };
  window.addEventListener("pointerdown", touched, { once: true, capture: true });
  window.addEventListener("keydown", touched, { once: true, capture: true });
  check("load");
  window.addEventListener("pagehide", saveCurrentPlace);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check("resume");
    else saveCurrentPlace();
  });
  setInterval(() => { if (document.visibilityState === "visible") check("interval"); }, CHECK_EVERY_MS);
}
