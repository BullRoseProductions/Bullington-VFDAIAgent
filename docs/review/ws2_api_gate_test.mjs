// node docs/review/ws2_api_gate_test.mjs
// No network, no DB. WS-2 (H-1) the AI-route lockdown — the API half (claude/B4C_WS2_AIGate_Step0.md §5; rulings D-1..D-6).
// Each REAL route (api/claude.js, concepts.js, assistant.js, image.js) is bundled with esbuild, its Supabase client
// replaced by a fake (getUser + rpc + from) and global fetch stubbed so every model call is COUNTED. Checks:
//   1. all four routes: no token → 401 · a valid JWT with no member → 403 (the model AND the cap never touched) · a
//      member → 200 with record_ai_call charged for that route · the cap refuses → 429 · the cap RPC errors → 503 ·
//      the membership RPC errors → 503 — the model is never called on any refusal (fail safe)
//   2. /api/claude input caps (D-6): system > 310k (string or blocks) · user > 120k · > 100 turns · a turn > 20k ·
//      non-string content · ending on assistant · > 800k in total → 413, BEFORE the cap is charged; a Station Q&A-sized
//      payload (300k system) and a 20-question cert quiz (79 turns) pass
//   3. the provider's raw error.message is never echoed (claude, concepts) — 502 with a generic message
//   4. source fences: no service-role key in the four routes or _auth.js; all four use requireMember; claude/concepts
//      no longer forward data.error.message; the runtime files changed are exactly the five api files
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
Object.assign(process.env, { SUPABASE_URL: "https://x.supabase.test", SUPABASE_ANON_KEY: "anon-test", ANTHROPIC_API_KEY: "sk-test", IMAGE_API_KEY: "img-test" });

// ---------------------------------------------------------------- the fakes
const FAKE_SB = `
export function createClient(url, key, opts) {
  const S = globalThis.__S;
  const auth = (opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || null;
  const q = () => { const b = {}; for (const m of ["select", "eq", "in", "is", "order", "limit", "gte", "lte", "lt", "gt", "or", "not"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: null, error: null }); b.single = b.maybeSingle; b.then = (r) => Promise.resolve({ data: [], error: null }).then(r); return b; };
  return {
    auth: { getUser: async (tok) => (S.users[tok] ? { data: { user: S.users[tok] }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } }) },
    rpc: async (name, args) => { S.rpcs.push({ name, args, auth }); return S.rpc(name, args, auth); },
    from: () => q(),
  };
}`;
let calls = [];   // model calls
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body });
  const S = globalThis.__S;
  if (S.providerFails) return { ok: false, status: 400, json: async () => ({ error: { type: "invalid_request_error", message: "SECRET-PROVIDER-DETAIL org_abc123" } }) };
  if (String(url).includes("openai")) return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "AAAA" }] }) };
  const text = String(init?.body || "").includes("art director") ? JSON.stringify([{ headline: "Join us", mood: "warm", imagePrompt: "A scene. No text, no logos." }]) : "hello";
  return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) };
};
const outDir = mkdtempSync(join(tmpdir(), "b4c-ws2-"));
async function load(route) {
  const out = join(outDir, `${route}.mjs`);
  await build({ entryPoints: [join(root, `api/${route}.js`)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    plugins: [{ name: "fake-sb", setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
    } }] });
  return (await import(pathToFileURL(out).href)).default;
}
const H = { claude: await load("claude"), concepts: await load("concepts"), assistant: await load("assistant"), image: await load("image") };

// a world: who the token belongs to, what the membership + cap RPCs answer
function world({ member = true, memberErr = false, cap = { allowed: true, used: 1, ceiling: 150 }, capErr = false, providerFails = false } = {}) {
  globalThis.__S = {
    users: { "tok-ok": { id: "u1", email: "m@x.test" } }, rpcs: [], providerFails,
    rpc: (name) => {
      if (name === "my_member_id") return memberErr ? { data: null, error: { message: "boom" } } : { data: member ? "m1" : null, error: null };
      if (name === "my_department_id") return { data: member ? "d1" : null, error: null };
      if (name === "record_ai_call") return capErr ? { data: null, error: { message: "function does not exist" } } : { data: cap, error: null };
      if (name === "record_assistant_turn" || name === "record_image_generation") return { data: { allowed: true, used: 1, ceiling: 500 }, error: null };
      return { data: null, error: null };
    },
  };
  calls = [];
}
const BODY = {
  claude: { system: "You are helpful.", user: "Hi" },
  concepts: { purpose: "Recruiting", occasion: "Open house", count: 1 },
  assistant: { messages: [{ role: "user", content: "When is the next drill?" }] },
  image: { prompt: "A fire engine at dusk", quality: "medium", size: "1024x1536" },
};
async function call(route, { token = "tok-ok", body = BODY[route] } = {}) {
  const res = { code: 0, body: null, headers: {}, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const req = { method: "POST", headers: { origin: "https://app.b4thecall.com", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body };
  await H[route](req, res);
  return res;
}
const capCalls = () => globalThis.__S.rpcs.filter((r) => r.name === "record_ai_call");

// ---------------------------------------------------------------- 1. every route
for (const route of ["claude", "concepts", "assistant", "image"]) {
  world(); let r = await call(route, { token: null });
  ok(`${route}: no token → 401, model not called`, r.code === 401 && calls.length === 0, `${r.code}`);
  world({ member: false }); r = await call(route);
  ok(`${route}: valid JWT, NO member → 403 "ask your Department Admin"; model and cap never touched`, r.code === 403 && /Department Admin/.test(r.body?.error) && calls.length === 0 && capCalls().length === 0, `${r.code} ${r.body?.error}`);
  world({ memberErr: true }); r = await call(route);
  ok(`${route}: membership check errors → 503 fail-safe, model not called`, r.code === 503 && calls.length === 0, `${r.code}`);
  world(); r = await call(route);
  ok(`${route}: member → 200; record_ai_call charged for '${route}' AS THE CALLER (their JWT); model called once`, r.code === 200 && calls.length === 1 && capCalls().length === 1 && capCalls()[0].args?.p_route === route && capCalls()[0].auth === "Bearer tok-ok", `${r.code} ${JSON.stringify(r.body).slice(0, 80)}`);
  world({ cap: { allowed: false, used: 150, ceiling: 150, scope: "member" } }); r = await call(route);
  ok(`${route}: over today's cap → 429 with used/ceiling, model not called`, r.code === 429 && r.body?.used === 150 && r.body?.ceiling === 150 && calls.length === 0, `${r.code} ${r.body?.error}`);
  world({ capErr: true }); r = await call(route);
  ok(`${route}: cap RPC errors (e.g. the function isn't there) → 503 fail-safe, model not called`, r.code === 503 && calls.length === 0, `${r.code}`);
}
{ world({ cap: { allowed: false, used: 12, ceiling: 150, scope: "department", dept_used: 1500, dept_ceiling: 1500 } }); const r = await call("claude");
  ok("claude: the department backstop refusal reads as the department's limit", r.code === 429 && /department/i.test(r.body?.error), r.body?.error); }

// ---------------------------------------------------------------- 2. /api/claude input caps (D-6)
const big = (n) => "x".repeat(n);
const turns = (n, len = 50) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: big(len) }));
const CAP_CASES = [
  ["system 310,001 chars (string)", { system: big(310_001), user: "q" }],
  ["system 310,001 chars (text blocks)", { system: [{ type: "text", text: big(200_000) }, { type: "text", text: big(110_001) }], user: "q" }],
  ["system not text", { system: [{ type: "image", source: {} }], user: "q" }],
  ["user 120,001 chars", { system: "s", user: big(120_001) }],
  ["user not a string", { system: "s", user: { a: 1 } }],
  ["101 turns", { system: "s", messages: turns(101) }],
  ["a 20,001-char turn", { system: "s", messages: [{ role: "user", content: big(20_001) }] }],
  ["non-string content", { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }],
  ["a 'system' role turn", { system: "s", messages: [{ role: "system", content: "x" }, { role: "user", content: "q" }] }],
  ["ending on the assistant", { system: "s", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }],
  ["41 turns × 19,999 (> 800,000 total)", { system: "s", messages: turns(41, 19_999) }],
];
for (const [label, body] of CAP_CASES) {
  world(); const r = await call("claude", { body });
  ok(`claude 413: ${label} — refused before the cap is charged; model not called`, r.code === 413 && calls.length === 0 && capCalls().length === 0, `${r.code} ${r.body?.error}`);
}
{ world(); const r = await call("claude", { body: { system: big(300_000), messages: [{ role: "user", content: "What's our SOP for a car fire?" }] } });
  ok("claude: a Station Q&A-sized call (300,000-char system) passes", r.code === 200 && calls.length === 1); }
{ world(); const quiz = turns(79, 400); const r = await call("claude", { body: { system: "tutor", messages: quiz } });
  ok("claude: a 20-question cert quiz (79 turns) passes — the ruled 40-turn cap would refuse it (see DEVIATION)", quiz[78].role === "user" && r.code === 200 && calls.length === 1, `${r.code} ${r.body?.error || ""}`); }
{ world(); const r = await call("claude", { body: { system: big(310_000), user: big(120_000) } });
  ok("claude: exactly at the limits (310,000 / 120,000) passes", r.code === 200); }

// ---------------------------------------------------------------- 3. no provider error echo
for (const route of ["claude", "concepts"]) {
  world({ providerFails: true }); const r = await call(route);
  ok(`${route}: a provider error → 502 with a generic message; the raw provider message is never sent`, r.code === 502 && !JSON.stringify(r.body).includes("SECRET-PROVIDER-DETAIL"), `${r.code} ${JSON.stringify(r.body)}`);
}

// ---------------------------------------------------------------- 4. source fences
const src = Object.fromEntries(["_auth", "claude", "concepts", "assistant", "image"].map((f) => [f, readFileSync(join(root, `api/${f}.js`), "utf8")]));
ok("no service-role key in _auth.js or the four AI routes", Object.values(src).every((s) => !/SERVICE_ROLE|service_role/i.test(s)));
ok("all four routes gate with requireMember + charge with chargeAiCall; none still calls requireUser itself",
  ["claude", "concepts", "assistant", "image"].every((f) => src[f].includes('import { requireMember, chargeAiCall } from "./_auth.js";') && /await requireMember\(req, res\)/.test(src[f]) && /chargeAiCall\((ctx|member), "/.test(src[f]) && !/requireUser\(/.test(src[f])));
ok("claude/concepts no longer forward the provider's data.error.message", !/error:\s*data\?\.error\?\.message/.test(src.claude) && !/error:\s*data\?\.error\?\.message/.test(src.concepts));
ok("assistant/image no longer build their own Supabase client (requireMember's as-caller client)", !src.assistant.includes("createClient(") && !src.image.includes("createClient("));
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
ok("runtime files changed vs origin/main = the five api files (no client change)", JSON.stringify(changed) === JSON.stringify(["api/_auth.js", "api/assistant.js", "api/claude.js", "api/concepts.js", "api/image.js"]), JSON.stringify(changed));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token counts unchanged (App.jsx 132 · digest.js 32 · assistant.js 14)",
  tok(readFileSync(join(root, "src/App.jsx"), "utf8")) === 132 && tok(readFileSync(join(root, "api/digest.js"), "utf8")) === 32 && tok(src.assistant) === 14, String(tok(src.assistant)));
ok("Notify crew held back", !execSync("git ls-files api", { cwd: root }).toString().includes("notify-session"));
