# B4C Phase 3.1 #2 — Probation UI — Review Record

**Reviewer:** Claude (gate review) · **Date:** 2026-10-18
**Target:** `docs/review/probation_ui_DIFF.patch` (826 lines) · commit `3fb42f6` on `theme/industrial-noir` (pushed, preview up, **not promoted**)
**DB layer:** `sql/probation_2026-10-18.sql` — applied + RETEST 56/0/7 (live), reviewed separately.
**Status:** **CODE REVIEW PASS** for the DA/Officer flows (before Ashlea's §6 acceptance run + promote). Live preview visual spot-check confirmed "Gate not configured" renders with honest/neutral copy; milestone rail computes real due dates; supervised log shows honest 0 hr.

## What was verified against the build order's hard rules
- **Honest defaults** — unconfigured gate reads "Gate not configured" (never "cleared"), identically on the member path, the dashboard card, and the board chip (all read `gate.configured`). No start date → "Probation start not set," never a made-up day count (`day_n` shown only when `started_on && day_n != null`).
- **Legacy ticks** — "Done — sign-off not recorded" (both the `done_unrecorded` state and the `onboardingSignedLine` fallback when `checked_by` is null). No backfill.
- **No PII** — items are status-only; milestone note labeled "no personal records"; supervised log carries only type/hours/date/apparatus/supervisor/note. No file/number/license/medical field anywhere.
- **Custody (UI, not just RPC)** — `isSelf` suppresses sign/log/void on your own record (with an explanatory line); supervisor picker excludes both the caller and the member; probation-start field gated to Department Admin **and** not-self. RPCs remain authoritative.
- **RPC contract** — reads via `my_probation_status` / `member_probation_status` / `dept_probation_board`; writes via `set_member_probation`, `set_probation_milestone`, `log_supervised_session`, `void_supervised_session`, plus unchanged `set_onboarding_item` for manual ticks. Signatures and arg names all correct. Hours validated 0<h≤24 (matches DB); item hours_target 0<t≤10000 (matches DB).
- **Role gates** mirror the DB: milestones/items `canManage` (Board/DA/Officer); supervised log/void `CANMANAGE_OPS_ROLES` (DA/Officer); start-date Department Admin only; item config `DEPT_ADMIN_ROLES`.
- **Safe** — `onboarding_progress` REVOKE untouched; DA ticking preserved; `verified` never referenced; no feature flag / cron.

## Fixes passed back to CC
1. **Fix before promote (small). [DONE in the toggle pass — `ProbationBoard` now gated `!editMode && probOn && canSign`.]** `ProbationBoard` rendered for anyone on the Onboarding officer screen, but `dept_probation_board()` is `is_canmanage()`-gated. A pure **Project Admin** (reaches that screen via `isDeptAdmin`) got a permanent "Couldn't load the probation board — Retry" error card that can never succeed.
2. **Minor.** Same PA case — the per-member path panels (gate banner, reviews, supervised log) silently don't render for a PA because `member_probation_status` is leadership-gated. Fails closed; acceptable, but a PA can configure the gate without seeing the resulting member path.
3. **Minor.** The overview progress ring for a *non-featured* probationary member can briefly undercount auto-satisfied (ack/hours/cert) items until `dept_probation_board()` returns (the fallback counts only manual progress rows). Self-heals on load.

None of the three block a DA/Officer acceptance run.

## Remaining before "live"
- Ashlea's §6 acceptance run — real logins in separate browsers (DA + member, IH/NH), on a throwaway test member (the preview shares the live DB; logged time can only be voided, never deleted).
- Then promote (theme → main, served-bundle verify per `B4C_Promote_Checklist.md`), Notify Crew excluded.
