-- READ-ONLY Step 0 (Funding / Events) part 2: the gate + station-sharing function bodies, and the legacy `events` table's use.
SELECT jsonb_pretty(jsonb_build_object(
  'defs', (SELECT jsonb_object_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid))
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
              AND p.proname IN ('is_canmanage', 'is_canmanage_ops', 'is_leader', 'session_reg_is_leader', 'get_station_fundraisers',
                                'set_fundraiser_shared', 'set_fundraiser_step_visible', 'my_department_rollup')),
  'events_rows', (SELECT jsonb_agg(jsonb_build_object('dept', d.name, 'date', e.date, 'type', e.type, 'present', e.present, 'total', e.total, 'created', e.created_at::date))
                    FROM public.events e JOIN public.departments d ON d.id = e.department_id),
  'fundraisers_rows', (SELECT jsonb_agg(jsonb_build_object('dept', d.name, 'status', f.status, 'shared', f.shared_with_station, 'target', f.target_date, 'created', f.created_at::date))
                    FROM public.fundraisers f JOIN public.departments d ON d.id = f.department_id),
  'fk_into_events_tables', (SELECT coalesce(jsonb_agg(conrelid::regclass::text || ' -> ' || confrelid::regclass::text || ' ' || conname), '[]'::jsonb) FROM pg_constraint
                              WHERE contype = 'f' AND confrelid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass, 'public.events'::regclass, 'public.fundraisers'::regclass))
)) AS r;
