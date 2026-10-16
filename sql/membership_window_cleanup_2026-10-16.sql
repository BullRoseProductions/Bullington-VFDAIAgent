-- =====================================================================
-- MEMBERSHIP WINDOW CLEANUP — ONE-OFF DATA REPAIR. Record: Claude gate review PASS (exemplary) 2026-10-16 — recorded AFTER apply (applied by hand earlier the same day).
-- APPLIED by hand 2026-10-16. Do NOT re-run
-- as-is (the counts are spent). Result on live: paul_terminated_on 2026-10-09 · paul_certs 0 · prejoin_left 0 ·
-- postexit_left 0 · paul_attendance_kept 11. Deleted: 1 pre-join row (Kai Newton, 9/18 drill), 0 post-exit, 41 Paul certs.
-- For a later pass (e.g. Jared Allen once his join date is on file): re-run the PREVIEW and refill the constants.
-- ORDER: membership_window (migration) -> its RETEST -> membership_window_cleanup_PREVIEW.sql -> THIS.
--
-- REFUSES TO RUN until the three EXPECT_ constants below are filled in from the PREVIEW's SUMMARY rows. Each delete
-- must match its preview count EXACTLY or the whole block raises and nothing changes. If anything moved between the
-- preview and this run (a new check-in, an edited join date), re-run the preview and refill.
--
-- WHAT IT DOES, all-or-nothing:
--   1. Paul Stetzel: termination date 2026-10-09 (member_separation; refuses if a DIFFERENT date is already on file).
--   2. Deletes attendance on drills dated BEFORE the member's start (joined_date, else Jan 1 of `joined`'s year —
--      the same rule the trigger enforces).
--   3. Deletes attendance on drills dated AFTER the member's termination date (the end day itself is kept).
--   4. Deletes every certs row of Paul Stetzel.
-- WHAT IT KEEPS: all of Paul's attendance on or before 10/9 and his hours history; every station_presence row
-- (geo-verified hours — the preview lists any that sit on a deleted attendance row); cert_submissions; the proof
-- files in storage (SQL can't remove them — the preview lists their paths). The `verified` column is not written.
-- DRY RUN 2026-10-16 — PGlite mock (Kia: joined 9/1 on an Aug drill; Paul: drills Aug/Oct 1/Oct 9/Oct 12 + 3 certs +
-- a geo-hours row on Oct 12): blank constants -> refuses; wrong count -> raises, attendance/certs/separation all
-- unchanged; right counts -> 1 pre-join + 1 post-exit + 3 certs deleted, Paul's Aug/Oct 1/Oct 9 kept, presence + subs kept.
-- =====================================================================
DO $fix$
DECLARE
  EXPECT_PREJOIN     constant int := 1;      -- PREVIEW 2026-10-16: Kai Newton (joined 2026-10-08) on the 2026-09-18 drill
  EXPECT_POSTEXIT    constant int := 0;      -- PREVIEW 2026-10-16: none (Paul has no attendance after 10/9)
  EXPECT_PAUL_CERTS  constant int := 41;     -- PREVIEW 2026-10-16: 41 (matches the brief)
  v_paul uuid; v_paul_dept uuid; v_on date; v_n int;
BEGIN
  IF EXPECT_PREJOIN IS NULL OR EXPECT_POSTEXIT IS NULL OR EXPECT_PAUL_CERTS IS NULL THEN
    RAISE EXCEPTION 'Fill in the EXPECT_ constants from the PREVIEW first. Nothing changed.';
  END IF;
  IF to_regclass('public.member_separation') IS NULL THEN
    RAISE EXCEPTION 'Apply membership_window first (member_separation is missing). Nothing changed.';
  END IF;

  -- 1. Paul — exactly one member row by that name
  SELECT count(*) INTO v_n FROM public.members WHERE lower(btrim(name)) = 'paul stetzel';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected exactly one member named Paul Stetzel, found %. Nothing changed.', v_n; END IF;
  SELECT id, department_id INTO v_paul, v_paul_dept FROM public.members WHERE lower(btrim(name)) = 'paul stetzel';
  SELECT terminated_on INTO v_on FROM public.member_separation WHERE member_id = v_paul;
  IF v_on IS NOT NULL AND v_on <> date '2026-10-09' THEN
    RAISE EXCEPTION 'Paul already has a different termination date on file (%). Nothing changed.', v_on;
  END IF;
  INSERT INTO public.member_separation (member_id, department_id, terminated_on, set_by_member, set_at)
  VALUES (v_paul, v_paul_dept, date '2026-10-09', NULL, now())
  ON CONFLICT (member_id) DO NOTHING;

  -- 2. before the start
  DELETE FROM public.session_attendance sa
   USING public.training_sessions ts, public.members m
    LEFT JOIN public.member_private mp ON mp.member_id = m.id
   WHERE ts.id = sa.session_id AND m.id = sa.member_id
     AND ts."date" < coalesce(mp.joined_date, make_date(nullif(substring(m.joined::text from '^\s*(\d{4})'), '')::int, 1, 1));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> EXPECT_PREJOIN THEN
    RAISE EXCEPTION 'Pre-join delete matched % rows, preview said %. Nothing changed — re-run the preview.', v_n, EXPECT_PREJOIN;
  END IF;

  -- 3. after the end (Paul's 10/9 is on file now, from step 1)
  DELETE FROM public.session_attendance sa
   USING public.training_sessions ts, public.member_separation ms
   WHERE ts.id = sa.session_id AND ms.member_id = sa.member_id AND ts."date" > ms.terminated_on;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> EXPECT_POSTEXIT THEN
    RAISE EXCEPTION 'Post-termination delete matched % rows, preview said %. Nothing changed — re-run the preview.', v_n, EXPECT_POSTEXIT;
  END IF;

  -- 4. Paul's certs
  DELETE FROM public.certs WHERE member_id = v_paul;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> EXPECT_PAUL_CERTS THEN
    RAISE EXCEPTION 'Paul cert delete matched % rows, expected %. Nothing changed.', v_n, EXPECT_PAUL_CERTS;
  END IF;
END
$fix$;

-- state check (read-only) — expect: paul_terminated_on 2026-10-09 · paul_certs 0 · prejoin_left 0 · postexit_left 0 ·
-- paul_attendance_kept = his count on or before 10/9 (unchanged)
SELECT (SELECT ms.terminated_on FROM public.member_separation ms JOIN public.members m ON m.id = ms.member_id WHERE lower(btrim(m.name)) = 'paul stetzel') AS paul_terminated_on,
       (SELECT count(*) FROM public.certs c JOIN public.members m ON m.id = c.member_id WHERE lower(btrim(m.name)) = 'paul stetzel') AS paul_certs,
       (SELECT count(*) FROM public.session_attendance sa JOIN public.training_sessions ts ON ts.id = sa.session_id JOIN public.members m ON m.id = sa.member_id
          LEFT JOIN public.member_private mp ON mp.member_id = m.id
         WHERE ts."date" < coalesce(mp.joined_date, make_date(nullif(substring(m.joined::text from '^\s*(\d{4})'), '')::int, 1, 1))) AS prejoin_left,
       (SELECT count(*) FROM public.session_attendance sa JOIN public.training_sessions ts ON ts.id = sa.session_id
          JOIN public.member_separation ms ON ms.member_id = sa.member_id WHERE ts."date" > ms.terminated_on) AS postexit_left,
       (SELECT count(*) FROM public.session_attendance sa JOIN public.members m ON m.id = sa.member_id WHERE lower(btrim(m.name)) = 'paul stetzel') AS paul_attendance_kept;
