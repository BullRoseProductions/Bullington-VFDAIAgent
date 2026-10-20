# B4C — Let the desktop app use more screen width — BUILD ORDER for CC

**What Ashlea sees:** the B4C desktop app **downloaded from the App Store** leaves big empty gutters on a wide monitor — the content stops at a fixed width and centers, wasting 300–500px of side space on a maximized window.

**What that desktop app actually is (confirmed in repo):** there is no Electron/Tauri and no Mac Catalyst target. The iOS app is iPad-compatible (`TARGETED_DEVICE_FAMILY = "1,2"`, landscape allowed, `UIRequiresFullScreen` not set), so on an Apple Silicon Mac it's distributed as **"iPhone & iPad Apps on Mac"** — the iPad Capacitor build running in a resizable Mac window. Same app, same web bundle. (The same cap also pinches real iPad users and the web/PWA.)

**Root cause (confirmed in repo, `theme/industrial-noir`):** the app shell's `content` style in `src/App.jsx` (~line 27277) caps the whole content column:
```
content: {
  padding: "26px clamp(18px, 4vw, 40px)",
  paddingLeft/Right: "calc(clamp(18px, 4vw, 40px) + env(safe-area-inset-...))",
  paddingBottom: "calc(26px + env(safe-area-inset-bottom))",
  maxWidth: 1080, width: "100%", margin: "0 auto",   // <-- this 1080 is the gutter
}
```
This is the only ≥1000px content-column cap in the file (verified — nothing else wraps pages at 900–1080). Every page's content region uses it.

## The change
Raise the `content` `maxWidth` from `1080` to a desktop-friendly cap. **Recommend `1600`** (or a responsive value — see below). That's the whole fix: one value in one style object.

### Why it's safe and why it only helps big windows
- **Phones unaffected.** It's `width: "100%"` capped at `maxWidth`. Phone widths are well under 1080, so they already fill 100% — raising the cap to 1600 changes nothing below 1080px. Only wide surfaces (Mac window, iPad landscape, desktop browser) gain room.
- **The responsive grids already handle the extra width.** `dashGrid` (1.5fr/1fr), `statRow` (auto-fit minmax 150px), `quickGrid` (auto-fit minmax 290px), and the department-cards grid all reflow to use more width — so more room = more/wider columns, which is exactly the ask. No per-component changes needed.

### Delivery — this is the part that changed from the first draft
The desktop app from the App Store is the **iPad build in a Mac window**, so a web-layer change reaches it **only inside a store build** (bundled assets) — NOT from a web deploy. The web app and the PWA get it instantly on the next `main` deploy; the **App Store Mac app and iPad users get it only when a build carrying it is approved.**

**Recommendation: fold this one-liner into the 3.1 build before you submit it** (3.1 is built and gate-reviewed but not yet submitted). It's a one-line, Path-A, routine-review change — adding it means CC edits the value on `release/3.1-store`, rebuilds, I re-review the trivial diff, and 3.1 ships wider out of the gate. Version stays 3.1 / iOS 14 / Android 12 (content change, no version bump). If you'd rather not touch the reviewed build, it rides the next build instead — your call.

### Optional, nicer: keep reading views tighter
1600 is great for the grid-heavy pages (dashboard, roster, reports, apparatus). If any text-heavy view (a long form, a single-column reading page) feels too wide at 1600, cap that view locally rather than lowering the shell. Don't block the shell bump on this — ship the bump first, tune locally only if something actually reads wrong.

## Deliver for review
A one-line diff (the `maxWidth` value) is all I expect. Alongside it, tell me how the main views look at the wider cap — dashboard (the oversight grid), Roster (the wide table), and a Report — so I can confirm nothing stretches badly. Then it folds to `main` with the normal web deploy.

## Honest-state
Cosmetic layout only. No data, no permissions, no native change — Path A untouched. "Live on the web/PWA" = merged to main + Vercel deployed. "Live on the App Store Mac app / iPad" = carried in an approved store build (fold into 3.1, or a later build). Different surfaces, different timing.
