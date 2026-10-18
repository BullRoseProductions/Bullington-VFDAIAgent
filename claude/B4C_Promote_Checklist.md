# B4C — Reskin → Production: Walkthrough & Promote Checklist

*Everything is built and gate-passed on `theme/industrial-noir`. NOTHING is promoted. This is the path from preview to the live web, then the native app. The rule holds: nothing is called "live" until the served production bundle is verified.*

## Step 1 — Ashlea walks the preview (the gate — visual proof)
Sign in on the preview build and actually click INTO things, not just glance at the nav. You're looking for: the Industrial Noir look holding, no Times-font modals, no broken/empty states, nothing that reads wrong.

Hit these, opening detail views + modals as you go:
- **Reports:** the hub, then open each — Chief's Report (check the funding "Include in report" toggle), Attendance, Action Items, Station Hours (click a day → the day detail), Capital Plan (the depreciation card), Apparatus Checks (the search + type chips + sticky bar), + Board Stats.
- **Meetings → Minutes:** the grouped/collapsed saved list, the drafter's meeting picker + "starting from" strip, a saved-minutes row's **Assign to meeting** chip.
- **Member & support:** Station Q&A, Study Session, Your Six, Your person, Brand Kit, Settings & Support hub → Support & Contact + About, After-Call Checklist settings.
- **Admin / ops:** Project Admin radar, Pending certs queue, the Finalize & lock confirm (on a session), a Truck check.
- **Core + polish:** Dashboard, Notifications, Recruitment, Public Relations, both Meetings tabs, Training AI draft, My Station Hours.

**Watch-list (known, not bugs):**
- Funding / Reports / some modules are OFF for North Hood — enable them for NHC, or walk a department that has them on, or you won't see those pages.
- AI outputs (the Q&A answer cards, the scored quiz, the AI minutes draft) are blank on preview **by design** — preview has no AI key. Those get verified on production in Step 3.

Flag anything that looks off and I'll turn it around before we promote.

## Step 2 — Promote to the web
Once you're happy with Step 1:
1. **CC merges `theme/industrial-noir` → `main`** (this is the "commit it" — making it official).
2. The web deploy goes out (Vercel on merge to main).
3. **Claude verifies the SERVED production bundle** — I confirm the live site is actually serving the reskin (not just that the branch merged). This is the line between "merged" and "live." I don't call it live until this passes.
4. **Rollback stays armed** — if anything's wrong on prod, we revert fast.

## Step 3 — Production-only checks (right after promote)
These couldn't be proven on preview (no AI key / they write live data). Do them once on prod, then they're truly proven:
- Run **one AI minutes draft** (Meetings → Minutes drafter) — confirms the grounded prompt works live.
- Make **one real Minutes → meeting assignment**, confirm the chip, then remove it.
- The **business-meeting flow:** flag an "everyone" session as a meeting → assign its minutes → remove.
- Spot-check a **Station Q&A** answer and a **Study Session** quiz now that the AI key is live.

## Step 4 — Native app (separate, after the web is solid)
- **Build 12** → your **TestFlight geofence test on a real iPhone** (the one you need to actually run).
- Resubmit to the App Store with the parked 2.5.4 notes (build 12 already archived, `location` mode removed).

## Parked for after promote
- Make NHCVFD's 4 Word documents AI-readable (it's a `.docx`-not-extracted gap, not OCR — the fix + the small code change are scoped and waiting).
- Security-tail hardening (minutes RLS gate, board-agenda visibility).
- The remaining queued builds.

*The honest status line stays: it's "live" only after Step 2.3 (served-bundle verify) passes — not when it merges.*
