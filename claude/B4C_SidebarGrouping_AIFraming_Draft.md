# B4C: Sidebar grouping + AI framing (Bret's final slice) — DRAFT, NOT deployed

**Branch:** `feat/sidebar-ai-framing`, off main `2f1bf9a` (industrial-noir-63, routing R1).
**Changed:** `src/App.jsx`, `src/Notifications.jsx` (one optional prop), new `src/navGroups.js` and `src/aiFraming.js`, the review test, and this note.
**Untouched (asserted):** `src/router.js`, `src/main.jsx`, `vercel.json`, `api/`, `shared/`, `go()`.

## 1. Sidebar grouping

**What it is:** presentation only. The sidebar shows the same `visibleNav` items, filtered by the same rules (role, module toggle, the equipment-manager exception, Read & Sign only while something is outstanding). They sit under five headers, with support and admin behind one gear. Every item still calls `go(key)`, so R1's paths, push/replace and Back are unchanged. The phone drawer is the same `<aside>`, so it groups the same way.

### The item map (proposed homes in **bold**, for the gate)
| Group | Items |
|---|---|
| Today | Dashboard, Notifications, Station Duties, **Meetings** |
| Train | Training (Library and its drills light it up), Study Session, Station Q&A |
| People | Roster, New-Member Onboarding, Qualifications, Expirations, **Reports** |
| Station | Apparatus, Equipment, My Equipment, Station Hours, Station Documents, Readiness, Read & Sign, Your Six |
| Outreach | Recruitment, Funding & Events, Public Relations |
| ⚙ gear | Settings & Support, Content Admin, Add Department, **Department (PA)** |

**Questions for the gate:**
- **Meetings → Today.** Meetings are dated events with agendas and minutes, the "what's coming up" kin of Duties. The alternative is People (governance).
- **Reports → People.** Most of the content is about members: training, attendance, hours, compliance, and Board stats. The alternative is Today.
- **Department (the PA's department list) → gear,** alongside the other Project-Admin screens. For a Project-Admin-only user this leaves just Today (Dashboard, Notifications) plus the gear, so their main oversight screen is one click deeper. The alternative is to keep it at the top level for PAs.
- **Notifications is new in the sidebar.** It has no NAV entry; the bell has always been its door. It's listed under Today so its unread count has a header to surface on. It isn't added to NAV, so Quick Access tiles, module toggles and the role guard are unchanged. The bell stays.
- **Library** has had no sidebar entry since the fold (it is Training's tab). It stays that way and lights up Train → Training.

### Behaviour
- **Folding:**
  - Each header folds or unfolds its group. The state is remembered per device in `localStorage` (`b4c_nav_collapsed`); it's a convenience, and blocked or junk storage reads as "everything open".
  - Everything starts open.
  - The group holding the screen on show is always open. Its header is inert, with the title "Holds the screen you're on".
- **Badges:** Read & Sign (outstanding count) and Notifications (your unread count) still show on their items. When their group is folded, the group's total shows on its header.
  - The notification count comes from the bell's own existing read, through a new optional `onCount` prop. There's no second fetch.
- **No empty groups:** a group with no visible items never renders. A Member sees no Outreach; a Project-Admin-only user sees only Today.
  - If a future NAV key isn't in the map, it falls into the last group rather than vanishing, and the test fails until it gets a real home.
- **The gear:** with one item (everyone but a Project Admin: Settings & Support) it's a plain entry; with more it's a "Settings & admin" menu, open whenever it holds the screen on show.

## 2. AI framing

- **The Station Q&A count.** The classifier is `documents.type`, the "Document type" picked at upload. "SOP / SOG", and bare "SOP"/"SOG" on older rows, count as SOP/SOG. Forms, Reference, Handbook, Policy, Agreement and Other are counted as station documents.
  - **The header now reads, for example:** "Reading 1 SOP/SOG document and 2 other station documents". With no SOPs it says "Reading N station documents", and the chip says "Document-grounded" rather than "SOP-grounded". An answer citing a non-SOP document is chipped "From your documents".
  - **Every document is still read;** only the label changed. The file name is never used.
  - **Known limit:** the upload picker defaults to "SOP / SOG", so a form uploaded without changing the type counts as an SOP. That is a data-entry fix (re-type it in Station Documents), not something to guess at here.
- **The Q&A wait.** `/api/claude` doesn't stream, so there are staged status lines by elapsed time, in a `role="status"` polite live region:
  1. "Sending your question…"
  2. "Reading your N station documents…" (or "Working through your question…" when there are none)
  3. "Writing the answer…"
  4. "Still writing — longer answers can take up to half a minute."

  No percentages and no promised finish time. No streaming infrastructure was built.
- **Drafter prefill**, from data the app already holds (the department row, the roster, the loaded sessions). There's no new read, and nothing per keystroke. A field fills only until the person types in it.
  - **Recruitment:**
    - **Town:** from the department's city.
    - **Department size:** the shared headcount (Active + Probationary; not Inactive, PA or test). It used to start at a made-up "14".
    - **Key local dates:** "Our next meeting: …" and "Our next training night: … (title)".
    - **Public sessions only:** past, cancelled and leadership-only sessions are skipped, so officer-only meetings never reach public copy.
    - When nothing is known, the prompt says "(not given)" instead of inventing a value.
  - **Public Relations:** the caption topic becomes the next public training night (the old example text when there is none). The prompt now also carries the department's name and town.
- **The AI note.** One plain line, "Written by AI — it can be wrong. Check it against your department's SOPs before you use it.", with a **more** toggle. "more" shows the full terms and links to "How we use AI" (b4thecall.com/legal/responsible-ai, the page Settings → Legal & trust already links).
  - **Where it appears:** on 17 AI-output surfaces:
    - Study Session and Station Q&A;
    - the drill-plan panel and the plan viewer;
    - the Recruitment plan and Station Documents drafter;
    - PR captions;
    - Funding (fundraiser HQ and appeals);
    - cert and report narratives;
    - maintenance;
    - Meetings minutes and agenda;
    - Onboarding;
    - Ask B4C;
    - the dashboard's insight drafts.
  - **Packets keep the long paragraph:** library drill packets are written content, not AI output.
  - **No note on the Training Plans "Draft with AI" flow:** it writes straight into the drill-plan editor, where officers edit and approve the plan, and the note shows when that plan is viewed (plan viewer).

## Proof: `sidebar_ai_framing_test.mjs`, 91/91
Covers the item map, grouping per role (Member / Department Admin / Project-Admin-only), fold and remember, the pinned active group, header badges, routing fences (router/main/vercel/appUpdate/pendingScan/deeplink and `go()` byte-identical; grouped items push their R1 paths), the SOP classification and live header, the staged wait, prefill values landing in the fields, and the AI note on every listed surface.

**Mutations caught** (one at a time, each reverted):
- not pinning the active group fails 1 check;
- badges on open headers only fails 3;
- every document being an SOP fails 6;
- rendering empty groups fails 4;
- Recruitment ignoring the prefill fails 1.

**Also checked in real Chrome** (dev harness, fake backend): the grouping renders, a folded Today shows the unread count on its header, the fold survives a reload, and Recruitment prefills town and size.

## Two existing guards re-ruled (narrowly, for the gate)
- **`ai_drafting_sliceB_test`.** "AiPlanViewer is byte-identical to aed762f's" became "AiPlanViewer is aed762f's with exactly one swap: `<Disclaimer S={S} compact dark />` → `<AiNote />`". The swap string must occur exactly once in aed762f's version. `serializeDrillPlan` stays exactly aed762f's.
- **`xss_m1m2_test`.** The new `href={AI_POLICY_URL}` is classified as a constant, with a new pin that `AI_POLICY_URL` is a `https://b4thecall.com/…` literal. Every other href classification is unchanged.
