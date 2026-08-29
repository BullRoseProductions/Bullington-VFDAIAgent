import { Capacitor } from "@capacitor/core";

/* App links — catching the URL that opened the app.

   THE WEB PATH DOES NOT WORK HERE, and that is the whole reason this file exists.
   In the browser a scanned QR navigates to app.b4thecall.com/checkin?checkin=… and
   App.jsx reads window.location.search on mount. In the native app the WebView loads
   from the LOCAL BUNDLE — its location is capacitor://localhost or similar — so
   window.location.search never contains the parameters, no matter how correct the
   link was. The URL arrives through the plugin instead, or not at all.

   TWO SOURCES, AND BOTH ARE REQUIRED. This is the classic app-links trap:

     getLaunchUrl()   COLD START. The app was not running; the OS launched it because
                      of the link. The appUrlOpen event fires during that launch —
                      quite possibly before any JavaScript has run, certainly before a
                      React effect could have attached a listener. Relying on the
                      listener alone loses exactly the case people test first.

     appUrlOpen       WARM START. The app was already running, in the foreground or
                      backgrounded. No relaunch happens, so getLaunchUrl still returns
                      whatever URL started the process — possibly nothing, possibly a
                      stale one from hours ago. Only the event carries the new link.

   Neither covers the other. Both feed the same handler.

   DEDUPE IS NOT OPTIONAL. On some launches the same URL arrives from BOTH — the
   process starts with a launch URL and the event fires as well. Routing twice would
   re-run the check-in screen underneath the member while they are reading it. The
   guard is on the URL string, not a boolean, so a second genuinely-different scan in
   the same session still routes.

   NO-OP ON WEB by design: there the browser's own address bar is the delivery
   mechanism and App.jsx already reads it. */

let appSub = null;         // the appUrlOpen subscription; must never stack
let lastRouted = null;     // the last URL handed onward — see DEDUPE above
let started = false;       // startDeepLinks is idempotent per launch

/* Start listening. `onLink` receives the full URL string; the caller decides what,
   if anything, to do with it — this module deliberately knows nothing about
   check-in or handoff, so the routing rules live in one place in App.jsx.

   Returns a teardown, and never throws: a deep link failing to arrive must not take
   down the app on launch. */
export async function startDeepLinks(onLink) {
  if (!Capacitor.isNativePlatform()) return () => {};
  /* ONCE PER LAUNCH. addListener STACKS — call this twice and every link is routed
     twice, which on a check-in means the screen re-enters underneath the member.
     The returned teardown clears the flag, so a genuine unmount/remount (React's
     development double-invoke, for one) re-attaches exactly one listener. */
  if (started) return () => {};
  started = true;

  /* DESTRUCTURE THE HANDLE — never `return mod.App` out of an async function.

     A Capacitor plugin handle is a Proxy that forwards EVERY property access to
     native, `then` included, which makes it a thenable. Returning one from an async
     function hands it to the promise machinery, which calls App.then(resolve, reject)
     to adopt it; native answers "App.then() is not implemented on ios", and neither
     resolve nor reject is ever called. The await then hangs forever — no listener
     attached, no launch URL read, every deep link silently dropped, and the only
     evidence an unhandled rejection in a console nobody is watching.

     push.js:90 destructures for this reason. geofence.js gets away with returning its
     handle only because TransistorSoft's default export is a plain class, not a
     registerPlugin proxy.

     Dynamic import so the plugin stays out of the web bundle rather than shipping to
     browsers that can never use it. */
  let App = null;
  try { ({ App } = await import("@capacitor/app")); } catch { App = null; }
  if (!App) {
    // Release the once-only flag: nothing was attached, so a later attempt must be
    // allowed to try again. Leaving it set would make a transient import failure
    // permanent for the life of the process.
    started = false;
    return () => {};
  }

  const deliver = (url) => {
    if (!url || url === lastRouted) return;
    lastRouted = url;
    /* The catch stays; only its logging came out. A routing failure must not take
       down the launch path, and the URL carries a session id and a live sign-in
       token — not something to print to a console we do not control. */
    try { onLink(url); } catch { /* routing failed; the app still starts */ }
  };

  /* WARM START — attached FIRST, before the launch-URL read below. If it were
     attached after, a link arriving during that await would land on nothing. The
     dedupe is what makes the overlap harmless. */
  try {
    appSub = await App.addListener("appUrlOpen", (e) => deliver(e?.url));
  } catch { /* no listener is bad but not fatal; the cold-start path may still work */ }

  /* COLD START — the URL the process was launched with. Read once, after the
     listener is up. */
  try {
    const launch = await App.getLaunchUrl();
    deliver(launch?.url);
  } catch { /* getLaunchUrl is unavailable on some platforms; the listener covers warm */ }

  return () => {
    if (appSub) { try { appSub.remove(); } catch { /* already gone */ } appSub = null; }
    started = false;
  };
}
