# B4C — Training Library folded into Training — DRAFT (client only). Not reviewed, not promoted.

**Branch:** `feat/library-fold` off main `291013e` (industrial-noir-45).
**Scope:** only `src/App.jsx` at runtime. No SQL, API or vercel.json change.
**Invariants:** verified 132, or 108 raw, unchanged before and after. Notify held.

## Step 0 (read-only, live 2026-10-28)
`departments.disabled_modules` is `[]` for all 5 departments: B4C Demo, Granbury, Indian Harbor, Lipan, North Hood. No
department hides Library or Training today, so **the blast radius is none**. Nobody newly sees a Library tab they had
switched off. No data edit.

## The change (`src/App.jsx`)
1. **NAV:** the `{ key: "library", label: "Training Library" }` entry is removed. Its dashboard Quick Access tile derives
   from NAV, so it goes with it. The orphaned `QUICK.library` blurb is removed too.
2. **TOGGLEABLE_MODULES:** `"library"` is removed, so Library is always on wherever Training is. A leftover `"library"`
   in `disabled_modules` is ignored. The Settings → Module visibility list loses its Library row automatically, because
   that list iterates `TOGGLEABLE_MODULES`.
3. **SCREEN_PARENT** goes from `{ packet: "library" }` to **`{ library: "training", packet: "training" }`**.
   - The `library` entry goes beyond the directive, and is required. Without it, the alias would have **no** module
     gate once it left `TOGGLEABLE_MODULES`.
   - A department with Training switched off could then reach the Library through a deep link, `go("library")` or a
     restored screen. Now the alias follows Training's toggle and is bounced to the dashboard.
4. **Sidebar active state** becomes `screen === n.key || SCREEN_PARENT[screen] === n.key`. Training lights up on
   `library` and on `packet`, so a highlighted parent always exists.
5. **Ask B4C `canOpen`:** it resolves `SCREEN_PARENT[k] || k` before checking NAV and roles.
   - Otherwise the assistant's `open_screen("library")` would be refused, because there's no NAV row any more.
   - It now opens wherever Training is reachable. Both have the same `ROLES`.
6. **Kept:** the `"library"` screen alias. It renders `<Training initialView="library">`, `key={screen}`. Packet
   "Back to library" still goes to `setScreen("library")`, and so does the stale-packet redirect.
7. **Copy:**
   - `"…attach it from the Library."` becomes **`"…attach it from Training Plans."`** That toast was about the *plan*
     library, and the hand-off returns to the Training Plans tab. "Library" now means the drill-catalog tab, so the old
     wording would send people to the wrong tab.
   - PA Admin sub: "The Training Library is now…" becomes "The drill library (Training → Library tab) is now…".
   - Comments that described the nav entry are updated.
   - The quoted "Published. Check the Training Library." isn't in the current source. No string literal in `src/` says
     "Training Library" any more.

## Findings worth knowing
- **No dashboard opens a packet today.** `Dashboard` receives `library` and `openPacket`, but every variant (Member, DA,
  Officer, Board, PA) ignores them. The only `openPacket(...)` calls are in the Library tab: the spotlight and run cards.
  The "reachable from the dashboard" comment was stale and is corrected. So the real packet path is
  Training → Library → packet → Back.
- **Not changed (API is out of scope):** `api/assistant.js` `SCREENS.library = "Training Library"` is the label the AI
  uses for that screen. It still works, because the client now allows it via the parent. Renaming it to e.g.
  "Training → Library" belongs in a future API slice.

## Verification — `docs/review/library_fold_test.mjs`: 23/0
This renders the **real** `<App/>` (sidebar, router, Training, Library, Packet) in happy-dom as a signed-in DA, with a
fake Supabase. It checks:
- The sidebar has no "Training Library", and Training is present.
- Training → Library tab renders the catalog.
- Opening a drill shows the packet with **Training highlighted (exactly one active item)**. Back to library lands on the
  Library tab, with Training highlighted.
- The `library` alias, restored through the same path a post-update reload or deep link takes, lands on the Library tab
  with Training highlighted.
- A department with `"library"` in `disabled_modules` sees the Library tab.
- A department with Training disabled has no Training item, and the alias bounces to the dashboard.
- The source fences hold.

**Mutation check:** with the `library: "training"` parent removed, 4 checks fail. The highlight goes dead (nothing
active) and a Training-disabled department reaches the alias. So the checks have teeth.

**Test-only touch:** `training_slice5_ui_test.mjs` pinned the old toast text. It now expects
"attach it from Training Plans" and passes 40/0.

**Full suite:** 36 files, **998 PASS, 0 FAIL**. `npm run build` (eslint + vite) passes.
