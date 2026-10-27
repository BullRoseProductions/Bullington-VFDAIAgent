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
// Fences PINNED to the copy's own release (0d0b07e, a --no-ff merge whose first parent 99a15b0 is the main it landed on):
// "vs origin/main" holds only until the next slice merges. Historical = the release vs its parent.
const REL = "0d0b07e";
const BASE = `${REL}^1`;
const base = execSync(`git show ${BASE}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();
const rel = execSync(`git show ${REL}:src/App.jsx`, { cwd: root, maxBuffer: 1 << 27 }).toString();

ok("the upload hint says who can open the proof", rel.includes("A leader reviews and approves it. Only you and your department's leaders can open the proof file."));
ok("the Expirations footer no longer claims 'never … the scan'", !rel.includes("never the number, the scan") && rel.includes("Uploaded proof files (certificates, cards) can be opened only by the member and department leaders."));
ok("the footer still promises no license numbers or medical detail in the tracker", rel.includes("never a license number or any medical detail"));
const changed = execSync(`git diff --name-only ${BASE} ${REL} -- src api shared`, { cwd: root }).toString().trim().split("\n").filter(Boolean);
ok("the release (0d0b07e) changed only src/App.jsx (runtime) vs its parent", JSON.stringify(changed) === '["src/App.jsx"]', JSON.stringify(changed));
const lines = execSync(`git diff -U0 ${BASE} ${REL} -- src/App.jsx`, { cwd: root }).toString().split("\n").filter((l) => /^[-+][^-+]/.test(l));
ok("exactly two lines changed in App.jsx (copy only)", lines.length === 4, String(lines.length));
const storageCalls = (s) => (s.match(/storage\.from\(/g) || []).length;
ok("no storage call added or removed", storageCalls(rel) === storageCalls(base));
const tok = (s) => (s.match(new RegExp("verifie" + "d", "gi")) || []).length;
ok("locked-token count unchanged by the release vs its parent", tok(rel) === tok(base), `${tok(rel)} vs ${tok(base)}`);
ok("Notify crew held back", !existsSync(join(root, "api/notify-session.js")) && !src.includes("NotifyCrewModal"));
