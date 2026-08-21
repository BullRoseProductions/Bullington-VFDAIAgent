-- =====================================================================
-- ROLLBACK — restore dept_station_shifts to its PRE-C2 definition.
--
-- ONLY NEEDED IF C2 HALF-APPLIED: the DROP committed but the CREATE failed, so
-- dept_station_shifts does not exist and the app is erroring. Paste this whole
-- file and run it.
--
-- This is the LIVE definition as it stood before C2 — the pg_get_functiondef
-- output, unmodified: 10 columns, no officer_attested, branch B deriving inline
-- from session_attendance at full drill length.
--
-- It also re-grants EXECUTE to authenticated, which is what the ACL held before
-- C2 ran. Confirm afterwards with:
--   SELECT has_function_privilege('authenticated',
--            'public.dept_station_shifts(timestamptz,timestamptz)'::regprocedure,
--            'EXECUTE');
--
-- dept_iso_hours needs NO rollback: C2 changes it with CREATE OR REPLACE, which
-- either succeeds whole or does nothing.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.dept_station_shifts(
  p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()),
  p_to timestamp with time zone DEFAULT now())
 RETURNS TABLE(member_id uuid, member_name text, checked_in_at timestamp with time zone,
               checked_out_at timestamp with time zone, hours numeric, kind text,
               verified boolean, auto_closed boolean, source text, optional boolean)
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
    -- A. OBSERVED
    select m.id, m.name, sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours,
           sp.kind, sp.verified, sp.auto_closed,
           coalesce(sp.source, 'geo')::text as source,
           false as optional
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    where sp.department_id = v_dept
      and sp.checked_out_at is not null
      and sp.kind in ('standby','training')
      and sp.checked_in_at >= p_from
      and sp.checked_in_at <  p_to
    union all
    -- B. ATTENDANCE-DERIVED
    select m.id, m.name,
           (ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago' as checked_in_at,
           ((ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago')
             + make_interval(mins => ts.duration_min)                                          as checked_out_at,
           round((ts.duration_min / 60.0)::numeric, 2)   as hours,
           'training'::text                              as kind,
           false                                         as verified,
           false                                         as auto_closed,
           'attendance'::text                            as source,
           (coalesce(ts.counts_toward_attendance, true) = false) as optional
    from public.session_attendance sa
    join public.training_sessions ts on ts.id = sa.session_id
    join public.members m           on m.id = sa.member_id
    where ts.department_id = v_dept
      and ts.done
      and ts.duration_min is not null
      and coalesce(ts.audience, 'everyone') <> 'board'
      and coalesce(ts.is_offsite, false) = false
      and ((ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago') >= p_from
      and ((ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago') <  p_to
      and not exists (
        select 1 from public.station_presence sp2
         where sp2.kind = 'training'
           and sp2.session_id = sa.session_id
           and sp2.member_id  = sa.member_id
      )
    order by 3 desc;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
