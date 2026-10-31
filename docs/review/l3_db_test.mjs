// PGLITE_DIR=<dir with @electric-sql/pglite> node docs/review/l3_db_test.mjs
// No network, no live DB. L-3 (drop the dead tables, DB draft). Checks:
//   1. the backup + DRAFT + RETEST + ROLLBACK + the change list REGENERATE byte-identical from the live captures (docs/review/l3_build.mjs --check)
//   2. the PGlite dry run passes end to end (docs/review/l3_dryrun_harness.mjs: the backup reproduces live's content md5, pins
//      reproduce, apply, re-run refuses, RETEST 3/0/0, rollback round trip, the standalone backup, 13 drift refusals, 9 mutations)
//   3. the STOP rule still holds in the capture: zero references of every kind; both tables unreachable
//   4. fences: no client / api / shared / vercel.json change vs the base; verified 132/32/14; Notify held
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "09f7755";   // live main when L-3 was drafted (industrial-noir-51)
const gen = spawnSync("node", [join(root, "docs/review/l3_build.mjs"), "--check"], { encoding: "utf8" });
ok("the backup + DRAFT + RETEST + ROLLBACK + the change list regenerate byte-identical from the live captures", gen.status === 0 && (gen.stdout.match(/^same /gm) || []).length === 5, gen.stdout.split("\n").filter((l) => !l.startsWith("same")).join(" "));
const dry = spawnSync("node", [join(root, "docs/review/l3_dryrun_harness.mjs")], { encoding: "utf8", env: process.env });
const m = /(\d+) passed, (\d+) failed\s*$/.exec(dry.stdout.trim());
ok("PGlite dry run: every check passes (backup = live content · pins · apply · RETEST 3/0/0 · rollback · 13 drift refusals · 9 mutations)", dry.status === 0 && m && +m[2] === 0 && +m[1] >= 36, m ? `${m[1]} passed, ${m[2]} failed` : (dry.stderr || "").slice(0, 200));
const S0 = JSON.parse(readFileSync(join(root, "docs/review/l3_STEP0_LIVE.json"), "utf8"));
ok("STOP rule: zero references in the Step 0 capture (functions any schema, policies, views, triggers, rules, cron)",
  ["ref_functions", "ref_policies", "ref_views", "ref_triggers_anywhere", "ref_rules", "ref_cron"].every((k) => S0[k] == null));
ok("both tables unreachable from the API today (RLS on, no policy; anon no grant)", ["profiles", "_d2a_resync_backup"].every((t) => S0.tables[t].rls && S0.tables[t].policies == null && !S0.tables[t].reachable.anon.SELECT));
const changed = execSync(`git diff --name-only ${BASE} -- src api shared vercel.json`, { cwd: root }).toString().trim();
ok(`no client / api / shared / vercel.json change vs ${BASE} — DB draft only`, changed === "", changed);
const tok = (p) => (readFileSync(join(root, p), "utf8").match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
