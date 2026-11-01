// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/signup_invite_test.mjs
// No network, no DB. Signup closure (H-2) Slice 1 — the invite endpoint + the client migration.
//   1. api/invite.js, bundled against a fake @supabase/supabase-js that records every client built (by key), every RPC and
//      roster read (as whom), every admin invite and every OTP:
//      refusals — no token 401; a plain member 403 not-authorized; a DA inviting an address NOT on their roster 404 (and one
//      on ANOTHER department's roster 404 — the roster read is scoped to my_department_id(), never the body); a PA inviting
//      a non-DA address 404; a check that can't run 503 — and in every refusal the service-key client is NEVER built and no
//      invite / OTP is sent. Happy paths — DA (own roster) and PA (a DA in pa_department_radar) each call
//      auth.admin.inviteUserByEmail exactly once with { redirectTo: APP_ORIGIN }. Existing account (email_exists) → the
//      Supabase-sent sign-in link with shouldCreateUser:false, nothing else that could create. 429 / 502 / 500 bodies are
//      terse step names; the log carries the detail but never the service key or the full target address.
//   2. src/authLinks.js (fakes for supabaseClient + apiBase): the sign-in screen's link asks with shouldCreateUser:false;
//      the no-account refusal maps to Ashlea's sentence; sendInvite turns every endpoint answer into honest words.
//   3. D, the REAL src/Login.jsx in happy-dom: an unknown address → "No account yet — ask your department admin to add you.",
//      and the only auth call made was signInWithOtp with shouldCreateUser:false (no signUp, nothing that creates).
//   4. the three admin sites in src/App.jsx call sendInvite; no signInWithOtp left outside authLinks' login link.
//   fences: only the expected files; no SQL; vercel.json untouched; verified 132/32/14; Notify held.
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "f10383f";   // live main when this was drafted (industrial-noir-55)
// Structural fences PINNED to the reviewed range: base f10383f .. reviewed 919b579 — "vs the working tree" would go red once
// later work lands. REV=<sha> (or REV="" for the working tree) overrides. The behavior checks run on today's code.
const REV = process.env.REV ?? "919b579";
const SVC = "sb_secret_TESTKEY_never_in_a_body";
Object.assign(process.env, { SUPABASE_URL: "https://x.supabase.test", SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: SVC, VITE_APP_URL: "https://app.b4thecall.com" });
const outDir = mkdtempSync(join(tmpdir(), "b4c-invite-"));

// ================================================================ 1. the endpoint
const FAKE_SB = `
export function createClient(url, key, opts) {
  const S = globalThis.__S;
  const as = (opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || null;
  S.clients.push({ key, as });
  const q = (table) => { const f = { table, as, ops: [] }; const b = {};
    for (const m of ["select", "eq", "ilike", "limit", "in", "is", "order"]) b[m] = (...a) => { f.ops.push([m, ...a]); return b; };
    b.then = (r, j) => Promise.resolve((() => { S.reads.push(f); return S.read(f); })()).then(r, j); return b; };
  return {
    auth: {
      getUser: async (tok) => (S.users[tok] ? { data: { user: S.users[tok] }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } }),
      admin: { inviteUserByEmail: async (email, o) => { S.invites.push({ key, email, o }); return S.invite(email); },
               createUser: async () => { S.creates.push(1); return { data: null, error: null }; } },
      signInWithOtp: async (args) => { S.otps.push({ key, args }); return S.otp(args); },
      signUp: async () => { S.creates.push(1); return { data: null, error: null }; },
    },
    rpc: async (name, args) => { S.rpcs.push({ name, as }); return S.rpc(name, args); },
    from: (t) => q(t),
  };
}`;
const endpointOut = join(outDir, "invite.mjs");
await build({ entryPoints: [join(root, "api/invite.js")], bundle: true, format: "esm", platform: "node", outfile: endpointOut, logLevel: "silent",
  plugins: [{ name: "fake-sb", setup(b) {
    b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
  } }] });
const invite = (await import(pathToFileURL(endpointOut).href)).default;

// PostgREST ilike semantics: % any run, _ one char, \x a literal x.
const escRe = (c) => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
function likeToRe(pat) {
  let out = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "\\" && i + 1 < pat.length) out += escRe(pat[++i]);
    else if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else out += escRe(c);
  }
  return new RegExp("^" + out + "$", "i");
}
const ROSTER = [
  { department_id: "d1", email: "Newbie@Example.test" },     // mixed case on purpose
  { department_id: "d1", email: "a_b@example.test" },
  { department_id: "d2", email: "other@example.test" },      // someone else's department
];
const RADAR = [{ department_id: "d1", admin_email: "chief@example.test" }, { department_id: "d3", admin_email: "newda@fresh.test" }];
function world({ da = false, pa = false, member = true, radarErr = false, invite = { data: { user: { id: "u-new" } }, error: null }, otp = { data: {}, error: null } } = {}) {
  globalThis.__S = {
    users: { "tok-ok": { id: "u1", email: "caller@example.test" } },
    clients: [], rpcs: [], reads: [], invites: [], otps: [], creates: [],
    rpc: (name) => {
      if (name === "my_member_id") return { data: member ? "m1" : null, error: null };
      if (name === "my_department_id") return { data: member ? "d1" : null, error: null };
      if (name === "is_dept_admin") return { data: da, error: null };
      if (name === "is_project_admin") return { data: pa, error: null };
      if (name === "pa_department_radar") return radarErr ? { data: null, error: { message: "Not authorized" } } : (pa ? { data: RADAR, error: null } : { data: null, error: { message: "Not authorized" } });
      return { data: null, error: null };
    },
    read: (f) => {   // members, filtered exactly as PostgREST would: eq department_id, ilike email (with \\-escapes honoured)
      const dept = f.ops.find((o) => o[0] === "eq" && o[1] === "department_id")?.[2];
      const pat = f.ops.find((o) => o[0] === "ilike")?.[2] ?? "";
      const re = likeToRe(pat);
      return { data: ROSTER.filter((r) => r.department_id === dept && re.test(r.email)), error: null };
    },
    invite: () => invite, otp: () => otp,
  };
}
const logs = [];
const origErr = console.error; console.error = (...a) => logs.push(a.join(" "));
async function call({ token = "tok-ok", body = { email: "newbie@example.test" }, method = "POST", origin = "https://app.b4thecall.com" } = {}) {
  logs.length = 0;
  const res = { code: 0, body: null, headers: {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } };
  await invite({ method, headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body }, res);
  return res;
}
const S = () => globalThis.__S;
const svcBuilt = () => S().clients.some((c) => c.key === SVC);
const nothingSent = () => !svcBuilt() && S().invites.length === 0 && S().otps.length === 0 && S().creates.length === 0;

world(); let r = await call({ token: null });
ok("no token → 401; no service client, nothing sent", r.code === 401 && nothingSent(), `${r.code}`);
world({ member: false }); r = await call();
ok("signed in but not a member of a department → 403 (requireMember); nothing sent", r.code === 403 && nothingSent(), `${r.code}`);
world({ da: false, pa: false }); r = await call();
ok("REFUSES a non-DA/PA caller → 403 { ok:false, failed:[\"not-authorized\"] }; no service client, nothing sent",
  r.code === 403 && JSON.stringify(r.body) === '{"ok":false,"failed":["not-authorized"]}' && nothingSent(), JSON.stringify(r.body));
world({ da: true }); r = await call({ body: { email: "stranger@nowhere.test" } });
ok("REFUSES a DA inviting an email NOT on their roster → 404 not-on-roster; nothing sent", r.code === 404 && r.body.failed[0] === "not-on-roster" && nothingSent(), JSON.stringify(r.body));
world({ da: true }); r = await call({ body: { email: "other@example.test", department_id: "d2" } });
ok("…and an address on ANOTHER department's roster → 404, even with department_id \"d2\" in the body (never read from the client)",
  r.code === 404 && nothingSent() && S().reads.every((f) => f.ops.some((o) => o[0] === "eq" && o[1] === "department_id" && o[2] === "d1")), JSON.stringify(S().reads.map((f) => f.ops)));
world({ da: true }); r = await call({ body: { email: "axb@example.test" } });
ok("roster match is exact: \"axb@\" does not match \"a_b@\" (ilike wildcards escaped)", r.code === 404 && nothingSent(), `${r.code}`);
world({ pa: true }); r = await call({ body: { email: "newbie@example.test" } });
ok("REFUSES a PA inviting a non-DA address → 404 not-on-roster; nothing sent", r.code === 404 && nothingSent() && S().rpcs.some((x) => x.name === "pa_department_radar"), JSON.stringify(r.body));
world({ pa: true, radarErr: true }); r = await call({ body: { email: "newda@fresh.test" } });
ok("a check that can't run (radar errors) → 503 authorize, logged; nothing sent", r.code === 503 && r.body.failed[0] === "authorize" && nothingSent() && logs.some((l) => /pa_department_radar/.test(l)), `${r.code}`);

world({ da: true }); r = await call({ body: { email: "  NEWBIE@example.test " } });
const da = S();
ok("DA HAPPY PATH: own-roster address → auth.admin.inviteUserByEmail ONCE, with the service key, redirectTo APP_ORIGIN; 200 sent:\"invite\"",
  r.code === 200 && r.body.sent === "invite" && r.body.mode === "da" && da.invites.length === 1 && da.invites[0].key === SVC
  && da.invites[0].email === "newbie@example.test" && JSON.stringify(da.invites[0].o) === '{"redirectTo":"https://app.b4thecall.com"}' && da.otps.length === 0, JSON.stringify(r.body));
ok("…the authorization ran AS THE CALLER (their JWT) — is_dept_admin + the roster read — before the service client was built",
  da.rpcs.filter((x) => x.name === "is_dept_admin").every((x) => x.as === "Bearer tok-ok") && da.reads.every((f) => f.as === "Bearer tok-ok")
  && da.clients.findIndex((c) => c.key === SVC) > da.clients.findIndex((c) => c.as === "Bearer tok-ok"));
world({ pa: true }); r = await call({ body: { email: "newda@fresh.test" } });
ok("PA HAPPY PATH: a DA address from pa_department_radar → inviteUserByEmail once; 200 sent:\"invite\" mode pa",
  r.code === 200 && r.body.mode === "pa" && S().invites.length === 1 && S().invites[0].email === "newda@fresh.test", JSON.stringify(r.body));

world({ da: true, invite: { data: null, error: { status: 422, code: "email_exists", message: "A user with this email address has already been registered" } } }); r = await call();
ok("EXISTING ACCOUNT: email_exists → the Supabase-sent sign-in link, shouldCreateUser:false, redirect APP_ORIGIN, on the ANON key; 200 sent:\"login-link\"",
  r.code === 200 && r.body.sent === "login-link" && S().otps.length === 1 && S().otps[0].key === "anon-test"
  && S().otps[0].args.options.shouldCreateUser === false && S().otps[0].args.options.emailRedirectTo === "https://app.b4thecall.com", JSON.stringify(S().otps[0]?.args));
ok("…and nothing on that path can create: no createUser / signUp, no second invite", S().creates.length === 0 && S().invites.length === 1);
world({ da: true, invite: { data: null, error: { status: 422, message: "A user with this email address has already been registered" } } }); r = await call();
ok("existing account recognised by the older message shape too", r.code === 200 && r.body.sent === "login-link");

world({ da: true, invite: { data: null, error: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" } } }); r = await call();
ok("rate limit → 429 { ok:false, failed:[\"rate-limit\"] }", r.code === 429 && JSON.stringify(r.body) === '{"ok":false,"failed":["rate-limit"]}');
world({ da: true, invite: { data: null, error: { status: 500, code: "unexpected_failure", message: "Database error saving new user" } } }); r = await call();
ok("admin failure → 502 terse { ok:false, failed:[\"invite\"] }; the detail is in the log, not the body",
  r.code === 502 && JSON.stringify(r.body) === '{"ok":false,"failed":["invite"]}' && logs.some((l) => /\[invite\] FAILED invite/.test(l) && /unexpected_failure/.test(l)), logs.join(" | "));
ok("…the log names the domain only (*@example.test), never the full address, never the service key",
  logs.some((l) => l.includes("*@example.test")) && !logs.some((l) => l.includes("newbie@") || l.includes(SVC)));
world({ da: true, invite: { data: null, error: { status: 422, code: "email_exists" } }, otp: { data: null, error: { status: 500, code: "unexpected_failure", message: "smtp down" } } }); r = await call();
ok("existing account but the link fails → 502 failed:[\"login-link\"]", r.code === 502 && r.body.failed[0] === "login-link");
const saved = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
world({ da: true }); r = await call();
ok("service key missing → 500 failed:[\"config\"], logged by NAME; nothing sent", r.code === 500 && r.body.failed[0] === "config" && nothingSent() && logs.some((l) => /SUPABASE_SERVICE_ROLE_KEY/.test(l)));
process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
world({ da: true }); r = await call({ body: { email: "not-an-email" } });
ok("malformed email → 400 failed:[\"email\"]; nothing sent", r.code === 400 && r.body.failed[0] === "email" && nothingSent());
world({ da: true }); r = await call({ method: "GET" });
ok("GET → 405", r.code === 405 && nothingSent());
world(); r = await call({ method: "OPTIONS", origin: "capacitor://localhost" });
ok("CORS preflight from the native app → 204 with POST + Authorization allowed", r.code === 204 && /POST/.test(r.headers["Access-Control-Allow-Methods"]) && /Authorization/.test(r.headers["Access-Control-Allow-Headers"]));
let anyBodyLeak = false;
for (const w of [{ da: true, invite: { data: null, error: { status: 500, code: "x", message: `boom ${SVC}` } } }]) { world(w); r = await call(); anyBodyLeak ||= JSON.stringify(r.body).includes(SVC) || JSON.stringify(r.body).includes("boom"); }
ok("no response body ever carries Supabase's message or the key", !anyBodyLeak);
console.error = origErr;

// ================================================================ 2 + 3. the client: authLinks + the real Login.jsx
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const MOCKS = {
  sb: `
    const C = () => globalThis.__auth;
    export const supabase = { auth: {
      signInWithOtp: async (a) => { C().calls.push(["signInWithOtp", a]); return C().otp(a); },
      signInWithPassword: async (a) => { C().calls.push(["signInWithPassword", a]); return { error: null }; },
      signUp: async (a) => { C().calls.push(["signUp", a]); return { error: null }; },
      resetPasswordForEmail: async (e) => { C().calls.push(["resetPasswordForEmail", e]); return { error: null }; },
      getSession: async () => ({ data: { session: { access_token: "t" } } }) } };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";`,
  api: `
    export const isNative = () => false; export const apiUrl = (p) => p;
    export async function authedFetch(path, init) { globalThis.__auth.fetches.push({ path, body: JSON.parse(init.body) }); return globalThis.__auth.reply(); }`,
};
const clientOut = join(outDir, "client.mjs");
await build({
  stdin: { contents: `export * as AL from "./src/authLinks.js"; export { default as Login } from "./src/Login.jsx"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: clientOut, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test" }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
  } }],
});
const { AL, Login, createRoot, act, createElement } = await import(pathToFileURL(clientOut).href);
const NO_ACCOUNT = { error: { status: 422, code: "otp_disabled", message: "Signups not allowed for otp" } };
const authWorld = ({ otp = () => ({ error: null }), reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true, sent: "invite" }) }) } = {}) => { globalThis.__auth = { calls: [], fetches: [], otp, reply }; };

authWorld(); await AL.sendLoginLink(" Member@Example.test ", { redirect: "https://app.test/checkin?x=1" });
const c0 = globalThis.__auth.calls[0];
ok("sendLoginLink (the sign-in screen's link) asks with shouldCreateUser:false, normalized address, the redirect kept",
  c0?.[0] === "signInWithOtp" && c0[1].email === "member@example.test" && c0[1].options.shouldCreateUser === false && c0[1].options.emailRedirectTo === "https://app.test/checkin?x=1", JSON.stringify(c0));
ok("isNoAccountError: Supabase's refusal shapes (otp_disabled / signup_disabled / message) yes; a rate limit no",
  AL.isNoAccountError(NO_ACCOUNT.error) && AL.isNoAccountError({ code: "signup_disabled", message: "Signups not allowed for this instance" })
  && AL.isNoAccountError({ message: "Signups not allowed for otp" }) && !AL.isNoAccountError({ status: 429, message: "For security purposes, you can only request this after 60 seconds." }));
ok("the sentence is exactly the ruling's", AL.NO_ACCOUNT_MESSAGE === "No account yet — ask your department admin to add you.");

const reply = (status, body) => () => ({ ok: status < 300, status, json: async () => body });
authWorld(); let s = await AL.sendInvite(" NEW@x.test ");
ok("sendInvite → POST /api/invite { email } (normalized); 200 → { data:{ sent }, error:null }",
  globalThis.__auth.fetches[0]?.path === "/api/invite" && globalThis.__auth.fetches[0].body.email === "new@x.test" && s.error === null && s.data.sent === "invite");
ok("…and it never calls Supabase auth directly", globalThis.__auth.calls.length === 0);
const msg = async (status, body) => { authWorld({ reply: reply(status, body) }); return (await AL.sendInvite("a@x.test")).error?.message || ""; };
ok("404 not-on-roster → \"…isn't on your roster — add the member first…\"", /isn't on your roster/.test(await msg(404, { ok: false, failed: ["not-on-roster"] })));
ok("403 not-authorized → \"Only a Department Admin can send invites.\"", (await msg(403, { ok: false, failed: ["not-authorized"] })) === "Only a Department Admin can send invites.");
ok("429 → the hourly email limit, honestly", /hourly email limit/.test(await msg(429, { ok: false, failed: ["rate-limit"] })));
ok("502 invite → honest: \"The invite service couldn't send it just now (invite)…\"", /couldn't send it just now \(invite\)/.test(await msg(502, { ok: false, failed: ["invite"] })));
ok("500 config → honest, names the step", /\(config\)/.test(await msg(500, { ok: false, failed: ["config"] })));
ok("requireMember's own 403 sentence passes through", /Department Admin/.test(await msg(403, { error: "Your login isn't linked to an active member of a department — ask your Department Admin." })));
authWorld({ reply: () => { throw new TypeError("Failed to fetch"); } }); s = await AL.sendInvite("a@x.test");
ok("network failure → \"Couldn't reach the invite service…\"", /Couldn't reach the invite service/.test(s.error?.message || ""));

// D — the real Login.jsx
authWorld({ otp: () => NO_ACCOUNT });
const host = document.createElement("div"); document.body.appendChild(host);
const rootEl = createRoot(host);
await act(async () => rootEl.render(createElement(Login)));
const emailInput = host.querySelector('input[type="email"]') || host.querySelector("input");
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
  setter.call(emailInput, "unknown@nowhere.test");
  emailInput.dispatchEvent(new win.Event("input", { bubbles: true }));
});
const linkBtn = [...host.querySelectorAll("button")].find((b) => /email me a login link/i.test(b.textContent));
await act(async () => { linkBtn.click(); });
await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const text = host.textContent;
ok("D: an unknown address on the sign-in screen shows \"No account yet — ask your department admin to add you.\"", text.includes("No account yet — ask your department admin to add you."), text.slice(0, 200));
ok("D: …not Supabase's raw \"Signups not allowed for otp\", and no \"Sent — check your email\"", !/Signups not allowed/.test(text) && !/Sent — check your email/.test(text));
const calls = globalThis.__auth.calls;
ok("D: creates nothing — the only auth call was signInWithOtp with shouldCreateUser:false (no signUp)",
  calls.length === 1 && calls[0][0] === "signInWithOtp" && calls[0][1].options.shouldCreateUser === false && calls[0][1].email === "unknown@nowhere.test", JSON.stringify(calls));
authWorld();
await act(async () => { linkBtn.click(); });
await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
ok("D: an existing account still gets its link (\"Sent — check your email…\")", /Sent — check your email/.test(host.textContent));
await act(async () => rootEl.unmount());

// ================================================================ 4. the source + fences
const show = (p) => REV ? execSync(`git show ${REV}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");
const app = show("src/App.jsx");
ok("App.jsx: no signInWithOtp left (A, B, C all moved)", !/signInWithOtp/.test(app));
ok("A add-member, B new department's DA, C Resend each call sendInvite",
  /const \{ error: otpErr \} = await sendInvite\(email\)/.test(app) && /await sendInvite\(created\.adminEmail\)/.test(app) && /await sendInvite\(email\);\s+\/\/ \/api\/invite/.test(app));
ok("A keeps its notifications: \"Member added & invited\" / \"Member added — login link didn't send\" (no dead \"request one at sign-in\" advice)",
  app.includes('title: "Member added & invited"') && app.includes("title: \"Member added — login link didn't send\"") && !/They can request one at sign-in/.test(app));
const al = show("src/authLinks.js");
ok("authLinks: the one remaining signInWithOtp is the login link, with shouldCreateUser: false", (al.match(/signInWithOtp/g) || []).length === 1 && /shouldCreateUser: false/.test(al));
const ep = show("api/invite.js");
ok("api/invite.js: admin.inviteUserByEmail with { redirectTo: APP_ORIGIN }; never reads a department from the body", /admin\.inviteUserByEmail\(target, \{ redirectTo: APP_ORIGIN \}\)/.test(ep) && !/req\.body\??\.department/.test(ep));
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const files = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["api/invite.js", "claude/B4C_SignupInvite_Slice1_Draft.md", "docs/review/signup_invite_test.mjs", "src/App.jsx", "src/Login.jsx", "src/authLinks.js"];
ok("changed: only api/invite.js, src/App.jsx, src/Login.jsx, src/authLinks.js (+ this test, the note)", files.every((f) => allowed.includes(f)) && files.includes("api/invite.js"), JSON.stringify(files));
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("no SQL; vercel.json, api/_auth.js, api/_cors.js, api/_cron.js untouched", ["sql", "vercel.json", "api/_auth.js", "api/_cors.js", "api/_cron.js"].every(untouched));
const tok = (p) => (show(p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
process.exit(process.exitCode || 0);
