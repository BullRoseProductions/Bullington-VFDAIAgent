// Weekly Training Content slice 6: the provider call moves from api/claude.js to api/_anthropic.js.
// Step 0 §5.3: "a refactor of a security-reviewed file, so it ships as its own slice with a byte-identical behaviour test".
//
// HOW: the OLD /api/claude (api/ at BASE, extracted with git archive) and the NEW one (this tree) are each bundled with
// esbuild. Both use their real _auth.js and _cors.js, with only the Supabase client faked, and global fetch stubbed.
// Every case runs through BOTH handlers in an identical world, and the test compares, byte for byte:
//   · what reached the provider: URL, method, headers and the exact request-body STRING;
//   · what the caller got: status, JSON body and headers;
//   · what went to the server log (console.error arguments);
//   · which RPCs ran, with which JWT.
// The matrix covers every path: the gate refusals (405 / preflight / 401 / 403 / 503 / 413 / 429 / missing key), every
// system / user / messages shape the body builder branches on, and every provider outcome (text, mixed blocks, no content,
// an error with and without detail, a non-JSON reply, a network failure).
// Then: the fences, and the helper's own contract for slice 7's cron.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "195feec";                    // main 2a621b4 + its tests-only pin: the last commit before this slice
const REV = process.env.REV ?? "027bed8";  // pinned to the released range 195feec..027bed8 ("GATE PASS @ 027bed8", merged 2026-11-14)
Object.assign(process.env, { SUPABASE_URL: "https://x.supabase.test", SUPABASE_ANON_KEY: "anon-test", ANTHROPIC_API_KEY: "sk-test" });

// ---------------------------------------------------------------- the fakes (shared by both handlers)
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
let trace;
const PROVIDER = {
  text: () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "  hello  " }], stop_reason: "end_turn" }) }),
  mixed: () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "\n a" }, { type: "tool_use", id: "t", name: "x", input: {}, text: "LEAK-NON-TEXT" }, { type: "text", text: "b \n" }] }) }),
  noContent: () => ({ ok: true, status: 200, json: async () => ({ stop_reason: "max_tokens" }) }),
  nullContent: () => ({ ok: true, status: 200, json: async () => ({ content: null }) }),
  nullBody: () => ({ ok: true, status: 200, json: async () => null }),
  err400: () => ({ ok: false, status: 400, json: async () => ({ type: "error", error: { type: "invalid_request_error", message: "SECRET-PROVIDER-DETAIL org_abc123" } }) }),
  err529bare: () => ({ ok: false, status: 529, json: async () => ({}) }),
  errNull: () => ({ ok: false, status: 500, json: async () => null }),
  notJson: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token < in JSON"); } }),
  errNotJson: () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
  network: () => { throw new TypeError("fetch failed"); },
};
globalThis.fetch = async (url, init) => {
  trace.fetch.push({ url: String(url), method: init?.method, headers: JSON.stringify(init?.headers), body: init?.body });
  return PROVIDER[globalThis.__S.provider]();
};
const realError = console.error;
console.error = (...a) => { if (trace) trace.log.push(JSON.stringify(a)); else realError(...a); };

function world({ member = true, memberErr = false, cap = { allowed: true, used: 1, ceiling: 150 }, capErr = false, provider = "text" } = {}) {
  globalThis.__S = {
    users: { "tok-ok": { id: "u1", email: "m@x.test" } }, rpcs: [], provider,
    rpc: (name) => {
      if (name === "my_member_id") return memberErr ? { data: null, error: { message: "boom" } } : { data: member ? "m1" : null, error: null };
      if (name === "my_department_id") return { data: member ? "d1" : null, error: null };
      if (name === "record_ai_call") return capErr ? { data: null, error: { message: "function does not exist" } } : { data: cap, error: null };
      return { data: null, error: null };
    },
  };
  trace = { fetch: [], log: [] };
}

// ---------------------------------------------------------------- bundle BASE and REV
const work = mkdtempSync(join(tmpdir(), "b4c-anth-"));
const baseDir = join(work, "base");
execSync(`mkdir -p "${baseDir}" && git archive ${BASE} api | tar -x -C "${baseDir}"`, { cwd: root });
async function load(apiDir, name) {
  const out = join(work, `${name}.mjs`);
  await build({ entryPoints: [join(apiDir, "api/claude.js")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
    plugins: [{ name: "fake-sb", setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: FAKE_SB, loader: "js" }));
    } }] });
  return (await import(pathToFileURL(out).href)).default;
}
const OLD = await load(baseDir, "old"), NEW = await load(root, "new");
ok("BASE's claude.js holds the inline fetch; this tree's does not (it imports the helper)",
  readFileSync(join(baseDir, "api/claude.js"), "utf8").includes("https://api.anthropic.com/v1/messages")
  && !readFileSync(join(root, "api/claude.js"), "utf8").includes("api.anthropic.com")
  && !existsSync(join(baseDir, "api/_anthropic.js")));

async function run(handler, w, { method = "POST", token = "tok-ok", body, noKey = false }) {
  world(w);
  const res = { code: 0, body: null, headers: {}, ended: false, status(n) { this.code = n; return this; }, json(o) { this.body = o; return this; }, end() { this.ended = true; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const req = { method, headers: { origin: "https://app.b4thecall.com", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body };
  const key = process.env.ANTHROPIC_API_KEY; if (noKey) delete process.env.ANTHROPIC_API_KEY;
  let threw = null;
  try { await handler(req, res); } catch (e) { threw = String(e); }
  if (noKey) process.env.ANTHROPIC_API_KEY = key;
  const t = trace; trace = null;
  return JSON.stringify({ threw, code: res.code, body: res.body, headers: res.headers, ended: res.ended, fetch: t.fetch, log: t.log, rpcs: globalThis.__S.rpcs });
}

// ---------------------------------------------------------------- 1. the differential matrix
const big = (n) => "x".repeat(n);
const SHAPES = [
  ["system string + user", { system: "You are helpful.", user: "Hi" }],
  ["system whitespace only (not wrapped)", { system: "   \n ", user: "Hi" }],
  ["system empty string", { system: "", user: "Hi" }],
  ["system as text blocks (passed through)", { system: [{ type: "text", text: "A" }, { type: "text", text: "B" }], user: "Hi" }],
  ["no system", { user: "Hi" }],
  ["system null", { system: null, user: "Hi" }],
  ["multi-turn messages", { system: "tutor", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }] }],
  ["empty messages array → single-shot user", { system: "s", messages: [], user: "Hi" }],
  ["unicode and quotes in every field", { system: "Système — “quoted”   \\ </script>", user: "émoji 🚒 \"x\"\n\ttab" }],
  ["Station Q&A size (300,000-char system)", { system: big(300_000), messages: [{ role: "user", content: "SOP?" }] }],
  ["exactly at the limits (310,000 / 120,000)", { system: big(310_000), user: big(120_000) }],
];
const CASES = [];
for (const [label, body] of SHAPES) CASES.push([`200 path: ${label}`, {}, { body }]);
for (const p of Object.keys(PROVIDER)) CASES.push([`provider outcome: ${p}`, { provider: p }, { body: { system: "s", user: "Hi" } }]);
CASES.push(
  ["GET → 405", {}, { method: "GET", body: { user: "Hi" } }],
  ["OPTIONS preflight", {}, { method: "OPTIONS" }],
  ["no token → 401", {}, { token: null, body: { user: "Hi" } }],
  ["bad token → 401", {}, { token: "tok-bad", body: { user: "Hi" } }],
  ["no member → 403", { member: false }, { body: { user: "Hi" } }],
  ["membership check errors → 503", { memberErr: true }, { body: { user: "Hi" } }],
  ["missing ANTHROPIC_API_KEY → 500", {}, { body: { user: "Hi" }, noKey: true }],
  ["no body at all", {}, {}],
  ["413: user 120,001", {}, { body: { system: "s", user: big(120_001) } }],
  ["413: system not text", {}, { body: { system: [{ type: "image", source: {} }], user: "q" } }],
  ["413: ending on the assistant", {}, { body: { system: "s", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] } }],
  ["429: member cap", { cap: { allowed: false, used: 150, ceiling: 150, scope: "member" } }, { body: { user: "Hi" } }],
  ["429: department backstop", { cap: { allowed: false, used: 12, ceiling: 150, scope: "department", dept_used: 1500, dept_ceiling: 1500 } }, { body: { user: "Hi" } }],
  ["503: cap RPC errors", { capErr: true }, { body: { user: "Hi" } }],
);
let same = 0, modelCalls = 0;
for (const [label, w, opts] of CASES) {
  const a = await run(OLD, w, opts), b = await run(NEW, w, opts);
  if (a === b) same++;
  modelCalls += JSON.parse(a).fetch.length;
  ok(`identical: ${label}`, a === b, a === b ? "" : `\n   OLD ${a.slice(0, 400)}\n   NEW ${b.slice(0, 400)}`);
}
ok(`all ${CASES.length} cases byte-identical (request body string, response, headers, log, RPCs); ${modelCalls} provider calls compared`, same === CASES.length && modelCalls >= SHAPES.length + Object.keys(PROVIDER).length);

// spot checks on what "identical" means here, so a matrix that compared nothing can't pass
{ const r = JSON.parse(await run(NEW, {}, { body: { system: "You are helpful.", user: "Hi" } }));
  const sent = JSON.parse(r.fetch[0].body);
  ok("the request is the one WS-2 reviewed: model claude-sonnet-4-6, max_tokens 2000, cached string system, version 2023-06-01, the key from env",
    r.code === 200 && r.body.text === "hello" && r.fetch[0].url === "https://api.anthropic.com/v1/messages" && r.fetch[0].method === "POST"
    && r.fetch[0].headers === JSON.stringify({ "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01" })
    && JSON.stringify(Object.keys(sent)) === JSON.stringify(["model", "max_tokens", "system", "messages"])
    && sent.model === "claude-sonnet-4-6" && sent.max_tokens === 2000
    && JSON.stringify(sent.system) === JSON.stringify([{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }])
    && JSON.stringify(sent.messages) === JSON.stringify([{ role: "user", content: "Hi" }]), r.fetch[0].body); }
{ const r = JSON.parse(await run(NEW, { provider: "err400" }, { body: { user: "Hi" } }));
  ok("a provider error → 502 with the fixed sentence; the provider's detail is in the log under \"api/claude\", never in the response",
    r.code === 502 && r.body.error === "The AI service couldn't answer just now — please try again." && !JSON.stringify(r.body).includes("SECRET")
    && r.log.length === 1 && r.log[0] === JSON.stringify(["api/claude: Anthropic error", 400, "invalid_request_error", "SECRET-PROVIDER-DETAIL org_abc123"]), JSON.stringify(r.log)); }
{ const a = JSON.parse(await run(NEW, { provider: "network" }, { body: { user: "Hi" } })), b = JSON.parse(await run(NEW, { provider: "notJson" }, { body: { user: "Hi" } }));
  ok("a network failure and a non-JSON reply → 500 \"AI request failed\", nothing logged (as before)", a.code === 500 && b.code === 500 && a.body.error === "AI request failed" && a.log.length === 0 && b.log.length === 0); }

// ---------------------------------------------------------------- 2. the helper's contract (what slice 7's cron will rely on)
const H = await import(pathToFileURL(join(root, "api/_anthropic.js")).href);
ok("api/_anthropic.js exports callAnthropic, messagesBody and the pinned constants", typeof H.callAnthropic === "function" && typeof H.messagesBody === "function"
  && H.MODEL === "claude-sonnet-4-6" && H.MAX_TOKENS === 2000 && H.ANTHROPIC_VERSION === "2023-06-01" && H.ANTHROPIC_URL === "https://api.anthropic.com/v1/messages");
{ world({ provider: "err529bare" }); const out = await H.callAnthropic({ key: "k", system: "s", user: "u", logTag: "api/weekly-drill" }); const t = trace; trace = null;
  ok("callAnthropic on a provider error → { ok: false, status } only, logged under the caller's tag", JSON.stringify(out) === JSON.stringify({ ok: false, status: 529 })
    && t.log.length === 1 && JSON.parse(t.log[0])[0] === "api/weekly-drill: Anthropic error", JSON.stringify(out)); }
{ world({ provider: "mixed" }); const out = await H.callAnthropic({ key: "k", system: "s", user: "u", logTag: "x" }); trace = null;
  ok("callAnthropic on success → { ok: true, text } with text blocks joined, non-text dropped, trimmed", JSON.stringify(out) === JSON.stringify({ ok: true, text: "ab" }), JSON.stringify(out)); }
{ world({ provider: "network" }); let threw = false; try { await H.callAnthropic({ key: "k", user: "u", logTag: "x" }); } catch { threw = true; } trace = null;
  ok("callAnthropic lets a network failure THROW (the caller's catch decides the answer)", threw); }
const helperSrc = readFileSync(join(root, "api/_anthropic.js"), "utf8");
ok("the helper reads no env, no Supabase, no auth: the caller passes the key", !/process\.env|supabase|requireMember|requireCron/.test(helperSrc.replace(/\/\/.*$/gm, "")));

// ---------------------------------------------------------------- 3. fences
const changed = execSync(`git diff --name-only ${BASE} ${REV === "HEAD" ? "" : REV}`, { cwd: root }).toString().trim().split("\n").filter(Boolean).sort();
const untracked = REV === "HEAD" ? execSync("git ls-files --others --exclude-standard -- api docs/review shared src sql", { cwd: root }).toString().trim().split("\n").filter(Boolean) : [];
const allChanged = [...new Set([...changed, ...untracked])].sort();
const allowed = ["api/_anthropic.js", "api/claude.js", "docs/review/anthropic_helper_BUILD_ORDER.md", "docs/review/anthropic_helper_test.mjs"];
ok(`only the helper, claude.js and this slice's test / notes changed (${BASE}..${REV})`, allChanged.every((p) => allowed.includes(p)) && allChanged.includes("api/_anthropic.js") && allChanged.includes("api/claude.js"), JSON.stringify(allChanged));
const fn = (s) => s.slice(s.indexOf("export const SYSTEM_MAX"), s.indexOf("export default async function handler"));
const baseClaude = readFileSync(join(baseDir, "api/claude.js"), "utf8"), revClaude = readFileSync(join(root, "api/claude.js"), "utf8");
ok("the input caps (SYSTEM_MAX … inputProblem) are byte-identical to BASE", fn(baseClaude).length > 1000 && fn(baseClaude) === fn(revClaude));
const gate = (s) => s.slice(s.indexOf("export default async function handler"), s.indexOf("  try {"));
ok("the handler's gate (cors → POST → requireMember → key → inputProblem → chargeAiCall) is byte-identical to BASE", gate(baseClaude).length > 300 && gate(baseClaude) === gate(revClaude));
for (const f of ["api/_auth.js", "api/_cors.js", "api/_cron.js", "vercel.json", "api/assistant.js", "api/concepts.js", "api/digest.js"])
  ok(`${f} untouched`, readFileSync(join(root, f), "utf8") === execSync(`git show ${BASE}:${f}`, { cwd: root, maxBuffer: 1 << 26 }).toString());
const count = (f) => (readFileSync(join(root, f), "utf8").match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified counts: App.jsx 132 · digest 32 · assistant 14", count("src/App.jsx") === 132 && count("api/digest.js") === 32 && count("api/assistant.js") === 14, `${count("src/App.jsx")}/${count("api/digest.js")}/${count("api/assistant.js")}`);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));

console.error = realError;
process.exit(process.exitCode || 0);
