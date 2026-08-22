#!/usr/bin/env node
/* Send ONE push straight to ONE device, bypassing the digest entirely.
 *
 * WHY THIS EXISTS. The digest is the only thing that calls sendPush(), and it suppresses push in
 * both of its preview modes (`?dry=1` and `?to=`), so there is no way to test delivery through it
 * without a full real run — which emails department admins and pushes every officer. Testing a
 * notification pipeline should not require writing a fake certification onto somebody's compliance
 * record and telling their colleagues about it.
 *
 * This proves the same chain the digest uses, because it is deliberately the same code path:
 * service-account JWT -> Google OAuth -> FCM v1 -> APNs/FCM -> the handset. If this works, the
 * only thing left untested in the real flow is the digest's own detection logic.
 *
 * THE CREDENTIAL NEVER LEAVES YOUR MACHINE. Point it at the JSON file or export the env var; the
 * script reads it locally, prints only the project_id and client_email, and never echoes the key.
 *
 * USAGE
 *   # 1. Prove the credentials work. Sends NOTHING — just mints an OAuth token.
 *   node scripts/push-test.mjs --sa ~/Downloads/firebase-sa.json --check
 *
 *   # 2. Send one notification to one device.
 *   node scripts/push-test.mjs --sa ~/Downloads/firebase-sa.json --token "<device token>"
 *
 *   # Or with the env var Vercel already holds:
 *   export FIREBASE_SERVICE_ACCOUNT="$(cat ~/Downloads/firebase-sa.json)"
 *   node scripts/push-test.mjs --token "<device token>"
 *
 * GET THE TOKEN (Supabase SQL editor, after the app has registered on the device):
 *   SELECT m.name, d.platform, d.token, d.updated_at
 *     FROM member_devices d JOIN members m ON m.id = d.member_id
 *    ORDER BY d.updated_at DESC LIMIT 5;
 *
 * DO NOT COMMIT THE SERVICE ACCOUNT JSON. Keep it outside the repo — ~/Downloads is fine, the
 * project directory is not.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);

const saPath = arg("--sa");
const token = arg("--token");
const checkOnly = has("--check");
const title = arg("--title") || "B4C test";
const body = arg("--body") || "If you can read this, push delivery works end to end.";

// ---- credentials ----------------------------------------------------------
// Identical parsing to api/_push.js, including the \n repair: Vercel env vars commonly arrive with
// literal backslash-n rather than real newlines, and PEM parsing fails on the difference.
function serviceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saPath) {
    try { raw = readFileSync(saPath.replace(/^~/, process.env.HOME), "utf8"); }
    catch (e) { die(`Could not read ${saPath}: ${e.message}`); }
  }
  if (!raw) die("No credentials. Pass --sa <path-to-json> or export FIREBASE_SERVICE_ACCOUNT.");
  let sa;
  try { sa = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { die("The service account is not valid JSON. If it came from Vercel, make sure the whole value was copied."); }
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    die("The JSON parsed but is missing client_email, private_key or project_id — that is not a service-account key.\n" +
        "In Firebase: Project settings -> Service accounts -> Generate new private key.");
  }
  return { ...sa, private_key: String(sa.private_key).replace(/\\n/g, "\n") };
}

function die(msg) { console.error(`\n  ERROR  ${msg}\n`); process.exit(1); }

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: sa.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(sa.private_key, "base64url")}`;

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    die(`Google refused the service account (HTTP ${r.status}): ${j.error_description || j.error || "no detail"}\n` +
        `         Usually a revoked/deleted key, or a clock more than a few minutes off.`);
  }
  return j.access_token;
}

/* FCM's failure modes are specific and each points somewhere different. Translating them is most of
   the value here — "500 error" tells you nothing, "your APNs key is missing" tells you everything. */
function explain(status, payload) {
  const err = payload?.error || {};
  const detail = (err.details || []).map((d) => d.errorCode || d.reason).filter(Boolean).join(",");
  const msg = String(err.message || "");

  if (/third_party_auth|APNS|Auth error from APNS/i.test(detail + msg)) {
    return "APNs REJECTED FIREBASE. The device token is fine; Firebase cannot talk to Apple.\n" +
           "         Check Firebase -> Project settings -> Cloud Messaging -> APNs Authentication Key:\n" +
           "         the .p8 must be uploaded with the right Key ID AND Team ID, and the key must cover this bundle id.\n" +
           "         Also check aps-environment matches how the app was built (development for an Xcode run,\n" +
           "         production for TestFlight/App Store) — a mismatch registers a token that can never receive.";
  }
  if (/UNREGISTERED|NOT_FOUND/i.test(detail + msg) || status === 404) {
    return "TOKEN IS DEAD. The install it belonged to is gone (app deleted, or token rotated).\n" +
           "         Re-open the app on the device, re-check member_devices for a newer row, and retry.\n" +
           "         Note the real sender prunes these automatically — this is the same signal it acts on.";
  }
  if (/SENDER_ID_MISMATCH/i.test(detail + msg)) {
    return "WRONG FIREBASE PROJECT. This token was issued by a different project than the service account.\n" +
           "         The GoogleService-Info.plist / google-services.json in the app must belong to the same\n" +
           "         project as the service account you are using here.";
  }
  if (status === 401 || status === 403) {
    return "CREDENTIALS REJECTED. The service account cannot send for this project.\n" +
           "         It needs the Firebase Cloud Messaging API enabled and a role that permits sending.";
  }
  if (/INVALID_ARGUMENT/i.test(detail + msg)) {
    return "MALFORMED REQUEST — usually a truncated or whitespace-padded token. Re-copy it from the DB.";
  }
  return null;
}

// ---- main -----------------------------------------------------------------
const sa = serviceAccount();
console.log(`\n  project      ${sa.project_id}`);
console.log(`  sending as   ${sa.client_email}`);

const oauth = await accessToken(sa);
console.log(`  credentials  OK — OAuth token minted`);

if (checkOnly) {
  console.log(`\n  --check only. FIREBASE_SERVICE_ACCOUNT is valid and can authenticate.`);
  console.log(`  Nothing was sent. Re-run with --token "<device token>" to test delivery.\n`);
  process.exit(0);
}
if (!token) die(`No --token given. Get one with:\n` +
  `           SELECT m.name, d.platform, d.token FROM member_devices d\n` +
  `             JOIN members m ON m.id = d.member_id ORDER BY d.updated_at DESC LIMIT 5;`);

console.log(`  token        …${token.slice(-12)}  (${token.length} chars)`);

const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
  method: "POST",
  headers: { authorization: `Bearer ${oauth}`, "content-type": "application/json" },
  // Same shape api/_push.js sends, so a pass here means the real sender's payload is good too.
  body: JSON.stringify({
    message: {
      token,
      notification: { title, body },
      data: { notification_id: "test", deep_link: "/notifications" },
    },
  }),
});

const payload = await r.json().catch(() => ({}));
if (r.ok) {
  console.log(`\n  SENT  ${payload.name || "(accepted)"}`);
  console.log(`\n  FCM accepted it. That means the credentials, the project and the token are all good.`);
  console.log(`  If nothing appears on the handset, the failure is AFTER FCM:`);
  console.log(`    • app in the foreground — iOS suppresses the banner by default; background it and resend`);
  console.log(`    • Notifications switched off for B4C in iOS Settings`);
  console.log(`    • Focus / Do Not Disturb\n`);
  process.exit(0);
}

console.error(`\n  FAILED  HTTP ${r.status}`);
console.error(`  ${JSON.stringify(payload?.error || payload)}`);
const why = explain(r.status, payload);
if (why) console.error(`\n  LIKELY CAUSE\n         ${why}`);
console.error("");
process.exit(1);
