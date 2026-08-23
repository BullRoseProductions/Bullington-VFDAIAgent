-- =====================================================================
-- TAG AI OUTPUTS TO A FUNDRAISER — one nullable FK + its index. Additive.
--
-- WHY: the planner's output stops being a loose draft in a shared pile and
-- becomes THIS fundraiser's plan, readable from its HQ. Same move the action
-- items and calendar events already made in slice 1.
--
-- ON DELETE SET NULL, NOT CASCADE. Deliberate, and the opposite of what the
-- word "belongs to" suggests. An ai_output is a DOCUMENT — a plan somebody
-- generated, possibly edited by hand, possibly the only written record of what
-- the department intended to do. Deleting the fundraiser it was filed under is
-- a filing decision; destroying the document is not the same decision, and
-- CASCADE would silently make it one. SET NULL returns the row to the general
-- fundraiser-drafts pool, where the planner's Saved-drafts list still shows it.
-- Nothing is lost, and it is still discoverable.
--
-- This matches the failsafe posture already on this table: ai_outputs is
-- soft-deleted (deleted_at) and versioned on replace precisely because losing a
-- generated document is expensive. A hard CASCADE here would have quietly
-- undercut that.
--
-- NULLABLE, no backfill, no default. Every ai_output written before this — and
-- every one the other five features write (minutes, agenda, report, recruitment,
-- and untagged fundraiser drafts) — has no fundraiser and should keep saying so.
-- NULL means "not filed under a fundraiser", which is the truth for all of them.
--
-- PARTIAL INDEX. The HQ's only query is
--   WHERE fundraiser_id = $1 AND deleted_at IS NULL
-- so the index covers exactly that and excludes the NULL rows, which will be the
-- overwhelming majority of this table for the foreseeable future — every minutes
-- and agenda document lives here too. Indexing them would be pure overhead on a
-- lookup that never asks for them.
--
-- RLS UNTOUCHED, as briefed. Adding a column inherits every existing policy on
-- public.ai_outputs. Nothing here widens who may read or write a document, and
-- in particular the feature-scoped INSERT branches (report is DA/PA-only) are
-- unaffected.
--
-- DEPLOY GATE: the 5a build writes fundraiser_id on insert and the HQ selects by
-- it, so this must be applied BEFORE that build deploys or PostgREST answers 400
-- on both. It is safe to apply against the CURRENT build, which never mentions
-- the column — existing reads use select("*") or explicit lists that omit it.
-- =====================================================================

BEGIN;

ALTER TABLE public.ai_outputs
  ADD COLUMN IF NOT EXISTS fundraiser_id uuid
    REFERENCES public.fundraisers(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.ai_outputs.fundraiser_id IS
  'Optional: the fundraiser this document was filed under. NULL = not filed under one (all minutes/agenda/report rows, and untagged fundraiser drafts). ON DELETE SET NULL — deleting a fundraiser must not destroy the document.';

-- Matches the HQ query exactly; NULL rows excluded because nothing looks them up.
CREATE INDEX IF NOT EXISTS ai_outputs_fundraiser_id_idx
  ON public.ai_outputs (fundraiser_id)
  WHERE fundraiser_id IS NOT NULL;

COMMIT;

-- Without this, PostgREST keeps serving its cached schema and rejects the first
-- write that mentions fundraiser_id as an unknown column.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only.
-- =====================================================================
--
-- -- 1. Column exists, is uuid, and is NULLABLE. Expect exactly one row:
-- --    fundraiser_id | uuid | YES | NULL
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'ai_outputs'
--    AND column_name = 'fundraiser_id';
--
-- -- 2. THE ONE THAT MATTERS: the FK's delete action must be SET NULL, not
-- --    CASCADE. Expect delete_rule = 'SET NULL' and references public.fundraisers.
-- --    If this says CASCADE, STOP — deleting a fundraiser would destroy its
-- --    documents. Expect one row.
-- SELECT con.conname,
--        pg_get_constraintdef(con.oid) AS definition,
--        CASE con.confdeltype WHEN 'n' THEN 'SET NULL' WHEN 'c' THEN 'CASCADE'
--                             WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
--                             WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
--   FROM pg_constraint con
--  WHERE con.conrelid = 'public.ai_outputs'::regclass
--    AND con.contype = 'f'
--    AND 'fundraiser_id' = ANY (
--          SELECT a.attname FROM pg_attribute a
--           WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey));
--
-- -- 3. Nothing was backfilled — every existing document should still be NULL.
-- --    Expect tagged = 0.
-- SELECT count(*) AS total, count(fundraiser_id) AS tagged FROM public.ai_outputs;
--
-- -- 4. The partial index exists and carries its WHERE clause. Expect one row
-- --    whose indexdef ends with "WHERE (fundraiser_id IS NOT NULL)".
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname = 'public' AND tablename = 'ai_outputs'
--    AND indexname = 'ai_outputs_fundraiser_id_idx';
--
-- -- 5. RLS is untouched: same policies as before, still enforced.
-- SELECT c.relrowsecurity, p.polname, p.polcmd
--   FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
--  WHERE c.oid = 'public.ai_outputs'::regclass
--  ORDER BY p.polname;
