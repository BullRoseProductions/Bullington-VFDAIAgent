-- =====================================================================
-- SLICE 3 SELF-TEST — proves the de-overlap math before real data exists.
--
-- SAFE TO RUN ANY TIME. It is one SELECT over a VALUES list. It reads no table,
-- writes no row, needs no member_id or department_id, and does not require
-- dept_iso_hours to be installed. Paste it and read the output.
--
-- The clip + range_agg pipeline below is COPIED VERBATIM from the function body,
-- so if this produces the expected numbers, the function's arithmetic is right.
-- The only thing it cannot test is the RLS/leadership gate.
--
-- Window under test: [2026-08-01 00:00Z, 2026-08-02 00:00Z)   — one 24h day.
--
-- EXPECTED OUTPUT (5 rows; E must be absent — that is the sixth assertion):
--
--   member                        training  standby  iso_total  naive_sum
--   A — partial overlap               2.00     3.00       5.00       6.00
--   B — training inside standby       1.50     2.50       4.00       5.50
--   C — no overlap                    2.00     4.00       6.00       6.00
--   D — clipped at window edge        0.00     2.00       2.00       4.00
--   (E — excluded rows)              no row
--
-- WHAT EACH CASE PROVES:
--   A  partial overlap — standby 18:00-22:00, training 21:00-23:00. The shared
--      21:00-22:00 hour goes to TRAINING. Union 18:00-23:00 = 5.00. Naive
--      addition says 6.00, i.e. one hour billed twice. Standby keeps 3.00, the
--      part it does not share.
--   B  containment — training 19:00-20:30 sits wholly inside standby
--      18:00-22:00. Union is still just the standby block, 4.00. Training takes
--      1.50, standby is left with the 2.50 either side. This is the case that
--      breaks a naive "standby minus training" subtraction done per row pair.
--   C  disjoint — standby 08:00-12:00, training 18:00-20:00, nothing shared.
--      iso_total equals the naive sum, 6.00. The GUARD CASE: it proves the
--      de-overlap does not over-subtract when there is nothing to subtract.
--   D  clipping — a standby running 2026-07-31 22:00 to 2026-08-01 02:00 is
--      credited only for the 2.00 hours inside the window, not 4.00. D also
--      carries a shift ending exactly AT p_from (07-31 20:00 to 08-01 00:00),
--      which clips to an empty range and is dropped — proving the half-open
--      boundary does not mint a zero-length phantom row.
--   E  exclusions — an UNVERIFIED 4h training and an OPEN standby (no
--      checked_out_at). Neither is creditable, so E must not appear in the
--      output at all. A member whose only time is uncredited has no ISO row.
-- =====================================================================

WITH bounds(p_from, p_to) AS (
  VALUES ('2026-08-01 00:00:00+00'::timestamptz, '2026-08-02 00:00:00+00'::timestamptz)
),
raw(mname, kind, verified, checked_in_at, checked_out_at) AS (VALUES
  -- A — partial overlap
  ('A — partial overlap',         'standby',  true, '2026-08-01 18:00+00'::timestamptz, '2026-08-01 22:00+00'::timestamptz),
  ('A — partial overlap',         'training', true, '2026-08-01 21:00+00'::timestamptz, '2026-08-01 23:00+00'::timestamptz),
  -- B — training fully inside standby
  ('B — training inside standby', 'standby',  true, '2026-08-01 18:00+00'::timestamptz, '2026-08-01 22:00+00'::timestamptz),
  ('B — training inside standby', 'training', true, '2026-08-01 19:00+00'::timestamptz, '2026-08-01 20:30+00'::timestamptz),
  -- C — no overlap at all
  ('C — no overlap',              'standby',  true, '2026-08-01 08:00+00'::timestamptz, '2026-08-01 12:00+00'::timestamptz),
  ('C — no overlap',              'training', true, '2026-08-01 18:00+00'::timestamptz, '2026-08-01 20:00+00'::timestamptz),
  -- D — window clipping, plus a shift ending exactly at p_from
  ('D — clipped at window edge',  'standby',  true, '2026-07-31 22:00+00'::timestamptz, '2026-08-01 02:00+00'::timestamptz),
  ('D — clipped at window edge',  'standby',  true, '2026-07-31 20:00+00'::timestamptz, '2026-08-01 00:00+00'::timestamptz),
  -- E — must be excluded entirely: unverified, and open
  ('E — excluded rows',           'training', false,'2026-08-01 09:00+00'::timestamptz, '2026-08-01 13:00+00'::timestamptz),
  ('E — excluded rows',           'standby',  true, '2026-08-01 14:00+00'::timestamptz, NULL)
),

-- ---- everything below is the function body's pipeline, unchanged ----
clipped AS (
  select
    r.mname as mid,                                  -- stands in for member_id
    (r.kind = 'training') as is_training,
    tstzrange(greatest(r.checked_in_at, b.p_from),
              least(r.checked_out_at, b.p_to), '[)') as span,
    -- naive per-row hours, kept only so the report can show what double-counting
    -- WOULD have produced; the function itself never computes this
    extract(epoch from (least(r.checked_out_at, b.p_to)
                      - greatest(r.checked_in_at, b.p_from))) as naive_secs
  from raw r cross join bounds b
  where r.verified
    and r.checked_out_at is not null
    and r.checked_in_at  <  b.p_to
    and r.checked_out_at >  b.p_from
),
live AS (
  select * from clipped where not isempty(span)
),
agg AS (
  select
    c.mid,
    range_agg(c.span) filter (where c.is_training) as training_mr,
    range_agg(c.span)                              as all_mr,
    sum(c.naive_secs)                              as naive_secs
  from live c
  group by c.mid
),
secs AS (
  select
    a.mid,
    coalesce((select sum(extract(epoch from (upper(x) - lower(x))))
                from unnest(a.training_mr) x), 0) as training_secs,
    coalesce((select sum(extract(epoch from (upper(x) - lower(x))))
                from unnest(a.all_mr) x), 0)      as total_secs,
    a.naive_secs
  from agg a
)
select
  s.mid                                                          as member,
  round((s.training_secs / 3600.0)::numeric, 2)                  as training_hours,
  round(((s.total_secs - s.training_secs) / 3600.0)::numeric, 2) as standby_hours,
  round((s.total_secs / 3600.0)::numeric, 2)                     as iso_total_hours,
  round((s.naive_secs / 3600.0)::numeric, 2)                     as naive_sum_hours,
  round(((s.naive_secs - s.total_secs) / 3600.0)::numeric, 2)    as double_counted_hours,
  -- the invariant the whole slice rests on; must be true on every row
  (round((s.training_secs / 3600.0)::numeric, 2)
   + round(((s.total_secs - s.training_secs) / 3600.0)::numeric, 2)
   = round((s.total_secs / 3600.0)::numeric, 2))                 as identity_holds
from secs s
order by s.mid;

-- EXPECTED, in full:
--
--  member                       | training | standby | iso_total | naive | double_counted | identity
--  -----------------------------+----------+---------+-----------+-------+----------------+---------
--  A — partial overlap          |     2.00 |    3.00 |      5.00 |  6.00 |           1.00 | t
--  B — training inside standby  |     1.50 |    2.50 |      4.00 |  5.50 |           1.50 | t
--  C — no overlap               |     2.00 |    4.00 |      6.00 |  6.00 |           0.00 | t
--  D — clipped at window edge   |     0.00 |    2.00 |      2.00 |  2.00 |           0.00 | t
--
--  4 rows. "E — excluded rows" absent.
--
-- If double_counted_hours is 0.00 on A or B, the de-overlap is NOT working.
-- If it is non-zero on C, the de-overlap is over-subtracting.
-- If D shows 4.00 anywhere, the window clip is not being applied.
-- If E appears, the verified/closed filters are not being applied.
