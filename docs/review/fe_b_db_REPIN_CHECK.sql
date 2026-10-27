-- READ-ONLY re-check (after the rebase onto 361f5ff, i.e. after WS-3 was applied live): do FE-B-DB's pins still hold?
-- Mirrors the migration's pre-flight without running it. No writes.
WITH pins(sig, md5) AS (VALUES
  ('public.cancel_action_item(uuid,text)', '2c5cac1238c59f68b25c4e4013c0489f'), ('public.complete_action_item(uuid)', 'af1dc282df773b252b9ef4e2ffb67bf2'),
  ('public.get_station_fundraisers()', '1d8634cfd5bdfcca54fe7379b36da916'), ('public.is_canmanage()', '44083b6d721a50ace3ad21280e2260d3'),
  ('public.is_canmanage_ops()', '92fa180343748968dff96fa044b0420d'), ('public.is_dept_admin()', 'c692e44f62923d2bf4c1a39a21a87bf7'),
  ('public.is_leader()', '3f462af26a46909309f856f769226baa'), ('public.is_muted(uuid,text)', '4e5107d4104e2ac4a8bd2d2347b5db49'),
  ('public.my_department_id()', '87f546659c3804a943b48e419e017f18'), ('public.my_department_rollup()', '7f9723c917b30cbe030db328fe6b8255'),
  ('public.my_member_id()', '3f66369c8af7bc07ec59831af6536fee'), ('public.notify_action_item_assigned()', '55b3058c7977d0e1ce643c77cb4ac5eb'),
  ('public.reopen_action_item(uuid)', '76513cd2c2468faad981e52f61db6408'), ('public.set_fundraiser_shared(uuid,boolean)', '6dc0f4c97d2b4426c259025f4a8e588e'),
  ('public.set_fundraiser_step_visible(uuid,boolean)', '3b3c1da70032b0b83c20113d39db3d68'))
SELECT jsonb_pretty(jsonb_build_object(
  'pins_ok', (SELECT count(*) FROM pins WHERE md5(pg_get_functiondef(to_regprocedure(sig))) = md5),
  'pins_total', (SELECT count(*) FROM pins),
  'pins_drifted', (SELECT coalesce(jsonb_agg(sig), '[]'::jsonb) FROM pins WHERE to_regprocedure(sig) IS NULL OR md5(pg_get_functiondef(to_regprocedure(sig))) <> md5),
  'event_and_action_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('recruitment_events', 'funding_events', 'action_items')),
  'policy_snapshot_md5', (SELECT md5(string_agg(tablename || '.' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname))
                            FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('recruitment_events', 'funding_events', 'action_items')),
  'fe_b_names_clear', NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('claim_event_need', 'unclaim_event_need', 'assign_event_need', 'remove_event_need_claim', 'tg_event_needs_guard'))
                      AND to_regclass('public.event_needs') IS NULL AND to_regclass('public.event_need_claims') IS NULL,
  'total_public_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
)) AS r;
