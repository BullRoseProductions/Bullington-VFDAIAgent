# Standard certs (DB) — live apply + RETEST, 2026-10-23

Review PASS d55e35d (recorded 0d1113b). Applied by Claude in the Supabase SQL editor, project `ifeptqnlucmvhlvadcpj`
(BullRoseProductions's Project, production). The editor text was checked against the file before each run
(SHA-256 prefix: DRAFT `aeba20161e58d788`, RETEST `474273db31979f31`).

## Apply — `sql/standard_certs_DRAFT.sql` — state row

| std_rls | std_policies | std_rows | by_track | rpc_ok | total_policies | locked_token_fns |
|---|---|---|---|---|---|---|
| true | 1 | 69 | cards 8 · ems 5 · sffma 24 · tcfp 32 | true | 171 | 17 |

Every value is the expected one in the file's state-check comment.

## RETEST — `sql/standard_certs_RETEST.sql` (SENTINEL-rolled-back; nothing changed)

```
PASS  S0 master list 69 rows (cards 8 · ems 5 · sffma 24 · tcfp 32); add_standard_cert_type authenticated-only
— B4C Demo Department
   SKIP  all — needs a DA here, a plain member here and a DA of another department, unique emails (DA demo@b4thecall.com, member none, other-dept DA 5@b4thecall.com)
— Granbury Fire Station
   SKIP  all — needs a DA here, a plain member here and a DA of another department, unique emails (DA 5@b4thecall.com, member none, other-dept DA lipanvfd.roger@yahoo.com)
— Indian Harbor Volunteer Fire Department
   PASS  M1 plain member reads all 69 standard rows; an INSERT is refused by RLS, an UPDATE touches 0 rows
   PASS  A3 plain member: add_standard_cert_type refused on authority; nothing added
   PASS  A1 DA adds a never-expires SFFMA + an expiring EMS standard; both in this catalog with the standard's name / flag / category, created_by the DA
   PASS  A2 the same standard twice → "already in your catalog"; an unknown id → "not found"
   PASS  A4 a DA of another department adds the same standard — it lands in their catalog; this one is unchanged
   PASS  A5 the copy edits via set_cert_type and deletes via delete_cert_type; the master row is untouched (still 69)
— Lipan Volunteer Fire Department
   PASS  M1 plain member reads all 69 standard rows; an INSERT is refused by RLS, an UPDATE touches 0 rows
   PASS  A3 plain member: add_standard_cert_type refused on authority; nothing added
   PASS  A1 DA adds a never-expires SFFMA + an expiring EMS standard; both in this catalog with the standard's name / flag / category, created_by the DA
   PASS  A2 the same standard twice → "already in your catalog"; an unknown id → "not found"
   PASS  A4 a DA of another department adds the same standard — it lands in their catalog; this one is unchanged
   PASS  A5 the copy edits via set_cert_type and deletes via delete_cert_type; the master row is untouched (still 69)
— North Hood County Volunteer Fire Department
   PASS  M1 plain member reads all 69 standard rows; an INSERT is refused by RLS, an UPDATE touches 0 rows
   PASS  A3 plain member: add_standard_cert_type refused on authority; nothing added
   PASS  A1 DA adds a never-expires SFFMA + an expiring EMS standard; both in this catalog with the standard's name / flag / category, created_by the DA
   PASS  A2 the same standard twice → "already in your catalog"; an unknown id → "not found"
   PASS  A4 a DA of another department adds the same standard — it lands in their catalog; this one is unchanged
   PASS  A5 the copy edits via set_cert_type and deletes via delete_cert_type; the master row is untouched (still 69)
---- 19 passed, 0 failed, 2 skipped ----
(this exception IS the rollback — nothing was changed)
```

The 2 skips are fixture gaps, not failures: B4C Demo and Granbury have no plain (non-officer) member to run M1 / A3 as.
Every case ran and passed on the three departments that have one.
