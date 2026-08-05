-- =====================================================================
-- SLICE 7C-1 — is_offsite on training_sessions. SCHEMA ONLY, INERT.
--
-- First step of moving off-site from an ad-hoc member action into training
-- planning. One column and one CHECK. Nothing reads is_offsite until C3/C4,
-- and it defaults false on every existing row, so applying this changes no
-- behaviour and moves no number.
--
-- WHY A FLAG AT ALL: off-site is decided at PLANNING, before anyone is standing
-- anywhere, so coordinates cannot be the signal — they do not exist yet. Slice
-- 7A branched on "are coordinates set", which was right when the only way to
-- become off-site was to set them. It stops being right the moment a session
-- can be marked off-site in advance, because "no coordinates yet" would fall
-- back to verifying against the station members are not at. C3 rewrites that
-- branch to key on this flag; C1 just puts the flag there.
--
-- LOCKED FOR THE C-SERIES (context, not all implemented here):
--   • location is captured at Open sign-in, which is inherently on-site.
--   • the ad-hoc "Working off-site?" button is removed in C2, together with a
--     REVOKE on offsite_check_in so "no caller" is enforced, not assumed.
--   • off-site TRAINING credits immediately as an ordinary verified
--     kind='training' row. It does NOT route through the approval queue —
--     officer-scheduled + officer-on-site + member-geo-verified is already at
--     least as trustworthy as an at-station drill. C3/C4 leave the approval
--     path alone entirely.
--
-- PRECONDITION: I could not check this from my side — the Supabase session is
-- expired and I will not sign in. So the check is built in below and RAISES
-- with the offending rows rather than forcing the constraint. You can also run
-- the standalone pre-flight first:
--
--   SELECT id, title, date, location_lat, location_lng, location_label
--     FROM public.training_sessions
--    WHERE location_lat IS NOT NULL OR location_lng IS NOT NULL;
--
--   -- expect 0 rows. Every such row would violate the new CHECK, because the
--   -- column arrives as false everywhere.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Precondition — refuse rather than force.
--
-- The new column arrives false on every existing row, so ANY row that already
-- holds coordinates would violate "not off-site => no coordinates". Rather than
-- let ADD CONSTRAINT fail with a bare violation message, list them and stop.
-- The whole transaction rolls back, so a refusal costs nothing.
--
-- The Aug-4 recon said with_location = 0. This does not trust that.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_bad  int;
  v_list text;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.training_sessions
   WHERE location_lat IS NOT NULL OR location_lng IS NOT NULL;

  IF v_bad > 0 THEN
    SELECT string_agg(format('%s (%s, %s) lat=%s lng=%s label=%s',
                             id, title, date, location_lat, location_lng,
                             coalesce(location_label, '-')), E'\n  ')
      INTO v_list
      FROM public.training_sessions
     WHERE location_lat IS NOT NULL OR location_lng IS NOT NULL;

    RAISE EXCEPTION
      E'% session(s) already hold coordinates and would violate the new CHECK:\n  %\n\nNothing was changed. Either mark these sessions off-site first, or clear their coordinates with set_session_location(<id>), then re-run.',
      v_bad, v_list;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 1. The flag.
--
-- NOT NULL DEFAULT false: every existing session is at the station, which is
-- both true and the behaviour C3 will preserve for them. Postgres 11+ stores
-- the default in the catalog rather than rewriting the table, so this is a
-- metadata-only operation on any size of table.
-- ---------------------------------------------------------------------
ALTER TABLE public.training_sessions
  ADD COLUMN IF NOT EXISTS is_offsite boolean NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------
-- 2. The invariant: not off-site => no coordinates.
--
-- This is what lets C3's member_check_in branch on the FLAG alone and never
-- worry that a stale coordinate contradicts it. It also means turning the
-- planning toggle back OFF must clear the coordinates — set_session_location's
-- existing clear path (null lat + null lng) already does exactly that, so C4
-- calls it rather than needing anything new.
--
-- Composes with, and does not touch, slice 7A's pair-check
-- training_sessions_location_pair ((location_lat IS NULL) = (location_lng IS NULL)).
-- Together: coordinates come in pairs, and only an off-site session may have them.
--
-- Deliberately NOT the converse. An off-site session with NO coordinates is a
-- legitimate, expected state — that is exactly a drill marked off-site at
-- planning whose location has not been captured yet. C3 is what makes that
-- state fail closed at scan time instead of falling back to the station.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'training_sessions_coords_require_offsite'
       AND conrelid = 'public.training_sessions'::regclass
  ) THEN
    ALTER TABLE public.training_sessions
      ADD CONSTRAINT training_sessions_coords_require_offsite
      CHECK (is_offsite OR (location_lat IS NULL AND location_lng IS NULL));
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 3. Post-condition — prove nothing was rewritten.
--
-- A column add plus a CHECK cannot touch rows. This enforces it rather than
-- asserting it: if the count moved, or anything came out flagged, or the 7A
-- pair-check went missing, the whole transaction rolls back.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_total int;
  v_flagged int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE is_offsite)
    INTO v_total, v_flagged
    FROM public.training_sessions;

  RAISE NOTICE 'training_sessions: % rows, % flagged off-site (expect 0 flagged)', v_total, v_flagged;

  IF v_flagged > 0 THEN
    RAISE EXCEPTION 'Unexpected: % session(s) came out flagged off-site. The column should default false everywhere.', v_flagged;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='training_sessions_location_pair'
                    AND conrelid='public.training_sessions'::regclass) THEN
    RAISE EXCEPTION 'Slice 7A''s training_sessions_location_pair check is missing — stop and inspect before continuing the C-series.';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all from the catalog
-- =====================================================================
--
-- -- 1. The column: NOT NULL, default false.
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='training_sessions' AND column_name='is_offsite';
-- -- expect: boolean | NO | false
--
-- -- 2. BOTH checks present — the new one and 7A's pair-check, untouched.
-- SELECT conname, pg_get_constraintdef(oid) AS definition
--   FROM pg_constraint
--  WHERE conrelid='public.training_sessions'::regclass AND contype='c'
--  ORDER BY conname;
-- -- expect training_sessions_coords_require_offsite AND
-- --        training_sessions_location_pair
--
-- -- 3. No row violates the new CHECK. Expect violations = 0.
-- SELECT count(*) AS violations
--   FROM public.training_sessions
--  WHERE NOT (is_offsite OR (location_lat IS NULL AND location_lng IS NULL));
--
-- -- 4. Row count + flag distribution. Compare `total` against what you saw
-- --    before applying; expect flagged = 0 and with_coords = 0.
-- SELECT count(*) AS total,
--        count(*) FILTER (WHERE is_offsite)            AS flagged,
--        count(*) FILTER (WHERE location_lat IS NOT NULL) AS with_coords
--   FROM public.training_sessions;
--
-- -- 5. Nothing reads it yet — C3 is what teaches member_check_in the flag.
-- --    Expect false.
-- SELECT prosrc ILIKE '%is_offsite%' AS member_check_in_knows_flag
--   FROM pg_proc
--  WHERE proname='member_check_in' AND pronamespace='public'::regnamespace;
