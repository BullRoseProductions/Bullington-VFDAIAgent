# B4C — RLS Security Sweep (punch-list P1 #3) — Step 0 brief

**Goal:** finish the family sweep — close any remaining write policy in the two classes we already fixed, and extend the delete-lock. **Supabase `ifeptqnlucmvhlvadcpj`.**

## The two bug classes (what we're hunting)
- **Apparatus class** — a WRITE policy gated by `department_id = my_department_id()` with **no role function** (and not self-gated by `my_member_id`). A plain member can write the row directly. We fixed this on `apparatus` and `apparatus_maintenance`.
- **Cross-dept class** — a WRITE policy using `is_leader()` (role-anywhere) with **no** `my_department_id()` predicate. A leader in dept A can act on dept B. We fixed this on `members` (Oct 17).

## What the repo already told me (findings so far)
- **Fundraiser tables are CLEAN.** `fundraisers` and `fundraiser_sponsors` are both `FOR ALL` gated by `department_id = my_department_id() AND is_canmanage()` (`sql/fundraiser_hq_slice1_schema.sql`). The "fundraiser log" suspect on the punch list does **not** hold up against the migration — no exposed fundraiser write policy. (The live audit will confirm there's no other fundraiser-tagged table hiding one.)
- **Prime lead to confirm: `duties` UPDATE.** The policy `"members update duties in their dept"` is `USING/WITH CHECK (department_id = my_department_id())` — **no role gate**. That's the apparatus shape: a member could directly UPDATE any duty row in their dept (reassign, edit text, change due date, mark others' done), not just tick their own. The authoritative path is `complete_duty`/`uncomplete_duty` (SECURITY DEFINER), so the broad policy is likely a vestige. **BUT** it may be backstopped by column-level UPDATE grants (only `done`/`done_at` writable) — Step 0 checks that before we call it a hole.
- **schema.sql is ~5 months stale** (still shows the pre-Oct-17 `is_leader()` members policy). So the repo can't tell us the current live policy set — **the live `pg_policies` dump is the only authority.** That's why Step 0 runs on prod.

## Step 0 — run it on live, report back (`sql/rls_sweep_STEP0_CHECK.sql`)
Read-only, all SELECTs on catalogs. In the Supabase SQL editor, set **No limit**, run it, paste back **all six result sets**:
1. **Suspects, apparatus class** — write policies with no role gate and no self gate.
2. **Suspects, cross-dept class** — `is_leader()` without `my_department_id` (expect ZERO).
3. **Client write grants** — which RLS tables `authenticated` can INSERT/UPDATE/DELETE at all. A suspect on an RPC-only table (all false) is **backstopped**, not a live hole (like the `apparatus_checks` finding); a suspect on a table with the matching grant true is a **real hole**.
4. **Suspect UPDATE columns** — for `duties` (and any other set-1 UPDATE suspect): the per-column UPDATE grants, so we see if a broad policy is narrowed to safe columns.
5. **DELETE surface** — every DELETE policy + its gate + whether the client can delete, for the delete-lock extension (3b).
6. **Baseline** — `total_policies` + the `verified`-token function count, for the eventual fix's before/after snapshot.

## After Step 0 (the reviewer characterizes, then we fix)
- **3a — real holes only.** For each set-1/2 suspect cross-referenced with set 3/4, I decide real-vs-backstopped exactly like the apparatus review. Real ones get the same fix: tighten the policy to `department_id = my_department_id() AND <the right role gate>` (`is_canmanage_ops()` for ops records, `is_canmanage()` for leadership records, `is_dept_admin()` for admin-only), in a single guarded DO block that snapshots every other policy byte-identical, with a RETEST (member blocked, the right role allowed, cross-dept blocked, `verified` untouched) and a PGlite dry run. If `duties` is confirmed exposed, that's the headline fix.
- **3b — delete-lock extension (hardening).** From set 4, the `"leaders delete …"` policies (content_calendar, recruitment_events, session_plans, post_categories, members, …) let any Officer delete. The reviewer picks which destructive deletes should tighten to **`is_dept_admin()` + own-dept** (the training_plans/sessions standard) vs. stay at leader. This is deliberate hardening, not a live exploit — ranked below 3a.

## Deliverables (same rhythm as every slice)
Step 0 output → reviewer characterization → a single `sql/rls_sweep_fix_DRAFT.sql` + RETEST + PGlite dry run, delivered to `docs/review/` for gate review **before** apply. Nothing applied until PASS. DB-policy change = live on web AND native the moment applied (no deploy), so the RETEST on live is the proof.
