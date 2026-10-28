// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/fe_b_ui_test.mjs
// No network, no DB. Bundles the REAL src/App.jsx with esbuild (in-memory fakes for supabaseClient, ConfirmDestructive,
// NoirDialogs) and drives EventsCalendar as leaders — FE-B-UI (claude/B4C_FundingEvents_FE_A_FE_B_DB_ReviewRecord.md):
//   1. reads: recruitment_events carries event_type; needs + claims read with explicit columns
//   2. coverage: a calendar chip shows "· taken/slots" + "needs: N of M covered"; the detail shows the coverage chip
//   3. the Needs editor (DA / Officer): validates 1–50 whole people and shift order before any write; inserts on the right
//      parent (recruitment_event_id vs funding_event_id); edit; remove names the sign-ups it drops; a 0-row write is an error
//   4. assign / remove a sign-up go through assign_event_need / remove_event_need_claim (never the claims table); RPC
//      codes are shown as plain sentences; a past event hides assign / remove and says sign-ups are closed
//   5. Jobs (community only): read by recruitment_event_id; add (department_id + recruitment_event_id + source_label);
//      Done / Not needed (reason) / Reopen through the lifecycle RPCs
//   6. delete-confirm names how many sign-ups go with the event
//   7. community subtype: event_type on add / edit; fundraiser rows never carry it
//   8. role gates: Board / PA / Member see needs + who signed up, but no editor, no assign, no jobs actions
//   9. the source: no write to event_need_claims anywhere; only src/App.jsx changed; verified unchanged; Notify held
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
      const b = { _t: table, _op: "select", _f: [], _cols: null, _ret: null, _row: null };
      b.select = (c) => { if (b._op === "select") b._cols = c; else b._ret = c; return b; };
      for (const m of ["neq", "order", "limit", "in", "is", "gte", "lte", "not"]) b[m] = () => b;
      b.eq = (c, v) => { b._f.push([c, v]); return b; };
      b.insert = (row) => { b._op = "insert"; b._row = row; return b; };
      b.update = (row) => { b._op = "update"; b._row = row; return b; };
      b.delete = () => { b._op = "delete"; return b; };
      b.then = (res, rej) => { const call = { table, op: b._op, cols: b._cols, row: b._row, f: b._f, ret: b._ret }; st.calls.push(call); return Promise.resolve(st.answer(call)).then(res, rej); };
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.rpcs.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.rpc(n, args)).then(res, rej) }; } };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async (o) => { globalThis.__destructive.push(o); return true; }; export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => !!globalThis.__canDeleteShared; export const DestructiveConfirmHost = () => null;`,
  nd: `export const noirConfirm = async (o) => { globalThis.__confirms.push(o); return true; }; export const noirPrompt = async (o) => { globalThis.__prompts.push(o); return globalThis.__promptAnswer; }; export const NoirDialogHost = () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-feb-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { EventsCalendar, needCoverage };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { EventsCalendar, needCoverage, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- data (this month, so the calendar opens on it) ----
const now = new Date(); const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
// The OPEN event is TODAY (open by the D1 window — today's event takes sign-ups). It used to be min(today + 2, 27), which
// from the 26th on put the "future" event in the past — closed, no assign list — and the test crashed (fixed 2026-10-28).
const fut = now.getDate(), pastD = Math.max(now.getDate() - 2, 1);
const pastIso = now.getDate() > 2 ? `${ym}-${String(pastD).padStart(2, "0")}` : null;   // a past day this month (skipped on the 1st/2nd)
const MEMBERS = [{ id: "m1", name: "Ada Lane", status: "Active", access: ["Member"] }, { id: "m2", name: "Ben Cho", status: "Probationary", access: ["Member"] },
  { id: "m3", name: "Cy Dee", status: "Active", access: ["Officer"] }, { id: "m4", name: "Old Timer", status: "Inactive", access: ["Member"] }];
let DB, WRITE_ANSWER, RPC_ERR;
const reset = () => {
  DB = {
    funding_events: [{ id: "f1", date: `${ym}-${String(fut).padStart(2, "0")}`, title: "Pancake breakfast", color: "#CC9E52", notes: null, start_time: null, end_time: null, location_label: null, fundraiser_id: null }],
    recruitment_events: [{ id: "r1", date: `${ym}-${String(fut).padStart(2, "0")}`, title: "Open house", color: "#2FA869", notes: null, start_time: null, end_time: null, location_label: null, event_type: "open_house" },
      ...(pastIso ? [{ id: "r2", date: pastIso, title: "Old booth", color: "#2FA869", notes: null, start_time: null, end_time: null, location_label: null, event_type: null }] : [])],
    fundraisers: [],
    event_needs: [{ id: "n1", recruitment_event_id: "r1", funding_event_id: null, role_label: "Engine crew", slots_needed: 3, start_time: null, end_time: null, notes: "Bring turnouts", sort: 0, created_at: "1" },
      { id: "n2", recruitment_event_id: "r1", funding_event_id: null, role_label: "Kids' table", slots_needed: 1, start_time: "10:00:00", end_time: "12:00:00", notes: null, sort: 1, created_at: "2" },
      ...(pastIso ? [{ id: "n3", recruitment_event_id: "r2", funding_event_id: null, role_label: "Setup", slots_needed: 2, start_time: null, end_time: null, notes: null, sort: 0, created_at: "3" }] : [])],
    event_need_claims: [{ id: "c1", need_id: "n1", member_id: "m1", claimed_by: "m1", created_at: "1" }, { id: "c2", need_id: "n2", member_id: "m2", claimed_by: "m3", created_at: "2" },
      ...(pastIso ? [{ id: "c3", need_id: "n3", member_id: "m1", claimed_by: "m1", created_at: "3" }] : [])],
    action_items: [{ id: "j1", text: "Book the bounce house", status: "open", assigned_to: "m3", assignee_name: null, due_date: `${ym}-15`, completed_at: null, cancel_reason: null, created_at: "1" },
      { id: "j2", text: "Print flyers", status: "done", assigned_to: null, assignee_name: null, due_date: null, completed_at: "x", cancel_reason: null, created_at: "2" }],
  };
  WRITE_ANSWER = null; RPC_ERR = {};
  Object.assign(globalThis.__sb, { calls: [], rpcs: [] });
  globalThis.__destructive = []; globalThis.__confirms = []; globalThis.__prompts = []; globalThis.__promptAnswer = "Rental place brings it";
  notes.length = 0;
};
globalThis.__sb = {
  answer: (c) => {
    if (c.op === "select") return { data: DB[c.table] ? DB[c.table].map((r) => ({ ...r })) : [], error: null };
    if (WRITE_ANSWER) return WRITE_ANSWER;
    return { data: c.ret ? [{ id: "w1" }] : null, error: null };
  },
  rpc: (n) => (n === "my_department_id" ? { data: "dept-1", error: null } : RPC_ERR[n] ? { data: null, error: { message: RPC_ERR[n] } } : { data: { ok: true }, error: null }),
};
const notes = []; const notify = (n) => notes.push(n);
const S = new Proxy({}, { get: () => ({}) });
reset();
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
let host, rr;
async function mount(role, canDeleteShared = false) {
  globalThis.__canDeleteShared = canDeleteShared;
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rr = createRoot(host);
  await act(async () => { rr.render(React.createElement(EventsCalendar, { S, role, notify, members: MEMBERS })); });
  await tick(); await tick();
}
const unmount = () => act(() => rr.unmount());
const btn = (root, t) => [...root.querySelectorAll("button")].find((b) => (t instanceof RegExp ? t.test(norm(b.textContent)) : norm(b.textContent) === t));
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const setVal = (n, v) => act(async () => {
  const proto = n.tagName === "SELECT" ? win.HTMLSelectElement.prototype : n.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(n, v); n.dispatchEvent(new win.Event(n.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
});
const chip = (t) => [...host.querySelectorAll("[title]")].find((n) => (n.getAttribute("title") || "").includes(t) && (n.getAttribute("title") || "").includes("tap for details"));
const field = (root, label) => { const l = [...root.querySelectorAll("label")].find((x) => norm(x.textContent).startsWith(label)); return l && l.querySelector("input, select, textarea"); };
const panel = () => host.querySelector('[data-testid="needs-panel"]');
const jobs = () => host.querySelector('[data-testid="jobs-panel"]');
const writes = (table) => globalThis.__sb.calls.filter((c) => c.table === table && c.op !== "select");

// ---------------------------------------------------------------- 0. coverage helper
ok("needCoverage caps per need and sums", JSON.stringify(needCoverage([{ id: "a", slots_needed: 2 }, { id: "b", slots_needed: 1 }], [{ need_id: "a" }, { need_id: "a" }, { need_id: "a" }, { need_id: "b" }])) === '{"taken":3,"slots":3}');

// ---------------------------------------------------------------- 1 + 2. reads + coverage on chips
reset(); await mount(["Department Admin"], true);
{ const r = (t) => globalThis.__sb.calls.find((c) => c.table === t && c.op === "select");
  ok("recruitment_events read carries event_type", /event_type/.test(r("recruitment_events")?.cols || ""), r("recruitment_events")?.cols);
  ok("needs + claims read with explicit columns", r("event_needs")?.cols === "id, recruitment_event_id, funding_event_id, role_label, slots_needed, start_time, end_time, notes, sort, created_at" && r("event_need_claims")?.cols === "id, need_id, member_id, claimed_by, created_at");
  const c = chip("Open house");
  ok("chip shows coverage '· 2/4' and the tooltip says 'needs: 2 of 4 covered' + the subtype", norm(c?.textContent).includes("Open house · 2/4") && /needs: 2 of 4 covered/.test(c.getAttribute("title")) && /Community event \(Open house\)/.test(c.getAttribute("title")), norm(c?.textContent));
  ok("an event with no needs has no coverage suffix", !/·\s*\d+\/\d+/.test(norm(chip("Pancake breakfast")?.textContent))); }

// ---------------------------------------------------------------- 3. detail + Needs editor (DA)
await click(chip("Open house")); await tick(); await tick();
const jobsRead = globalThis.__sb.calls.find((c) => c.table === "action_items" && c.op === "select");
{ const t = norm(panel()?.textContent);
  ok("detail: coverage chip '2 of 4 covered' + both needs with who signed up", panel() && host.querySelector('[data-testid="coverage-chip"]')?.textContent === "2 of 4 covered" && t.includes("Engine crew") && t.includes("1 of 3") && t.includes("Ada Lane") && t.includes("Kids' table") && t.includes("Ben Cho") && t.includes("Bring turnouts"));
  ok("detail header names the subtype", norm(host.textContent).includes("Community event · Open house")); }
await click(btn(panel(), /Add a need/));
for (const [label, role, slots, start, end] of [["empty role", "", "2", "", ""], ["0 people", "Setup", "0", "", ""], ["51 people", "Setup", "51", "", ""], ["2.5 people", "Setup", "2.5", "", ""], ["end before start", "Setup", "2", "14:00", "09:00"]]) {
  await setVal(field(panel(), "Role / need"), role); await setVal(field(panel(), "How many"), slots);
  await setVal(field(panel(), "Shift start"), start); await setVal(field(panel(), "Shift end"), end);
  globalThis.__sb.calls.length = 0; notes.length = 0;
  await click(btn(panel(), "Add need")); await tick();
  ok(`add need refused before any write: ${label}`, writes("event_needs").length === 0 && notes.some((n) => n.kind === "error"));
}
await setVal(field(panel(), "Role / need"), "Setup crew"); await setVal(field(panel(), "How many"), "4"); await setVal(field(panel(), "Shift start"), "08:00"); await setVal(field(panel(), "Shift end"), "09:30");
globalThis.__sb.calls.length = 0;
await click(btn(panel(), "Add need")); await tick(); await tick();
{ const w = writes("event_needs")[0];
  ok("add need → event_needs insert on the community parent, with department + shift, read back", w && w.op === "insert" && w.row.recruitment_event_id === "r1" && !("funding_event_id" in w.row) && w.row.department_id === "dept-1"
     && w.row.role_label === "Setup crew" && w.row.slots_needed === 4 && w.row.start_time === "08:00" && w.row.end_time === "09:30" && w.ret === "id", JSON.stringify(w?.row)); }
// edit + the DB refusing to drop below sign-ups
const editBtn = () => [...panel().querySelectorAll('[data-testid="need-row"]')].find((r) => /Engine crew/.test(r.textContent)).querySelector("button");
await click(editBtn()); await setVal(field(panel(), "How many"), "0");
WRITE_ANSWER = null; notes.length = 0; globalThis.__sb.calls.length = 0;
await click(btn(panel(), "Save need")); await tick();
ok("edit: 0 people refused before the write", writes("event_needs").length === 0);
await setVal(field(panel(), "How many"), "1");
WRITE_ANSWER = { data: null, error: { message: "SLOTS_BELOW_CLAIMS: 1 people are signed up — remove someone before lowering it to 0." } };
await click(btn(panel(), "Save need")); await tick();
{ const w = writes("event_needs")[0];
  ok("edit → update by id with .select(); a DB refusal is shown as a sentence (code stripped)", w && w.op === "update" && w.f.some(([c, v]) => c === "id" && v === "n1") && w.ret === "id"
     && notes.some((n) => n.kind === "error" && /people are signed up/.test(n.text) && !/SLOTS_BELOW_CLAIMS/.test(n.text))); }
WRITE_ANSWER = { data: [], error: null }; notes.length = 0;
await click(btn(panel(), "Save need")); await tick();
ok("edit: 0 rows back = an error, not a success", notes.some((n) => n.kind === "error" && /Nothing was saved/.test(n.text)));
WRITE_ANSWER = null;
await click(btn(panel(), "Cancel"));
// remove a need: names its sign-ups
const removeBtn = () => [...[...panel().querySelectorAll('[data-testid="need-row"]')].find((r) => /Engine crew/.test(r.textContent)).querySelectorAll("button")].find((b) => norm(b.textContent) === "Remove");
globalThis.__sb.calls.length = 0;
await click(removeBtn()); await tick();
ok("remove need: the confirm names the sign-ups it drops; delete by id with .select()", /1 person is signed up/.test(globalThis.__confirms.at(-1)?.body || "") && writes("event_needs").some((w) => w.op === "delete" && w.f.some(([c, v]) => c === "id" && v === "n1") && w.ret === "id"));

// ---------------------------------------------------------------- 4. assign / remove a sign-up
{ const engine = [...panel().querySelectorAll('[data-testid="need-row"]')].find((r) => /Engine crew/.test(r.textContent));
  const sel = engine.querySelector("select");
  const opts = [...sel.options].map((o) => o.textContent);
  ok("assign list = active / probationary members not already on it (no Inactive, no duplicate)", !opts.includes("Old Timer") && !opts.includes("Ada Lane") && opts.includes("Ben Cho") && opts.includes("Cy Dee"), JSON.stringify(opts));
  await setVal(sel, "m3"); globalThis.__sb.rpcs.length = 0;
  await click(btn(engine, "Assign")); await tick();
  ok("Assign → assign_event_need(need, member)", globalThis.__sb.rpcs.some((r) => r.n === "assign_event_need" && r.args.p_need_id === "n1" && r.args.p_member_id === "m3"));
  RPC_ERR.assign_event_need = "FULL: every slot for this is taken."; notes.length = 0;
  await setVal(sel, "m2"); await click(btn(engine, "Assign")); await tick();
  ok("an RPC refusal reads as a sentence (FULL: stripped)", notes.some((n) => n.kind === "error" && n.text === "every slot for this is taken."));
  delete RPC_ERR.assign_event_need; globalThis.__sb.rpcs.length = 0;
  await click(engine.querySelector('button[aria-label="Remove Ada Lane"]')); await tick();
  ok("✕ on a sign-up → remove_event_need_claim(claim)", globalThis.__sb.rpcs.some((r) => r.n === "remove_event_need_claim" && r.args.p_claim_id === "c1")); }
ok("the full need (Kids' table 1 of 1) offers no Assign", ![...panel().querySelectorAll('[data-testid="need-row"]')].find((r) => /Kids' table/.test(r.textContent)).querySelector("select"));

// ---------------------------------------------------------------- 5. Jobs (community)
{ const jr = jobsRead;
  ok("jobs read action_items by recruitment_event_id", jr && jr.f.some(([c, v]) => c === "recruitment_event_id" && v === "r1"));
  const t = norm(jobs()?.textContent);
  ok("jobs list: open + done, owner + due shown", t.includes("Book the bounce house") && t.includes("Cy Dee") && t.includes("Print flyers") && t.includes("1 open"));
  await click(btn(jobs(), /Add a job/));
  await setVal(field(jobs(), "Job"), "  Borrow tables  "); await setVal(field(jobs(), "Who"), "m1"); await setVal(field(jobs(), "Due"), `${ym}-20`);
  globalThis.__sb.calls.length = 0;
  await click(btn(jobs(), "Add job")); await tick(); await tick();
  const w = writes("action_items")[0];
  ok("add job → action_items insert (department, recruitment_event_id, source_label = the event, assignee, due) read back", w && w.op === "insert" && w.row.recruitment_event_id === "r1" && w.row.department_id === "dept-1"
     && w.row.source_label === "Open house" && w.row.text === "Borrow tables" && w.row.assigned_to === "m1" && w.row.due_date === `${ym}-20` && w.ret === "id", JSON.stringify(w?.row));
  globalThis.__sb.rpcs.length = 0;
  const row = (re) => [...jobs().querySelectorAll('[data-testid="job-row"]')].find((r) => re.test(r.textContent));
  await click(btn(row(/bounce house/), "Done")); await tick();
  await click(btn(row(/bounce house/), "Not needed")); await tick();
  await click(btn(row(/Print flyers/), "Reopen")); await tick();
  const n = globalThis.__sb.rpcs.map((r) => r.n);
  ok("Done / Not needed (with a reason) / Reopen → the lifecycle RPCs", n.includes("complete_action_item") && globalThis.__sb.rpcs.some((r) => r.n === "cancel_action_item" && r.args.p_reason === "Rental place brings it") && n.includes("reopen_action_item")); }

// ---------------------------------------------------------------- 6. delete names the sign-ups
await click(btn(host, /^Delete$/)); await tick();
ok("delete-confirm names the sign-ups removed with the event", /2 sign-ups for its 2 needs are removed too/.test(globalThis.__destructive.at(-1)?.impact || "") && /jobs for it stay/.test(globalThis.__destructive.at(-1)?.impact || ""), globalThis.__destructive.at(-1)?.impact);
await unmount();

// ---------------------------------------------------------------- 3b. fundraiser event: needs on the funding_event_id arm, no Jobs
reset(); await mount(["Officer"], false);
await click(chip("Pancake breakfast")); await tick(); await tick();
ok("a fundraiser event shows Needs but not Jobs", !!panel() && !jobs());
await click(btn(panel(), /Add a need/)); await setVal(field(panel(), "Role / need"), "Griddle"); await setVal(field(panel(), "How many"), "2");
globalThis.__sb.calls.length = 0; await click(btn(panel(), "Add need")); await tick(); await tick();
{ const w = writes("event_needs")[0];
  ok("a need on a fundraiser event goes on funding_event_id", w && w.row.funding_event_id === "f1" && !("recruitment_event_id" in w.row)); }
await unmount();

// ---------------------------------------------------------------- 4b. a past event: closed
if (pastIso) {
  reset(); await mount(["Department Admin"], true);
  await click(chip("Old booth")); await tick(); await tick();
  ok("past event: no assign, no remove ✕, 'sign-ups are closed'", !panel().querySelector("select") && !panel().querySelector('button[aria-label^="Remove "]') && /sign-ups are closed/.test(norm(panel().textContent)));
  await unmount();
} else ok("past event check skipped (first days of the month)", true);

// ---------------------------------------------------------------- 7. subtype on add / edit
reset(); await mount(["Officer"], false);
await click(btn(host, /Add an event/)); await click(host.querySelector('[data-testid="event-kind-community"]'));
await setVal(field(host, "Title"), "Parade float"); await setVal(field(host, "Kind of event"), "parade");
globalThis.__sb.calls.length = 0;
await click(btn(host, /^Add to/)); await tick();
{ const w = writes("recruitment_events")[0];
  ok("community add writes event_type", w && w.op === "insert" && w.row.event_type === "parade", JSON.stringify(w?.row)); }
await click(btn(host, /Add an event/)); await click(host.querySelector('[data-testid="event-kind-fundraiser"]'));
ok("the fundraiser form has no 'Kind of event'", !field(host, "Kind of event"));
await setVal(field(host, "Title"), "Raffle"); globalThis.__sb.calls.length = 0;
await click(btn(host, /^Add to/)); await tick();
{ const w = writes("funding_events")[0];
  ok("fundraiser add never carries event_type", w && !("event_type" in w.row)); }
await click(chip("Open house")); await tick();
await click([...host.querySelectorAll("button")].find((b) => norm(b.textContent) === "Edit" && !b.closest('[data-testid="needs-panel"]')));   // the EVENT's Edit, not a need's
ok("edit pre-fills the subtype", field(host, "Kind of event")?.value === "open_house");
await setVal(field(host, "Kind of event"), "booth"); globalThis.__sb.calls.length = 0;
await click(btn(host, "Save changes")); await tick();
{ const w = writes("recruitment_events")[0];
  ok("edit writes the new subtype", w && w.op === "update" && w.row.event_type === "booth"); }
await unmount();

// ---------------------------------------------------------------- 8. role gates
for (const [who, role] of [["Board", ["Board Member"]], ["Project Admin", ["Project Admin"]], ["Member", ["Member"]]]) {
  reset(); await mount(role, who === "Project Admin");
  await click(chip("Open house")); await tick(); await tick();
  const t = norm(panel()?.textContent);
  ok(`${who}: sees needs + who signed up, but no editor / assign / remove / job actions`, t.includes("Ada Lane") && !btn(panel(), /Add a need/) && !btn(panel(), "Edit")
     && !panel().querySelector("select") && !panel().querySelector('button[aria-label^="Remove "]') && !btn(jobs(), /Add a job/) && !btn(jobs(), "Done") && !btn(jobs(), "Reopen"));
  await unmount();
}

// ---------------------------------------------------------------- 9. the source
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
// The DELTA fences are PINNED to FE-B-UI's own code commit (35980a0, parent d0e7ae9 = FE-A-r2; released in
// industrial-noir-36): "vs origin/main" goes red once the slice is on main. The structural guards below still read today's tree.
const REL = "35980a0";
const BASE = `${REL}^1`;
const base = execSync(`git show ${BASE}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const rel = execSync(`git show ${REL}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const changed = execSync(`git diff --name-only ${BASE} ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("FE-B-UI (35980a0) changed only src/App.jsx (runtime) vs its parent", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
ok("no write to event_need_claims anywhere — sign-ups only through the RPCs", !/from\("event_need_claims"\)\.(insert|update|upsert|delete)/.test(src) && src.includes('supabase.rpc("assign_event_need"') && src.includes('supabase.rpc("remove_event_need_claim"'));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged by FE-B-UI (35980a0) vs its parent", tok(rel) === tok(base), `${tok(rel)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
