// node docs/review/onboarding_card_veterans_test.mjs
// No network, no DB. HOTFIX — veterans' dashboards claimed "Your onboarding / Not cleared to run". The REAL
// OnboardingCardPath source is lifted out of src/App.jsx — the fix (REV) and main's (BASE 63adbb1) — JSX-compiled with
// esbuild, and run against the same my_probation_status fixtures (useProbationStatus stubbed). Checks:
//   (a) Probationary → the card shows regardless (nothing ticked, no start date)
//   (b) THE BUG: an Active veteran — no probation start, no manual ticks, only AUTO items satisfied (ack / hours / cert,
//       incl. an ack whose audience excludes them) → main renders "2 of 43 complete"; the fix renders NOTHING
//   (c) an Active member promoted mid-checklist — officer-signed manual ticks + open items → still shows; likewise a
//       probation start date alone, an assigned mentor alone, a legacy kind-less tick
//   plus unchanged: finished checklist → hidden; never onboarded → hidden; the progress math still counts auto items
//   fences: only src/App.jsx (+ this test) changed, the one hunk sits inside OnboardingCardPath, OnboardingCardPlain
//   byte-identical, no SQL / api / native, verified 132/32/14, Notify held
import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { transformSync } from "esbuild";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "63adbb1";   // live main when this was drafted (industrial-noir-53)
// Structural fences PINNED to the reviewed range: base 63adbb1 .. reviewed 5688e43 — "vs the working tree" would go red once
// later work lands. REV=<sha> (or REV="" for the working tree) overrides. The component checks run on REV's source.
const REV = process.env.REV ?? "5688e43";
const src = (rev, p) => rev ? execSync(`git show ${rev}:${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString()
  : execSync(`cat ${p}`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const fnSrc = (text, name) => { const i = text.indexOf(`function ${name}(`); if (i < 0) return null; return text.slice(i, text.indexOf("\n}\n", i) + 2); };

// ---------------------------------------------------------------- the component, compiled against stubs
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
const Frag = (p) => p;
const named = (n) => Object.assign((p) => p, { displayName: n });
const STUBS = {
  React: { useContext: () => true },   // NoirCtx → noir dashboards (CardHead header)
  NoirCtx: {}, moduleEnabled: () => true, h, Frag,
  Card: named("Card"), CardHead: named("CardHead"), SectionLabel: named("SectionLabel"), ProgressBar: named("ProgressBar"),
  UserPlus: named("UserPlus"), CheckCircle2: named("CheckCircle2"), Lock: named("Lock"), ChevronRight: named("ChevronRight"),
  FIRE: new Proxy({}, { get: () => "#000" }), FS: { btn: {}, num: {} },
};
function load(rev) {
  const code = transformSync(fnSrc(src(rev, "src/App.jsx"), "OnboardingCardPath"), { loader: "jsx", jsxFactory: "h", jsxFragment: "Frag" }).code;
  return (st) => new Function(...Object.keys(STUBS), "useProbationStatus", `${code}\nreturn OnboardingCardPath;`)(
    ...Object.values(STUBS), () => ({ st, err: null, reload() {} }))({ S: {}, me: { id: "m1", status: st.status }, go() {}, dept: {} });
}
const text = (n) => n == null || typeof n === "boolean" ? "" : typeof n !== "object" ? String(n) : [n.props?.title || "", ...(n.children || []).map(text)].join("");
const fixed = load(REV), main = load(BASE);

// ---------------------------------------------------------------- my_probation_status fixtures
const auto = [
  { item_id: "a1", label: "SOPs signed", kind: "ack", satisfied: true },            // signed doc on record
  { item_id: "a2", label: "Board policy (Probationary only)", kind: "ack", satisfied: true },   // audience excludes them → reads satisfied
];
const openManual = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ item_id: `o${from + i}`, label: `Open item ${from + i}`, kind: "manual", satisfied: false, clears_to_run: i < 3 }));
const gate = { configured: true, required: 5, satisfied: 0 };
const st = (o) => ({ status: "Active", started_on: null, cleared_to_run: false, gate, items: [], ...o });

// (a) Probationary
{ const s = st({ status: "Probationary", items: openManual(10) });
  const r = fixed(s);
  ok("(a) Probationary, nothing ticked, no start date → card SHOWS (\"Your path to active\")", r != null && /Your path to active/.test(text(r)), text(r).slice(0, 80)); }
{ const s = st({ status: "Probationary", items: [...auto, ...openManual(5)] });
  ok("(a) Probationary with only auto items done → shows", fixed(s) != null); }

// (b) the veteran — Scott's "2 of 43"
{ const s = st({ items: [...auto, ...openManual(41)] });
  const before = main(s), after = fixed(s);
  ok("(b) BUG REPRODUCED on main: Active veteran with only auto items satisfied → main renders \"Your onboarding · 2 of 43 complete · Not cleared to run\"",
    before != null && /Your onboarding/.test(text(before)) && /2 of 43 complete/.test(text(before)) && /Not cleared to run/.test(text(before)));
  ok("(b) THE FIX: same veteran → card GONE", after === null); }
{ const s = st({ items: [{ item_id: "h", label: "Hours", kind: "hours", satisfied: true }, { item_id: "c", label: "CPR", kind: "cert", satisfied: true }, ...openManual(4)] });
  ok("(b) hours + cert kinds satisfied alone → GONE (main showed it)", fixed(s) === null && main(s) != null); }

// (c) promoted mid-checklist — human acts
{ const s = st({ items: [...auto, { item_id: "m1", label: "Radio check-off", kind: "manual", satisfied: true }, { item_id: "m2", label: "Station tour", kind: "manual", satisfied: true }, ...openManual(6)] });
  const r = fixed(s);
  ok("(c) officer-signed manual ticks + open items → card STILL SHOWS (\"Your onboarding · 4 of 10 complete\")", r != null && /Your onboarding/.test(text(r)) && /4 of 10 complete/.test(text(r)), text(r).slice(0, 90)); }
{ const s = st({ started_on: "2026-09-01", items: [...auto, ...openManual(6)] });
  ok("(c) a probation start date alone (no ticks) → shows", fixed(s) != null); }
{ const s = st({ items: [{ item_id: "mt", label: "Mentor assigned", kind: "manual", satisfied: true }, ...openManual(3)] });
  ok("(c) an assigned mentor alone (kind manual, is_mentor → satisfied) → shows", fixed(s) != null); }
{ const s = st({ items: [{ item_id: "lg", label: "Legacy tick", satisfied: true }, ...openManual(3)] });
  ok("(c) a legacy kind-less tick → counts as human → shows", fixed(s) != null); }

// unchanged edges
{ const s = st({ items: [...auto, { item_id: "m1", label: "x", kind: "manual", satisfied: true }] });
  ok("unchanged: Active, every item satisfied → hidden (fix and main)", fixed(s) === null && main(s) === null); }
{ const s = st({ items: openManual(5) });
  ok("unchanged: Active, never onboarded (nothing satisfied) → hidden (fix and main)", fixed(s) === null && main(s) === null); }
{ const s = st({ items: [] });
  ok("unchanged: no checklist → hidden", fixed(s) === null); }
{ const s = st({ items: [...auto, { item_id: "m1", label: "x", kind: "manual", satisfied: true }, ...openManual(1)] });
  ok("progress math unchanged: auto items still count toward done (3 of 4, 75%) — identical text to main", /3 of 4 complete/.test(text(fixed(s))) && /75%/.test(text(fixed(s))) && text(fixed(s)) === text(main(s))); }

// ---------------------------------------------------------------- fences
const diffArgs = REV ? `${BASE} ${REV}` : BASE;
const changed = execSync(`git diff --name-only ${diffArgs}`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
const untracked = REV ? [] : execSync("git ls-files --others --exclude-standard", { cwd: root }).toString().trim().split("\n").filter(Boolean);
const all = [...new Set([...changed, ...untracked])].filter((f) => f !== ".env" && f !== "node_modules").sort();
const allowed = ["docs/review/onboarding_card_veterans_test.mjs", "src/App.jsx"];
ok("changed: only src/App.jsx (+ this test)", all.every((f) => allowed.includes(f)) && all.includes("src/App.jsx"), JSON.stringify(all));
const appDiff = execSync(`git diff -U0 ${diffArgs} -- src/App.jsx`, { cwd: root }).toString();
const hunks = [...appDiff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)/gm)];
const baseApp = src(BASE, "src/App.jsx"), start = baseApp.slice(0, baseApp.indexOf("function OnboardingCardPath(")).split("\n").length;
const end = start + fnSrc(baseApp, "OnboardingCardPath").split("\n").length;
const minus = appDiff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")), plus = appDiff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
ok("App.jsx: ONE hunk, inside OnboardingCardPath — the show rule line out, the humanStarted rule (+ its comment) in",
  hunks.length === 1 && +hunks[0][1] > start && +hunks[0][1] < end && minus.length === 1 && /done === 0/.test(minus[0])
  && plus.length === 4 && plus.some((l) => /const humanStarted = !!st\.started_on/.test(l)) && plus.some((l) => /!humanStarted\)\) return null/.test(l)), `hunks=${hunks.length} -${minus.length} +${plus.length}`);
ok("OnboardingCardPlain byte-identical", fnSrc(src(REV, "src/App.jsx"), "OnboardingCardPlain") === fnSrc(baseApp, "OnboardingCardPlain") && fnSrc(baseApp, "OnboardingCardPlain") != null);
const untouched = (p) => execSync(`git diff --name-only ${diffArgs} -- ${p}`, { cwd: root }).toString().trim() === "";
ok("no SQL, no api/, no shared/, no native (ios/android/capacitor.config)", ["sql", "api", "shared", "ios", "android", "capacitor.config.json", "vercel.json"].every(untouched));
const tok = (rev, p) => (src(rev, p).match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok(REV, "src/App.jsx") === 132 && tok(REV, "api/digest.js") === 32 && tok(REV, "api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
