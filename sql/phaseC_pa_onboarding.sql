-- =====================================================================
-- PHASE C — onboarding completeness: PA-side roster, and a department that is
-- BORN with its default house.
--
-- THREE CHANGES, ONE MIGRATION:
--   1. pa_department_members()  — read a department's roster as a PA (new)
--   2. pa_add_member()          — add a member to a department as a PA (new)
--   3. pa_create_department()   — + p_address, and it now creates the default
--                                 station row (EDIT — see the section header)
--
-- WHY 1 AND 2 EXIST. A Project Admin is not a member of the departments they
-- administer, so the members RLS correctly refuses their reads and writes there.
-- Until now the workaround was hand-INSERTing roster rows in the Supabase
-- console. These replace that the same way pa_add_station replaced hand-adding
-- stations: a narrow, gated function instead of a console.
--
-- is_project_admin() IS THE WHOLE SECURITY BOUNDARY on both, as on every pa_*
-- function. Both are SECURITY DEFINER and reach across departments by design —
-- that is the point, since the caller is deliberately not a member. Without the
-- gate, any authenticated user could read or write the roster of any department
-- in the system. It is not validation; it is the authorization.
--
-- ACCESS IS NOT RANK, and the two must not be confused:
--   members.role   — free-text RANK ("Firefighter", "Captain"). A plain text
--                    input in the app. There is no allowed set, so none is
--                    enforced here.
--   members.access — the PERMISSION array, and a CLOSED set. Validated below
--                    against the same four values as shared/roles.js:32
--                    (GRANTABLE_ROLES). Project Admin is deliberately absent
--                    there and absent here: it is not grantable from a roster.
-- Writing 'Member' into role instead of access would produce a member with a
-- rank of "Member" and no permissions at all.
--
-- DEPLOY GATE: apply BEFORE the client deploys — the PA screen calls all three
-- by name and PostgREST answers 404 for a function it has not seen.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='is_project_admin') THEN
    RAISE EXCEPTION 'Precondition failed: is_project_admin() is missing. It is the security boundary for every function in this file.';
  END IF;

  -- access must really be text[]; the RETURNS TABLE below and the array
  -- validation both depend on it.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='members'
                    AND column_name='access' AND data_type='ARRAY') THEN
    RAISE EXCEPTION 'Precondition failed: members.access is not an array type.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='stations'
                    AND column_name='address') THEN
    RAISE EXCEPTION 'Precondition failed: stations.address is missing. Apply sql/stations_phaseA.sql first.';
  END IF;

  -- The departments columns section 3's station insert copies FROM — the same
  -- five Phase A's backfill read (sql/stations_phaseA.sql:61). Asserted here
  -- because a plpgsql BODY IS NOT CATALOG-CHECKED AT CREATE TIME: a missing
  -- column would let this migration commit clean and then fail the first time a
  -- PA actually creates a department, which is the worst place to find out.
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(array['station','station_lat','station_lng','station_radius_m','geofence_enabled']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='departments' AND column_name=c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: departments is missing column(s): %. pa_create_department() copies from these to build the default station — check the real names before re-running.', v_missing;
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. pa_department_members() — the roster, for a department the caller is
--    not in.
--
-- Mirrored from pa_members_missing_email() in sql/pa_support_actions.sql: same
-- plpgsql / STABLE SECURITY DEFINER / search_path shape, same gate-first body,
-- same (member_id, name, access, status) core with the columns the PA list also
-- needs. STABLE, not VOLATILE — it only reads.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_department_members(p_department_id uuid)
 RETURNS TABLE(member_id uuid, name text, role text, access text[], status text, email text, phone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  return query
    select m.id, m.name, m.role, m.access, m.status, m.email, m.phone
    from members m
    where m.department_id = p_department_id
    order by m.role nulls last, m.name asc;
end;
$function$;


-- ---------------------------------------------------------------------
-- 2. pa_add_member() — add one member to a department the caller is not in.
--
-- THE ROW MUST BE INDISTINGUISHABLE from the one the in-app add-member path
-- writes (src/App.jsx:8446). Every default below is copied from that line
-- rather than chosen here:
--     role         nullif(trim) — the form sends `rl.trim() || null`
--     access       defaults to {Member} when empty — `ax.length ? ax : ["Member"]`
--     status       'Active'     — the form's initial state
--     phone        '—'          — the form sends `ph.trim() || "—"`, an EM DASH,
--                                 not null and not '', because the roster renders it
--     mentor_id    null         — `mt || null`, and there is no PA-side mentor picker
--     joined       as passed    — a 4-CHAR YEAR string (`sdate.slice(0,4)`), not a date
--     participation 0           — set explicitly by the form
--
-- password_set IS DELIBERATELY NOT NAMED, exactly as the in-app path does not
-- name it. sql/members_password_set.sql says why: the column defaults false, and
-- that default is what puts every newly onboarded member through the
-- set-password screen on first sign-in. Naming it here — even as false — would
-- couple this function to a gate it has no business restating.
--
-- NO member_private WRITE. The in-app path follows its insert with a
-- member_private upsert for birthday/address/start date. That is a separate
-- table with its own policy and its own form; a PA seeding a roster does not
-- have those details, and writing empty rows there would be noise. Those are
-- filled in from the member's own file, as they are today.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_add_member(
  p_department_id uuid,
  p_name          text,
  p_email         text,
  p_access        text[] DEFAULT array['Member']::text[],
  p_role          text   DEFAULT NULL,
  p_phone         text   DEFAULT NULL,
  p_status        text   DEFAULT 'Active',
  p_joined        text   DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name   text   := btrim(coalesce(p_name, ''));
  v_email  text   := lower(btrim(coalesce(p_email, '')));
  v_access text[] := CASE WHEN p_access IS NULL OR cardinality(p_access) = 0
                          THEN array['Member']::text[] ELSE p_access END;
  v_bad    text;
  v_id     uuid;
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  if not exists (select 1 from departments d where d.id = p_department_id) then
    raise exception 'Department not found';
  end if;

  if v_name = '' then
    raise exception 'Give the member a name.';
  end if;

  -- Same rule, same regex, as pa_set_member_email() and the in-app form. A
  -- member with no valid email can never sign in, and email is how a login is
  -- matched to this row — so a bad one is not a cosmetic problem.
  if v_email = '' or v_email !~ '^\S+@\S+\.\S+$' then
    raise exception 'A valid email is required so this member can sign in.';
  end if;

  -- ACCESS is closed; RANK is not checked at all. See the header.
  select string_agg(x, ', ') into v_bad
    from unnest(v_access) x
   where x not in ('Member', 'Officer', 'Board Member', 'Department Admin');
  if v_bad is not null then
    raise exception 'Unknown access level: %', v_bad;
  end if;

  -- Duplicate guard, scoped to THIS DEPARTMENT because that is what the members
  -- email index enforces since Phase 1b: unique on (lower(email), department_id).
  -- Two departments may legitimately both have the same volunteer; the same
  -- roster twice is the error.
  if exists (select 1 from members m
              where m.department_id = p_department_id
                and lower(btrim(coalesce(m.email, ''))) = v_email) then
    raise exception 'That email is already on this roster.';
  end if;

  insert into members (department_id, name, role, access, status, phone, email, mentor_id, joined, participation)
  values (p_department_id,
          v_name,
          nullif(btrim(coalesce(p_role, '')), ''),
          v_access,
          coalesce(nullif(btrim(coalesce(p_status, '')), ''), 'Active'),
          coalesce(nullif(btrim(coalesce(p_phone,  '')), ''), '—'),
          v_email,
          null,
          nullif(btrim(coalesce(p_joined, '')), ''),
          0)
  returning id into v_id;

  return v_id;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. pa_create_department() — a department is now BORN with its default house.
--
-- THE GAP THIS CLOSES. Phase A's station backfill was one-time
-- (sql/stations_phaseA.sql:171, `WHERE NOT EXISTS`), nothing creates a stations
-- row on a trigger, and this function only ever inserted departments + members.
-- So every department created after Phase A would have had NO station at all:
-- my_active_station_id() null, set_default_station_id() arm 2 finding no
-- default, and therefore NULL station_id stamped on every apparatus, equipment,
-- duty, station_log and station_presence row it ever recorded. The live
-- diagnostic came back clean (all 5 departments at exactly one default), so
-- there is nothing to heal — THERE IS DELIBERATELY NO BACKFILL IN THIS FILE.
-- This is the fix landing forward.
--
-- WHY DROP + CREATE AND NOT CREATE OR REPLACE. Adding a parameter does not
-- replace a function — it OVERLOADS it. Both pa_create_department(text x5) and
-- (text x6) would exist, and a five-argument call resolves to the OLD one,
-- which creates no station. The fix would silently not land for exactly the
-- callers it was written for. DROP discards grants, so they are re-established
-- in section 4 — same lesson as Phase 2b.
--
-- After the drop there is ONE function. A caller passing the original five
-- named arguments now resolves to this one with p_address defaulting to NULL,
-- so old callers keep working AND get their default station. That is the whole
-- point of the trailing default.
--
-- BYTE-IDENTICAL, DELIBERATELY: the gate, all four validations, the GLOBAL
-- duplicate-email check, the departments insert, and above all the FIRST
-- DEPARTMENT ADMIN insert are copied from the live body unchanged. The only
-- additions are the p_address parameter and the stations insert.
--
-- THE STATION ROW IS SHAPE-IDENTICAL TO A BACKFILLED ONE. It reads the same
-- source columns Phase A read, from the department row just inserted, in the
-- same order: name from the same CASE over station ('Main Station' when blank),
-- lat/lng/radius_m/geofence_enabled straight off the department. `label` is left
-- NULL because Phase A's backfill never set one — a department created today
-- and a department backfilled in Phase A should be indistinguishable apart from
-- the address this call can now carry.
-- ---------------------------------------------------------------------
DROP FUNCTION public.pa_create_department(text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.pa_create_department(p_name text, p_station text, p_city text, p_admin_name text, p_admin_email text, p_address text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_aname   text := btrim(coalesce(p_admin_name, ''));
  v_email   text := lower(btrim(coalesce(p_admin_email, '')));
  v_dept_id uuid;
begin
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;
  if v_name  = '' then raise exception 'Department name is required'; end if;
  if v_aname = '' then raise exception 'Admin name is required';      end if;
  if v_email = '' or v_email !~ '^\S+@\S+\.\S+$' then
    raise exception 'A valid admin email is required';
  end if;
  if exists (select 1 from members where lower(email) = v_email) then
    raise exception 'A member with the email % already exists', v_email;
  end if;
  insert into departments (name, station, city)
  values (v_name,
          nullif(btrim(coalesce(p_station, '')), ''),
          nullif(btrim(coalesce(p_city, '')),    ''))
  returning id into v_dept_id;
  -- NEW: the department's default house. Column-for-column as Phase A's backfill
  -- built one, reading the same department columns, plus the address.
  insert into stations (department_id, name, address, lat, lng, radius_m, geofence_enabled, is_default, is_active)
  select d.id,
         case when d.station is not null and btrim(d.station) <> ''
              then btrim(d.station) else 'Main Station' end,
         nullif(btrim(coalesce(p_address, '')), ''),
         d.station_lat,
         d.station_lng,
         d.station_radius_m,
         coalesce(d.geofence_enabled, false),
         true,
         true
    from departments d
   where d.id = v_dept_id;
  insert into members (department_id, name, email, access, status, phone, participation)
  values (v_dept_id, v_aname, v_email, array['Department Admin']::text[], 'Active', '—', 0);
  return v_dept_id;
end;
$function$;


-- ---------------------------------------------------------------------
-- 4. Grants. Postgres default-grants EXECUTE to PUBLIC and anon inherits
-- through it, so revoke both and grant authenticated back — the pattern from
-- sql/revoke_anon_execute_sweep.sql and pa_add_station. The is_project_admin()
-- check inside each function is what actually gates it; the grant just keeps an
-- unauthenticated caller from reaching the body at all.
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.pa_department_members(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_department_members(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.pa_add_member(uuid, text, text, text[], text, text, text, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_add_member(uuid, text, text, text[], text, text, text, text) TO authenticated;
-- pa_create_department was DROPPED above, which discarded its grants. Re-establish
-- them on the NEW six-argument signature. Without this the PA screen would call a
-- function it has no EXECUTE on. (sql/revoke_anon_execute_sweep.sql:47 still names
-- the old five-argument signature; that file is historical and is not re-run.)
REVOKE EXECUTE ON FUNCTION public.pa_create_department(text, text, text, text, text, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.pa_create_department(text, text, text, text, text, text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only except the probes, which roll back.
-- =====================================================================
--
-- -- 1. Both exist, SECURITY DEFINER, anon locked out.
-- --    Expect 2 rows; definer=t, anon_exec=f, auth_exec=t; vol 's' then 'v'.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        prosecdef AS definer, provolatile AS vol,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('pa_department_members','pa_add_member')
--  ORDER BY proname;
--
-- -- 2. THE GATE IS REALLY IN EACH BODY, and pa_add_member does not name
-- --    password_set. Expect gated=t on both, names_password_set=f.
-- SELECT proname,
--        (prosrc ILIKE '%is_project_admin()%') AS gated,
--        (prosrc ILIKE '%password_set%')       AS names_password_set
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('pa_department_members','pa_add_member')
--  ORDER BY proname;
--
-- -- 3. THE PROBES. Run as postgres in this editor, where is_project_admin() is
-- --    false, so BOTH must RAISE 'Not authorized'. That error is the PASS.
-- --   SELECT * FROM public.pa_department_members(
-- --     (SELECT id FROM public.departments ORDER BY name LIMIT 1));
-- --   BEGIN;
-- --     SELECT public.pa_add_member(
-- --       (SELECT id FROM public.departments ORDER BY name LIMIT 1),
-- --       'ZZ Probe', 'zz.probe@example.com');
-- --   ROLLBACK;
--
-- -- 4. The roster is unchanged by merely creating these functions.
-- --    Compare to the same figures taken before applying.
-- SELECT count(*) AS members, count(*) FILTER (WHERE password_set) AS password_set_true
--   FROM public.members;
--
-- -- 4b. pa_create_department: EXACTLY ONE, six args, no overload left behind,
-- --     grants re-established after the DROP, and the station insert is really
-- --     in the body while the admin insert is untouched.
-- --     Expect 1 row; args ending `p_address text DEFAULT NULL`;
-- --     anon_exec=f, auth_exec=t, makes_station=t, admin_insert=t, gated=t.
-- SELECT count(*) OVER () AS how_many,
--        pg_get_function_arguments(oid) AS args,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--        (prosrc ILIKE '%insert into stations%')                  AS makes_station,
--        (prosrc ILIKE '%array[''Department Admin'']%')           AS admin_insert,
--        (prosrc ILIKE '%is_project_admin()%')                    AS gated
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='pa_create_department';
--
-- -- 4c. THE REAL PROOF, rolled back: creating a department now yields a default
-- --     station AND the first admin. Run as postgres -> is_project_admin() is
-- --     false -> it RAISES 'Not authorized', which is itself the gate passing.
-- --     To prove the station, run it SIGNED IN AS A PA instead (check 3 below).
-- --   BEGIN;
-- --     SELECT public.pa_create_department('ZZ Probe FD','Station 9','Nowhere',
-- --            'ZZ Admin','zz.admin@example.com','1 Probe Way');
-- --   ROLLBACK;
--
-- -- 4d. Still exactly one default station per department, none missing.
-- --     Expect no rows.
-- SELECT d.name, count(s.id) AS stations, count(*) FILTER (WHERE s.is_default) AS defaults
--   FROM public.departments d LEFT JOIN public.stations s ON s.department_id = d.id
--  GROUP BY d.name HAVING count(s.id) = 0 OR count(*) FILTER (WHERE s.is_default) <> 1;
--
-- -- 5. UNTOUCHED PROOF — this file creates none of these.
-- SELECT pg_get_functiondef('public.pa_add_station'::regproc);
-- SELECT pg_get_functiondef('public.pa_set_member_email'::regproc);
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
--
-- ---------- SIGNED IN ----------
-- -- 6.  PA, on a department you are NOT a member of: the roster lists its
-- --     members; add one (name/email/access) and they appear in that
-- --     department's own Roster screen.
-- -- 7.  Add the SAME email again -> refused with "already on this roster",
-- --     and no second row is written.
-- -- 8.  The new member's first sign-in goes through the set-password screen —
-- --     proof password_set defaulted false rather than being set here.
-- -- 9.  A NON-PA calling either RPC directly -> 'Not authorized'.
