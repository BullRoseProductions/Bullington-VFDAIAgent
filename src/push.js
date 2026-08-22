import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabaseClient";

// Push registration — NATIVE ONLY. There is no web-push path here: the PWA would need a service
// worker and a VAPID key, which is a different mechanism entirely. On web this is a no-op, so the
// site behaves exactly as it does today.
//
// Behind VITE_PUSH_ENABLED so the whole thing stays dark until a device test confirms delivery.
// Mirrors the server's PUSH_ENABLED flag; either side can be off independently.
const FLAG_ON = import.meta.env.VITE_PUSH_ENABLED === "1";

export const pushAvailable = () => FLAG_ON && Capacitor.isNativePlatform();

/* TWO DIFFERENT LIFETIMES, and conflating them was a disclosure bug.

   `started` guards the LISTENERS, which must be attached exactly once per app launch or they
   stack and every push fires its handler N times.

   `cachedToken` is a property of the DEVICE, not of whoever is signed in. It arrives once from
   APNs/FCM per launch and stays valid across logins.

   Filing the token against a member is a THIRD thing, and it has to happen every time the member
   changes. Previously all three hung off `started`: member B signing in on a handed-over phone
   hit the early return, register() was never called again, the registration listener never
   re-fired, and register_device never ran — so the token stayed filed to member A and A's lock
   screen showed B's cert and gear notifications. The RPC was always correct
   (ON CONFLICT DO UPDATE SET member_id); nothing was calling it. */
let started = false;
let cachedToken = null;

/* File the cached token against whoever is signed in RIGHT NOW.

   Deliberately takes no member argument. register_device is SECURITY DEFINER and reads
   my_member_id() from the JWT, so the caller cannot assert a member and this always follows the
   live session. That is also what makes the late-token case correct: if the token arrives after
   a member change, the listener calls this and it files against the then-current member, not the
   one who was signed in when register() ran. */
async function fileToken() {
  if (!cachedToken) return { ok: false, reason: "no-token-yet" };
  try {
    await supabase.rpc("register_device", { p_token: cachedToken, p_platform: Capacitor.getPlatform() });
    return { ok: true };
  } catch (e) {
    // The next member change or launch re-files. A missed filing costs a notification, not data.
    return { ok: false, reason: "rpc-failed", detail: String(e?.message || e) };
  }
}

/* Re-file this device against the current member. Call whenever the signed-in member changes.

   Cheap and idempotent: one upsert keyed on the token. Safe to call when no token has arrived
   yet — it no-ops, and the registration listener files it the moment it does. */
export async function syncDeviceRegistration() {
  if (!pushAvailable()) return { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" };
  return fileToken();
}

/* Unfile this device on sign-out, so a signed-out phone stops receiving the last member's pushes.

   MUST RUN BEFORE supabase.auth.signOut(). The delete is governed by member_devices_delete_own
   (USING member_id = my_member_id()), so once the session is gone my_member_id() is null, the
   policy matches nothing, and the row silently survives. Ordering is the whole correctness
   argument here, not an optimisation.

   cachedToken is deliberately NOT cleared. The token belongs to the device: if someone else signs
   in on this phone without relaunching, syncDeviceRegistration() re-files that same token to them.
   Clearing it would leave the next member with no token and no way to get one, because register()
   only runs once per launch. */
export async function unregisterPush() {
  if (!pushAvailable()) return { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" };
  if (!cachedToken) return { ok: true, reason: "nothing-filed" };
  try {
    const { error } = await supabase.from("member_devices").delete().eq("token", cachedToken);
    if (error) return { ok: false, reason: "delete-failed", detail: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "delete-failed", detail: String(e?.message || e) };
  }
}

/* Registers this device and files its token against the signed-in member.
   Returns a reason rather than throwing: push failing must never block someone using the app. */
export async function initPush({ onOpen } = {}) {
  if (!pushAvailable()) return { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" };
  if (started) return { ok: true, reason: "already-started" };
  started = true;

  let PushNotifications;
  try {
    ({ PushNotifications } = await import("@capacitor/push-notifications"));   // dynamic: keeps the plugin out of the web bundle
  } catch (e) {
    return { ok: false, reason: "plugin-missing", detail: String(e?.message || e) };
  }

  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await PushNotifications.requestPermissions();
    }
    // A refusal is a legitimate answer, not an error. Never re-prompt on later launches —
    // iOS only shows the system dialog once anyway, and nagging is what gets an app deleted.
    if (perm.receive !== "granted") return { ok: false, reason: "denied" };

    // Listeners MUST be attached before register(): on a warm start the token can arrive
    // immediately, and a listener added afterwards would miss it and never file the device.
    await PushNotifications.addListener("registration", async (token) => {
      // Cache FIRST, then file. The cache is what lets a later member change re-file without
      // needing register() again, so it must survive even if the RPC below fails.
      cachedToken = token.value;
      await fileToken();   // files against the CURRENT session, which may not be the one that called register()
    });
    await PushNotifications.addListener("registrationError", () => { /* no token this launch; retried next launch */ });
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      // Tapping a push opens the inbox. The payload carries deep_link, but we only ever honour
      // our own known destination — never navigate somewhere a payload names.
      if (typeof onOpen === "function") onOpen(action?.notification?.data?.notification_id || null);
    });

    await PushNotifications.register();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "error", detail: String(e?.message || e) };
  }
}
