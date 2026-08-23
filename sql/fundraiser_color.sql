-- =====================================================================
-- FUNDRAISER COLOUR — one column, nullable. Small and additive.
--
-- WHY NULLABLE, AND WHY NO BACKFILL. The app derives a stable fallback for
-- NULL: frColor(fr) hashes the fundraiser's id into CATEGORY_COLORS, so every
-- fundraiser already has a distinct-ish, STABLE colour before this column holds
-- anything. Backfilling would write those derived values into the table and buy
-- nothing, while turning "nobody has chosen a colour" and "somebody chose this
-- exact colour" into the same state — which is the distinction that lets the
-- palette be re-ordered later without silently repainting every old fundraiser.
--
-- So: NULL means "derive it", a value means "a human picked this". Those are
-- different facts and the column keeps them different.
--
-- NO CHECK CONSTRAINT ON THE FORMAT, deliberately. The obvious move is
-- CHECK (color ~ '^#[0-9A-Fa-f]{6}$'). It is declined because the writer is a
-- fixed swatch picker over CATEGORY_COLORS — there is no free-text path to this
-- column from the UI — and a constraint here would become the thing that blocks
-- a future palette change to, say, a named token or an rgb() string. The value
-- is presentational: a bad one renders an ugly chip, it does not corrupt a
-- record or mis-state a compliance number. Cheap to add later if a second
-- writer ever appears; expensive to discover mid-migration.
--
-- NO RLS CHANGES. Adding a column to an existing table inherits every policy
-- already on public.fundraisers (dept-scoped + is_canmanage()). Nothing here
-- widens who can read or write a fundraiser row.
--
-- INERT UNTIL THE APP SHIPS. Every existing read uses an explicit column list,
-- so a new column is invisible to them; nothing selects or writes `color` until
-- the matching build lands. Applying this changes no screen and no number.
-- =====================================================================

BEGIN;

-- IF NOT EXISTS so a re-run is a no-op rather than an error. Note this does NOT
-- verify the type if the column somehow already exists with a different one —
-- the VERIFY block below is what actually confirms the shape.
ALTER TABLE public.fundraisers
  ADD COLUMN IF NOT EXISTS color text;

COMMENT ON COLUMN public.fundraisers.color IS
  'Calendar/identity colour, one of CATEGORY_COLORS. NULL = not chosen; the app derives a stable colour from the id instead. Presentational only.';

COMMIT;

-- Closes the PostgREST 400-on-new-column race: without this, the API layer
-- keeps serving its cached schema and rejects the first writes that mention
-- `color` as an unknown column.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only.
-- =====================================================================
--
-- -- 1. The column exists, is text, and is NULLABLE. Expect exactly one row:
-- --    column_name=color | data_type=text | is_nullable=YES | column_default=NULL
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'fundraisers' AND column_name = 'color';
--
-- -- 2. Nothing was backfilled — every existing row should still be NULL, i.e.
-- --    with_color = 0. If this is non-zero, something wrote colours already.
-- SELECT count(*) AS total, count(color) AS with_color FROM public.fundraisers;
--
-- -- 3. No constraint was added on the column (confirming the decision above).
-- --    Expect 0 rows.
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.fundraisers'::regclass
--    AND pg_get_constraintdef(oid) ILIKE '%color%';
--
-- -- 4. RLS is untouched and still enforced. Expect relrowsecurity=t and the
-- --    same policy list as before this migration.
-- SELECT c.relrowsecurity, p.polname, pg_get_expr(p.polqual, p.polrelid) AS using_expr
--   FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
--  WHERE c.oid = 'public.fundraisers'::regclass
--  ORDER BY p.polname;
