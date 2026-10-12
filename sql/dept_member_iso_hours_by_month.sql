-- =====================================================================
-- dept_member_iso_hours_by_month — ONE member's credited station hours for MANY
-- windows in ONE round-trip. DRAFT. NOT YET APPLIED.
--
-- Only pg_proc says whether this is live, never git:
--   select proname from pg_proc where proname = 'dept_member_iso_hours_by_month';
--
-- WHY. The member file's new STATION HOURS panel charts a member's credited hours
-- per month. The Station Hours Report's per-member credited figure is that
-- member's iso_total_hours row from dept_iso_hours(window) (mergeStationHours:
-- row.total = iso_total_hours). dept_iso_hours_by_month only returns DEPARTMENT
-- totals, so there was no per-member-by-month source.
--
-- HOW — A WRAPPER, NOT A SECOND IMPLEMENTATION. Same shape as
-- dept_iso_hours_by_month: for each window it calls the existing
-- dept_iso_hours(start, end) and keeps the one member's row. The de-overlap, the
-- clipping, the training-wins rule, the auto-closed exclusion, attested training
-- and the department scoping all stay in dept_iso_hours. Identical to the report
-- by construction: same function, same windows, same row.
--
-- SECURITY INVOKER, deliberately. It runs as the caller, so dept_iso_hours' own
-- is_leadership() gate and my_department_id() scoping apply unchanged: a member
-- id from another department simply has no row (credited 0), and a non-leader
-- gets 'Not authorized'. Adds no privilege. EXECUTE revoked from anon/public.
--
-- The client passes the windows (local-time month boundaries), as with
-- dept_iso_hours_by_month. Capped at 24 windows. Never touches `verified`.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. PRECONDITION — the inner function must exist with the expected args.
-- ---------------------------------------------------------------------
do $pre$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'dept_iso_hours'
                  and pg_get_function_identity_arguments(oid) = 'p_from timestamp with time zone, p_to timestamp with time zone') then
    raise exception 'Precondition failed: dept_iso_hours(p_from timestamptz, p_to timestamptz) not found.';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------
-- 1. THE WRAPPER.
-- ---------------------------------------------------------------------
create or replace function public.dept_member_iso_hours_by_month(p_member_id uuid, p_starts timestamptz[], p_ends timestamptz[])
 returns table(idx integer, credited numeric)
 language plpgsql
 stable
 security invoker
 set search_path to 'public'
as $function$
declare
  n integer := coalesce(array_length(p_starts, 1), 0);
begin
  if p_member_id is null then
    raise exception 'A member is required.';
  end if;
  if n <> coalesce(array_length(p_ends, 1), 0) then
    raise exception 'Starts and ends must be the same length.';
  end if;
  if n > 24 then
    raise exception 'At most 24 windows per call.';
  end if;
  -- idx is 1-based, matching the input arrays. Every window gets a row, even an
  -- empty one (credited 0), so the client never mistakes a missing row for a
  -- failed read.
  return query
  select i,
         coalesce((select h.iso_total_hours
                     from public.dept_iso_hours(p_starts[i], p_ends[i]) h
                    where h.member_id = p_member_id), 0)::numeric
    from generate_series(1, n) as i
   order by i;
end;
$function$;

revoke all    on function public.dept_member_iso_hours_by_month(uuid, timestamptz[], timestamptz[]) from anon, public;
grant execute on function public.dept_member_iso_hours_by_month(uuid, timestamptz[], timestamptz[]) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. POST-CONDITIONS — in-transaction, so a hole rolls itself back.
-- ---------------------------------------------------------------------
do $post$
begin
  if has_function_privilege('anon', 'public.dept_member_iso_hours_by_month(uuid, timestamptz[], timestamptz[])', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE dept_member_iso_hours_by_month. Rolling back.';
  end if;
  if not has_function_privilege('authenticated', 'public.dept_member_iso_hours_by_month(uuid, timestamptz[], timestamptz[])', 'EXECUTE') then
    raise exception 'Post-condition failed: authenticated cannot EXECUTE dept_member_iso_hours_by_month. Rolling back.';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
              and proname = 'dept_member_iso_hours_by_month' and prosecdef) then
    raise exception 'Post-condition failed: dept_member_iso_hours_by_month must be SECURITY INVOKER. Rolling back.';
  end if;
end
$post$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- VERIFY (run separately, after applying) — impersonates a leader and checks
-- the wrapper returns exactly what dept_iso_hours returns for that member, month
-- by month. Fill in the three placeholders. Expect 6 rows, match = true.
-- A bare call from the SQL editor raises 'Not authorized' (no JWT) — the gate.
--
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('email', '<leader email>', 'role', 'authenticated')::text, true);
--   with w as (
--     select i,
--            date_trunc('month', now()) - make_interval(months => 6 - i) as s,
--            least(date_trunc('month', now()) - make_interval(months => 5 - i), now()) as e
--       from generate_series(1, 6) as i
--   ),
--   batched as (
--     select * from public.dept_member_iso_hours_by_month('<member uuid>'::uuid,
--       (select array_agg(s order by i) from w), (select array_agg(e order by i) from w))
--   )
--   select w.i, to_char(w.s, 'Mon YYYY') as month, b.credited as batched,
--          coalesce((select h.iso_total_hours from public.dept_iso_hours(w.s, w.e) h
--                     where h.member_id = '<member uuid>'::uuid), 0) as direct,
--          b.credited = coalesce((select h.iso_total_hours from public.dept_iso_hours(w.s, w.e) h
--                     where h.member_id = '<member uuid>'::uuid), 0) as match
--     from w join batched b on b.idx = w.i order by w.i;
-- rollback;
-- =====================================================================
