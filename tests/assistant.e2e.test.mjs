process.env.ANTHROPIC_API_KEY = "test-key"; process.env.SUPABASE_URL = "https://sb.test"; process.env.SUPABASE_ANON_KEY = "anon";
const JWT = "member-jwt";
const log = []; let anthropicCalls = 0; let script = []; let limitHit = false;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const method = (init.method || "GET").toUpperCase();
  const auth = new Headers(init.headers || {}).get("authorization");
  if (url.startsWith("https://api.anthropic.com")) { anthropicCalls++; const body = JSON.parse(init.body); log.push({ anthropic: true, tools: body.tools.map(t => t.name), lastMsg: body.messages.at(-1) }); return json(script.shift()); }
  log.push({ url: url.replace("https://sb.test", ""), method, auth });
  if (url.includes("/auth/v1/user")) return json({ id: "u1", email: "m@x" });
  if (url.includes("/rpc/record_assistant_turn")) return json(limitHit ? { allowed: false, used: 500, ceiling: 500 } : { allowed: true, used: 7, ceiling: 500 });
  if (url.includes("/rpc/my_member_id")) return json("mem-1");
  if (url.includes("/rpc/my_department_id")) return json("dept-1");
  if (url.includes("/rest/v1/members")) return json({ name: "Kai Newton", access: ["Member"], joined: "2026" });
  if (url.includes("/rest/v1/departments")) return json({ name: "North Hood" });
  if (url.includes("/rest/v1/celebrations")) return json({ joined_date: "2026-10-08" });
  if (url.includes("/rpc/my_station_shifts")) return json([{ hours: 2.47, verified: true, kind: "standby" }, { hours: 1, verified: false, kind: "standby" }]);
  if (url.includes("/rpc/my_open_station_session")) return json([]);
  if (url.includes("/rest/v1/certs")) return json([{ name: "FF1", exp: "2026-09" }, { name: "EMT", exp: "2028-01" }]);
  if (url.includes("/rest/v1/cert_submissions")) return json([]);
  return json({ message: "unmocked " + url }, 404);
};
const { default: handler } = await import("../api/assistant.js");
const call = async (messages) => { let out = { status: 200 }; const res = { setHeader() {}, status(s) { out.status = s; return res; }, json(o) { out.body = o; return res; }, end() { return res; } };
  await handler({ method: "POST", headers: { authorization: `Bearer ${JWT}`, origin: "https://app.b4thecall.com" }, body: { messages } }, res); return out; };
const check = (ok, m) => console.log(ok ? "PASS" : "FAIL", m);

// 1. hours + certs question: model calls two tools, then answers
script = [
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "my_hours", input: { range: "year" } }, { type: "tool_use", id: "t2", name: "my_certs", input: {} }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "You have 2.5 credited hours this year. FF1 expired." }] },
];
let r = await call([{ role: "user", content: "my hours and certs?" }]);
const sbCalls = log.filter(l => !l.anthropic);
check(r.status === 200 && /2\.5 credited/.test(r.body.text), "answer returned");
check(sbCalls.filter(l => !l.url.includes("/auth/v1/")).every(l => l.auth === `Bearer ${JWT}`), "every DB call carries the caller's JWT (as-user, no service role)");
check(sbCalls.filter(l => l.method !== "GET" && !l.url.includes("/auth/")).every(l => l.url.includes("/rpc/")), "no non-RPC writes (only GETs + RPC POSTs)");
check(sbCalls.findIndex(l => l.url.includes("record_assistant_turn")) < log.findIndex(l => l.anthropic), "meter recorded BEFORE the first model call");
const toolResult = JSON.parse(log.filter(l => l.anthropic)[1].lastMsg.content[0].content);
check(toolResult.credited === 2.5 && toolResult.unverified === 1, "my_hours: credited = verified only (2.5), unverified 1");
const certRes = JSON.parse(log.filter(l => l.anthropic)[1].lastMsg.content[1].content);
check(certRes.certs[0].status === "expired" && certRes.certs[0].name === "FF1", "my_certs: expired first");
check(sbCalls.some(l => l.url.includes("/rest/v1/certs") && l.url.includes("member_id=eq.mem-1")), "certs read scoped to my own member id");
check(JSON.stringify(r.body.records.sort()) === JSON.stringify(["my_certs", "my_hours"]), "records grounding returned");

// 2. navigation + unknown tool name rejected
log.length = 0;
script = [
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "n1", name: "open_screen", input: { screen: "stationhours" } }, { type: "tool_use", id: "n2", name: "run_sql", input: { q: "select * from members" } }, { type: "tool_use", id: "n3", name: "open_screen", input: { screen: "department" } }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "Opening Station Hours." }] },
];
r = await call([{ role: "user", content: "open my hours" }]);
const res2 = log.filter(l => l.anthropic)[1].lastMsg.content.map(c => JSON.parse(c.content));
check(r.body.navigate === "stationhours", "navigate = stationhours");
check(res2[1].error === "Unknown tool." && res2[2].error, "unlisted tool + non-allowlisted screen refused");
check(!log.some(l => !l.anthropic && /run_sql|members\?select=\*/.test(l.url) && l.url.includes("run")), "nothing executed for the unknown tool");
log.length = 0;
script = [
  { stop_reason: "tool_use", content: [{ type: "tool_use", id: "r1", name: "open_screen", input: { screen: "reports" } }] },
  { stop_reason: "end_turn", content: [{ type: "text", text: "Reports is for leadership." }] },
];
r = await call([{ role: "user", content: "open reports" }]);
const res3 = JSON.parse(log.filter(l => l.anthropic)[1].lastMsg.content[0].content);
check(r.body.navigate === null && /leadership/.test(res3.error || ""), "plain member: leadership-only screen refused server-side, no navigate");

// 3. ceiling reached -> friendly message, model never called
log.length = 0; anthropicCalls = 0; limitHit = true;
r = await call([{ role: "user", content: "hi" }]);
check(r.status === 200 && r.body.limited === true && /breather/.test(r.body.text) && anthropicCalls === 0, "ceiling: friendly breather, no model call");
limitHit = false;

// 4. no auth -> 401, nothing else runs
log.length = 0; anthropicCalls = 0;
let o = {}; const res = { setHeader() {}, status(s) { o.s = s; return res; }, json(b) { o.b = b; return res; }, end() { return res; } };
await handler({ method: "POST", headers: {}, body: { messages: [{ role: "user", content: "x" }] } }, res);
check(o.s === 401 && anthropicCalls === 0 && !log.some(l => l.url?.includes("record_assistant_turn")), "no session -> 401, no meter, no model");
// 5. history must end on a user turn
o = {}; await handler({ method: "POST", headers: { authorization: `Bearer ${JWT}` }, body: { messages: [{ role: "assistant", content: "x" }] } }, res);
check(o.s === 400, "bad history -> 400");
