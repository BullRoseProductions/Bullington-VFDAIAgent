// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/fe_c_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (in-memory fakes) and drives the MEMBER side of event needs
// — FE-C-UI (claude/B4C_FundingEvents_Redesign_Step0_ReviewRecord.md FE8; FE-B-DB's claim / unclaim RPCs):
//   1. "Needs hands" card: upcoming events with an open slot (or one I'm on), soonest first, at most 3; past events and
//      full-without-me events left out; nothing at all when no event needs anyone
//   2. Sign up → claim_event_need(need); Can't make it → unclaim_event_need(need); a DB refusal (FULL / CLOSED) reads as a
//      sentence; the lists re-read after each
//   3. who's going is visible to members (FE5.2) — "You" for me
//   4. Station calendar (every dashboard): community / fundraiser chips carry "· taken/slots"; the event detail shows Needs
//      hands with Sign up; a past event is closed (no buttons); training events are unchanged
//   5. the source: no table write for sign-ups; the card + calendar props on all four dashboards; only src/App.jsx changed
//      vs origin/main; verified unchanged; Notify held
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
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table, _op: "select", _cols: null };
      b.select = (c) => { b._cols = c; return b; };
      for (const m of ["eq", "neq", "order", "limit", "in", "is", "gte", "lte", "not"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = () => { b._op = m; st.writes.push({ table, op: m }); return b; };
      b.then = (res, rej) => { st.reads.push({ table, cols: b._cols }); return Promise.resolve(st.table(table)).then(res, rej); };
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.rpcs.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.rpc(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) } };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => false; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async () => true; export const noirPrompt = async () => null; export const NoirDialogHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-fec-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { NeedsHandsCard, DashboardCalendar };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { NeedsHandsCard, DashboardCalendar, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- dates relative to today (local) ----
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = (off) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + off); return iso(d); };
const ME = "m-me";
const MEMBERS = [{ id: ME, name: "Me Myself", status: "Active" }, { id: "m2", name: "Ben Cho", status: "Active" }, { id: "m3", name: "Cy Dee", status: "Active" }];
let DB, RPC_ERR;
const reset = () => {
  DB = {
    recruitment_events: [
      { id: "r1", title: "Open house", date: day(5), start_time: "10:00:00" },     // open slots
      { id: "r2", title: "Booth", date: day(2), start_time: null },               // full, but I'm on it
      { id: "r3", title: "Parade", date: day(9), start_time: null },              // full, not me → hidden
      { id: "r4", title: "Old fair", date: day(-3), start_time: null },           // past → hidden from the card
      { id: "r5", title: "School visit", date: day(12), start_time: null },       // open
      { id: "r6", title: "Safety day", date: day(15), start_time: null },         // open (4th → cut by the limit of 3)
    ],
    funding_events: [{ id: "f1", title: "Pancake breakfast", date: day(1), start_time: "07:00:00" }],   // open → soonest
    event_needs: [
      { id: "n1", recruitment_event_id: "r1", funding_event_id: null, role_label: "Engine crew", slots_needed: 3, start_time: null, end_time: null, notes: "Bring turnouts", sort: 0, created_at: "1" },
      { id: "n1b", recruitment_event_id: "r1", funding_event_id: null, role_label: "Kids' table", slots_needed: 1, start_time: "10:00:00", end_time: "12:00:00", notes: null, sort: 1, created_at: "1b" },
      { id: "n2", recruitment_event_id: "r2", funding_event_id: null, role_label: "Booth staff", slots_needed: 1, start_time: null, end_time: null, notes: null, sort: 0, created_at: "2" },
      { id: "n3", recruitment_event_id: "r3", funding_event_id: null, role_label: "Float crew", slots_needed: 1, start_time: null, end_time: null, notes: null, sort: 0, created_at: "3" },
      { id: "n4", recruitment_event_id: "r4", funding_event_id: null, role_label: "Setup", slots_needed: 2, start_time: null, end_time: null, notes: null, sort: 0, created_at: "4" },
      { id: "n5", recruitment_event_id: "r5", funding_event_id: null, role_label: "Talk to kids", slots_needed: 2, start_time: null, end_time: null, notes: null, sort: 0, created_at: "5" },
      { id: "n6", recruitment_event_id: "r6", funding_event_id: null, role_label: "Demo", slots_needed: 2, start_time: null, end_time: null, notes: null, sort: 0, created_at: "6" },
      { id: "nf", recruitment_event_id: null, funding_event_id: "f1", role_label: "Griddle", slots_needed: 2, start_time: null, end_time: null, notes: null, sort: 0, created_at: "7" },
    ],
    event_need_claims: [
      { id: "c1", need_id: "n1", member_id: "m2", claimed_by: "m2", created_at: "1" },
      { id: "c1b", need_id: "n1b", member_id: "m3", claimed_by: "m3", created_at: "1b" },   // Kids' table full (not me)
      { id: "c2", need_id: "n2", member_id: ME, claimed_by: ME, created_at: "2" },
      { id: "c3", need_id: "n3", member_id: "m2", claimed_by: "m2", created_at: "3" },
      { id: "c4", need_id: "n4", member_id: ME, claimed_by: ME, created_at: "4" },
    ],
    content_calendar: [], training_sessions: [{ id: "t1", date: day(3), start_time: "19:00:00", title: "Hose drill", audience: "everyone", status: "scheduled", session_plans: [] }], action_items: [],
  };
  RPC_ERR = {};
  Object.assign(globalThis.__sb, { reads: [], rpcs: [], writes: [] });
  notes.length = 0;
};
globalThis.__sb = {
  table: (t) => ({ data: (DB[t] || []).map((r) => ({ ...r })), error: null }),
  rpc: (n) => (RPC_ERR[n] ? { data: null, error: { message: RPC_ERR[n] } } : { data: { ok: true }, error: null }),
};
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });
reset();
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
let host, rr;
async function render(el) {
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rr = createRoot(host);
  await act(async () => { rr.render(el); }); await tick(); await tick(); await tick();
}
const unmount = () => act(() => rr.unmount());

// ---------------------------------------------------------------- 1. the card's selection
reset(); await render(React.createElement(NeedsHandsCard, { meId: ME, members: MEMBERS, notify }));
{ const card = host.querySelector('[data-testid="needs-hands"]'); const t = norm(card?.textContent);
  const order = ["Pancake breakfast", "Booth", "Open house", "School visit"].map((x) => t.indexOf(x));
  ok("card: upcoming events with an open slot or me on it, soonest first, max 3", !!card && order[0] >= 0 && order[0] < order[1] && order[1] < order[2] && order[3] === -1, JSON.stringify(order));
  ok("card: past events and full-without-me events are left out", !t.includes("Old fair") && !t.includes("Parade") && !t.includes("Safety day"));
  ok("card: shows coverage per event (Open house: Engine crew 1/3 + Kids' table 1/1 = 2 of 4)", [...card.querySelectorAll('[data-testid="hands-coverage"]')].map((x) => x.textContent).includes("2 of 4 covered"));
  const openHouse = [...card.querySelectorAll('[data-testid="signup-row"]')].filter((r) => /Engine crew|Kids' table/.test(r.textContent));
  ok("card: only OPEN needs are offered (the full Kids' table isn't, I'm not on it)", openHouse.length === 1 && /Engine crew/.test(openHouse[0].textContent));
  ok("who's going is visible (Ben Cho), and my own row says 'You'", t.includes("Ben Cho") && /You're signed up/.test(t)); }

// ---------------------------------------------------------------- 2. sign up / can't make it / refusals
{ const card = host.querySelector('[data-testid="needs-hands"]');
  const row = [...card.querySelectorAll('[data-testid="signup-row"]')].find((r) => /Engine crew/.test(r.textContent));
  globalThis.__sb.rpcs.length = 0; globalThis.__sb.reads.length = 0;
  await click(row.querySelector('[data-testid="claim"]')); await tick(); await tick();
  ok("Sign up → claim_event_need(need) and the lists re-read", globalThis.__sb.rpcs.some((r) => r.n === "claim_event_need" && r.args.p_need_id === "n1") && globalThis.__sb.reads.some((r) => r.table === "event_need_claims") && notes.some((n) => n.kind === "success" && /signed up for Engine crew/.test(n.text)));
  const mine = [...card.querySelectorAll('[data-testid="signup-row"]')].find((r) => /Booth staff/.test(r.textContent));
  globalThis.__sb.rpcs.length = 0;
  await click(mine.querySelector('[data-testid="unclaim"]')); await tick();
  ok("Can't make it → unclaim_event_need(need)", globalThis.__sb.rpcs.some((r) => r.n === "unclaim_event_need" && r.args.p_need_id === "n2"));
  RPC_ERR.claim_event_need = "FULL: every slot for this is taken."; notes.length = 0;
  const griddle = [...card.querySelectorAll('[data-testid="signup-row"]')].find((r) => /Griddle/.test(r.textContent));
  await click(griddle.querySelector('[data-testid="claim"]')); await tick();
  ok("a refusal reads as a sentence (FULL: stripped)", notes.some((n) => n.kind === "error" && n.text === "every slot for this is taken.")); }
await unmount();

reset(); DB.event_needs = []; await render(React.createElement(NeedsHandsCard, { meId: ME, members: MEMBERS, notify }));
ok("card: nothing at all when no event needs anyone", !host.querySelector('[data-testid="needs-hands"]') && host.textContent === "");
await unmount();

// ---------------------------------------------------------------- 4. station calendar
reset(); await render(React.createElement(DashboardCalendar, { S, notify, meId: ME, members: MEMBERS }));
{ const chip = (t) => [...host.querySelectorAll("[title]")].find((n) => (n.getAttribute("title") || "").includes(t) && /click for details/.test(n.getAttribute("title")));
  // The training chip (Hose drill, 3 days out) — read BEFORE any month step, and again after one, so it's never vacuous.
  let hose = chip("Hose drill");
  // Open house is 5 days out — step to its month if that's next month (late in a month), so this always runs.
  if (!chip("Open house")) { await click(host.querySelector('button[aria-label="Next month"]')); await tick(); hose = hose || chip("Hose drill"); }
  ok("calendar: a training chip is found and is unchanged (no coverage suffix)", !!hose && !/·\s*\d+\/\d+/.test(norm(hose.textContent)) && !/needs:/.test(hose.getAttribute("title")));
  const oh = chip("Open house");
  ok("calendar: the Open house chip is found (stepping a month when needed)", !!oh);
  if (oh) {
    ok("calendar: a community chip carries '· 2/4' + 'needs: 2 of 4 covered'", norm(oh.textContent).includes("Open house · 2/4") && /needs: 2 of 4 covered/.test(oh.getAttribute("title")));
    await click(oh); await tick();
    const t = norm(host.textContent);
    ok("calendar detail: Needs hands + coverage + Sign up for an open need", t.includes("Needs hands") && t.includes("2 of 4 covered") && !!host.querySelector('[data-testid="claim"]'));
    globalThis.__sb.rpcs.length = 0;
    await click(host.querySelector('[data-testid="claim"]')); await tick();
    ok("calendar detail: Sign up → claim_event_need", globalThis.__sb.rpcs.some((r) => r.n === "claim_event_need" && r.args.p_need_id === "n1"));
  } else ok("calendar chips checked in the current month only (Open house falls next month today)", true);
  await unmount(); reset(); await render(React.createElement(DashboardCalendar, { S, notify, meId: ME, members: MEMBERS }));   // fresh, on this month
  const old = chip("Old fair");
  if (old) {
    await click(old); await tick();
    ok("calendar detail: a past event is closed — no Sign up / Can't make it", !host.querySelector('[data-testid="claim"]') && !host.querySelector('[data-testid="unclaim"]') && /sign-ups are closed/.test(norm(host.textContent)) && /You were signed up/.test(norm(host.textContent)));
  } else ok("past-event check needs this month's date (skipped today)", true); }
await unmount();

// ---------------------------------------------------------------- 5. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const base = execSync("git show origin/main:src/App.jsx", { cwd: root, maxBuffer: 1 << 27 }).toString();
const changed = execSync("git diff --name-only origin/main -- src api shared", { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime) vs origin/main", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
ok("sign-ups only through claim_ / unclaim_event_need — no write to event_need_claims", !/from\("event_need_claims"\)\.(insert|update|upsert|delete)/.test(src) && src.includes('supabase.rpc(fn, { p_need_id: n.id })'));
ok("the Needs hands card is on all four dashboards", (src.match(/<NeedsHandsCard meId=\{meId\} members=\{members\} notify=\{notify\}/g) || []).length === 4);
ok("every dashboard calendar gets meId + members", (src.match(/<DashboardCalendar S=\{S\} notify=\{notify\} meId=\{meId\} members=\{members\}/g) || []).length === 4 && !/<DashboardCalendar S=\{S\} notify=\{notify\} (withImportanceMode )?\/>/.test(src));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
