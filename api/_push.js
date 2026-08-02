// FCM HTTP v1 sender + notification-row builder, shared by the digest.
// Not an endpoint — the leading underscore keeps Vercel from routing it.
//
// AUTH: FCM v1 needs an OAuth2 token minted from a Firebase SERVICE ACCOUNT
// (client_email + private_key), set as FIREBASE_SERVICE_ACCOUNT in Vercel. The APNs .p8
// is a different credential entirely — it lets Firebase talk to Apple, not us to Firebase.
// The JWT is signed with node:crypto, so this needs no new dependency.
import { createSign } from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const sa = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
    // Vercel env vars often arrive with literal \n rather than real newlines; PEM parsing needs real ones.
    return { ...sa, private_key: String(sa.private_key).replace(/\\n/g, "\n") };
  } catch { return null; }
}

// Mint a short-lived access token. `nowSeconds` is injectable so this is testable without a clock.
async function accessToken(sa, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = `${unsigned}.${signer.sign(sa.private_key, "base64url")}`;

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(`FCM auth failed: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

/* ---------------- notification rows ----------------
   Recipients follow the locked model:
     • cert items  → the member whose cert it is (they're the one who has to renew it)
     • gear + maintenance → each department leader (nobody "owns" an engine's pump test)
   A leader still SEES everything department-wide via RLS; these rows decide who gets
   an unread badge and a push, which is a narrower question than who may read it. */
export function buildNotifications(items, deptId, leaderIds, countedIds) {
  const rows = [];
  for (const it of items) {
    const recipients = it.member_id
      ? (countedIds.has(it.member_id) ? [it.member_id] : [])   // excluded accounts never get notified
      : leaderIds;
    for (const member_id of recipients) {
      rows.push({
        department_id: deptId,
        member_id,
        type: it.kind,
        title: it.title,
        body: it.body,
        subject_ref: it.subject_ref ? String(it.subject_ref) : null,
        severity: it.urgent ? "critical" : "warning",
      });
    }
  }
  return rows;
}

// Insert with ON CONFLICT DO NOTHING against the (member_id, type, subject_ref) unique index —
// the daily cycle re-derives everything from scratch, so this is what stops it restacking.
export async function insertNotifications(sb, rows) {
  if (!rows.length) return { inserted: 0, rows: [] };
  const { data, error } = await sb.from("notifications")
    .upsert(rows, { onConflict: "member_id,type,subject_ref", ignoreDuplicates: true })
    .select("id, member_id, title, body");
  if (error) throw new Error(`notifications insert failed: ${error.message}`);
  return { inserted: (data || []).length, rows: data || [] };   // only genuinely NEW rows come back
}

/* ---------------- push ---------------- */
// Send one message per token. FCM v1 has no multicast in the REST API, so this is inherently
// per-token; sends run sequentially to stay clear of rate limits.
export async function sendPush(sb, notifications, tokensByMember) {
  const sa = serviceAccount();
  if (!sa) return { sent: 0, failed: 0, skipped: "FIREBASE_SERVICE_ACCOUNT missing or malformed" };
  let token;
  try { token = await accessToken(sa); }
  catch (e) { return { sent: 0, failed: 0, error: String(e.message || e) }; }

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
  const dead = [];
  let sent = 0, failed = 0;
  for (const n of notifications) {
    for (const t of tokensByMember.get(n.member_id) || []) {
      const r = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: t,
            notification: { title: n.title, body: n.body || "" },
            data: { notification_id: String(n.id), deep_link: "/notifications" },   // tapping opens the inbox
          },
        }),
      });
      if (r.ok) { sent += 1; continue; }
      failed += 1;
      const err = await r.json().catch(() => ({}));
      const status = err?.error?.details?.[0]?.errorCode || err?.error?.status;
      // UNREGISTERED / INVALID_ARGUMENT on the token = the install is gone. This is the only
      // moment we ever learn a token is dead, so prune it here or it's retried forever.
      if (status === "UNREGISTERED" || r.status === 404) dead.push(t);
    }
  }
  if (dead.length) await sb.from("member_devices").delete().in("token", dead);
  return { sent, failed, pruned: dead.length };
}

export const __test = { serviceAccount, b64url };
