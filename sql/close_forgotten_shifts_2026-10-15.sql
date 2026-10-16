-- =====================================================================
-- CLOSE THREE FORGOTTEN SHIFTS — North Hood County, out-time 9:30 PM Central, 10/15/2026. HOURS-WRITING.
-- Run ONLY after sql/close_forgotten_shifts_2026-10-15_PREVIEW.sql has been checked.
-- Goes through the admin-gated close_open_shift() (it enforces out-time in [check-in, now], refuses an already-closed
-- shift, sets checked_out_at + auto_closed = false, never touches verified) — acting as a North Hood Department Admin.
-- ALL-OR-NOTHING. Raises and changes nothing unless, for EACH of Kai Newton / Mike Bell / Kenny Bell: exactly one open
-- shift in North Hood, checked in on 10/15/2026 at the stated minute (7:02 / 7:39 / 7:40 PM CT), and the credited time
-- comes back within ±1 minute of 2h28m / 1h51m / 1h50m (rounded; check-ins carry seconds). Chase Thomas's and Spencer Sampler's open shifts must still be open after.
-- =====================================================================
DO $close$
DECLARE
  OUT_AT constant timestamptz := timestamptz '2026-10-15 21:30 America/Chicago';
  v_nh uuid; v_da text; v_n int; v_id uuid; v_in timestamptz; r record; v_left_before int; v_left_after int;
  v_rpt text := '';
BEGIN
  SELECT count(*) INTO v_n FROM public.departments WHERE name ILIKE 'North Hood County%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected one North Hood County department, found %. Nothing changed.', v_n; END IF;
  SELECT id INTO v_nh FROM public.departments WHERE name ILIKE 'North Hood County%';
  SELECT lower(d.email) INTO v_da FROM public.members d
   WHERE d.department_id = v_nh AND d.access && array['Department Admin']::text[] AND d.email IS NOT NULL
     AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(d.email)) = 1
   ORDER BY d.id LIMIT 1;
  IF v_da IS NULL THEN RAISE EXCEPTION 'No North Hood Department Admin with a unique email to act as. Nothing changed.'; END IF;

  SELECT count(*) INTO v_left_before FROM public.station_presence sp JOIN public.members m ON m.id = sp.member_id
   WHERE sp.department_id = v_nh AND sp.checked_out_at IS NULL AND lower(btrim(m.name)) IN ('chase thomas', 'spencer sampler');

  -- act as the North Hood DA (helpers key on auth.email(); stay as postgres)
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);

  FOR r IN SELECT * FROM (VALUES ('kai newton',  '19:02', '2h28m'),
                                 ('mike bell',   '19:39', '1h51m'),
                                 ('kenny bell',  '19:40', '1h50m')) AS t(who, in_hm, want) LOOP
    SELECT count(*) INTO v_n FROM public.station_presence sp JOIN public.members m ON m.id = sp.member_id
     WHERE sp.department_id = v_nh AND sp.checked_out_at IS NULL AND lower(btrim(m.name)) = r.who;
    IF v_n <> 1 THEN RAISE EXCEPTION '% has % open shifts in North Hood (expected 1). Nothing changed.', r.who, v_n; END IF;
    SELECT sp.id, sp.checked_in_at INTO v_id, v_in FROM public.station_presence sp JOIN public.members m ON m.id = sp.member_id
     WHERE sp.department_id = v_nh AND sp.checked_out_at IS NULL AND lower(btrim(m.name)) = r.who;
    IF to_char(v_in AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI') <> '2026-10-15 ' || r.in_hm THEN
      RAISE EXCEPTION '% checked in at % CT, not 2026-10-15 %. Nothing changed.', r.who, to_char(v_in AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI'), r.in_hm;
    END IF;
    PERFORM public.close_open_shift(v_id, OUT_AT);
    -- the expected durations are rounded ("~2h28m") and check-ins carry seconds, so allow ±1 minute
    IF abs(extract(epoch from (OUT_AT - v_in)) / 60.0 - (split_part(r.want, 'h', 1)::int * 60 + rtrim(split_part(r.want, 'h', 2), 'm')::int)) > 1 THEN
      RAISE EXCEPTION '% would be credited %, expected %. Nothing changed.', r.who, to_char(OUT_AT - v_in, 'FMHH24"h"MI"m"'), r.want;
    END IF;
    v_rpt := v_rpt || format('%s %s; ', r.who, to_char(OUT_AT - v_in, 'FMHH24"h"MI"m"SS"s"'));
  END LOOP;

  SELECT count(*) INTO v_left_after FROM public.station_presence sp JOIN public.members m ON m.id = sp.member_id
   WHERE sp.department_id = v_nh AND sp.checked_out_at IS NULL AND lower(btrim(m.name)) IN ('chase thomas', 'spencer sampler');
  IF v_left_after <> v_left_before THEN
    RAISE EXCEPTION 'Chase/Spencer open shifts changed (% -> %). Nothing changed.', v_left_before, v_left_after;
  END IF;
  RAISE NOTICE 'Closed as %: %', v_da, v_rpt;
END
$close$;

-- state check (read-only) — expect the three CLOSED at Oct 15 2026 09:30 PM, auto_closed false, credited 2h28m / 1h51m /
-- 1h50m; Chase Thomas and Spencer Sampler still OPEN.
SELECT m.name, sp.kind, sp.verified, sp.auto_closed,
       to_char(sp.checked_in_at AT TIME ZONE 'America/Chicago', 'Mon DD YYYY HH12:MI AM') AS checked_in_ct,
       coalesce(to_char(sp.checked_out_at AT TIME ZONE 'America/Chicago', 'Mon DD YYYY HH12:MI AM'), 'OPEN') AS checked_out_ct,
       to_char(sp.checked_out_at - sp.checked_in_at, 'FMHH24"h"MI"m"SS"s"') AS credited
  FROM public.station_presence sp JOIN public.members m ON m.id = sp.member_id
  JOIN public.departments d ON d.id = sp.department_id AND d.name ILIKE 'North Hood County%'
 WHERE lower(btrim(m.name)) IN ('kai newton', 'mike bell', 'kenny bell', 'chase thomas', 'spencer sampler')
   AND (sp.checked_out_at IS NULL OR sp.checked_out_at = timestamptz '2026-10-15 21:30 America/Chicago')
 ORDER BY m.name;
