// node docs/review/scorecard_ui_test.mjs — reproducible from a clean checkout after `npm i` (no network, no DB).
// Bundles the REAL src/App.jsx with esbuild (a dev dependency via vite), exposing only the readiness pieces under test,
// then: 1. the verdict wording (rdVerdict) — honest-empty, "Ready, renewals due", never "Ready" on an unknown state;
// 2. the rendered scorecard (RdScorecard, server-rendered) — expiring items in the renewals strip, NOT in Outstanding;
//    certs shown but not counted; activity = station hours / trainings / drives, no calls tile;
// 3. the printable packet (rdPacketBlocks) — standard, verdicts, rollups, honest when the standard isn't set;
// 4. the department list order (rdSortMembers).
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { build } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };

// ---- a browser just big enough for App.jsx's module scope to load under node ----
const noop = () => {};
const el = () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop }, sheet: { insertRule: noop } });
globalThis.window = { location: { origin: "https://app.test", href: "https://app.test/", search: "", hash: "", pathname: "/" }, addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }), navigator: { userAgent: "node" }, innerWidth: 1200, innerHeight: 800, setTimeout, clearTimeout };
globalThis.document = { addEventListener: noop, removeEventListener: noop, createElement: el, createTextNode: () => ({}), head: el(), body: el(), documentElement: el(), visibilityState: "visible", querySelector: () => null, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop }; globalThis.sessionStorage = globalThis.localStorage;

const root = fileURLToPath(new URL("../../", import.meta.url));
const APP = join(root, "src/App.jsx");
const EXPOSE = ["RdScorecard", "rdVerdict", "rdPacketBlocks", "rdSortMembers"];
const out = join(mkdtempSync(join(tmpdir(), "b4c-scorecard-")), "app.under-test.mjs");
await build({
  entryPoints: [APP], bundle: true, format: "esm", platform: "node", outfile: out, jsx: "automatic", logLevel: "silent",
  banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },   // node built-ins the renderer require()s
  loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".css": "empty" },
  define: { "import.meta.env": JSON.stringify({ VITE_SUPABASE_URL: "https://x.test", VITE_SUPABASE_ANON_KEY: "x", MODE: "test", DEV: false, PROD: true }) },
  plugins: [{ name: "expose", setup(b) {
    // Vite asset imports ("…?url", "…?raw") have no meaning here — each becomes an empty string.
    b.onResolve({ filter: /\?(url|raw)$/ }, (a) => ({ path: a.path, namespace: "vite-asset" }));
    b.onLoad({ filter: /.*/, namespace: "vite-asset" }, () => ({ contents: 'export default "";', loader: "js" }));
    b.onLoad({ filter: /src[\\/]App\.jsx$/ }, async (a) => {
      const { readFileSync } = await import("fs");
      return { contents: readFileSync(a.path, "utf8") + `\nexport { ${EXPOSE.join(", ")} };\nexport { renderToStaticMarkup } from "react-dom/server";\nexport { default as React } from "react";\n`, loader: "jsx", resolveDir: join(root, "src") };
    });
  } }],
});
// React + the renderer come from the SAME bundle as the components (two copies of React = an invalid hook call)
const { RdScorecard, rdVerdict, rdPacketBlocks, rdSortMembers, renderToStaticMarkup, React } = await import(pathToFileURL(out).href);

// ---- fixtures, shaped like readiness_verdict() ----
const plus = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const it = (o) => ({ requirement_id: o.id, kind: o.kind, ref_id: null, label: o.label, satisfied: o.sat, status: o.status, expires_on: o.exp ?? null });
const ready_due = { member_id: "m1", name: "Dana Kerr", status: "Active", state: "ready", required: 3, satisfied: 3,
  items: [it({ id: "r1", kind: "qualification_type", label: "Engine 1 driver", sat: true, status: "qualified" }),
          it({ id: "r2", kind: "credential_license", label: "Driver's license", sat: true, status: "expiring", exp: plus(40) }),
          it({ id: "r3", kind: "document", label: "SOGs", sat: true, status: "signed" })],
  outstanding: [], renewals_due: [{ label: "Driver's license", expires_on: plus(40) }],
  certs: [{ label: "EMT-Basic", expires_on: plus(300), status: "current" }, { label: "IS-100", expires_on: null, status: "no_date" }],
  activity: { window: "last 12 months", station_hours: 41.25, trainings: 28, drives: 12 } };
const not_ready = { member_id: "m2", name: "Ari Lane", status: "Probationary", state: "not_ready", required: 3, satisfied: 1,
  items: [it({ id: "r1", kind: "qualification_type", label: "Engine 1 driver", sat: false, status: "in_progress" }),
          it({ id: "r2", kind: "credential_license", label: "Driver's license", sat: false, status: "expired", exp: plus(-9) }),
          it({ id: "r3", kind: "document", label: "SOGs", sat: true, status: "signed" })],
  outstanding: ["Engine 1 driver — in progress", "Driver's license — expired"], renewals_due: [], certs: [],
  activity: { window: "last 12 months", station_hours: 0, trainings: 2, drives: 0 } };
const ready = { ...ready_due, member_id: "m3", name: "Bo Cruz", renewals_due: [], items: ready_due.items.map((x) => (x.status === "expiring" ? { ...x, status: "current", expires_on: plus(400) } : x)) };
const not_set = { member_id: "m4", name: "Cy Moe", status: "Active", state: "not_set", required: 0, satisfied: 0, items: [], outstanding: [], renewals_due: [], certs: [], activity: { station_hours: 3, trainings: 1, drives: 0 } };

// 1. verdict wording
ok("no standard reads 'Readiness standard not set' — neither ready nor not ready", rdVerdict(not_set).title === "Readiness standard not set" && rdVerdict(not_set).tone === "muted");
ok("ready + an expiring credential reads 'Ready, renewals due' (green)", rdVerdict(ready_due).title === "Ready, renewals due" && rdVerdict(ready_due).tone === "good");
ok("ready with nothing due reads 'Ready to respond'", rdVerdict(ready).title === "Ready to respond");
ok("not ready names the count", rdVerdict(not_ready).title === "Not ready" && /1 of 3 required items met · 2 outstanding/.test(rdVerdict(not_ready).text));
ok("an unknown / missing state is never 'Ready'", !/ready/i.test(rdVerdict({ state: "bogus" }).short) && !/^Ready/.test(rdVerdict(null).title));

// 2. the rendered scorecard
const html = (sc) => renderToStaticMarkup(React.createElement(RdScorecard, { sc, self: false }));
const h1 = html(ready_due);
// the markup between one section label and the next one (end), so an assertion sees only that section
const section = (h, label, end) => { const i = h.indexOf(label); if (i < 0) return ""; const j = h.indexOf(end, i + label.length); return h.slice(i, j < 0 ? undefined : j); };
ok("ready + due: a 'Renewals due · 1' strip, and NO Outstanding section", h1.includes("Renewals due · 1") && !h1.includes("Outstanding"));
ok("the renewals strip names the item and its date", /Driver&#x27;s license[\s\S]*Renew by/.test(section(h1, "Renewals due", "Required qualifications")));
ok("certs are shown and marked as not counting", h1.includes("Certifications · 2") && h1.includes("don&#x27;t count toward the readiness verdict") && h1.includes("IS-100"));
ok("activity tiles: Station hours / Trainings / Drives — no calls tile", h1.includes("Station hours") && h1.includes("Trainings") && h1.includes(">Drives<") && !/calls/i.test(h1));
// Re-baselined in WS-4d (F-3 / F3-b): station_hours IS the credited figure now, and the label says so.
ok("station hours are labelled as CREDITED (location-confirmed + officer-attested), not 'logged shifts'", /credited station hours \(location-confirmed \+ officer-attested\), last 12 months/.test(h1) && !/not ISO-credited/.test(h1));
const h2 = html(not_ready);
const outSec = section(h2, "Outstanding · 2", "Required qualifications");
ok("not ready: Outstanding lists the two unmet items, not the met one", outSec.includes("Engine 1 driver") && outSec.includes("Expired") && !outSec.includes("SOGs"));
ok("not ready: no renewals strip", !h2.includes("Renewals due"));
const h3 = html(not_set);
ok("no standard: honest card, no score, no Outstanding", h3.includes("Readiness standard not set") && h3.includes("No required items yet") && !h3.includes("Outstanding") && !/\d+\/\d+<\/span>/.test(h3));
ok("no 5+ digit run in any rendered scorecard (no numbers leak)", ![h1, h2, h3].some((h) => />[^<]*\d{5,}[^<]*</.test(h)));

// 3. the packet
const pk = { department: "Test VFD", standard_set: true,
  requirements: [{ kind: "qualification_type", label: "Engine 1 driver" }, { kind: "credential_license", label: "Driver's license" }, { kind: "document", label: "SOGs" }],
  members: [ready_due, not_ready], readiness: { counted: 2, ready: 1, not_ready: 1, not_set: 0 },
  qualifications: [{ name: "Engine 1 driver", qualified: 1, in_progress: 1, not_started: 0 }],
  expirations: { expired: 1, no_date: 1, expiring: 1, current: 1 },
  acknowledgments: [{ title: "SOGs", version: 3, current: 2, audience: 2, outstanding: 0 }, { title: "Officer SOP", version: 1, current: 0, audience: 0, outstanding: 0 }] };
const b = rdPacketBlocks(pk);
const heads = b.filter((x) => x.type === "h2").map((x) => x.text);
ok("packet sections in order", heads.join(" | ") === "Readiness standard | Summary | Member readiness | Activity — last 12 months | Qualifications | Expirations | Acknowledgments", heads.join(" | "));
const mt = b.find((x) => x.type === "table" && x.head[0] === "Member" && x.head.includes("Readiness"));
const r1 = mt.rows.find((r) => r.cells[0] === "Dana Kerr").cells, r2 = mt.rows.find((r) => r.cells[0] === "Ari Lane").cells;
ok("packet: ready + due member reads 'Ready, renewals due', renewal in its own column, Outstanding empty", r1[2] === "Ready, renewals due" && r1[4] === "—" && /Driver's license \(by /.test(r1[5]));
ok("packet: not ready member lists the outstanding items", r2[2] === "Not ready" && r2[3] === "1/3" && /in progress/.test(r2[4]) && r2[5] === "—");
ok("packet: no table row is muted (the print shell would stamp '(inactive)')", b.filter((x) => x.type === "table").every((t) => t.rows.every((r) => !r.muted)));
ok("packet: an audience-0 document reads 'Not applicable', not 0 of 0", b.find((x) => x.type === "table" && x.head[0] === "Document").rows[1].cells[2] === "Not applicable");
ok("packet: the standard is listed with each kind", b.find((x) => x.type === "list").items.join(" / ") === "Engine 1 driver (qualification) / Driver's license (credential) / SOGs (acknowledgment)");
ok("packet: no calls, and the hours line names credited hours (WS-4d)", !JSON.stringify(b).match(/calls/i) && JSON.stringify(b).includes("credited station hours (location-confirmed + officer-attested), last 12 months") && !JSON.stringify(b).includes("not ISO-credited"));
const bNS = rdPacketBlocks({ ...pk, standard_set: false, requirements: [], members: [not_set], readiness: { counted: 1, ready: 0, not_ready: 0, not_set: 1 } });
ok("packet with no standard: says so, prints no Ready / Not ready counts, member reads 'Standard not set'", JSON.stringify(bNS).includes("Readiness standard not set.") && !JSON.stringify(bNS).includes("**Ready:**")
  && bNS.find((x) => x.type === "table" && x.head.includes("Readiness")).rows[0].cells[2] === "Standard not set");

// 4. list order
ok("department list: not ready, then ready with renewals, then ready", rdSortMembers([ready, ready_due, not_ready]).map((m) => m.name).join(",") === "Ari Lane,Dana Kerr,Bo Cruz");
// App.jsx starts module-level timers (auth refresh, reconnect) that would keep node alive — exit with the verdict.
process.exit(process.exitCode ?? 0);
