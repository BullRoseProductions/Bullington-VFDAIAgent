-- =====================================================================
-- SLICE 2 — officer-close stamps the training stop time.
--
-- RUN ONLY AFTER sql/slice0_training_ledger_safety.sql AND
-- sql/slice1_training_geoverify.sql ARE LIVE.
--
-- WHAT THIS CLOSES: Slice 1 made a QR scan write an OPEN kind='training' row
-- (checked_in_at = scan time, checked_out_at = null). Until something stamps
-- checked_out_at, every training row has a null stop and credits ZERO hours.
-- This file stamps it the moment the officer finalizes the session.
--
-- Each member's training hours then = checked_out_at - checked_in_at, per row.
-- No ended_at column is added to training_sessions — the stop deliberately lives
-- on each presence row, because members scan in at different times and the credit
-- is per-member, not a flat session length.
--
-- TRIGGER, NOT RPC — see the recon note in item 2 below.
--
-- NO CLIENT CHANGE IS REQUIRED BY THIS FILE. The existing "Finalize & lock
-- attendance" button (src/App.jsx:10920, a direct UPDATE of done:true) starts
-- stamping stop times the moment this SQL is applied. Deploy order is therefore
-- unconstrained; there is no old-client/new-client window.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Index that serves the trigger's UPDATE.
--
-- Slice 0's unique index leads with member_id, so it cannot serve a
-- session_id-only lookup. Postgres does NOT auto-index the referencing side of
-- station_presence_session_id_fkey either. This partial index covers exactly the
-- trigger's WHERE clause and stays tiny — rows drop out of it the instant they
-- are closed, so it only ever holds currently-open training rows.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS station_presence_open_training_by_session
  ON public.station_presence (session_id)
  WHERE kind = 'training' AND checked_out_at IS NULL;


-- ---------------------------------------------------------------------
-- 2. Trigger function — stamp every open training row for the session.
--
-- WHY A TRIGGER AND NOT AN RPC (recon result):
--   `done` is set by a DIRECT CLIENT UPDATE, not an RPC —
--     src/App.jsx:10920  .from("training_sessions").update({ done: true })   finalize
--     src/App.jsx:10938  .from("training_sessions").update({ done: false })  reopen
--   There is no finalize RPC to stamp inside. An RPC would mean inventing one AND
--   editing the client, and would still be bypassable by any other write path
--   (the Supabase dashboard, a future admin screen, a bulk fix-up). A trigger
--   catches every path, needs no client change, and stamps now() SERVER-SIDE so
--   the stop time cannot be spoofed by a caller.
--
-- SECURITY DEFINER is REQUIRED, not stylistic: station_presence has RLS, and the
-- finalizing officer has no UPDATE grant over OTHER members' presence rows. As
-- the invoker the trigger would silently update 0 rows — the worst possible
-- failure, since finalize would still report success while crediting no hours.
--
-- IDEMPOTENT: the `checked_out_at IS NULL` guard means re-finalizing a session
-- (finalize -> reopen -> finalize) never re-stamps an already-closed row, so a
-- member's stop time is whatever the FIRST close recorded.
--
-- NEVER REOPENS: this only ever writes a non-null checked_out_at. Un-doing a
-- session (true -> false) does not fire it at all — see the WHEN clause below —
-- and nothing here can null a stop time back out.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_training_presence_on_done()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.station_presence
     set checked_out_at = now()
   where session_id = new.id
     and kind = 'training'
     and checked_out_at is null;
  return null;   -- AFTER trigger: return value is ignored
end;
$function$;

-- Trigger functions fire regardless of EXECUTE privilege; revoking keeps it off
-- the PostgREST surface so nobody can call it directly. (House rule: Postgres
-- default-grants EXECUTE to PUBLIC on every new function.)
REVOKE EXECUTE ON FUNCTION public.close_training_presence_on_done() FROM anon, public;


-- ---------------------------------------------------------------------
-- 3. The trigger itself.
--
-- WHEN (old.done IS DISTINCT FROM new.done AND new.done = true) fires ONLY on a
-- genuine false -> true transition:
--   • false -> true  → FIRES (the officer finalized)
--   • true  -> true  → skipped (any other edit to a finalized row)
--   • true  -> false → skipped (reopen — rows stay closed, hours preserved)
--   • null  -> true  → FIRES  (IS DISTINCT FROM is null-safe)
--   • x     -> null  → skipped (`null = true` is null, which is not true)
-- Evaluating this in the WHEN clause rather than the body means the function
-- body is not even entered on unrelated updates (title, date, audience edits).
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_close_training_presence_on_done ON public.training_sessions;
CREATE TRIGGER trg_close_training_presence_on_done
  AFTER UPDATE ON public.training_sessions
  FOR EACH ROW
  WHEN (old.done IS DISTINCT FROM new.done AND new.done = true)
  EXECUTE FUNCTION public.close_training_presence_on_done();

COMMIT;

-- No NOTIFY needed — no table columns or API-visible functions changed. Harmless
-- to run, and kept for consistency with the other migrations in this series.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
-- -- 1. Trigger exists, is AFTER UPDATE, and carries the WHEN guard:
-- SELECT tgname, pg_get_triggerdef(oid)
--   FROM pg_trigger
--  WHERE tgrelid = 'public.training_sessions'::regclass AND NOT tgisinternal;
--
-- -- 2. The function is SECURITY DEFINER (prosecdef = true). If this is false the
-- --    trigger will silently update 0 rows under RLS.
-- SELECT proname, prosecdef, proconfig
--   FROM pg_proc
--  WHERE proname = 'close_training_presence_on_done'
--    AND pronamespace = 'public'::regnamespace;
--
-- -- 3. station_presence must NOT have FORCE ROW LEVEL SECURITY — if
-- --    relforcerowsecurity is true, even the owner is subject to RLS and the
-- --    SECURITY DEFINER update would still be filtered. Expect false.
-- SELECT relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE oid = 'public.station_presence'::regclass;
--
-- -- 4. Nothing left stranded: open training rows whose session is ALREADY done.
-- --    Deliberately NOT auto-backfilled — stamping those with now() would credit
-- --    hours that were never worked. Expect 0 rows (Slice 1 is new). If any turn
-- --    up, decide the stop time deliberately rather than letting this file guess.
-- SELECT sp.id, sp.member_id, sp.session_id, sp.checked_in_at, ts.title, ts.date
--   FROM public.station_presence sp
--   JOIN public.training_sessions ts ON ts.id = sp.session_id
--  WHERE sp.kind = 'training' AND sp.checked_out_at IS NULL AND ts.done;
--
-- -- 5. End-to-end proof, AFTER a scan + finalize. Every row should show a
-- --    non-null stop and a sane duration.
-- SELECT member_id, session_id, verified, checked_in_at, checked_out_at,
--        round(extract(epoch FROM (checked_out_at - checked_in_at)) / 3600.0, 2) AS hours
--   FROM public.station_presence
--  WHERE kind = 'training'
--  ORDER BY checked_in_at DESC;
