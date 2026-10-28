// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/step_regen_test.mjs
// No network, no DB. Per-step AI regenerate in the training-plan editor (client only). The REAL TrainingPlans /
// DrillPlanEditForm (src/App.jsx) with an in-memory fake of the drill-plan RPCs and a fake authedFetch for /api/claude:
//   1. ROUND TRIP: stepToRun → the editor's line ("t | d") → runFromText (the editor's own save parse) is byte-clean, and
//      libRowToPacket's "— N min" regex reads the title + minutes back; normal drafts are unchanged (drillPlanToContent
//      output == the old mapper's); pipes / newlines can't break a line
//   2. parseStepReply is FAIL-CLOSED: title non-empty string, minutes non-negative integer or null, actions a non-empty
//      array of non-blank strings — anything else → null
//   3. rows ("Rewrite a step") on any draft with steps — AI-drafted and manual — never on an approved plan, Start blank,
//      or a draft with no steps
//   4. a rewrite: ONE /api/claude call (system = DRILL_STEP_SYSTEM, the target marked, the note included); while it runs
//      the run-of-show box is read-only, every Rewrite button + Save are disabled, Collapse stays hidden (B1 edit guard);
//      only the target line changes (the others byte-identical); nothing is written until Save; Undo restores it exactly
//   5. Save → set_drill_plan with only that step changed in run_of_show
//   6. FAIL-CLOSED on a bad reply (11 shapes + an HTTP 429): the text is byte-identical, an alert says so, nothing written
//   7. DRILL_STEP_SYSTEM carries DRILL_PLAN_SYSTEM's guardrails; fences: only src/App.jsx (+ this test / notes) changed —
//      api/claude.js (the WS-2 gate) untouched; verified 132 (108 raw); Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "2c772d3";   // main when this was drafted (industrial-noir-48)
const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/", width: 1200, height: 900 });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MOCKS = {
  sb: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = {};
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "maybeSingle", "single"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (a) => { st.writes.push({ table, m, a }); return b; };
      b.then = (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }) }) }, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {} };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  cd: `export const confirmDestructive = async () => true; export const setDeleteGateRole = () => {}; export const useCanDeleteShared = () => true; export const DestructiveConfirmHost = () => null;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p;
    export async function authedFetch(path, init) { const body = JSON.parse(init.body); globalThis.__ai.push({ path, body }); const r = await globalThis.__aiReply(body);
      return { ok: r.status === 200, status: r.status, text: async () => JSON.stringify(r.status === 200 ? { text: r.text } : { error: "AI limit reached" }) }; }`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-stepregen-")), "app.under-test.mjs");
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
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { TrainingPlans, stepToRun, parseStepReply, runToText, runFromText, drillPlanToContent, libRowToPacket, DRILL_STEP_SYSTEM, DRILL_PLAN_SYSTEM };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx" }));
  } }],
});
const { TrainingPlans, stepToRun, parseStepReply, runToText, runFromText, drillPlanToContent, libRowToPacket, DRILL_STEP_SYSTEM, DRILL_PLAN_SYSTEM, createRoot, act, React } = await import(pathToFileURL(out).href);
globalThis.__ai = []; globalThis.__aiReply = async () => ({ status: 200, text: "{}" });

// ---------------------------------------------------------------- the fake plan library
const content = { summary: "Advance a charged line.", objectives: ["Advance a charged 1.75 in line"], steps: [{ title: "Size-up", minutes: 10, actions: ["Walk the scene"] }], safety: ["Full PPE and SCBA"] };
const plan = (id, title, status) => ({ id, title, category: "Fire", duration_min: 120, audience: "All", content, status, source: "ai", created_by: "m-ada", created_at: "2026-10-20T12:00:00Z",
  approved_by: status === "approved" ? "m-ada" : null, approved_at: status === "approved" ? "2026-10-21T12:00:00Z" : null, attached_sessions: 0 });
let DB = [];
globalThis.__sb = {
  calls: [], writes: [],
  answer: (n, a) => {
    if (n === "dept_drill_plans") return { data: DB.map((p) => ({ ...p })), error: null };
    if (n === "set_drill_plan" && a.p_id) { const r = DB.find((p) => p.id === a.p_id); Object.assign(r, { title: a.p_title, content: a.p_content }); return { data: r, error: null }; }
    if (n === "set_drill_plan" && !a.p_id) { const r = { ...plan(`p${DB.length + 1}`, a.p_title, "draft"), content: a.p_content, source: a.p_source }; DB.push(r); return { data: r, error: null }; }
    if (n === "approve_drill_plan") { const r = DB.find((p) => p.id === a.p_id); Object.assign(r, { status: "approved", approved_by: "m-ada", approved_at: new Date().toISOString() }); return { data: r, error: null }; }
    return { data: null, error: null };
  },
};
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (n) => act(async () => { n.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const S = new Proxy({}, { get: () => ({}) });
let host, rootR;
async function mount(role, manage) {
  globalThis.__sb.calls = []; globalThis.__sb.writes = [];
  if (rootR) await act(async () => rootR.unmount());
  document.body.innerHTML = ""; host = document.createElement("div"); document.body.appendChild(host); rootR = createRoot(host);
  await act(async () => { rootR.render(React.createElement(TrainingPlans, { S, role, canManageTraining: manage, sessions: [], loadSessions: () => {}, members: [{ id: "m-ada", name: "Ada DA" }],
    notify: () => {}, dept: { name: "Test FD" }, categories: [{ id: "c1", name: "Fire", color: "#B11E2A" }], viewToggle: null, loadPlans: () => {}, onScheduleWithPlan: () => {}, reloadNonce: 0 })); });
  await tick(); await tick();
}
const card = (title) => [...host.querySelectorAll("button[aria-pressed]")].find((b) => norm(b.textContent).startsWith(title));
const detail = () => { const t = norm(host.textContent); return t.includes("Approved plan") ? "approved" : t.includes("Awaiting review") ? "draft" : null; };
const detailTitle = () => host.querySelector('[style*="font-size: 18px"]')?.textContent || null;
const collapseBtn = () => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Collapse this plan");
const button = (t) => [...host.querySelectorAll("button")].find((b) => norm(b.textContent) === t || norm(b.textContent).startsWith(t));


const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// ================================================================ 1 round trip
const OLD = (s) => ({ t: String(s.title || "Step") + (s.minutes ? ` — ${s.minutes} min` : ""), d: strL(s.actions).join("; ") || (typeof s.detail === "string" ? s.detail : "") });
function strL(a) { return Array.isArray(a) ? a.filter((x) => x != null && String(x).trim() !== "").map(String) : []; }
const NORMAL = [{ title: "Size-up", minutes: 10, actions: ["Walk the scene", "Assign crews"] }, { title: "Advance the line", minutes: 25, actions: ["Flake the hose", "Bleed air"] },
  { title: "Debrief", minutes: null, actions: ["What went well?"] }, { title: "Rehab", minutes: 0, actions: ["Water", "Vitals"] }, { title: "Brief", minutes: 5, actions: [], detail: "Talk it through" }];
ok("normal drafted steps: drillPlanToContent's run_of_show is byte-identical to the old mapper's", deep(drillPlanToContent({ steps: NORMAL }).run_of_show, NORMAL.map(OLD)), JSON.stringify(drillPlanToContent({ steps: NORMAL }).run_of_show[0]));
const EDGE = [...NORMAL, { title: "Ladder | throw", minutes: 15, actions: ["Raise\nthe fly", "Heel | foot"] }, { title: "  Spaced   title  ", minutes: 12, actions: ["  trim me  "] }, { title: "Rounded", minutes: 12.6, actions: ["x"] }];
let rtBad = [];
for (const st of EDGE) {
  const r = stepToRun(st);
  const back = runFromText(runToText([r]))[0];
  const pk = libRowToPacket({ id: "x", content: { run_of_show: [r] } }).steps[0];
  const mins = Number(st.minutes) > 0 ? Math.round(Number(st.minutes)) : null;
  const okOne = deep(back, r) && !/[\n|]/.test(r.t) && !/\n/.test(r.d) && pk.m === mins && pk.t === r.t.replace(/\s+—\s+\d+\s*min$/, "");
  if (!okOne) rtBad.push({ st: st.title, r, back, pk });
}
ok("ROUND TRIP: stepToRun → editor line → runFromText (the save parse) is byte-clean, and libRowToPacket reads title + minutes back — for 8 steps incl. pipes, newlines, spacing, null/0/fractional minutes",
  rtBad.length === 0, JSON.stringify(rtBad).slice(0, 300));
ok("a pipe in a title can't split the line (→ '/'); a newline in an action can't break the line (→ space)", stepToRun(EDGE[5]).t === "Ladder / throw — 15 min" && stepToRun(EDGE[5]).d === "Raise the fly; Heel | foot", JSON.stringify(stepToRun(EDGE[5])));

// ================================================================ 2 parseStepReply, fail-closed
const GOOD = { title: "Advance a charged line", minutes: 20, actions: ["Flake the hose", "Bleed air at the nozzle", "Call for water"] };
ok("parseStepReply: a well-formed reply → the step (code fences tolerated; minutes null allowed)", deep(parseStepReply(JSON.stringify(GOOD)), GOOD) && deep(parseStepReply("```json\n" + JSON.stringify(GOOD) + "\n```"), GOOD) && parseStepReply(JSON.stringify({ ...GOOD, minutes: null }))?.minutes === null);
const BAD = { "not JSON": "sure! here's step 3", "a JSON array": JSON.stringify([GOOD]), "title empty": JSON.stringify({ ...GOOD, title: "  " }), "title a number": JSON.stringify({ ...GOOD, title: 5 }),
  "title missing": JSON.stringify({ minutes: 5, actions: ["a"] }), "minutes negative": JSON.stringify({ ...GOOD, minutes: -1 }), "minutes fractional": JSON.stringify({ ...GOOD, minutes: 2.5 }),
  "minutes a string": JSON.stringify({ ...GOOD, minutes: "10" }), "minutes missing": JSON.stringify({ title: "x", actions: ["a"] }), "actions a string": JSON.stringify({ ...GOOD, actions: "Do it" }),
  "actions empty": JSON.stringify({ ...GOOD, actions: [] }), "an action not a string": JSON.stringify({ ...GOOD, actions: ["ok", 3] }), "a blank action": JSON.stringify({ ...GOOD, actions: ["ok", "  "] }) };
const leaks = Object.entries(BAD).filter(([, t]) => parseStepReply(t) !== null).map(([k]) => k);
ok(`parseStepReply FAIL-CLOSED: ${Object.keys(BAD).length} malformed shapes → null`, leaks.length === 0, JSON.stringify(leaks));

// ================================================================ fixtures
const RUN = [{ t: "Size-up — 10 min", d: "Walk the scene; Assign crews" }, { t: "Stretch — 15 min", d: "Pull the preconnect" }, { t: "Advance — 20 min", d: "Old step three" }, { t: "Debrief — 10 min", d: "Hot wash | lessons" }];
const mk = (id, title, status, source, run) => ({ ...plan(id, title, status), source, content: { summary: "Hose work.", objectives: ["Advance a charged line"], run_of_show: run, materials: ["Engine"], safety: ["Full PPE"] } });
const fresh = () => [mk("p1", "Hose advance", "draft", "ai", RUN.map((x) => ({ ...x }))), mk("p2", "Radio check", "draft", "manual", [{ t: "Brief — 5 min", d: "Channels" }, { t: "Test — 10 min", d: "Each radio" }]),
  mk("p3", "Ladder raise", "approved", "ai", [{ t: "Raise — 10 min", d: "Two-person" }]), mk("p4", "Empty draft", "draft", "manual", [])];
const runBox = () => [...host.querySelectorAll("textarea")].find((t) => t.closest("label")?.textContent.includes("Run of show"));
const rows = () => host.querySelectorAll("[data-rewrite-row]");
const rewriteBtn = (n) => host.querySelector(`button[aria-label="Rewrite step ${n}"]`);
const noteBox = (n) => host.querySelector(`input[aria-label="Note for step ${n}"]`);
const saveBtn = () => [...host.querySelectorAll("button")].find((b) => norm(b.textContent) === "Save changes");
const setVal = async (n, v) => act(async () => { const proto = n.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(n, v); n.dispatchEvent(new win.Event("input", { bubbles: true })); });
async function openEdit(title) { if (detailTitle() !== title) { await click(card(title)); await tick(); } const e = button("Edit"); if (e) { await click(e); await tick(); } }

// ================================================================ 3 where the rows appear
DB = fresh();
await mount(["Department Admin"], true);
await openEdit("Hose advance");
ok("AI-drafted draft with 4 steps: 4 'Rewrite a step' rows, labelled by step", rows().length === 4 && norm(rows()[2].textContent).startsWith("Step 3 · Advance — 20 min"), norm(rows()[2]?.textContent));
await mount(["Department Admin"], true); await openEdit("Radio check");
ok("a manual (started-blank) draft with steps gets rows too", rows().length === 2);
await mount(["Department Admin"], true); await openEdit("Ladder raise");
ok("an APPROVED plan's editor has no rewrite rows", !!runBox() && rows().length === 0);
await mount(["Department Admin"], true); await openEdit("Empty draft");
ok("a draft with no steps has no rows", !!runBox() && rows().length === 0);
await mount(["Department Admin"], true); await click(button("Start blank")); await tick();
ok("Start blank (unsaved) has no rows", !!host.querySelector("#tp-start-blank textarea") && host.querySelectorAll("#tp-start-blank [data-rewrite-row]").length === 0);

// ================================================================ 4 a rewrite, in flight
DB = fresh();
await mount(["Department Admin"], true); await openEdit("Hose advance");
const original = runBox().value;
globalThis.__ai = []; globalThis.__sb.calls = [];
let release; globalThis.__aiReply = () => new Promise((r) => { release = () => r({ status: 200, text: JSON.stringify(GOOD) }); });
await setVal(noteBox(3), "make it a two-person advance");
await click(rewriteBtn(3)); await tick();
ok("ONE /api/claude call, system = DRILL_STEP_SYSTEM", globalThis.__ai.length === 1 && globalThis.__ai[0].path === "/api/claude" && globalThis.__ai[0].body.system === DRILL_STEP_SYSTEM);
const u = globalThis.__ai[0].body.user;
ok("the prompt marks ONLY step 3 as the target, carries the others as context, the plan + the note",
  /\n>>> TARGET 3\. Advance — 20 min \| Old step three\n/.test(u) && (u.match(/>>> TARGET/g) || []).length === 1 && u.includes("\n1. Size-up — 10 min | Walk the scene; Assign crews") && u.includes("\n4. Debrief — 10 min | Hot wash | lessons")
  && u.includes("Plan: Hose advance") && u.includes("- Advance a charged line") && u.includes("Note from the officer: make it a two-person advance") && u.includes("Rewrite step 3 only."), u.slice(0, 200));
ok("while it runs: the run-of-show box is read-only, every Rewrite button and Save are disabled",
  runBox().readOnly && [1, 2, 3, 4].every((n) => rewriteBtn(n).disabled) && saveBtn().disabled);
ok("…and the B1 edit guard holds: no Collapse button while editing", !host.querySelector('button[aria-label="Collapse this plan"]'));
ok("…a second tap can't start another call", (await click(rewriteBtn(2)), globalThis.__ai.length === 1));
await act(async () => { release(); }); await tick(); await tick();
const after = runBox().value.split("\n"), before = original.split("\n");
const expect3 = `${stepToRun(GOOD).t} | ${stepToRun(GOOD).d}`;
ok("only line 3 changed — lines 1, 2, 4 byte-identical; line 3 = stepToRun(reply)", after.length === before.length && [0, 1, 3].every((k) => after[k] === before[k]) && after[2] === expect3, JSON.stringify(after));
ok("…the box is editable again, Save enabled, a 'review, then Save' note shown", !runBox().readOnly && !saveBtn().disabled && norm(host.textContent).includes("Step 3 rewritten — review, then Save changes."));
ok("nothing written: no set_drill_plan call before Save", !globalThis.__sb.calls.some((c) => c.n === "set_drill_plan") && globalThis.__sb.writes.length === 0);
const undo = host.querySelector('button[aria-label="Undo rewrite of step 3"]');
await click(undo); await tick();
ok("Undo restores the box byte-for-byte", runBox().value === original);

// ================================================================ 5 rewrite + Save → set_drill_plan with only that step changed
globalThis.__aiReply = async () => ({ status: 200, text: JSON.stringify(GOOD) });
await click(rewriteBtn(3)); await tick(); await tick();
await click(saveBtn()); await tick(); await tick();
const sv = globalThis.__sb.calls.filter((c) => c.n === "set_drill_plan");
const ros = sv[0]?.args?.p_content?.run_of_show || [];
ok("Save → ONE set_drill_plan(p1): run_of_show steps 1, 2, 4 deep-equal the stored ones; step 3 = stepToRun(reply)",
  sv.length === 1 && sv[0].args.p_id === "p1" && ros.length === 4 && [0, 1, 3].every((k) => deep(ros[k], RUN[k])) && deep(ros[2], stepToRun(GOOD)), JSON.stringify(ros));
ok("…and the saved step re-parses clean (libRowToPacket: title + 20 min)", deep(libRowToPacket({ id: "x", content: { run_of_show: [ros[2]] } }).steps[0], { t: "Advance a charged line", m: 20, d: stepToRun(GOOD).d }));
ok("…one 'claude' AI call per rewrite (2 rewrites → 2 calls)", globalThis.__ai.length === 2);

// ================================================================ 6 fail-closed on a bad reply
DB = fresh();
await mount(["Department Admin"], true); await openEdit("Hose advance");
const base = runBox().value;
let leaked = [];
for (const [k, t] of [...Object.entries(BAD), ["HTTP 429 (the daily cap)", null]]) {
  globalThis.__aiReply = async () => (t === null ? { status: 429 } : { status: 200, text: t });
  globalThis.__ai = [];
  await click(rewriteBtn(2)); await tick(); await tick();
  const unchanged = runBox().value === base;
  const said = norm(host.textContent).includes("Couldn't rewrite that step — it's unchanged.");
  if (!(unchanged && said && globalThis.__ai.length === 1 && !saveBtn().disabled)) leaked.push(k);
}
ok(`FAIL-CLOSED: ${Object.keys(BAD).length} malformed replies + an HTTP 429 each leave the text byte-identical, say so, one call each`, leaked.length === 0, JSON.stringify(leaked));
ok("…and nothing was written", !globalThis.__sb.calls.some((c) => c.n === "set_drill_plan") && globalThis.__sb.writes.length === 0);
ok("no Undo offered after a failed rewrite", !host.querySelector('button[aria-label="Undo rewrite of step 2"]'));

// ================================================================ 7 prompt guardrails + fences
ok("DRILL_STEP_SYSTEM carries DRILL_PLAN_SYSTEM's guardrails (not a substitute; defer to local protocols / medical direction; qualified instructor + safety officer + authorization; realistic for staffing and apparatus) + no invented specifics + JSON-only one step",
  ["You are NOT a substitute for certified instruction, medical direction, or the AHJ.", "Defer to local protocols, state requirements, and medical direction.", "qualified instructor", "safety officer", "authorization", "realistic for the stated staffing and apparatus", "Do not invent specifics", "Respond with ONLY one valid JSON object"].every((x) => DRILL_STEP_SYSTEM.includes(x))
  && ["You are NOT a substitute for certified instruction, medical direction, or the AHJ.", "Defer to local protocols, state requirements, and medical direction."].every((x) => DRILL_PLAN_SYSTEM.includes(x)));
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const changed = execSync(`git diff --name-only ${BASE}`, { cwd: root }).toString().trim().split("\n").concat(execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n")).filter(Boolean);
const okFile = (p) => ["src/App.jsx", "docs/review/step_regen_test.mjs"].includes(p) || /^claude\/B4C_StepRegen_/.test(p);
ok(`only src/App.jsx (+ this test / notes) changed vs ${BASE} — api/claude.js (the WS-2 gate) untouched, no SQL`, changed.every(okFile) && !changed.includes("api/claude.js"), JSON.stringify(changed.filter((p) => !okFile(p))));
const claudeJs = readFileSync(join(root, "api/claude.js"), "utf8");
ok("the gate a rewrite goes through: /api/claude → requireMember → inputProblem → chargeAiCall(ctx, \"claude\")", /requireMember\(req, res\)[\s\S]*inputProblem\([\s\S]*chargeAiCall\(ctx, "claude", res\)/.test(claudeJs));
ok("drafts only: onRewriteStep is passed only when sel.status === \"draft\"", src.includes('onRewriteStep={sel.status === "draft" ? rewriteStep : undefined}'));
ok("verified untouched: App.jsx 132 (108 raw)", (src.match(new RegExp("verifie" + "d", "gi")) || []).length === 132 && (src.match(new RegExp("verifie" + "d", "g")) || []).length === 108);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
await act(async () => rootR.unmount());
process.exit(process.exitCode || 0);
