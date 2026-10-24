# B4C — Cert expiry: malformed date reads as "expired" — FIX BUILD ORDER for CC

**Scope:** a malformed cert expiry (observed live: `exp = "0000-00"` on North Hood's "Boaters Ed Cert") passes the `^\d{4}-\d{2}$` format check but is garbage, so it's computed as **EXPIRED** and rendered **"expired undefined 0"**, and it counts against the member's coverage/readiness. It must read **"No expiration date"** (NO DATE, muted, rank 3 — not counted expired), never expired. Reported by Ashlea from live 2026-10-24. The status rule is replicated in client + SQL, so **this is a coordinated client + DB change — keep them in lockstep.** Standard discipline on the SQL. `verified` never touched.

## Root cause (verified in the code)
`certStatus(exp, neverExpires)` (`src/App.jsx:~11016`) and `expPhrase(exp, neverExpires)` (`~11126`) both validate only `typeof exp === "string" && /^\d{4}-\d{2}$/.test(exp)`. That regex accepts `"0000-00"`, `"2026-00"`, `"2026-13"`, etc. Then:
- `certStatus`: `[y,m]=exp.split("-").map(Number)`; `diff = y*12+m - nowYM()`; a zero/garbage date → `diff < 0` → **EXPIRED (rank 0)**, counted in coverage/readiness as expired.
- `expPhrase`: `mon = months[m-1]` → `months[-1]` = `undefined`; `y = 0` → **"expired undefined 0"**.

`"0000-00"` is **not a sentinel** anywhere — no code reads it specially. It's bad data on that row.

## The fix — client
Tighten the validity test in **both** `certStatus` and `expPhrase` (and anywhere else that parses a cert `exp`): a cert `exp` is valid only when it matches `^\d{4}-\d{2}$` **AND** the month is `01–12` **AND** the year is plausible (recommend `>= 1900`). An `exp` that fails any of these → **NO DATE** (`certStatus` rank 3, label "NO DATE", muted) and **"No expiration date"** (`expPhrase`). Never EXPIRED, never "undefined". A single shared validator (e.g. a `validExpYM(exp)` helper) used by both keeps them from drifting. `neverExpires` still wins first (unchanged).

## The fix — SQL (lockstep)
The comment at `certStatus` says the rule is **replicated in `dept_cert_readiness()`**. **Step 0 (no SQL):** find every live SQL reader that parses a cert `exp` — `dept_cert_readiness()` and any expirations/reminders reader (e.g. `dept_cert_expirations`) — and show how each validates it. Then harden each identically: a cert `exp` with month outside 01–12 (or an implausible year) is treated as **no date / not expired**, exactly like the client, so the readiness % and the "expired" counts agree between client and SQL. Full discipline — single DO block, pin the reader md5s, snapshot everything else byte-identical, PGlite dry run (a `0000-00` / `2026-13` row reads no-date, not expired; a real expired row still expired; a never-expires type still wins), SENTINEL RETEST on live. Deliver the migration + dry run + RETEST for gate review before apply.

## Optional (ask Ashlea) — data cleanup
Separately, there may be other rows across departments with a malformed `exp`. A one-off read-only audit (`select … where exp !~ '^\d{4}-(0[1-9]|1[0-2])$'`) would show how many and where. Not required for the fix (the hardening makes them read correctly), but offer it — a scoped `UPDATE` could null the garbage dates so they read "No expiration date" cleanly rather than relying on the guard. Decide with Ashlea; don't touch data without review.

## Review hooks
- Client: a shared `validExpYM`-style check rejects month 00 / >12 and implausible years → NO DATE / "No expiration date", never EXPIRED or "undefined"; `neverExpires` still wins; coverage/readiness no longer counts a garbage date as expired.
- SQL: every `exp`-parsing reader hardened identically (client↔SQL agree); everything else byte-identical; `verified` untouched; standard discipline + dry run + RETEST.
- No change to a legitimately expired cert or a never-expires cert.

## Deliver
Client diff + the SQL Step 0 → gate review → the SQL migration + dry run + RETEST → gate review → apply. Web-layer promote for the client (Notify held back); the SQL applied + live RETEST verified. The immediate workaround for the reported cert (assign it a never-expires cert type) needs none of this.
