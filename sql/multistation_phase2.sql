-- =====================================================================
-- MULTI-STATION — PHASE 2: the cross-station roll-up.
--
-- ADDITIVE ONLY. One new function and nothing else. my_department_id(),
-- my_member_id() and the is_* family (Phase 1 / 1b) are NOT touched: this adds
-- a way to SEE several stations at once, it does not change which one you are
-- acting in. Switching still goes through set_active_department().
--
-- A SCOPED COPY OF pa_department_radar(), lifted from the LIVE definition
-- (pg_get_functiondef) rather than from sql/pa_department_radar.sql — that
-- file's own header admits the function has been dropped and recreated to add
-- columns, so the repo copy is not authoritative. The live return shape was
-- checked against it before writing this: 21 columns, identical names, identical
-- order, no drift.
--
-- EXACTLY THREE CHANGES from the live body, verified by diffing the two:
--   1. renamed to my_department_rollup()
--   2. the PA gate removed
--   3. one WHERE added to the single `from departments d` that feeds the base CTE
-- Every metric subquery, the health CASE and the ORDER BY are byte-identical.
-- That is the whole point of copying rather than rewriting: the roll-up cannot
-- disagree with the PA radar about a department's health, because the arithmetic
-- is the same arithmetic.
--
-- THE WHERE CLAUSE IS THE SECURITY BOUNDARY, and it replaces the gate rather
-- than relaxing it. The function is SECURITY DEFINER, so it reads across
-- department boundaries — that is what makes a roll-up possible at all. What
-- stops it being a data leak is that it takes NO PARAMETER and filters to
-- lower(auth.email())'s own memberships. There is nothing a caller can pass to
-- widen it. A single-station user gets exactly one row: their own department's
-- data, which they can already see everywhere else in the app.
--
-- WHY SCOPING THE ONE `from departments d` IS SUFFICIENT: every metric in the
-- base CTE is a correlated subquery keyed on d.id. Filter the driving relation
-- and every count, every max() and the health verdict follow it. There is no
-- second path into the data to forget about.
--
-- DEPLOY GATE: apply BEFORE the rebuilt bundle deploys — the client calls
-- my_department_rollup() and PostgREST answers 404 for a function it has not
-- seen. Safe against the current build, which never calls it.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.my_department_rollup()
 RETURNS TABLE(department_id uuid, department_name text, station text, city text, admin_name text, admin_email text, health text, last_activity timestamp with time zone, days_since_activity integer, active_members_30d bigint, member_count bigint, documents_count bigint, apparatus_count bigint, training_sessions_count bigint, profile_complete boolean, members_no_email_count bigint, documents_no_text_count bigint, expiring_certs_count bigint, expired_certs_count bigint, overdue_duties_count bigint, open_action_items_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
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
      (select count(*) from action_items ai where ai.department_id = d.id and ai.status = 'open') as open_action_items_count
    from departments d
    where d.id in (
      select m.department_id from public.members m
      where lower(m.email) = lower(auth.email())
    )
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
    b.expiring_certs_count, b.expired_certs_count, b.overdue_duties_count, b.open_action_items_count
  from base b
  order by
    case when b.last_activity is null then 0
         when current_date - b.last_activity::date > 30 then 0
         when current_date - b.last_activity::date >= 14 then 1 else 2 end,
    b.last_activity asc nulls first, b.department_name asc;
end;
$function$;

-- Postgres default-grants EXECUTE to PUBLIC on a new function and anon inherits
-- through PUBLIC — same pattern as sql/revoke_anon_execute_sweep.sql. The email
-- filter inside is what actually protects the data; this stops an unauthenticated
-- caller reaching the function at all, where auth.email() would be NULL and the
-- filter would match nothing anyway.
REVOKE EXECUTE ON FUNCTION public.my_department_rollup() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.my_department_rollup() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only.
--
-- my_department_rollup() reads auth.email(), which is NULL in the SQL editor.
-- Called there it returns ZERO ROWS — that is correct behaviour, not a failure,
-- and it is also the cheapest proof that the filter works: with no identity
-- there are no memberships and therefore no departments.
-- =====================================================================
--
-- -- 1. It exists, is STABLE SECURITY DEFINER, and anon cannot execute.
-- --    Expect definer=t, volatility=STABLE, anon=f, auth=t.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        CASE provolatile WHEN 's' THEN 'STABLE' WHEN 'v' THEN 'VOLATILE'
--                         WHEN 'i' THEN 'IMMUTABLE' END AS volatility,
--        prosecdef AS security_definer,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace AND proname = 'my_department_rollup';
--
-- -- 2. THE GATE IS GONE AND THE FILTER IS THERE. Expect pa_gate=f, scoped=t.
-- --    A true pa_gate would mean the copy still refuses for non-PAs; a false
-- --    scoped would mean it returns EVERY department to EVERY user — stop
-- --    immediately and drop the function if so.
-- SELECT proname,
--        (prosrc ILIKE '%is_project_admin%')                  AS pa_gate,
--        (prosrc ILIKE '%lower(m.email) = lower(auth.email())%') AS scoped
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace AND proname = 'my_department_rollup';
--
-- -- 3. Zero rows with no identity. In this editor auth.email() is NULL, so the
-- --    membership filter matches nothing. Expect 0.
-- SELECT count(*) AS rows_with_no_identity FROM public.my_department_rollup();
--
-- -- 4. The columns match pa_department_radar() exactly — the client renders the
-- --    same field names for both. Expect 0 rows (no differences).
-- SELECT a.ordinal_position, a.parameter_name AS rollup_col, b.parameter_name AS radar_col
--   FROM information_schema.parameters a
--   FULL JOIN information_schema.parameters b
--     ON a.ordinal_position = b.ordinal_position
--    AND b.specific_name = (SELECT oid::regprocedure::text FROM pg_proc
--                            WHERE pronamespace='public'::regnamespace
--                              AND proname='pa_department_radar' LIMIT 1)
--    AND b.parameter_mode = 'TABLE'
--  WHERE a.specific_name = (SELECT oid::regprocedure::text FROM pg_proc
--                            WHERE pronamespace='public'::regnamespace
--                              AND proname='my_department_rollup' LIMIT 1)
--    AND a.parameter_mode = 'TABLE'
--    AND a.parameter_name IS DISTINCT FROM b.parameter_name;
--
-- ---------- SIGNED IN as a real user (the app, or an authenticated session) ----------
--
-- -- 5. SINGLE-STATION USER: exactly one row, and its figures match what that
-- --    member already sees on their own dashboard. One row is the pass; two
-- --    would mean the filter is not scoping.
-- --   SELECT department_name, station, health, member_count, expiring_certs_count,
-- --          expired_certs_count, overdue_duties_count, open_action_items_count
-- --     FROM public.my_department_rollup();
--
-- -- 6. THE 2-DEPARTMENT TEST MEMBER (manufactured in the Phase 1 VERIFY):
-- --    expect exactly TWO rows, one per station, regardless of which station is
-- --    currently active — the roll-up is not scoped by the switcher.
-- --   SELECT department_name, station, health FROM public.my_department_rollup();
--
-- -- 7. NO LEAK. Count the departments that exist versus the rows returned. For
-- --    any non-PA user the second number must equal their membership count and
-- --    never the first.
-- --   SELECT (SELECT count(*) FROM public.departments)            AS departments_total,
-- --          (SELECT count(*) FROM public.my_department_rollup()) AS rows_i_can_see;
