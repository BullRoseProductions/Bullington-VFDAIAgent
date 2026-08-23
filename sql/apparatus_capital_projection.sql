-- =====================================================================
-- CAPITAL REPLACEMENT — projection inputs. Two nullable columns. Additive.
--
-- WHAT THIS ENABLES: today's replacement cost plus an inflation rate, so the
-- app can PROJECT what a rig will cost in its replacement year rather than
-- asking a department to guess a 2034 figure in 2026. Nobody knows what a
-- pumper costs in eight years; everybody knows what one costs today.
--
-- replace_cost IS NOT REPLACED, it becomes the OVERRIDE. That is the whole
-- shape of this change:
--   current_cost + inflation_rate  -> the projection, computed
--   replace_cost                   -> a human's figure, wins when present
-- A department with a real quote from a dealer, or a board-adopted number,
-- must be able to state it and have the report use it. A projection that
-- silently overrode a known price would be worse than no projection.
--
-- NULLABLE, NO BACKFILL, NO DEFAULT. Every existing rig keeps working exactly
-- as it does today: replace_cost is still whatever was typed, and a rig with no
-- current_cost simply has nothing to project from. Writing a default inflation
-- rate into every row would be inventing a department's assumption for them —
-- the 3% fallback is a display-time default (and a visible, editable prefill on
-- the add form), not a stored fact.
--
-- NUMERIC, not integer, for both. current_cost so cents survive if anyone pastes
-- them; inflation_rate because 3.5% is an ordinary answer and an integer column
-- would round it to 3 or 4 without saying so.
--
-- NO CHECK CONSTRAINTS. The only writer is the apparatus form, which validates
-- range client-side, and a bad number here produces a wrong projection on one
-- screen — not a corrupted record or a mis-stated compliance figure. A CHECK on
-- the rate would also have to guess a plausible band, and guessing wrong blocks
-- a department in a way that is hard to diagnose from the UI.
--
-- NO RLS CHANGE. Adding columns inherits every policy already on
-- public.apparatus. Nothing here widens who may read or write a rig.
--
-- DEPLOY GATE: the 4a build names both columns in the apparatus select and
-- writes them in capPayload, so this must be applied BEFORE that build deploys
-- or PostgREST answers 400 on the apparatus read and every rig save. Safe to
-- apply against the CURRENT build, which never mentions them — its select is an
-- explicit column list that omits both.
-- =====================================================================

BEGIN;

ALTER TABLE public.apparatus
  ADD COLUMN IF NOT EXISTS current_cost numeric;

ALTER TABLE public.apparatus
  ADD COLUMN IF NOT EXISTS inflation_rate numeric;

COMMENT ON COLUMN public.apparatus.current_cost IS
  'What it would cost to replace this rig in TODAY''s dollars. Feeds the projection; NULL = not tracked.';
COMMENT ON COLUMN public.apparatus.inflation_rate IS
  'Percent per year used to project current_cost forward to replace_year. NULL = use the app default (3%). Stored as a percent, so 3.5 means 3.5%/yr.';

COMMIT;

-- Without this, PostgREST keeps serving its cached schema and rejects the first
-- read or write that names either column.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only.
-- =====================================================================
--
-- -- 1. Both columns exist, are numeric, and are NULLABLE. Expect exactly two
-- --    rows, both is_nullable = YES and column_default = NULL.
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'apparatus'
--    AND column_name IN ('current_cost', 'inflation_rate')
--  ORDER BY column_name;
--
-- -- 2. Nothing was backfilled — every existing rig should still be NULL on both.
-- --    Expect with_current_cost = 0 and with_rate = 0.
-- SELECT count(*) AS total,
--        count(current_cost)   AS with_current_cost,
--        count(inflation_rate) AS with_rate
--   FROM public.apparatus;
--
-- -- 3. replace_cost is UNTOUCHED and still holds whatever was already typed —
-- --    it is now the override, not a casualty. Compare this to what you expect.
-- SELECT count(*) AS total, count(replace_cost) AS with_override
--   FROM public.apparatus;
--
-- -- 4. No constraint was added on either column (confirming the decision above).
-- --    Expect 0 rows.
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.apparatus'::regclass
--    AND (pg_get_constraintdef(oid) ILIKE '%current_cost%'
--      OR pg_get_constraintdef(oid) ILIKE '%inflation_rate%');
--
-- -- 5. RLS untouched: still enforced, same policy list as before.
-- SELECT c.relrowsecurity, p.polname, p.polcmd
--   FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
--  WHERE c.oid = 'public.apparatus'::regclass
--  ORDER BY p.polname;
