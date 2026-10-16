# Seamless auto-update (web) — review record

**Verdict: PASS**, from the Claude review via Ashlea on 2026-10-16, for build `3776aaa`. It is **not promoted yet.**

- **Code:** `src/appUpdate.js`, plus wiring in `App.jsx`, `main.jsx` and `supabaseClient.js`.
- **Diff:** `docs/review/app_update_no_refresh_DIFF.patch`

## The reviewer's checks against the code

1. **Write counter.** It sits at the existing `authFetch` chokepoint. It counts every request that isn't GET or HEAD and decrements in `.finally()`, so an error can't leak the count. A `Math.max` floor stops it going negative.
2. **No database surface added.** No new `.rpc()` calls, and nothing touches station presence, hours or `verified`.
3. **Guards match the app's real modals and editors.**
   - The `[aria-modal="true"]` check matches `NoirDialogs.jsx:79` and `ConfirmDestructive.jsx:150/188`.
   - The `useEditorOpen` registry has 18 call sites.
4. **No reload loop.** At most 3 automatic reloads per deploy id per tab, with 2- and 4-minute back-off. The cold-start reload only fires before the person has touched the page.
5. **Place restore.** `takeRestoredPlace` is memoised (safe under StrictMode) and a saved place expires after 2 minutes. A `?checkin` / `?handoff` deep link still wins, and the one-shot scan screens are never restored.
6. **Degrades safely.** Every storage access is wrapped in try/catch. On native the module is inert.
7. **Gates unchanged.** 1395 → 1395 gate tokens; reads 283; rpc 177; 0 lines containing "verified". `vercel.json` needed no change.

## Decisions — all four confirmed as built

| Decision | Outcome |
|---|---|
| Native | No store nudge. Capgo already delivers native OTA (`autoUpdate "atBackground"`). A store nudge for native-code releases is deferred as a separate small piece. |
| Cold-start reload | **Kept.** It fires only before the page is touched and is loop-guarded. |
| Panel open/closed state | Not restored in v1. Only screens, hub sub-views and scroll are restored. |
| Defaults | Both apply styles (silent swap on navigation, plus the pill), with a 10-minute check. |

## Already verified on preview

| Check | Result |
|---|---|
| A faked newer `version.json` | Shows the pill |
| ✕ (dismiss) | Keeps the pill hidden on the next check |
| Update | Reloads and records exactly one attempt |
| Background tab | Correctly skipped |

## Still to verify before promoting (needs a signed-in preview session)

- [ ] After an update reload, the person lands on the same screen (including the Settings › Former members sub-view).
- [ ] The silent swap when navigating: the reload lands on the destination screen.

Once both pass, promote the usual way. Notify crew stays held back. Rollback is the current release, `3f21678`.
