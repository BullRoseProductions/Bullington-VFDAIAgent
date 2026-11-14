# Weekly Training Content, slice 2: Library S2 UI: build order and hand-back

**Status:** for gate. **Not reviewed, not promoted.** Branch `feat/library-s2-ui`, off origin/main `37e3527`.
- Client only: `src/App.jsx`. No `api/`, `shared/`, `sql/`, native, package or `vercel.json` change. No SQL to apply.
- Web on merge; phones get it in build 19 (with Live Data 1b). Nothing rides build 18.

**Design:** `docs/design/training_content_step0.md` §2, §3 and §6 row 2 (gate PASS @2a0768c; rulings @4cfe29f, R5).
**DB:** Library S2 DB, live 2026-11-04 at gate PASS @0235cf2 (record b86d5dc, live RETEST 15/0/0).

## What it does

### 1. The curator: Content Admin (Project Admin only)
The Content Admin screen's dead "Publishing" placeholder is replaced by `LibraryCurator`.
- **Add a drill:** a form (title, track, level, length, who it's for, and the packet sections, one item per line). It saves through `pa_put_library_drill` as **submitted**. Nothing reaches a department until it's published.
- **Waiting to publish:** each submitted drill has **Preview**, **Edit** and **Publish**.
- **Published:** the live catalog, with **Preview** and **Withdraw**. There's no Edit, because published drills are final (L5 snapshots). To change one, withdraw it and add a new one.
- **Withdrawn:** **Preview** and **Publish again** (S2-1).
- **Preview** renders the drill through `libRowToPacket`, the Library's own mapper. It shows the Packet's sections in the Packet's order and skips empty ones, so it matches what departments see.
- **Publish** asks first (`noirConfirm`): it goes to every department, it can't be edited afterwards, and copies are kept. **Withdraw** asks first too (danger): it leaves every library, and copies are kept.
- **Reads:**
  - `pa_library_queue()` for submitted and withdrawn drills (a non-PA gets no rows);
  - the published catalog from `useLibraryCatalog`, the same read the Library tab makes.

  A failed queue read keeps the last-known list and offers Retry. It never shows "nothing waiting" on an error.
- **Writes** are the three `pa_*` RPCs only, each gated on `is_project_admin()` inside the function. There's no table write.

### 2. "From B4C" in Training Plans (R5)
- **What it shows:** the newest three published drills, from the same `useLibraryCatalog` read (no new query; still one `library_drills` read for the Training screen).
- **On each card:** track, length, title and objective. Tapping opens the packet.
- **"Add to my plans"** is shown to training managers only and uses the existing `pull_library_drill` path (`addLibraryDrill`). A drill already pulled reads **"In your plans · open"**.
- **"See the whole library →"** flips to the Library tab. The Library tab itself is unchanged.
- The section is hidden when the catalog is empty.

### 3. A library draft opens with its category picker (Step 0 §2)
- **Why:** `pull_library_drill` sets `category = NULL` on the copy, because categories are department-local.
- **The picker:** an open library **draft** with no category shows a "Pick a category for this plan" picker. It's for writers only, and Save is disabled until a category is picked. It saves through `set_drill_plan`, changing only the category; everything else is sent as it is.
- **After any pull** (packet, Library or From B4C): `pull_library_drill`'s returned copy id is remembered. Training Plans re-reads and opens that copy. It never does this while a plan is being edited or written, so one plan's text can't land on another.
- `addLibraryDrill` now returns the copy id, which is truthy, as before.

## Judgment calls for the gate
- **LS-1, "From B4C" = the whole published catalog** (seed + B4C-written), not only `origin = 'b4c'`. Every published drill is B4C-curated. With today's catalog, a b4c-only filter would show nothing.
- **LS-2:** the curator lives in the **existing PA-only Content Admin screen** (`admin`, already in `PA_NAV`). There's no new nav entry or route.
- **LS-3, the picker shows on drafts only.** Approval is where the officer files the plan. An approved library plan keeps the normal Edit form for its category.
- **LS-4, the curator form writes the packet keys too** (`instructor_guide`, `scenario`, `discussion`, `evaluation`, `debrief`) beside the `drill_plans` keys. A department's copy keeps editing like any plan. Unknown content keys are carried through an edit untouched.

## Tests
- **`docs/review/library_s2_ui_test.mjs`: 46/46, exit 0.**
  - It bundles the real `src/App.jsx` with fakes for supabase, NoirDialogs (confirm recorded and answerable), ConfirmDestructive and apiBase.
  - It covers the curator's reads, writes, confirms, validation, preview and error paths; From B4C; the picker and the after-pull focus; and the source fences.
- **Suite:** 68 files. Red is counted by exit code. After the two fixes below, every file exits 0.
  - **Stale fence fixed:** `csp_realtime_wss_test.mjs` diffed against the working tree, so it went red as soon as a later slice touched `src/`. It's now pinned to its released range `cdf1d37..37e3527` (gate PASS @37e3527).
  - **Environment:** the new worktree needed its `node_modules` link (ignored, not committed). `m7_jspdf` and `xss_m1m2` read packages from it.
- **Build:** `vite build` exits 0. It was compiled with placeholder env vars only as a compile check; nothing from that build ships.

## Invariants
- verified counts: App.jsx 132 · digest 32 · assistant 14, unchanged;
- Notify held (`api/notify-session.js` absent);
- `api/_cron.js` and `vercel.json` byte-identical to `37e3527`;
- no RLS, grant or SQL change;
- `PA_NAV` unchanged.

## After gate PASS (on Ashlea's go)
1. Pin `library_s2_ui_test.mjs`'s `REV` to the passed sha, then merge to main and push.
2. Served-verify `version.json`.
3. **Ashlea's live check, signed in as Project Admin:**
   - add a test drill and preview it;
   - publish it, and see it under From B4C in a department;
   - add it to plans and pick a category;
   - withdraw it, and confirm the department copy stays.
