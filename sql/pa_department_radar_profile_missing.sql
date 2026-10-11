-- =====================================================================
-- pa_department_radar — Phase 1 follow-on: profile_missing. DRAFT. NOT YET APPLIED.
--
-- Built from the LIVE definition (= sql/pa_department_radar_phase1a.sql, applied
-- 2026-10-11 and grants-checked). One change, nothing else:
--   + profile_missing text[] — a label for each profile_complete condition that
--     isn't met: 'Tagline', 'Voice', 'Custom primary color', 'Custom accent color'.
--     Each CASE is the exact clause from profile_complete, so the array is empty
--     if and only if profile_complete is true. Empty array, never null.
-- profile_complete itself is unchanged. Security mode, search_path, the
-- is_project_admin() gate and every existing column are unchanged.
-- Return type changes → DROP + CREATE, which resets the ACL: REVOKE/GRANT below
-- restore it, and the post-condition rolls everything back if they didn't.
-- =====================================================================
begin;

DROP FUNCTION IF EXISTS public.pa_department_radar();

CREATE OR REPLACE FUNCTION public.pa_department_radar()
 RETURNS TABLE(department_id uuid, department_name text, station text, city text, admin_name text, admin_email text, health text, last_activity timestamp with time zone, days_since_activity integer, active_members_30d bigint, member_count bigint, documents_count bigint, apparatus_count bigint, training_sessions_count bigint, profile_complete boolean, members_no_email_count bigint, documents_no_text_count bigint, expiring_certs_count bigint, expired_certs_count bigint, overdue_duties_count bigint, open_action_items_count bigint, open_long_shifts_count bigint, profile_missing text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_project_admin() then raise exception 'Not authorized'; end if;
  return query
  with base as (
    select
      d.id as department_id, d.name as department_name, d.station, d.city,
      (select m.name from members m
         where m.department_id = d.id and m.access && array['Department Admin']::text[]
           and m.email is not null and btrim(m.email) <> ''
         order by m.created_at asc nulls last limit 1) as admin_name,
      (select lower(m.email) from members m
         where m.department_id = d.id and m.access && array['Department Admin']::text[]
           and m.email is not null and btrim(m.email) <> ''
         order by m.created_at asc nulls last limit 1) as admin_email,
      greatest(
        (select max(sa.checked_in_at) from session_attendance sa where sa.department_id = d.id),
        (select max(dl.done_at)       from duty_log dl          where dl.department_id = d.id),
        (select max(ai.created_at)    from action_items ai      where ai.department_id = d.id),
        (select max(doc.created_at)   from documents doc        where doc.department_id = d.id
                                                                  and doc.deleted_at is null and doc.archived_at is null),
        (select max(an.created_at)    from announcements an     where an.department_id = d.id),
        (select max(ts.created_at)    from training_sessions ts where ts.department_id = d.id)
      ) as last_activity,
      (select count(distinct mid) from (
          select sa.member_id as mid from session_attendance sa
            where sa.department_id = d.id and sa.checked_in_at >= now() - interval '30 days'
          union
          select dl.done_by from duty_log dl
            where dl.department_id = d.id and dl.done_at >= now() - interval '30 days'
          union
          select ai.completed_by from action_items ai
            where ai.department_id = d.id and ai.completed_at >= now() - interval '30 days'
       ) act where mid is not null) as active_members_30d,
      (select count(*) from members mm where mm.department_id = d.id
                                        and not (mm.access && array['Project Admin']::text[])) as member_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null and dc.archived_at is null) as documents_count,
      (select count(*) from apparatus ap where ap.department_id = d.id) as apparatus_count,
      (select count(*) from training_sessions ts where ts.department_id = d.id) as training_sessions_count,
      (    d.tagline is not null and btrim(d.tagline) <> ''
       and d.voice is not null and btrim(d.voice) <> ''
       and d.primary_color is not null and d.primary_color <> '#B11E2A'
       and d.accent_color is not null and d.accent_color <> '#1F4E79') as profile_complete,
      (select count(*) from members mm where mm.department_id = d.id
                                        and not (mm.access && array['Project Admin']::text[])
                                        and (mm.email is null or btrim(mm.email) = '')) as members_no_email_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null and dc.archived_at is null
                                          and (dc.content_text is null or btrim(dc.content_text) = '')) as documents_no_text_count,
      (select count(*) from certs c where c.department_id = d.id and c.exp ~ '^\d{4}-\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) between 0 and 3) as expiring_certs_count,
      (select count(*) from certs c where c.department_id = d.id and c.exp ~ '^\d{4}-\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) < 0) as expired_certs_count,
      (select count(*) from duties du where du.department_id = d.id
                                       and du.done = false and du.due_date is not null and du.due_date < current_date) as overdue_duties_count,
      (select count(*) from action_items ai where ai.department_id = d.id and ai.status = 'open') as open_action_items_count,
      (select count(*) from station_presence sp
         where sp.department_id = d.id
           and sp.checked_out_at is null
           and sp.checked_in_at < now() - interval '24 hours') as open_long_shifts_count,
      -- One label per UNMET profile_complete condition, each the exact negation of its clause above,
      -- so the array is empty exactly when profile_complete is true.
      array_remove(array[
        case when d.tagline is not null and btrim(d.tagline) <> ''          then null else 'Tagline' end,
        case when d.voice is not null and btrim(d.voice) <> ''              then null else 'Voice' end,
        case when d.primary_color is not null and d.primary_color <> '#B11E2A' then null else 'Custom primary color' end,
        case when d.accent_color is not null and d.accent_color <> '#1F4E79'   then null else 'Custom accent color' end
      ], null) as profile_missing
    from departments d
  )
  select b.department_id, b.department_name, b.station, b.city, b.admin_name, b.admin_email,
    case when b.last_activity is null then 'RED'
         when current_date - b.last_activity::date < 14 then 'GREEN'
         when current_date - b.last_activity::date <= 30 then 'YELLOW'
         else 'RED' end as health,
    b.last_activity,
    case when b.last_activity is null then null else current_date - b.last_activity::date end as days_since_activity,
    b.active_members_30d, b.member_count, b.documents_count, b.apparatus_count, b.training_sessions_count,
    b.profile_complete, b.members_no_email_count, b.documents_no_text_count,
    b.expiring_certs_count, b.expired_certs_count, b.overdue_duties_count, b.open_action_items_count,
    b.open_long_shifts_count,
    b.profile_missing
  from base b
  order by
    case when b.last_activity is null then 0
         when current_date - b.last_activity::date > 30 then 0
         when current_date - b.last_activity::date >= 14 then 1 else 2 end,
    b.last_activity asc nulls first, b.department_name asc;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.pa_department_radar() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_department_radar() TO authenticated;

do $post$
begin
  if has_function_privilege('anon', 'public.pa_department_radar()', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE pa_department_radar. Rolling back.';
  end if;
  if not has_function_privilege('authenticated', 'public.pa_department_radar()', 'EXECUTE') then
    raise exception 'Post-condition failed: authenticated cannot EXECUTE pa_department_radar. Rolling back.';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.pa_department_radar()'::regprocedure) then
    raise exception 'Post-condition failed: pa_department_radar is not SECURITY DEFINER. Rolling back.';
  end if;
  if pg_get_function_result('public.pa_department_radar()'::regprocedure) not like '%profile_missing text[]%' then
    raise exception 'Post-condition failed: profile_missing column missing. Rolling back.';
  end if;
end
$post$;

NOTIFY pgrst, 'reload schema';

commit;
