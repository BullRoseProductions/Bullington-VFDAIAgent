/* The scanned-QR stash — the rules that decide whether a check-in is recorded, or recorded twice.
 *
 * Runs with no browser and no database: `node src/pendingScan.test.mjs`.
 *
 * WHAT THIS PROVES. The parts that fail INVISIBLY: that an expired stash cannot fire, that a
 * replayed stash is spent so the same scan cannot be recorded twice, that a hostile or broken
 * localStorage degrades to a no-op instead of throwing on the app's critical path, and that the
 * redirect URL is one the router will actually recognise.
 *
 * WHAT IT CANNOT PROVE. That Safari, the mail app and Supabase behave as expected end-to-end —
 * that is the manual matrix, and it needs real sessions and a real emailed link.
 *
 * The consume-once and TTL cases matter most. A lost check-in is visible and recoverable: the
 * member scans again. A PHANTOM check-in — a stale stash firing at an unrelated login days later —
 * writes attendance at a drill nobody attended, on a screen that gave no reason to look.
 */
import {
  PENDING_SCAN_KEY, PENDING_SCAN_TTL_MS,
  parseScan, capturePendingScan, readFreshPendingScan, clearPendingScan,
  consumePendingScan, scanRedirectUrl,
} from "./pendingScan.js";

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed += 1; console.log(`  ok   ${label}`); return; }
  failed += 1;
  console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
}
// A localStorage stand-in. `mode` lets a test make it behave like private mode or a full quota.
function fakeStorage(mode) {
  const map = new Map();
  return {
    map,
    getItem: (k) => { if (mode === "throw-read" || mode === "throw-all") throw new Error("SecurityError"); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (mode === "throw-write" || mode === "throw-all") throw new Error("QuotaExceededError"); map.set(k, v); },
    removeItem: (k) => { if (mode === "throw-all") throw new Error("SecurityError"); map.delete(k); },
  };
}
const stash = (s, over = {}) => s.map.set(PENDING_SCAN_KEY, JSON.stringify({ kind: "checkin", id: "sess-1", token: "tok-1", ts: Date.now(), ...over }));

console.log("\nPARSING — what counts as a scan, and which parameter wins.");
{
  check("a check-in URL", parseScan("?checkin=abc&t=xyz"), { kind: "checkin", id: "abc", token: "xyz" });
  check("a handoff URL", parseScan("?handoff=h1&t=c1"), { kind: "handoff", id: "h1", token: "c1" });
  // Must match routeDeepLink's order, or the two routers disagree about the same URL.
  check("checkin wins over handoff, matching routeDeepLink", parseScan("?handoff=h1&checkin=c9&t=t1").kind, "checkin");
  check("a token-less code is still captured — the server rejects it with a real message", parseScan("?checkin=abc"), { kind: "checkin", id: "abc", token: null });
  check("an unrelated URL is not a scan", parseScan("?type=recovery"), null);
  check("an empty search is not a scan", parseScan(""), null);
  check("undefined is not a scan", parseScan(undefined), null);
}

console.log("\nCAPTURE — written before the auth gate, whether or not they are signed in.");
{
  const s = fakeStorage();
  capturePendingScan("?checkin=sess-9&t=tok-9", s);
  const v = JSON.parse(s.map.get(PENDING_SCAN_KEY));
  check("stored under the shared key", [v.kind, v.id, v.token], ["checkin", "sess-9", "tok-9"]);
  check("stamped with a time", typeof v.ts === "number" && v.ts > 0, true);

  const s2 = fakeStorage();
  capturePendingScan("?type=recovery", s2);
  check("a password-reset URL stashes nothing", s2.map.size, 0);
}

console.log("\nTTL — an old scan must never fire.");
{
  const s = fakeStorage();
  stash(s, { ts: Date.now() - (PENDING_SCAN_TTL_MS + 1000) });
  check("a stash past the TTL is ignored", readFreshPendingScan(s), null);
  check("...and is cleared, so it cannot be re-examined at every future login", s.map.size, 0);

  const s2 = fakeStorage();
  stash(s2, { ts: Date.now() - (PENDING_SCAN_TTL_MS - 5000) });
  check("a stash just inside the TTL is honoured", readFreshPendingScan(s2)?.id, "sess-1");

  // A device whose clock was wrong when the scan happened would otherwise hold a stash that never
  // expires — every future check would compute a negative age and call it fresh.
  const s3 = fakeStorage();
  stash(s3, { ts: Date.now() + 60 * 60 * 1000 });
  check("a stash stamped in the FUTURE is treated as stale, not eternally fresh", readFreshPendingScan(s3), null);
}

console.log("\nCONSUME ONCE — the guard against a duplicate attendance record.");
{
  const s = fakeStorage();
  stash(s);
  const first = consumePendingScan(s);
  check("the first replay gets the scan", first?.id, "sess-1");
  check("the key is gone the moment it is read", s.map.size, 0);
  check("a second replay — StrictMode, a retry, a later login — gets nothing", consumePendingScan(s), null);
}

console.log("\nMALFORMED — corrupt or half-written records are not acted on.");
{
  for (const [label, raw] of [
    ["not JSON", "{{{"],
    ["null", "null"],
    ["an unknown kind", JSON.stringify({ kind: "delete-everything", id: "x", ts: Date.now() })],
    ["no id", JSON.stringify({ kind: "checkin", ts: Date.now() })],
    ["an empty id", JSON.stringify({ kind: "checkin", id: "", ts: Date.now() })],
    ["no timestamp", JSON.stringify({ kind: "checkin", id: "x" })],
    ["a non-numeric timestamp", JSON.stringify({ kind: "checkin", id: "x", ts: "yesterday" })],
  ]) {
    const s = fakeStorage();
    s.map.set(PENDING_SCAN_KEY, raw);
    check(`${label} is ignored`, readFreshPendingScan(s), null);
  }
}

console.log("\nSTORAGE UNAVAILABLE — private mode must not blank the app.");
{
  // This runs at module scope on the import stack in main.jsx. An uncaught throw here is a white
  // screen, which is a far worse outcome than the lost check-in it was trying to prevent.
  check("a write that throws is swallowed", capturePendingScan("?checkin=a&t=b", fakeStorage("throw-write")), null);
  check("a read that throws returns null", readFreshPendingScan(fakeStorage("throw-read")), null);
  check("a storage that throws on everything still returns null", readFreshPendingScan(fakeStorage("throw-all")), null);
  check("consume on a dead storage returns null", consumePendingScan(fakeStorage("throw-all")), null);
  clearPendingScan(fakeStorage("throw-all"));
  check("clear on a dead storage does not throw", true, true);
  // No window and no injected storage — the native/SSR shape.
  check("no storage at all: capture is a no-op", capturePendingScan("?checkin=a&t=b"), null);
  check("no storage at all: read is null", readFreshPendingScan(), null);
}

console.log("\nREDIRECT — the magic link must return to a URL the router recognises.");
{
  const url = scanRedirectUrl("https://app.b4thecall.com", { kind: "checkin", id: "s1", token: "t1" });
  check("check-in redirect", url, "https://app.b4thecall.com/checkin?checkin=s1&t=t1");
  check("the router would act on it", parseScan(new URL(url).search), { kind: "checkin", id: "s1", token: "t1" });

  const h = scanRedirectUrl("https://app.b4thecall.com", { kind: "handoff", id: "h1", token: "c1" });
  check("handoff redirect", h, "https://app.b4thecall.com/handoff?handoff=h1&t=c1");
  check("the router would act on that too", parseScan(new URL(h).search), { kind: "handoff", id: "h1", token: "c1" });

  check("no token: no empty t= parameter", scanRedirectUrl("https://x.test", { kind: "checkin", id: "s1", token: null }), "https://x.test/checkin?checkin=s1");
  check("no scan: no redirect, so sendLink falls back to APP_URL", scanRedirectUrl("https://x.test", null), null);
  // Ids come from the server as uuids, but the encoder must not be the weak link if that changes.
  check("ids are URL-encoded", scanRedirectUrl("https://x.test", { kind: "checkin", id: "a b&c", token: "t/1" }), "https://x.test/checkin?checkin=a+b%26c&t=t%2F1");
}

console.log("\nEND TO END, in memory: scan → login wall → replay.");
{
  const s = fakeStorage();                                    // one origin, shared across tabs
  capturePendingScan("?checkin=drill-77&t=tok-77", s);        // main.jsx, before the gate
  const atLogin = readFreshPendingScan(s);                    // Login.jsx builds the redirect
  check("the login screen can still see the scan", atLogin?.id, "drill-77");
  check("and does not consume it — the replay still needs it", s.map.size, 1);
  check("redirect carries it through the email", scanRedirectUrl("https://app.b4thecall.com", atLogin), "https://app.b4thecall.com/checkin?checkin=drill-77&t=tok-77");
  const replayed = consumePendingScan(s);                     // App.jsx, first mount after auth
  check("the replay fires with the right code and token", [replayed?.id, replayed?.token], ["drill-77", "tok-77"]);
  check("nothing is left to fire again", readFreshPendingScan(s), null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
