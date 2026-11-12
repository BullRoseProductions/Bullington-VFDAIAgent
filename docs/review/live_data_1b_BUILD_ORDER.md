# Live Data, slice 1b (client): trainings update live. Build order and hand-back

**Status:** for gate. **Not reviewed, not promoted.**

**Branch:** `feat/live-data-1b`, off `17153e2` (the build-18 re-cut sha, gate PASS @269fb0b + fence pin).

**Rides:** build 19 + the web deploy. The gate ruled that 1b stays out of build 18 unless it's gated before the re-cut.

**Scope:** client only. No SQL, no `api/`, `shared/`, native, package or `vercel.json` change.

**1a is live** (gate PASS @4a0e7a8 / P5 @f4d38e6, live RETEST 14/0/1). Statement-level triggers on `training_sessions` call `realtime.send({k:'trainings', at}, 'live', 'dept:<department_id>', private)`, and Realtime adds `id` to the payload. The join is authorized by `live_dept_receive`.

## What it does

**`src/liveData.js` (new):**
- **One private Realtime channel per app session**, on `dept:<my_department_id()>`, listening for broadcast event `live`.
- **A subscriber registry keyed by `k`.**
- **The lifecycle:**
  - **Lazy:** join when the first subscriber mounts, leave when the last unmounts.
  - **Resume:** if the channel errored, timed out or closed, it's rebuilt. This uses the app's one resume signal, `useReconnect`: visibilitychange plus native `appStateChange`, collapsed.
  - **Auth:**
    - SIGNED_OUT leaves the channel.
    - SIGNED_IN re-checks `my_department_id()` and rejoins if the topic changed.
    - TOKEN_REFRESHED does nothing here: supabase-js re-authorizes the socket itself (Step 0 §6, condition 2). No token pushing.
- **Silent:** nothing throws into the UI. If there's no department, a failed join or a dead socket, the app behaves exactly as it does today, and the resume refresh still runs. Logs are sparse and prefixed `[live]`.

**`useLiveRefresh(keys, loader, opts)`:** this **is** the screen's `useAutoRefresh(loader)`, so resume behaviour is unchanged and there's still exactly one refresher per loader. On top of that:
- a matching signal starts a **1.5s trailing debounce** (D4);
- it then calls the auto-refresh **trigger** with a **5s minimum interval**.

**`src/useReconnect.js`:** `useAutoRefresh` now **returns a trigger**. It's backwards compatible: same signature, the resume path is unchanged, and the ~30 existing callers ignore the return value.
- **It never drops a request.** "Too soon" waits out the window. An open editor and its 2s grace, a screen's `skipWhen` hold, or a load already in flight re-check every second.
- **It shares the existing gate,** so in-flight, editor guard and resume-dead retry work exactly as they do for resume refreshes.
- **Pending triggers coalesce.**

**`src/App.jsx`:**
- the root `useAutoRefresh(loadSessions)` becomes `useLiveRefresh(["trainings"], loadSessions)`, plus one import;
- `loadSessions` itself, and its never-blank-on-error behaviour, are untouched;
- members and plans keep their plain resume refresh.

## The kill switch

**`VITE_LIVE_DATA_ENABLED=0`** at build time turns live data off completely: no channel, no rpc and no auth listener. Every screen falls back to its resume refresh.
- On by default (any other value, or unset).
- It's a build-time variable, so killing it on web means changing it in Vercel and redeploying. Killing it on native means a new build.

## Tests: `docs/review/live_data_1b_test.mjs` (36 checks)

The test bundles the real `src/liveData.js` + `src/useReconnect.js` + React against a fake supabase. Each simulated client has its own instance, all sharing one fake Realtime bus. It passes short debounce and interval values through the hook's options, and asserts the real defaults separately.

| # | Check |
|---|---|
| 1 | Two clients in the same department: B's save → A's loader runs **once**, after the debounce, with no navigation |
| 2 | An open editor defers the refresh. It's still held inside the 2s grace after close, then runs **once** |
| 3 | A burst of 5 signals → **one** refetch. A signal inside the minimum interval waits it out and still runs once (not dropped) |
| 4 | CHANNEL_ERROR → rebuilt on resume and signals flow again. With no channel at all, the resume refresh still runs |
| 5 | SIGNED_OUT leaves. SIGNED_IN as another department's user joins the new topic. TOKEN_REFRESHED doesn't rejoin. One auth listener |
| 6 | Private channel, topic `dept:<id>` from the rpc, event `live`. Another key doesn't run the trainings loader. Department B never sees `dept:A` |
| 7 | `VITE_LIVE_DATA_ENABLED=0`: no channel, no rpc, no auth listener, and the resume refresh still runs |
| 8 | No table writes, no token pushes. The App wiring has one refresher. Defaults 1.5s / 5s / `live`. `useAutoRefresh` is backwards compatible. Invariants: verified counts 132/32/14, Notify held. Files-changed fence vs `17153e2`; no ios/, android/, package, api/, sql/, shared/ or `vercel.json` changes |

## Decisions for the gate

- **LD-1:** **only root `loadSessions` is wired**, per §3. Attendance, roster and the rest follow the rollout order, one key per slice.
- **LD-2:** **the live path never drops a signal.** That's stricter than the resume path, which skips when it's too soon. A dropped signal would mean a member sees stale data until the next resume, which is what this feature exists to remove. The cost is at most one deferred run per window.
- **LD-3:** **the kill switch is on by default** (`!== "0"`).
- **LD-4:** **the resume rebuild uses the existing `useReconnect` per subscriber.** It's idempotent: a healthy channel is left alone.
- **LD-5, a blocker for the web half. Needs a ruling plus a `vercel.json` change I did NOT make (out of this slice's scope).**
  - **The problem:** the web CSP is **enforced** (industrial-noir-55, `f10383f`). Its `connect-src` allows `https://ifeptqnlucmvhlvadcpj.supabase.co` but **not `wss://`**, so on the web the browser blocks the Realtime socket. 1b then silently degrades to resume-refresh only: nothing breaks, but nothing goes live.
  - **Native is unaffected:** the bundled app isn't served with Vercel's headers, and `index.html` has no CSP meta tag.
  - **`docs/review/m3_headers_test.mjs` is RED on this branch, by design.** Its §4 asserts "no realtime channel in the client, so no wss: is allowed (add it if a .channel() ever lands)", and a channel has now landed.
  - **Proposed fix** (its own small slice, gated): add exactly `wss://ifeptqnlucmvhlvadcpj.supabase.co` to `connect-src` in the enforced CSP, then update m3 §4 and csp_enforce_test to require that one origin whenever a channel exists. No wildcard.
  - **Order:** ship it with or before the web deploy of 1b.

## On-device check for Ashlea (after promotion, before build 19 submits)

1. **Same department:** sign two phones into the same department and open **Training → schedule** on both. On phone A, edit a session's start time and save. Within about 2 seconds, **phone B's schedule shows the new time with no navigation and no pull-to-refresh**.
2. **Bursts:** on phone A, mark several attendees quickly. Phone B updates **once**, not per tap. (That needs the attendance key, a later slice, so here just confirm nothing misbehaves.)
3. **Open editor:** on phone B, open a training edit form, then edit a session on phone A. Phone B's form is **not** disturbed. After B closes the form, its list updates within a few seconds.
4. **Another department:** a phone signed into a **different department** sees **nothing** change when phone A saves.
5. **Background:** background phone B for a minute, edit on phone A, then bring B back. B shows the change, either from the resume refresh or the rebuilt channel.
6. **Kill switch (optional, web):** build with `VITE_LIVE_DATA_ENABLED=0`. The app works exactly as before 1b, with no `[live]` console lines.

## Suite on this branch

**66 files. 65 green, 1 red: `m3_headers_test` (LD-5, by design until the CSP slice lands).**

**Also fixed here:** `docs/review/field_requests_ui_test.mjs`'s pinned verified-count check crashed with `ENOBUFS`. It does `git show <rev>:src/App.jsx` through `execSync` with the default 1 MB buffer, and `App.jsx` is larger than that. The buffer is raised to 64 MB, and the test is now 37/37 with a clean exit.
- The bug came in with the fence-pin commit `17153e2`.
- It's test-only and doesn't touch the bundle, so the build-18 artifacts are unaffected.

**Build:** `npx vite build` (placeholder env, output to scratch) compiles cleanly.
