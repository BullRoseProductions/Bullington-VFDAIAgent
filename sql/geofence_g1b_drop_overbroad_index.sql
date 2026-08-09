-- =====================================================================
-- G1b — drop the over-broad open-row index; keep the scoped ones.
--
-- WHAT IT WAS
--   station_presence_one_open  =  UNIQUE (member_id) WHERE checked_out_at IS NULL
--
-- Created by hand as an early double-check-in guard, before the training ledger
-- existed. It is not in any tracked migration, which is why no recon this
-- session surfaced it — it only appeared when the G1 counter-test tried to hold
-- an open standby row and an open training row for the same member and was
-- refused.
--
-- WHY IT HAS TO GO. It forbids ANY two open rows for a member, across all kinds.
-- That contradicts the ledger's overlap model in three places built since:
--   • slice 0 made station_check_out never close a training row, precisely so a
--     standby punch and an open drill row can coexist;
--   • dept_iso_hours de-overlaps training against standby intervals, which only
--     means anything if both can be open at once;
--   • member_check_in inserts its training presence row with
--     ON CONFLICT (member_id, session_id) WHERE kind='training' ... DO NOTHING,
--     which handles the TRAINING index. A violation of this different index is
--     not caught by that ON CONFLICT, so the function RAISES.
--
-- THE LIVE BUG IT CAUSED. A member clocked in on standby who scans a drill QR
-- hits the unique violation, member_check_in aborts, and because the presence
-- insert and the attendance insert share one transaction, the attendance row
-- rolls back too — so the scan fails outright and records nothing. This is a
-- candidate explanation for why zero kind='training' rows have ever existed in
-- this database, though it is not proof of it.
--
-- OVERLAP MODEL (owner-confirmed): training and standby coexist. dept_iso_hours
-- de-overlaps with training winning, so the same minute is never counted twice
-- and training time never reads as standby.
--
-- WHAT REPLACES IT — nothing new; three narrower indexes already do the real work:
--   station_presence_one_open_session_per_member
--     UNIQUE (member_id) WHERE checked_out_at IS NULL
--                          AND kind IN ('standby','offsite')
--     The guarantee G2 needs: a member cannot hold two open standby/offsite
--     sessions, so the PWA and the geofence daemon cannot both open one.
--   station_presence_one_open_offsite_per_member
--     UNIQUE (member_id) WHERE kind='offsite' AND checked_out_at IS NULL
--     Strict subset of the above; harmless, kept rather than churned.
--   station_presence_one_training_per_session
--     UNIQUE (member_id, session_id) WHERE kind='training' AND session_id IS NOT NULL
--     Idempotent scans: a double-tap cannot create two rows for one drill.
--
-- Net effect: double check-in is still impossible for the kinds a MEMBER can
-- start, and a drill can once again be scanned by someone already on shift.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Refuse to run unless the three scoped indexes are all present.
--
-- Dropping the broad one is only safe because they exist. If any is missing,
-- this would remove the last protection against a member holding two open
-- standby rows — the exact race G2's geofence daemon introduces.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(want, ', ')
    INTO v_missing
    FROM (VALUES
      ('station_presence_one_open_session_per_member'),
      ('station_presence_one_open_offsite_per_member'),
      ('station_presence_one_training_per_session')
    ) AS t(want)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND tablename='station_presence' AND indexname = t.want);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to drop the broad index — these scoped indexes are missing: %. Nothing was changed.', v_missing;
  END IF;
  RAISE NOTICE 'All three scoped indexes present — safe to drop the broad one.';
END $$;


-- ---------------------------------------------------------------------
-- 2. Drop it.
--
-- IF EXISTS so the file is re-runnable. Its definition is recorded in this
-- file's header, so recreating it is a copy-paste if the decision is ever
-- reversed.
-- ---------------------------------------------------------------------
DROP INDEX IF EXISTS public.station_presence_one_open;


-- ---------------------------------------------------------------------
-- 3. Post-conditions.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_still int; v_kept int;
BEGIN
  SELECT count(*) INTO v_still FROM pg_indexes
   WHERE schemaname='public' AND tablename='station_presence' AND indexname='station_presence_one_open';
  IF v_still > 0 THEN
    RAISE EXCEPTION 'station_presence_one_open is still present after the drop — stop and inspect.';
  END IF;

  SELECT count(*) INTO v_kept FROM pg_indexes
   WHERE schemaname='public' AND tablename='station_presence'
     AND indexname IN ('station_presence_one_open_session_per_member',
                       'station_presence_one_open_offsite_per_member',
                       'station_presence_one_training_per_session');
  IF v_kept <> 3 THEN
    RAISE EXCEPTION 'Expected 3 scoped indexes after the drop, found % — stop and inspect.', v_kept;
  END IF;

  RAISE NOTICE 'Broad index dropped; all 3 scoped indexes intact.';
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. The broad index is gone and the scoped ones remain. Expect 6 rows and
-- --    NO station_presence_one_open.
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname='public' AND tablename='station_presence' ORDER BY indexname;
--
-- -- 2. THE COUNTER-TEST, re-run. All three inserts must now SUCCEED and the
-- --    final SELECT must return 3 rows. ROLLBACK discards everything.
-- --    This is the whole point of the slice — run it.
-- --
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind)
-- --     SELECT department_id, id, true, 'geo', 'standby' FROM public.members LIMIT 1;
-- --
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind, checked_out_at)
-- --     SELECT department_id, id, true, 'geo', 'standby', now() FROM public.members LIMIT 1;
-- --
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind)
-- --     SELECT department_id, id, true, 'geo', 'training' FROM public.members LIMIT 1;
-- --
-- --     SELECT kind, CASE WHEN checked_out_at IS NULL THEN 'open' ELSE 'closed' END AS state, count(*)
-- --       FROM public.station_presence
-- --      WHERE member_id = (SELECT id FROM public.members LIMIT 1)
-- --      GROUP BY 1,2 ORDER BY 1,2;
-- --   ROLLBACK;
--
-- -- 3. The DUPLICATE probe must still FAIL — dropping the broad index must not
-- --    have opened the door G1 exists to close. Expect 23505 on the 2nd insert,
-- --    naming station_presence_one_open_session_per_member.
-- --
-- --   BEGIN;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind)
-- --     SELECT department_id, id, true, 'geo', 'standby' FROM public.members LIMIT 1;
-- --     INSERT INTO public.station_presence (department_id, member_id, verified, source, kind)
-- --     SELECT department_id, id, true, 'gps_geofence', 'standby' FROM public.members LIMIT 1;
-- --   ROLLBACK;
--
-- -- 4. Nothing was written by any of the above. Expect 28 (or whatever the
-- --    current real count is) and 0 rows with source='gps_geofence'.
-- SELECT count(*) AS total,
--        count(*) FILTER (WHERE source='gps_geofence') AS probe_leakage
--   FROM public.station_presence;
