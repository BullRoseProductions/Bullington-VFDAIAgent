-- L-2/L-4 Step 0 follow-up. READ-ONLY. (a) every is_leadership()/is_department_admin() caller: real call vs comment-only,
-- and every line that uses v_dept / my_department_id(); (b) the member_active_department row — counts only, no emails.
SELECT p.proname AS name,
       (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'is_leadership\(|is_department_admin\(')::text AS real_call,
       (SELECT string_agg(btrim(l), ' ⏎ ') FROM regexp_split_to_table(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\n') l
         WHERE l ~* 'v_dept|my_department_id\(\)|is_leadership|is_department_admin') AS dept_lines
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~* 'is_leadership\(|is_department_admin\('
   AND p.proname NOT IN ('is_leadership', 'is_department_admin')
UNION ALL
SELECT 'member_active_department', 'rows ' || count(*)::text,
       'pointing at a dept the email is an Active/Probationary member of: ' ||
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.members m WHERE lower(m.email) = mad.email AND m.department_id = mad.department_id AND m.status IN ('Active','Probationary')))::text
  FROM public.member_active_department mad
ORDER BY 1;
