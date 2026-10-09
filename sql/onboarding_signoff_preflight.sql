-- =====================================================================
-- ONBOARDING SIGN-OFF — PREFLIGHT. READ-ONLY. Run this BEFORE
-- sql/onboarding_signoff.sql and paste the results back.
--
-- schema.sql is stale for these tables: it shows onboarding_progress.item_key
-- (text, NOT NULL) while the app reads and upserts item_id with
-- onConflict "member_id,item_id". Only the live catalog says which is true,
-- and the migration's insert depends on it.
-- =====================================================================

-- 1. Columns on both tables (expect onboarding_progress.item_id, and no NOT NULL item_key).
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name in ('onboarding_progress', 'onboarding_items')
 order by table_name, ordinal_position;

-- 2. The unique constraint the upsert relies on (expect one on (member_id, item_id)).
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'public.onboarding_progress'::regclass;

-- 3. Every policy on both tables — who can read and who can write today.
select tablename, policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename in ('onboarding_progress', 'onboarding_items')
 order by tablename, cmd, policyname;

-- 4. Table grants (the migration revokes INSERT/UPDATE on progress from authenticated).
select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privs
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name in ('onboarding_progress', 'onboarding_items')
   and grantee in ('anon', 'authenticated')
 group by grantee, table_name;

-- 5. The gate functions the RPC and policies call, and the name is free.
select proname, pg_get_function_identity_arguments(oid) as args, prosecdef
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('is_canmanage', 'my_member_id', 'my_department_id', 'is_leader', 'set_onboarding_item')
 order by proname;
