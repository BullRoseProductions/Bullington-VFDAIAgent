-- =====================================================================
-- APPLIED 2026-09-05 — C2 confirmed live via pg_get_functiondef; North Hood verified
-- (Chase 1.5 / 35.4 / 36.9); security boundary confirmed from proacl
-- (dept_iso_hours_for = service_role only).
--
-- THE RECORD, NOT THE CHANGE. This file was written AFTER the fact, from
-- pg_get_functiondef against the live database — it is a transcript of what is
-- running, not the script that put it there. Re-running it is safe and yields
-- the live state, grants included, which is the point: without it the repo
-- knows only that api/digest.js CALLS dept_iso_hours_for, and nothing at all
-- about what that function does or who may execute it.
--
-- WHY THE SPLIT. dept_iso_hours scopes itself with my_department_id() and gates
-- on is_leadership(), so it needs a browser session and answers for exactly one
-- department. api/digest.js runs on the service-role key with no JWT and loops
-- over every department: it could not call that function at all. Rather than
-- reimplement the interval union in JavaScript — a fourth copy of the credit
-- rule, and one that would also have to reproduce attested_training's flat-90
-- derivation — the body moved into a p_dept-parameterised core and the original
-- became a wrapper. One rule, two callers, no drift.
--
-- THE SECURITY BOUNDARY IS THE WHOLE REASON THE GRANTS ARE HERE. p_dept is a
-- PARAMETER, and the function is SECURITY DEFINER. If `authenticated` could
-- execute it, any logged-in member could read any department's hours by passing
-- its id. The observed ACL revokes exactly that: service_role only. The wrapper
-- keeps the authenticated path, and it is safe because it takes no department —
-- it derives one from the caller. Get this wrong on a re-run and the split
-- becomes a cross-department data leak, which is why the grants are reproduced
-- rather than left to whatever CREATE happens to default to.
--
-- TWO THINGS THE BODY DOES THAT THE PRE-SPLIT VERSION DID NOT, both from C2 and
-- both load-bearing for the client change committed alongside this file:
--   • `and not sp.auto_closed` — a shift whose stop time the sweeper guessed is
--     excluded even when the check-in was properly location-verified.
--   • the `union all` against attested_training(p_dept, ...) — officer-attested
--     drill attendance is de-overlapped TOGETHER with standby, which is what
--     makes Chase read 35.42 + 1.50 = 36.92 instead of 36.92 + 1.50 = 38.42.
--
-- AND ONE THING WORTH KNOWING BEFORE READING A REPORT: `where not att.optional`.
-- Optional sessions produce no ISO hours. Since the client now takes CREDITED
-- from this function, optional attested drill time is no longer credited
-- anywhere — it used to raise the credited total while leaving ISO alone. That
-- is a policy consequence of the split, not an accident of it; the methodology
-- note in src/report.js was corrected in the same commit to stop describing the
-- old behaviour.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE CORE. Verbatim from pg_get_functiondef, 2026-09-05.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_iso_hours_for(p_dept uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(member_id uuid, member_name text, training_hours numeric, standby_hours numeric, iso_total_hours numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_dept is null then raise exception 'A department is required.'; end if;
  if p_from is null or p_to is null then raise exception 'A start and end date are both required.'; end if;
  if p_from >= p_to then raise exception 'The start of the period must come before the end.'; end if;
  return query
  with clipped as (
    select sp.member_id as mid, (sp.kind = 'training') as is_training,
      tstzrange(greatest(sp.checked_in_at, p_from), least(sp.checked_out_at, p_to), '[)') as span
    from public.station_presence sp
    where sp.department_id = p_dept and sp.verified and sp.checked_out_at is not null
      and not sp.auto_closed and sp.kind in ('standby','training')
      and sp.checked_in_at < p_to and sp.checked_out_at > p_from
    union all
    select att.member_id as mid, true as is_training,
      tstzrange(greatest(att.start_at, p_from), least(att.end_at, p_to), '[)') as span
    from public.attested_training(p_dept, p_from, p_to) att
    where not att.optional and att.start_at < p_to and att.end_at > p_from
  ),
  live as (select * from clipped where not isempty(span)),
  agg as (
    select c.mid,
      range_agg(c.span) filter (where c.is_training) as training_mr,
      range_agg(c.span) as all_mr
    from live c group by c.mid
  ),
  secs as (
    select a.mid,
      coalesce((select sum(extract(epoch from (upper(r) - lower(r)))) from unnest(a.training_mr) r), 0) as training_secs,
      coalesce((select sum(extract(epoch from (upper(r) - lower(r)))) from unnest(a.all_mr) r), 0) as total_secs
    from agg a
  ),
  final as (
    select s.mid as mid, m.name as mname,
      round((s.training_secs / 3600.0)::numeric, 2) as t_hours,
      round(((s.total_secs - s.training_secs) / 3600.0)::numeric, 2) as s_hours,
      round((s.total_secs / 3600.0)::numeric, 2) as tot_hours
    from secs s join public.members m on m.id = s.mid
  )
  select f.mid, f.mname, f.t_hours, f.s_hours, f.tot_hours from final f
  order by f.tot_hours desc, f.mname;
end;
$function$;


-- ---------------------------------------------------------------------
-- 2. THE WRAPPER. Verbatim from pg_get_functiondef, 2026-09-05.
--
-- Takes no department: it derives one from the caller, which is exactly why it
-- is safe to leave executable by `authenticated` while the core is not.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_iso_hours(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(member_id uuid, member_name text, training_hours numeric, standby_hours numeric, iso_total_hours numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_leadership() then raise exception 'Not authorized'; end if;
  return query select * from public.dept_iso_hours_for(public.my_department_id(), p_from, p_to);
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. GRANTS — reproducing the observed ACLs.
--
-- NOT OPTIONAL AND NOT COSMETIC. A bare CREATE grants EXECUTE to PUBLIC by
-- default, so these REVOKEs are what actually establish the boundary described
-- in the header. A DROP+CREATE discards the ACL and silently re-opens it; the
-- capture/replay some tooling does around DDL does NOT restore revokes. Any
-- future edit to either function must be followed by this section again.
-- ---------------------------------------------------------------------

-- The core takes p_dept, so authenticated is revoked along with public and anon:
-- a definer-rights function with a department parameter is a cross-department
-- read for anyone who can call it.
REVOKE ALL ON FUNCTION public.dept_iso_hours_for(uuid, timestamptz, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dept_iso_hours_for(uuid, timestamptz, timestamptz) TO service_role;

-- The wrapper is the browser's path in. authenticated keeps EXECUTE because the
-- function scopes itself; anon never gets it.
REVOKE ALL ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_iso_hours(timestamptz, timestamptz) TO authenticated, service_role;


-- ---------------------------------------------------------------------
-- 4. Tell PostgREST about the new function, or the digest's first call 404s
--    against a schema cache that predates it.
-- ---------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
