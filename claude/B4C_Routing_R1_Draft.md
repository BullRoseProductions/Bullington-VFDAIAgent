# B4C: Routing R1, the router and top-level screens (DRAFT, web only, NOT deployed)

**Branch:** `feat/routing-r1`, off main `635d643` (industrial-noir-62). Step 0 (`design/routing-step0` @ `51e0147`) was accepted
with four rulings: a hand-written router, readable kebab-case paths, tabs replace / screens push, and R1 aiming for build 18, web-first.
**Changed:** a new `src/router.js`; `src/App.jsx`; `src/main.jsx` (one module-scope line); `vercel.json` (one rewrite);
`docs/review/routing_r1_test.mjs`; this note.
**Byte-identical (asserted):** `appUpdate.js`, `pendingScan.js`, `deeplink.js`, `Login.jsx`, `SetPassword.jsx`, `routeDeepLink`, the AASA, `assetlinks.json`, the Android manifest, and `vercel.json`'s crons, headers and two existing rewrites.

## What made R1
| Screen | Path |
|---|---|
| Dashboard | `/` |
| Notifications | `/notifications` |
| Training | `/training` |
| Library (Training's Library tab as its own screen) | `/training/library` |
| Library drill (packet) | `/training/library/:libraryId` (dot-free id) |
| Roster | `/roster` |
| New-Member Onboarding | `/onboarding` |
| Apparatus | `/apparatus` |
| Qualifications | `/qualifications` |
| Equipment / My Equipment | `/equipment`, `/my-equipment` |
| Station Hours | `/station-hours` |
| Station Duties | `/duties` |
| Recruitment | `/recruitment` |
| Funding & Events | `/funding` |
| Public Relations | `/public-relations` |
| Meetings | `/meetings` |
| Reports | `/reports` |
| Expirations / Readiness | `/expirations`, `/readiness` |
| Study Session / Station Q&A | `/study`, `/station-qa` |
| Station Documents / Read & Sign | `/documents`, `/read-sign` |
| Your Six | `/your-six` |
| Settings & Support | `/settings` |
| Content Admin / Add Department / Department (PA) | `/admin`, `/add-department`, `/department` |
| **Check-in / handoff (one-shot QR)** | **unchanged:** `/checkin?checkin=…&t=…`, `/handoff?handoff=…&t=…`, outside the router |

That is all 26 sidebar screens plus notifications, library and packet (28 paths plus the packet pattern).
**`navArg` rides in the history entry's state, never in the URL.** Roster "pending", the Meetings mode and the Department target
therefore survive Back and refresh in the same tab, but aren't shareable yet.

## Deferred to R2
- **Sub-views in the URL:**
  - Training tabs (Schedule / Plans / Library inside `/training`);
  - Roster tabs;
  - Meetings modes;
  - Reports / Settings / Funding views (still the update-restore's `useRestorableView`);
  - `/department/:deptId`.
- **The Roster tab seed reads the role at mount.** That's existing behaviour, made visible now. On a cold load the role is still
  "Member" when Roster mounts, so a refreshed DA "Pending Items" opens on Members. Meetings (not role-dependent) does keep its
  mode. R2 fixes this when the tab moves into the URL and is seeded after identity.
- **Entity detail URLs** (a member file, a rig, a document) are long tail.

## How it works
- **`src/router.js`** (hand-written, no library):
  - the route table, `pathFor` / `parsePath` (dot-free ids; `/checkin`, `/handoff` and unknown paths aren't the router's);
  - `pushRoute` / `replaceRoute`, which carry `location.hash` through verbatim and never read it;
  - the main-panel scroll helpers;
  - the **pending path** stash (the same capture/consume-once/30-minute shape as `pendingScan`).
- **`App.jsx`:**
  - **Boot:** the address bar decides the screen. A restored place (app update) supplies its own screen's extras when it agrees with the URL; the URL wins when they disagree.
  - **One sync effect:** a screen change **pushes**. These **replace**:
    - first render, redirects (the retired `ai`, a disabled module, a missing packet, the role guard);
    - View-as, a pending path, the same path with new state;
    - leaving a one-shot check-in / handoff (Back can't land on a spent code).

    It does nothing on `/checkin` / `/handoff` (that's `routeDeepLink`'s job).
  - **popstate** sets the screen without pushing again and restores that entry's scroll.
  - **go()** saves the outgoing scroll. It points the URL at the destination before an app-update boundary reload (so the reload lands where the person was headed), and puts it back if no reload happens.
  - **Sign-out** (`SIGNED_OUT`) replaces to `/`.
  - **The role guard waits for `identityChecked`.** Role is `["Member"]` until the identity read lands, so an earlier guard would bounce a DA's cold `/reports`. Equipment (equipment managers load later) and Read & Sign (in the menu only while something is outstanding) aren't bounced; both already show the right view to anyone.
  - `data-b4c-screen` on the main panel, for tests and the sweep harness.
- **`main.jsx`:** `capturePendingPath(location.pathname)` at module scope, beside `capturePendingScan`. It reads the pathname only.
- **`vercel.json`:** one catch-all, `/((?!api/|assets/|\.well-known/)[^.]*)` → `/index.html`. It was compiled with **Vercel's own `@vercel/routing-utils` 6.6.1**, which accepts the config:
  - app paths go to `index.html`;
  - `/api`, `/assets`, `/.well-known` and every real file (anything with a dot: `version.json`, `manifest.json`, icons, `/index.html`) are left alone.

## Proof: `routing_r1_test.mjs`, 51/51
The real `App.jsx` is bundled and cold-loaded in happy-dom at real URLs; happy-dom implements push / replace / back / forward / popstate.
1. **The route table:** all 26 NAV keys plus notifications and library; round-trip; kebab-case; dot-free ids; one-shot and unknown paths aren't the router's.
2. **Cold loads:** all 28 paths as a **Member** and as a **DA** give the right screen with the URL unchanged. **No bounce:** the bar is never rewritten to `/` during a load. A path the role's sidebar never offers bounces to `/` by replace once identity lands.
3. **An unknown path** gives `/`, replaced.
4. **Back walks screens, not tabs:** sidebar taps push and the Training Plans tab adds nothing. Back gives Training, then the dashboard; Forward doesn't duplicate.
5. **Scroll:** a push puts the panel at the top; Back restores 480.
6. **Refresh** stays on the same screen with no new entry, and the entry's navArg survives (`/meetings` reopens on Minutes).
7. **`/checkin` / `/handoff`:**
   - `routeDeepLink` and the files above are byte-identical;
   - a cold `/checkin?…` still checks in, with the same args, and the router writes nothing before `routeDeepLink` reads the code;
   - leaving it replaces;
   - a cold `/handoff?…` still previews;
   - a bare `/checkin` runs nothing.
8. **The hash:**
   - App-level writes carry a `#access_token=…` through verbatim;
   - `router.js`'s code has no hash read, write or clear;
   - **a recovery link through the real `main.jsx`**, even on a deep path, reaches **"Set a new password" with the hash exactly as it arrived**, and the pending path took the pathname only.
9. **The pending path:**
   - it is captured only for a real non-root path, consumed once, and expires after 30 minutes;
   - a magic link landing on `/` goes to `/reports` by replace;
   - **a QR scan in play always wins.** This caught a real ordering bug: the pending-path effect now runs before the scan replay spends the scan.
10. **View-as and sign-out** land on `/` with no Back step; `go()` writes the destination URL before a boundary reload.
11. **`vercel.json`:**
    - crons, headers and the two rewrites are byte-identical;
    - exactly one rewrite is added, and the raw diff is only that block;
    - routing-utils compiles it with no error, sends every app path to index.html, and leaves the exclusions alone.

Plus the fences, the counts and Notify.

**Mutations caught:**
- dropping the identity wait fails 2 (a DA's cold `/onboarding` bounced);
- stripping the hash from writes fails 8;
- pushing instead of replacing when leaving `/checkin` fails 7.

The other suite tests are untouched and green.

**Suite** 58 files, 1,495 passed, 0 failed · **lint** and **build** clean · verified **132/32/14** · **Notify held**.

## Native (build 18)
- **No native config change.** Capacitor 8.5.0's local server already serves `index.html` for extension-less paths on both platforms (Step 0, from source).
- **For build-18 QA on device:**
  1. Tap through a few screens, then Android **Back**. It should walk screens: Capacitor's default uses WebView history, which now has entries. At `/` it exits as today.
  2. A cold launch opens the dashboard, as today. The native start URL is `/`, and the app-update restore is inert on native.
  3. A `/checkin` / `/handoff` app link still opens the check-in / handoff screen.
- **iOS** has no hardware Back; swipe-back isn't enabled on the WebView, so nothing changes there.

## Known edges, stated
- **One-time, at the R1 deploy:** a tab still running the *pre*-R1 build that hits an app-update boundary reload lands on the screen it left rather than the one it was heading to. The old code can't write the URL; the URL wins. This happens once per open tab and loses nothing.
- **Real-Chrome Back / refresh** wasn't separately run; happy-dom's history implementation carried the proof. It's easy to add with the sweep harness if the gate wants it.
