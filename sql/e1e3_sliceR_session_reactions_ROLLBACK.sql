-- =====================================================================
-- ROLLBACK for e1e3_sliceR_session_reactions — insurance, GENERATED from the same capture.
-- Refuses unless Slice R is applied, and REFUSES while the table holds ANY vote (they're real once the UI ships — dropping the
-- table would destroy them). Then: drop the two functions and the table (its policy and index go with it), and prove the rest
-- is untouched: every other function and policy byte-identical to just before, the training_sessions / session_attendance
-- triggers + constraints back on their pins, the ledger functions on theirs.
-- =====================================================================
DO $rollback$
DECLARE v_n bigint; v_others text; v_pol text;
BEGIN
  IF to_regclass('public.training_session_reactions') IS NULL OR to_regprocedure('public.set_session_reaction(uuid, integer)') IS NULL OR to_regprocedure('public.session_reaction_tally(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK: Slice R is not applied. Refusing.';
  END IF;
  SELECT count(*) INTO v_n FROM public.training_session_reactions;
  IF v_n > 0 THEN RAISE EXCEPTION 'ROLLBACK: training_session_reactions holds % vote(s) — dropping it would lose them. Refusing.', v_n; END IF;
  v_others := (SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.oid::regprocedure::text NOT IN ('set_session_reaction(uuid,integer)', 'session_reaction_tally(uuid[])'));
  v_pol := (SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'training_session_reactions');
  DROP FUNCTION public.set_session_reaction(uuid, integer);
  DROP FUNCTION public.session_reaction_tally(uuid[]);
  DROP TABLE public.training_session_reactions;
  IF to_regclass('public.training_session_reactions') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_session_reaction', 'session_reaction_tally'))
     OR (SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.oid::regprocedure::text NOT IN ('set_session_reaction(uuid,integer)', 'session_reaction_tally(uuid[])')) IS DISTINCT FROM v_others
     OR (SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public') IS DISTINCT FROM v_pol
     OR (SELECT md5(string_agg(c.relname || '.' || t.tgname || '|' || pg_get_triggerdef(t.oid), ',' ORDER BY (c.relname || '.' || t.tgname) COLLATE "C")) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgrelid IN ('public.training_sessions'::regclass, 'public.session_attendance'::regclass) AND NOT t.tgisinternal) IS DISTINCT FROM '0e2714dae8ca4600780ea7c49eaf7059' OR (SELECT md5(string_agg(c.relname || '.' || k.conname || '|' || pg_get_constraintdef(k.oid), ',' ORDER BY (c.relname || '.' || k.conname) COLLATE "C")) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.conrelid IN ('public.training_sessions'::regclass, 'public.session_attendance'::regclass) AND k.contype <> 'n') IS DISTINCT FROM '25511204a6c5038b46056c2504be9b99'
     OR md5(pg_get_functiondef('public.attested_training(uuid, timestamp with time zone, timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'aff25333771cd38c1f473bcde5e1e96e' OR md5(pg_get_functiondef('public.dept_iso_hours_for(uuid, timestamp with time zone, timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '705c9a9b5532d28824f5e50e74d6059f' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: not back to the pre-Slice-R state. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
