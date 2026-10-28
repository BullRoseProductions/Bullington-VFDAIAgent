-- =====================================================================
-- ROLLBACK for l4_role_helpers_scope — insurance, GENERATED from the same capture: the three functions re-created from
-- their exact captured definitions. Refuses unless all three are in the applied state; proves each is back to its md5.
-- =====================================================================
DO $rollback$
DECLARE r record;
BEGIN
  IF NOT ((SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_leadership' AND p.prokind = 'f') = '
  -- L-4: the department-scoped leadership gate. Same roles + status as before, now only in the caller''s own department
  -- (my_department_id()); that is exactly is_leader(), so it delegates — one definition, no drift. Callers unchanged.
  select public.is_leader();
'
          AND (SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_department_admin' AND p.prokind = 'f') = '
  -- L-4: the department-scoped admin gate (Department Admin or Project Admin, in the caller''s own department). That is
  -- exactly is_dept_admin(), so it delegates — one definition, no drift. Callers unchanged.
  select public.is_dept_admin();
'
          AND (SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'is_announcer' AND p.prokind = 'f') = '
  select exists (
    select 1 from public.members
    where lower(email) = lower(auth.email())
      and status in (''Active'',''Probationary'')
      and department_id = public.my_department_id()   -- L-4: the role counts only in the caller''s own department
      and access && array[''Department Admin'',''Project Admin'',''Officer'']::text[]
  );
') THEN
    RAISE EXCEPTION 'ROLLBACK: the three helpers are not in the L-4 applied state. Refusing.';
  END IF;
CREATE OR REPLACE FUNCTION public.is_leadership()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from members
    where lower(members.email) = lower(auth.email())
      and members.status in ('Active','Probationary')
      and members.access && array['Project Admin','Department Admin','Board Member','Officer']::text[]
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_department_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from members
    where lower(members.email) = lower(auth.email())
      and members.status in ('Active','Probationary')
      and members.access && array['Department Admin','Project Admin']::text[]
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_announcer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.members
    where lower(email) = lower(auth.email())
      and status in ('Active','Probationary')
      and access && array['Department Admin','Project Admin','Officer']::text[]
  );
$function$
;

  FOR r IN SELECT * FROM (VALUES
      ('is_leadership', 'cc5861c24398fbf58147fee6f60cf410'),
      ('is_department_admin', '99570e1790f233594464da32436c8ca7'),
      ('is_announcer', 'eda2b1609930debb7b586ac5afba4779')) v(name, md5) LOOP
    IF (SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name AND p.prokind = 'f') IS DISTINCT FROM r.md5 OR (SELECT p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name AND p.prokind = 'f') IS DISTINCT FROM 'true|s|{search_path=public}|{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
      RAISE EXCEPTION 'ROLLBACK post-condition: %() is not back to its captured definition / ACL. Rolling back.', r.name;
    END IF;
  END LOOP;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
