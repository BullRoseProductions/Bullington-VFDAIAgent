-- =====================================================================
-- MULTI-STATION — PHASE 2b: make the roll-up ROLE-AWARE PER STATION.
--
-- THE PROBLEM THIS CLOSES. Phase 2 returned station-wide leadership figures —
-- member counts, expiring and expired certs, overdue duties, open action items,
-- the primary admin's name and email — to every caller who belonged to two or
-- more departments. Belonging to a station is not the same as running it. A
-- plain member at station B could read B's whole operational picture.
--
-- PER DEPARTMENT, NOT PER LOGIN. Somebody can be an Officer at one station and
-- an ordinary firefighter at another, so can_manage is decided against the
-- caller's member row IN THAT DEPARTMENT — d.id by d.id — not once for the
-- session.
--
-- NULLED AT THE DATABASE, NOT HIDDEN IN THE UI. Where the caller does not
-- manage a station, every leadership column comes back NULL. Nothing crosses
-- the wire that the client then has to be trusted to conceal. A UI-only fix
-- would leave the numbers visible to anyone who opened the network tab.
--
-- THE ROLE ARRAY IS is_canmanage()'s, READ FROM THE LIVE FUNCTION:
--     array['Board Member','Department Admin','Officer']
-- The brief separately listed a four-element array including 'Project Admin'.
-- That is NOT what is_canmanage() uses, and shared/roles.js carries an explicit
-- "NO Project Admin" comment on the same set. Following the live function:
-- including PA here would hand a Project Admin station-wide leadership figures
-- at any department where they happen to hold a member row, which is exactly the
-- over-exposure this migration exists to close. A PA already has
-- pa_department_radar() for cross-department oversight.
--
-- ATTENDANCE USES is_leader()'s ARRAY, which is a DIFFERENT set — it includes
-- Project Admin. That is not an inconsistency: it mirrors MemberDashboard's
-- monthRate, where being a leader means restricted (leadership/board) drills
-- count toward your rate. Two questions, two role sets, both taken from the
-- live functions rather than assumed.
--
-- UNCHANGED, DELIBERATELY: my_department_id(), my_member_id() and the is_*
-- family are not touched by this file. Nothing here alters what any
-- single-department user sees anywhere in the app.
--
-- THE AUTHORIZATION BOUNDARY IS UNCHANGED AND KEPT VERBATIM: the same
--     where d.id in (select department_id from members where lower(email) = lower(auth.email()))
-- from Phase 2. The new LATERAL that resolves the caller's own member row is an
-- additional read, NOT a second boundary — it cannot widen the department set,
-- because the WHERE has already fixed it. Still no parameters.
--
-- DEPLOY GATE: apply BEFORE the rebuilt bundle deploys. The client branches on
-- can_manage, which the current function does not return.
-- =====================================================================

BEGIN;

-- DROP FIRST — REQUIRED, not tidiness. Postgres cannot change a function's
-- RETURNS TABLE via CREATE OR REPLACE ("cannot change return type of existing
-- function"), and this adds 12 columns to Phase 2's 21. The same constraint is
-- why sql/pa_department_radar.sql says that function must be dropped to add
-- columns.
--
-- SAFE HERE, and worth saying why rather than assuming: nothing depends on this
-- function. No view selects from it, no RLS policy calls it, no other function
-- references it — the only caller is the client, over PostgREST. Dropping a
-- function that policies depended on would be a very different and much worse
-- operation.
--
-- INSIDE THE TRANSACTION, so no other session ever observes the window where the
-- function does not exist, and a failure anywhere below rolls the DROP back with
-- everything else — the Phase 2 version survives intact.
--
-- DROP DISCARDS THE GRANTS. That is why the REVOKE/GRANT pair below the function
-- is not optional bookkeeping: without it the recreated function would carry
-- Postgres's default EXECUTE-to-PUBLIC and anon would inherit it.
DROP FUNCTION IF EXISTS public.my_department_rollup();

CREATE OR REPLACE FUNCTION public.my_department_rollup()
 RETURNS TABLE(
   -- ---- always returned: enough to render a card header for any station you belong to
   department_id uuid, department_name text, station text, city text,
   can_manage boolean,
   -- ---- leadership columns: the Phase 2 set, NULL unless can_manage
   admin_name text, admin_email text, health text,
   last_activity timestamp with time zone, days_since_activity integer,
   active_members_30d bigint, member_count bigint, documents_count bigint,
   apparatus_count bigint, training_sessions_count bigint, profile_complete boolean,
   members_no_email_count bigint, documents_no_text_count bigint,
   expiring_certs_count bigint, expired_certs_count bigint,
   overdue_duties_count bigint, open_action_items_count bigint,
   -- ---- member-scoped columns: the caller's OWN standing at that station
   my_attendance_pct integer, my_attendance_total integer, my_attendance_attended integer,
   my_certs_current integer, my_certs_expiring integer, my_certs_expired integer,
   my_open_duties integer, my_overdue_duties integer,
   my_next_event_date date, my_next_event_title text, my_next_event_type text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with base as (
    select
      d.id as department_id, d.name as department_name, d.station, d.city,

      -- WHAT THE CALLER IS **HERE**. me.my_access is this person's roles at THIS
      -- department; a leader at one station is not a leader at the next.
      coalesce(me.my_access && array['Board Member','Department Admin','Officer']::text[], false) as can_manage,
      -- is_leader()'s array, used ONLY to decide whether restricted drills count
      -- toward this member's own attendance rate (mirrors MemberDashboard).
      coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false) as my_is_leader,
      me.my_mid,

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
      (select count(*) from members mm where mm.department_id = d.id) as member_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null and dc.archived_at is null) as documents_count,
      (select count(*) from apparatus ap where ap.department_id = d.id) as apparatus_count,
      (select count(*) from training_sessions ts where ts.department_id = d.id) as training_sessions_count,
      (    d.tagline is not null and btrim(d.tagline) <> ''
       and d.voice is not null and btrim(d.voice) <> ''
       and d.primary_color is not null and d.primary_color <> '#B11E2A'
       and d.accent_color is not null and d.accent_color <> '#1F4E79') as profile_complete,
      (select count(*) from members mm where mm.department_id = d.id
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

      -- ================= MEMBER-SCOPED =================
      -- Every one of these is filtered to me.my_mid. They are computed for all
      -- callers (they are the caller's OWN data, never anybody else's) and are
      -- what a non-managing member sees in place of the leadership figures.

      -- ATTENDANCE, this calendar month, mirroring MemberDashboard.monthRate:
      -- a drill counts only if it is done, has at least one recorded attendee,
      -- is not flagged optional, and — for a non-leader — is not restricted.
      -- The "has an attendee" test is what makes this "recorded drills" rather
      -- than "scheduled drills"; a session nobody signed into is not a missed
      -- drill, it is an unheld one.
      (select count(*) from training_sessions ts
        where ts.department_id = d.id and ts.done
          and date_trunc('month', ts.date) = date_trunc('month', current_date)
          and coalesce(ts.counts_toward_attendance, true) <> false
          and (coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false)
               or coalesce(ts.audience,'everyone') not in ('leadership','board'))
          and exists (select 1 from session_attendance sa where sa.session_id = ts.id)
      )::int as my_attendance_total,
      (select count(*) from training_sessions ts
        where ts.department_id = d.id and ts.done
          and date_trunc('month', ts.date) = date_trunc('month', current_date)
          and coalesce(ts.counts_toward_attendance, true) <> false
          and (coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false)
               or coalesce(ts.audience,'everyone') not in ('leadership','board'))
          and exists (select 1 from session_attendance sa
                       where sa.session_id = ts.id and sa.member_id = me.my_mid)
      )::int as my_attendance_attended,

      -- CERTS — same month-arithmetic and same regex as the leadership columns
      -- above, filtered to this member. The three buckets are disjoint, so a
      -- cert is current, expiring, or expired, never two of them.
      (select count(*) from certs c where c.department_id = d.id and c.member_id = me.my_mid
           and c.exp ~ '^\d{4}-\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) > 3)::int as my_certs_current,
      (select count(*) from certs c where c.department_id = d.id and c.member_id = me.my_mid
           and c.exp ~ '^\d{4}-\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) between 0 and 3)::int as my_certs_expiring,
      (select count(*) from certs c where c.department_id = d.id and c.member_id = me.my_mid
           and c.exp ~ '^\d{4}-\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) < 0)::int as my_certs_expired,

      -- DUTIES assigned to me here. Two numbers, because the card needs both:
      -- open drives the "N due" stat, overdue drives the red edge.
      (select count(*) from duties du where du.department_id = d.id
                                       and du.assigned_to = me.my_mid and du.done = false)::int as my_open_duties,
      (select count(*) from duties du where du.department_id = d.id
                                       and du.assigned_to = me.my_mid and du.done = false
                                       and du.due_date is not null and du.due_date < current_date)::int as my_overdue_duties,

      -- NEXT EVENT across the same four calendar sources MemberDashboard reads.
      -- Audience-aware: a non-leader is not told about a leadership-only drill
      -- they cannot attend. content_calendar's text column is `caption`, not
      -- `title` — confirmed against the live schema, not assumed.
      nx.nd as my_next_event_date, nx.nt as my_next_event_title, nx.nk as my_next_event_type

    from departments d
    -- The caller's own member row AT THIS DEPARTMENT. Phase 1b's unique index on
    -- (lower(email), department_id) guarantees at most one, so this cannot fan out;
    -- the limit 1 is belt and braces.
    left join lateral (
      select m.id as my_mid, m.access as my_access
        from members m
       where m.email is not null
         and lower(m.email) = lower(auth.email())
         and m.department_id = d.id
       limit 1
    ) me on true
    left join lateral (
      select x.d as nd, x.t as nt, x.k as nk
        from (
          select ts.date as d, ts.title as t, 'Training'::text as k
            from training_sessions ts
           where ts.department_id = d.id and ts.date >= current_date
             and (coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false)
                  or coalesce(ts.audience,'everyone') not in ('leadership','board'))
          union all
          select fe.date, fe.title, 'Funding'::text
            from funding_events fe where fe.department_id = d.id and fe.date >= current_date
          union all
          select re.date, re.title, 'Recruitment'::text
            from recruitment_events re where re.department_id = d.id and re.date >= current_date
          union all
          select cc.date, cc.caption, 'Content'::text
            from content_calendar cc where cc.department_id = d.id and cc.date >= current_date
        ) x
       order by x.d asc, x.k asc
       limit 1
    ) nx on true
    -- UNCHANGED FROM PHASE 2 — the authorization boundary, verbatim.
    where d.id in (
      select m.department_id from public.members m
      where lower(m.email) = lower(auth.email())
    )
  )
  select
    b.department_id, b.department_name, b.station, b.city,
    b.can_manage,
    -- EVERY leadership column is gated on can_manage. This is the whole point of
    -- the migration: a non-managing member gets NULL over the wire, not a number
    -- the client is trusted to hide.
    case when b.can_manage then b.admin_name  end,
    case when b.can_manage then b.admin_email end,
    case when b.can_manage then
      case when b.last_activity is null then 'RED'
           when current_date - b.last_activity::date < 14 then 'GREEN'
           when current_date - b.last_activity::date <= 30 then 'YELLOW'
           else 'RED' end
    end as health,
    case when b.can_manage then b.last_activity end,
    case when b.can_manage then
      case when b.last_activity is null then null else current_date - b.last_activity::date end
    end as days_since_activity,
    case when b.can_manage then b.active_members_30d      end,
    case when b.can_manage then b.member_count            end,
    case when b.can_manage then b.documents_count         end,
    case when b.can_manage then b.apparatus_count         end,
    case when b.can_manage then b.training_sessions_count end,
    case when b.can_manage then b.profile_complete        end,
    case when b.can_manage then b.members_no_email_count  end,
    case when b.can_manage then b.documents_no_text_count end,
    case when b.can_manage then b.expiring_certs_count    end,
    case when b.can_manage then b.expired_certs_count     end,
    case when b.can_manage then b.overdue_duties_count    end,
    case when b.can_manage then b.open_action_items_count end,
    -- Member-scoped: always returned, always the caller's own data.
    -- pct is NULL when the month held no qualifying drills — "no drills yet" and
    -- "attended none of them" are different facts and must not both read as 0%.
    case when b.my_attendance_total > 0
         then round(b.my_attendance_attended * 100.0 / b.my_attendance_total)::int end as my_attendance_pct,
    b.my_attendance_total, b.my_attendance_attended,
    b.my_certs_current, b.my_certs_expiring, b.my_certs_expired,
    b.my_open_duties, b.my_overdue_duties,
    b.my_next_event_date, b.my_next_event_title, b.my_next_event_type
  from base b
  order by
    case when b.last_activity is null then 0
         when current_date - b.last_activity::date > 30 then 0
         when current_date - b.last_activity::date >= 14 then 1 else 2 end,
    b.last_activity asc nulls first, b.department_name asc;
end;
$function$;

-- Grants unchanged from Phase 2. The email filter inside is what protects the
-- data; this keeps an unauthenticated caller from reaching the function at all.
REVOKE EXECUTE ON FUNCTION public.my_department_rollup() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.my_department_rollup() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only.
--
-- As in Phase 2, calling the function in the SQL editor returns ZERO ROWS
-- because auth.email() is NULL there. That is the pass, not a failure.
-- =====================================================================
--
-- -- 1. UNTOUCHED PROOF. Re-run these and diff against the STEP 0 capture taken
-- --    before this migration. They must be character-for-character identical —
-- --    this file does not contain the word "my_department_id" outside comments.
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
-- SELECT pg_get_functiondef('public.is_canmanage()'::regprocedure);
-- SELECT pg_get_functiondef('public.is_leader()'::regprocedure);
--
-- -- 2. The rollup still has its boundary and still has no PA gate.
-- --    Expect pa_gate=f, scoped=t, role_array=t.
-- SELECT proname,
--        (prosrc ILIKE '%is_project_admin%')                              AS pa_gate,
--        (prosrc ILIKE '%lower(m.email) = lower(auth.email())%')          AS scoped,
--        (prosrc ILIKE '%Board Member%Department Admin%Officer%')         AS role_array
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='my_department_rollup';
--
-- -- 3. Column count and order. Expect 33 columns, can_manage at position 5.
-- SELECT ordinal_position, parameter_name, data_type
--   FROM information_schema.parameters
--  WHERE specific_schema='public'
--    AND specific_name=(SELECT oid::regprocedure::text FROM pg_proc
--                        WHERE pronamespace='public'::regnamespace
--                          AND proname='my_department_rollup' LIMIT 1)
--    AND parameter_mode='TABLE'
--  ORDER BY ordinal_position;
--
-- -- 4. No identity, no rows.
-- SELECT count(*) AS rows_with_no_identity FROM public.my_department_rollup();
--
-- ---------- SIGNED IN, and this is the proof the brief asks for ----------
--
-- -- 5. THE MIXED-ROLE TEST USER: leader at one station, plain member at the
-- --    other. Expect can_manage true on exactly one row, and on the OTHER row
-- --    every leadership column NULL. Check this in the network response, not
-- --    just on screen — the point of the migration is that the numbers are not
-- --    sent, not that they are not drawn.
-- --   SELECT department_name, can_manage,
-- --          member_count, expiring_certs_count, expired_certs_count,
-- --          overdue_duties_count, open_action_items_count, health, admin_email,
-- --          my_attendance_pct, my_certs_expiring, my_certs_expired,
-- --          my_open_duties, my_next_event_date, my_next_event_title
-- --     FROM public.my_department_rollup();
--
-- -- 6. REGRESSION — the all-leader 2-department user. Both rows must have
-- --    can_manage = true and the same leadership figures as before this
-- --    migration. The leader card is not being redesigned.
--
-- -- 7. A single-station member: exactly one row, and the client still renders
-- --    nothing (the <= 1 gate is unchanged).
