// POST /api/invite — send someone their way into B4C: an invite for a brand-new account, a sign-in link for an existing one.
// Signup closure (H-2) Slice 1. Replaces the client's signInWithOtp at the three admin sites (add member, new department's DA,
// Resend), which only ever created the account because public signups were open — the dashboard flip closes that, so the one
// account-creating path left is this endpoint, behind the same department-admin checks the app already enforces.
//
// ORDER IS THE POINT. Everything up to the admin call runs AS THE CALLER (anon key + their JWT, requireMember's client), through
// the same functions and RLS the app uses; only once a check has passed does the service key touch anything:
//   1. requireMember — a valid session that resolves to an Active/Probationary member of their active department (401/403/503)
//   2. DA path:  is_dept_admin() (Project Admin or Department Admin of the caller's CURRENT department)
//               AND the address is on that department's roster — read through RLS, so it can only ever be their own roster
//      PA path:  is_project_admin() AND the address is a department's DA in pa_department_radar() (Ashlea's ruling: DAs only)
//      neither  → 403 not-authorized · an admin, but not on the roster / not a DA → 404 not-on-roster
//   3. auth.admin.inviteUserByEmail(email, { redirectTo: APP_ORIGIN }) with the service key (sb_secret_ — legacy JWT keys are
//      disabled on this project). Creates the account and sends Supabase's "Invite user" email. Works with signups OFF.
//   4. Already an account (email_exists) → a Supabase-sent sign-in link via signInWithOtp with shouldCreateUser:false — that
//      call can never create an account, so the fallback can't reopen what the flip closed.
// The department is never taken from the client: the DA path uses my_department_id() (inside RLS), the PA path the radar.
// Failures answer cron-honesty style — { ok:false, failed:[step] } — and the details go to the log only: never the service
// key, never Supabase's raw message in the body, and the target address logged by domain only.
import { createClient } from "@supabase/supabase-js";
import { cors } from "./_cors.js";
import { requireMember } from "./_auth.js";

// The origin the emailed link lands on. Same rule as the client's APP_ORIGIN and _cors.js: the production origin, never the
// request's own Origin (a preview or a native capacitor:// origin must not be baked into an emailed link).
export const APP_ORIGIN = (process.env.VITE_APP_URL || process.env.APP_URL || "https://app.b4thecall.com").replace(/\/$/, "");

const EMAIL_RE = /^\S+@\S+\.\S+$/;
export const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
// ilike treats % and _ as wildcards — and _ is common in addresses. Escape them so the roster match is exact.
const ilikeExact = (e) => e.replace(/[\\%_]/g, (c) => `\\${c}`);
const domainOf = (e) => (e.includes("@") ? `*@${e.split("@").pop()}` : "(none)");

// Supabase's "already registered" — the code on current GoTrue, the message on older ones.
export const isEmailExists = (err) => !!err && (err.code === "email_exists" || err.code === "user_already_exists" || /already (been )?registered/i.test(err.message || ""));
export const isRateLimited = (err) => !!err && (err.status === 429 || /rate.?limit/i.test(err.code || "") || /rate limit/i.test(err.message || ""));

function fail(res, status, step, log) {
  if (log) console.error(`[invite] FAILED ${step}:`, log);
  return res.status(status).json({ ok: false, failed: [step] });
}

// → "da" | "pa" | null, or throws (a check that couldn't run is not a "no").
export async function authorize(sb, deptId, target) {
  const da = await sb.rpc("is_dept_admin");
  if (da.error) throw new Error(`is_dept_admin: ${da.error.message}`);
  let admin = false;
  if (da.data === true) {
    admin = true;
    const { data, error } = await sb.from("members").select("id, email").eq("department_id", deptId).ilike("email", ilikeExact(target)).limit(2);
    if (error) throw new Error(`roster read: ${error.message}`);
    if ((data || []).some((m) => normalizeEmail(m.email) === target)) return { mode: "da" };
  }
  const pa = await sb.rpc("is_project_admin");
  if (pa.error) throw new Error(`is_project_admin: ${pa.error.message}`);
  if (pa.data === true) {
    admin = true;
    const { data, error } = await sb.rpc("pa_department_radar");
    if (error) throw new Error(`pa_department_radar: ${error.message}`);
    if ((data || []).some((d) => normalizeEmail(d.admin_email) === target)) return { mode: "pa" };
  }
  return { mode: null, admin };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;   // preflight answered; also sets ACAO on the real request
  if (req.method !== "POST") return res.status(405).json({ ok: false, failed: ["method"] });
  const ctx = await requireMember(req, res);   // 401 / 403 / 503 already sent
  if (!ctx) return;

  const target = normalizeEmail(req.body?.email);
  if (!EMAIL_RE.test(target)) return fail(res, 400, "email");

  let auth;
  try {
    auth = await authorize(ctx.sb, ctx.deptId, target);
  } catch (e) {
    return fail(res, 503, "authorize", `${e.message} (member ${ctx.memberId})`);
  }
  if (!auth.mode) return auth.admin ? fail(res, 404, "not-on-roster") : fail(res, 403, "not-authorized");

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) {
    return fail(res, 500, "config", `missing ${[!url && "SUPABASE_URL", !serviceKey && "SUPABASE_SERVICE_ROLE_KEY", !anonKey && "SUPABASE_ANON_KEY"].filter(Boolean).join(", ")}`);
  }
  const who = `${auth.mode} member ${ctx.memberId} → ${domainOf(target)}`;

  // 3 — a brand-new account: the admin invite (the only path that creates one once signups are off)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let inv;
  try {
    inv = await admin.auth.admin.inviteUserByEmail(target, { redirectTo: APP_ORIGIN });
  } catch (e) {
    return fail(res, 502, "invite", `${who}: ${e.message}`);
  }
  if (!inv.error) return res.status(200).json({ ok: true, sent: "invite", mode: auth.mode });
  if (isRateLimited(inv.error)) return fail(res, 429, "rate-limit", `${who}: invite ${inv.error.status || ""} ${inv.error.code || ""}`);
  if (!isEmailExists(inv.error)) return fail(res, 502, "invite", `${who}: ${inv.error.status || ""} ${inv.error.code || ""} ${inv.error.message || ""}`);

  // 4 — an existing account: a Supabase-sent sign-in link that can NEVER create one
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let otp;
  try {
    otp = await anon.auth.signInWithOtp({ email: target, options: { shouldCreateUser: false, emailRedirectTo: APP_ORIGIN } });
  } catch (e) {
    return fail(res, 502, "login-link", `${who}: ${e.message}`);
  }
  if (!otp.error) return res.status(200).json({ ok: true, sent: "login-link", mode: auth.mode });
  if (isRateLimited(otp.error)) return fail(res, 429, "rate-limit", `${who}: login-link ${otp.error.status || ""} ${otp.error.code || ""}`);
  return fail(res, 502, "login-link", `${who}: ${otp.error.status || ""} ${otp.error.code || ""} ${otp.error.message || ""}`);
}
