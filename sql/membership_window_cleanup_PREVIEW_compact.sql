-- =====================================================================
-- MEMBERSHIP WINDOW CLEANUP — PREVIEW, COMPACT. READ-ONLY. Same rows as membership_window_cleanup_PREVIEW.sql, grouped:
-- one line per section x department x member with a count and the drill-date range — short enough to copy whole.
-- =====================================================================
WITH paul AS (
  SELECT m.id, m.department_id FROM public.members m WHERE lower(btrim(m.name)) = 'paul stetzel'
),
win AS (
  SELECT m.id AS member_id, m.name, m.department_id,
         coalesce(mp.joined_date, make_date(nullif(substring(m.joined::text from '^\s*(\d{4})'), '')::int, 1, 1)) AS start_on,
         coalesce(ms.terminated_on, CASE WHEN m.id IN (SELECT id FROM paul) THEN date '2026-10-09' END) AS end_on
    FROM public.members m
    LEFT JOIN public.member_private    mp ON mp.member_id = m.id
    LEFT JOIN public.member_separation ms ON ms.member_id = m.id
),
bad AS (
  SELECT CASE WHEN ts."date" < w.start_on THEN 'prejoin' ELSE 'postexit' END AS kind,
         sa.id, sa.session_id, sa.member_id, w.name, w.department_id, ts."date" AS drill_date, ts.title, w.start_on, w.end_on
    FROM public.session_attendance sa
    JOIN public.training_sessions ts ON ts.id = sa.session_id
    JOIN win w ON w.member_id = sa.member_id
   WHERE ts."date" < w.start_on OR ts."date" > w.end_on
),
paul_certs AS (
  SELECT c.* FROM public.certs c WHERE c.member_id IN (SELECT id FROM paul)
),
lines AS (
  SELECT 1 AS ord, 'DELETE' AS action, b.kind AS section, d.name AS department, b.name AS member,
         b.title AS detail, b.drill_date, b.start_on, b.end_on, b.id::text AS row_id
    FROM bad b JOIN public.departments d ON d.id = b.department_id
  UNION ALL
  SELECT 2, 'DELETE', 'paul_cert', d.name, 'Paul Stetzel', c.name || ' · exp ' || coalesce(c.exp::text, '—'), NULL, NULL, NULL, c.id::text
    FROM paul_certs c JOIN paul p ON p.id = c.member_id JOIN public.departments d ON d.id = p.department_id
  UNION ALL
  SELECT 3, 'INFO', 'paul_term', d.name, m.name,
         CASE WHEN ms.terminated_on IS NULL THEN 'will be set to 2026-10-09' ELSE 'already on file' END,
         NULL, NULL, coalesce(ms.terminated_on, date '2026-10-09'), m.id::text
    FROM public.members m JOIN paul p ON p.id = m.id JOIN public.departments d ON d.id = m.department_id
    LEFT JOIN public.member_separation ms ON ms.member_id = m.id
  UNION ALL
  SELECT 4, 'INFO', 'hours_kept', d.name, b.name, 'station_presence training row ' || coalesce(sp.verified::text, '?') || ' (KEPT)',
         b.drill_date, NULL, NULL, sp.id::text
    FROM bad b JOIN public.station_presence sp ON sp.member_id = b.member_id AND sp.session_id = b.session_id AND sp.kind = 'training'
    JOIN public.departments d ON d.id = b.department_id
  UNION ALL
  SELECT 5, 'INFO', 'proof_kept', NULL, 'Paul Stetzel', c.proof_path, NULL, NULL, NULL, c.id::text
    FROM paul_certs c WHERE c.proof_path IS NOT NULL
  UNION ALL
  SELECT 6, 'INFO', 'subs_kept', NULL, 'Paul Stetzel', count(*)::text || ' cert_submissions (KEPT)', NULL, NULL, NULL, NULL
    FROM public.cert_submissions cs WHERE cs.member_id IN (SELECT id FROM paul)
  UNION ALL
  SELECT 7, 'INFO', 'triggers', NULL, NULL, tgrelid::regclass::text || ': ' || tgname, NULL, NULL, NULL, NULL
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.session_attendance'::regclass, 'public.certs'::regclass)
  UNION ALL
  SELECT 8, 'SUMMARY', 'paul_matches', NULL, NULL, (SELECT count(*) FROM paul)::text || ' member row(s) named Paul Stetzel (must be 1)', NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 9, 'SUMMARY', 'EXPECT_PREJOIN', NULL, NULL, (SELECT count(*) FROM bad WHERE kind = 'prejoin')::text, NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 10, 'SUMMARY', 'EXPECT_POSTEXIT', NULL, NULL, (SELECT count(*) FROM bad WHERE kind = 'postexit')::text, NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 11, 'SUMMARY', 'EXPECT_PAUL_CERTS', NULL, NULL, (SELECT count(*) FROM paul_certs)::text || ' (brief says 41)', NULL, NULL, NULL, NULL
)
SELECT action, section, department, member,
       CASE WHEN action = 'DELETE' OR section IN ('hours_kept', 'proof_kept') THEN count(*)::text ELSE string_agg(DISTINCT detail, '; ') END AS n_or_detail,
       min(drill_date) AS first_drill, max(drill_date) AS last_drill, min(start_on) AS start_on, min(end_on) AS end_on
  FROM lines
 GROUP BY ord, action, section, department, member
 ORDER BY ord, department, member;
