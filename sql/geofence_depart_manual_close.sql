-- =====================================================================
-- geofence_depart — CLOSE A MANUALLY-OPENED STANDBY SHIFT ON FENCE EXIT.
--
-- THE HOLE. A member taps "Clock in" (station_check_in → source 'geo',
-- kind 'standby'), walks away, and the shift stays open until the sweeper caps
-- it at max_shift_hours. geofence_depart sees the EXIT, finds no gps_geofence
-- row open, and returns null — the phone knew they left and the database did
-- not. Hours are credited for time nobody was on station.
--
-- WHO THIS ACTUALLY HELPS, stated plainly: fence registration depends on the
-- department having geofencing on and the member having granted location
-- (App.jsx ~2083). It has nothing to do with how they checked in — so a
-- consenting member is monitored continuously and the EXIT fires whether the
-- shift was opened by the daemon or by hand. A member who declines location can
-- still clock in and walk away. This closes a hole for consenting members, not
-- a universal one.
--
-- WRITTEN AGAINST THE LIVE BODIES, captured 2026-08-31 via pg_get_functiondef:
-- geofence_depart, station_check_in, set_default_station_id, and the
-- trg_station_id_station_presence trigger. The repo files lag the database.
--
-- ---------------------------------------------------------------------
-- WHY DROP + CREATE AND NOT CREATE OR REPLACE.
--
-- Adding a parameter does not replace a function, it OVERLOADS it. Both
-- geofence_depart(timestamptz) and geofence_depart(timestamptz, uuid) would
-- exist, and then a one-argument call is AMBIGUOUS — Postgres raises "function
-- is not unique" — because the two-arg form's default makes it a candidate for
-- the same call. Every 2.1 install would start failing to check out. So the old
-- signature must go, and DROP discards the ACL, which is re-established in
-- section 3. That is the same lesson as pa_create_department and geofence_arrive.
--
-- ---------------------------------------------------------------------
-- BACKWARD COMPATIBILITY IS THE CRITICAL CONSTRAINT.
--
-- The installed base (2.1) calls geofence_depart(p_at) with no station. If that
-- call took the new station-scoped selection, a null station would match no row
-- and auto-checkout would break for every phone in the field until it updated.
--
-- So SELECTION branches on whether a station was passed, as two separate blocks
-- rather than one clause with a coalesce — the point is that the legacy block
-- can be read and compared against the captured body without untangling it:
--
--   p_station_id IS NULL  -> today's selection, unchanged: gps_geofence only,
--                            no station filter, no manual arm.
--   p_station_id NOT NULL -> station-scoped, and manual standby included.
--
-- DEPLOY ORDER IS LOAD-BEARING: this migration must be live in production
-- BEFORE the client build that sends p_station_id ships. The default keeps old
-- installs working throughout; a client that sends the argument to a database
-- that does not have it yet gets "function not found" and stops checking out.
--
-- ---------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE. No universal max-shift cap — that is deferred,
-- and nothing below forecloses it: the cap still lives in one place and applies
-- to whatever row was selected, regardless of source.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_open_null integer;
  v_copies    integer;
BEGIN
  SELECT count(*) INTO v_copies FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname='geofence_depart';
  IF v_copies <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: expected exactly one geofence_depart, found %. Resolve the overload before dropping.', v_copies;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_depart'
                    AND pronargs = 1) THEN
    RAISE EXCEPTION 'Precondition failed: geofence_depart is not the 1-argument form this file replaces. Re-capture pg_get_functiondef.';
  END IF;

  -- The captured body. If this text is gone, the body drifted after capture and
  -- the legacy branch below is no longer a faithful copy of it.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='geofence_depart'
                    AND prosrc LIKE '%ONLY what the daemon opened%'
                    AND prosrc LIKE '%THE SWEEPER GOT HERE FIRST%') THEN
    RAISE EXCEPTION 'Precondition failed: geofence_depart body is not the one captured 2026-08-31. Re-capture before applying.';
  END IF;

  -- verified_latch's premise, restated: departure must never touch the verdict.
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace='public'::regnamespace AND proname='geofence_depart'
                AND prosrc ILIKE '%verified%') THEN
    RAISE EXCEPTION 'Precondition failed: geofence_depart references `verified`. Stop and read the body.';
  END IF;

  -- THE GATE for dropping the `station_id is null` arm. A row that is open with
  -- no station could never be selected under absolute station scope, so it would
  -- become un-closable by the fence. Zero at capture; assert it still holds.
  SELECT count(*) INTO v_open_null FROM public.station_presence
   WHERE checked_out_at IS NULL AND station_id IS NULL;
  IF v_open_null <> 0 THEN
    RAISE EXCEPTION 'Precondition failed: % open row(s) have no station_id. Absolute station scope would make them un-closable by the fence — handle them explicitly rather than widening the selection.', v_open_null;
  END IF;

  RAISE NOTICE 'Pre-flight OK — one 1-arg geofence_depart, body matches capture, no open null-station rows.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. Out with the one-argument form. See the header for why this is not a
--    CREATE OR REPLACE.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.geofence_depart(timestamptz);


-- ---------------------------------------------------------------------
-- 2. The two-argument form.
-- ---------------------------------------------------------------------
CREATE FUNCTION public.geofence_depart(
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
  select max_shift_hours into v_cap
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
-- 3. GRANTS — re-established explicitly on the NEW signature.
--
-- The DROP discarded the old ACL. These are stated rather than replayed from a
-- capture: the automated capture/replay pattern does NOT restore revokes, which
-- is how dept_station_shifts came back executable by anon after Phase E. anon is
-- revoked by hand, and service_role is granted by hand because a DROP+CREATE has
-- silently stripped it twice in this codebase.
-- ---------------------------------------------------------------------
REVOKE ALL    ON FUNCTION public.geofence_depart(timestamptz, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_depart(timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.geofence_depart(timestamptz, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after, separately)
-- =====================================================================
--
-- -- 1. SIGNATURE AND GRANTS. This is the check for the failure this file is
-- --    most likely to cause. EXPECT exactly one row:
-- --      pronargs 2 · auth_exec t · svc_exec t · anon_exec f · public_absent t
-- --
-- --    BOTH grant lines are load-bearing, in opposite directions:
-- --      GRANT  …  restores what the DROP removed (authenticated + service_role
-- --                both held EXECUTE before this file ran).
-- --      REVOKE …  removes the PUBLIC EXECUTE that Postgres grants by DEFAULT to
-- --                every newly created function. Without it the rebuilt function
-- --                would be WIDER than the one it replaced, silently.
-- SELECT p.oid::regprocedure                                       AS signature,
--        p.pronargs,
--        p.proacl::text                                            AS raw_acl,
--        has_function_privilege('anon',          p.oid,'EXECUTE')  AS anon_exec,
--        has_function_privilege('authenticated', p.oid,'EXECUTE')  AS auth_exec,
--        has_function_privilege('service_role',  p.oid,'EXECUTE')  AS svc_exec,
--        NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
--                                                                  AS public_absent
--   FROM pg_proc p
--  WHERE p.pronamespace='public'::regnamespace AND p.proname='geofence_depart';
--
-- -- 2. EXACTLY ONE COPY. Two would make a 1-argument call ambiguous and break
-- --    every install in the field. EXPECT 1.
-- SELECT count(*) AS copies FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='geofence_depart';
--
-- -- 3. BOTH SELECTION BLOCKS ARE PRESENT, and verified is still untouched.
-- --    EXPECT legacy_block t · station_block t · manual_arm t · touches_verified f
-- SELECT prosrc LIKE '%ONLY what the daemon opened%'                AS legacy_block,
--        prosrc LIKE '%station_id = p_station_id%'                  AS station_block,
--        prosrc LIKE '%source = ''geo''          and kind = ''standby''%' AS manual_arm,
--        prosrc ILIKE '%verified%'                                  AS touches_verified
--   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='geofence_depart';
--
-- -- 4. NOTHING WAS CLOSED BY APPLYING THIS. The two rows open at capture must
-- --    still be open — the migration changes a function, never data.
-- SELECT count(*) AS still_open FROM public.station_presence WHERE checked_out_at IS NULL;
--
-- -- 5. NO ZERO-LENGTH ROWS EXIST. EXPECT 0 (the Aug 28 shape).
-- SELECT count(*) AS zero_length_rows FROM public.station_presence
--  WHERE checked_out_at = checked_in_at;
--
-- -- 6. THEN RUN sql/geofence_depart_manual_close_RETEST.sql — nine cases, all
-- --    inside BEGIN … ROLLBACK. Every row must read PASS.
