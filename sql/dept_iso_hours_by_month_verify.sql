-- VERIFY dept_iso_hours_by_month — READ-ONLY, rolls itself back.
-- Impersonates a leader and checks, for each of the last 6 months, that the
-- wrapper returns EXACTLY what the per-month calls return today.
-- Fill in the two placeholders (a DA or Officer's auth user id + email).
-- Month boundaries here are UTC; the client sends local-time boundaries, but
-- the comparison only needs both sides to use the same windows.
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub', '<leader auth uid>', 'email', '<leader email>', 'role', 'authenticated')::text, true);

  with w as (
    select i,
           date_trunc('month', now()) - make_interval(months => 6 - i) as s,
           least(date_trunc('month', now()) - make_interval(months => 5 - i), now()) as e
      from generate_series(1, 6) as i
  ),
  batched as (
    select * from public.dept_iso_hours_by_month(
      (select array_agg(s order by i) from w), (select array_agg(e order by i) from w))
  ),
  direct as (
    select w.i,
           coalesce((select sum(iso_total_hours) from public.dept_iso_hours(w.s, w.e)), 0) as credited,
           (select count(*) from public.dept_station_shifts(w.s, w.e))::int as shifts
      from w
  )
  select d.i, to_char(w.s, 'Mon YYYY') as month,
         b.credited as batched_credited, d.credited as direct_credited,
         b.shifts as batched_shifts, d.shifts as direct_shifts,
         (b.credited = d.credited and b.shifts = d.shifts) as match
    from direct d join batched b on b.idx = d.i join w on w.i = d.i
   order by d.i;
  -- expect: 6 rows, match = true on every row.
rollback;
