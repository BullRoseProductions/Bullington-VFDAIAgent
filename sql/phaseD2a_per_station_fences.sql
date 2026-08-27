-- =====================================================================
-- PHASE D2a — PER-STATION FENCES, PINNING, AND ATTRIBUTION.
--
-- The web-provable half of D2. Everything per-station that can be built and
-- proven in a browser; the native multi-region registration and the on-device
-- testing are D2b.
--
-- WHAT THIS TURNS ON. Until now stations.lat/lng/radius_m/geofence_enabled were
-- written by Phase A's backfill and by pa_create_department, and read by NOTHING
-- — every geofence read went to departments.station_*. D2a makes the stations
-- columns the readers, which is why section 1 seeds them first: a department
-- that is fenced today (Granbury, Lipan) would otherwise lose its fence the
-- moment this lands, because its default house's copy is stale.
--
-- STATION SCOPING IS ATTRIBUTION AND VERIFICATION, NOT AN RLS BOUNDARY. Every
-- member may work at every house. Nothing here changes a policy. Untouched, and
-- verified untouched at the bottom of this file: my_department_id, my_member_id,
-- the is_* family, is_at_station, is_at_point, my_stations,
-- set_default_station_id, my_active_station_id, set_active_station.
--
-- THE HINT IS A HINT, NEVER AUTHORITY. p_station_id comes from a phone, and a
-- rooted device can name any station. Arm 1 validates it against the caller's
-- own department; arm 2 re-derives the house from the coordinates server-side;
-- arm 3 falls through to exactly today's behaviour. Every failure path degrades
-- safely rather than erroring.
--
-- DEPLOY GATE: apply BEFORE the client deploys. The pin editor writes
-- stations.lat/lng/radius_m and the client calls my_station_fences by name.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- The geofence_arrive assertions are the important ones. This file DROPs and
-- recreates that function, so it must be certain which body it is replacing:
-- the four-argument one, carrying the replay-dedup block that g4l1 added. If a
-- different body is live, the recreate would silently discard logic that exists
-- to stop every ordinary shift being double-counted on the next app open.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(array['lat','lng','radius_m','geofence_enabled','is_default','is_active']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='stations' AND column_name=c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'D2a precondition failed: stations is missing column(s): %. Apply sql/stations_phaseA.sql first.', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='station_presence' AND column_name='station_id') THEN
    RAISE EXCEPTION 'D2a precondition failed: station_presence.station_id is missing. Apply sql/stations_phaseB3.sql first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='is_at_point') THEN
    RAISE EXCEPTION 'D2a precondition failed: is_at_point() is missing. Both the resolver and the verifier call it.';
  END IF;

  -- geofence_arrive must be the FOUR-argument body, and the ONLY one, so the DROP
  -- below names the right signature and leaves no overload behind.
  --
  -- CHECKED ON pronargs, NOT on an exact pg_get_function_identity_arguments()
  -- string. That function INCLUDES PARAMETER NAMES — it returns
  -- 'p_lat double precision, p_lng double precision, ...', not a bare type list —
  -- so matching it against types alone can never be true and the precondition
  -- refuses a database that is in fact correct. It did exactly that on the first
  -- apply attempt.
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive') <> 1 THEN
    RAISE EXCEPTION 'D2a precondition failed: expected exactly one geofence_arrive(), found %. An overload must be resolved before this file can DROP the right one.',
      (SELECT count(*) FROM pg_proc
        WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive'
                    AND pronargs = 4) THEN
    -- The message prints the ACTUAL signature, so a mismatch is diagnosable from
    -- the error alone rather than needing a separate capture.
    RAISE EXCEPTION 'D2a precondition failed: geofence_arrive() does not take 4 arguments. Live signature is (%). Capture pg_get_functiondef before proceeding.',
      (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc
        WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive' LIMIT 1);
  END IF;

  -- ...and it must carry the replay-dedup block. Recreating without it would
  -- reintroduce the duplicate-shift bug g4l1 exists to fix.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive'
                    AND prosrc ILIKE '%checked_in_at between%'
                    AND prosrc ILIKE '%2 minutes%') THEN
    RAISE EXCEPTION 'D2a precondition failed: the live geofence_arrive() has no arrival-time replay-dedup block. This file reproduces that block; if it is absent the live body is not what D2a was written against.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='station_check_in'
                    AND prosrc ILIKE '%is_at_station%') THEN
    RAISE EXCEPTION 'D2a precondition failed: station_check_in() does not call is_at_station(). The live body is not what this file was written against.';
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. THE RESYNC — seed each default house from its department, and keep the
--    prior values so it can be undone.
--
-- WHY IT IS FIRST AND WHY IT IS NOT OPTIONAL. Sections 3 and 4 start reading
-- stations.lat/lng/radius_m/geofence_enabled. Those columns are a point-in-time
-- copy taken by Phase A's backfill (and by pa_create_department at creation) and
-- nothing has kept them in step since. Two live consequences without this:
--   • a department that moved its pin on the settings screen would start failing
--     verification for members standing at the corrected location;
--   • a department that switched geofencing on AFTER its backfill has
--     stations.geofence_enabled = false on its own default house, so the
--     per-house gate would switch its fence off.
--
-- THE BACKUP IS THE ROLLBACK. There is no way to re-derive the prior values once
-- they are overwritten, so they are captured first, in the same transaction.
-- ON CONFLICT DO NOTHING so that re-running this file preserves the ORIGINAL
-- capture rather than overwriting it with already-resynced values — the second
-- capture would be worthless as a rollback.
--
-- NON-DEFAULT HOUSES ARE LEFT ALONE. They have no department to copy from and
-- inventing coordinates would be worse than leaving them absent; they get pinned
-- through the editor in the client half of D2a.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public._d2a_resync_backup (
  station_id       uuid PRIMARY KEY,
  lat              double precision,
  lng              double precision,
  radius_m         integer,
  geofence_enabled boolean,
  captured_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public._d2a_resync_backup IS
  'Pre-D2a values of the DEFAULT stations geo columns, captured before the resync in sql/phaseD2a_per_station_fences.sql. Exists solely so section 1 can be undone. Not read by the app.';

/* A scratch table in `public` is PostgREST-visible by default. RLS on with no
   policies, plus the revoke, means no API caller can read it — this holds a
   department's coordinates and has no business being reachable. */
ALTER TABLE public._d2a_resync_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public._d2a_resync_backup FROM anon, authenticated, public;

INSERT INTO public._d2a_resync_backup (station_id, lat, lng, radius_m, geofence_enabled)
SELECT s.id, s.lat, s.lng, s.radius_m, s.geofence_enabled
  FROM public.stations s
 WHERE s.is_default
ON CONFLICT (station_id) DO NOTHING;

UPDATE public.stations s
   SET lat              = d.station_lat,
       lng              = d.station_lng,
       radius_m         = d.station_radius_m,
       geofence_enabled = coalesce(d.geofence_enabled, false)
  FROM public.departments d
 WHERE d.id = s.department_id
   AND s.is_default;

DO $report$
DECLARE v_n integer; v_fenced integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.stations WHERE is_default;
  SELECT count(*) INTO v_fenced FROM public.stations WHERE is_default AND geofence_enabled;
  RAISE NOTICE 'D2a resync: % default station(s) seeded from their department; % now geofence_enabled.', v_n, v_fenced;
END
$report$;


-- ---------------------------------------------------------------------
-- 2. my_station_fences() — the coordinates the client needs to register fences.
--
-- NEW FUNCTION RATHER THAN WIDENING my_stations(). my_stations() is the B1
-- picker's read and several screens call it; changing its return shape would
-- mean DROP + CREATE on all of them for the benefit of one caller. This is
-- additive and touches nothing.
--
-- SECURITY DEFINER AND NO PARAMETER, the property that makes the my_* family
-- safe: there is nothing to pass to make it answer for another department. It
-- can only ever return the stations of my_department_id().
--
-- ACTIVE STATIONS ONLY — a retired house should not be fenced. Note this differs
-- from my_stations(), which deliberately returns retired houses so the picker
-- can present them; a fence list has no equivalent reason to.
--
-- Rows with a null pin are still RETURNED, not filtered: the client needs to
-- know a house exists and is unpinned in order to say so, and filtering would
-- make an unconfigured house indistinguishable from one that is switched off.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_station_fences()
 RETURNS TABLE(
   station_id       uuid,
   name             text,
   lat              double precision,
   lng              double precision,
   radius_m         integer,
   geofence_enabled boolean,
   is_default       boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.my_member_id() is null then
    raise exception 'We could not match your login to a member record.';
  end if;

  return query
    select s.id, s.name, s.lat, s.lng, s.radius_m, s.geofence_enabled, s.is_default
      from stations s
     where s.department_id = public.my_department_id()
       and s.is_active
     order by s.is_default desc, s.name;
end;
$function$;

REVOKE ALL   ON FUNCTION public.my_station_fences() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.my_station_fences() TO authenticated;


-- ---------------------------------------------------------------------
-- 3. geofence_arrive() — attribute the arrival to the house that fired.
--
-- DROP + CREATE. Adding p_station_id OVERLOADS rather than replaces, and a
-- four-argument call would keep resolving to the old body — so the fix would
-- silently not land for exactly the caller it was written for. That is the
-- Phase C lesson; the grants are re-established below because DROP discards
-- them.
--
-- REPRODUCED FROM THE LIVE g4l1 BODY. The identity gate, the geofence_enabled
-- gate, the three clock guards, the already-open check and — above all — the
-- ARRIVAL-TIME REPLAY-DEDUP BLOCK are carried over unchanged. That block is what
-- stops the SDK's persisted queue double-recording every completed shift on the
-- next app open, and section 0 asserts it is really in the body being replaced.
--
-- THREE ADDITIONS, AND NOTHING ELSE:
--   (a) the p_station_id parameter
--   (b) the three-arm station resolution
--   (c) verification measured against the RESOLVED house when it has a pin
--
-- ARM 2 PASSES NULL FOR ACCURACY, DELIBERATELY. Arm 2 is ROUTING — which house
-- is this — not VERIFICATION — was the member really there. A fix too coarse to
-- prove presence is still perfectly good evidence of which building it is
-- nearest to. Letting accuracy veto the routing would push a genuine arrival to
-- arm 3 and attribute it to the default house, which is the very thing D2 exists
-- to stop. Verification runs separately, WITH accuracy, immediately below.
--
-- SINGLE-STATION NO-OP, mechanically: one station is the default, it is the only
-- pinned house, arm 1 or arm 2 resolves to it, its coordinates were seeded from
-- the department in section 1 so is_at_point(station) is the same computation on
-- the same numbers as today's is_at_point(department), and the B3 trigger would
-- have stamped that same station_id anyway. Identical row by construction.
-- ---------------------------------------------------------------------
DROP FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz);

CREATE FUNCTION public.geofence_arrive(
  p_lat        double precision,
  p_lng        double precision,
  p_accuracy   double precision DEFAULT NULL,
  p_at         timestamptz      DEFAULT NULL,
  p_station_id uuid             DEFAULT NULL
) RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member   uuid := public.my_member_id();
  v_dept     uuid := public.my_department_id();
  v_enabled  boolean;
  v_lat      double precision;   -- the DEPARTMENT pin, still the fallback
  v_lng      double precision;
  v_radius   integer;
  v_station  uuid;               -- the RESOLVED house, or null for arm 3
  v_slat     double precision;   -- that house's pin
  v_slng     double precision;
  v_srad     integer;
  v_verified boolean;
  v_at       timestamptz := coalesce(p_at, now());
  v_row      public.station_presence;
begin
  if v_member is null or v_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;

  select geofence_enabled, station_lat, station_lng, station_radius_m
    into v_enabled, v_lat, v_lng, v_radius
    from public.departments where id = v_dept;

  if not coalesce(v_enabled, false) then
    raise exception 'Automatic arrival is not switched on for your department.';
  end if;

  -- the device's clock is not ours to trust
  if v_at > now() + interval '5 minutes' then
    raise exception 'That arrival is timestamped in the future — check the device clock.';
  end if;
  if v_at > now() then
    v_at := now();                                  -- ordinary drift; clamp rather than refuse
  end if;
  if v_at < now() - interval '30 days' then
    raise exception 'That arrival is more than 30 days old and was not recorded.';
  end if;

  -- already on the clock? hand back that row. Never open a second session.
  select * into v_row from public.station_presence
   where member_id = v_member
     and checked_out_at is null
     and kind in ('standby','offsite')
   order by checked_in_at desc limit 1;
  if found then return v_row; end if;

  /* ALREADY RECORDED — OPEN OR CLOSED. Carried over from g4l1 unchanged; without
     it, replay duplicates every ordinary completed shift on the next app open and
     inflates exactly the hours ISO and LOSAP are counted from. Matching on
     ARRIVAL TIME is what makes a replayed event land on the row it already
     created. */
  select * into v_row from public.station_presence
   where member_id = v_member
     and source = 'gps_geofence'                     -- only rows this function created
     and kind in ('standby','offsite')
     and checked_in_at between v_at - interval '2 minutes' and v_at + interval '2 minutes'
   order by abs(extract(epoch from (checked_in_at - v_at)))   -- the closest match, not merely the newest
   limit 1;
  if found then return v_row; end if;

  /* ── D2a: WHICH HOUSE ──────────────────────────────────────────────────────
     ARM 1 — the phone's hint, validated. The department check is the security
     boundary: without it a device could attribute its arrival to any station row
     in the system, including another department's. */
  if p_station_id is not null then
    select s.id, s.lat, s.lng, s.radius_m
      into v_station, v_slat, v_slng, v_srad
      from stations s
     where s.id = p_station_id
       and s.department_id = v_dept
       and s.is_active;
  end if;

  /* ARM 2 — no usable hint, so re-derive it from the coordinates. The nearest
     active pinned house whose OWN radius contains the fix. Accuracy is not
     passed: see the header — this is routing, not verification. */
  if v_station is null and p_lat is not null and p_lng is not null then
    select s.id, s.lat, s.lng, s.radius_m
      into v_station, v_slat, v_slng, v_srad
      from stations s
     where s.department_id = v_dept
       and s.is_active
       and s.lat is not null
       and s.lng is not null
       and public.is_at_point(s.lat, s.lng, s.radius_m, p_lat, p_lng, null)
     order by 6371000 * 2 * asin(sqrt(
                power(sin(radians(p_lat - s.lat) / 2), 2)
                + cos(radians(s.lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - s.lng) / 2), 2)))
     limit 1;
  end if;

  /* ARM 3 — v_station stays null. The insert names station_id anyway, and
     set_default_station_id() only fills when NULL, so the row is stamped exactly
     as it is today. Nothing errors. */

  -- VERIFY against the resolved house when it carries a pin; otherwise the
  -- department, which is what the live body does for every arrival today.
  if v_station is not null and v_slat is not null and v_slng is not null then
    v_verified := public.is_at_point(v_slat, v_slng, v_srad, p_lat, p_lng, p_accuracy);
  else
    v_verified := public.is_at_point(v_lat, v_lng, v_radius, p_lat, p_lng, p_accuracy);
  end if;

  insert into public.station_presence
    (department_id, member_id, verified, source, kind, checked_in_at, station_id)
  values
    (v_dept, v_member, v_verified, 'gps_geofence', 'standby', v_at, v_station)
  returning * into v_row;

  return v_row;
end;
$function$;

-- DROP discarded the ACL. Restated on the FIVE-argument signature, from the LIVE
-- capture rather than from what g2/g4l1 wrote:
--
--   {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--
-- THREE entries, and the third is the one a DROP quietly costs you. This is the
-- same trap D1 hit on dept_shifts_needing_review: g2 and g4l1 only ever wrote a
-- REVOKE and one GRANT, and landed on an ACL containing service_role because
-- Supabase's default privileges grant it on creation. Relying on that default to
-- restore a privilege is not the same as restoring it — so it is explicit here.
-- Idempotent when the default holds, correct when it does not.
REVOKE ALL ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz, uuid)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz, uuid)
  TO service_role;


-- ---------------------------------------------------------------------
-- 4. station_check_in() — verify against the active house.
--
-- SAME 5-ARGUMENT SIGNATURE, so CREATE OR REPLACE is valid, the ACL is preserved
-- and there are deliberately NO grant lines here.
--
-- ONE CHANGE ONLY: what the coordinates are measured against. The identity gate,
-- the kind validation, the already-open check, the insert and the return are
-- carried over from the live body unchanged. station_id is still stamped by the
-- set_default_station_id trigger, which is not touched.
--
-- is_at_station() IS NOT TOUCHED, and that is the point of the fallback branch.
-- It is also member_check_in()'s training geo-verify; editing it would move
-- training verification, which is not D2a's business. Only this function's USE
-- of it changes — and only when the active house has a pin to use instead.
--
-- A HOUSE WITH NO PIN FALLS BACK rather than failing. Houses 2..N start life
-- unpinned (nothing ever set their coordinates), so without this branch every
-- check-in at a new house would verify false — punishing members for a
-- configuration their DA has not done yet.
--
-- ALL KINDS VERIFY AGAINST THE HOUSE, including p_kind='training'. Training held
-- AT a station is training at a particular house, and off-site training goes
-- through its own check-in path, not this one. Post-resync this is identical to
-- today for a single-station department. Flagged rather than assumed — say so if
-- training should stay department-level and it is a two-line change.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.station_check_in(
  p_lat        double precision DEFAULT NULL::double precision,
  p_lng        double precision DEFAULT NULL::double precision,
  p_accuracy   double precision DEFAULT NULL::double precision,
  p_kind       text             DEFAULT 'standby'::text,
  p_session_id uuid             DEFAULT NULL::uuid
)
 RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member   uuid := public.my_member_id();
  v_dept     uuid := public.my_department_id();
  v_station  uuid;
  v_slat     double precision;
  v_slng     double precision;
  v_srad     integer;
  v_verified boolean := false;
  v_row      public.station_presence;
begin
  if v_member is null or v_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  if p_kind not in ('training','standby','incident') then
    raise exception 'Invalid session type.';
  end if;
  select * into v_row from public.station_presence
    where member_id = v_member and checked_out_at is null
    order by checked_in_at desc limit 1;
  if found then return v_row; end if;

  -- D2a: measure against the house being viewed, when it has a pin.
  v_station := public.my_active_station_id();
  if v_station is not null then
    select s.lat, s.lng, s.radius_m into v_slat, v_slng, v_srad
      from stations s where s.id = v_station;
  end if;

  if v_slat is not null and v_slng is not null then
    v_verified := public.is_at_point(v_slat, v_slng, v_srad, p_lat, p_lng, p_accuracy);
  else
    v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);   -- unchanged fallback
  end if;

  insert into public.station_presence (department_id, member_id, verified, source, kind, session_id)
  values (v_dept, v_member, v_verified, 'geo', p_kind, p_session_id)
  returning * into v_row;
  return v_row;
end;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after). Every write below rolls back.
-- =====================================================================
--
-- -- 0. BASELINE — run BEFORE applying too, and diff. Must be IDENTICAL.
-- --   SELECT * FROM public.dept_iso_hours(date_trunc('year', now()), now());
-- --   SELECT count(*), sum(hours) FROM public.dept_station_shifts(date_trunc('year', now()), now());
--
-- -- 1. THE RESYNC. Every default house now carries its department's pin and
-- --    flag. Expect one row per department, mismatch=false everywhere, and
-- --    Granbury + Lipan showing geofence_enabled = true.
-- SELECT d.name, s.name AS house, s.lat, s.lng, s.radius_m, s.geofence_enabled,
--        (s.lat IS DISTINCT FROM d.station_lat
--         OR s.lng IS DISTINCT FROM d.station_lng
--         OR s.radius_m IS DISTINCT FROM d.station_radius_m) AS mismatch
--   FROM public.stations s JOIN public.departments d ON d.id = s.department_id
--  WHERE s.is_default ORDER BY d.name;
--
-- -- 1b. The rollback exists. Expect one row per default station.
-- SELECT count(*) AS backed_up FROM public._d2a_resync_backup;
--
-- -- 2. Signatures and grants. Expect geofence_arrive copies=1 with FIVE args
-- --    (no 4-arg overload left behind), anon=f / auth=t on both RPCs.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        count(*) OVER (PARTITION BY proname) AS copies,
--        prosecdef AS definer,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--        proacl::text AS acl
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('geofence_arrive','station_check_in','my_station_fences')
--  ORDER BY proname;
--
-- -- 3. THE DEDUP BLOCK SURVIVED THE RECREATE. This is the one that matters most
-- --    — losing it double-counts every shift. Expect dedup=t, resolves=t.
-- SELECT (prosrc ILIKE '%checked_in_at between%')  AS dedup,
--        (prosrc ILIKE '%p_station_id%')           AS resolves
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive';
--
-- -- 4. ARM 1 IS BOUNDED BY DEPARTMENT. Pass ANOTHER department's station id;
-- --    it must NOT be trusted — the row comes back attributed to a house of the
-- --    caller's own department (arm 2/3), never the foreign one.
-- --    Run signed in as a member of a geofenced department.
-- --   BEGIN;
-- --     SELECT station_id FROM public.geofence_arrive(
-- --       34.0, -84.0, 12, now(),
-- --       (SELECT s.id FROM public.stations s
-- --         WHERE s.department_id <> public.my_department_id() LIMIT 1));
-- --     -- expect: NOT the id passed in
-- --     SELECT sp.station_id, st.department_id = public.my_department_id() AS own_department
-- --       FROM public.station_presence sp LEFT JOIN public.stations st ON st.id = sp.station_id
-- --      WHERE sp.member_id = public.my_member_id() ORDER BY sp.checked_in_at DESC LIMIT 1;
-- --   ROLLBACK;
--
-- -- 5. ARM 2 RESOLVES FROM COORDINATES with no hint at all. Pin a second house
-- --    first (or use the editor), then arrive at its coordinates.
-- --    Expect station_id = that house.
-- --   BEGIN;
-- --     SELECT station_id FROM public.geofence_arrive(
-- --       (SELECT lat FROM public.stations WHERE department_id = public.my_department_id()
-- --          AND NOT is_default AND lat IS NOT NULL LIMIT 1),
-- --       (SELECT lng FROM public.stations WHERE department_id = public.my_department_id()
-- --          AND NOT is_default AND lng IS NOT NULL LIMIT 1),
-- --       12, now(), NULL);
-- --   ROLLBACK;
--
-- -- 6. SINGLE-STATION NO-OP: with one house, hint and no-hint give the same
-- --    station_id and the same verified.
-- --   BEGIN;
-- --     SELECT station_id, verified FROM public.geofence_arrive(34.0, -84.0, 12, now() - interval '1 hour', NULL);
-- --   ROLLBACK;
-- --   BEGIN;
-- --     SELECT station_id, verified FROM public.geofence_arrive(34.0, -84.0, 12, now() - interval '1 hour',
-- --       (SELECT id FROM public.stations WHERE department_id = public.my_department_id() AND is_default));
-- --   ROLLBACK;
--
-- -- 7. station_check_in falls back for an UNPINNED house rather than verifying
-- --    false. Point the active station at a pinless house, then check in.
-- --   BEGIN;
-- --     SELECT public.set_active_station(
-- --       (SELECT id FROM public.stations WHERE department_id = public.my_department_id()
-- --          AND lat IS NULL LIMIT 1));
-- --     SELECT verified FROM public.station_check_in(34.0, -84.0, 12, 'standby', NULL);
-- --   ROLLBACK;
--
-- -- 8. UNTOUCHED PROOF — diff each against its pre-apply capture.
-- SELECT pg_get_functiondef('public.is_at_station'::regproc);
-- SELECT pg_get_functiondef('public.is_at_point'::regproc);
-- SELECT pg_get_functiondef('public.my_stations'::regproc);
-- SELECT pg_get_functiondef('public.set_default_station_id'::regproc);
-- SELECT pg_get_functiondef('public.my_active_station_id'::regproc);
-- SELECT pg_get_functiondef('public.set_active_station'::regproc);
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
-- SELECT pg_get_functiondef('public.geofence_depart'::regproc);
-- SELECT pg_get_functiondef('public.auto_close_stale_shifts'::regproc);
--
-- ---------- ROLLBACK OF SECTION 1, if ever needed ----------
-- --   UPDATE public.stations s
-- --      SET lat = b.lat, lng = b.lng, radius_m = b.radius_m, geofence_enabled = b.geofence_enabled
-- --     FROM public._d2a_resync_backup b WHERE b.station_id = s.id;
