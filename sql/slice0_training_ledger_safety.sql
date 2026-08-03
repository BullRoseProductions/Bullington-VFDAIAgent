-- =====================================================================
-- SLICE 0 — make station_presence safe for a second `kind` (training).
--
-- INERT TODAY. Verified before writing: the table contains exactly one kind —
-- 18 rows, all kind='standby', session_id populated 0 times. So nothing here
-- changes behaviour now; it closes the holes BEFORE anything can write a
-- training row, so there is never a window where a scan corrupts a standby shift.
--
-- Run order matters only in that this must land before Slice 1 (the geo-verified
-- scan that writes kind='training').
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Idempotent scan: one open training row per member per session.
--
-- A partial unique index rather than application logic, so a double-scan is a
-- no-op at the DATABASE level and is race-safe — two concurrent scans cannot
-- both win. Slice 1's insert then uses ON CONFLICT DO NOTHING.
--
-- Partial (WHERE kind='training' AND session_id IS NOT NULL) so it constrains
-- nothing about standby rows, which legitimately have a null session_id and can
-- legitimately repeat for the same member.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS station_presence_one_training_per_session
  ON public.station_presence (member_id, session_id)
  WHERE kind = 'training' AND session_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- 2. station_check_out() — never close a training row.
--
-- BEFORE: `where member_id = v_member and checked_out_at is null` with no kind
-- filter, so a member's standby clock-out would ALSO close any open training row
-- the moment training rows start existing.
--
-- Also hardens the original `returning * into v_row` on a multi-row UPDATE, which
-- silently closed every open row while reporting only one. There are already 2
-- open rows in the table today, so this is reachable now, not hypothetical. The
-- CTE closes every open STANDBY row (healing stale ones) and deterministically
-- returns the most recent, instead of an arbitrary one.
--
-- Signature, volatility, SECURITY DEFINER, search_path and both user-facing
-- exception strings are reproduced verbatim from the live definition.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.station_check_out()
 RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member uuid := public.my_member_id();
  v_row public.station_presence;
begin
  if v_member is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  with closed as (
    update public.station_presence
       set checked_out_at = now()
     where member_id = v_member
       and checked_out_at is null
       and kind = 'standby'          -- NEVER close a training row; the officer closes those
    returning *
  )
  select * into v_row from closed order by checked_in_at desc limit 1;
  if v_row.id is null then raise exception 'You are not currently checked in.'; end if;
  return v_row;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. my_open_station_session() — prefer the STANDBY row.
--
-- The personal clock reads this to decide what to display, and Clock-out calls
-- station_check_out(), which (above) only ever closes standby. Without this the
-- clock could show a training row while Clock-out acted on a standby one.
--
-- Only change: `(kind = 'standby') desc,` added to the ORDER BY. Boolean DESC
-- puts true first, so an open standby row wins; otherwise the newest open row is
-- returned unchanged. Backward-compatible today (only standby exists).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_open_station_session()
 RETURNS SETOF station_presence
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.station_presence
    where member_id = public.my_member_id() and checked_out_at is null
    order by (kind = 'standby') desc, checked_in_at desc
    limit 1;
$function$;


-- ---------------------------------------------------------------------
-- 4. dept_on_station_now() — one row per member, training wins.
--
-- Already kind-aware (`kind in ('standby','training')`) but had no per-member
-- dedupe, so a member with BOTH an open standby and an open training row would
-- appear twice in the leadership panel.
--
-- Only change: DISTINCT ON (m.id) with training-priority, wrapped in a subquery
-- so the outer result keeps the original chronological order. DISTINCT ON
-- requires its expression to lead the inner ORDER BY, which is why m.id is first
-- there — the display ordering is preserved by the outer ORDER BY instead.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_on_station_now()
 RETURNS TABLE(member_id uuid, member_name text, checked_in_at timestamp with time zone, kind text, verified boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  return query
    select x.member_id, x.member_name, x.checked_in_at, x.kind, x.verified
    from (
      select distinct on (m.id)
             m.id as member_id, m.name as member_name,
             sp.checked_in_at, sp.kind, sp.verified
      from public.station_presence sp
      join public.members m on m.id = sp.member_id
      where sp.department_id = v_dept
        and sp.checked_out_at is null
        and sp.kind in ('standby','training')
      order by m.id, (sp.kind = 'training') desc, sp.checked_in_at
    ) x
    order by x.checked_in_at;
end;
$function$;


NOTIFY pgrst, 'reload schema';

-- ---- VERIFY ----
-- \df+ public.station_check_out
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE tablename='station_presence' AND indexname='station_presence_one_training_per_session';
-- -- still inert? (expect one row: standby)
-- SELECT kind, count(*), count(session_id) FROM public.station_presence GROUP BY kind;
