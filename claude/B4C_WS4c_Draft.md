# B4C — WS-4c draft: the headcount (B-1..B-4) + onboarding (E-1/E-2) (for gate review)

**CC, 2026-10-27. DRAFT — nothing applied, nothing merged.**

- **Branch:** `feat/ws4c-members`, off main `2129fff` (industrial-noir-38).
- **Rulings:** B4C_WS4_Metrics_Directive.md (B-1..B-4, E-1/E-2).
- **Coordinated apply on Ashlea's go:** the DB first, then the client.

| Part | Files |
|---|---|
| **DB (B-4)** | `sql/ws4c_members_view_separated_DRAFT.sql`; RETEST `sql/ws4c_members_view_separated_RETEST.sql`; dry run `docs/review/ws4c_members_view_dryrun_harness.mjs` → `ws4c_members_view_DRYRUN.txt`; live reads `docs/review/ws4c_LIVEDEFS.json` |
| **Client** | `shared/members.js` (new), `src/App.jsx`, `api/digest.js`, `shared/attendance.js` (comment only). Test `docs/review/ws4c_members_test.mjs` **28/0** → `ws4c_members_TEST_OUTPUT.txt`. Diff `docs/review/ws4c_members_DIFF.patch` |
| **Checks** | full suite **29 tests, 0 red, 794 PASS**; build OK; `shared/` differential tests green; `verified` 132 · 32 · 14; Notify held; no `station_presence` line added |

## 1 · The live reads (read-only, 2026-10-27)

- **`members_view`**
  - md5 `5c78c518a924963a3f0acf61e8184e19`; owner postgres; `security_invoker=false`; scoped by `my_department_id()`.
  - **status / role / access / participation are masked to NULL for non-leaders** (`CASE WHEN is_leader()`).
  - ACL `{postgres,anon,authenticated,service_role = arwdDxtm}`. Anon's broad grant returns nothing: anon has no department.
  - No dependent views.
- **Its two functions:** `is_leader()` `3f462af2…`, `my_department_id()` `87f54665…`.
- **`member_separation`:** sealed (RLS on, 0 policies, no anon / authenticated privilege). **1 row**; **0 separated Active/Probationary members today**, so **no headcount moves on apply**.
- **The server's rule:** `dept_readiness_packet` / `dept_probation_board` / `onboarding_signoff_queue` all use `not exists (select 1 from member_separation s where s.member_id = m.id)`. Any row counts, **including a future-dated termination**. The new column is that predicate, nothing else.
- **Baseline:** fn_count 227 · policies 181 · verified 961 (organic since 959/960).

## 2 · The DB slice (B-4) — `members_view.separated`

- **One change:** `members_view` = its **live text** (pinned by md5) + one appended column.
  ```sql
  CASE WHEN is_leader() THEN (EXISTS (SELECT 1 FROM member_separation s WHERE s.member_id = members.id)) ELSE NULL::boolean END AS separated
  ```
- ⚠ **For your eye — the mask.** I masked `separated` for non-leaders **exactly like `status`**.
  - A termination is a DA record (the membership-window rule keeps `terminated_on` out of every view), and a yes/no is still a disclosure.
  - Leaders already see the effect: the readiness packet's headcount omits separated members.
  - Non-leaders can't see status either, so their screens can't apply B-1/B-4 today anyway (see §3, "masked").
  - If you'd rather expose it to every member, it's a one-line change.
- **Preflight refuses on drift:**
  - the view md5;
  - `is_leader()` / `my_department_id()` md5s;
  - options/owner;
  - `member_separation` shape + seal;
  - "already applied".
- **Post-conditions prove:**
  - columns = old list + `separated:boolean`;
  - **ACL string identical** before/after;
  - options/owner unchanged;
  - **stripping the new column gives back the pinned md5** (nothing else changed);
  - `terminated_on` in no view;
  - `member_separation` still sealed;
  - policies / function counts unchanged;
  - verified unchanged.
- Then `NOTIFY pgrst` and a state row.

**Expected live state row:**

| field | expected |
|---|---|
| separated_column | `boolean` |
| view_columns | 13 |
| view_options_owner | `security_invoker=false\|postgres` |
| view_acl | unchanged |
| terminated_on_in_view | 0 |
| sep_sealed | true |
| members_with_separation_row | 1 |
| separated_active_or_prob | 0 |
| total_policies | 181 |
| fn_count | 227 |
| verified_presence | unchanged from just before the apply |

**Dry run (PGlite, live bodies, no stubs except a labelled packet stub for T5)** — `ws4c_members_view_DRYRUN.txt`:
- **pins 4/4:** the view md5 **reproduces from the live text**. The ACL is compared minus PG17's MAINTAIN `m`, which PGlite lacks.
- **apply:** state row; re-run **refused**.
- **RETEST:** **15/0/0** over 2 mock departments (real and fixture DA).
- **drift refusals:** 5/5.
- **mutations:** 6/6 refused by the migration's own post-conditions:
  - unmasked;
  - future-dated not counted;
  - status unmasked;
  - `terminated_on` exposed;
  - anon grant revoked;
  - department scope dropped.
- **post-apply drift:** 4/4 caught by the RETEST alone:
  - anon revoked;
  - `member_separation` opened;
  - the view replaced unmasked;
  - future-dated stops counting.

**RETEST (live, rolled-back SENTINEL, every department):**
- **O1:** column / options / grants as live, privilege by privilege.
- **O2:** only `separated` added; `terminated_on` nowhere; still sealed.
- **O3:** pinned fns.
- **Per department**, with a real DA where one exists, a fixture Officer, a plain Member, a separated Active member (yesterday), a future-separated Active member and a normal Active member:
  - **T1/T2:** the DA and the Officer see `separated` true/true/false/false.
  - **T3:** a plain Member sees NULL on every row.
  - **T4:** anon sees nothing.
  - **T5:** the B-4 headcount over the view **= the server's own `dept_readiness_packet()->readiness->counted`**; both separated fixtures out, the normal member in.
  - **T6:** `station_presence` byte-identical; verified unchanged.

## 3 · `shared/members.js` — the one headcount

- **The id list (owner / test / demo) lives here only.** It was copied in App.jsx and api/digest.js ("MUST stay in sync").
- **`isListedMember`:** not an excluded id, not a Project Admin. That is exactly what `countsInStats` was. It drives **lists, names, the roster table, assignees, celebrations, the session roll, cert alerts**, all unchanged. Inactive stays listed.
- **`isCountedMember`:** listed ∧ Active/Probationary ∧ not separated (B-1..B-4). It drives the **headcount and every denominator**.
- **`headcount()`:** counted, active, probationary, inactive (alongside), separated, listed.
- **Masked:** `members_view` gives non-leaders NULL status (and NULL `separated`). A NULL **never excludes**, so a plain member's screens keep counting as they did. For leaders and the email the rule is exact.

**Count sites moved:**
- **Dashboard Members tile:** headcount + "+ N inactive". It used to be the full roster, every status.
- **Roster chips:** Members = headcount + "+ N inactive"; Active "% of members". The "All / Active / Probationary" **tabs** stay list counts, because they count what the tab lists.
- **BoardStats hero:** headcount.
- **Roster breakdown bar:** separated gets its own segment, never inside Active.
- **Attendance:** `deptAttendance`'s predicate is `isCountedMember` → the Attendance Report, ReportsHub, BoardStats, Chief's Report, trends, RosterAttendance and the member file. **Inactive and separated members leave the attendance rows/denominator (C-1).**
- **Also:** board-event accountability, attendance-gap insights, cert-coverage tiles, the Training headcount, the Chief's Report totals.

**The email:**
- Imports `isListedMember` / `isCountedMember`. Its **attendance %** is over `isCountedMember`, with separation read from `member_separation(member_id)`: tolerant, never `terminated_on`.
- **Duty, credited-hours and notification people stay the listed set.** Moving a credited-hours population is WS-4d's lens, and cert currency is F-1.

## 4 · Onboarding (E), client-only

- **E-1, open items = the server's computed status** (`my_probation_status` / `member_probation_status` / `dept_probation_board`):
  - the member card (Plain) and the member's own checklist (Plain);
  - the admin's featured member;
  - the admin overview rings: read from the board, **also with the switch OFF**.
  - The raw `onboarding_progress` overview read is **gone**. With no computed row a ring reads "—", never a raw count.
  - The progress row still supplies the "Signed by …" line (display).
- **E-2, "Awaiting sign-off" tile = `onboarding_signoff_queue` rows.** The queue card on the same screen reports its length (`onCount`), so the tile and the queue agree by construction. It used to count every open manual item. The sub-label is now "marked ready".
- **B-4 here too:** the overview population drops separated members, which is `dept_probation_board`'s population.

⚠ **E-1 vs an earlier design — please confirm with Ashlea.**
- The probation switch was built so that **OFF = "the plain onboarding checklist exactly as before probation (every item an officer sign-off)"**. The code said so: *"probation off: every item is a plain officer sign-off again, whatever its saved kind"*.
- The live status functions **never read the switch**: for an `ack` / `hours` / `cert` item, a manual tick is ignored; only the computed fact satisfies it. So E-1 "even when probation is off" changes OFF-mode for **auto-kind items**.
- **Today it changes nothing anyone sees:** both OFF departments (Granbury, B4C Demo) have **0 onboarding items**. The live auto items (16) are all in Indian Harbor, which is ON.
- It would only bite a department that configures auto items with probation ON and then switches it OFF. If Ashlea wants OFF to stay "every item a tick", the fix is one condition in `doneOf` plus the Plain card. Say the word.

## 5 · Re-baselined, not weakened

- `ws4b_shared_test`'s wrapper pin named `countsInStats`. It now accepts the planned successor `isCountedMember`; still "one thin wrapper, no local copy".
- No other test moved.

## Not in 4c

- F-1 (cert currency, five definitions): not ruled into this slice.
- Celebrations and the session roll keep the listed population. They're people lists, not counts.
- WS-4d stays queued (F-3, meetings-as-standby, voided shift count).
