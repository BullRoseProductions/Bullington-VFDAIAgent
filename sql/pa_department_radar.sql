-- ============================================================
-- Project Admin (PA) Dashboard — issue/health radar
-- ------------------------------------------------------------
-- Two functions powering a PA-only, cross-department monitoring
-- screen. Verified against the live DB (North Hood) — all tables
-- and columns below confirmed to exist live (certs.department_id,
-- duty_log, duties.due_date/done, action_items.completed_by, etc.).
--
-- NOTE: schema.sql in this repo is stale; this file is the source
-- of truth for these two functions. Idempotent (CREATE OR REPLACE)
-- — safe to re-run.
-- ============================================================

-- ============================================================
-- 1) is_project_admin()  — PA-ONLY gate
--    Models on is_announcer() (array-overlap), NOT is_department_admin()
--    which uses IN and is WRONG for the live text[] access column.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_project_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from members
    where lower(members.email) = lower(auth.email())
      and members.access && array['Project Admin']::text[]   -- PA only; excludes Department Admin
  );
$function$;

GRANT EXECUTE ON FUNCTION public.is_project_admin() TO authenticated;


-- ============================================================
-- 2) pa_department_radar()  — one row per department, all flags precomputed.
--    Self-gates on the FIRST line. SECURITY DEFINER so it can read across
--    departments (bypasses the per-dept RLS), but only a Project Admin
--    can get past the gate.
-- ============================================================
CREATE OR REPLACE FUNCTION public.pa_department_radar()
 RETURNS TABLE (
   department_id            uuid,
   department_name          text,
   station                  text,
   city                     text,
   -- health pulse
   health                   text,        -- GREEN / YELLOW / RED
   last_activity            timestamptz,
   days_since_activity      integer,
   active_members_30d       bigint,
   -- setup completeness
   member_count             bigint,
   documents_count          bigint,      -- current (non-deleted/archived)
   apparatus_count          bigint,
   training_sessions_count  bigint,
   profile_complete         boolean,
   -- issue flags (needs attention)
   members_no_email_count   bigint,
   documents_no_text_count  bigint,      -- advisory: content_text IS NULL
   expiring_certs_count     bigint,      -- 0..3 months out
   expired_certs_count      bigint,      -- already lapsed
   overdue_duties_count     bigint,
   open_action_items_count  bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- hard gate: only a Project Admin may run this
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  with base as (
    select
      d.id   as department_id,
      d.name as department_name,
      d.station,
      d.city,

      -- ---- HEALTH PULSE: last activity = max across every live dated per-dept signal
      greatest(
        (select max(sa.checked_in_at) from session_attendance sa where sa.department_id = d.id),
        (select max(dl.done_at)       from duty_log dl          where dl.department_id = d.id),
        (select max(ai.created_at)    from action_items ai      where ai.department_id = d.id),
        (select max(doc.created_at)   from documents doc        where doc.department_id = d.id
                                                                  and doc.deleted_at is null
                                                                  and doc.archived_at is null),
        (select max(an.created_at)    from announcements an     where an.department_id = d.id),
        (select max(ts.created_at)    from training_sessions ts where ts.department_id = d.id)
        -- training_sessions is the LIVE "meetings/drills" source (the app never queries the
        -- legacy `meetings` table).
      ) as last_activity,

      -- ---- ACTIVE MEMBERS (distinct, last 30 days): check-ins + duty completions + action-item completions
      (select count(distinct mid) from (
          select sa.member_id   as mid from session_attendance sa
            where sa.department_id = d.id and sa.checked_in_at >= now() - interval '30 days'
          union
          select dl.done_by            from duty_log dl
            where dl.department_id = d.id and dl.done_at      >= now() - interval '30 days'
          union
          select ai.completed_by       from action_items ai
            where ai.department_id = d.id and ai.completed_at >= now() - interval '30 days'
       ) act where mid is not null) as active_members_30d,

      -- ---- SETUP COMPLETENESS
      (select count(*) from members mm   where mm.department_id = d.id) as member_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null
                                          and dc.archived_at is null)   as documents_count,
      (select count(*) from apparatus ap where ap.department_id = d.id) as apparatus_count,
      (select count(*) from training_sessions ts where ts.department_id = d.id) as training_sessions_count,

      -- profile/brand "filled in" heuristic: tagline + voice present AND colors customized off defaults.
      -- logo_url is deliberately EXCLUDED (v1 brand form doesn't save it — see App.jsx:6937).
      (    d.tagline       is not null and btrim(d.tagline) <> ''
       and d.voice         is not null and btrim(d.voice)   <> ''
       and d.primary_color is not null and d.primary_color <> '#B11E2A'
       and d.accent_color  is not null and d.accent_color  <> '#1F4E79'
      ) as profile_complete,

      -- ---- ISSUE FLAGS
      (select count(*) from members mm where mm.department_id = d.id
                                        and (mm.email is null or btrim(mm.email) = '')) as members_no_email_count,

      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null
                                          and dc.archived_at is null
                                          and (dc.content_text is null or btrim(dc.content_text) = '')) as documents_no_text_count,

      -- certs.exp is 'YYYY-MM' TEXT (month precision). Parse, do NOT cast to date. Mirrors App.jsx:4021.
      -- diff = (yr*12 + mo) - (current yr*12 + current mo)
      (select count(*) from certs c
         where c.department_id = d.id
           and c.exp ~ '^\d{4}-\d{2}$'
           and ( split_part(c.exp,'-',1)::int * 12 + split_part(c.exp,'-',2)::int )
             - ( extract(year from now())::int * 12 + extract(month from now())::int ) between 0 and 3
      ) as expiring_certs_count,

      (select count(*) from certs c
         where c.department_id = d.id
           and c.exp ~ '^\d{4}-\d{2}$'
           and ( split_part(c.exp,'-',1)::int * 12 + split_part(c.exp,'-',2)::int )
             - ( extract(year from now())::int * 12 + extract(month from now())::int ) < 0
      ) as expired_certs_count,

      (select count(*) from duties du where du.department_id = d.id
                                       and du.done = false
                                       and du.due_date is not null
                                       and du.due_date < current_date) as overdue_duties_count,

      (select count(*) from action_items ai where ai.department_id = d.id
                                            and ai.status = 'open') as open_action_items_count

    from departments d
  )
  select
    b.department_id,
    b.department_name,
    b.station,
    b.city,
    case
      when b.last_activity is null                    then 'RED'
      when current_date - b.last_activity::date <  14 then 'GREEN'
      when current_date - b.last_activity::date <= 30 then 'YELLOW'
      else 'RED'
    end                                               as health,
    b.last_activity,
    case when b.last_activity is null then null
         else current_date - b.last_activity::date end as days_since_activity,
    b.active_members_30d,
    b.member_count,
    b.documents_count,
    b.apparatus_count,
    b.training_sessions_count,
    b.profile_complete,
    b.members_no_email_count,
    b.documents_no_text_count,
    b.expiring_certs_count,
    b.expired_certs_count,
    b.overdue_duties_count,
    b.open_action_items_count
  from base b
  order by
    -- worst health first, then most stale — the "needs attention" stuff floats up
    case
      when b.last_activity is null then 0
      when current_date - b.last_activity::date > 30 then 0
      when current_date - b.last_activity::date >= 14 then 1
      else 2
    end,
    b.last_activity asc nulls first,
    b.department_name asc;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.pa_department_radar() TO authenticated;
