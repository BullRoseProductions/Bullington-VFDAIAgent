/* OVER-THE-AIR WEB-LAYER UPDATES — NOT IN USE. Inert stubs.

   B4C does not use an OTA update service. A Capgo live-update plugin was wired in on
   Sept 24 (89f3ffe) but no account or bundle was ever set up behind it, so it never
   delivered anything; it was removed for 3.1. New builds reach phones through the app
   stores, and the web layer a phone runs is the one compiled into the installed app.

   These five exports keep their names, signatures and return shapes so the caller
   (src/main.jsx) is unchanged. Each does nothing:
     markBundleHealthy()   -> { ok: false, reason: "disabled" }
     currentBundle()       -> null
     setChannel(channel)   -> { ok: false, reason: "disabled" }
     revertToStoreBundle() -> { ok: false, reason: "disabled" }
     watchLiveUpdates()    -> a detach function that does nothing

   If an OTA service is ever adopted, it starts here — and the bundled-asset model is
   still the constraint: capacitor.config.json must never grow a server.url (a rig in a
   dead zone would get a white screen, and a backgrounded geofence would wake a webview
   with nothing to load). */

export async function markBundleHealthy() {
  return { ok: false, reason: "disabled" };
}

export async function currentBundle() {
  return null;
}

// eslint-disable-next-line no-unused-vars
export async function setChannel(channel) {
  return { ok: false, reason: "disabled" };
}

export async function revertToStoreBundle() {
  return { ok: false, reason: "disabled" };
}

export async function watchLiveUpdates() {
  return () => {};
}
