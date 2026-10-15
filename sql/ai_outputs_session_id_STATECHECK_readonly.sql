-- READ-ONLY. What did the failed run of ai_outputs_session_id_2026-10-15.sql leave behind? Nothing here writes.
-- All false / 0 = nothing applied. Any true / 1 = a partial apply (the fixed migration finishes it safely).
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ai_outputs' AND column_name = 'session_id') AS column_exists,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_outputs_session_id_minutes_only')                                                  AS check_exists,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_ai_outputs_session_id' AND NOT tgisinternal)                                    AS trigger_exists,
  to_regprocedure('public.guard_ai_outputs_session_id()') IS NOT NULL                                                                         AS guard_fn_exists,
  to_regprocedure('public.assign_minutes_to_session(uuid, uuid)') IS NOT NULL                                                                 AS rpc_exists,
  CASE WHEN to_regprocedure('public.assign_minutes_to_session(uuid, uuid)') IS NULL THEN NULL
       ELSE has_function_privilege('anon', 'public.assign_minutes_to_session(uuid, uuid)', 'EXECUTE') END                                    AS anon_can_execute_rpc,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ai_outputs_session_id_idx')                                  AS index_exists,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_outputs')                                                 AS ai_outputs_policies;
