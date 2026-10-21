# B4C — Large-screen store screenshots: automated capture — for CC

**Goal:** produce the shot-list screens at the exact store pixel sizes, from safe (non-PII) data, and hand the raw PNGs to Claude to size/caption and build the feature graphic. Shot list + specs: [[B4C_StoreAssets_LargeScreen_Kit]].

**Why Playwright, not a real browser window:** headless Chromium can set **any viewport + deviceScaleFactor**, so you get a true 2752×2064 capture regardless of the Mac's actual screen resolution. A real window can't exceed the monitor. Use `page.setViewportSize` + `deviceScaleFactor` and a **viewport** screenshot (`fullPage:false`) so each file is exactly the slot size.

## The screens (5) × the sizes (3) = 15 PNGs
Screens, in order of value (from the kit):
1. **Program Oversight dashboard** ("Every department, at a glance")
2. **Readiness Scorecard** (a member's)
3. **Expirations** dashboard
4. **Reports** → a Chief's Report
5. **Roster**

Sizes (viewport, DPR 1, landscape):
- **1920 × 1080** → Google Play (10"/7"/Chromebook slots)
- **2752 × 2064** → Apple App Store (13" iPad landscape)
- **2560 × 1440** → website hero (shot 1 only is strictly needed, but capture all at this size too; cheap)

Name each `play_1920x1080_01_oversight.png`, `ios_2752x2064_01_oversight.png`, `web_2560x1440_01_oversight.png`, … `_05_roster.png`.

## Two decisions I need from Ashlea before you capture (flag these, don't guess)
1. **Auth.** The app is behind sign-in; neither you nor Claude types Ashlea's real password. Cleanest: Ashlea triggers a **magic-link login to the Demo/test account** (`test@b4c.com`, which lives in the Demo Department) and you drive the headless session from that link, **or** she points you at an already-authenticated browser profile/storage-state. Use whatever she picks; don't store a password.
2. **PII / which data.** Rosters, member names, real expirations = **use the Demo Department** so no real member PII lands in a public store listing. The **one exception is shot #1, Program Oversight**, which is a Project-Admin view spanning all departments — it shows real *department* names and admins (org-level, e.g. "Indian Harbor VFD · Granbury, TX"), not member PII. Ashlea's call: accept the real department names (fine for marketing — they're public orgs) or capture that one on Demo-only data. Everything else: Demo Department.

## Capture notes
- Wait for each screen's data to finish loading (network idle + the key element visible) before the screenshot, so nothing is mid-spinner.
- Dark "Industrial Noir" UI — no special handling, just capture as-is.
- Don't capture any modal/toast open; clean screen state.
- If a screen has its own internal scroll, capture the top (the headline + first cards) — that's the selling part.

## Output / handoff
Save the 15 PNGs into a connected folder so Claude can retrieve them — put them under **`~/projects/Bullington-VFDAIAgent/store-assets/raw/`** (create it; it can be gitignored — these are build artifacts, not source). Tell Claude the path when done.

Then Claude takes over: verify each file is exactly its target pixel size, optionally add the benefit captions from the kit, build the **1024×500 feature graphic** (branded title card), and deliver store-ready assets + a copy back to a folder Ashlea can upload from. **CC does not upload anything to the stores.**
