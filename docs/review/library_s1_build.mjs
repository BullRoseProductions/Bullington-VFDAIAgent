// node docs/review/library_s1_build.mjs
// Builds sql/library_s1_catalog_DRAFT.sql from docs/review/library_s1_template.sql + the 6 SEED packets in src/App.jsx
// (evaluated verbatim — no hand-copied content) + the live pins in docs/review/library_s1_LIVEDEFS.json.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const app = readFileSync(join(root, "src/App.jsx"), "utf8");
const start = app.indexOf("const SEED = [");
const end = app.indexOf("\n];", start);
if (start < 0 || end < 0) throw new Error("SEED not found");
const SEED = new Function(`return ${app.slice(start + "const SEED = ".length, end + 2)}`)();
if (SEED.length !== 6) throw new Error(`expected 6 SEED packets, got ${SEED.length}`);

const strList = (a) => (Array.isArray(a) ? a.filter((x) => x != null && String(x).trim() !== "").map(String) : []);
const toContent = (p) => ({                        // D1 — the drill_plans shape + the packet-only keys
  summary: p.objective || "",
  objectives: strList(p.evaluation),
  run_of_show: (p.steps || []).map((s) => ({ t: `${s.t}${s.m ? ` — ${s.m} min` : ""}`, d: s.d || "" })),
  materials: strList(p.equipment),
  safety: strList(p.safety),
  instructor_guide: p.instructorGuide || "",
  scenario: p.scenario || "",
  discussion: strList(p.discussion),
  debrief: strList(p.debrief),
  evaluation: strList(p.evaluation),
  revised: p.updated || "",
});
const lit = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const rows = SEED.map((p) => {
  const json = JSON.stringify(toContent(p));
  if (json.includes("$seed$")) throw new Error("dollar-quote collision");
  const mins = parseInt(String(p.time), 10) || null;
  return `  INSERT INTO public.library_drills (code, title, track, level, duration_min, audience, content, origin, state, published_at)\n` +
         `  VALUES (${lit(p.code)}, ${lit(p.title)}, ${lit(p.track)}, ${lit(p.level)}, ${mins ?? "NULL"}, NULL, $seed$${json}$seed$::jsonb, 'seed', 'published', now());`;
});

const L = JSON.parse(readFileSync(join(root, "docs/review/library_s1_LIVEDEFS.json"), "utf8"));
const pins = Object.entries(L.defs).sort(([a], [b]) => a.localeCompare(b))
  .map(([sig, d]) => `    'public.${sig}', '${d.md5}'`).join(",\n");

let sql = readFileSync(join(root, "docs/review/library_s1_template.sql"), "utf8")
  .replace("/*@PINS@*/", pins)
  .replace("/*@SEED@*/", rows.join("\n"))
  .replaceAll("/*@SEED_COUNT@*/", String(SEED.length));
if (sql.includes("/*@")) throw new Error("unfilled placeholder");
writeFileSync(join(root, "sql/library_s1_catalog_DRAFT.sql"), sql);
console.log(`ok — ${SEED.length} seed packets (${SEED.map((p) => p.code).join(", ")}); ${Object.keys(L.defs).length} pins; ${sql.length} chars`);
