// node docs/review/ws3_certproof_copy_test.mjs
// WS-3 (cert-proof privacy) — the client half is COPY ONLY: the privacy wording now matches the storage policy in
// sql/ws3_certproof_privacy_DRAFT.sql (proof files: the member + department leaders). Source checks, no DOM.
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { fileURLToPath } from "url";
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, extra); if (!cond) process.exitCode = 1; };
const root = fileURLToPath(new URL("../../", import.meta.url));
const src = readFileSync(join(root, "src/App.jsx"), "utf8");
const BASE = "origin/main";
const base = execSync(`git show ${BASE}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();

ok("the upload hint says who can open the proof", src.includes("A leader reviews and approves it. Only you and your department's leaders can open the proof file."));
ok("the Expirations footer no longer claims 'never … the scan'", !src.includes("never the number, the scan") && src.includes("Uploaded proof files (certificates, cards) can be opened only by the member and department leaders."));
ok("the footer still promises no license numbers or medical detail in the tracker", src.includes("never a license number or any medical detail"));
const changed = execSync(`git diff --name-only ${BASE} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("only src/App.jsx changed (runtime) vs origin/main", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const lines = execSync(`git diff -U0 ${BASE} -- src/App.jsx`, { cwd: root }).toString().split("\n").filter((l) => /^[-+][^-+]/.test(l));
ok("exactly two lines changed in App.jsx (copy only)", lines.length === 4, String(lines.length));
const storageCalls = (s) => (s.match(/storage\.from\(/g) || []).length;
ok("no storage call added or removed", storageCalls(src) === storageCalls(base));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged vs origin/main", tok(src) === tok(base), `${tok(src)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
