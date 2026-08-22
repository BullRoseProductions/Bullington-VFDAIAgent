-- =====================================================================
-- notifications.pushed_at — slice 2. INERT.
--
-- The drain marker. Slice 4's trigger will write notification rows the moment an
-- action item is assigned, and pulse will later claim the unsent ones by setting
-- pushed_at. Nothing writes or reads it yet.
--
-- NULLABLE, AND EXISTING ROWS STAY NULL ON PURPOSE. NULL means "not pushed", and
-- every row already in the table was in fact pushed by the digest — so on paper
-- they are mislabelled. Backfilling them to now() would be a lie of a different
-- shape (they were not pushed now), and the honest fix is that the drain query
-- in slice 4 will be bounded by created_at as well as pushed_at IS NULL, so it
-- can never reach back and re-push history. Recorded here because a future
-- reader WILL see NULLs on pushed rows and wonder.
--
-- The partial index is the drain's access path: it indexes only unsent rows, so
-- it stays small no matter how large the table grows.
-- =====================================================================

BEGIN;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz;

COMMENT ON COLUMN public.notifications.pushed_at IS
  'When push was sent for this row. NULL = not yet pushed. Rows predating this column are NULL despite having been pushed; the drain is bounded by created_at so it cannot re-push them.';

CREATE INDEX IF NOT EXISTS notifications_unpushed_idx
  ON public.notifications (created_at)
  WHERE pushed_at IS NULL;

COMMIT;

-- Closes the PostgREST 400-on-new-column race: without this, the API layer keeps
-- serving a cached schema that has no pushed_at and rejects any request naming it.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. Column exists, nullable, no default.
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='notifications' AND column_name='pushed_at';
--
-- -- 2. Partial index present.
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname='public' AND tablename='notifications' AND indexname='notifications_unpushed_idx';
--
-- -- 3. Nothing was touched. Every existing row should still be NULL, and the
-- --    count should equal the total row count.
-- SELECT count(*) AS total, count(*) FILTER (WHERE pushed_at IS NULL) AS unpushed
--   FROM public.notifications;
