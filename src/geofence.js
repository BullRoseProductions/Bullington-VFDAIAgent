import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabaseClient";

/* Automatic station presence — the consent layer and the permission flow.
   G4b was the disclosure and the record of what the member answered. G4c adds the first
   real plugin calls: configuring the SDK and asking the OS for location.

   STILL NO FENCES AND NO HANDLERS. Nothing is registered, nothing is started, no
   enter/exit event can fire. ready() applies configuration and leaves the plugin
   DISABLED — no foreground service, no notification, no battery cost. G4d is what
   turns it on.

   Behind VITE_GEOFENCE_ENABLED so the whole feature stays dark until a device test
   confirms enter/exit actually fires. Mirrors departments.geofence_enabled on the
   server; either side can be off independently, and BOTH must be on for a member to
   see anything. Today the flag is unset and 0 of 2 departments have opted in. */
const FLAG_ON = import.meta.env.VITE_GEOFENCE_ENABLED === "1";

/* Deliberately NOT gated on Capacitor.isNativePlatform() — G4b makes no native calls, so
   the disclosure can be reviewed in a browser before any device exists. The native gate
   belongs in G4c, where the first real plugin call appears. Web must never get further
   than reading this copy. */
export const geofenceConsentAvailable = () => FLAG_ON;

/* True only where a geofence could actually run. G4c's entry point, exported now so the
   native check lands in one place rather than being rediscovered later. */
export const geofenceAvailable = () => FLAG_ON && Capacitor.isNativePlatform();

/* WHY LOCAL STORAGE, AND WHY KEYED BY MEMBER.

   Consent to be located is consent given on a PARTICULAR PHONE. The OS permission it
   leads to is per-device and per-install, so a record of it that syncs across devices
   would be lying: agreeing on your phone says nothing about the station tablet, and an
   answer that followed you to a new device would skip a disclosure the store requires
   us to show. Device-local is the honest scope.

   Keyed by member id because a station tablet can be signed into by different people.
   One member's answer must never stand in for another's — an unkeyed record would let
   the second person's phone start reporting their location because the first agreed.

   NOT AN AUDIT TRAIL. localStorage is clearable and unsigned; this decides whether to
   show a screen, and nothing more. If the department ever needs to prove who consented
   and when — a fair thing to want before tracking volunteers — that is a server-side
   record with a timestamp, and it is a separate slice. Do not let this stand in for it. */
const KEY = (memberId) => `b4c.geofence.consent.${memberId}`;

/* Returns "granted" | "declined" | null (never asked). Never throws: Safari private mode
   and locked-down WebViews can make localStorage itself raise, and a storage failure must
   not take down Settings. An unreadable record reads as "never asked", which errs toward
   showing the disclosure again — the safe direction, since the cost is re-reading a
   screen and the alternative is tracking someone who never saw it. */
export function readGeofenceConsent(memberId) {
  if (!memberId) return null;
  try {
    const v = localStorage.getItem(KEY(memberId));
    return v === "granted" || v === "declined" ? v : null;
  } catch { return null; }
}

/* CONSENT IS OBSERVABLE, and it has to be.

   localStorage is invisible to React: writing it re-renders nothing. The fence-start
   effect reads consent as a GUARD but could never list it as a dependency, so on the one
   run that matters — the run where the member actually consents — the effect had already
   bailed and nothing re-ran it. The fence was never registered until the next launch, and
   a feature that needs a manual restart to work is broken.

   A subscription rather than a prop threaded through the tree, because there are two
   independent writers (the first-run overlay and the Settings panel) and a third will
   eventually exist. Anything that has to be wired up per call site is something a future
   call site will forget to wire. */
const consentListeners = new Set();

export function subscribeGeofenceConsent(fn) {
  consentListeners.add(fn);
  return () => consentListeners.delete(fn);
}

// One listener throwing must not stop the others from hearing about it.
function announceConsentChange() {
  consentListeners.forEach((fn) => { try { fn(); } catch { /* a bad listener is not the store's problem */ } });
}

/* Records the answer. Returns false if it could not be stored, so the caller can decide
   whether to proceed — a decision we could not persist will be asked again next launch.
   Announces ONLY on a successful write: a failed store must not make the app believe
   something changed. */
export function writeGeofenceConsent(memberId, decision) {
  if (!memberId || (decision !== "granted" && decision !== "declined")) return false;
  try {
    localStorage.setItem(KEY(memberId), decision);
    announceConsentChange();
    return true;
  } catch { return false; }
}

/* Withdrawing is a first-class action, not an edge case: the disclosure promises members
   they can turn this off, and that promise has to be executable from our own UI rather
   than by sending them into the phone's settings. Clearing the record returns them to
   "never asked", so the full disclosure shows again before anything restarts. */
export function clearGeofenceConsent(memberId) {
  if (!memberId) return false;
  try {
    localStorage.removeItem(KEY(memberId));
    announceConsentChange();
    return true;
  } catch { return false; }
}


/* ══════════════════════════════════════════════════════════════════════════════
   NATIVE — the first plugin calls in the project.

   Everything below no-ops on web and while the flag is off, and every function
   returns a reason instead of throwing. Location failing must never block someone
   from using the app: a member who cannot get a permission dialog still has to be
   able to check in by hand.
   ══════════════════════════════════════════════════════════════════════════════ */

let configured = false;   // ready() is idempotent per launch — config must not be re-applied on every render
let BG = null;            // the plugin handle, resolved once

/* ─── TEMP — REVERT BEFORE RELEASE ────────────────────────────────────────────
   Desk-test instrumentation. Wraps every return so the reason string reaches the
   Capacitor console (Logcat tag: "Capacitor/Console"). Revert = delete this helper
   and unwrap the TT(...) calls below. */
const TT = (where, res) => {
  console.log(`[geofence] ${where} →`, res?.reason, res?.detail || "", res?.ok === true ? "OK" : "");
  return res;
};
/* ─── END TEMP ─────────────────────────────────────────────────────────────── */

/* Dynamic import, exactly as push.js does it: this keeps the native plugin out of the
   web bundle entirely rather than shipping it to browsers that can never use it. */
async function loadPlugin() {
  if (BG) return BG;
  try {
    const mod = await import("@transistorsoft/capacitor-background-geolocation");
    BG = mod?.default ?? mod?.BackgroundGeolocation ?? null;
    return BG;
  } catch { return null; }
}

/* Configure the SDK. Does NOT start it and does NOT ask for permission.

   ON "GEOFENCE-ONLY MODE": there is no config key that means it. Geofences-only is a
   RUNTIME mode the SDK enters when startGeofences() is called instead of start(), and
   that call belongs to G4d. What this function does is set everything so that mode is
   the only thing that can happen — no motion engine, no continuous tracking config —
   and leave the plugin disabled. Calling it "configured for geofence-only" would be
   describing an intention as if it were a setting.

   `rationale` is the Android 11+ dialog shown before the OS sends someone to Settings
   to pick "Allow all the time". It is member-facing copy and is passed in rather than
   written here, so all consent wording stays in one reviewed place. */
export async function initGeofence({ rationale } = {}) {
  if (!geofenceAvailable()) {
    return TT("initGeofence", { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" });
  }
  if (configured) return TT("initGeofence", { ok: true, reason: "already-configured" });

  const bg = await loadPlugin();
  if (!bg) return TT("initGeofence", { ok: false, reason: "plugin-missing" });

  try {
    const state = await bg.ready({
      // reset:true so OUR config wins on every launch. The SDK persists configuration
      // across restarts, which means a value changed in a past build would otherwise
      // survive in the field and quietly outlive the code that set it.
      reset: true,

      // THE BINDING CONSTRAINT from G4a. We stripped ACTIVITY_RECOGNITION from the
      // manifest; without this the SDK still reaches for a Motion API it no longer has
      // rights to. The permission removal and this flag are one change in two files —
      // never move one without the other.
      disableMotionActivityUpdates: true,

      // Ask for Always. The SDK sequences it correctly per platform: When-In-Use first,
      // then the separate Always escalation that Android 11+ refuses to bundle into one
      // dialog. We do not hand-roll that sequence.
      locationAuthorizationRequest: "Always",
      backgroundPermissionRationale: rationale || undefined,

      // Presence has to survive the things phones actually do: get swiped closed, run
      // out of battery, reboot in the night. A departure the app was not alive to notice
      // is a shift that never closes.
      stopOnTerminate: false,
      startOnBoot: true,

      /* THE REPLAY BUFFER. Capacitor has no JS headless task — a transition that fires
         while the app is dead reaches no listener and is NOT re-delivered later. Without
         this the event is simply gone.

         PERSIST_MODE_GEOFENCE writes geofence transitions (and only those) to the SDK's
         own SQLite queue. We configure no `url`, so nothing is ever uploaded from here;
         the queue exists purely as our buffer, and drainGeofenceQueue() empties it on the
         next app open. If the constant were ever missing the value falls back to the SDK
         default, which persists MORE rather than less — a benign direction to fail in.

         maxDaysToPersist is set explicitly because the SDK's default is short (1 day) and
         would quietly discard the exact case this exists for: a member who works a shift
         and doesn't open the app again for several days. Fourteen days is well past any
         plausible gap while still bounding the queue. */
      persistMode: bg.PERSIST_MODE_GEOFENCE,
      maxDaysToPersist: 14,

      /* TEMP — REVERT BEFORE RELEASE.
         Release values are  debug: false  and  logLevel: bg.LOG_LEVEL_ERROR.
         debug:true plays a sound on every transition and posts a notification; VERBOSE
         fills Logcat. Both are desk-test aids and both are wrong on a member's phone. */
      debug: true,
      logLevel: bg.LOG_LEVEL_VERBOSE,
    });
    configured = true;
    // enabled:false is the assertion that this slice is inert — ready() configured the
    // SDK and started nothing.
    return TT("initGeofence", { ok: true, reason: "configured", enabled: !!state?.enabled });
  } catch (e) {
    return TT("initGeofence", { ok: false, reason: "ready-failed", detail: String(e?.message || e) });
  }
}

/* Translate the SDK's authorization integer into something the app can reason about.

   These are the AuthorizationStatus enum values the native layer sends over the bridge
   (NotDetermined 0, Restricted 1, Denied 2, Always 3, WhenInUse 4). The plugin also
   exposes them as AUTHORIZATION_STATUS_* getters, but depending on those makes the whole
   permission gate hinge on legacy aliases surviving: if they ever disappear, every
   comparison quietly evaluates false, authName returns "unknown", and geofencing simply
   never starts with nothing logged and nothing thrown. A silent never-starts is the worst
   failure this file could have, so it reads the wire values directly. */
const AUTH = { 0: "not-determined", 1: "restricted", 2: "denied", 3: "always", 4: "when-in-use" };
function authName(status) {
  return AUTH[status] ?? "unknown";
}

/* Ask the OS for location. Call ONLY after the member has read the disclosure and
   pressed Continue — the whole point of G4b is that this dialog never arrives cold.

   requestPermission() REJECTS rather than resolves when the answer is no, and the
   rejection value is the status itself. Treating that as an error would turn an
   ordinary "no thanks" into a crash report, so both paths are read the same way.

   "when-in-use" is a real, partial outcome and is reported as such: the member said yes
   to something, just not to background. Collapsing it into "denied" would lose the
   difference between a refusal and a half-grant, and G4d needs that difference — it
   decides whether presence can be recorded while the app is closed. */
export async function requestGeofencePermission({ rationale } = {}) {
  const init = await initGeofence({ rationale });
  if (!init.ok) return init;

  const bg = BG;
  let status;
  try {
    status = await bg.requestPermission();
  } catch (e) {
    status = typeof e === "number" ? e : e?.status;
    if (typeof status !== "number") {
      return { ok: false, reason: "request-failed", detail: String(e?.message || e) };
    }
  }

  const name = authName(status);
  return { ok: name === "always", reason: name, status };
}

/* What the OS currently thinks, without asking for anything. Lets Settings tell a member
   the truth ("your phone is blocking this") instead of showing them a switch that claims
   to be on while the OS quietly refuses. Never prompts. */
export async function getGeofencePermission() {
  if (!geofenceAvailable()) {
    return { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" };
  }
  const bg = await loadPlugin();
  if (!bg) return { ok: false, reason: "plugin-missing" };
  try {
    const status = await bg.getProviderState();
    const name = authName(status?.status);
    return { ok: name === "always", reason: name, enabled: !!status?.enabled };
  } catch (e) {
    return { ok: false, reason: "state-failed", detail: String(e?.message || e) };
  }
}

/* Turn it off — remove the fence, drop the listener, stop the plugin.

   Order matters. Remove the fence FIRST so a transition cannot fire while we are tearing
   down, and drop the listener before stop() so a final event can't arrive at a handler
   whose department context is already gone. Every step is idempotent and safe against a
   plugin that was never started. */
export async function stopGeofence() {
  if (!geofenceAvailable()) {
    return { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" };
  }
  const bg = await loadPlugin();
  if (!bg) return { ok: false, reason: "plugin-missing" };
  try {
    await bg.removeGeofences([STATION_FENCE_ID]).catch(() => {});
    fenceSignature = null;
    if (geoSub) { try { geoSub.remove(); } catch { /* already gone */ } geoSub = null; }
    await bg.stop();
    running = false;
    return { ok: true, reason: "stopped" };
  } catch (e) {
    return { ok: false, reason: "stop-failed", detail: String(e?.message || e) };
  }
}


/* ══════════════════════════════════════════════════════════════════════════════
   G4d — the station fence and the handlers that write to the ledger.
   ══════════════════════════════════════════════════════════════════════════════ */

const STATION_FENCE_ID = "b4c-station";

/* A geofence is a TRIGGER, not a verdict. The server decides truth: geofence_arrive
   re-runs is_at_point() against the department's own radius and stamps `verified`
   accordingly, so the fence's job is only to wake us at roughly the right moment.

   The floor exists because OS geofencing does not work at small radii — a 25 m fence
   simply never fires reliably, and a fence that never fires is worse than one that fires
   early. It only bites below 100 m; the 150 m default is untouched. When it DOES bite,
   the gap between fence and station radius produces arrivals the server marks unverified,
   which is the honest outcome and visible in the ledger rather than silently credited. */
const FENCE_MIN_RADIUS_M = 100;

/* Arrival is DWELL, not ENTER. Crossing a line means nothing — someone driving past the
   station at 40 mph crosses it twice and has not turned out. Requiring two minutes inside
   is what separates "arrived" from "went by", and it kills edge-flapping: a phone sitting
   at the boundary re-triggering ENTER/EXIT would otherwise litter the ledger with
   minute-long sessions that all look like real shifts.

   The cost is honest and small: the clock starts at the dwell mark rather than the moment
   of crossing, so a shift loses its first two minutes. Against multi-hour standby that is
   noise, and it buys a number nobody has to explain away. */
/* TEMP — REVERT BEFORE RELEASE. Release value is 2 * 60 * 1000 (120s).
   Lowered to 10s so a single emulator teleport produces a DWELL while you're watching,
   instead of requiring two minutes of simulated loitering. notifyOnDwell / notifyOnEntry
   are unchanged — only the wait is shortened. At 10s the anti-flapping property this
   constant exists for is effectively gone, which is fine at a desk and wrong in the field. */
const FENCE_LOITERING_MS = 10 * 1000;

let fenceSignature = null;   // lat|lng|radius currently registered — re-register when it changes
let geoSub = null;           // the onGeofence subscription; must never stack
let running = false;

/* The handler. Reads coordinates from THE EVENT — never getCurrentPosition().

   That is the binding constraint from G4a: we dropped SCHEDULE_EXACT_ALARM, and without
   exact alarms a backgrounded getCurrentPosition() can fail outright. The event already
   carries the fix it was captured with, which is also the more truthful number — it is
   where the member was when the transition happened, not where they are now that we got
   around to asking.

   REPLAY SAFETY — true only once the Layer 1 migration is applied, and worth stating
   precisely because the earlier version of this comment was wrong. It claimed replay
   "cannot double-open a session" on the strength of arrive returning an existing OPEN
   row. That guard never covered the case that actually matters: the SDK persists every
   transition, this handler does not delete the record it just processed, and so the next
   app open replays arrivals for shifts that have since CLOSED. A closed shift is invisible
   to an open-row check, so the replay inserted a SECOND row and the replayed EXIT closed
   it — every ordinary shift double-counted, not merely the terminated-app case.

   What makes it safe now is that geofence_arrive is idempotent on ARRIVAL TIME, matching a
   row within two minutes of the event timestamp whether that row is open or closed. A
   replayed event carries the timestamp it fired with, so it lands on the row it already
   created and returns it unchanged. Both RPCs still take p_at, so hours are credited to
   when they happened rather than to when the phone got round to saying so. */
async function handleGeofenceEvent(evt, { onEvent } = {}) {
  const action = evt?.action;
  const at = evt?.timestamp || null;    // ISO string; the RPCs bound and clamp it server-side

  // TEMP — REVERT BEFORE RELEASE: prove the transition reached JS at all.
  console.log("[geofence] onGeofence FIRED:", action, evt?.identifier, at, evt?.location?.coords);

  try {
    if (action === "EXIT") {
      const { error } = await supabase.rpc("geofence_depart", { p_at: at });
      if (error) throw error;
      onEvent?.({ action: "depart", at });
      return { ok: true, action: "depart" };
    }

    // DWELL is what we registered for. ENTER is handled identically and defensively: if the
    // registration is ever changed to notify on entry, this keeps working, and the RPC
    // returns the existing open row rather than opening a second one.
    if (action === "DWELL" || action === "ENTER") {
      const c = evt?.location?.coords;
      if (!c || typeof c.latitude !== "number" || typeof c.longitude !== "number") {
        onEvent?.({ action: "error", reason: "event-without-coords" });
        return { ok: false, reason: "event-without-coords" };
      }
      const { error } = await supabase.rpc("geofence_arrive", {
        p_lat: c.latitude,
        p_lng: c.longitude,
        p_accuracy: typeof c.accuracy === "number" ? c.accuracy : null,
        p_at: at,
      });
      if (error) throw error;
      onEvent?.({ action: "arrive", at });
      return { ok: true, action: "arrive" };
    }

    // An action we don't act on (nothing today registers for it).
    return { ok: false, reason: `unhandled-action-${action}` };
  } catch (e) {
    // A failed write must never take down the daemon. The member is still on shift; the
    // sweeper and the manual check-in both remain available, and the next transition gets
    // its own attempt. The RESULT matters to the replay path: a record is only deleted
    // from the queue once its write actually succeeded.
    onEvent?.({ action: "error", reason: String(e?.message || e) });
    return { ok: false, reason: String(e?.message || e) };
  }
}


/* ── Catch-up on next open ─────────────────────────────────────────────────────
   Capacitor has no JS headless task, so a transition that fires while the app is
   terminated reaches nothing and is never re-delivered. This is what makes those
   events recoverable: the SDK persisted them, and on the next open we replay them
   through the SAME path a live event takes.

   The hours come out RIGHT, just late. Each record carries its own coordinates and
   its own timestamp, and both RPCs take p_at, so a shift that ended yesterday is
   written with yesterday's times rather than with the moment we got around to it.

   CHRONOLOGICAL ORDER IS LOAD-BEARING. Replaying an EXIT before its ENTER would
   close nothing and then open a session that never closes. Sorted ascending.

   DELETE ONLY WHAT LANDED. destroyLocation(uuid) per record, after its write
   succeeded — never destroyLocations(), which would clear the whole queue including
   anything that failed or arrived between the read and the delete. A record whose
   write failed stays put and is retried on the next open; the RPCs' idempotency is
   what makes that retry harmless. */
let drained = false;

function persistedToEvent(rec) {
  const g = rec?.geofence || {};
  // Prefer the geofence event's own location/timestamp; fall back to the containing
  // record, whose shape differs slightly depending on how the SDK serialised it.
  const coords = g?.location?.coords || rec?.coords || null;
  return {
    action: g?.action,
    identifier: g?.identifier,
    timestamp: g?.timestamp || rec?.timestamp || null,
    location: coords ? { coords } : null,
  };
}

export async function drainGeofenceQueue({ onEvent } = {}) {
  if (!geofenceAvailable()) {
    return { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" };
  }
  // Once per app open. Re-running on every effect re-fire would replay the queue
  // repeatedly — harmless thanks to idempotency, but pointless work against the network.
  if (drained) return { ok: true, reason: "already-drained" };
  drained = true;

  const bg = await loadPlugin();
  if (!bg) return { ok: false, reason: "plugin-missing" };

  let rows;
  try {
    rows = await bg.getLocations();
  } catch (e) {
    drained = false;                                   // a read that failed is not a drain
    return { ok: false, reason: "read-failed", detail: String(e?.message || e) };
  }

  const pending = (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.geofence?.action)
    .sort((a, b) => String(a?.geofence?.timestamp || a?.timestamp || "")
      .localeCompare(String(b?.geofence?.timestamp || b?.timestamp || "")));

  if (!pending.length) return { ok: true, reason: "nothing-queued", replayed: 0 };

  let replayed = 0, failed = 0;
  for (const rec of pending) {
    // Sequential, not parallel: these are ordered state transitions on one member's
    // shift, and firing them concurrently would race arrive against depart.
    const res = await handleGeofenceEvent(persistedToEvent(rec), { onEvent });
    if (res?.ok && rec?.uuid) {
      await bg.destroyLocation(rec.uuid).catch(() => {});
      replayed++;
    } else {
      failed++;                                        // left in the queue for next time
    }
  }
  return { ok: true, reason: "drained", replayed, failed, total: pending.length };
}

/* Start geofence-only monitoring for this department's station.

   startGeofences(), NEVER start(). start() is continuous tracking — a breadcrumb trail,
   the thing the disclosure promises we do not do. The two calls differ by one word and by
   everything that matters, so this is the only place either may be called.

   Re-registers when the department moves its pin: an officer correcting the station
   location must not leave members fenced to the old one. */
export async function startStationGeofence({ dept, rationale, onEvent } = {}) {
  if (!geofenceAvailable()) {
    return TT("startStationGeofence", { ok: false, reason: Capacitor.isNativePlatform() ? "flag-off" : "web" });
  }
  if (!dept?.geofence_enabled) return TT("startStationGeofence", { ok: false, reason: "dept-not-enabled" });

  const lat = Number(dept?.station_lat);
  const lng = Number(dept?.station_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    // No pin, no fence. Silent would be wrong — this is a department that switched the
    // feature on without finishing the setup it depends on.
    return TT("startStationGeofence", { ok: false, reason: "no-station-pin" });
  }
  const radius = Math.max(Number(dept?.station_radius_m) || 150, FENCE_MIN_RADIUS_M);

  const init = await initGeofence({ rationale });
  if (!init.ok) return TT("startStationGeofence", init);
  const bg = BG;

  // Never prompt from here. Starting is a consequence of permission already granted;
  // a dialog appearing because an effect re-ran is exactly the nagging G4c avoids.
  const perm = await getGeofencePermission();
  console.log("[geofence] getGeofencePermission →", perm);   // TEMP — REVERT BEFORE RELEASE
  if (perm.reason !== "always") return TT("startStationGeofence", { ok: false, reason: `permission-${perm.reason}` });

  try {
    // Listener BEFORE start, and exactly one of them — the push.js rule. A subscription
    // added per render would fire the same transition N times and open N sessions.
    if (!geoSub) geoSub = bg.onGeofence((evt) => handleGeofenceEvent(evt, { onEvent }));

    const signature = `${lat}|${lng}|${radius}`;
    if (fenceSignature !== signature) {
      await bg.removeGeofences([STATION_FENCE_ID]).catch(() => {});
      await bg.addGeofence({
        identifier: STATION_FENCE_ID,
        latitude: lat,
        longitude: lng,
        radius,
        notifyOnEntry: false,          // crossing is not arriving — see FENCE_LOITERING_MS
        notifyOnDwell: true,
        loiteringDelay: FENCE_LOITERING_MS,
        notifyOnExit: true,
      });
      fenceSignature = signature;
      console.log("[geofence] addGeofence registered:", { id: STATION_FENCE_ID, lat, lng, radius, loiteringDelay: FENCE_LOITERING_MS });   // TEMP — REVERT BEFORE RELEASE
    }

    if (!running) {
      await bg.startGeofences();      // geofence-only mode. NOT start().
      running = true;
      console.log("[geofence] startGeofences() returned — monitoring is live");   // TEMP — REVERT BEFORE RELEASE
    }
    return TT("startStationGeofence", { ok: true, reason: "monitoring", radius, dwellMs: FENCE_LOITERING_MS });
  } catch (e) {
    return TT("startStationGeofence", { ok: false, reason: "start-failed", detail: String(e?.message || e) });
  }
}

/* Is the fence actually up? Asked of the plugin rather than of our own flags, because a
   module variable saying "running" survives states the plugin does not. */
export async function isStationGeofenceActive() {
  if (!geofenceAvailable()) return false;
  const bg = await loadPlugin();
  if (!bg) return false;
  try {
    const fences = await bg.getGeofences();
    return Array.isArray(fences) && fences.some((f) => f.identifier === STATION_FENCE_ID);
  } catch { return false; }
}
