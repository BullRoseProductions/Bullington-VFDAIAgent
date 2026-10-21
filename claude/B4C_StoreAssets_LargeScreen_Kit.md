# B4C — Large-Screen Store Asset Kit (Play + App Store + Website)

*Oct 20, 2026. What to capture, at what size, for each surface. B4C is a responsive web app, so every "desktop/large-screen" asset is just the app captured at a wide window — you don't need a separate build.*

---

## Part 1 — The shot list (what to capture)

Lead with oversight and accountability — the stuff that makes a chief go "that solves my problem." Raw screenshots work; a short benefit caption across the top of each (big, legible) converts better. Capture in **landscape** for large screens.

| # | Screen | Why it sells | Suggested caption |
|---|--------|--------------|-------------------|
| 1 | **Program Oversight dashboard** ("Every department, at a glance") | The money shot — multi-department health, stat tiles, "needs attention" cards. The whole pitch in one view. | "Catch problems before anyone reports them." |
| 2 | **Readiness Scorecard** (feature #5) | Member readiness at a glance — the ISO / accountability story. | "Know who's ready for the call." |
| 3 | **Expirations** (certs dashboard) | The compliance pain it kills — expired / expiring certs, surfaced. | "No more expired certs slipping through." |
| 4 | **Roster** | Wide member table shines on a big screen; shows depth. | "Your whole crew, current and clear." |
| 5 | **Reports** (Chief report or board stats) | The artifact you hand the board / ISO — authoritative at desktop width. | "Board-ready reports in one click." |
| 6 | **New-Member Onboarding** (item config + sign-off) | Structured onboarding with real sign-off — shows rigor. | "Onboard new members the right way." |
| 7 | **Apparatus / Equipment** (truck checks) | Daily-ops angle for the rank-and-file, not just admins. | "Truck checks that actually get done." |

**Use 3–5 strong ones per listing, not all 8.** The first screenshot does ~80% of the work — make it #1. Order: 1 → 2 → 3 → 5 → 4.

> Avoid any screen showing a real member's personal contact info or anything sensitive — use the Demo Department, or blur names. The dashboard's "needs attention" demo data is perfect for this.

---

## Part 2 — Exact specs per surface

### A) Google Play — large-screen slots (in the listing editor you're already in)
Below the phone screenshots: **7-inch tablet**, **10-inch tablet**, **Chromebook**. Fill at least the tablet + Chromebook slots or Play flags the app "not optimized for large screens."
- **Format:** PNG or JPEG, **no transparency**.
- **Size:** each side **1080–3840px**; the long side no more than 2× the short side. **1920 × 1080 (16:9 landscape)** is the safe, great-looking default — use it for all three large-screen slots.
- **Count:** up to 8 per slot; **3–5** is plenty.
- **Feature graphic** (shared, required): **1024 × 500**, PNG/JPEG no alpha. (This is the banner — a branded B4C title card, not a screenshot.)

### B) Apple App Store — iPad (its own slots, separate from iPhone)
As of now Apple requires **one iPad set at the 13-inch size** and scales it down for smaller iPads.
- **Size:** **2064 × 2752** (portrait) or **2752 × 2064** (landscape) for 13-inch iPad. The older 12.9-inch size (**2048 × 2732 / 2732 × 2048**) is also accepted.
- **Format:** PNG or JPEG, **RGB, flattened, no transparency, no rounded corners** (capture the raw app, don't add a device frame for the store slot).
- **Count:** up to **10** per localization. Use the same 3–5 shots as Play, re-captured at iPad size.
- Landscape is fine and recommended for B4C's wide views.

### C) Website / marketing (no fixed spec — make them look good)
- **Hero / feature shots:** capture at **2× for retina** — **2560 × 1440** (or 1920 × 1080) wide. Shot #1 (the oversight dashboard) is your hero.
- **Device framing:** for the website you *can* drop these into a laptop/browser mockup frame (unlike the app-store slots, which want raw). Optional.
- **One-pager / sales deck:** the same captures at 1920 × 1080 slot straight into slides.

---

## Part 3 — How to capture them cleanly

B4C is responsive, so you capture the **desktop web app at the target pixel size** — no device needed (though a real iPad capture for the Apple set is also fine).

1. **Chrome → DevTools (⌥⌘I) → device toolbar (⌘⇧M) → "Responsive"**, then type the exact pixel size (e.g. 2752 × 2064 for iPad landscape, 1920 × 1080 for Play/web). Set DPR to 1 so the capture is exactly those pixels.
2. Navigate to the screen, get it into a clean state (Demo Department data, nothing sensitive on screen).
3. DevTools **⋮ menu → "Capture screenshot"** (or Cmd-Shift-P → "Capture screenshot") → gives you a PNG at exactly that resolution.
4. For the **feature graphic** (1024 × 500) and any captioned versions, drop the raw screenshot into Canva / your tool, add the B4C title + caption on the Industrial-Noir black, export at the exact size.
5. Name them by surface + screen (`play_chromebook_01_oversight.png`, `ios_ipad_01_oversight.png`) so the right file goes in the right slot.

**One capture session covers all three** if you shoot at the largest size (2752 × 2064) and downscale for Play/web — but cleanest is to capture each surface at its own native size so nothing's soft.

---

## Checklist
- [ ] Capture shots 1–5 at **1920 × 1080** → Play 10"/7"/Chromebook slots (3–5 each)
- [ ] Capture shots 1–5 at **2752 × 2064** → App Store iPad slots
- [ ] Build **1024 × 500** feature graphic (branded title card)
- [ ] Capture shot #1 at **2560 × 1440** → website hero
- [ ] No sensitive/real member data in any shot (use Demo Department)
- [ ] Save per-surface listing changes → content review (quick), current images stay live until approved

---

*Tie-in: the desktop-width fix (raising the content cap from 1080 → ~1600) makes these desktop captures look even better — more of the oversight grid on screen. Capture after that ships if you want the fullest-looking shots. See [[B4C_Desktop_Width_BuildOrder]].*
