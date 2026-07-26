-- =====================================================================
-- Add a third audience value 'board' to training_sessions.
-- Self-determining: works whether or not a CHECK constraint exists today.
--   * drops ANY existing CHECK that references audience, then
--   * adds the canonical 3-value guard.
-- Safe: every existing value (everyone / leadership) is in the new set, and NULL
-- passes a CHECK. Idempotent (re-running drops+re-adds the same constraint).
-- Run this in Supabase FIRST, then the app can save 'board' events. VERIFY below.
-- =====================================================================
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'public.training_sessions'::regclass
      AND pg_get_constraintdef(oid) ILIKE '%audience%'
  LOOP
    EXECUTE format('ALTER TABLE public.training_sessions DROP CONSTRAINT %I', c);
  END LOOP;

  ALTER TABLE public.training_sessions
    ADD CONSTRAINT training_sessions_audience_check
    CHECK (audience IN ('everyone', 'leadership', 'board'));
END $$;

-- =====================================================================
-- VERIFY (run separately): the check now allows all three values.
-- =====================================================================
-- select conname, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid = 'public.training_sessions'::regclass and contype = 'c'
--   and pg_get_constraintdef(oid) ilike '%audience%';
--   expect: CHECK (audience IN ('everyone','leadership','board'))
