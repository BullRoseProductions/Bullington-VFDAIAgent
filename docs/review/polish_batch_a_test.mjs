// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/polish_batch_a_test.mjs
// No network, no DB. Bret/Tommy polish batch A — the behaviour that matters, on the REAL src/App.jsx bundled with esbuild
// (supabaseClient + apiBase faked; the app's own NoirDialogHost mounted beside it, as main.jsx does). happy-dom has no
// layout: the table-scoped scrolling is proven in real Chrome (claude/B4C_PolishBatchA_Draft.md); here only its structure.
//   1. confirms block the action until confirmed — Resend login link: Cancel sends nothing, Send link sends exactly one;
//      Clear all checkmarks + the roster card ✕ were already guarded on main (asserted, so a regression shows)
//   2. end must be AFTER start — 11:47 → 11:47 is refused (was accepted); earlier refused; later / blanks fine
//   3. Expirations: an empty tracker shows "Add the first credential" (DA/officer) → Manage records opens a new credential;
//      Send reminders is a normal button, DISABLED at zero flagged with the reason, enabled and counted when someone is
//   4. Qualifications: no types → "Add the first qualification" → Manage qualifications opens on a new type
//   5. Study Session: the ~160-track list is searchable — typing narrows the grouped list (headings kept), a single hit
//      is picked, clearing restores all; the picked track never drops out of the select
//   6. person pickers exclude Inactive (and separated) — NULL status (masked) kept; the row's current person kept
//   7. fmtPhone: one display formatter — US numbers read (817) 555-0199; anything else exactly as stored
//   8. the giver countdown can't paint red before its first tick (null <= 10 was true)
//   9. Station Hours + Capital cards scroll the TABLE, not the card (header / explainer stay put); no clip added
//  FOLLOW-UP (rulings on the gate's PASS @88b559f):
//  10. board-audience events → Board + DA + PA only; "Leadership only" → leaders only — the rule, and the calendars obey it
//  11. the onboarding sign-off approver picker lists Active only (no Probationary); a current probationary approver is marked
//  12. the Department page with no department chosen is the PA's department list (radar read); a tap opens that department
//  13. Tommy's picker: "Plan (optional)" lists APPROVED drills only; picking one schedules the session WITH that existing plan
//      via attach_drill_plan_to_session — no plan created (no drill_plans write, no pull, no AI call)
//  14. Bret's packet buttons: an approved department copy → "Schedule this" / "Attach to a session" through the same path;
//      a draft copy → "waiting on officer approval", no buttons
//   fences: only src/App.jsx, src/phone.js, this test, the note; verified 132/32/14; Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "459dd61";   // live main when this was drafted (industrial-noir-61)
const REV = process.env.REV || null;   // the working tree until review; pin it in the promote push
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");

const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "InputEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia", "ResizeObserver", "IntersectionObserver", "MutationObserver", "location", "history", "screen", "CustomEvent"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A DA in a department; each case sets globalThis.__fx = { rpc: {...}, tables: {...} } before rendering.
const MOCKS = {
  sb: `
    const ME = "m-me", D = "d-1";
    const FX = () => globalThis.__fx || { rpc: {}, tables: {} };
    const BASE_RPC = { my_member_id: ME, my_department_id: D, is_dept_admin: true, is_department_admin: true, is_leader: true, is_leadership: true, is_canmanage: true, is_canmanage_ops: true, is_project_admin: false, has_password: true, my_open_station_session: [], my_stations: [], dept_cert_types: [], my_read_sign_queue: [] };
    function q(table) {
      const f = { single: false }; const b = {};
      for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "lt", "gt", "or", "not", "range", "filter", "match", "contains", "overlaps", "ilike", "like", "textSearch"]) b[m] = () => b;
      for (const m of ["insert", "update", "delete", "upsert"]) b[m] = (payload) => { f.write = m; (globalThis.__writes ||= []).push({ table, op: m, payload }); return b; };
      b.single = () => { f.single = true; return b; }; b.maybeSingle = () => { f.single = true; return b; };
      b.then = (res, rej) => {
        if (f.write === "insert") { const rows = [].concat((globalThis.__writes.at(-1) || {}).payload || []).map((r, i) => ({ id: "new-" + table + "-" + i, ...r })); return Promise.resolve({ data: f.single ? rows[0] : rows, error: null }).then(res, rej); }
        const rows = (FX().tables || {})[table] || []; return Promise.resolve(f.single ? { data: rows[0] || null, error: null } : { data: rows, error: null, count: rows.length }).then(res, rej); };
      return b;
    }
    export const supabase = {
      from: q,
      rpc: (n, args) => { (globalThis.__rpcs ||= []).push({ n, args }); const all = { ...BASE_RPC, ...(FX().rpc || {}) }; return { then: (res, rej) => Promise.resolve(n in all ? { data: all[n], error: null } : { data: null, error: { message: "no fixture: " + n } }).then(res, rej) }; },
      auth: { getSession: async () => ({ data: { session: { user: { id: "u1", email: "da@x.test" }, access_token: "t" } } }), getUser: async () => ({ data: { user: { id: "u1", email: "da@x.test" } } }),
              onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}), refreshSession: async () => ({ data: {} }) },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "x" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }), list: async () => ({ data: [], error: null }) }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  api: `export const isNative = () => false; export const apiUrl = (p) => p;
    export async function authedFetch(url, init) { (globalThis.__calls ||= []).push({ url, body: init && init.body });
      return { ok: true, status: 200, json: async () => ({ ok: true, sent: "invite" }), text: async () => "" }; }`,
  qr: `export const QRCodeCanvas = () => null; export const QRCodeSVG = () => null; export default () => null;`,
};
const out = join(mkdtempSync(join(tmpdir(), "b4c-pba-")), "app.mjs");
await build({
  stdin: { contents: `export { default as App, ResendLink, eventTimesInvalid, isPickable, pickable, sessionVisibleTo, DashboardCalendar, OicItemConfig, PADepartmentList, Packet, libRowToPacket } from "./src/App.jsx"; export { NoirDialogHost } from "./src/NoirDialogs.jsx"; export { fmtPhone } from "./src/phone.js"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" },
  bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "fakes", setup(b) {
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
    b.onResolve({ filter: /^\.\/apiBase(\.js)?$/ }, () => ({ path: "api", namespace: "fake" }));
    b.onResolve({ filter: /^qrcode\.react$/ }, () => ({ path: "qr", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: MOCKS[a.path], loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + "\nexport { ResendLink, eventTimesInvalid, isPickable, pickable, sessionVisibleTo, DashboardCalendar, OicItemConfig, PADepartmentList, Packet, libRowToPacket };\n", loader: "jsx" }));
  } }],
});
const { App, ResendLink, eventTimesInvalid, isPickable, pickable, sessionVisibleTo, DashboardCalendar, OicItemConfig, PADepartmentList, Packet, libRowToPacket, NoirDialogHost, fmtPhone, createRoot, act, createElement: h } = await import(pathToFileURL(out).href);
const origErr = console.error; console.error = () => {};
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const ME = { id: "m-me", department_id: "d-1", name: "Dana Admin", access: ["Department Admin"], status: "Active", role: "Chief", email: "da@x.test", phone: "8175550101" };
async function mount(el) {
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(win.React?.Fragment || "div", null, el, h(NoirDialogHost))));
  await tick(10);
  return { host, r, unmount: async () => { await act(async () => r.unmount()); host.remove(); } };
}
// Land on a screen the way a person does: the sidebar. (The app-update restore point is read once per page load, so it
// can't steer a second App in the same bundle.)
const NAV = { expirations: "Expirations", qualifications: "Qualifications", study: "Study Session", training: "Training" };
async function screen(name, fx) {
  globalThis.__fx = fx;
  win.localStorage.clear(); win.sessionStorage.clear();
  const v = await mount(h(App));
  const item = [...v.host.querySelectorAll("button, a")].find((b) => b.textContent.trim() === NAV[name]);
  if (!item) throw new Error("no nav item for " + name);
  await act(async () => { item.click(); }); await tick(10);
  return v;
}
const dialog = () => document.querySelector('[role="dialog"]');
const dialogBtn = (re) => [...(dialog()?.querySelectorAll("button") || [])].find((b) => re.test(b.textContent));
const btn = (root, re) => [...root.querySelectorAll("button")].find((b) => re.test(b.textContent));
const setInput = async (el, v) => { await act(async () => { const d = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value"); d.set.call(el, v); el.dispatchEvent(new win.Event("input", { bubbles: true })); }); await tick(2); };

// 1 — Resend login link: a confirm in front of the rate-limited send
{ globalThis.__calls = [];
  const v = await mount(h(ResendLink, { email: "  New.Member@Example.test ", notify: () => {} }));
  await act(async () => { btn(v.host, /Resend login link/).click(); }); await tick(3);
  ok("1. Resend: tapping it opens a confirm \"Email a sign-in link to <address>?\" (normalised address) — nothing sent yet",
    /Email a sign-in link to new\.member@example\.test\?/.test(dialog()?.textContent || "") && globalThis.__calls.length === 0, dialog()?.querySelector("h2")?.textContent);
  await act(async () => { dialogBtn(/^Cancel$/).click(); }); await tick(3);
  ok("1. …Cancel → no send, the button is still there", globalThis.__calls.length === 0 && !dialog() && !!btn(v.host, /Resend login link/));
  await act(async () => { btn(v.host, /Resend login link/).click(); }); await tick(3);
  await act(async () => { dialogBtn(/^Send link$/).click(); }); await tick(4);
  ok("1. …Send link → exactly ONE /api/invite with the normalised address, then the sent state",
    globalThis.__calls.length === 1 && globalThis.__calls[0].url === "/api/invite" && JSON.parse(globalThis.__calls[0].body).email === "new.member@example.test" && /Login link sent to/.test(v.host.textContent));
  await v.unmount(); }
const app = show(REV, "src/App.jsx");
const fnBody = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf("\nfunction ", i + 10)); };
const before = (body, guard, write) => { const g = body.indexOf(guard), w = body.indexOf(write); return g > 0 && w > g; };
ok("1. Clear all checkmarks: already behind a confirm on main (noirConfirm before the first uncomplete_duty)",
  before(fnBody(app, "StationDuties").slice(fnBody(app, "StationDuties").indexOf("async function clearAllCheckmarks")), "noirConfirm(", 'rpc("uncomplete_duty"'));
ok("1. the roster card's red ✕: already behind the typed-phrase confirmDestructive before the delete",
  /async function remove\(id, name\) \{\n\s+if \(!\(await confirmDestructive\(\{ noun: "member"/.test(app) && before(app.slice(app.indexOf("async function remove(id, name)")), "confirmDestructive(", 'from("members").delete()'));

// 2 — end > start
ok("2. 11:47 → 11:47 is refused (zero-length; was accepted)", eventTimesInvalid("23:47", "23:47") === true && eventTimesInvalid("23:47:00", "23:47") === true);
ok("2. end before start refused; end after start fine; a blank either side fine (times optional)",
  eventTimesInvalid("19:00", "18:30") && !eventTimesInvalid("18:00", "21:00") && !eventTimesInvalid("", "18:00") && !eventTimesInvalid("18:00", ""));
ok("2. station out-times were already client-checked (WS-4a G): out-time <= check-in refused in all three closers",
  (app.match(/when <= (new Date\(r\.checked_in_at\)|inAt)/g) || []).length === 3);

// 3 — Expirations
{ const v = await screen("expirations", { rpc: { dept_expirations: [] }, tables: { members: [ME], member_credentials: [], gear_items: [], apparatus_tests: [], apparatus: [] } });
  const empty = v.host.querySelector("[data-empty-expirations]");
  ok("3. Expirations, nothing tracked: the empty state carries \"Add the first credential\"", !!empty && !!btn(empty, /Add the first credential/));
  const send = v.host.querySelector("[data-send-reminders]");
  ok("3. Send reminders at zero flagged: a normal button, DISABLED, saying why (label + hover title)",
    !!send && send.disabled && /nobody's flagged/.test(send.textContent) && /nothing to send/.test(send.getAttribute("title") || "") && !/dashed/.test(send.getAttribute("style") || ""));
  await act(async () => { btn(empty, /Add the first credential/).click(); }); await tick(4);
  ok("3. …the CTA opens Manage records on a NEW credential (the form's Save is showing)", /Credentials/.test(v.host.textContent) && !!btn(v.host, /^\s*Save/) && !btn(v.host, /Add a credential/));
  await v.unmount(); }
{ const exp = (i, bucket, mid, on) => ({ item_id: `e${i}`, member_id: mid, member_name: "Pat Example", source: "cred", kind: "license", label: "Driver license", cls: null, expires_on: on, bucket });
  const v = await screen("expirations", { rpc: { dept_expirations: [exp(1, "expired", "m-2", "2025-01-01"), exp(2, "expired", "m-3", "2025-02-01"), exp(3, "current", "m-4", "2099-01-01")] }, tables: { members: [ME], member_credentials: [], gear_items: [], apparatus_tests: [], apparatus: [] } });
  const send = v.host.querySelector("[data-send-reminders]");
  ok("3. …with flagged members it's enabled and counted (no dead tap)", !!send && !send.disabled && /flagged members · 2/.test(send.textContent), send?.textContent);
  ok("3. …and no empty-state CTA once something is tracked", !v.host.querySelector("[data-empty-expirations]"));
  await v.unmount(); }

// 4 — Qualifications
{ const v = await screen("qualifications", { rpc: { dept_qualification_matrix: { types: [], members: [], cells: [] }, my_qualifications: [] }, tables: { members: [ME], qualification_types: [], qualification_drives: [], apparatus: [] } });
  const empty = v.host.querySelector("[data-empty-quals]");
  ok("4. Qualifications, none set up: the empty state carries \"Add the first qualification\" (DA)", !!empty && !!btn(empty, /Add the first qualification/), empty?.textContent?.slice(0, 80));
  await act(async () => { btn(empty, /Add the first qualification/).click(); }); await tick(4);
  const nameBox = [...v.host.querySelectorAll("input")].find((i) => i.getAttribute("placeholder") === "e.g. Engine 1 driver");
  ok("4. …the CTA opens Manage qualifications on a NEW type (name field showing)", !!nameBox && /Hide/.test(v.host.textContent));
  await v.unmount(); }

// 5 — Study Session search
{ const v = await screen("study", { rpc: {}, tables: { members: [ME] } });
  const sel = () => v.host.querySelector("[data-cert-select]"), box = v.host.querySelector("[data-cert-search]");
  const opts = () => [...sel().querySelectorAll("option")].map((o) => o.value), groups = () => [...sel().querySelectorAll("optgroup")].map((g) => g.label);
  const all = opts().length;
  ok("5. the full list is grouped (optgroup headings) and large", all >= 100 && groups().length >= 8, `${all} tracks / ${groups().length} groups`);
  await setInput(box, "rescue");
  ok("5. typing \"rescue\" narrows it — every option left matches (or is the picked track), headings kept",
    opts().length < all && opts().length > 1 && groups().length >= 1 && opts().every((o) => /rescue/i.test(o) || o === sel().value || groups().some((g) => /rescue/i.test(g))), `${opts().length} left`);
  ok("5. …with a count of matches", /\d+ of \d+ match/.test(v.host.querySelector("[data-cert-count]")?.textContent || ""));
  await setInput(box, "rope res");
  ok("5. a single hit is picked for you (\"rope res\" → Rope Rescue)", /Rope Rescue/i.test(sel().value), sel().value);
  await setInput(box, "zzzz-nothing");
  ok("5. no match → the picked track still listed, so the select never shows a value it doesn't hold", opts().length === 1 && opts()[0] === sel().value);
  await setInput(box, "");
  ok("5. clearing restores the whole list", opts().length === all);
  await v.unmount(); }

// 6 — pickers
{ const L = (id, status, extra = {}) => ({ id, name: id, access: ["Member"], status, ...extra });
  const ms = [L("a", "Active"), L("p", "Probationary"), L("i", "Inactive"), L("s", "Active", { separated: true }), L("n", null)];
  const ids = (xs) => xs.map((m) => m.id).join(",");
  ok("6. pickable: Inactive and separated out; Active, Probationary and a masked (NULL) status in", ids(pickable(ms)) === "a,p,n" && !isPickable(ms[2]), ids(pickable(ms)));
  ok("6. …the row's CURRENT person stays listed even if since gone inactive (an edit never silently re-points)", ids(pickable(ms, "i")) === "a,p,i,n");
  const sites = (app.match(/pickable\(members(, [a-zA-Z.]+)?\)/g) || []).length;
  ok("6. five pickers use it: Reach-out person, action-item Owner ×2, duty Assign-to ×2", sites === 5, `${sites}`);
  ok("6. the mentor / supervisor pickers already excluded Inactive on main (unchanged); the approver is Active-only now (11)",
    /m\.id !== member\.id && m\.status === "Active" && isAssignable\(m\)/.test(app) && /m\.status !== "Inactive" && isAssignable\(m\)/.test(app)
    && /\(m\.status === "Active" \|\| m\.status === "Probationary"\) && isAssignable\(m\)/.test(show(BASE, "src/App.jsx"))); }

// 7 — phones
ok("7. fmtPhone: 8175550199 / 817.555.0199 / +1 817 555 0199 / (817)555-0199 → (817) 555-0199",
  ["8175550199", "817.555.0199", "+1 817 555 0199", "(817)555-0199", " 1-817-555-0199 "].every((p) => fmtPhone(p) === "(817) 555-0199"));
ok("7. …anything else exactly as stored: extensions, short / international numbers, words, the \"—\" placeholder, blanks",
  fmtPhone("817-555-0199 x12") === "817-555-0199 x12" && fmtPhone("555-0199") === "555-0199" && fmtPhone("+44 20 7946 0958") === "+44 20 7946 0958" && fmtPhone("call the station") === "call the station" && fmtPhone("—") === "—" && fmtPhone(null) === "");
ok("7. every place a phone is SHOWN goes through it (Your Six, donor, sponsor, roster card, roster export, member file ×2) — tel: links still use telDigits",
  (app.match(/fmtPhone\(/g) || []).length === 7 && (app.match(/tel:\$\{telDigits\(/g) || []).length === (show(BASE, "src/App.jsx").match(/tel:\$\{telDigits\(/g) || []).length);

// 8 — giver countdown
ok("8. the giver's countdown tints from the SAME number it prints (no null <= 10 red frame); the receiver's guards null",
  /const left = secs \?\? Math\.max\(0/.test(app) && /color: left <= 10 \? FIRE\.redText/.test(app) && /color: secs != null && secs <= 10 \? FIRE\.redText/.test(app) && !/color: secs <= 10/.test(app));

// 9 — table-scoped scrolling
const cardsWithTableScroll = (body) => (body.match(/<div (key=\{g\.year\} )?style=\{\{ \.\.\.FS\.cardNoir, padding: "8px 0"[^}]*\}\}>/g) || []).length;
const sh = fnBody(app, "StationHoursReport"), cp = fnBody(app, "CapitalPlanReport");
const baseApp = show(BASE, "src/App.jsx"), shB = fnBody(baseApp, "StationHoursReport"), cpB = fnBody(baseApp, "CapitalPlanReport");
ok("9. Station Hours: the 4 cards are plain cards, each table in its own ScrollX (header + explainer no longer scroll)",
  cardsWithTableScroll(sh) - cardsWithTableScroll(shB) === 4 && (sh.match(/<ScrollX><table /g) || []).length === 4 && !/<ScrollX style=\{\{ \.\.\.FS\.cardNoir/.test(sh));
ok("9. Capital plan: each year's card + Not yet planned the same (the depreciation table already scrolled alone)",
  cardsWithTableScroll(cp) - cardsWithTableScroll(cpB) === 2 && (cp.match(/<ScrollX><table /g) || []).length === 2 && !/<ScrollX (key=\{g\.year\} )?style=\{\{ \.\.\.FS\.cardNoir/.test(cp));
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const added = execSync(`git diff -U0 ${diffArgs} -- src/App.jsx src/phone.js`, { cwd: root, maxBuffer: 1 << 27 }).toString().split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++") && !/^\+\s*(\/\/|\/\*|\*)/.test(l));
ok("9. no overflow hidden / clip added anywhere in the slice", !added.some((l) => /overflow[XY]?\s*:\s*["']?(hidden|clip)/i.test(l)));

// 10 — who sees restricted sessions
{ const B = { audience: "board" }, Ld = { audience: "leadership" }, E = { audience: "everyone" };
  const who = (s) => ["Member", "Officer", "Board Member", "Department Admin", "Project Admin"].filter((r) => sessionVisibleTo(s, [r])).join(",");
  ok("10. a BOARD event: Board Member, Department Admin, Project Admin — not Officers, not members", who(B) === "Board Member,Department Admin,Project Admin", who(B));
  ok("10. a LEADERSHIP-ONLY event: Officer, Board, DA, PA — never a plain member", who(Ld) === "Officer,Board Member,Department Admin,Project Admin", who(Ld));
  ok("10. an everyone event (or no audience): all", who(E) === "Member,Officer,Board Member,Department Admin,Project Admin" && sessionVisibleTo({}, ["Member"]));
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date(), d = (n) => ymd(new Date(now.getFullYear(), now.getMonth(), n));   // three different days this month (a day cell shows 2 chips + "+N")
  const ts = [{ id: "t1", date: d(1), title: "Hose drill EVERYONE", audience: "everyone", status: "scheduled", session_plans: [] },
              { id: "t2", date: d(2), title: "Budget BOARDONLY", audience: "board", status: "scheduled", session_plans: [] },
              { id: "t3", date: d(3), title: "Officer sync LEADONLY", audience: "leadership", status: "scheduled", session_plans: [] }];
  const cal = async (role) => { globalThis.__fx = { rpc: {}, tables: { training_sessions: ts, content_calendar: [], recruitment_events: [], funding_events: [], action_items: [] } };
    const v = await mount(h(DashboardCalendar, { S: {}, notify: () => {}, meId: "m-me", members: [], role })); const t = v.host.textContent; await v.unmount();
    return ["EVERYONE", "BOARDONLY", "LEADONLY"].filter((k) => t.includes(k)).join(","); };
  const m = await cal(["Member"]), o = await cal(["Officer"]), bd = await cal(["Board Member"]), da = await cal(["Department Admin"]);
  ok("10. the dashboard calendar obeys it: a member sees only the everyone event", m === "EVERYONE", m);
  ok("10. …an Officer sees the leadership event but not the board one", o === "EVERYONE,LEADONLY", o);
  ok("10. …a Board Member and a DA see all three", bd === "EVERYONE,BOARDONLY,LEADONLY" && da === "EVERYONE,BOARDONLY,LEADONLY", `${bd} / ${da}`);
  ok("10. every DashboardCalendar is handed the viewer's role (4 dashboards); Dashboard + Training get the filtered list; record screens keep all",
    (app.match(/<DashboardCalendar [^>]*role=\{role\}/g) || []).length === 4 && (app.match(/sessions=\{visibleSessions\}/g) || []).length === 2
    && /<Roster [^>]*sessions=\{trainingSessions\}/.test(app) && /<Reports [^>]*sessions=\{trainingSessions\}/.test(app)); }

// 11 — approver picker
{ const ms = [{ id: "a1", name: "Alex Active", status: "Active", access: ["Officer"] }, { id: "p1", name: "Pat Probie", status: "Probationary", access: ["Member"] }, { id: "i1", name: "Ivy Inactive", status: "Inactive", access: ["Member"] }];
  let v = await mount(h(OicItemConfig, { it: { id: "x", approver_kind: "tier", approver_role: null }, members: ms, busy: false, onSave: () => {} }));
  const people = () => [...v.host.querySelectorAll('optgroup[label="A specific person"] option')].map((o) => o.textContent);
  ok("11. the onboarding sign-off approver picker lists Active people only (no Probationary, no Inactive)", people().join("|") === "Alex Active", people().join("|"));
  await v.unmount();
  v = await mount(h(OicItemConfig, { it: { id: "x", approver_kind: "person", approver_member_id: "p1" }, members: ms, busy: false, onSave: () => {} }));
  ok("11. …an item already naming a probationary approver keeps them listed, marked \"probationary — pick someone else\"", people().some((t) => /Pat Probie \(probationary — pick someone else\)/.test(t)), people().join("|"));
  await v.unmount(); }

// 12 — the Department page
{ const gone = []; globalThis.__fx = { rpc: { pa_department_radar: [{ department_id: "d-z", department_name: "Zeta VFD", station: "Station 9", city: "Tolar, TX" }, { department_id: "d-a", department_name: "Alpha VFD", station: null, city: "Lipan, TX" }] }, tables: {} };
  let v = await mount(h(PADepartmentList, { go: (s, a) => gone.push([s, a]) }));
  const rows = [...v.host.querySelectorAll("[data-pa-dept-list] button")];
  ok("12. no department chosen → the PA's department list (from pa_department_radar), A–Z, with station · city", rows.length === 2 && /Alpha VFD/.test(rows[0].textContent) && /Station 9 · Tolar, TX/.test(rows[1].textContent));
  await act(async () => { rows[1].click(); });
  ok("12. …a tap opens that department's page: go(\"department\", { id, name })", gone.length === 1 && gone[0][0] === "department" && gone[0][1].id === "d-z" && gone[0][1].name === "Zeta VFD");
  await v.unmount();
  globalThis.__fx = { rpc: { pa_department_radar: undefined }, tables: {} }; delete globalThis.__fx.rpc.pa_department_radar;
  v = await mount(h(PADepartmentList, { go: () => {} }));
  ok("12. …a failed read says so with Retry — never an empty list", /Couldn't load your departments/.test(v.host.textContent) && !!btn(v.host, /Retry/));
  await v.unmount();
  ok("12. DepartmentAdmin's no-target branch renders it (the dead-end card is gone)", /if \(!deptId\) return <PADepartmentList go=\{go\} \/>/.test(app) && !/Open a department from the Program overview to configure it/.test(app)); }

// 13 — Tommy's picker, end to end on the real Training schedule form
{ const plans = [{ id: "dp-ok", title: "Ladder throws", status: "approved", duration_min: 90, category: "Ladders" }, { id: "dp-draft", title: "AI hazmat draft", status: "draft", source: "ai", duration_min: 60 }];
  globalThis.__writes = []; globalThis.__rpcs = []; globalThis.__calls = [];
  const v = await screen("training", { rpc: { dept_drill_plans: plans, attach_drill_plan_to_session: { id: "sp-1" }, my_training_officer: true, is_training_manager: true }, tables: { members: [ME], training_plans: [], training_sessions: [] } });
  const open = btn(v.host, /Schedule a session/);
  ok("13. (setup) a DA on Training has \"Schedule a session\"", !!open);
  await act(async () => { open.click(); }); await tick(8);
  const pick = v.host.querySelector("[data-plan-picker]");
  const opts = pick ? [...pick.querySelectorAll("option")].map((o) => o.textContent) : [];
  ok("13. the form has \"Plan (optional)\" listing APPROVED drills only (the draft isn't offered)", !!pick && opts.join("|") === "— None —|Ladder throws · 90 min", opts.join("|"));
  await act(async () => { pick.value = "dp-ok"; pick.dispatchEvent(new win.Event("change", { bubbles: true })); }); await tick(3);
  ok("13. …picking it sets the existing \"With plan\" chip", /With plan: Ladder throws/.test(v.host.querySelector('[data-testid="with-plan-chip"]')?.textContent || ""));
  await act(async () => { btn(v.host, /^\s*Add to /).click(); }); await tick(10);
  const ins = globalThis.__writes.filter((w) => w.table === "training_sessions" && w.op === "insert");
  const att = globalThis.__rpcs.filter((r) => r.n === "attach_drill_plan_to_session");
  ok("13. save → the session is inserted, then attach_drill_plan_to_session({ p_plan_id: the picked plan, p_session_id: the new session })",
    ins.length === 1 && att.length === 1 && att[0].args.p_plan_id === "dp-ok" && att[0].args.p_session_id === "new-training_sessions-0", JSON.stringify(att[0]?.args));
  ok("13. …and NO plan is created: no drill_plans write, no pull_library_drill, no AI call",
    !globalThis.__writes.some((w) => w.table === "drill_plans") && !globalThis.__rpcs.some((r) => /pull_library_drill|draft|create_drill/.test(r.n)) && !globalThis.__calls.some((c) => /claude|ai/i.test(c.url)));
  await v.unmount(); }

// 14 — Bret's packet buttons
{ const pk = { id: "lib-1", libraryId: "lib-1", track: Object.keys({}).length ? "" : undefined, title: "Ladder throws", code: "L-1", time: "90 min", level: "All", sections: [] };
  const rendered = async (copy) => { const used = []; let v;
    try { v = await mount(h(Packet, { S: {}, packet: { ...pk, track: "fire" }, dept: {}, notify: () => {}, back: () => {}, usage: null, added: true, canAdd: true, onAdd: () => {}, copy, onUseCopy: (k, p) => used.push([k, p.id]) })); }
    catch (e) { return { err: String(e) }; }
    return { v, used }; };
  const src = fnBody(app, "Packet");
  ok("14. an APPROVED department copy shows \"Schedule this\" + \"Attach to a session\", each handing that copy on (onUseCopy)",
    /data-testid="lib-schedule"[^>]*onClick=\{\(\) => onUseCopy\("schedule", copy\)\}/.test(src) && /data-testid="lib-attach"[^>]*onClick=\{\(\) => onUseCopy\("attach", copy\)\}/.test(src) && /copy\?\.status === "approved"/.test(src));
  ok("14. a DRAFT copy: \"In your plans — waiting on officer approval\", no buttons", /waiting on officer approval/.test(src));
  ok("14. the hand-off reaches the same paths: schedule → the Library prefill (goSchedule → With plan); attach → Training Plans with that plan selected + attach open",
    /goSchedule\(\{ planId: p\.id, planTitle: p\.title, title: p\.title, duration: p\.duration_min, category: p\.category \}\)/.test(app) && /setPlansFocus\(\{ planId: p\.id, attach: true/.test(app) && /setSelId\(focus\.planId\); setAttachOpen\(!!focus\.attach\)/.test(app) && /props\.onHandoffDone\?\.\(\)/.test(app));
  ok("14. the copy (id + status) comes from the catalog's own drill_plans read — no new read", /from\("drill_plans"\)\.select\("library_id, id, status, title, duration_min, category"\)/.test(app));
  const pkt = libRowToPacket({ id: "lib-1", code: "L-1", track: "Fire", title: "Ladder throws", level: "All", duration_min: 90, content: {} });   // the catalog's own shape
  const live = async (copy) => { const used = []; let v;
    try { v = await mount(h(Packet, { S: {}, packet: pkt, dept: {}, notify: () => {}, back: () => {}, usage: null, added: true, canAdd: true, onAdd: () => {}, copy, onUseCopy: (k, p) => used.push([k, p.id]) })); }
    catch (e) { return { err: String(e).slice(0, 120) }; }
    return { v, used }; };
  const A = await live({ id: "dp-9", status: "approved", title: "Ladder throws" });
  if (A.err) ok("14. (render) the packet renders", false, A.err);
  else {
    const sch = A.v.host.querySelector('[data-testid="lib-schedule"]'), att = A.v.host.querySelector('[data-testid="lib-attach"]');
    await act(async () => { sch?.click(); att?.click(); });
    ok("14. rendered: an approved copy → both buttons; each click hands THAT copy on (schedule, then attach)", !!sch && !!att && JSON.stringify(A.used) === JSON.stringify([["schedule", "dp-9"], ["attach", "dp-9"]]) && !A.v.host.querySelector('[data-testid="lib-added"]'), JSON.stringify(A.used));
    await A.v.unmount();
    const D = await live({ id: "dp-8", status: "draft", title: "Ladder throws" });
    ok("14. rendered: a draft copy → \"In your plans — waiting on officer approval\", no Schedule / Attach", !D.err && /waiting on officer approval/.test(D.v.host.querySelector('[data-testid="lib-added"]')?.textContent || "") && !D.v.host.querySelector('[data-testid="lib-schedule"]') && !D.v.host.querySelector('[data-testid="lib-attach"]'));
    if (!D.err) await D.v.unmount();
  }
  void rendered; }

// fences
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
// + the two earlier slice tests whose assertions the rulings deliberately changed (the drill_plans read's columns; the approver picker)
const allowed = new Set(["src/App.jsx", "src/phone.js", "docs/review/polish_batch_a_test.mjs", "claude/B4C_PolishBatchA_Draft.md", "docs/review/library_s1_ui_test.mjs", "docs/review/onboarding_item_config_ui_test.mjs"]);
const stray = [...changed, ...untracked.filter((p) => /^(src|api|shared|sql|docs\/review|ios|android|index\.html|vercel\.json)/.test(p))].filter((p) => !allowed.has(p));
ok("fences: only src/App.jsx, src/phone.js, this test, the note + the two re-ruled slice tests (no SQL, api, shared, native, vercel.json)", stray.length === 0, JSON.stringify(stray));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("Notify held: api/notify-session.js absent", REV ? !execSync(`git ls-tree --name-only ${REV} api/`, { cwd: root }).toString().includes("notify-session.js") : !existsSync(join(root, "api/notify-session.js")));
console.error = origErr;
process.exit(process.exitCode || 0);
