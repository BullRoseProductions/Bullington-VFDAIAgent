-- =====================================================================
-- RLS SWEEP — STEP 0 (read-only live audit). Run in the Supabase SQL editor, No limit.
-- RAN on live 2026-10-20. Findings (raw; the reviewer characterizes):
--   set 1 (no role / self gate): aftercall_run_items INSERT (dept via the run); member_active_department INSERT+UPDATE
--     and member_active_station INSERT+UPDATE (own row by email, no department / station check). duties is NOT a
--     suspect: its live UPDATE policy carries a role or self token (text not printed — Step 0c reads it).
--   set 2 (is_leader without my_department_id): ZERO rows.
--   set 3: most RLS tables keep the Supabase-default full client grants; RPC-only as designed: apparatus_tests,
--     document_*, equipment_issues, gear_items, member_credentials / probation / qualifications / separation,
--     probation_milestones, qualification_types, readiness_requirements, session_registrations, supervised_sessions;
--     onboarding_items column-narrowed; onboarding_progress no INSERT / UPDATE (DELETE grant, no DELETE policy).
--   3b: duties — EVERY column client-updatable (no column backstop); member_active_department / _station all columns.
--   set 4: 21 DELETE policies, all row-scoped to my_department_id() except member_devices (own row) and member_private
--     / members / onboarding_items (dept-scoped). Role-anywhere gate inside a row-scoped DELETE: announcements
--     (is_department_admin()). PA-only hard deletes: ai_outputs, documents.
--   set 5: total_policies 169 · verified_token_fns 17.
-- Purpose: find every remaining write policy in the apparatus class (a member can write where only
-- leaders should) and the cross-dept class (a role-anywhere write with no department predicate), plus
-- the full DELETE surface for the delete-lock extension. NOTHING is changed — all SELECTs on catalogs.
--
-- Why live, not schema.sql: schema.sql is months stale (still shows the pre-Oct-17 is_leader() members
-- policy we already fixed). pg_policies is the only truth. Paste ALL rows back for the reviewer.
--
-- ONE RESULT SET (CC, Oct 19): the Supabase editor shows only the LAST statement's result, so the six
-- sets are UNION ALL'd into one, keyed by `ord` + `check` (same names, same logic as the brief). 3b no
-- longer needs a hand edit: it covers duties PLUS every table set 1 flags as an UPDATE / ALL suspect.
--
-- Already closed (should NOT reappear as suspects): apparatus UPDATE, apparatus_maintenance UPDATE,
-- members INSERT/DELETE cross-dept. Known lead to confirm here: duties UPDATE ("members update duties
-- in their dept") looked dept-only with no role gate in the stale dump — this will show the live truth
-- AND whether a column grant backstops it.
--
-- Columns: ord · check · tbl · cmd · name · detail · flag
--   1 apparatus-class suspect: name = policy, detail = USING | WITH CHECK, flag = dept_scoped true/false
--   2 cross-dept suspect:      name = policy, detail = USING | WITH CHECK
--   3 client write grants:     detail = 'ins … upd … del …' (authenticated, TABLE level), flag = whether ANY column is
--                              still insertable / updatable (a column-only grant reads false at table level — see 3b)
--   3b suspect UPDATE columns: name = column, flag = can_update
--   4 DELETE policies:         name = policy, detail = USING, flag = client_can_delete
--   5 baseline:                name = total_policies / verified_token_fns, detail = the count
-- =====================================================================
WITH wp AS (   -- every public WRITE policy (INSERT / UPDATE / DELETE / ALL) with its full expression
  SELECT c.oid AS relid, c.relname AS tbl, p.polname, p.polcmd,
         CASE p.polcmd WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END AS cmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' | ' ||
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND p.polcmd IN ('a', 'w', 'd', '*')
),
s1 AS (        -- 1. apparatus class: NO role gate and NO self (my_member_id) gate
  SELECT * FROM wp
  WHERE expr !~* '(is_canmanage|is_canmanage_ops|is_dept_admin|is_department_admin|is_leader|access\s*&&|Project Admin|my_member_id)'
)
SELECT 1 AS ord, '1_SUSPECT_no_role_gate' AS check, tbl, cmd, polname AS name, expr AS detail,
       'dept_scoped=' || (expr ~* 'my_department_id')::text AS flag
  FROM s1
UNION ALL
-- 2. cross-dept class: is_leader() with NO my_department_id() (role-anywhere). Expect ZERO.
SELECT 2, '2_SUSPECT_role_anywhere', tbl, cmd, polname, expr, NULL
  FROM wp WHERE expr ~* 'is_leader' AND expr !~* 'my_department_id'
UNION ALL
-- 3. backstop: can an authenticated client write each RLS table at all (table-level privilege)?
SELECT 3, '3_client_write_grants', c.relname, NULL, NULL,
       'ins ' || has_table_privilege('authenticated', c.oid, 'INSERT')::text
       || ' · upd ' || has_table_privilege('authenticated', c.oid, 'UPDATE')::text
       || ' · del ' || has_table_privilege('authenticated', c.oid, 'DELETE')::text,
       -- a column-only grant reads false at table level: say whether ANY column is still writable (then read 3b)
       'ins_some_col=' || has_any_column_privilege('authenticated', c.oid, 'INSERT')::text
       || ' · upd_some_col=' || has_any_column_privilege('authenticated', c.oid, 'UPDATE')::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
UNION ALL
-- 3b. per-column UPDATE grants for duties + every set-1 UPDATE / ALL suspect (filled in automatically)
SELECT 4, '3b_suspect_update_columns', a.attrelid::regclass::text, NULL, a.attname, NULL,
       'can_update=' || has_column_privilege('authenticated', a.attrelid, a.attname, 'UPDATE')::text
  FROM pg_attribute a
 WHERE a.attrelid IN (SELECT to_regclass('public.duties') UNION SELECT relid FROM s1 WHERE cmd IN ('UPDATE', 'ALL'))
   AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
-- 4. DELETE surface: every DELETE policy + its gate + whether the client can delete at all
SELECT 5, '4_delete_policies', c.relname, 'DELETE', p.polname, pg_get_expr(p.polqual, p.polrelid),
       'client_can_delete=' || has_table_privilege('authenticated', c.oid, 'DELETE')::text
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND p.polcmd = 'd'
UNION ALL
-- 5. baseline for the eventual fix's before / after snapshot
SELECT 6, '5_baseline', NULL, NULL, 'total_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')::text, NULL
UNION ALL
SELECT 6, '5_baseline', NULL, NULL, 'verified_token_fns',
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0)::text, NULL
ORDER BY 1, 3, 4, 5;
