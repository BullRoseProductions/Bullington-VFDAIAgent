import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
const listeners = {};
const mk = (scrollHeight, clientHeight, scrollTop = 0) => ({ scrollHeight, clientHeight, scrollTop, attrs: {} });
const els = {};
globalThis.window = { scrollY: 0, innerHeight: 800, addEventListener: (e, f) => { (listeners[e] ||= []).push(f); }, removeEventListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); }, scrollTo: (x, y) => { globalThis.window.scrollY = y; }, location: { reload() {} } };
globalThis.document = {
  documentElement: { scrollHeight: 800 },
  querySelectorAll: () => Object.entries(els).map(([k, el]) => ({ getAttribute: () => k, get scrollTop() { return el.scrollTop; } })),
  querySelector: (sel) => { const k = sel.match(/"(.+)"/)[1]; return els[k] || null; },
};
const store = {}; globalThis.sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.localStorage = globalThis.sessionStorage;
// Load the REAL src/appUpdate.js (reproducible from a clean checkout: `node docs/review/auto_update_scroll_test.mjs`).
// Its six imports are app/runtime modules node can't resolve here, so they're stubbed in memory, and the two functions
// under test are exposed; the module body is otherwise byte-for-byte the source.
const SRC = new URL("../../src/appUpdate.js", import.meta.url);
const STUBS = [
  ['import { useState } from "react";', "const useState = () => [null, () => {}];"],
  ['import { Capacitor } from "@capacitor/core";', "const Capacitor = { isNativePlatform: () => false };"],
  ['import { anEditorIsOpen } from "./useReconnect";', "const anEditorIsOpen = () => false;"],
  ['import { writesInFlight } from "./supabaseClient";', "const writesInFlight = () => 0;"],
  ['import { noirConfirm } from "./NoirDialogs.jsx";', "const noirConfirm = async () => false;"],
  ['import { FIRE } from "./theme.js";', "const FIRE = {};"],
];
let code = readFileSync(SRC, "utf8");
for (const [from, to] of STUBS) {
  if (!code.includes(from)) throw new Error(`appUpdate.js import changed — update the stub for: ${from}`);
  code = code.replace(from, to);
}
if (/^import /m.test(code)) throw new Error("appUpdate.js has an import this test doesn't stub");
code += "\nexport { readScroll, restoreScroll };\n";
const tmp = join(mkdtempSync(join(tmpdir(), "b4c-scroll-")), "appUpdate.under-test.mjs");
writeFileSync(tmp, code);
const { readScroll, restoreScroll } = await import(pathToFileURL(tmp).href);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name, cond, extra = "") => console.log(cond ? "PASS" : "FAIL", name, extra);
// 1. read: only non-zero, keyed by the data-b4c-scroll value
els.main = mk(3000, 800, 1240); els.fit = mk(500, 500, 0);
ok("readScroll saves the panel, skips a zero", JSON.stringify(readScroll()) === '{"main":1240}', JSON.stringify(readScroll()));
// 2. restore when the panel mounts LATE and its content GROWS over time
delete els.main; delete els.fit;
restoreScroll({ main: 1240 });
await wait(300); els.main = mk(900, 800, 0);         // mounted, but too short yet
await wait(300); ok("waits while the content is too short", els.main.scrollTop === 0);
els.main.scrollHeight = 2600;                          // data arrived
await wait(300); ok("restores once reachable", els.main.scrollTop === 1240, String(els.main.scrollTop));
// 3. the person scrolls first -> restore backs off
els.main = mk(400, 800, 0);
restoreScroll({ main: 900 });
await wait(200); (listeners.wheel || []).forEach((f) => f());
els.main.scrollHeight = 3000; await wait(400);
ok("a wheel scroll cancels the restore", els.main.scrollTop === 0, String(els.main.scrollTop));
ok("its listeners are removed afterwards", (listeners.wheel || []).length === 0, String((listeners.wheel || []).length));
// 4. never tall enough -> lands as far as it can after the window (6s)
els.main = mk(1000, 800, 0); restoreScroll({ main: 5000 });
await wait(6500); ok("too short forever -> the bottom", els.main.scrollTop === 200, String(els.main.scrollTop));
// 5. two scrollers at once (main + a fitToScreen body)
els.main = mk(2000, 800, 0); els.fit = mk(1500, 600, 0); restoreScroll({ main: 300, fit: 700 });
await wait(300); ok("main + fit both restored", els.main.scrollTop === 300 && els.fit.scrollTop === 700, `${els.main.scrollTop}/${els.fit.scrollTop}`);
process.exit(0);
