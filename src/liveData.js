import { useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import { useAutoRefresh, useReconnect } from "./useReconnect";

/* LIVE DATA, SLICE 1b — the department change signal, client side.
   Design: docs/design/live_data_step0.md (gate APPROVED 2026-11-12, D1–D5). DB side (1a) is live: statement-level triggers
   call realtime.send({k, at}, 'live', 'dept:<department_id>', private) — Realtime adds its own message id to the payload.
   The private-channel join is authorized by live_dept_receive: a member may join only 'dept:' || my_department_id().

   WHAT THIS DOES. One private Realtime channel per app session, on the member's department topic. A screen says which keys
   it cares about (useLiveRefresh(["trainings"], loader)); a signal for one of those keys asks that screen's existing
   useAutoRefresh to run its loader "as soon as allowed" — the same in-flight guard, open-editor guard and resume-dead retry
   every resume refresh already goes through, plus a 1.5s trailing debounce and a 5s minimum interval (D4). A signal carries
   no row data; the screen re-reads through the access rules it already has.

   SILENT BY CONTRACT. Nothing here throws into the UI or renders anything. If the socket cannot connect, errors or drops,
   the app behaves exactly as it did before 1b: the resume refresh still runs. On resume a broken channel is rebuilt.
   Auth: supabase-js re-authorizes the socket on TOKEN_REFRESHED itself (verified, Step 0 §6 condition 2) — no token
   pushing here. SIGNED_OUT leaves the channel; SIGNED_IN re-checks the department and rejoins if it changed.

   KILL SWITCH: VITE_LIVE_DATA_ENABLED=0 at build time turns all of this off (no channel is ever created); every screen
   falls back to its resume refresh. On by default. */

export const LIVE_ENABLED = (() => {
  try { return import.meta.env?.VITE_LIVE_DATA_ENABLED !== "0"; } catch { return true; }
})();
export const LIVE_EVENT = "live";
export const LIVE_DEBOUNCE_MS = 1500;
export const LIVE_MIN_INTERVAL_MS = 5000;

const log = (...a) => { try { console.info("[live]", ...a); } catch { /* no console */ } };

const subs = new Map();      // k -> Set<fn>
let subscriberCount = 0;
let channel = null;          // the one channel
let topic = null;            // 'dept:<id>' it is on
let broken = false;          // the channel errored / timed out / closed under us
let joining = null;          // in-flight join promise
let authWired = false;

function dispatch(payload) {
  const k = payload && typeof payload === "object" ? payload.k : null;
  if (!k) return;
  const set = subs.get(k);
  if (!set) return;
  for (const fn of [...set]) { try { fn(payload); } catch { /* a subscriber must never break the others */ } }
}

async function departmentTopic() {
  const { data, error } = await supabase.rpc("my_department_id");
  if (error || !data) return null;
  return `dept:${data}`;
}

function leave(why) {
  const ch = channel;
  channel = null; topic = null; broken = false;
  if (ch) {
    try { supabase.removeChannel(ch); } catch { /* already gone */ }
    log("left", why || "");
  }
}

function join() {
  if (!LIVE_ENABLED) return Promise.resolve();
  if (joining) return joining;
  if (channel && !broken) return Promise.resolve();
  joining = (async () => {
    const t = await departmentTopic();
    if (!t || subscriberCount === 0) return;                 // no department / nobody listening any more
    if (channel && !broken && topic === t) return;
    if (channel) leave(broken ? "rebuild" : "topic changed");
    const ch = supabase.channel(t, { config: { private: true } });
    ch.on("broadcast", { event: LIVE_EVENT }, (msg) => dispatch(msg && msg.payload));
    channel = ch; topic = t; broken = false;
    ch.subscribe((status) => {
      if (ch !== channel) return;                            // a channel we already left
      if (status === "SUBSCRIBED") { broken = false; log("joined", t); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") { broken = true; log("channel", status); }
    });
  })()
    .catch((e) => { log("join failed", e && e.message ? e.message : e); })
    .finally(() => { joining = null; });
  return joining;
}

function wireAuth() {
  if (authWired || !LIVE_ENABLED) return;
  authWired = true;
  try {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") { leave("signed out"); return; }
      if (event === "SIGNED_IN" && subscriberCount > 0) {
        // Another user may have signed in on this device: the department (and so the topic) can differ.
        departmentTopic().then((t) => {
          if (subscriberCount === 0) return;
          if (!t) { leave("no department"); return; }
          if (t !== topic || !channel || broken) { leave("re-sign-in"); join(); }
        }).catch(() => { /* silent */ });
      }
    });
  } catch { authWired = false; }
}

/* On resume: rebuild a channel that broke while we were away (or never joined). Idempotent and cheap when healthy. */
export function ensureLive() {
  if (!LIVE_ENABLED || subscriberCount === 0) return;
  if (!channel || broken) join();
}

function subscribe(keys, fn) {
  for (const k of keys) {
    if (!subs.has(k)) subs.set(k, new Set());
    subs.get(k).add(fn);
  }
  subscriberCount += 1;
  wireAuth();
  join();
  return () => {
    for (const k of keys) { const s = subs.get(k); if (s) { s.delete(fn); if (!s.size) subs.delete(k); } }
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) leave("no subscribers");
  };
}

/* useLiveRefresh(keys, loader, opts) — the screen-facing hook. It IS the screen's useAutoRefresh (so resume behaviour is
   unchanged and there is still exactly one refresher per loader), plus: a matching change signal → 1.5s trailing debounce
   → the auto-refresh trigger with a 5s minimum interval, which waits out an open editor and an in-flight load rather than
   dropping the request. With the kill switch off it is exactly useAutoRefresh. */
export function useLiveRefresh(keys, loader, { minIntervalMs, debounceMs = LIVE_DEBOUNCE_MS, liveMinIntervalMs = LIVE_MIN_INTERVAL_MS, skipWhen } = {}) {
  const trigger = useAutoRefresh(loader, { ...(minIntervalMs != null ? { minIntervalMs } : {}), skipWhen });
  const timerRef = useRef(null);
  const keyStr = (Array.isArray(keys) ? keys : [keys]).filter(Boolean).join("|");

  useReconnect(() => { ensureLive(); });

  useEffect(() => {
    if (!LIVE_ENABLED || !keyStr) return undefined;
    const onSignal = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { timerRef.current = null; trigger({ minIntervalMs: liveMinIntervalMs }); }, debounceMs);
    };
    const off = subscribe(keyStr.split("|"), onSignal);
    return () => { clearTimeout(timerRef.current); timerRef.current = null; off(); };
  }, [keyStr, trigger, debounceMs, liveMinIntervalMs]);
}

// test seam: module state snapshot (never used by the app)
export const __liveState = () => ({ channel, topic, broken, subscriberCount, keys: [...subs.keys()] });
