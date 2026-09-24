import { Capacitor } from "@capacitor/core";

/* OVER-THE-AIR WEB-LAYER UPDATES (Capgo).

   WHAT THIS BUYS. Everything above the native shell — React, the screens, the SQL
   the client sends, a wording fix on a form — can reach installed phones without a
   store review. What it CANNOT ship is anything native: a new Capacitor plugin, a
   permission string, an Info.plist key, a version bump. Those still need a build.
   The rule of thumb: if it lives in src/ it can go OTA; if it changed ios/ or
   android/ or package.json's native deps, it cannot.

   THE BUNDLED-ASSET MODEL IS PRESERVED — THIS IS THE LOAD-BEARING CONSTRAINT.
   The other way to do live updates is to point Capacitor's `server.url` at a hosted
   copy of the web app. We do NOT do that, and capacitor.config.json must never grow
   a server.url. Under server.url the phone fetches the app over the network at
   launch: a rig in a dead zone gets a white screen, and a backgrounded geofence
   that wakes the webview has nothing to wake into. Capgo instead downloads a zip,
   unpacks it to the app's own storage, and points the SAME local file loader at the
   new folder. The app stays offline-first; only the folder it reads changes.

   WHY "atBackground" AND NOT AN INSTANT APPLY. The plugin checks for an update on
   every foreground transition — cold launch and resume, which is the launch/resume
   requirement — downloads in the background, and swaps the bundle only when the app
   NEXT goes to background. Nothing reloads under the member's feet. That matters
   here more than in most apps: an instant apply would tear down the webview
   mid-drill-sign-in, and @transistorsoft's geofence keeps native state that a
   surprise reload has no reason to survive cleanly. A member gets the new bundle on
   their next launch, which for a volunteer department is the same day.

   ROLLBACK, IN THREE LAYERS, FASTEST FIRST:
     1. AUTOMATIC, per-device. notifyAppReady() below is the health signal. If a
        bundle fails to reach it within appReadyTimeout the plugin reverts that
        phone to the previous working bundle by itself. A bundle that white-screens
        therefore un-ships itself — no console, no telemetry, no action from us.
     2. OPERATIONAL, fleet-wide, seconds. Reassign the channel to the last good
        bundle from the CLI:
          npx @capgo/cli@latest bundle list --app-id com.bigbulltech.b4c
          npx @capgo/cli@latest channel set production --bundle <last-good-version> --app-id com.bigbulltech.b4c
        Every phone picks it up on its next foreground check.
     3. LAST RESORT, per-device. revertToStoreBundle() throws away every downloaded
        bundle and returns the phone to the assets compiled into the installed app —
        the one that went through store review. Wire it to a support action if we
        ever need a member to self-rescue over the phone.

   THE API KEY IS NOT IN THE APP AND MUST NOT BE. Capgo identifies the app by its
   Capacitor appId (com.bigbulltech.b4c). The key is a PUBLISHING credential used by
   the CLI to upload bundles — it belongs in the shell that runs the upload, never in
   a shipped bundle, where it would be readable by anyone who unzips the IPA. */

const isNative = () => Capacitor.isNativePlatform();

// Dynamic, like push.js and geofence.js: the web bundle must not pull in a native
// shim for a feature the web build cannot run.
async function plugin() {
  if (!isNative()) return null;
  try {
    const mod = await import("@capgo/capacitor-updater");
    // Destructure. A Capacitor plugin proxy is a thenable, so `return mod.CapacitorUpdater`
    // from an async function makes await forward .then() to native and hang forever.
    const { CapacitorUpdater } = mod;
    return CapacitorUpdater || null;
  } catch { return null; }
}

/* THE HEALTH SIGNAL, and the thing that makes layer-1 rollback real.

   Call this once the app has actually reached a usable state. Until it is called the
   plugin treats the running bundle as unproven, and a launch that never gets here
   rolls the phone back.

   CALLED TOO EARLY IT IS WORTHLESS. Calling it at module scope would mark a bundle
   healthy merely because its first line parsed — which is true of almost every broken
   bundle too. It is called from Root's mount effect instead: by then React has
   mounted, supabaseClient has initialised without throwing, and the shell has
   rendered. That is a claim worth making.

   Safe to call on web and safe to call twice; both are no-ops. */
export async function markBundleHealthy() {
  const p = await plugin();
  if (!p) return { ok: false, reason: "web" };
  try {
    await p.notifyAppReady();
    return { ok: true };
  } catch (e) {
    // Never let this break startup. Failing to report health costs us a rollback on
    // the next launch, which is the safe direction to fail in.
    console.warn("[b4c] notifyAppReady failed", e?.message || e);
    return { ok: false, reason: "error", message: e?.message };
  }
}

/* Which bundle is this phone actually running? Returns { version, native } —
   `native` is the version compiled into the installed app, `version` is the live
   bundle on top of it (equal to native when no OTA bundle has been applied).
   For a support call: "what does your About screen say" beats guessing. */
export async function currentBundle() {
  const p = await plugin();
  if (!p) return null;
  try {
    const { bundle, native } = await p.current();
    return { version: bundle?.version ?? null, status: bundle?.status ?? null, native: native ?? null };
  } catch { return null; }
}

/* Move this device to a named channel — "production", or a "beta" channel pointed at
   a bundle we want on a couple of phones before the department gets it. The channel
   a phone is NOT on is the safest place to test an OTA bundle. */
export async function setChannel(channel) {
  const p = await plugin();
  if (!p) return { ok: false, reason: "web" };
  try {
    const res = await p.setChannel({ channel });
    return { ok: true, ...res };
  } catch (e) { return { ok: false, reason: "error", message: e?.message }; }
}

/* Layer-3 rollback: discard every downloaded bundle and run the assets that shipped
   with the installed app. Irreversible only in the sense that the phone must
   re-download to get back — which it will do on its next foreground check. */
export async function revertToStoreBundle() {
  const p = await plugin();
  if (!p) return { ok: false, reason: "web" };
  try {
    await p.reset();
    return { ok: true };
  } catch (e) { return { ok: false, reason: "error", message: e?.message }; }
}

/* Console breadcrumbs for the one question that is otherwise unanswerable on a
   member's phone: did this device see the update, download it, and apply it?
   Listeners only — nothing here changes behaviour, and a listener that throws must
   not take startup with it. Returns a detach function. */
export async function watchLiveUpdates() {
  const p = await plugin();
  if (!p) return () => {};
  const subs = [];
  const on = async (name, fn) => {
    try { subs.push(await p.addListener(name, fn)); } catch { /* older plugin, unknown event */ }
  };
  await on("updateAvailable", (e) => console.info("[b4c][ota] update available", e?.bundle?.version));
  await on("downloadComplete", (e) => console.info("[b4c][ota] downloaded", e?.bundle?.version));
  await on("downloadFailed", (e) => console.warn("[b4c][ota] download FAILED", e?.version));
  await on("updateFailed", (e) => console.warn("[b4c][ota] update FAILED, rolling back", e?.bundle?.version));
  await on("appReloaded", () => console.info("[b4c][ota] reloaded onto a new bundle"));
  await on("noNeedUpdate", () => console.info("[b4c][ota] already current"));
  return () => { for (const s of subs) { try { s.remove(); } catch { /* already gone */ } } };
}
