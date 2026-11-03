// HAPPY_DOM_DIR=<dir with happy-dom installed> node docs/review/pa_geofence_honesty_test.mjs      (REV=<sha> to check a commit)
// No network, no DB. Bundles the REAL src/App.jsx (at REV, else the working tree) with esbuild, supabaseClient swapped for an
// in-memory fake, and checks the PA geofence honesty slice — the PA DepartmentAdmin "Geofencing (paid add-on)" card:
//   1. the North Hood trap is now visible: master ON + the house's own switch OFF renders that house as off (unticked,
//      "Pinned · automatic arrival off", not green); the old "Per-station add-ons" title is gone; the BOTH-switches truth line
//   2. house ON + master OFF: the row stays visible, says "Automatic arrival on · 400 m" but is NOT green, carries
//      "Not live — the department master switch is off.", and the card-level not-live note shows. The note follows the SAVED
//      master, not an unsaved tick; an unreadable master is said as unknown, never green
//   3. a house with no pin: its switch is disabled, with "Needs a location first — a Department Admin sets it in the station editor."
//   4. ticking a house calls pa_set_station_geofence({ p_station_id, p_enabled }) with the right id and value; success (its own id
//      back) says Saved and re-reads the list; a refusal renders as the error, a null / wrong id back as "nothing was written" —
//      never "Saved"; every house switch is disabled while one saves
//   5. the master switch keeps its plumbing: pa_get/set_geofence_enabled, the "Save add-ons" button, relabelled as the master
//   6. the state line is the DA station list's wording: same three strings as before this slice, and the DA list (StationsAdmin)
//      renders the same line for the same row
//   7. fences: only src/App.jsx + the SQL file (+ its RETEST) + the test files; App.jsx changes only inside DepartmentAdmin,
//      the new stationFenceLine helper and the DA list's one state-line block; exactly one new RPC (pa_set_station_geofence);
//      api/ shared/ vercel.json untouched; counts 132/32/14; Notify absent
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { execSync } from "child_process";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "07377ed";                    // live main when this was drafted (industrial-noir-67)
const REV = process.env.REV ?? "";         // "" = the working tree; pinned to the reviewed sha at promote
const show = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString() : readFileSync(join(root, p), "utf8");

const hdReq = createRequire(join(process.env.HAPPY_DOM_DIR || root, "package.json"));
const { Window } = hdReq("happy-dom");
const win = new Window({ url: "https://app.test/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "sessionStorage", "matchMedia"]) {
  try { globalThis[k] = k === "window" ? win : win[k]; } catch { /* read-only in this node */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const origErr = console.error; console.error = (...a) => { if (!String(a[0]).includes("act(")) origErr(...a); };

const MOCKS = {
  supabase: `
    const st = new Proxy({}, { get: (_, k) => globalThis.__sb[k] });
    function q(table) {
      const b = { _t: table };
      for (const m of ["select", "eq", "neq", "in", "is", "order", "maybeSingle", "single", "limit"]) b[m] = () => b;
      b.then = (res, rej) => { st.reads.push(table); return Promise.resolve(st.table(table)).then(res, rej); };
      return b;
    }
    export const supabase = { from: q, rpc: (n, args) => { st.calls.push({ n, args }); return { then: (res, rej) => Promise.resolve(st.answer(n, args)).then(res, rej) }; } };
    export const APP_URL = "https://app.test", APP_ORIGIN = "https://app.test";
    export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;`,
  confirm: `
    export const confirmDestructive = async () => true;
    export const setDeleteGateRole = () => {};
    export const useCanDeleteShared = () => true;
    export const DestructiveConfirmHost = () => null;`,
};
const appSrc = show(REV, "src/App.jsx");
const out = join(mkdtempSync(join(tmpdir(), "b4c-pagf-")), "app.under-test.mjs");
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
    b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({ contents: a.path === "sb" ? MOCKS.supabase : MOCKS.confirm, loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, () => ({ contents: appSrc + `\nexport { DepartmentAdmin, StationsAdmin, stationFenceLine };\nexport { createRoot } from "react-dom/client";\nexport { act } from "react";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") }));
  } }],
});
const { DepartmentAdmin, StationsAdmin, createRoot, act, React } = await import(pathToFileURL(out).href);

// ---- fixtures: North Hood's real shape (one house, pinned, its own switch off) plus an unpinned and an "on" house
const DEPT = { id: "d1", name: "North Hood County" };
const S20 = { station_id: "s20", name: "Station 20", label: null, address: "1 Main St", is_default: true, is_active: true, lat: 32.4, lng: -97.8, radius_m: 400, geofence_enabled: false };
const S21 = { station_id: "s21", name: "Station 21", label: "21", address: null, is_default: false, is_active: true, lat: null, lng: null, radius_m: null, geofence_enabled: false };
const S22 = { station_id: "s22", name: "Station 22", label: null, address: null, is_default: false, is_active: true, lat: 32.5, lng: -97.7, radius_m: null, geofence_enabled: true };
let STATIONS = [], MASTER = true, answers = {};
globalThis.__sb = {
  calls: [], reads: [],
  answer: (n, args) => {
    if (answers[n]) return answers[n](args);
    if (n === "pa_get_disabled_modules") return { data: [], error: null };
    if (n === "pa_department_members") return { data: [], error: null };
    if (n === "pa_get_geofence_enabled") return { data: MASTER, error: null };
    if (n === "pa_department_stations") return { data: STATIONS.map((r) => ({ ...r })), error: null };
    if (n === "my_department_id") return { data: "d1", error: null };
    return { data: null, error: null };
  },
  table: (t) => ({ data: t === "stations" ? STATIONS.map(({ station_id, ...r }) => ({ id: station_id, ...r })) : [], error: null }),
};
const notes = []; const notify = (n) => notes.push(n);
const tick = (n = 3) => act(async () => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); });
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
async function mountPA() {
  globalThis.__sb.calls = []; globalThis.__sb.reads = []; notes.length = 0;
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => { r.render(React.createElement(DepartmentAdmin, { S: {}, role: ["Project Admin"], target: DEPT, notify, go: () => {} })); });
  await tick(5);
  return { host, unmount: () => act(() => r.unmount()) };
}
const card = (host) => [...host.querySelectorAll("[data-geofence-stations]")][0]?.closest("div[style]")?.parentElement?.closest("div");
const rowOf = (host, id) => host.querySelector(`[data-station-fence="${id}"]`);
const lineOf = (host, id) => rowOf(host, id)?.querySelector("[data-fence-line]");
const boxOf = (host, id) => rowOf(host, id)?.querySelector('input[type="checkbox"]');
const masterBox = (host) => [...host.querySelectorAll("label")].find((l) => norm(l.textContent).startsWith("Automatic arrival — department master switch"))?.querySelector("input");
const click = (el) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
const GREEN = (c) => /green/i.test(c) || false;
const colorOf = (el) => el?.style?.color || "";
const themeSrc = show(REV, "src/theme.js");   // FIRE tokens live there
const fireOf = (key) => { const m = themeSrc.match(new RegExp(`\\b${key}:\\s*"([^"]+)"`)); return m ? m[1] : null; };
const greenText = fireOf("greenText"), amberText = fireOf("amberText");
ok("0 theme tokens found (greenText / amberText)", !!greenText && !!amberText, `${greenText} ${amberText}`);
const isGreen = (el) => { const c = colorOf(el); return GREEN(c) || (greenText && c.replace(/\s/g, "").toLowerCase() === greenText.replace(/\s/g, "").toLowerCase()) || c === "var(--green-text)"; };

// ---- 1. the North Hood trap
STATIONS = [S20]; MASTER = true;
{ const { host, unmount } = await mountPA();
  const t = norm(host.textContent);
  ok("1 card titled \"Geofencing (paid add-on)\"; \"Per-station add-ons\" is gone", t.includes("Geofencing (paid add-on)") && !t.includes("Per-station add-ons") && !/title="Per-station add-ons"/.test(appSrc));
  ok("1 the truth line: a fence only where BOTH switches are on", t.includes("Phones build a fence only where BOTH the department master switch and that station’s own switch are on."));
  ok("1 master ON (ticked) and labelled as the department master switch", masterBox(host)?.checked === true && t.includes("Turning this on makes geofencing available to this department. No phone builds a fence until a station's own switch below is also on."));
  ok("1 North Hood trap visible: Station 20 renders OFF (unticked) under a master that is ON", rowOf(host, "s20") && boxOf(host, "s20").checked === false && !boxOf(host, "s20").disabled);
  ok("1 …its line is the DA wording \"Pinned · automatic arrival off\", not green", norm(lineOf(host, "s20")?.textContent) === "Pinned · automatic arrival off" && !isGreen(lineOf(host, "s20")), colorOf(lineOf(host, "s20")));
  ok("1 no not-live note when nothing is on", !host.querySelector("[data-not-live]"));
  await unmount(); }

// ---- 2. house ON + master OFF
STATIONS = [S20, { ...S22, radius_m: 400 }]; MASTER = false;
{ const { host, unmount } = await mountPA();
  const ln = lineOf(host, "s22");
  ok("2 house ON + master OFF: the row stays visible, ticked, \"Automatic arrival on · 400 m\"", rowOf(host, "s22") && boxOf(host, "s22").checked && norm(ln?.textContent) === "Automatic arrival on · 400 m");
  ok("2 …never green (amber)", !isGreen(ln) && (!amberText || colorOf(ln).replace(/\s/g, "").toLowerCase() === amberText.replace(/\s/g, "").toLowerCase()), colorOf(ln));
  ok("2 …and says it is not live", norm(rowOf(host, "s22").textContent).includes("Not live — the department master switch is off."));
  ok("2 card-level note: none of these are live until the master is on", norm(host.querySelector("[data-not-live]")?.textContent).startsWith("The department master switch is off, so none of these are live"));
  // An unsaved tick of the master does not make them live
  await click(masterBox(host)); await tick();
  ok("2 ticking the master WITHOUT saving keeps the not-live truth (it follows the saved value)", masterBox(host).checked === true && !!host.querySelector("[data-not-live]") && !isGreen(lineOf(host, "s22")));
  // Save it: now live -> green, notes gone
  await click([...host.querySelectorAll("button")].find((b) => norm(b.textContent) === "Save add-ons")); await tick();
  const setM = globalThis.__sb.calls.filter((c) => c.n === "pa_set_geofence_enabled").at(-1);
  ok("5 master saves through pa_set_geofence_enabled (unchanged plumbing), \"Save add-ons\" button", setM && setM.args.p_department_id === "d1" && setM.args.p_enabled === true);
  ok("2 once the master is SAVED on, the ON house is green and the not-live notes go", isGreen(lineOf(host, "s22")) && !host.querySelector("[data-not-live]") && !norm(rowOf(host, "s22").textContent).includes("Not live"), colorOf(lineOf(host, "s22")));
  await unmount(); }
// master unreadable
answers.pa_get_geofence_enabled = () => ({ data: null, error: { message: "network" } });
STATIONS = [{ ...S22, radius_m: 400 }];
{ const { host, unmount } = await mountPA();
  ok("2 master unreadable: said as unknown; an ON house is not shown green", norm(host.textContent).includes("The master switch couldn’t be read, so whether these are live is unknown.") && !isGreen(lineOf(host, "s22")));
  await unmount(); }
delete answers.pa_get_geofence_enabled;

// ---- 3. no pin
STATIONS = [S20, S21]; MASTER = true;
{ const { host, unmount } = await mountPA();
  ok("3 a house with no pin: its switch is disabled", boxOf(host, "s21")?.disabled === true && boxOf(host, "s20")?.disabled === false);
  ok("3 …with the DA-editor pointer, and the DA no-pin line", norm(rowOf(host, "s21").textContent).includes("Needs a location first — a Department Admin sets it in the station editor.") && norm(lineOf(host, "s21")?.textContent) === "Not pinned — no automatic arrival");
  await unmount(); }

// ---- 4. the toggle
STATIONS = [S20, S21]; MASTER = true;
{ const { host, unmount } = await mountPA();
  answers.pa_set_station_geofence = (a) => { STATIONS = STATIONS.map((r) => r.station_id === a.p_station_id ? { ...r, geofence_enabled: a.p_enabled } : r); return { data: a.p_station_id, error: null }; };
  const readsBefore = globalThis.__sb.calls.filter((c) => c.n === "pa_department_stations").length;
  await click(boxOf(host, "s20")); await tick(5);
  const c1 = globalThis.__sb.calls.filter((c) => c.n === "pa_set_station_geofence").at(-1);
  ok("4 ticking Station 20 -> pa_set_station_geofence({ p_station_id: \"s20\", p_enabled: true })", c1 && c1.args.p_station_id === "s20" && c1.args.p_enabled === true && Object.keys(c1.args).length === 2, JSON.stringify(c1?.args));
  ok("4 success (its own id back): \"Saved\", the row reads ON, and the list is re-read", norm(rowOf(host, "s20").textContent).includes("Saved — this house's switch is on.") && boxOf(host, "s20").checked && norm(lineOf(host, "s20").textContent) === "Automatic arrival on · 400 m"
    && globalThis.__sb.calls.filter((c) => c.n === "pa_department_stations").length > readsBefore);
  ok("4 the master was not written by a house toggle", !globalThis.__sb.calls.some((c) => c.n === "pa_set_geofence_enabled"));
  await click(boxOf(host, "s20")); await tick(5);
  const c2 = globalThis.__sb.calls.filter((c) => c.n === "pa_set_station_geofence").at(-1);
  ok("4 unticking -> p_enabled: false", c2 && c2.args.p_station_id === "s20" && c2.args.p_enabled === false && norm(rowOf(host, "s20").textContent).includes("Saved — this house's switch is off."));
  // refusal
  answers.pa_set_station_geofence = () => ({ data: null, error: { message: "Not authorized" } });
  await click(boxOf(host, "s20")); await tick(5);
  const rt = norm(rowOf(host, "s20").textContent);
  ok("4 a refusal renders as the error, not \"Saved\"; the switch stays off", rt.includes("Couldn't save: Not authorized") && !rt.includes("Saved") && boxOf(host, "s20").checked === false && rowOf(host, "s20").querySelector('[role="alert"]'));
  // 0-row / null answer
  answers.pa_set_station_geofence = () => ({ data: null, error: null });
  await click(boxOf(host, "s20")); await tick(5);
  ok("4 a null answer (nothing written) is an error, never \"Saved\"", norm(rowOf(host, "s20").textContent).includes("nothing was written") && !norm(rowOf(host, "s20").textContent).includes("Saved") && boxOf(host, "s20").checked === false);
  answers.pa_set_station_geofence = () => ({ data: "some-other-id", error: null });
  await click(boxOf(host, "s20")); await tick(5);
  ok("4 a different id back is also \"nothing was written\"", norm(rowOf(host, "s20").textContent).includes("nothing was written") && boxOf(host, "s20").checked === false);
  // busy: a pending save disables every house switch
  let release; answers.pa_set_station_geofence = (a) => new Promise((res) => { release = () => res({ data: a.p_station_id, error: null }); });
  await click(boxOf(host, "s20")); await tick(2);
  ok("4 while a house saves, every house switch is disabled", boxOf(host, "s20").disabled === true && boxOf(host, "s21").disabled === true);
  release(); await tick(5);
  ok("4 …and re-enabled after (the pinned one)", boxOf(host, "s20").disabled === false && boxOf(host, "s21").disabled === true);
  delete answers.pa_set_station_geofence;
  await unmount(); }

// ---- 6. wording = the DA list's
const baseSrc = show(BASE, "src/App.jsx");
ok("6 the three state strings are the DA list's own, as they read before this slice", ["\"Not pinned — no automatic arrival\"", "`Automatic arrival on · ${r.radius_m || 150} m`", "\"Pinned · automatic arrival off\""].every((s) => baseSrc.includes(s) && appSrc.includes(s)));
STATIONS = [S20, S21, S22]; MASTER = true;
{ const pa = await mountPA();
  const paLines = ["s20", "s21", "s22"].map((id) => norm(lineOf(pa.host, id)?.textContent));
  await pa.unmount();
  document.body.innerHTML = ""; const host = document.createElement("div"); document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => { r.render(React.createElement(StationsAdmin, { S: {}, setDept: () => {} })); });
  await tick(6);
  const t = norm(host.textContent);
  ok("6 the DA list (StationsAdmin) renders the same line for each same row", paLines.every((l) => l && t.includes(l)) && paLines.join("|") === "Pinned · automatic arrival off|Not pinned — no automatic arrival|Automatic arrival on · 150 m", paLines.join("|"));
  await act(() => r.unmount()); }

// ---- 7. fences
const block = (s, sig) => { const i = s.indexOf(sig); if (i < 0) return ""; return s.slice(i, s.indexOf("\n}\n", i) + 3); };
const DA_LINE_BASE = baseSrc.slice(baseSrc.indexOf("                <div style={{ fontSize: 12, marginTop: 2, color: r.lat == null || r.lng == null"), baseSrc.indexOf("</div>", baseSrc.indexOf("\"Pinned · automatic arrival off\")}")) + 6);
const DA_LINE_REV = appSrc.slice(appSrc.indexOf("                <div style={{ fontSize: 12, marginTop: 2, color: { nopin:"), appSrc.indexOf("{stationFenceLine(r).text}") + "{stationFenceLine(r).text}\n                </div>".length);
const helper = (s) => { const i = s.indexOf("/* ONE HOUSE'S AUTOMATIC-ARRIVAL STATE"); return i < 0 ? "" : s.slice(i, s.indexOf("function StationsAdmin(", i)); };
const outside = (s, daLine) => s.replace(block(s, "function DepartmentAdmin("), "").replace(helper(s), "").replace(daLine, "");
ok("7 App.jsx changes only inside DepartmentAdmin, the stationFenceLine helper and the DA list's state-line block", DA_LINE_BASE.length > 100 && DA_LINE_REV.length > 50 && helper(appSrc).length > 100
  && outside(appSrc, DA_LINE_REV) === outside(baseSrc, DA_LINE_BASE));
const rpcs = (s) => [...new Set(s.match(/supabase\.rpc\("[a-z_]+"/g) || [])].sort();
const added = rpcs(appSrc).filter((x) => !rpcs(baseSrc).includes(x)), dropped = rpcs(baseSrc).filter((x) => !rpcs(appSrc).includes(x));
ok("7 exactly one new RPC (pa_set_station_geofence), none dropped", JSON.stringify(added) === '["supabase.rpc(\\"pa_set_station_geofence\\""]' && dropped.length === 0, JSON.stringify({ added, dropped }));
ok("7 the master plumbing lines are unchanged", ["supabase.rpc(\"pa_get_geofence_enabled\", { p_department_id: deptId })", "supabase.rpc(\"pa_set_geofence_enabled\", { p_department_id: deptId, p_enabled: !!geofenceOn })"].every((l) => appSrc.includes(l) && baseSrc.includes(l)));
const changed = execSync(`git diff --name-only ${REV ? `${BASE} ${REV}` : BASE}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const ALLOWED = ["src/App.jsx", "sql/pa_station_geofence_honesty.sql", "sql/pa_station_geofence_honesty_RETEST.sql",
  "docs/review/pa_geofence_honesty_test.mjs", "docs/review/pa_station_geofence_dryrun_harness.mjs", "docs/review/pa_station_geofence_DRYRUN.txt"];
const touched = [...new Set([...changed, ...untracked])];
ok("7 fence: only the slice's files", touched.every((f) => ALLOWED.includes(f)) && touched.includes("src/App.jsx") && touched.includes("sql/pa_station_geofence_honesty.sql"), touched.filter((f) => !ALLOWED.includes(f)).join(","));
ok("7 fence: api/, shared/, vercel.json, native untouched", !touched.some((f) => /^(api|shared|ios|android)\//.test(f) || f === "vercel.json" || f.startsWith("capacitor")));
const tok = (p) => (show(REV, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("7 counts: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14, `${tok("src/App.jsx")}/${tok("api/digest.js")}/${tok("api/assistant.js")}`);
ok("7 Notify held: api/notify-session.js absent", REV ? !execSync(`git ls-tree --name-only ${REV} api/`, { cwd: root }).toString().includes("notify-session.js") : !existsSync(join(root, "api/notify-session.js")));
console.error = origErr;
await win.happyDOM?.abort?.();
process.exit(process.exitCode || 0);
