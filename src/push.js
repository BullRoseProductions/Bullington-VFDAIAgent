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

let started = false;   // registration is idempotent per app launch — listeners must never stack

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
      try {
        await supabase.rpc("register_device", { p_token: token.value, p_platform: Capacitor.getPlatform() });
      } catch { /* the next launch re-registers; a missed filing is not worth surfacing */ }
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
