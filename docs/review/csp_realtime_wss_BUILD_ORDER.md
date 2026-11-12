# CSP: allow the realtime websocket (LD-5). Build order and hand-back

**Status:** DRAFT for gate. Not merged.

**Branch:** `feat/csp-realtime-wss`, off `cdf1d37` (Live Data 1b, gate PASS).

**Ruling:** gate, 2026-11-12, LD-5. Draft the CSP slice now, with its own gate: the wss origin into `connect-src`, and `m3_headers_test` / `csp_enforce_test` updated. **1b doesn't merge to main until this slice merges with it or before it, so main's suite never goes red.** Native needs nothing (no CSP in the app; `index.html` has no CSP meta tag), and 1b rides build 19.

## The change

**`vercel.json`:** one token. `connect-src 'self' https://ifeptqnlucmvhlvadcpj.supabase.co` **`wss://ifeptqnlucmvhlvadcpj.supabase.co`** `https://app.b4thecall.com`. Nothing else moves.
- **No wildcard:** no `wss:` scheme, no `*.supabase.co`, no `ws:`.
- **Same host:** the host is the one supabase-js derives its realtime URL from (the project URL, https → wss).

## Tests (every run reports its exit code; a non-zero exit fails the run)

| Test | Result | What changed in it |
|---|---|---|
| `docs/review/csp_realtime_wss_test.mjs` (new) | 12 PASS, **exit 0** | see below |
| `docs/review/m3_headers_test.mjs` | 24 PASS, **exit 0** | the "no realtime channel → no wss:" assert (it read today's `src/`) is replaced by three |
| `docs/review/csp_enforce_test.mjs` | 11 PASS, **exit 0** | header comment only; its checks stay pinned to `d377999..b6bb821`, the enforce step itself |
| `docs/review/live_data_1b_test.mjs` | 36 PASS, **exit 0** | fence pinned to its released range `17153e2..cdf1d37` (gate PASS @cdf1d37); it read the working tree and went red as soon as this slice existed |

**The new test checks:**
- **Exact diff:** `connect-src` equals BASE's plus exactly that token. Every other directive, header, cron and rewrite is unchanged.
- **One wss: only:** exactly one `wss:` source, in `connect-src`.
- **Nothing else loosened:** no wildcard, bare scheme or `ws:`, and `script-src` is still `'self'`.
- **One channel:** a single private channel, in `src/liveData.js`.
- **Fences:** no change in `src/`, `api/`, `shared/` or `sql/`; verified counts 132/32/14; Notify held.

**The three new `m3_headers_test` asserts:**
- the only channel in the client is `src/liveData.js`;
- the *released* report-only CSP had no `wss:`;
- *today's* enforced CSP allows exactly the project's `wss:` origin, in `connect-src` only.

## Merge order (for Ashlea's go)

This branch is **1b + this slice**: `cdf1d37` + one commit. Merging this branch's tip lands both together, so main never sees 1b without the CSP.

**After the deploy, served-verify:**
- the live response header's `connect-src` contains the wss origin;
- on the web, the realtime socket connects (DevTools → Network → WS, `wss://ifeptqnlucmvhlvadcpj.supabase.co/realtime/v1/websocket`) with no CSP violation in the console.
