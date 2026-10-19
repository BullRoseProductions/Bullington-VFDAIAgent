# B4C — Remove Ask B4C from the production nav + dashboard card (web hotfix) — for CC

## Problem
Production (app.b4thecall.com = `origin/main` @ `541df2f`) still shows:
- the left-nav **"Ask B4C"** entry — `src/App.jsx:1771`: `{ key: "ask", label: "Ask B4C", Icon: Sparkles, roles: ROLES },`
- the member-dashboard **AskB4CLauncher** card — component `src/App.jsx:~4924` (`function AskB4CLauncher({ go })`), rendered at `~5002` (`<AskB4CLauncher go={go} />`).

The 3.0 decision removed BOTH (the right-edge handle is the single opener). That removal is commit **`56d10a5`** ("3.0 mobile batch…"), on `release-3.0` + `theme/industrial-noir`; it shipped in the 3.0 app and is on preview, but was **never promoted to the web**. So the website is one promote behind. Fix the web.

## Fix (branch off `origin/main`, e.g. `fix/web-remove-askb4c-nav`)
1. Remove the nav entry line (`~1771`): `{ key: "ask", label: "Ask B4C", Icon: Sparkles, roles: ROLES },`.
2. Remove the member-dashboard card: delete `function AskB4CLauncher(...)` (`~4924`) and its render `<AskB4CLauncher go={go} />` (`~5002`) — exactly as `56d10a5` did.
3. Leave the Ask B4C drawer + the right-edge handle untouched — the handle stays the opener. `go("ask")` becomes unreferenced; leaving it is harmless (matches `56d10a5`).
4. Keep this hotfix MINIMAL — do NOT pull the rest of `56d10a5` (phone bottom-sheet / `useFitHeight` / `overflowX` guard) unless a clean cherry-pick is preferred and you want web fully in line with the app; if so, review the full resulting diff.

## Verify (before prod deploy — Claude gate-reviews the diff)
- build + eslint clean.
- Web: left nav no longer lists Ask B4C; member dashboard has no Ask B4C card; the **right-edge handle still opens Ask B4C**.
- `verified` untouched — 0 changed lines reference it.
- NAV count 14 → 13 (same delta `56d10a5` recorded).

## Deploy
- To production; **served-bundle verify** on app.b4thecall.com: new `index-*` hash, nav has no Ask B4C, handle opens it. (Not just "deploy succeeded.")
- Keep the prior prod deploy as one-click rollback.

## Note (git housekeeping)
A stale lock `.git/refs/heads/theme/industrial-noir.lock` was left by a check from the Claude (device-bridge) side — deleting is blocked there. Remove it locally before committing on theme: `rm .git/refs/heads/theme/industrial-noir.lock`. It does NOT affect a branch cut from `origin/main`.
