-- =====================================================================
-- 2.2 GEOFENCE BATCH — stop late-delivered arrivals double-crediting hours,
-- and stop the departure path capping fenced shifts at the wrong number.
--
-- TWO FIXES, ONE FILE, because they are the same incident seen from both ends:
-- a fence that flaps at its boundary produces extra events, and both functions
-- mishandle them — one by inserting a duplicate shift, the other by trimming a
-- real one.
--
-- ---------------------------------------------------------------------
-- FIX 1 — geofence_arrive: reject an arrival already covered by a shift.
--
-- WHAT HAPPENED. Measured 2026-09-01 across all departments: 2.74 credited
-- hours sat inside overlapping station_presence rows, in 3 pairs across 2
-- members. Every pair involved a gps_geofence row; none was two manual rows.
--
-- Jeff Harper, Indian Harbor, 2026-08-31 — the clearest case, and the one this
-- guard is written against:
--
--   d45cee11  created 19:24:44  checked_in 19:22:44 -> 20:02:13   0.66h
--   9ba2248a  created 20:40:30  checked_in 19:31:30 -> 20:02:13   0.51h
--
-- The second row was WRITTEN AT 20:40 — 69 minutes after its own claimed
-- arrival, and 38 minutes after the shift it landed inside had already closed.
-- Both closed at 20:02:13.030, the same millisecond, from one EXIT event.
--
-- WHY THE EXISTING GUARDS MISSED IT. Two already stand in this function:
--   1. "already on the clock?" returns the OPEN row — but by 20:40 the first
--      row was closed, so there was nothing open to return.
--   2. a +/- 2 MINUTE arrival-time window catches a redelivery of the SAME
--      event. These were not redeliveries: the fence fired a SECOND, genuine
--      DWELL minutes after the first. Observed gaps were 8m46s (Jeff), 4m05s
--      and 2m03s (Matt Hohon, Granbury) — every one outside the window.
--
-- WIDENING THE WINDOW IS NOT THE FIX. Nine minutes of slack would start
-- rejecting real re-entries. Containment is exact instead, and it catches all
-- three observed cases:
--
--   Jeff    19:31:30 inside [19:22:44, 20:02:13]
--   Matt-1  14:12:57 inside [14:08:52, 15:51:15]
--   Matt-2  20:57:59 inside [20:55:56, 21:33:28]
--
-- IT CANNOT SWALLOW A REAL RE-ENTRY, by construction. A genuine return happens
-- AFTER the previous shift closed, so it falls outside every recorded range.
-- Only an arrival landing INSIDE a period already on the books is refused, and
-- that is never a new arrival. The retest proves this case explicitly.
--
-- ---------------------------------------------------------------------
-- FIX 2 — geofence_depart: use the cap that matches the source.
--
-- D1 deliberately raised auto_close_stale_shifts' ceiling for fenced shifts to
-- the backstop, so the sweeper would stop cutting a fenced shift short before
-- the phone's real EXIT could arrive. geofence_depart then capped that same
-- shift at max_shift_hours the moment the EXIT did arrive — so a fenced shift
-- had two different maximum lengths depending on which path closed it, and the
-- phone reporting CORRECTLY produced the shorter one.
--
--   Matt Hohon, Granbury, 2026-08-30. max_shift_hours 10, backstop null -> 36.
--   Phone reported EXIT 11.2h after arrival. Capped to exactly 10.000h and
--   flagged. Had the phone stayed silent the sweeper would have allowed 36h.
--   He lost 1.2 hours because it worked.
--
-- ---------------------------------------------------------------------
-- BOTH ARE CREATE OR REPLACE. Neither signature changes — arrive stays at five
-- arguments, depart at two — so the ACL survives. Grants are restated anyway:
-- a DROP+CREATE has silently stripped service_role twice in this codebase, and
-- stating them costs nothing.
--
-- NEITHER TOUCHES verified. geofence_arrive sets it once at insert, from the
-- position fix, exactly as today. geofence_depart never names it — the latch
-- migration asserts that against prosrc, and prosrc contains comments, so the
-- column name is kept out of that body entirely.
--
-- RETEST: sql/geofence_replay_guard_and_cap_RETEST.sql. Run it after applying.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert the live bodies are the ones this was written
--    against. Both were captured 2026-09-01/02 via pg_get_functiondef.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  -- ---- geofence_arrive ----
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive') <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: expected exactly one geofence_arrive.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive'
                    AND pronargs = 5) THEN
    RAISE EXCEPTION 'Precondition failed: geofence_arrive is not the 5-argument form. Re-capture.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive'
                    AND prosrc LIKE '%already on the clock? hand back that row%'
                    AND prosrc LIKE '%ALREADY RECORDED — OPEN OR CLOSED%'
                    AND prosrc LIKE '%ARM 3%') THEN
    RAISE EXCEPTION 'Precondition failed: geofence_arrive body is not the one captured 2026-09-02. Re-capture before applying.';
  END IF;
  -- Refuse to apply twice: the new guard would otherwise be added a second time.
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive'
                AND prosrc LIKE '%ALREADY COVERED BY A RECORDED SHIFT%') THEN
    RAISE EXCEPTION 'Precondition failed: geofence_arrive already carries the containment guard. Nothing to do.';
  END IF;

  -- ---- geofence_depart ----
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname='geofence_depart') <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: expected exactly one geofence_depart.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_depart'
                    AND pronargs = 2) THEN
    RAISE EXCEPTION 'Precondition failed: geofence_depart is not the 2-argument form. Apply the manual-close migration first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_depart'
                    AND prosrc LIKE '%ONLY what the daemon opened%'
                    AND prosrc LIKE '%select max_shift_hours into v_cap%') THEN
    RAISE EXCEPTION 'Precondition failed: geofence_depart body is not the one captured 2026-09-02, or the cap has already been changed.';
  END IF;
  /* THE LATCH PREMISE, CHECKED STRUCTURALLY RATHER THAN BY NAME.

     The obvious assertion — prosrc must not ILIKE-match the verdict column's name — is what the
     latch migration itself uses, and it is wrong in a way that has already bitten. prosrc CONTAINS
     COMMENTS, and the deployed geofence_depart mentions that column three times in prose while
     never writing it. So the name-based check reports a violation that does not exist, and the
     latch migration would raise a false failure today if anyone re-ran it.

     THIS FILE REPAIRS THAT as a side effect: the body installed below keeps the token out entirely,
     comments and file paths included, so the latch migration's own precondition starts passing
     again for the right reason.

     What actually matters is that departure WRITES only three columns. Assert that instead — it is
     the property the latch depends on, and unlike a name match it cannot be tripped by a comment. */
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_depart'
                    AND prosrc LIKE '%set checked_out_at = v_at,%'
                    AND prosrc LIKE '%auto_closed    = v_auto,%'
                    AND prosrc LIKE '%fence_exit_at  = case when v_auto then v_raw else fence_exit_at end%') THEN
    RAISE EXCEPTION 'Precondition failed: geofence_depart''s update no longer sets exactly checked_out_at, auto_closed and fence_exit_at. Read the body before replacing it.';
  END IF;

  RAISE NOTICE 'Pre-flight OK — both bodies match the 2026-09-02 capture; neither fix is already present.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. geofence_arrive — everything verbatim except the ONE added guard,
--    which sits AFTER the existing +/- 2 minute check. That check stays: it
--    still catches a duplicate arriving slightly BEFORE an existing row's
--    start, which containment cannot see.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geofence_arrive(
  p_lat        double precision,
  p_lng        double precision,
  p_accuracy   double precision DEFAULT NULL::double precision,
  p_at         timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_station_id uuid DEFAULT NULL::uuid
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

  /* ALREADY COVERED BY A RECORDED SHIFT — the guard the two above could not be.

     The first returns an OPEN row; by the time a late event lands the row is
     usually closed. The second catches a redelivery of the SAME event within two
     minutes. What actually cost hours was neither: a fence flapping at its
     boundary fired a SECOND, GENUINE DWELL minutes after the first, and that
     event was delivered late — 69 minutes late on 2026-08-31, landing 38 minutes
     after the shift it fell inside had already closed. Observed arrival gaps were
     8m46s, 4m05s and 2m03s; all three sailed past the two-minute window and each
     inserted a row covering time already credited.

     CONTAINMENT, NOT A WIDER WINDOW. Nine minutes of slack would begin rejecting
     real re-entries. An arrival that falls INSIDE a shift already on the books is,
     by definition, a re-trigger of presence already recorded. A genuine return
     happens AFTER the previous shift closed and therefore lands outside every
     range — so this cannot swallow one.

     NOT RESTRICTED BY SOURCE, unlike the guard above it. A late fence arrival
     landing inside a MANUAL shift double-counts identically, and the "already on
     the clock" guard is source-agnostic for exactly that reason.

     RETURNS THE COVERING ROW rather than raising: the same contract as the two
     guards above, and the caller reads a returned row as "you are on the clock",
     which is true. */
  select * into v_row from public.station_presence
   where member_id = v_member
     and kind in ('standby','offsite')
     and tstzrange(checked_in_at, coalesce(checked_out_at, 'infinity')) @> v_at
   order by checked_in_at desc limit 1;
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


-- ---------------------------------------------------------------------
-- 2. geofence_depart — verbatim except the cap selection.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geofence_depart(
  p_at         timestamptz DEFAULT NULL,
  p_station_id uuid        DEFAULT NULL
) RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member uuid := public.my_member_id();
  v_raw    timestamptz := coalesce(p_at, now());   -- the phone's reading, kept
  v_at     timestamptz;
  v_cap    integer;
  v_limit  timestamptz;
  v_auto   boolean := false;
  v_row    public.station_presence;
begin
  if v_member is null then
    raise exception 'We could not match your login to a member record.';
  end if;

  if v_raw > now() then
    v_raw := now();                                 -- device clock drift
  end if;
  v_at := v_raw;

  -- ================= SELECTION — two separate blocks, never merged ==========
  if p_station_id is null then
    /* LEGACY BRANCH — an un-updated client, or any caller with no fence station.
       This selection is character-for-character the captured pre-change one:
       gps_geofence only, no station filter, no manual arm. It exists so the
       installed base keeps checking out exactly as it does today. Do not
       "tidy" it toward the branch below; the whole point is that it is the old
       behaviour and can be diffed against the capture. */
    select * into v_row from public.station_presence
     where member_id = v_member
       and checked_out_at is null                   -- never re-close an auto_closed row
       and source = 'gps_geofence'                  -- ONLY what the daemon opened
       and kind in ('standby','offsite')
     order by checked_in_at desc limit 1;
  else
    /* STATION-SCOPED BRANCH — a build that knows which fence fired.

       STATION SCOPE IS ABSOLUTE: no `station_id is null` escape hatch. A replayed
       or duplicated EXIT for one house must not reach a shift at another, which
       is precisely the Aug 28 failure — a queued EXIT applied twice, closing a
       second shift and leaving a zero-length auto_closed row. Asserted at apply
       time that no open row lacks a station, so nothing is stranded by this.

       ITS PRECISION LIMIT, so nobody over-trusts it: station_presence.station_id
       is stamped by trg_station_id_station_presence from my_active_station_id(),
       i.e. the house the member had SELECTED, falling back to the department
       default. A member whose picker sits on Station 1 who clocks in at Station 2
       has a Station 1 row. Scoping is still right — it bounds the damage a stray
       event can do — but it is not proof of where anyone physically stood.

       kind = 'standby' ON THE MANUAL ARM ONLY, and the asymmetry is deliberate:

         'incident'  EXCLUDED. An incident shift legitimately leaves the station —
                     that IS the call. Closing it on fence exit would cut real
                     hours from the people who responded.
         'offsite'   daemon arm only. An off-site shift is by definition not at
                     this station, so a station fence says nothing about it; the
                     daemon arm keeps it because that is today's behaviour and
                     removing it is not this file's job.
         'training'  never matched. It shares source 'geo' with manual standby
                     and is separated only by kind, so this clause is the whole
                     guard — source alone would sweep up a member's open
                     training check-in. */
    select * into v_row from public.station_presence
     where member_id = v_member
       and checked_out_at is null
       and station_id = p_station_id
       and (    (source = 'gps_geofence' and kind in ('standby','offsite'))
             or (source = 'geo'          and kind = 'standby') )
     order by checked_in_at desc limit 1;
  end if;

  if not found then
    /* THE SWEEPER GOT HERE FIRST. Before this, the phone's real departure was
       simply dropped on the floor. Now it is recorded as provenance so the
       review screen can show the officer what the fence actually saw — while
       the credited number stays exactly where the machine put it, and the
       decision stays with the human.

       UNCHANGED, AND STILL gps_geofence-ONLY. A manual row the sweeper already
       capped gets no fence provenance. That is a named gap, not an oversight:
       widening it would mean writing to rows this file otherwise never touches,
       and it wants its own review. */
    select * into v_row from public.station_presence
     where member_id = v_member
       and source = 'gps_geofence'
       and kind in ('standby','offsite')
       and auto_closed
       and fence_exit_at is null
       and checked_out_at is not null
       and checked_in_at > now() - interval '2 days'
       and v_raw > checked_in_at
     order by checked_in_at desc limit 1;

    if not found then
      return null;                                  -- nothing of ours; not an error
    end if;

    update public.station_presence
       set fence_exit_at = v_raw                    -- and NOTHING else
     where id = v_row.id
    returning * into v_row;

    return v_row;
  end if;

  -- ================= STAMPING — shared by both branches =====================
  /* THE CAP NOW MATCHES THE SOURCE, which is the second fix in this file.

     auto_close_stale_shifts uses the fenced backstop for a gps_geofence row and
     max_shift_hours for everything else. This function used max_shift_hours for
     BOTH — so a fenced shift had two different maximum lengths depending on which
     path closed it, and the phone reporting correctly produced the shorter one.

     Matt Hohon, Granbury, 2026-08-30: max_shift_hours 10, backstop null -> 36.
     The phone reported its EXIT 11.2h after arrival, so this capped the shift at
     exactly 10.000h and flagged it. Had the phone stayed silent the sweeper would
     have allowed 36h. The expression below is character-for-character the
     sweeper's, so the two cannot drift again. */
  select case when v_row.source = 'gps_geofence'
              then greatest(coalesce(geofence_backstop_hours, 36), max_shift_hours)
              else max_shift_hours
         end
    into v_cap
    from public.departments where id = v_row.department_id;
  v_limit := v_row.checked_in_at + make_interval(hours => coalesce(v_cap, 10));

  /* ZERO-LENGTH / BACKWARDS GUARD — applies to BOTH branches, and this is the
     one place the legacy branch is NOT identical to the captured body.

     The old code turned a departure that predates its own arrival into
     checked_out_at = checked_in_at with auto_closed = true: a zero-length
     flagged shift. That is what a replayed EXIT produced on 2026-08-28 — the
     same event applied twice, the second landing on a row it had already
     closed. A zero-length row is not evidence of anything; it credits nothing,
     it tells the reviewer nothing, and it destroys the open row that a later,
     real EXIT could have closed properly.

     So: no-op. Return null, change nothing, leave the shift open for the real
     departure or for the sweeper. Kept in the legacy branch deliberately —
     preserving a known bug for the installed base would buy nothing. */
  if v_at <= v_row.checked_in_at then
    return null;
  end if;

  /* A MANUAL ROW CLOSED BY THE FENCE IS ALWAYS FLAGGED. The member opened this
     shift deliberately, so the end time is a machine's opinion about someone
     else's intent — an officer may well need to correct it. Routing it to the
     review screen is the point, not a side effect. Daemon rows keep today's
     rule: flagged only when the recorded time is not what the phone said. */
  v_auto := (v_row.source = 'geo');

  if v_at > v_limit then
    -- longer than the department allows: cap it and hand it to a human
    v_at   := v_limit;
    v_auto := true;
  end if;

  /* THE ARRIVAL VERDICT IS NOT TOUCHED, on either path. It is a one-way latch
     (see the latch migration in sql/, named for that column) describing whether
     ARRIVAL was confirmed on station; a manual arrival was never confirmed by
     the fence, and closing the shift later cannot change what was true at the
     start.

     THAT COLUMN'S NAME IS DELIBERATELY ABSENT FROM THIS BODY, comments and file
     references included. The latch migration asserts that geofence_depart's
     prosrc does not ILIKE-match that name — and prosrc CONTAINS COMMENTS, so
     merely writing it here, even inside a path, would make that precondition
     raise a false failure on its next run. The assertion cannot tell a mention
     from a write; keeping the token out is what keeps the assertion working. */
  update public.station_presence
     set checked_out_at = v_at,
         auto_closed    = v_auto,
         -- provenance ONLY when the recorded checkout is not what the phone
         -- said. In the ordinary in-cap case they are the same value and a
         -- second copy would just be noise in the review screen.
         fence_exit_at  = case when v_auto then v_raw else fence_exit_at end
   where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. GRANTS — restated on both, though neither signature changed.
--
-- CREATE OR REPLACE preserves the ACL, so these are a no-op today. They are
-- here because a DROP+CREATE has silently stripped service_role twice in this
-- codebase, and because REVOKE removes the PUBLIC EXECUTE that Postgres grants
-- by default to any newly CREATED function — the day one of these becomes a
-- DROP+CREATE, these lines are the difference between preserved and widened.
-- ---------------------------------------------------------------------
REVOKE ALL    ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.geofence_arrive(double precision, double precision, double precision, timestamptz, uuid) TO service_role;

REVOKE ALL    ON FUNCTION public.geofence_depart(timestamptz, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_depart(timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.geofence_depart(timestamptz, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after, separately)
-- =====================================================================
-- -- 1. Signatures and grants. EXPECT one row each, pronargs 5 and 2,
-- --    anon_exec f, auth_exec t, svc_exec t, public_absent t.
-- SELECT p.oid::regprocedure AS signature, p.pronargs,
--        has_function_privilege('anon',          p.oid,'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', p.oid,'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  p.oid,'EXECUTE') AS svc_exec,
--        NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_absent
--   FROM pg_proc p
--  WHERE p.pronamespace='public'::regnamespace
--    AND p.proname IN ('geofence_arrive','geofence_depart')
--  ORDER BY p.proname;
--
-- -- 2. Both fixes present, both old guards intact, verdict still untouched.
-- --    EXPECT containment t · two_min_guard t · open_guard t · fenced_cap t · touches_verdict f
-- SELECT
--   (SELECT prosrc LIKE '%ALREADY COVERED BY A RECORDED SHIFT%' FROM pg_proc
--     WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive')      AS containment,
--   (SELECT prosrc LIKE '%2 minutes%' FROM pg_proc
--     WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive')      AS two_min_guard,
--   (SELECT prosrc LIKE '%already on the clock%' FROM pg_proc
--     WHERE pronamespace='public'::regnamespace AND proname='geofence_arrive')      AS open_guard,
--   (SELECT prosrc LIKE '%geofence_backstop_hours%' FROM pg_proc
--     WHERE pronamespace='public'::regnamespace AND proname='geofence_depart')      AS fenced_cap,
--   (SELECT prosrc ILIKE '%verified%' FROM pg_proc
--     WHERE pronamespace='public'::regnamespace AND proname='geofence_depart')      AS touches_verdict;
--
-- -- 3. No data moved. EXPECT the same open-row count as before applying.
-- SELECT count(*) AS still_open FROM public.station_presence WHERE checked_out_at IS NULL;
--
-- -- 4. THEN RUN sql/geofence_replay_guard_and_cap_RETEST.sql — every case PASS.
