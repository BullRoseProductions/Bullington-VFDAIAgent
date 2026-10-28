-- READ-ONLY: is_announcer() — full def + every caller (policies / functions / views), comments stripped.
SELECT 'def' AS kind, 'is_announcer' AS name, md5(pg_get_functiondef(p.oid)) || ' · ' || p.proacl::text || ' · ' || p.provolatile::text || ' · ' || coalesce(p.proconfig::text, '') AS info, pg_get_functiondef(p.oid) AS detail
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_announcer'
UNION ALL
SELECT 'policy', c.relname || ' · ' || p.polname, CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
       'USING ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '—') || ' | CHECK ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '—')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
 WHERE c.relnamespace = 'public'::regnamespace AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~* 'is_announcer\('
UNION ALL
SELECT 'function', p.proname, CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END,
       (SELECT string_agg(btrim(l), ' ⏎ ') FROM regexp_split_to_table(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\n') l WHERE l ~* 'is_announcer|v_dept|my_department_id\(\)|department_id')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'is_announcer' AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'is_announcer\('
UNION ALL
SELECT 'view', c.relname, '', left(pg_get_viewdef(c.oid), 300) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) ~* 'is_announcer\('
ORDER BY 1, 2;
