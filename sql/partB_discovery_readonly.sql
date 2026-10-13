-- =====================================================================
-- Part B DISCOVERY — READ-ONLY. ONE SELECT statement (the SQL editor shows only the
-- last statement's result, so everything is a single result set).
-- Reads system catalogs / information_schema only. No DDL, no DML, no SET, no
-- function that writes. to_regclass / pg_get_constraintdef / pg_get_function_identity_arguments
-- are pure lookups.
-- =====================================================================
select 'B1 column' as section, column_name::text as name,
       data_type || ' | nullable=' || is_nullable || ' | default=' || coalesce(column_default, '-') as detail
  from information_schema.columns
 where table_schema = 'public' and table_name = 'apparatus_maintenance_log'
union all
select 'B1 constraint', conname::text, pg_get_constraintdef(oid)
  from pg_constraint where conrelid = to_regclass('public.apparatus_maintenance_log')
union all
select 'policy ' || tablename, policyname::text,
       cmd || ' | roles=' || roles::text || ' | using=' || coalesce(qual, '-') || ' | check=' || coalesce(with_check, '-')
  from pg_policies
 where schemaname = 'public' and tablename in ('apparatus_maintenance_log', 'apparatus_maintenance', 'apparatus')
union all
select 'gate fn', proname::text, 'definer=' || prosecdef || ' | args=(' || pg_get_function_identity_arguments(oid) || ')'
  from pg_proc where pronamespace = 'public'::regnamespace
   and proname in ('is_canmanage', 'is_canmanage_ops', 'is_dept_admin', 'is_equipment_manager', 'my_department_id', 'my_member_id')
union all
select 'B3 name free', 'equipment_issues', coalesce(to_regclass('public.equipment_issues')::text, 'FREE')
union all
select 'B2 name free', 'apparatus.check_interval_days',
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                          and table_name = 'apparatus' and column_name = 'check_interval_days') then 'EXISTS' else 'FREE' end
order by 1, 2;
