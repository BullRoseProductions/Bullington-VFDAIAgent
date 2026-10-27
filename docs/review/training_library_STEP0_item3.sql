-- READ-ONLY (Training Library Step 0, item 3: schedule-aware recommendations). Category names + cadence + last_iso
-- (department training topics — not personal data), how many are overdue now, how sessions link to categories,
-- and drill_plans' category vs training_plans names. No writes.
WITH tp AS (
  SELECT p.*, d.name dept,
         CASE p.cadence WHEN 'Weekly' THEN 7 WHEN 'Bi-weekly' THEN 14 WHEN 'Monthly' THEN 30 WHEN 'Quarterly' THEN 90
                        WHEN 'Semi-annual' THEN 180 WHEN 'Annual' THEN 365 WHEN 'Biennial' THEN 730 END cad_days,
         (SELECT min(s.date) FROM public.training_sessions s WHERE s.plan_id = p.id AND NOT s.done AND coalesce(s.status, 'scheduled') <> 'cancelled'
            AND s.date >= (now() AT TIME ZONE 'America/Chicago')::date) next_scheduled
    FROM public.training_plans p JOIN public.departments d ON d.id = p.department_id)
SELECT jsonb_pretty(jsonb_build_object(
  'categories', (SELECT jsonb_agg(jsonb_build_object('dept', dept, 'name', name, 'cadence', cadence, 'last_iso', last_iso, 'next_scheduled', next_scheduled,
       'state', CASE WHEN cadence = 'One-off' THEN 'one-off' WHEN last_iso IS NULL THEN 'never logged'
                     WHEN next_scheduled IS NOT NULL THEN 'scheduled (reconciled)'
                     WHEN last_iso + cad_days < (now() AT TIME ZONE 'America/Chicago')::date THEN 'OVERDUE'
                     WHEN last_iso + cad_days - least(round(cad_days * 0.25), 30)::int <= (now() AT TIME ZONE 'America/Chicago')::date THEN 'due soon'
                     ELSE 'on track' END) ORDER BY dept, name) FROM tp),
  'cadence_values', (SELECT jsonb_object_agg(coalesce(cadence, '(null)'), n) FROM (SELECT cadence, count(*) n FROM public.training_plans GROUP BY 1) x),
  'sessions_with_plan', (SELECT jsonb_build_object('total', count(*), 'with_plan_id', count(*) FILTER (WHERE plan_id IS NOT NULL),
       'done_with_plan_id', count(*) FILTER (WHERE plan_id IS NOT NULL AND done)) FROM public.training_sessions),
  'drill_plans', (SELECT jsonb_build_object('rows', count(*), 'with_category', count(*) FILTER (WHERE category IS NOT NULL),
       'category_matches_a_plan_name', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.training_plans p WHERE p.department_id = dp.department_id AND p.name = dp.category))) FROM public.drill_plans dp),
  'session_plans_by_category', (SELECT jsonb_build_object('total', count(*), 'on_session_with_plan_id', count(*) FILTER (WHERE s.plan_id IS NOT NULL))
       FROM public.session_plans sp JOIN public.training_sessions s ON s.id = sp.session_id),
  'last_iso_fn', (SELECT md5(pg_get_functiondef('public.recompute_training_plan_last_iso(uuid)'::regprocedure))),
  'last_iso_trigger', (SELECT coalesce(jsonb_agg(tgrelid::regclass::text || '.' || tgname), '[]'::jsonb) FROM pg_trigger WHERE NOT tgisinternal
       AND tgfoid IN (SELECT oid FROM pg_proc WHERE prokind = 'f' AND pronamespace = 'public'::regnamespace AND pg_get_functiondef(oid) ILIKE '%recompute_training_plan_last_iso%' AND proname <> 'recompute_training_plan_last_iso'))
)) AS r;
