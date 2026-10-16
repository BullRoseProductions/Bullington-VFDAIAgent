-- =====================================================================
-- PREVIEW — READ-ONLY. North Hood County: every OPEN station_presence shift (checked_out_at IS NULL), with the planned
-- action. Three are to be closed at 9:30 PM Central on 10/15/2026 (they left then and forgot to clock out):
-- Kai Newton (in 7:02 PM), Mike Bell (in 7:39 PM), Kenny Bell (in 7:40 PM). Everyone else — Chase Thomas, Spencer
-- Sampler — stays OPEN. Times shown in America/Chicago. Expect exactly one CLOSE row per name, with the check-in time
-- above, and credited ≈ Kai 2h28m · Mike 1h51m · Kenny 1h50m. acting_da = the North Hood Department Admin the close
-- script acts as (close_open_shift is admin-gated; it records no actor).
-- =====================================================================
WITH nh AS (SELECT id FROM public.departments WHERE name ILIKE 'North Hood County%'),
out_at AS (SELECT timestamptz '2026-10-15 21:30 America/Chicago' AS t)
SELECT CASE WHEN lower(btrim(m.name)) IN ('kai newton', 'mike bell', 'kenny bell') THEN 'CLOSE at 9:30 PM' ELSE 'leave open' END AS action,
       m.name AS member, sp.kind, sp.verified,
       to_char(sp.checked_in_at AT TIME ZONE 'America/Chicago', 'Mon DD YYYY HH12:MI:SS AM') AS checked_in_ct,
       CASE WHEN lower(btrim(m.name)) IN ('kai newton', 'mike bell', 'kenny bell')
            THEN to_char((SELECT t FROM out_at) - sp.checked_in_at, 'FMHH24"h"MI"m"SS"s"') END AS credited_after,
       CASE WHEN lower(btrim(m.name)) IN ('kai newton', 'mike bell', 'kenny bell')
            THEN round((extract(epoch from ((SELECT t FROM out_at) - sp.checked_in_at)) / 3600.0)::numeric, 2) END AS hours_after,
       sp.id AS shift_id,
       (SELECT lower(d.email) FROM public.members d WHERE d.department_id = (SELECT id FROM nh)
           AND d.access && array['Department Admin']::text[] AND d.email IS NOT NULL
           AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(d.email)) = 1
         ORDER BY d.id LIMIT 1) AS acting_da,
       (SELECT count(*) FROM public.departments WHERE name ILIKE 'North Hood County%') AS dept_matches
  FROM public.station_presence sp
  JOIN public.members m ON m.id = sp.member_id
 WHERE sp.department_id = (SELECT id FROM nh) AND sp.checked_out_at IS NULL
 ORDER BY 1, sp.checked_in_at;
