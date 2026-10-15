# Industrial Noir — completeness audit (2026-10-13)

Read-only audit of `theme/industrial-noir` (src/App.jsx + Login / SetPassword / main / Notifications /
ConfirmDestructive). Nothing was changed. Line numbers are approximate (src/App.jsx unless noted) and
drift as the file changes.

**Legend:** yes = Noir done · partial = mostly Noir, one leftover (usually a token swap) · FLAT = old look ·
missing = the state doesn't exist (not a styling issue).
**Fix class:** SIMPLE = token / kit-piece swap I can apply · MOCK = layout-heavy, waits for a Claude mock ·
KIT = blocked on one shared kit decision, then simple everywhere.

---

## A. Shared kit pieces — fix once, cascades everywhere

| piece | where it shows | status | fix |
|---|---|---|---|
| Form fields: `S.field` / `S.fieldLabel` + `FS.input` (FIRE.card face, 0.5px border) | ~every inline form in the app | partial | KIT — add one Noir field token (card2Noir + line2Noir + Oswald label, as the rebuilt Issue / Add-units modals already use), then swap |
| `FS.btn` / `FS.row` 0.5px hairlines | buttons + list rows app-wide | partial | KIT — lineNoir row token; most "partial" rows below clear with it |
| `RichOutput` (dark) — FS.card + hairline title | every AI answer: Study, Q&A, Documents draft, plan viewer, Recruitment, PR, Minutes, Fundraisers, Chief's report, renewal drafts, onboarding AI | FLAT | SIMPLE — one component |
| `confirmDestructive` (src/ConfirmDestructive.jsx ~146/188) — hard-coded #13161B, system font, 0.5px | every delete confirm app-wide | partial | SIMPLE — tokens + Oswald header (copy the Issue-modal header) |
| **No Noir confirm dialog** for non-destructive confirms | ~20 `window.confirm` call sites (list in §C) | FLAT | KIT/MOCK — one shared dialog design, then each swap is simple |
| **No Noir prompt (text-input) dialog** | Reject cert reason, Rename onboarding category, Finalize-session length, Fundraiser HQ + Action item "no longer needed" reason | FLAT | MOCK — one shared design |
| `DocViewer` (proof / file plan viewer) | member file, certs, pending queue, training plans, dashboards, Documents | FLAT | SIMPLE |
| `AiPlanViewer` / `SessionPlanChooser` (usePlanViewer mounts — FS.card, rendered outside NoirSkin in member view) | Training both views, dashboards | FLAT | SIMPLE |
| `MonthCalendar` without `tiles` | dashboards' station calendar, Recruitment, Public Relations, Funding calendars | FLAT | SIMPLE — pass `tiles` |
| `<Stat dark>` (always FS.card) | Station Hours Report tiles, Yearly attendance, Chief's report | FLAT | SIMPLE — swap to StatTile |
| `S.aiBanner` — purple-grey 4px left edge leaks through cardNoir | Recruitment, PR, Minutes, Fundraisers, Chief's report | partial | SIMPLE |
| `GraphicStudio` | Recruitment, Public Relations | FLAT | SIMPLE |
| Mono `Pill` (S.opChip) | PersonalView cert chips, maintenance chips, Fundraisers "DONE", Apparatus-checks report PASS/FAIL | FLAT | SIMPLE (npill / ResultBadge) |
| Announcements feed + composer (all 4 dashboards, outside NoirSkin) | dashboards | FLAT | SIMPLE |
| `DeptCrest` (FIRE.card + hairline) | dashboard heroes, PA radar | FLAT | SIMPLE |
| Disclaimer strip (btnBg + hairline) | Packet, Study, Q&A, Documents, planner | partial | SIMPLE |

## B. Per page — everything not already "yes"

(Pages/aspects already Noir are summarised in one line each at the end of §B.)

### Dashboards & app chrome
| page | aspect | Noir? | note | fix |
|---|---|---|---|---|
| All dashboards | Announcements feed shell, rows, chips, loading/empty, composer, expiry editor | FLAT | FS.card + FS.kicker "FEED", hairlines, plain text states (~3321–3410) | SIMPLE |
| All dashboards | Birthdays & anniversaries | FLAT | FS.kicker + emoji heading, hairline (~3410) | SIMPLE |
| All dashboards | Station calendar header / grid / importance list / empty / event modal | FLAT | FS.kicker, non-tiles grid, FS.card modal (~6548–6614) | SIMPLE |
| All dashboards | Dashboard-level read errors | missing | Board/DA set loadErr but never render; Officer/Member ignore errors | MOCK (where the error box sits) |
| DA dashboard | "People to reach out to" label; NextLeadershipEventTile (outside NoirSkin); AI draft panel; resolve editor | FLAT/partial | ~3652, 3674, 3778, 3845 | SIMPLE |
| Member dashboard | calendar wrapper (outside NoirSkin); "Get prepared" divider; StationClockCard chip; hours-panel error | FLAT/partial | ~4491, 4448, 4311, 22352 | SIMPLE |
| PersonalView (shared) | cert chips (Pill); "Station duties still open" kicker; list rows | FLAT/partial | ~3081, 3151, FS.row | SIMPLE |
| CertProposals / ActionItemsCard | S.field form; hairline rows + chip | partial | ~4188, 4038 | SIMPLE |
| ProgramOverview / PA radar | non-PA guard card; NoEmailFixPanel | FLAT | ~21162, 21765 | SIMPLE |
| Chrome | sidebar brand/dept card hex borders; top bar border; bell hex | partial | ~22674, 22693, Notifications.jsx 68 | SIMPLE |
| Chrome | **Notifications center page** and **Notification settings page** | FLAT | no PageShell, system font, hex; **Back button uses undefined `S.btn` → unstyled native button (bug)** | MOCK |
| Chrome | in-app crash screen; root crash screen; boot "Loading…" | FLAT/partial | ~321; main.jsx 222, 173 | SIMPLE |
| Chrome | Geofence first-run consent modal (outside NoirSkin) | FLAT | ~2729 / 1013–1061 — legal copy, keep layout | SIMPLE |
| Chrome | CheckinConfirm / HandoffConfirm headings | partial | S.featTitle (~18531/18563) | SIMPLE |
| Login / SetPassword | error/success messages | partial | plain coloured text | SIMPLE |

### People
| page | aspect | Noir? | note | fix |
|---|---|---|---|---|
| Roster | band kicker on Pending tab | partial | falls back to ROSTER/CREW | SIMPLE |
| RosterMembers | Show/Hide inactive toggle | FLAT | S.segBtn pill (~9887) | SIMPLE |
| RosterMembers | Add member form | partial | no CardHead + S.field | SIMPLE |
| RosterPending | queue container/header | FLAT | bare rows on page bg (~10731) | MOCK |
| RosterPending | rows; loading/empty; proof viewer | FLAT | S.certRow hairline; bare text; DocViewer | SIMPLE |
| RosterPending | Reject reason | FLAT | `window.prompt` (~10712) | KIT (prompt dialog) |
| RosterPending | load error | missing | shows "No pending items." on failure | SIMPLE + logic fix |
| RosterCerts | ring cards (inline Oswald titles) | partial | ~10549 | SIMPLE |
| RosterAttendance | AI check-in draft box; whole-tab empty | partial/missing | ~3778; sections vanish | SIMPLE |
| MemberDetail | cert remove confirm | FLAT | `window.confirm` (~10009) → confirmDestructive | SIMPLE |
| MemberDetail | Deactivate / Reactivate confirm | FLAT | `window.confirm` ×2 (~9970) | KIT (confirm dialog) |
| MemberDetail | cert edit / Edit member / ProposeCert forms | partial | S.field | KIT (field) |
| MemberDetail | Member log header outside its Card; hairline rows | partial/FLAT | ~10351–10358 | SIMPLE |
| MemberDetail | Member log load error | missing | blanks on error | logic fix |
| Onboarding | edit-mode rows; category labels; mentor select | FLAT/partial | FS.row hairline, hand-rolled labels | SIMPLE |
| Onboarding | Rename category; Load defaults | FLAT | `window.prompt` / `window.confirm` | KIT |
| Onboarding | items load error | missing | stuck on "Loading checklist…" | logic fix |
| Onboarding | AI error + output | FLAT | plain red text; RichOutput | SIMPLE |

### Training & knowledge
| page | aspect | Noir? | note | fix |
|---|---|---|---|---|
| Training (leader) | AIDrillPlanner form/result panes, error, preview title, toggles, section heads, feedback box | FLAT/partial | S.aiForm / S.errBox / S.featTitle / S.aiListHead (~4959–5184) | SIMPLE |
| Training (leader) | overdue banner; schedule-on-new-date block; tags (audience/optional/off-site) | partial | ~19601, 5159, 18685 | SIMPLE |
| Training (leader) | edit-category / edit-session / plans panel / attendance roll / QR panel — Noir card nested in Noir card | partial | Lcard → NOIR_INSET; PRESENT/ABSENT text → CheckMark | SIMPLE |
| Training (leader) | **Finalize & lock** confirms + length prompt | FLAT | 2× `window.confirm` + `window.prompt` (~19178–19196) | MOCK (closeout sheet) |
| Training (leader) | fullscreen QR overlay | FLAT | system font white text (keep white QR plate) | SIMPLE |
| Training (leader) | AttachAgendaModal; NotifyCrew error | FLAT/partial | FS.card panel; plain red | SIMPLE |
| Training (both) | page loading + error states | missing | `sessionsErr` never surfaced | SIMPLE |
| Training (member) | "Up next for you" label; plan viewer mounts outside NoirSkin | partial/FLAT | ~19380, 19363 | SIMPLE |
| Library → Packet | page frame (no band/NoirSkin) | partial | ~4606 | MOCK (header) |
| Library → Custom packet request page | whole page | FLAT | no PageShell, FS.card | SIMPLE |
| Admin (Publish a packet) | header (no band); success box | FLAT/partial | ~20985, 20995 | SIMPLE |
| StudySession | mode/length segment buttons; section labels | partial | S.segRow; FS.kicker | SIMPLE |
| Documents | upload section/drop zone; list rows; version history; trash rows | partial | hairlines, nested Card | SIMPLE |
| Documents | library loading | missing | empty Card while loading | SIMPLE |
| Documents | Move to trash | FLAT | `window.confirm` | KIT |

### Apparatus & equipment
| page | aspect | Noir? | note | fix |
|---|---|---|---|---|
| Apparatus | check-schedule control; take-out-of-service form; add/edit rig forms | partial | bare inline rows; S.field | SIMPLE / KIT (field) |
| Apparatus | CapitalFields block | FLAT | red FS.kicker "CAPITAL PLANNING", hairline (~13356) | SIMPLE |
| Apparatus | return-to-service, remove rig, remove photo | FLAT | `window.confirm` | KIT |
| Apparatus | recently-removed list; checklist location labels/forms; retired items; LocationPicker | partial/FLAT | hairlines, btnBg | SIMPLE |
| Apparatus | PhotoDotEditor full-screen chrome | FLAT | hard-coded #0b0d10, white/black pills | MOCK |
| Apparatus | PhotoDotEditor bottom sheet | FLAT | FIRE.card + hairline | SIMPLE |
| Apparatus | MaintenancePanel title / list / chips / AI banner | FLAT | FS.kicker, S.certRow, Pill, S.featTitle/S.errBox (~15453–15543) | SIMPLE |
| Apparatus | CheckRunModal header; fail note/footer; photo-mode panel | partial/FLAT | hairlines, FS.btn tabs | SIMPLE |
| Apparatus | CheckRunModal Pass/Fail rows | FLAT | FS.btn opacity toggles | MOCK |
| Apparatus | **AfterCallRun** page (no band, no NoirSkin), run form, history | FLAT | ~13576–13685 | SIMPLE |
| Apparatus | fleet / photos / check-history / service-history / maintenance load + error states | missing | empty flashes while loading; failures read as empty | SIMPLE + logic |
| Equipment | managers bar avatars/assign; pending returns rows | partial | FIRE.card, S.field, hairline | SIMPLE |
| Equipment | ConfirmReturnModal; Recover modal; HandoffModal | partial | no glow header / inset footer; S.field | SIMPLE (copy Issue-modal shell) |
| Equipment | remove manager; mark lost; remove unit photo | FLAT | `window.confirm` | KIT |
| Equipment | unit edit / add type / edit type forms | partial | S.field | KIT (field) |
| Equipment / MyEquipment | registry + My Equipment loading; My Equipment error | missing | empty flashes; failure says "not signed for any equipment" | SIMPLE + logic |
| MyEquipment | transfer native checkbox; HandoffConfirm heading | partial | ~16259, 18563 | SIMPLE |

### Operations & admin
| page | aspect | Noir? | note | fix |
|---|---|---|---|---|
| Station Hours (member) | row dividers; loading | partial | hairlines; blank while loading | SIMPLE |
| Station Hours Report | summary tiles | FLAT | `<Stat dark>` | SIMPLE |
| Station Hours Report | review / open-long / on-now / tables / shift log rows | partial | hairline rows (lines that reference verified stay untouched) | SIMPLE |
| Station Hours Report | reject off-site / void shift | FLAT | `window.confirm` | KIT |
| Station Duties | Checklist/History toggle; rows + chips; history rows | partial | hand pills; FS.row hairline | SIMPLE |
| Station Duties | Clear checkmarks | FLAT | `window.confirm` | KIT |
| Recruitment | AI planner edge; "Ways to recruit" kicker; calendar; GraphicStudio; drafts rows | partial/FLAT | aiBanner, FS.kicker, non-tiles calendar | SIMPLE |
| Public Relations | content calendar grid; AI caption helper; GraphicStudio | FLAT/partial | non-tiles calendar, aiBanner | SIMPLE |
| **Funding hub** | shell (no band/NoirSkin), stats, tiles | FLAT | ~8421–8453 | SIMPLE |
| Fundraisers | frame, index, AI planner, idea bank, calendar, log, drafts | FLAT | FS.card / kicker / segRow / errBox / Pill (~7843–8311) | SIMPLE |
| **Fundraiser HQ** | whole workspace (~20 sections) | FLAT | ~7277–7672 | MOCK (your Funding mock) |
| Fundraiser HQ | review extracted tasks/dates | FLAT | ~7518 | SIMPLE |
| Fundraiser HQ / Minutes | "no longer needed" reason | FLAT | `window.prompt` | KIT (prompt) |
| Donations / Donor detail | frame, funds list, tracker, donor header/stats/history, log touch/gift forms | FLAT | ~8517–9279 | SIMPLE (or with the Funding mock) |
| Meetings | mode switch; action items rows + sub-heads; saved minutes rows; agenda builder legacy styles | FLAT/partial | S.segRow, S.certRow, FS.kicker, S.featTitle, S.errBox | SIMPLE |
| Meetings | delete minutes / agenda | FLAT | `window.confirm` | KIT |
| Reports hub / BoardStats | tile titles; BoardStats no band + hairlines | partial | ~11320, 11514 | SIMPLE |
| Reports → Yearly attendance, Chief's report, Action items, Capital plan, Apparatus checks | whole sub-views | FLAT | hand headers, FS.card, `<Stat dark>`, S.featTitle/S.errBox, Pill, `window.confirm` | SIMPLE (band + NoirSkin + kit swaps) |
| **Settings & Support** hub + every sub-screen (Department settings, StationsAdmin, Brand Kit, Support/requests, person picker, presence consent, after-call checklist setup) | FLAT | no band / NoirSkin, FS.card + kicker | SIMPLE |
| Your Six | shell (no band); reach-out modal headings; resource form | partial | ~737, 767 | SIMPLE |
| Add Department / Department (PA) | no band; hairlines; fallback cards outside NoirSkin | partial/FLAT | ~21069, 21464 | SIMPLE |

**Already Noir (yes) — not repeated above:** every dashboard hero/health charts/Action Center/insights/quick actions,
toasts, update bar, OfflineNotice, Login/SetPassword cards; Roster tabs/members cards/certs/attendance core, member-file
hero/certs/profile/history/readiness/qualified, Onboarding overview/featured/sign-off, MyOnboarding; Training leader
hero/categories/calendar/sessions/NotifyCrew, member Training (all four sections), Library/RunCard, Study/Q&A core,
Documents draft + empty; Apparatus board/rig detail/check history/service history/maintenance log/capital tiles/photo
strip, Equipment registry/open issues/Issue + Add-units modals/custody ledger/aging/by-category, My Equipment cards +
report issue; Station Hours (member) core, Station Hours Report new cards, Station Duties core, Recruitment phases,
PR ideas, Meetings import, Your Six resources.

## C. Not styling — logic issues found along the way
- **Notifications center + settings Back buttons** use `S.btn`, which doesn't exist → unstyled native buttons.
- **Failed reads that render as empty / never show** (against "loaders never blank on error"): RosterPending ("No pending
  items."), Onboarding items (stuck loading), member log (blanks), Training `sessionsErr` (never shown), Board/DA `loadErr`
  (never rendered), Officer/Member dashboard loads, Apparatus photos / check history / service history / maintenance,
  My Equipment ("not signed for any equipment").
- **Training schedule form** shows a "Length (min)" field bound to the *edit-session* state; the edit form has no Length field.
- **Library packet "Download packet (PDF)"** button has no handler.
- **Admin "Publish a packet"** with an empty title publishes silently.
- **Member Training backfill notice** tells members to set a session length, which they can't.
