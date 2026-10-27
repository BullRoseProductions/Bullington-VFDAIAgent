# B4C — WS-3 DRAFT: cert-proof files readable by owner + leaders only (M-4)

**CC, 2026-10-27. DRAFT — NOT APPLIED, NOT REVIEWED.**

- **Directive:** [[B4C_ReviewFixes_Wave1_Directives]] (WS-3).
- **Finding:** M-4 in `claude/B4C_CC_Security_Audit.md`. A plain member could open **178** other members' cert-proof scans.
- **Ashlea's ruling:** license and med-card numbers private; **DOB stays department-visible** (the `celebrations` view is **not touched**).

## Files (branch `feat/ws3-certproof-privacy`)

| File | What |
|---|---|
| `sql/ws3_certproof_privacy_DRAFT.sql` (sha256 `a14db4dd…`) | One all-or-nothing DO block + state row |
| `sql/ws3_certproof_privacy_RETEST.sql` (sha256 `d90a86da…`) | SENTINEL; fixture **members** only; **reads the real storage objects**, writes none |
| `docs/review/ws3_LIVEDEFS.sql` → `.json` | Live read 2026-10-27: the 6 storage policies, pins, object counts, ownership |
| `docs/review/ws3_dryrun_harness.mjs` → `ws3_DRYRUN.txt` | PGlite dry run (`fe_b_db_LIVEDEFS.json` copied in for the live gate bodies) |
| `src/App.jsx` (2 lines) + `docs/review/ws3_certproof_copy_test.mjs` (8/8) + `ws3_certproof_copy_DIFF.patch` | The copy |

## The change

**Live today:** one SELECT policy on `storage.objects`, `station_docs_read_own_dept`: any authenticated member reads anything under their department's folder.

| Policy | After |
|---|---|
| `station_docs_read_own_dept` | **ALTERed in place** (same name, same role): still "this bucket, my department's folder", but **excluding `cert-proofs/`**. Plans (9), minutes (12), apparatus (8), equipment (1) and root documents (27) read exactly as before. |
| `cert_proofs_read_owner_or_leader` (**new**, SELECT, `TO authenticated`) | `<my dept>/cert-proofs/<member_id>/…` is readable only if `<member_id> = my_member_id()` **or** `is_leader()` (PA / DA / Board / Officer, department-scoped). |
| The 3 INSERT policies (including members uploading their own proofs), UPDATE, DELETE | **untouched**, proven byte-identical by the post-condition |

- **Why `is_leader()` (D1):** it's the set the app already shows other members' proof links to.
  - Roster certs, the member file and the dashboard read `certs.proof_path`, which `certs` RLS ("Leaders read all certs") returns for other members only to `is_leader()`.
  - The pending-proof queue is DA-only, a subset.
  - So the storage gate now matches the UI exactly; nobody who can see a "View proof" button gets a broken link.
  - A narrower option is `is_dept_admin() OR is_training_manager()`. That would hide proofs from Board and Officers who can currently see the button, so it would need a UI change too.
- **Live data the policy has to fit:**
  - 252 cert-proof objects, **all** at `<dept>/cert-proofs/<member uuid>/…`;
  - every `certs.proof_path` (185) and `cert_submissions.proof_path` sits under `cert-proofs/`, so no proof escapes the carve-out;
  - 246 owners are current members of that department. **6 are orphans** (owner removed or moved); after this they're **leader-only** (D2).

## Evidence (PGlite dry run, `docs/review/ws3_DRYRUN.txt`)

- **Pins:** 4/4 mock bodies are md5-equal to the live pins (`is_leader`, `my_department_id`, `my_member_id`, `storage.foldername`). The 6 storage policies are loaded **verbatim** from the live read.
- **The leak is reproduced first:** before the migration, mock member `a2` reads **3** cert-proofs that aren't theirs. After it, **1** (their own).
- **The migration applies.** State row: 7 storage policies, SELECT = {`cert_proofs_read_owner_or_leader`, `station_docs_read_own_dept`}. **A re-run is refused.**
- **RETEST: 13 passed / 0 failed / 0 skipped:**
  - a plain member sees 0 cert-proofs **and all** other documents;
  - the real owner sees exactly their own;
  - DA, Officer, Board and PA each see all proofs;
  - another department's DA sees nothing;
  - anon sees nothing;
  - `verified` unchanged.
- **Drift refusals:** a drifted `is_leader()` and a drifted read policy are both refused by pre-flight.
- **6 migration mutations** (carve-out skipped, owner arm dropped, leaders narrowed, department check dropped, any member reads all, another policy touched): **all 6 refused** by the migration's own post-conditions.
- **6 post-apply drifts** (the correct migration applied, then the live policies corrupted as a later hand edit would): the **RETEST alone turns red on all 6** (T1/T2, T2, T3, T4, T1/T2, O1/O2). So the RETEST is a real check, not just an echo of the migration.

## The copy (ships with or after the apply — the claim is only true once the policy is live)

| Where | Before | After |
|---|---|---|
| Member's "Add a cert" (`App.jsx:4704`) | "…A leader reviews and approves it." | "…A leader reviews and approves it. **Only you and your department's leaders can open the proof file.**" |
| Expirations footer (`App.jsx:21056`) | "Expiry dates, class and pass/fail only — never the number, **the scan**, or any medical detail." | "This tracker keeps expiry dates, class and pass/fail only — never a license number or any medical detail. **Uploaded proof files (certificates, cards) can be opened only by the member and department leaders.**" |

- `ws3_certproof_copy_test.mjs` passes 8/8: exactly 2 lines changed, only `src/App.jsx`, no storage call changed, `verified` 132, Notify held.
- The suite passes 21/21 + this test; the build passes.
- Ashlea may want different wording. These are the accurate minimum.

## Decisions for the review

- **D1:** "Leaders" = `is_leader()`. It mirrors certs RLS and every in-app proof viewer (above).
- **D2:** the 6 orphan proofs become leader-only.
- **D3 — ownership risk.** `storage.objects` is owned by `supabase_storage_admin`, and the SQL editor's `postgres` role is **not** a member of it (`ws3_LIVEDEFS.json`).
  - Supabase normally lets the SQL editor manage storage policies, but the repo has no earlier SQL-applied storage policy to prove it here.
  - If the apply errors with "must be owner of table objects", **nothing changes** (one DO block). The same two statements then go in through **Dashboard → Storage → Policies**, and the RETEST runs unchanged.
- **D4:** the dry run can't exercise D3 (PGlite runs as superuser). The live RETEST after apply is the real proof.

## Apply (only after PASS + Ashlea's go)

1. Run `sql/ws3_certproof_privacy_DRAFT.sql`. Expected state row: **storage_policies 7**, select_policies = the two names, cert_proof_objects ≈ 252, verified_presence unchanged.
2. Run `sql/ws3_certproof_privacy_RETEST.sql` separately. Expected: O1 + O2, then T1–T5 for each department with proofs, then T6.
3. Promote the copy (`src/App.jsx`, 2 lines) to web.

- **Rollback:** `DROP POLICY cert_proofs_read_owner_or_leader ON storage.objects;` then `ALTER POLICY station_docs_read_own_dept ON storage.objects USING ((bucket_id = 'station-documents') AND ((storage.foldername(name))[1] = (my_department_id())::text));`
