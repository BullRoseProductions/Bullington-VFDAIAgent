// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/e1e3_u2_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (supabaseClient, ConfirmDestructive, NoirDialogs and apiBase
// swapped for in-memory fakes) and drives the real Training screen for E1/E3 Slice U2 (reactions UI; Slice R live):
//   1. a member on the roll: vote 👍 (set_session_reaction {p_session_id, p_value}), change to 👎, a repeat click is a no-op;
//      their own earlier vote read back from training_session_reactions (own-row RLS)
//   2. the 14-day window (America/Chicago): day 14 open, day 15 disabled + "Voting closed"; the DB's CLOSED said kindly
//      (a plain member votes from the member view's "How was training?" card; a leader from the leader view's list rows)
//   3. not on the roll / upcoming / cancelled: no control (both views)
//   4. leadership: ONE batched session_reaction_tally call (session ids only); "👍 N · 👎 M" at ≥ 3; a quiet "Not enough votes
//      yet" below (never a zero); no member id or name on any reactions line even from a hostile reply; a failed read shows nothing
//   5. the source: only Slice R's two new RPC names; the tally keeps only session_id/up/down; one own-vote read, no table write;
//      client only; verified 132/108; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/", width: 1024, height: 900 });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _w: null };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "not", "maybeSingle", "single"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (args) => { b._w = { table, op: m, args }; st.writes.push(b._w); return b; };
      b.then = (res, rej) => Promise.resolve(b._w && b._w.op === "insert" ? { data: [b._w.args], error: null } : st.table(table)).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ upload: async (p) => { st.uploads.push(p); return { data: { path: p }, error: null }; }, remove: async (ps) => { st.removed.push(...ps); return { error: null }; }, createSignedUrl: async () => ({ data: null, error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async (o) => { globalThis.__destructive.push(o); return true; }; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async (o) => { globalThis.__confirms.push(o); return true; }; export const noirPrompt = async (o) => { globalThis.__prompts.push(o); return globalThis.__promptAnswer; }; export const NoirDialogHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p; export async function authedFetch() { return { ok: false, status: 503, text: async () => "" }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-ts6-")), "app.under-test.mjs");
await build({
  entryPoints: [join(root, "src/App.jsx")], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onResolve({ filter: /ConfirmDestructive(\.jsx)?$/ }, () => ({ path: "cd", namespace: "fake" }));
    b.onResolve({ filter: /NoirDialogs(\.jsx)?$/ }, () => ({ path: "nd", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { Training };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { Training, createRoot, act, React } = await import(pathToFileURL(out).href);


// ---- fixtures, dated from TODAY IN AMERICA/CHICAGO (the clock set_session_reaction and the client both use) — never a fixed day
const chi = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date()).split("-").map(Number);
const ago = (n) => { const d = new Date(Date.UTC(chi[0], chi[1] - 1, chi[2] - n)); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; };
const sess = (id, title, daysAgo, extra = {}) => ({ id, title, ...ago(daysAgo), done: true, plans: [], attendance: ["m-1", "m-2", "m-3"], signinOpen: false, audience: "everyone",
  planId: null, startTime: "19:00:00", durationMin: 120, actualStart: null, actualEnd: null, setupMin: null, countsAttendance: true, isMeeting: false, isOffsite: false, locLabel: "", ...extra });
const SESS = () => [
  sess("dv", "Hose drill", 2),                                                  // open, m-1 on the roll, no vote yet
  sess("d14", "Ladders", 14),                                                   // the last open day
  sess("d15", "Pump ops", 15, { attendance: ["m-1"] }),                         // closed, m-1 never voted
  sess("dc", "Ropes", 20),                                                      // closed, m-1 voted 1
  sess("dx", "Vent drill", 2, { attendance: ["m-2", "m-3"] }),                   // m-1 NOT on the roll
  sess("du", "Upcoming", -3, { done: false, attendance: [] }),                  // not finished
  sess("dk", "Cancelled one", 4, { done: false, cancelled: true, status: "cancelled", attendance: [] }),
];
const MY_VOTES = [{ session_id: "dc", value: 1 }];
const TALLY = { dv: { up: 2, down: 1 }, dc: { up: 7, down: 1 } };              // under 3 counted votes = NO row (d14, d15, dx)
const CATS = [{ id: "c1", name: "Hose Ops", cadence: "Monthly", color: "#C0392B", lastISO: null }];
const MEMBERS = [{ id: "m-ada", name: "Ada DA", status: "Active", access: ["Department Admin"] }, { id: "m-oli", name: "Oli Officer", status: "Active", access: ["Officer"] },
  { id: "m-1", name: "Ann One", status: "Active", access: ["Member"] }, { id: "m-2", name: "Ben Two", status: "Active", access: ["Member"] }, { id: "m-3", name: "Cal Three", status: "Active", access: ["Member"] }];
globalThis.__sb = {
  calls: [], writes: [], uploads: [], removed: [], fail: {}, reads: [],
  table: (t) => { globalThis.__sb.reads.push(t); return t === "training_session_reactions" ? { data: MY_VOTES.map((r) => ({ ...r })), error: null } : { data: [], error: null }; },
  answer: (n, args) => {
    const f = globalThis.__sb.fail[n]; if (f) return { data: null, error: { message: f } };
    if (n === "my_department_id") return { data: "d-1", error: null };
    // a hostile reply: extra fields (a member id, a name) the client must never keep or show — the real RPC returns counts only
    if (n === "session_reaction_tally") return { data: (args.p_session_ids || []).filter((id) => TALLY[id]).map((id) => ({ session_id: id, ...TALLY[id], member_id: "m-2", voter: "Ben Two" })), error: null };
    if (n === "set_session_reaction") return { data: { session_id: args.p_session_id, value: args.p_value }, error: null };
    return { data: null, error: null };
  },
};
const S = new Proxy({}, { get: () => ({}) });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
let host, notes;
async function mount(role, meId, sessions = SESS(), fail = {}) {
  Object.assign(globalThis.__sb, { calls: [], writes: [], fail, reads: [] }); globalThis.__destructive = []; globalThis.__confirms = []; globalThis.__prompts = []; notes = [];
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); const r = createRoot(host);
  await act(async () => { r.render(React.createElement(Training, { S, role, plan: CATS, setPlan: () => {}, loadPlans: () => {}, sessions, setSessions: () => {}, loadSessions: () => {}, sessionsErr: false,
    members: MEMBERS, meId, notify: (n) => notes.push(n), dept: { name: "Indian Harbor" }, addFeedback: () => {}, isTrainingOfficer: false, onTrainingOfficersChanged: () => {} })); });
  await tick(); await tick();
  return { unmount: () => act(() => r.unmount()) };
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
async function show(id) {   // the list shows one month: step the calendar to the session's month (month-end safe)
  const s = SESS().find((x) => x.id === id);
  for (let i = 0; i < 3 && !norm(host.textContent).includes(`Sessions · ${MONTHS[s.m]} ${s.y}`); i++) {
    const cur = /Sessions · (\w+) (\d{4})/.exec(norm(host.textContent));
    const back = cur && (Number(cur[2]) * 12 + MONTHS.indexOf(cur[1])) > s.y * 12 + s.m;
    await click(host.querySelector(`button[title="${back ? "Previous month" : "Next month"}"]`)); await tick();
  }
  return document.getElementById(`ts-${id}`);
}
const mrow = (id) => document.getElementById(`mr-${id}`);   // the member view's "How was training?" card rows
const q = (row, t) => row?.querySelector(`[data-testid="${t}"]`);
const rpcs = (n) => globalThis.__sb.calls.filter((c) => c.n === n);

// 1 — a member on the roll: vote, change the vote, a repeat click is a no-op; their own earlier vote is read back
{ const { unmount } = await mount(["Member"], "m-1");
  ok("own votes are read from training_session_reactions (own-row RLS) — the only reactions read", globalThis.__sb.reads.includes("training_session_reactions"));
  const card = host.querySelector('[data-testid="react-card"]');
  ok("a plain member gets the \"How was training?\" card: my finished sessions from the last 30 days, newest first (dv, d14, d15, dc) — not dx (not on its roll)",
    /How was training\?/.test(norm(card?.textContent)) && JSON.stringify([...card.querySelectorAll('[id^="mr-"]')].map((e) => e.id)) === '["mr-dv","mr-d14","mr-d15","mr-dc"]',
    JSON.stringify(card && [...card.querySelectorAll('[id^="mr-"]')].map((e) => e.id)));
  let row = mrow("dv");
  ok("a finished session I attended shows \"How was it?\" with 👍 / 👎, neither pressed", /How was it\?/.test(norm(q(row, "react-row")?.textContent)) && q(row, "react-up")?.getAttribute("aria-pressed") === "false" && q(row, "react-down")?.getAttribute("aria-pressed") === "false" && !q(row, "react-up")?.disabled);
  await click(q(row, "react-up")); await tick();
  let v = rpcs("set_session_reaction");
  ok("👍 → set_session_reaction({p_session_id, p_value: 1}) — exactly those two arguments", v.length === 1 && JSON.stringify(v[0].args) === '{"p_session_id":"dv","p_value":1}', JSON.stringify(v));
  row = mrow("dv");
  ok("…and my vote lights up (👍 pressed)", q(row, "react-up")?.getAttribute("aria-pressed") === "true" && q(row, "react-down")?.getAttribute("aria-pressed") === "false");
  await click(q(row, "react-down")); await tick();
  v = rpcs("set_session_reaction"); row = mrow("dv");
  ok("change my vote: 👎 → p_value -1, 👎 now pressed (the DB updates the same row)", v.length === 2 && v[1].args.p_value === -1 && q(row, "react-down")?.getAttribute("aria-pressed") === "true" && q(row, "react-up")?.getAttribute("aria-pressed") === "false");
  await click(q(row, "react-down")); await tick();
  ok("clicking the vote I already have sends nothing", rpcs("set_session_reaction").length === 2);
  ok("a plain member never calls the tally", rpcs("session_reaction_tally").length === 0 && !host.querySelector('[data-testid="react-tally"], [data-testid="react-tally-few"]'));
  unmount(); }

// 2 — the window: day 14 open, day 15 closed (disabled + "Voting closed"); my earlier vote stays lit on a closed one
{ const { unmount } = await mount(["Member"], "m-1");
  let row = mrow("d14");
  ok("14 days after the session: still open (enabled)", !!q(row, "react-up") && !q(row, "react-up").disabled && !q(row, "react-closed"));
  row = mrow("d15");
  ok("15 days after: disabled with a quiet \"Voting closed\" — no vote possible", q(row, "react-up")?.disabled === true && q(row, "react-down")?.disabled === true && norm(q(row, "react-closed")?.textContent) === "Voting closed");
  await click(q(row, "react-up")); await tick();
  ok("…a click on a closed vote sends nothing", rpcs("set_session_reaction").length === 0);
  row = mrow("dc");
  ok("a closed session I voted on: \"Your vote\" with my 👍 lit, disabled", /Your vote/.test(norm(q(row, "react-row")?.textContent)) && q(row, "react-up")?.getAttribute("aria-pressed") === "true" && q(row, "react-up")?.disabled === true);
  unmount(); }
{ const { unmount } = await mount(["Member"], "m-1");
  globalThis.__sb.fail.set_session_reaction = "CLOSED: reactions close 14 days after the session.";
  const row = mrow("d14");
  await click(q(row, "react-up")); await tick();
  const e = norm(q(mrow("d14"), "react-err")?.textContent);
  ok("the DB's CLOSED (the boundary raced past midnight) is said kindly — no code, no vote lit", /^Voting has closed\. Votes are open for 14 days after a session/.test(e) && !/CLOSED/.test(e) && q(mrow("d14"), "react-up")?.getAttribute("aria-pressed") === "false", e);
  unmount(); }

// 3 — not on the roll / not finished / cancelled: no control at all
{ const { unmount } = await mount(["Member"], "m-1");
  ok("member view: a finished session I was NOT at (dx), an upcoming one (du), a cancelled one (dk) — no row, no control",
    !mrow("dx") && !mrow("du") && !mrow("dk") && host.querySelectorAll('[data-testid="react-row"]').length === 4);
  unmount(); }
{ const { unmount } = await mount(["Department Admin"], "m-ada");   // the leader view's list rows
  let row = await show("dx");
  ok("leader view: a finished session I was NOT at shows no 👍 / 👎 (only the tally line)", !q(row, "react-up") && !!q(row, "react-row"));
  row = await show("du");
  ok("leader view: an upcoming session has no reactions line", !q(row, "react-row"));
  row = await show("dk");
  ok("leader view: a cancelled session has no reactions line", !row || !q(row, "react-row"));
  unmount(); }

// 4 — leadership: ONE batched tally call; counts at ≥ 3, a quiet "Not enough votes yet" below; no ids, no names
for (const [who, role, meId] of [["Department Admin (not on these rolls)", ["Department Admin"], "m-ada"], ["Officer", ["Officer"], "m-oli"]]) {
  const { unmount } = await mount(role, meId);
  const t = rpcs("session_reaction_tally");
  const want = SESS().filter((x) => x.done && !x.cancelled).map((x) => x.id).sort();
  ok(`${who}: ONE session_reaction_tally call for every finished session — args {p_session_ids} only, session ids only`,
    t.length === 1 && JSON.stringify(Object.keys(t[0].args)) === '["p_session_ids"]' && JSON.stringify(t[0].args.p_session_ids) === JSON.stringify(want), JSON.stringify(t));
  let row = await show("dv");
  ok(`${who}: ≥ 3 votes → "👍 2 · 👎 1"`, norm(q(row, "react-tally")?.textContent) === "👍 2 · 👎 1" && !q(row, "react-tally-few"), norm(q(row, "react-row")?.textContent));
  ok(`${who}: not on the roll → the tally but no vote buttons`, !q(row, "react-up"));
  row = await show("dc");
  ok(`${who}: "👍 7 · 👎 1" on a closed session`, norm(q(row, "react-tally")?.textContent) === "👍 7 · 👎 1");
  row = await show("d14");
  ok(`${who}: under 3 votes → a quiet "Not enough votes yet" — never a zero`, norm(q(row, "react-tally-few")?.textContent) === "Not enough votes yet" && !q(row, "react-tally") && !/👍 0/.test(norm(q(row, "react-row")?.textContent)));
  const rows = [...host.querySelectorAll('[data-testid="react-row"]')].map((x) => norm(x.textContent)).join(" | ");
  ok(`${who}: no member id or name anywhere on a reactions line (the hostile reply's member_id / voter are dropped)`, rows.length > 0 && !/m-2|Ben Two|Ann One|Cal Three|member/i.test(rows), rows);
  unmount();
}
{ const { unmount } = await mount(["Department Admin"], "m-1");   // a DA who was on the roll
  const row = await show("dv");
  ok("a leader who attended sees both: their own vote control AND the tally", !!q(row, "react-up") && norm(q(row, "react-tally")?.textContent) === "👍 2 · 👎 1");
  await click(q(row, "react-up")); await tick();
  ok("…voting refreshes the tally — again ONE batched call", rpcs("set_session_reaction").length === 1 && rpcs("session_reaction_tally").length === 2 && JSON.stringify(rpcs("session_reaction_tally")[1].args.p_session_ids) === '["d14","d15","dc","dv","dx"]');
  unmount(); }
{ const { unmount } = await mount(["Department Admin"], "m-ada", SESS(), { session_reaction_tally: "boom" });
  const row = await show("dv");
  ok("a failed tally read shows nothing (never a fake zero or 'not enough')", rpcs("session_reaction_tally").length === 1 && !q(row, "react-tally") && !q(row, "react-tally-few"));
  unmount(); }

// 5 — the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const BASE = "f65886a";   // live origin/main when U2 was built (industrial-noir-50)
const base = execSync(`git show ${BASE}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const rpcSet = (s) => new Set((s.match(/supabase\.rpc\("([a-z_]+)"/g) || []).map((x) => x.slice(14, -1)));
const added = [...rpcSet(src)].filter((n) => !rpcSet(base).has(n)).sort();
ok("the only new RPC names are Slice R's two: set_session_reaction + session_reaction_tally", JSON.stringify(added) === '["session_reaction_tally","set_session_reaction"]', JSON.stringify(added));
ok("the tally path keeps only session_id / up / down from each row", /data\.map\(\(r\) => \[r\.session_id, \{ up: Number\(r\.up\) \|\| 0, down: Number\(r\.down\) \|\| 0 \}\]\)/.test(src) && !/member_id/.test(src.slice(src.indexOf("const loadTally"), src.indexOf("async function vote("))));
ok("the only reactions table read is the own-vote select (session_id, value)", (src.match(/from\("training_session_reactions"\)/g) || []).length === 1 && src.includes('from("training_session_reactions").select("session_id, value")') && !/from\("training_session_reactions"\)\.(insert|update|upsert|delete)/.test(src));
const changed = execSync(`git diff --name-only ${BASE} -- src api shared sql vercel.json package.json`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok(`client only: vs ${BASE} the only runtime change is src/App.jsx`, JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const tok = (s, flags) => (s.match(new RegExp("verifie" + "d", flags)) || []).length;
ok("verified untouched: App.jsx 132 (108 raw), same as the base", tok(src, "gi") === 132 && tok(src, "g") === 108 && tok(base, "gi") === 132, `${tok(src, "gi")}/${tok(src, "g")}`);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
