# B4C — WS-5 Step 0: RLS first-layer normalization (M-6 / S-2)

**CC, 2026-10-28. READ-ONLY — no SQL drafted, nothing applied.** For Claude's review, and Ashlea's rulings on the flags in §5.

- **Directive:** B4C_WS5_RLSNormalization_Directive.md.
- **Evidence:** live reads only, 2026-10-28, via `has_table_privilege`, `pg_policies`, `pg_default_acl`, `information_schema.role_table_grants`, `pg_roles` and `storage.buckets`. The schema snapshot was not used (memory: schema.sql is stale).
- **Code paths:** main @ `84a698c`.

## 1 · The live state

| | live |
|---|---|
| public relations | 92 (90 tables, 2 views) |
| **relations where anon holds a privilege** | **56** (54 × SELECT/INSERT/UPDATE/DELETE · `equipment_issues` SELECT only · `onboarding_progress` SELECT+DELETE) — **219 grants** |
| …of which RLS is **off** | **1**, `members_view`, a view that runs as its owner, so RLS doesn't apply to it |
| **policies with roles `{public}`** | **19**, on 16 tables (all listed in the appendix) |
| policies with roles `{anon}` | 0 |
| relations already without any anon privilege | 36: the newer tables, where each migration revoked anon itself (`event_needs`, `library_drills`, `ai_call_usage`, `member_separation`, …) |
| anon EXECUTE on public functions | **0**, every function is explicitly revoked (the anon-revoke pattern) |
| anon on public sequences | **1**, `training_session_audit_seq_seq` (USAGE/SELECT/UPDATE) |
| anon USAGE on schema `public` | yes. **Keep:** PostgREST needs it to accept anon requests at all; it grants no data |
| **default privileges** (`pg_default_acl`, schema public) | for **both** `postgres` and `supabase_admin`: new **tables** get `anon=arwdDxtm`, new **sequences** `anon=rwU`, new **functions** `anon=X`. That's why every migration has had to revoke anon by hand |
| roles that bypass RLS | `postgres`, `service_role` only |
| other roles with any grant on a public table, or EXECUTE beyond authenticated | **none** (`supabase_auth_admin`, `supabase_storage_admin`, `authenticator`, realtime: nothing) |
| storage | 1 bucket (`station-documents`, **not public**); 7 policies, 6 `TO authenticated`, **1 `TO {public}`** (§5, S-1) |

**Every one of the 19 `{public}` policies is department-scoped.** Each USING / WITH CHECK calls `my_department_id()`, several with `is_leader()` / `is_dept_admin()` / `is_equipment_manager()`.

## 2 · Does any real path touch these tables as anon? No.

**The client.**
- `src/main.jsx` renders `<Login />` whenever there is no session. `<App/>`, which holds every `.from()` / `.rpc()` in the product, mounts **only with a session**.
- `Login.jsx` and `authLinks.js` make **no** table or RPC calls: only `signInWithOtp` / `signInWithPassword`, which are Supabase **Auth** endpoints and use no table grants.
- `SetPassword.jsx` (`mark_password_set`) and the `has_password` gate run only with a session.
- **Login, sign-up (open, D-4 untouched), invite-accept (magic link → session → app) and password reset therefore never read a public table as anon.**

**The "global" reads are not anon-facing.**
- `departments` and `standard_cert_types` have **SELECT policies `TO authenticated` only**, so an anon read returns `[]` today.
- No picker renders before sign-in. They are authenticated-only in practice already.

**Modules that can run around a session:**

| Path | When | Today as anon | After revoke-anon |
|---|---|---|---|
| `push.js` `unregisterPush` (`member_devices` DELETE) | on sign-out, **before** `signOut()`, so as authenticated | if the session had already expired: 0 rows deleted, silently (the DELETE policy is `TO authenticated`) | a permission error, which the function already catches; sign-out never blocks. **Same outcome (the row survives).** |
| `geofence.js` (`geofence_arrive` / `_depart`) | native background events | RPCs; anon has no EXECUTE, so they already error | unchanged (no function grant is touched) |
| Realtime | — | **not used** (no `.channel()` / `postgres_changes` anywhere) | — |

**The API.** No route reads a table as anon:
- `api/_auth.js`'s cached anon client only calls `auth.getUser` (Auth API);
- `requireMember` carries the caller's JWT;
- `digest`, `pulse` and `expiration-reminders` use the service role (plus an as-user client with the JWT).

**Supabase itself.** PostgREST needs **schema USAGE** for anon, not table grants. A revoked table grant only turns an anon request into a `401/permission denied`. Auth, storage and realtime admin roles hold no public-table grants and don't rely on `TO public` policies.

## 3 · Per object — the verdict

The full list is the appendix.

- **All 56 anon-granted relations → revoke anon: safe.** Today an anon read of each returns **nothing**. Either:
  - **(a) 40 relations:** RLS is on and no policy reaches anon (every policy is `TO authenticated`, or there is none, e.g. `profiles`, `station_presence`), so the result is `[]`; or
  - **(b) 16 tables + `members_view`:** the only anon-reachable policies (or the view itself) call `my_department_id()`, which anon cannot EXECUTE, so the result is a **permission error**. Even if it could, `auth.email()` is null → no department → no rows.
  - Anon's **writes** are refused the same way: no INSERT/UPDATE/DELETE policy reaches anon, and the `{public}` `ALL` policies on `equipment` / `equipment_photos` / `equipment_type` need `is_dept_admin()` or `is_equipment_manager()`, also not executable by anon.
- **All 19 `{public}` policies → `TO authenticated`, same USING / WITH CHECK: safe for every real user.**
  - Every signed-in member is `authenticated`, which is a member of `public`, so it already matched these policies and still will.
  - `service_role` and `postgres` bypass RLS; no other role holds grants.
  - For anon it changes an error into "no policy" → nothing, which is moot once the grants are revoked.
- **`training_session_audit_seq_seq` → revoke anon.** PostgREST doesn't expose `nextval`, and anon can execute no function, so this is hygiene.
- **Keep:** anon's USAGE on schema `public` (PostgREST); `authenticated`'s grants, **all of them, untouched**. The migration proves `authenticated`'s privilege matrix identical before/after on all 92 relations.

## 4 · The forward-fix — new objects stop inheriting anon

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC;   -- recommended (F-3)
```

- **Our objects are created by `postgres`** (every migration runs in the SQL editor as `postgres`). The migration's preflight will confirm every public table is owned by `postgres` before relying on this.
- The `supabase_admin` default ACL is the platform's own and **not ours to change** (`postgres` isn't a member of `supabase_admin`). Supabase-owned objects aren't in scope.

## 5 · Flags — honest "this changes behavior" items (Ashlea's calls)

| # | What changes | Who can see it | CC rec |
|---|---|---|---|
| **F-1** | **Anon schema discovery goes away.** PostgREST's root (`GET /rest/v1/` with the public anon key, which is in every bundle) lists the tables and columns the requesting role can SELECT, so today that's these 56 relations' names and columns. After the revoke, anon sees none. *(Expected PostgREST behavior; not exercised live in this Step 0.)* | only an unauthenticated caller | **Do it.** It's a disclosure reduction, not a feature |
| **F-2** | **A session lost mid-use.** If a member's session disappears while the app is open (signed out in another tab, refresh failed), supabase-js falls back to the anon key. Today the 40 class-(a) reads then return `[]`, so a screen can **look empty**; after, they return an **error**, and the loaders keep last-known data and show retry (memory: loaders never blank on error). The app's session-expired banner fires either way | a member whose session dropped | **Accept.** An error is the honest answer; `[]` read as "you have nothing" |
| **F-3** | **Functions in the forward-fix:** also revoke the default EXECUTE from `anon` **and PUBLIC` for future functions. Then a new SECURITY DEFINER function is closed by default, and the manual REVOKE in every migration becomes a second layer, not the only one (memory: anon-execute-revoke-pattern) | nobody today (0 anon-executable functions) | **Yes**, but your call since the directive named tables |
| **S-1** | **Sibling, outside public:** the storage policy `equipment photos upload da or manager` is `TO {public}` (INSERT on `station-documents`, gated on `my_department_id()` + `is_dept_admin()` / `is_equipment_manager()`, which anon can't execute). Flipping it to `authenticated` is the same reasoning | nobody | **Include** it in WS-5 (one `ALTER POLICY`) or queue it; your call |

**Nothing found that a real member uses would break.** I found no load-bearing anon grant.

## 6 · How the migration would prove itself (when it's drafted)

**Preflight:**
- snapshot `authenticated`'s and `service_role`'s privilege matrix (92 relations × S/I/U/D) and every policy's USING / WITH CHECK text;
- refuse on drift from this Step 0's counts (56 / 219 / 19) or on a non-`postgres` owner.

**The change, one transaction:**
- `REVOKE ALL ON <the 56> FROM anon`;
- `ALTER POLICY … TO authenticated` × 19 (USING / WITH CHECK untouched);
- the sequence;
- the default privileges (+ F-3 / S-1 if ruled in).

**Post-conditions (in-transaction):**
- anon holds **nothing** on any public relation / sequence;
- `authenticated`'s and `service_role`'s matrices **byte-identical**;
- every policy's USING / WITH CHECK byte-identical, with only `roles` changed on the 19;
- 0 `{public}` policies in public;
- policy count unchanged; verified untouched.

**RETEST (rolled-back SENTINEL, every department):**
- as a **real member** and a **real Department Admin**: every table they can read returns the **same row count** as the pre-apply snapshot;
- as anon: every relation is refused;
- `station_presence` byte-identical.

**Served verification**, per the directive:
- a **logged-out / anon smoke pass:** load the alias, the Login screen, request a magic link, a password reset;
- **a real member signing in, in a separate browser** ("View as" proves nothing for RLS).

---

## Appendix — the 56 anon-granted relations (live, 2026-10-28)

| relation | kind | RLS | anon holds | authenticated holds | policies (cmd · roles) | today an anon read returns | verdict |
|---|---|---|---|---|---|---|---|
| `action_items` | table | on | S,I,U,D | S,I,U,D | INSERT·authenticated, SELECT·public, SELECT·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `ai_feedback` | table | on | S,I,U,D | S,I,U,D | SELECT·public | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `ai_outputs` | table | on | S,I,U,D | S,I,U,D | INSERT·authenticated, UPDATE·authenticated, SELECT·public, DELETE·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `announcements` | table | on | S,I,U,D | S,I,U,D | INSERT·authenticated, DELETE·authenticated, UPDATE·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `apparatus` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, INSERT·authenticated, DELETE·authenticated, UPDATE·authenticated | [] — every policy is TO authenticated | revoke anon |
| `apparatus_check_items` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, ALL·authenticated | [] — every policy is TO authenticated | revoke anon |
| `apparatus_check_results` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `apparatus_checks` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `apparatus_maintenance` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, INSERT·authenticated, DELETE·authenticated, UPDATE·authenticated | [] — every policy is TO authenticated | revoke anon |
| `apparatus_photos` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, ALL·authenticated | [] — every policy is TO authenticated | revoke anon |
| `apparatus_service_periods` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `cert_submissions` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, INSERT·authenticated, INSERT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `cert_types` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `certs` | table | on | S,I,U,D | S,I,U,D | SELECT·public, SELECT·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `content_calendar` | table | on | S,I,U,D | S,I,U,D | SELECT·public, DELETE·authenticated, UPDATE·authenticated, INSERT·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `departments` | table | on | S,I,U,D | S,I,U,D | UPDATE·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `documents` | table | on | S,I,U,D | S,I,U,D | SELECT·public, DELETE·authenticated, INSERT·authenticated, UPDATE·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `drill_plans` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `duties` | table | on | S,I,U,D | S,I,U,D | SELECT·public, DELETE·authenticated, UPDATE·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `duty_log` | table | on | S,I,U,D | S,I,U,D | UPDATE·authenticated, SELECT·authenticated, INSERT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `equipment` | table | on | S,I,U,D | S,I,U,D | ALL·public, SELECT·public | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 2 {public} policies → authenticated |
| `equipment_custody` | table | on | S,I,U,D | S,I,U,D | UPDATE·authenticated, SELECT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `equipment_handoff` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `equipment_handoff_items` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `equipment_issue_batch` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `equipment_issues` | table | on | S | S | SELECT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `equipment_manager` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `equipment_photos` | table | on | S,I,U,D | S,I,U,D | ALL·public, SELECT·public | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 2 {public} policies → authenticated |
| `equipment_type` | table | on | S,I,U,D | S,I,U,D | ALL·public, SELECT·public | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 2 {public} policies → authenticated |
| `events` | table | on | S,I,U,D | S,I,U,D | SELECT·public | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `funding_events` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, UPDATE·authenticated, INSERT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `fundraiser_log` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, SELECT·authenticated, INSERT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `maintenance` | table | on | S,I,U,D | S,I,U,D | SELECT·public | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `meetings` | table | on | S,I,U,D | S,I,U,D | SELECT·public | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `member_devices` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, INSERT·authenticated, SELECT·authenticated, UPDATE·authenticated | [] — every policy is TO authenticated | revoke anon |
| `member_notes` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, INSERT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `member_private` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, INSERT·authenticated, SELECT·authenticated, UPDATE·authenticated | [] — every policy is TO authenticated | revoke anon |
| `members` | table | on | S,I,U,D | S,I,U,D | UPDATE·authenticated, DELETE·authenticated, INSERT·authenticated, SELECT·public, SELECT·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `members_view` | view | **off** (view runs as owner) | S,I,U,D | S,I,U,D | none | **error** (anon can't EXECUTE my_department_id) | revoke anon |
| `notification_prefs` | table | on | S,I,U,D | S,I,U,D | INSERT·authenticated, SELECT·authenticated, UPDATE·authenticated | [] — every policy is TO authenticated | revoke anon |
| `notifications` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `onboarding_items` | table | on | S,I,U,D | S,D | DELETE·authenticated, INSERT·authenticated, UPDATE·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `onboarding_progress` | table | on | S,D | S,D | INSERT·authenticated, UPDATE·authenticated, SELECT·public, SELECT·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |
| `post_categories` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, UPDATE·authenticated, INSERT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `profiles` | table | on | S,I,U,D | S,I,U,D | none | [] — RLS on, **no policies** | revoke anon |
| `push_subscriptions` | table | on | S,I,U,D | S,I,U,D | ALL·authenticated | [] — every policy is TO authenticated | revoke anon |
| `recruitment_events` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, UPDATE·authenticated, INSERT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `resources` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, INSERT·authenticated, UPDATE·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `session_attendance` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated, DELETE·authenticated, INSERT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `session_plans` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, INSERT·authenticated, UPDATE·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `standard_cert_types` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `station_log` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, SELECT·authenticated, INSERT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `station_presence` | table | on | S,I,U,D | S,I,U,D | none | [] — RLS on, **no policies** | revoke anon |
| `training_officer` | table | on | S,I,U,D | S,I,U,D | SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `training_plans` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, UPDATE·authenticated, INSERT·authenticated, SELECT·authenticated | [] — every policy is TO authenticated | revoke anon |
| `training_sessions` | table | on | S,I,U,D | S,I,U,D | DELETE·authenticated, SELECT·public, UPDATE·authenticated, INSERT·authenticated | **error** — the {public} policy calls my_department_id(), which anon can't EXECUTE | revoke anon · flip 1 {public} policy → authenticated |

Relations already without any anon privilege (36): _d2a_resync_backup, aftercall_items, aftercall_run_items, aftercall_runs, ai_call_usage, apparatus_maintenance_log, apparatus_tests, assistant_usage, celebrations, document_acknowledgments, document_series, document_versions, donation_activity, donation_campaigns, donation_donors, event_need_claims, event_needs, fundraiser_sponsors, fundraisers, gear_items, image_gen_usage, library_drills, member_active_department, member_active_station, member_credentials, member_probation, member_qualifications, member_separation, probation_milestones, qualification_types, readiness_requirements, session_registrations, stations, supervised_sessions, training_session_audit, training_session_requests.
