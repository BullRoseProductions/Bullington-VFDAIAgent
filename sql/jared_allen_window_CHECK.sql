-- READ-ONLY. Why didn't the preview flag Jared Allen? Shows the join date the server actually uses for him, and every
-- drill he's recorded at, each marked inside/outside his window. One row per drill (plus one row if he has none).
WITH j AS (
  SELECT m.id, m.name, m.joined, m.status, mp.joined_date,
         coalesce(mp.joined_date, make_date(nullif(substring(m.joined::text from '^\s*(\d{4})'), '')::int, 1, 1)) AS start_on,
         (SELECT count(*) FROM public.members x WHERE lower(btrim(x.name)) = 'jared allen') AS name_matches
    FROM public.members m LEFT JOIN public.member_private mp ON mp.member_id = m.id
   WHERE lower(btrim(m.name)) = 'jared allen'
)
SELECT j.name, j.name_matches, j.status, j.joined AS joined_year_field, j.joined_date AS joined_date_on_file, j.start_on AS window_start,
       ts."date" AS drill_date, ts.title, ts.done,
       CASE WHEN ts."date" IS NULL THEN 'no attendance on file'
            WHEN j.start_on IS NULL THEN 'NO START DATE — nothing blocked'
            WHEN ts."date" < j.start_on THEN 'BEFORE JOIN' ELSE 'ok' END AS verdict
  FROM j
  LEFT JOIN public.session_attendance sa ON sa.member_id = j.id
  LEFT JOIN public.training_sessions ts ON ts.id = sa.session_id
 ORDER BY ts."date" NULLS FIRST;
