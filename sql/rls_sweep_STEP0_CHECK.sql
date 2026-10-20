-- =====================================================================
-- RLS SWEEP — STEP 0 (read-only live audit). Run in the Supabase SQL editor, No limit.
-- Purpose: find every remaining write policy in the apparatus class (a member can write where only
-- leaders should) and the cross-dept class (a role-anywhere write with no department predicate), plus
-- the full DELETE surface for the delete-lock extension. NOTHING is changed — all SELECTs on catalogs.
--
-- Why live, not schema.sql: schema.sql is months stale (still shows the pre-Oct-17 is_leader() members
-- policy we already fixed). pg_policies is the only truth. Paste ALL result sets back for the reviewer.
--
-- Already closed (should NOT reappear as suspects): apparatus UPDATE, apparatus_maintenance UPDATE,
-- members INSERT/DELETE cross-dept. Known lead to confirm here: duties UPDATE ("members update duties
-- in their dept") looked dept-only with no role gate in the stale dump — this will show the live truth
-- AND whether a column grant backstops it.
-- =====================================================================

-- ── 1. SUSPECTS — apparatus class: a WRITE policy with NO role gate and NO self (my_member_id) gate.
--     A hit here = a member may be able to write the row directly. Cross-check against set 3 (can the
--     client even write the table). Role tokens: is_canmanage[_ops], is_dept_admin, is_department_admin,
--     is_leader, access && (inline role), 'Project Admin'. Self token: my_member_id.
WITH wp AS (
  SELECT c.relname AS tbl, p.polname, p.polcmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' | ' ||
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND p.polcmd IN ('a', 'w', 'd', '*')   -- INSERT / UPDATE / DELETE / ALL
)
SELECT '1_SUSPECT_no_role_gate' AS check, tbl,
       CASE polcmd WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END AS cmd,
       polname, expr,
       (expr ~* 'my_department_id') AS dept_scoped
FROM wp
WHERE expr !~* '(is_canmanage|is_canmanage_ops|is_dept_admin|is_department_admin|is_leader|access\s*&&|Project Admin|my_member_id)'
ORDER BY tbl, cmd;

-- ── 2. SUSPECTS — cross-dept class: a WRITE policy that uses is_leader() but has NO my_department_id()
--     predicate (role-anywhere; a leader in dept A acting on dept B). Expect ZERO after the Oct-17 fix.
WITH wp AS (
  SELECT c.relname AS tbl, p.polname, p.polcmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' | ' ||
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND p.polcmd IN ('a', 'w', 'd', '*')
)
SELECT '2_SUSPECT_role_anywhere' AS check, tbl,
       CASE polcmd WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END AS cmd,
       polname, expr
FROM wp
WHERE expr ~* 'is_leader' AND expr !~* 'my_department_id'
ORDER BY tbl, cmd;

-- ── 3. BACKSTOP — can an authenticated client write each RLS table AT ALL (table-level priv)? A suspect
--     from set 1/2 on a table that is RPC-only (all three false) is backstopped like apparatus_checks —
--     NOT a live hole. A suspect on a table with the matching priv true IS a live hole.
SELECT '3_client_write_grants' AS check, c.relname AS tbl,
       has_table_privilege('authenticated', 'public.' || quote_ident(c.relname), 'INSERT') AS ins,
       has_table_privilege('authenticated', 'public.' || quote_ident(c.relname), 'UPDATE') AS upd,
       has_table_privilege('authenticated', 'public.' || quote_ident(c.relname), 'DELETE') AS del
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
ORDER BY c.relname;

-- ── 3b. For any set-1 UPDATE suspect, the per-column UPDATE grants tell us if the broad policy is
--     narrowed by column grants (e.g. duties UPDATE limited to done/done_at). Replace the table list
--     with the suspects set 1 actually returns; duties is pre-filled as the known lead.
SELECT '3b_suspect_update_columns' AS check, a.attrelid::regclass::text AS tbl, a.attname AS col,
       has_column_privilege('authenticated', a.attrelid, a.attname, 'UPDATE') AS can_update
FROM pg_attribute a
WHERE a.attrelid IN ('public.duties'::regclass)   -- add any other set-1 UPDATE suspect here
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY tbl, a.attnum;

-- ── 4. DELETE surface — every DELETE policy + its gate, for the delete-lock extension (3b). The Oct-3
--     lock put training_plans/training_sessions on is_dept_admin + own-dept. This lists where DELETE is
--     still at is_canmanage/is_leader ("leaders delete …") so the reviewer can decide what to tighten.
SELECT '4_delete_policies' AS check, c.relname AS tbl, p.polname,
       pg_get_expr(p.polqual, p.polrelid) AS using_expr,
       has_table_privilege('authenticated', 'public.' || quote_ident(c.relname), 'DELETE') AS client_can_delete
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND p.polcmd = 'd'
ORDER BY c.relname;

-- ── 5. State baseline for the eventual fix's before/after snapshot.
SELECT '5_baseline' AS check,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS verified_token_fns;
