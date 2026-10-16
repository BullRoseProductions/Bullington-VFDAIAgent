-- =====================================================================
-- MEMBERSHIP WINDOW — attendance only inside a member's start..end dates; a Department-Admin-only termination date.
-- APPLIED by hand 2026-10-16 (before a recorded review PASS). State check on live: rls_on true · 0 policies · 0 rows ·
-- anon_execute false · auth_window_execute false · auth_select false · triggers 2 · 157 policies (unchanged).
-- RETEST on live: 50 passed, 0 failed, 8 skipped. Was: DRAFT — for the reviewing Claude, then Ashlea applies. Test script: sql/membership_window_RETEST.sql (run AFTER,
-- separately). Cleanup of rows that already break the rule is a SEPARATE, previewed script:
-- sql/membership_window_cleanup_PREVIEW.sql then sql/membership_window_cleanup_DRAFT.sql.
--
-- THE PROBLEM. Nothing on the server checks that a member belonged to the department on the drill's date. The
-- officer roster (toggleAttend — a direct session_attendance INSERT under RLS) and the QR path (member_check_in)
-- both attach anyone: recent joiners land on pre-join drills, terminated members on post-exit drills.
--
-- THE WINDOW.
--   start = member_private.joined_date; if that is blank, Jan 1 of a leading 4-digit year in members.joined;
--           if both are blank, NO lower bound. This is EXACTLY the client's joinCutoff() (App.jsx), so the screen and
--           the server agree, and missing join info never wrongly blocks anybody.
--   end   = member_separation.terminated_on (NEW, below); blank = still a member. The end date itself is INCLUDED
--           (a member terminated 10/9 can still be credited for a 10/9 drill); the day after is refused.
--
-- WHAT CHANGES — ADDITIVE ONLY:
--   1. NEW table public.member_separation (member_id PK -> members ON DELETE CASCADE, department_id -> departments,
--      terminated_on date, set_by_member, set_at). HR-sensitive, so it is LOCKED the same way image_gen_usage is:
--      RLS ON, ZERO policies, every privilege revoked from anon/authenticated/public. Nobody reads it directly — not
--      officers, not members, not the celebrations view, not members_view. The two RPCs below are the only doors.
--   2. NEW RPCs (SECURITY DEFINER; EXECUTE revoked from anon+public, granted to authenticated):
--        get_member_termination(p_member uuid) RETURNS date
--        set_member_termination(p_member uuid, p_date date) RETURNS jsonb   -- p_date NULL clears it
--      Both require the caller to be a DEPARTMENT ADMIN OF THAT MEMBER'S DEPARTMENT: the target's department must be
--      my_department_id() AND the caller must hold a members row in that same department whose access contains
--      'Department Admin'. Deliberately NOT is_dept_admin() / is_department_admin(): both also admit Project Admins
--      (and one is role-anywhere — the 2026-10-13 cert leak). The brief is "only a Department Admin can see".
--      FLAG FOR REVIEW: Project Admins are therefore excluded too. set_ returns {terminated_on, attendance_after} —
--      how many attendance rows already sit after the date (they are NOT deleted here; the UI says so).
--   3. NEW internal helper public.membership_window_allows(p_member uuid, p_date date) RETURNS boolean.
--      EXECUTE revoked from EVERYONE incl. authenticated — callable only from the trigger functions (same owner), so
--      nobody can probe it date-by-date to recover a termination date.
--   4. NEW triggers (the enforcement — they fire for every writer, RLS or SECURITY DEFINER, even the table owner):
--        session_attendance  BEFORE INSERT OR UPDATE OF session_id, member_id  -> refuse outside the window
--        training_sessions   BEFORE UPDATE OF date (only when it really changes) -> refuse moving a drill to a date on
--                            which one of its attendees was not a member (otherwise "move the drill" bypasses 4a)
--      The refusal text never contains a date: 'MEMBERSHIP_WINDOW: this member was not on the department roster on
--      that date.' The client maps the MEMBERSHIP_WINDOW prefix to a plain message.
--
-- WHAT DOES NOT CHANGE. No policy on any table is created, altered or dropped (post-condition proves every policy is
-- identical, character for character). DELETE of attendance is untouched (an officer can always remove a row).
-- Existing rows that break the rule are NOT touched — that is the cleanup script's job, previewed first.
-- Editing a join date or setting a termination date does not re-check existing rows (the cleanup covers today's;
-- set_member_termination reports any it leaves behind).
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor. Safe to re-run (idempotent).
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_n int; v_t text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'$q$;
BEGIN
  -- 0. preconditions — the shapes this is written against
  IF to_regprocedure('public.my_department_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_department_id() missing.';
  END IF;
  SELECT data_type INTO v_t FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'date';
  IF v_t IS DISTINCT FROM 'date' THEN RAISE EXCEPTION 'Precondition failed: training_sessions.date is %, expected date.', coalesce(v_t, 'missing'); END IF;
  SELECT data_type INTO v_t FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_private' AND column_name = 'joined_date';
  IF v_t IS DISTINCT FROM 'date' THEN RAISE EXCEPTION 'Precondition failed: member_private.joined_date is %, expected date.', coalesce(v_t, 'missing'); END IF;
  SELECT data_type INTO v_t FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members' AND column_name = 'access';
  IF v_t IS DISTINCT FROM 'ARRAY' THEN RAISE EXCEPTION 'Precondition failed: members.access is %, expected text[].', coalesce(v_t, 'missing'); END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members' AND column_name = 'joined')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'session_attendance' AND column_name = 'session_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'session_attendance' AND column_name = 'member_id') THEN
    RAISE EXCEPTION 'Precondition failed: members.joined or session_attendance.(session_id, member_id) missing.';
  END IF;
  FOREACH v_t IN ARRAY array['public.membership_window_allows(uuid,date)', 'public.get_member_termination(uuid)', 'public.set_member_termination(uuid,date)',
                             'public.tg_session_attendance_membership_window()', 'public.tg_training_session_date_membership_window()'] LOOP
    IF to_regprocedure(v_t) IS NOT NULL THEN   -- nested: SQL AND doesn't short-circuit
      IF position('B4C:membership_window' in pg_get_functiondef(to_regprocedure(v_t))) = 0 THEN
        RAISE EXCEPTION 'Precondition failed: a different % exists — not overwriting it.', v_t;
      END IF;
    END IF;
  END LOOP;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1. the termination date — locked: RLS on, no policies, no privileges
  CREATE TABLE IF NOT EXISTS public.member_separation (
    member_id      uuid PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
    department_id  uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    terminated_on  date NOT NULL,
    set_by_member  uuid,
    set_at         timestamptz NOT NULL DEFAULT now()
  );
  COMMENT ON TABLE public.member_separation IS
    'B4C:membership_window — termination date (HR-sensitive). RPC-only: get_/set_member_termination (Department Admin of that department).';
  ALTER TABLE public.member_separation ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.member_separation FROM anon, authenticated, public;

  -- 2. the window test (internal)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.membership_window_allows(p_member uuid, p_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- B4C:membership_window — start = joined_date, else Jan 1 of members.joined's leading year, else none (== joinCutoff);
  -- end = member_separation.terminated_on, inclusive. Unknown member -> true (FKs police existence, not this).
  select coalesce((
    select (s.start_on is null or p_date >= s.start_on)
       and (s.end_on   is null or p_date <= s.end_on)
      from (select coalesce(mp.joined_date,
                            make_date(nullif(substring(m.joined::text from '^\s*(\d{4})'), '')::int, 1, 1)) as start_on,
                   ms.terminated_on as end_on
              from public.members m
              left join public.member_private    mp on mp.member_id = m.id
              left join public.member_separation ms on ms.member_id = m.id
             where m.id = p_member) s
  ), true);
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.membership_window_allows(uuid, date) FROM anon, authenticated, public;

  -- 3. enforcement on attendance
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.tg_session_attendance_membership_window()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:membership_window — refuse attendance on a drill dated outside the member's membership window. No date in the message.
declare v_date date;
begin
  select ts."date" into v_date from public.training_sessions ts where ts.id = NEW.session_id;
  if v_date is not null and not public.membership_window_allows(NEW.member_id, v_date) then
    raise exception 'MEMBERSHIP_WINDOW: this member was not on the department roster on that date.';
  end if;
  return NEW;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.tg_session_attendance_membership_window() FROM anon, authenticated, public;
  DROP TRIGGER IF EXISTS session_attendance_membership_window ON public.session_attendance;
  CREATE TRIGGER session_attendance_membership_window
    BEFORE INSERT OR UPDATE OF session_id, member_id ON public.session_attendance
    FOR EACH ROW EXECUTE FUNCTION public.tg_session_attendance_membership_window();

  -- 4. enforcement on moving a drill
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.tg_training_session_date_membership_window()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:membership_window — a drill can't be moved to a date on which one of its recorded attendees was not a member.
begin
  if NEW."date" is distinct from OLD."date" and NEW."date" is not null and exists (
       select 1 from public.session_attendance sa
        where sa.session_id = NEW.id and not public.membership_window_allows(sa.member_id, NEW."date")) then
    raise exception 'MEMBERSHIP_WINDOW: a member recorded at this drill was not on the department roster on that date.';
  end if;
  return NEW;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.tg_training_session_date_membership_window() FROM anon, authenticated, public;
  DROP TRIGGER IF EXISTS training_session_date_membership_window ON public.training_sessions;
  CREATE TRIGGER training_session_date_membership_window
    BEFORE UPDATE OF "date" ON public.training_sessions
    FOR EACH ROW EXECUTE FUNCTION public.tg_training_session_date_membership_window();

  -- 5. the two doors — Department Admin of the member's own department only
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.get_member_termination(p_member uuid)
 RETURNS date
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:membership_window — Department Admin of that member's department only (not Project Admin, not officers).
declare v_dept uuid; v_on date;
begin
  select department_id into v_dept from public.members where id = p_member;
  if v_dept is null or v_dept is distinct from public.my_department_id()
     or not exists (select 1 from public.members me
                     where lower(me.email) = lower(auth.email()) and me.department_id = v_dept
                       and me.access && array['Department Admin']::text[]) then
    raise exception 'Only a Department Admin can see this.';
  end if;
  select terminated_on into v_on from public.member_separation where member_id = p_member;
  return v_on;
end;
$function$
$ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_member_termination(p_member uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:membership_window — Department Admin of that member's department only. p_date NULL clears it. Never deletes attendance.
declare v_dept uuid; v_me uuid; v_after int := 0;
begin
  select department_id into v_dept from public.members where id = p_member;
  select me.id into v_me from public.members me
   where lower(me.email) = lower(auth.email()) and me.department_id = v_dept
     and me.access && array['Department Admin']::text[]
   limit 1;
  if v_dept is null or v_dept is distinct from public.my_department_id() or v_me is null then
    raise exception 'Only a Department Admin can change this.';
  end if;
  if p_date is null then
    delete from public.member_separation where member_id = p_member;
  else
    insert into public.member_separation as s (member_id, department_id, terminated_on, set_by_member, set_at)
    values (p_member, v_dept, p_date, v_me, now())
    on conflict (member_id) do update set terminated_on = excluded.terminated_on, department_id = excluded.department_id,
                                          set_by_member = excluded.set_by_member, set_at = now();
    select count(*) into v_after from public.session_attendance sa
      join public.training_sessions ts on ts.id = sa.session_id
     where sa.member_id = p_member and ts."date" > p_date;
  end if;
  return jsonb_build_object('terminated_on', p_date, 'attendance_after', v_after);
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.get_member_termination(uuid)       FROM anon, public;
  REVOKE EXECUTE ON FUNCTION public.set_member_termination(uuid, date) FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.get_member_termination(uuid)       TO authenticated;
  GRANT  EXECUTE ON FUNCTION public.set_member_termination(uuid, date) TO authenticated;

  -- 6. post-conditions — any failure undoes the whole block
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.member_separation'::regclass) THEN
    RAISE EXCEPTION 'Post-condition failed: RLS is off on member_separation. Rolling back.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_separation';
  IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: member_separation has % policies (expected none). Rolling back.', v_n; END IF;
  FOREACH v_t IN ARRAY array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.member_separation', v_t) OR has_table_privilege('authenticated', 'public.member_separation', v_t) THEN
      RAISE EXCEPTION 'Post-condition failed: anon/authenticated hold % on member_separation. Rolling back.', v_t;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.get_member_termination(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_member_termination(uuid,date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.membership_window_allows(uuid,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.membership_window_allows(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: a function is executable by a role that must not have it. Rolling back.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN ('session_attendance_membership_window', 'training_session_date_membership_window') AND tgenabled = 'O';
  IF v_n <> 2 THEN RAISE EXCEPTION 'Post-condition failed: % of 2 triggers enabled. Rolling back.', v_n; END IF;
  -- terminated_on must not be visible through any view (celebrations, members_view, …)
  IF EXISTS (SELECT 1 FROM information_schema.columns c JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
              WHERE c.table_schema = 'public' AND c.column_name = 'terminated_on') THEN
    RAISE EXCEPTION 'Post-condition failed: a view exposes terminated_on. Rolling back.';
  END IF;
  -- EVERY POLICY UNCHANGED, character for character (this migration adds none)
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN
    RAISE EXCEPTION 'Post-condition failed: a policy changed. Rolling back.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: rls_on true · 0 policies · anon_execute false · auth_window_execute false ·
-- auth_select false · triggers 2 · total_policies = what you had before
SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.member_separation'::regclass) AS rls_on,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_separation') AS table_policies,
       (SELECT count(*) FROM public.member_separation) AS rows,
       has_function_privilege('anon', 'public.set_member_termination(uuid,date)', 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', 'public.membership_window_allows(uuid,date)', 'EXECUTE') AS auth_window_execute,
       has_table_privilege('authenticated', 'public.member_separation', 'SELECT') AS auth_select,
       (SELECT count(*) FROM pg_trigger WHERE tgname IN ('session_attendance_membership_window', 'training_session_date_membership_window')) AS triggers,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- =====================================================================
-- ROLLBACK (only if needed, separately). Drops the termination dates with the table.
-- =====================================================================
-- DO $rb$
-- BEGIN
--   DROP TRIGGER IF EXISTS session_attendance_membership_window ON public.session_attendance;
--   DROP TRIGGER IF EXISTS training_session_date_membership_window ON public.training_sessions;
--   DROP FUNCTION IF EXISTS public.tg_session_attendance_membership_window();
--   DROP FUNCTION IF EXISTS public.tg_training_session_date_membership_window();
--   DROP FUNCTION IF EXISTS public.get_member_termination(uuid);
--   DROP FUNCTION IF EXISTS public.set_member_termination(uuid, date);
--   DROP FUNCTION IF EXISTS public.membership_window_allows(uuid, date);
--   DROP TABLE IF EXISTS public.member_separation;
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
