// HAPPY_DOM_DIR=<dir with happy-dom> node docs/review/notif_clearing_test.mjs
// No network, no DB. fix/notif-clearing (Ashlea, 2026-11-11: opened notifications don't clear; the bell said 4 while the
// header and Unread tab said 7). The REAL src/Notifications.jsx (bell + centre, rendered together, as in the app) is
// bundled with esbuild against a STATEFUL fake Supabase: head-only counts honour eq/is, mark_notification_read sets
// read_at only on the caller's own row (like the live RPC), mark_all_notifications_read marks all of the caller's.
//   1. the 4-vs-7 case: 7 own unread items, 3 of them older than the newest 50 rows (department-wide rows from other
//      officers push them out). Bell, header "N new" and Unread tab all say 7, from ONE server count. 64399b3's code,
//      on the same fixture, shows bell 4 / header 7 (the test catches the bug).
//   2. tap: the row reads as read, the RPC got that id, and bell + header + tab drop to 6 IMMEDIATELY, with no
//      visibilitychange; the DB row has read_at
//   3. "Mark all read": bell 0 at once, header badge and button gone, every own row read in the DB
//   4. push open: markNotificationReadFromPush(id) marks THAT row (DB), the bell drops, and the mounted centre reloads
//      to show it read; a non-uuid / empty id calls nothing and returns false
//   5. a refused tap resyncs (the row reads unread again, count re-counted, never a lie); a failed COUNT keeps the
//      last-known number, never 0
//   6. department-wide rows stay dim and untappable (no RPC); no chevron anywhere (a tap goes nowhere, so no arrow)
//   7. App.jsx wiring: the push handler opens the inbox AND marks the payload's id read
//   8. fences: files changed vs 64399b3 = src/Notifications.jsx, src/App.jsx, this test, the sidebar test's fake
//      (head counts honour eq/is) and maint_renag_test.mjs's fence pin; no api/, sql/, shared/, vercel.json, native, package changes; verified 132/32/14;
//      Notify held
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "64399b3";   // main when this slice branched (fix/maint-renag deployed 2026-11-11)

const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) { try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only */ } }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------- the stateful fake
const MOCK_SB = `
  const S = () => globalThis.__S;
  function q(table) {
    const f = { head: false, where: [], limit: null, order: null }; const b = {};
    for (const m of ["in", "gte", "lte", "not", "or", "neq"]) b[m] = () => b;
    b.select = (_c, o) => { if (o && o.head) f.head = true; return b; };
    b.eq = (c, v) => { f.where.push((r) => r[c] === v); return b; };
    b.is = (c, v) => { f.where.push((r) => (r[c] ?? null) === v); return b; };
    b.order = (c, o) => { f.order = [c, o]; return b; };
    b.limit = (n) => { f.limit = n; return b; };
    b.maybeSingle = async () => ({ data: null, error: null }); b.single = b.maybeSingle;
    b.then = (res, rej) => {
      const s = S();
      if (f.head) { s.countCalls++; if (s.failCount) return Promise.resolve({ data: null, error: { message: "count failed" }, count: null }).then(res, rej); }
      let rows = (s.tables[table] || []).filter((r) => f.where.every((w) => w(r)));
      if (f.order) rows = [...rows].sort((a, z) => (a[f.order[0]] < z[f.order[0]] ? 1 : -1) * (f.order[1] && f.order[1].ascending ? -1 : 1));
      if (f.limit != null) rows = rows.slice(0, f.limit);
      return Promise.resolve(f.head ? { data: null, error: null, count: rows.length } : { data: rows.map((r) => ({ ...r })), error: null }).then(res, rej);
    };
    return b;
  }
  export const supabase = {
    from: q,
    rpc: async (name, args) => {
      const s = S(); s.rpcs.push([name, args]);
      if (s.failRpc) return { data: null, error: { message: "refused" } };
      const now = new Date().toISOString();
      if (name === "mark_notification_read") for (const r of s.tables.notifications) if (r.id === args.p_id && r.member_id === s.me) r.read_at = r.read_at || now;
      if (name === "mark_all_notifications_read") for (const r of s.tables.notifications) if (r.member_id === s.me && !r.read_at) r.read_at = now;
      return { data: null, error: null };
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
  };
  export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";`;

async function bundle(tag, src) {
  const out = join(mkdtempSync(join(tmpdir(), "b4c-notif-")), `${tag}.mjs`);
  await build({
    stdin: src
      ? { contents: `${src}\nexport { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: join(root, "src"), sourcefile: "Notifications.jsx", loader: "jsx" }
      : { contents: `export { default as NotificationCenter, NotificationBell, markNotificationReadFromPush } from "./src/Notifications.jsx"; export { createRoot } from "react-dom/client"; export { act, createElement } from "react";`, resolveDir: root, loader: "js" },
    bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
    banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
    loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl" },
    define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test" }) },
    plugins: [{ name: "fakes", setup(b) {
      b.onResolve({ filter: /supabaseClient(\.js)?$/ }, () => ({ path: "sb", namespace: "fake" }));
      b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: MOCK_SB, loader: "js" }));
    } }],
  });
  return import(pathToFileURL(out).href);
}

// ---------------------------------------------------------------- fixture: Ashlea's 4-vs-7 shape
const ME = "0a0a0a0a-0000-4000-8000-000000000001";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-11-11T18:00:00Z");
function fixture() {
  const rows = [];
  let n = 0;
  const at = (minsAgo) => new Date(T0 - minsAgo * 60000).toISOString();
  // newest 50 rows: 4 own unread among 46 department-wide rows (other officers' copies of the daily summary)
  for (let i = 0; i < 50; i++) {
    const own = [5, 15, 25, 35].includes(i);
    rows.push({ id: uid(++n), member_id: own ? ME : `0b0b0b0b-0000-4000-8000-${String(i).padStart(12, "0")}`, type: "maint_summary", title: own ? `Own unread ${i}` : "1 maintenance item overdue",
                body: "Brush 26 · Radio Not Working", severity: "critical", read_at: null, created_at: at(i) });
  }
  // older rows 51..80: 3 more own unread (fall OUTSIDE the old bell's 50, inside the centre's 100), plus own read ones
  for (let i = 50; i < 80; i++) {
    const ownUnread = [55, 60, 70].includes(i), ownRead = [52, 65].includes(i);
    rows.push({ id: uid(++n), member_id: ownUnread || ownRead ? ME : "0c0c0c0c-0000-4000-8000-000000000009", type: "cert_expiring", title: ownUnread ? `Own unread ${i}` : ownRead ? `Own read ${i}` : "Dept cert",
                body: "", severity: "warning", read_at: ownRead ? at(i - 1) : null, created_at: at(i) });
  }
  return rows;
}
const ownUnreadIds = (rows) => rows.filter((r) => r.member_id === ME && !r.read_at).map((r) => r.id);

async function mount(mod, { failRpc = false } = {}) {
  globalThis.__S = { me: ME, tables: { notifications: fixture() }, rpcs: [], countCalls: 0, failRpc, failCount: false };
  const host = document.createElement("div"); document.body.appendChild(host);
  const r = mod.createRoot(host);
  const counts = [];
  const tree = mod.createElement("div", null,
    mod.createElement(mod.NotificationBell, { meId: ME, onOpen: () => {}, onCount: (c) => counts.push(c) }),
    mod.createElement(mod.NotificationCenter || mod.default, { S: {}, meId: ME, back: () => {} }));
  await mod.act(async () => r.render(tree));
  await settle(mod);
  return { host, r, counts };
}
const settle = async (mod) => { for (let i = 0; i < 6; i++) await mod.act(async () => { await new Promise((res) => setTimeout(res, 0)); }); };
const bellN = (host) => { const s = host.querySelector('button[aria-label^="Notifications"] span'); return s ? s.textContent : "0"; };
const headerN = (host) => { const b = [...host.querySelectorAll("h1 span")].find((s) => / new$/.test(s.textContent)); return b ? b.textContent.replace(" new", "") : "0"; };
const tabN = (host) => { const t = [...host.querySelectorAll("button")].find((b) => /^Unread/.test(b.textContent)); return t ? (t.textContent.replace("Unread", "") || "0") : "?"; };
const rowEl = (host, title) => [...host.querySelectorAll("span")].find((s) => s.textContent === title)?.closest("div[style*='padding: 13px 15px']");
const click = async (mod, el) => { await mod.act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); }); await settle(mod); };

const NOW = await bundle("now");

// ---------------------------------------------------------------- 1. the 4-vs-7 case
{
  const { host, r, counts } = await mount(NOW);
  ok("1. bell = 7 (all own unread, server count; was the newest-50 window)", bellN(host) === "7", bellN(host));
  ok("1. header \"N new\" = 7 and Unread tab = 7 — the same number as the bell", headerN(host) === "7" && tabN(host) === "7", `${headerN(host)}/${tabN(host)}`);
  ok("1. the sidebar (onCount) is told 7", counts.at(-1) === 7, JSON.stringify(counts));
  await NOW.act(async () => r.unmount());
}
{
  const baseSrc = execSync(`git show ${BASE}:src/Notifications.jsx`, { cwd: root, maxBuffer: 1 << 26 }).toString();
  const OLD = await bundle("base", `${baseSrc}`);
  const { host, r } = await mount({ ...OLD, NotificationCenter: OLD.default });
  ok(`1. the test catches the bug: ${BASE}'s code shows bell 4 / header 7 on this fixture`, bellN(host) === "4" && headerN(host) === "7", `${bellN(host)}/${headerN(host)}`);
  await OLD.act(async () => r.unmount());
}

// ---------------------------------------------------------------- 2. tap
{
  const { host, r, counts } = await mount(NOW);
  const el = rowEl(host, "Own unread 5");
  const before = globalThis.__S.countCalls;
  await click(NOW, el);
  const row = globalThis.__S.tables.notifications.find((x) => x.title === "Own unread 5");
  ok("2. tap → mark_notification_read called with that row's id", globalThis.__S.rpcs.some(([n, a]) => n === "mark_notification_read" && a.p_id === row.id));
  ok("2. tap → the DB row has read_at", !!row.read_at);
  ok("2. tap → bell, header and tab all 6 at once (no visibilitychange fired)", bellN(host) === "6" && headerN(host) === "6" && tabN(host) === "6", `${bellN(host)}/${headerN(host)}/${tabN(host)}`);
  ok("2. tap → the sidebar is told 6; and the count was re-read from the server after the write", counts.at(-1) === 6 && globalThis.__S.countCalls > before, JSON.stringify(counts.slice(-3)));
  ok("2. tap → the row now reads \"· read\" and is no longer tappable", /· read/.test(rowEl(host, "Own unread 5")?.textContent || "") && !/pointer/.test(rowEl(host, "Own unread 5")?.getAttribute("style") || ""));

  // ---------------------------------------------------------------- 3. mark all
  const markAll = [...host.querySelectorAll("button")].find((b) => /Mark all read/.test(b.textContent));
  await click(NOW, markAll);
  ok("3. Mark all read → bell 0, header badge gone, button gone", bellN(host) === "0" && headerN(host) === "0" && ![...host.querySelectorAll("button")].some((b) => /Mark all read/.test(b.textContent)), `${bellN(host)}/${headerN(host)}`);
  ok("3. Mark all read → every own row read in the DB; other members' rows untouched", ownUnreadIds(globalThis.__S.tables.notifications).length === 0 && globalThis.__S.tables.notifications.filter((x) => x.member_id !== ME).every((x) => !x.read_at));
  await NOW.act(async () => r.unmount());
}

// ---------------------------------------------------------------- 4. push open
{
  const { host, r } = await mount(NOW);
  const target = globalThis.__S.tables.notifications.find((x) => x.title === "Own unread 60");   // outside the old bell window
  let res;
  await NOW.act(async () => { res = await NOW.markNotificationReadFromPush(target.id); });
  await settle(NOW);
  ok("4. push open → that row read in the DB, returns true", res === true && !!target.read_at);
  ok("4. push open → bell + header drop to 6", bellN(host) === "6" && headerN(host) === "6", `${bellN(host)}/${headerN(host)}`);
  ok("4. push open → the mounted centre reloaded and shows the row read", /· read/.test(rowEl(host, "Own unread 60")?.textContent || ""));
  const calls = globalThis.__S.rpcs.length;
  let bad1, bad2, bad3;
  await NOW.act(async () => { bad1 = await NOW.markNotificationReadFromPush("../notifications"); bad2 = await NOW.markNotificationReadFromPush(null); bad3 = await NOW.markNotificationReadFromPush("1 or 1=1"); });
  ok("4. a non-uuid / empty push id calls nothing and returns false", bad1 === false && bad2 === false && bad3 === false && globalThis.__S.rpcs.length === calls);
  await NOW.act(async () => r.unmount());
}

// ---------------------------------------------------------------- 5. refused tap; failed count
{
  const { host, r } = await mount(NOW, { failRpc: true });
  await click(NOW, rowEl(host, "Own unread 15"));
  ok("5. a refused tap resyncs: the row reads unread again and the count is back to 7 (never a lie)",
    !/· read/.test(rowEl(host, "Own unread 15")?.textContent || "") && bellN(host) === "7" && headerN(host) === "7", `${bellN(host)}/${headerN(host)}`);
  globalThis.__S.failCount = true;
  await NOW.act(async () => { document.dispatchEvent(new win.Event("visibilitychange")); });
  await settle(NOW);
  ok("5. a failed COUNT keeps the last-known number (7), never 0", bellN(host) === "7" && headerN(host) === "7", `${bellN(host)}/${headerN(host)}`);
  await NOW.act(async () => r.unmount());
}

// ---------------------------------------------------------------- 6. department-wide rows; no chevron
{
  const { host, r } = await mount(NOW);
  const calls = globalThis.__S.rpcs.length;
  const deptRow = rowEl(host, "1 maintenance item overdue");
  await click(NOW, deptRow);
  ok("6. a department-wide (other member's) row stays untappable: no RPC, still dim", globalThis.__S.rpcs.length === calls && /opacity: 0.8/.test(deptRow?.getAttribute("style") || ""));
  ok("6. no chevron on any row (a tap goes nowhere, so no arrow)", !host.querySelector(".lucide-chevron-right") && !/ChevronRight/.test(readFileSync(join(root, "src/Notifications.jsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
  await NOW.act(async () => r.unmount());
}

// ---------------------------------------------------------------- 7. App.jsx wiring
{
  const app = readFileSync(join(root, "src/App.jsx"), "utf8");
  ok("7. App.jsx imports markNotificationReadFromPush from ./Notifications", /import NotificationCenter, \{ NotificationBell, markNotificationReadFromPush \} from "\.\/Notifications";/.test(app));
  ok("7. the push handler opens the inbox AND marks the payload's id read", /initPush\(\{ onOpen: \(id\) => \{ go\("notifications"\); markNotificationReadFromPush\(id\); \} \}\)/.test(app));
}

// ---------------------------------------------------------------- 8. fences
// PINNED to the reviewed range BASE..REV (gate PASS @7b609f4, deployed 2026-11-12): "vs the working tree" went stale once
// the next slice (feat/notif-otherdept-db) landed on top.
const REV = "7b609f4";
const sh = (c) => execSync(c, { cwd: root }).toString().trim();
const changed = sh(`git diff --name-only ${BASE} ${REV}`).split("\n").filter(Boolean).sort();
// + maint_renag_test.mjs: its working-tree fence pinned to its released range (328b918..64399b3), fence lines only.
const allowed = ["docs/review/maint_renag_test.mjs", "docs/review/notif_clearing_test.mjs", "docs/review/sidebar_ai_framing_test.mjs", "src/App.jsx", "src/Notifications.jsx"];
ok("8. files changed vs 64399b3 = src/Notifications.jsx, src/App.jsx, this test, the sidebar test's fake, the re-nag test's fence pin", JSON.stringify(changed) === JSON.stringify(allowed), JSON.stringify(changed));
ok("8. no api/, sql/, shared/, vercel.json, ios/, android/, package changes", sh(`git diff --name-only ${BASE} ${REV} -- api sql shared vercel.json ios android package.json package-lock.json`) === "");
const tok = (p) => (execSync(`git show ${REV}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString().match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("8. verified counts: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("8. Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));

// The rendered centre's refresh hook keeps a timer alive in happy-dom; end the run explicitly with the tally's code.
try { await win.happyDOM?.abort?.(); win.close?.(); } catch { /* best effort */ }
process.exit(process.exitCode || 0);
