// PGLITE_DIR=<dir with @electric-sql/pglite> node docs/review/l2_l4_db_test.mjs
// No network, no live DB. Security L-2 + L-4 (DB drafts). Checks:
//   1. the SQL + change list REGENERATE byte-identical from the live capture (docs/review/l2_l4_build.mjs --check)
//   2. the PGlite dry run passes end to end (docs/review/l2_l4_dryrun_harness.mjs: pins reproduce, apply, re-run refuses,
//      RETEST 0 failed, rollback round trip, drift refusals, every mutation caught and rolled back)
//   3. fences: no client / api / shared / vercel.json change vs main; verified 132/32/14; Notify held
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "7e1addc";   // main when this was drafted (industrial-noir-44)
const gen = spawnSync("node", [join(root, "docs/review/l2_l4_build.mjs"), "--check"], { encoding: "utf8" });
ok("the 6 SQL files + the change list regenerate byte-identical from docs/review/l2_l4_LIVEDEFS.json", gen.status === 0 && (gen.stdout.match(/^same /gm) || []).length === 7, gen.stdout.split("\n").filter((l) => !l.startsWith("same")).join(" "));
const dry = spawnSync("node", [join(root, "docs/review/l2_l4_dryrun_harness.mjs")], { encoding: "utf8", env: process.env });
const m = /(\d+) passed, (\d+) failed\s*$/.exec(dry.stdout.trim());
ok("PGlite dry run: every check passes (apply · refuse re-run · RETEST · rollback round trip · drift refusals · mutations caught)", dry.status === 0 && m && +m[2] === 0 && +m[1] >= 48, m ? `${m[1]} passed, ${m[2]} failed` : (dry.stderr || "").slice(0, 200));
const changed = execSync(`git diff --name-only ${BASE} -- src api shared vercel.json`, { cwd: root }).toString().trim();
ok(`no client / api / shared / vercel.json change vs ${BASE} — DB drafts only`, changed === "", changed);
const tok = (p) => (readFileSync(join(root, p), "utf8").match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("verified untouched: App.jsx 132 · digest 32 · assistant 14", tok("src/App.jsx") === 132 && tok("api/digest.js") === 32 && tok("api/assistant.js") === 14);
ok("Notify held: api/notify-session.js absent", !existsSync(join(root, "api/notify-session.js")));
