# B4C Phase 3.1 — Member Readiness & Qualification (Concept)

**Status:** Concept — mocks built & **approved by Ashlea 2026-10-17**. Not yet scoped as a CC build order.
**Source:** Tommy (Department Admin, Indian Harbor VFD) requests + Claude additions, 2026-10-17.
**One-line:** B4C already answers "is the *department* ready." Phase 3.1 extends that to the person — "is *this member* qualified to do what we need, and can we prove it." Person-level readiness, built as one module, not scattered features.

**Approved mocks (claude/mocks/, Industrial Noir, phone-width):**
- `B4C_Phase3.1_ReadSign_Mock.html` — read & attest, version-locked, re-sign on change
- `B4C_Phase3.1_Probation_Mock.html` — onboarding → cleared-to-run gate + probation lifecycle + milestones
- `B4C_Phase3.1_Qualifications_Mock.html` — who-can-do-what matrix + per-apparatus driver check-offs + drive log
- `B4C_Phase3.1_Scorecard_Mock.html` — per-member "is this person current" verdict
- `B4C_Phase3.1_Expirations_Mock.html` — department-wide expiry dashboard + push reminders

---

## Source — Tommy's four asks

1. **Onboarding** — everything that must be done before a recruit can start running calls.
2. **Probationary period** — a list of items to complete before the end of the 6-month probation; sets expectations up front.
3. **Driver / apparatus check-offs** — officers can see who is checked off on which vehicle, plus a way to **log drives**.
4. **Read-and-sign** — members read and sign SOPs, SOGs, and other required documents the department attaches (e.g., driving policy).

---

## Design guardrail (non-negotiable — Ashlea)

**B4C stores the compliance TRAIL, never the sensitive document.** Who, what, which version, when, who verified — dates and statuses only. No license scans/numbers, no medical records, no background-check contents. Department documents (SOPs/SOGs) are fine to store (already are, for Ask B4C). This keeps B4C out of the PII-breach-liability business and in its lane (readiness & accountability, not HR document storage). Every approved mock shows this explicitly in-screen ("status only · no record stored," "date only," "class only").

---

## Feature set (grouped)

**A. Onboarding → cleared-to-run (extends #1)**
- Required-items list to go from recruit → cleared to run calls; gate: not "active/running" until complete.
- Item types: in-app acknowledgments (SOPs), officer-verified sign-offs (personal paperwork — *status only, no file*), training/cert prerequisites.

**B. Probation lifecycle (extends #2)**
- Probation task list with the 6-month target; expectations visible from day one.
- Milestone evaluations (30/60/90-day, 6-mo): on-track / needs-work + officer sign-off.
- FTO / ride-along log (supervised shifts & calls); mentor/FTO assignment.
- Auto-flag the board when all items are done → vote off probation (drives the existing Active/Probationary status).

**C. Qualification matrix + driver quals (extends #3)**
- "Who can do what" grid: driver/operator *per apparatus*, pump operator, interior firefighter, officer-in-charge, EMS lead, etc. Tommy's apparatus check-offs are rows of this.
- Supervised-hours / drive log counting toward a qualification threshold; officer signs off when met.
- License + DOT medical-card **expiry** (date + class only — *never number or scan*) → readiness flag when lapsing.

**D. Read-and-sign documents (extends #4 — the compliance piece)**
- In-app read + attest for SOPs/SOGs/policies; version-locked, timestamped, immutable (store the document hash at time of signing).
- Role-based required reading (drivers sign the driving policy; officers sign the command policy).
- Re-acknowledgment on version change + annual re-sign for policies that need it.
- Acknowledgment-gated quals (can't be driver-qualified until the driving policy is signed).

**E. Payoff layer (makes it audit-grade and sellable)**
- Per-member **readiness scorecard** — quals, certs, acknowledgments, expirations, hours in one "is this person current" view.
- One **expirations dashboard** — certs, licenses, med cards, fit tests, gear — with push reminders (push already exists).
- **One-click audit / ISO packet** export (Reports hub) — the night-before-the-ISO-visit report that justifies the whole module.

**Adjacent (optional, same module)**
- Turnout gear / PPE lifecycle (NFPA 1851 — 10-yr gear life + annual inspection; dates only).
- Apparatus annual testing (pump / ladder / hose) beyond the daily truck check.

---

## How it fits what already exists (quick wins)

- **Onboarding checklist** already has "SOG & policy acknowledgment signed," "Background / driving-record consent signed," etc. — convert these honor-system checkboxes into real acknowledgments / officer sign-offs.
- **Station Documents** already stores SOPs (`content_text`) — add a "requires acknowledgment" flag + a version per document.
- **Certs / expiring-certs** logic already exists — generalize it into the expirations dashboard.
- **Apparatus** module exists — the qualification matrix, gear, and testing hang off it.
- **Member status** (Active / Probationary / Inactive) exists — the probation lifecycle drives the flip.

---

## Data sketch (fits the locked-table / RPC-only security model)

All RLS-locked, department-scoped, `verified`-flag discipline preserved; RPC-only writes.

- `member_qualifications` (member, qual_type, apparatus_id?, status, signed_off_by, at)
- `document_acknowledgments` (member, document_id, doc_version/hash, signed_at, method) — append-only
- `onboarding_items` / `probation_items` (member, item, status, verified_by, at, due)
- `member_credentials` (member, type = license / medcard / fit_test, class, expires_on) — **DATE ONLY**, no numbers/images
- `drive_log` / `supervised_hours` (member, apparatus?, date, supervisor, counts_toward)

---

## Suggested build order within 3.1

1. **Read-and-sign (SOP/SOG acknowledgment)** — cleanest, no PII, the hooks already exist. (The compliance piece Tommy asked for.)
2. **Onboarding / probation checklist** + the cleared-to-run gate + officer sign-offs.
3. **Qualification matrix + driver check-offs + drive log.**
4. **Expirations dashboard** + credential-date tracking + reminders.
5. **Audit / ISO packet export.**
6. (Optional, later) Gear lifecycle + apparatus annual testing.

---

## Open questions

- Personal-paperwork sign-off: simple "complete → verified → dated," or also a "filed at [reference]" pointer? (No file stored either way.)
- License / med-card expiry: **tentatively IN scope, date + class only** — the approved mocks include it (scorecard + expirations). Confirm before building.
- Legal-grade e-sign for consent forms: in-app ESIGN/UETA-compliant flow, a DocuSign handoff the department owns, or out of scope?
- Does this generalize beyond Indian Harbor — which other departments have asked? (Decides how configurable vs. opinionated to build it.)
- Build wedge: lead with Read-and-sign (cleanest, PII-free) unless Tommy's loudest pain is driver check-offs.
