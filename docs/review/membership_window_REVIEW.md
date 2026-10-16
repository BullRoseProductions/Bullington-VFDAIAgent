# Membership window — review record

**Verdict: PASS (exemplary)**, from the Claude gate review recorded on 2026-10-16. It covers:

- the migration: `sql/membership_window_2026-10-16.sql`
- the RETEST: `sql/membership_window_RETEST.sql`
- the cleanup: `sql/membership_window_cleanup_PREVIEW.sql`, `sql/membership_window_cleanup_PREVIEW_compact.sql` and `sql/membership_window_cleanup_2026-10-16.sql`
- the client's backend wiring

**Process note from the reviewer:** the migration and the cleanup were applied by hand *before* this PASS was recorded. Both came out clean, but this is the third or fourth time it has happened. From now on, the recorded PASS lands **before** anything is applied.

## Applied on live (2026-10-16, by hand)

| Step | Result |
|---|---|
| Migration | Every value in the state check is as expected: `rls_on` true · 0 policies · 0 rows · `anon_execute` false · `auth_window_execute` false · `auth_select` false · 2 triggers · 157 policies (unchanged). |
| RETEST | 50 passed, 0 failed, 8 skipped. V5 (a Project Admin is refused) was skipped in every department, because no Project Admin without Department Admin exists on live. The exclusion is proven only by the PGlite mutation run. |
| Preview (compact) | prejoin 1 (Kai Newton: joined 2026-10-08, recorded on the 2026-09-18 drill) · postexit 0 · Paul Stetzel certs 41 · Paul matches exactly 1 member. |
| Cleanup | `paul_terminated_on` 2026-10-09 · `paul_certs` 0 · `prejoin_left` 0 · `postexit_left` 0 · `paul_attendance_kept` 11. |

## Follow-ups

- **Jared Allen — CLOSED 2026-10-16, nothing to delete.** His join date of 2026-08-06 is on file, and exactly one member has his name. The full preview re-ran with prejoin 0, postexit 0 and Paul certs 0. `sql/jared_allen_window_CHECK.sql` shows his 5 recorded drills (8/20, 8/27, 9/10, 9/18, 10/8), all on or after Aug 6. The early drills seen on screen were most likely the roster listing him as absent at pre-join drills, which "Joined later" now handles. No second cleanup pass was written.
- **Other former members.** The Department Admin records them in Settings & Support › Admin › Former members, then we run one more preview → cleanup pass for their post-exit rows.
- **Paul's 41 proof files.** The reviewer asked for these to be deleted from storage. They are **HELD**, because `approve_cert_submission` copies the *submission's* `proof_path` onto the cert, so each file is the same object the kept cert submission points at. Deleting the files would break his submission history, which the brief says to keep. Waiting on Ashlea's decision.
- **Client.** The termination control moved to Settings & Support › Admin › Former members (Department Admin only), relabelled "Former member", with Reactivate. That is commit `548100f`, together with `097f813`. **Live on production 2026-10-16** as release `0eb2e7a` ("Release industrial-noir-6"); `version.json` serves `{"build":"0eb2e7a"}`. Rollback is `9e6d6ea`. Notify crew is still held back: it is absent from the bundle and `/api/notify-session` returns 404.
