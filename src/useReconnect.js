import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";

/* Auto-recovery and auto-refresh for one-shot data loads.
   The bug this exists for: a loader runs once in an empty-deps useEffect, the device is offline, the
   read fails, and nothing ever retries — the screen stays blank until the app is killed and reopened.

   Three signals now, two of them built into the WebView:
     • window 'online'          — fires when the OS regains connectivity
     • visibilitychange→visible — fires when the app returns to the foreground, which is the common
                                  recovery path: the user unlocks the phone after signal came back.
     • appStateChange           — the NATIVE resume signal, added below. See ONE LISTENER.
   The second is the important one on iOS. WKWebView's 'online' event can be missed if the app was
   suspended at the moment the network came back, so resume is the reliable backstop. main.jsx already
   relies on visibilitychange for the stale-bundle check and token refresh, so it's proven on device.

   Callers pass a callback that should decide whether a refetch is warranted (typically: only if the
   last load failed), so a routine app-resume while healthy doesn't restampede every query. */

/* ONE LISTENER FOR THE WHOLE APP, NOT ONE PER HOOK.

   useReconnect has ~27 call sites. Registering a native appStateChange listener inside the hook
   would register it 27 times — 27 bridge subscriptions for one OS event, all firing together on
   every resume. So the native listener is wired ONCE at module scope and re-broadcast as an
   ordinary DOM event that each hook instance listens for like any other. The hooks stay identical
   on web and native; only this function knows the difference.

   WHY ADD IT AT ALL when visibilitychange already fires on resume: it is the signal iOS actually
   guarantees. visibilitychange is a WebView behaviour we observe working; appStateChange is the
   platform telling us. Both feed the same fire("resume"), and the 1500ms collapse below means a
   resume that trips both still produces exactly one refetch.

   DESTRUCTURE THE PLUGIN — never `return mod.App` out of an async function. A Capacitor handle is a
   Proxy that forwards every property to native, `then` included, so returning one makes the promise
   machinery call App.then() and hang forever. That cost a full device cycle in deeplink.js. */
const RESUME_EVENT = "b4c:native-resume";
let nativeWired = false;
function wireNativeResume() {
  if (nativeWired || typeof document === "undefined") return;
  if (!Capacitor.isNativePlatform()) return;   // web has visibilitychange; nothing to wire
  nativeWired = true;
  import("@capacitor/app")
    .then(({ App }) => {
      if (!App) { nativeWired = false; return; }
      return App.addListener("appStateChange", ({ isActive }) => {
        // Only the foreground edge. Backgrounding is not a moment to refetch.
        if (isActive) document.dispatchEvent(new Event(RESUME_EVENT));
      });
    })
    .catch(() => {
      // Release the flag: a transient import failure must not permanently disable the
      // native path. visibilitychange still covers resume in the meantime.
      nativeWired = false;
    });
}

export function useReconnect(onReconnect) {
  const cb = useRef(onReconnect);
  cb.current = onReconnect;   // always invoke the latest closure without re-registering listeners

  useEffect(() => {
    wireNativeResume();
    let lastFired = 0;
    const fire = (why) => {
      // Unlocking a phone that just regained signal fires BOTH events within milliseconds.
      // Collapse the burst so we issue one refetch, not two. appStateChange and
      // visibilitychange also arrive together on a native resume — same collapse, same reason.
      const now = Date.now();
      if (now - lastFired < 1500) return;
      lastFired = now;
      cb.current?.(why);
    };
    const onOnline = () => fire("online");
    const onVisible = () => { if (document.visibilityState === "visible") fire("resume"); };
    const onNative = () => fire("resume");

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener(RESUME_EVENT, onNative);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener(RESUME_EVENT, onNative);
    };
  }, []);
}

/* ---------------------------------------------------------------------------
   THE OPEN-EDITOR REGISTRY (used by useAutoRefresh below).

   A background refetch that lands while someone is halfway through a form is the one way this
   feature can make things worse rather than better. The obvious fix — pass skipWhen down to every
   screen — does not work for the root loaders: `members` and `trainingSessions` live in App() and
   are refreshed there, but the add-member form that must not be disturbed lives inside Roster,
   several components away. App() cannot see that state and should not have to.

   So a screen with an open editor says so, once, and every auto-refresh in the app defers while it
   is open. A count rather than a boolean because two screens can be mounted with editors open at
   the same time, and the first one closing must not clear the second one's guard.

   This is a PAUSE, not a cancel: the next resume after the form closes refreshes normally. */

/* WHY THIS IS A RENDER-TIME REGISTRY AND NOT AN EFFECT-TIME COUNTER.

   The first version was `openEditors += 1` in a useEffect with [isOpen] deps,
   decremented in the cleanup. It leaked a refetch: on 2026-08-31, with the Add
   Member form open the entire time, one past-throttle resume read the counter as
   0 and refetched all three root loaders mid-edit, while a later resume on the
   same open form correctly read 1.

   An effect-time counter has windows by construction. Between a state change and
   its effect, between an unmount's cleanup and the remount's effect if those land
   in separate commits, and — in dev — module state resets to 0 outright when HMR
   replaces this file. Any of those makes "is an editor open?" briefly answer no
   while a form sits on screen, and a resume landing in that window refetches
   under someone's hands.

   So the flag is written DURING RENDER, where it cannot lag the state it
   describes: by the time React has rendered the form, the registry already says
   so. Writing to a module Map during render is impure in principle, but this
   write is idempotent — setting a key to a boolean — so a StrictMode double
   render, a discarded concurrent render, or a re-render for any other reason all
   produce the same value. Only the UNREGISTER is an effect, and only on unmount.

   THE GRACE PERIOD is the belt to that brace. A transient zero is
   indistinguishable from a real close, so any close is treated as "still
   editing" for a moment afterwards. It costs one deferred refresh after someone
   finishes a form; it buys immunity to whatever window we have not thought of.
   A refetch that lands mid-edit is a bug someone loses work to; a refresh that
   waits sixty more seconds is not. */
const editorFlags = new Map();     // stable per-hook key -> currently open?
let lastEditorClosedAt = 0;        // when the last open editor went away
const EDITOR_GRACE_MS = 2000;

export function useEditorOpen(isOpen) {
  const keyRef = useRef(null);
  if (keyRef.current === null) keyRef.current = Symbol("b4c.editor");

  const wasAnyOpen = anEditorIsOpen();
  editorFlags.set(keyRef.current, !!isOpen);          // during render, no window
  if (wasAnyOpen && !anEditorIsOpen()) lastEditorClosedAt = Date.now();

  useEffect(() => {
    const key = keyRef.current;
    return () => {
      editorFlags.delete(key);                        // unmount only
      if (!anEditorIsOpen()) lastEditorClosedAt = Date.now();
    };
  }, []);
}

export const anEditorIsOpen = () => {
  for (const open of editorFlags.values()) if (open) return true;
  return false;
};

/* What useAutoRefresh actually asks. "No editor is open, and none has closed in
   the last couple of seconds" — the second clause is what a transient zero
   cannot get past, because a transient zero sets the timestamp on its way
   through. */
const editingOrJustFinished = () =>
  anEditorIsOpen() || (Date.now() - lastEditorClosedAt < EDITOR_GRACE_MS);

/* useAutoRefresh — keep a screen's data current without anyone force-quitting.

   THE PROBLEM IT SOLVES. Every loader in this app runs once in an empty-deps effect and never
   re-reads. useReconnect was already wired to 27 of them and already fired on resume — but almost
   every call site reads `if (loadErr) load()`, so it only ever recovers from a FAILED load. On a
   healthy screen the callback fired and deliberately did nothing. This is the same shape as the
   sign-in-token bug: the machinery was there, the gate was wrong.

   SILENT BY CONTRACT. This never touches loading state and never renders anything. A refresh the
   member did not ask for must not blank the screen they are reading, and a failed refresh must
   leave the last-known data exactly where it was — the loaders already keep last-known data on
   error, and this must not undo that. It is not a substitute for the initial load's spinner; it
   runs behind it.

   TWO REFS, NOT ONE, and the split is a bug fix rather than tidiness. The geofence rescue
   originally stamped its throttle BEFORE the async work, so a load that failed or timed out burned
   the whole interval and every retry hit the throttle silently. Concurrency is what that stamp was
   really protecting against, and inFlightRef does that job properly. lastSuccessRef is stamped only
   AFTER the loader resolves. Moving it earlier reintroduces exactly that bug.

   SEEDED AT MOUNT, so a resume seconds after a screen opens does not immediately re-read what was
   just read. Mount counts as a successful load, because it was one.

   skipWhen IS FOR OPEN EDITORS. A background refetch that replaces the list under an open form can
   pull the row being edited out from under someone mid-sentence. Screens holding unsaved input pass
   a predicate and the refresh defers to the next resume. Deliberately explicit per screen: guessing
   which state counts as "editing" is how you get a refresh that never runs. */

export function useAutoRefresh(loader, { minIntervalMs = 60000, skipWhen } = {}) {
  const loaderRef = useRef(loader);   loaderRef.current = loader;
  const skipRef = useRef(skipWhen);   skipRef.current = skipWhen;
  const inFlightRef = useRef(false);          // concurrency guard
  const lastSuccessRef = useRef(Date.now());  // the throttle window — mount seeds it

  useReconnect(() => {
    if (inFlightRef.current) return;                                              // already running
    if (Date.now() - lastSuccessRef.current < minIntervalMs) return;              // too soon
    if (editingOrJustFinished()) return;                                          // someone is mid-form
    if (skipRef.current && skipRef.current()) return;                             // screen-specific hold
    inFlightRef.current = true;
    Promise.resolve()
      .then(() => loaderRef.current?.())
      .then(() => { lastSuccessRef.current = Date.now(); })   // AFTER, never before
      .catch(() => { /* keep last-known data; the loader owns its own error surface */ })
      .finally(() => { inFlightRef.current = false; });
  });
}

// navigator.onLine is only trustworthy in the negative: false reliably means no network, true just
// means an interface is up. Used for wording only — never to decide whether to attempt a fetch.
export const looksOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
