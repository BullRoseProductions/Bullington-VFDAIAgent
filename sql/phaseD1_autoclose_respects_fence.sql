-- =====================================================================
-- PHASE D1 — AUTO-CLOSE RESPECTS THE FENCE.
--
-- THE LIVE BUG THIS FIXES. Geofencing is ON for Lipan (1 house) and Granbury
-- (2 houses). auto_close_stale_shifts() is time-based and blind to the fence, so
-- a fenced standby that runs past max_shift_hours is closed at the cap BEFORE
-- the real EXIT arrives. The EXIT then finds nothing open — geofence_depart
-- matches on `checked_out_at is null` — returns NULL by design, and the phone's
-- real departure is discarded. The shift is credited at the cap, flagged, and
-- the evidence needed to correct it is gone.
--
-- open_geofence_shifts = 0 today, so nothing is mid-flight. The next long fenced
-- standby is what hits it.
--
-- THE RULE THAT DOES NOT BEND. An auto_closed shift is NEVER auto-re-credited
-- from a phone's late report. geofence_depart's `checked_out_at is null` guard
-- stays exactly as it is. This file fixes the bug by PREVENTION (the sweeper
-- stops firing early on fenced shifts) and PRESERVATION (the phone's real exit
-- time is always kept for the human reviewer) — never by letting the device
-- rewrite a credited number.
--
-- DEPARTMENT-LEVEL, NOT PER-STATION. No pins, no fence routing, no station_id
-- work, no per-station reads or writes. All of that is D2. Nothing in this file
-- reads or writes `stations`.
--
-- WRITTEN AGAINST THE LIVE BODIES (captured Aug 27), not the repo files. The
-- repo's slice6 copy of dept_shifts_needing_review is STALE — slice7b4 widened
-- it with reason / offsite_label / location_confirmed, and that ten-column shape
-- is what section 4 reproduces. Section 0 asserts it rather than trusting it.
--
-- DEPLOY GATE: apply BEFORE the client deploys. The review screen reads
-- fence_exit_at by name.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- The last three are the ones that matter most: they assert that the LIVE
-- bodies are the ones this file was written against. A drifted body must fail
-- here, at apply time, rather than being silently replaced by a version built
-- on wrong assumptions.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text;
BEGIN
  -- columns the new sweeper and depart bodies read and write
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(array['checked_in_at','checked_out_at','auto_closed','source',
                      'member_id','department_id','kind']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='station_presence' AND column_name=c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'D1 precondition failed: station_presence is missing column(s): %.', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='departments'
                    AND column_name='max_shift_hours') THEN
    RAISE EXCEPTION 'D1 precondition failed: departments.max_shift_hours is missing. Apply sql/slice5_autoclose_guardrail.sql first.';
  END IF;

  -- The sweeper we are replacing must be the cap-based one.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace
                    AND proname='auto_close_stale_shifts'
                    AND prosrc ILIKE '%max_shift_hours%') THEN
    RAISE EXCEPTION 'D1 precondition failed: auto_close_stale_shifts() does not reference max_shift_hours. The live body is not what this file was written against.';
  END IF;

  -- geofence_depart must be the g4l1 body: daemon-scoped AND carrying the cap.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace
                    AND proname='geofence_depart'
                    AND prosrc ILIKE '%gps_geofence%'
                    AND prosrc ILIKE '%v_limit%') THEN
    RAISE EXCEPTION 'D1 precondition failed: geofence_depart() is not the shift-length-guard body (no v_limit). Apply sql/geofence_g4l1_shift_length_guard.sql first.';
  END IF;

  -- The review queue must already be the slice7b4 ten-column shape. If it is
  -- still the slice6 seven-column one, section 4 would silently DROP the
  -- off-site approval columns the review screen depends on.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace
                    AND proname='dept_shifts_needing_review'
                    AND pg_get_function_result(oid) ILIKE '%reason%'
                    AND pg_get_function_result(oid) ILIKE '%offsite_label%') THEN
    RAISE EXCEPTION 'D1 precondition failed: dept_shifts_needing_review() does not return reason/offsite_label. Section 4 reproduces the slice7b4 shape and would drop columns the review screen reads.';
  END IF;
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. The two columns.
--
-- fence_exit_at is PROVENANCE, and the comment says so because the next person
-- to find it will be looking at a timestamp that is not the checkout time and
-- wondering which one counts. It feeds no credited total, appears in no report,
-- and is never summed.
--
-- geofence_backstop_hours is NULLABLE and the function coalesces to 36 and
-- clamps to >= max_shift_hours, so the no-shrink guarantee never depends on
-- what is (or is not) in this column. 36h is comfortably longer than any real
-- standby, so the backstop only ever closes a genuinely abandoned session —
-- a dead battery, a killed app, a phone that never reported an exit.
-- ---------------------------------------------------------------------
ALTER TABLE public.station_presence
  ADD COLUMN IF NOT EXISTS fence_exit_at timestamptz;

COMMENT ON COLUMN public.station_presence.fence_exit_at IS
  'The phone''s raw reported EXIT time, preserved for review whenever the recorded checkout was capped or the shift was already auto-closed. Provenance only — never a credited number, never summed, never read by a report.';

ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS geofence_backstop_hours integer;

COMMENT ON COLUMN public.departments.geofence_backstop_hours IS
  'How long to wait for a silent phone before auto_close_stale_shifts() gives up on a gps_geofence shift. NULL means the built-in default (36h). Always clamped to >= max_shift_hours by the function, so it can never shorten a shift.';


-- ---------------------------------------------------------------------
-- 2. auto_close_stale_shifts() — fenced rows sweep at the backstop.
--
-- BEFORE (live): every open row, regardless of source, closed at
--   checked_in_at + max_shift_hours.
--
-- AFTER: a source='gps_geofence' row uses
--   greatest(coalesce(geofence_backstop_hours, 36), max_shift_hours)
-- which is ALWAYS >= the cap, so no row closes earlier than it does today.
-- Every other row is byte-identical: plain d.max_shift_hours.
--
-- BRANCHING ON source ALONE, not on the department's current geofence flag. A
-- shift the daemon opened is fenced-origin even if geofencing was switched off
-- afterwards, and the backstop (being >= the cap) is always the safe interval
-- for it. Reading the flag would mean a mid-shift toggle changes how an
-- already-open shift is closed, which is exactly the kind of retroactive
-- surprise this file exists to remove.
--
-- THE INTERVAL EXPRESSION APPEARS TWICE — once in SET, once in WHERE — and the
-- two MUST stay in step. If they diverge, the sweeper closes rows at a time it
-- did not select them by. Written out rather than factored into a LATERAL
-- because the UPDATE target is not in scope for a LATERAL in UPDATE ... FROM.
--
-- STILL DETERMINISTIC AND IDEMPOTENT: checked_out_at is checked_in_at + an
-- interval, never now(), so the credited window does not depend on when cron
-- happened to run. That was slice 5's reasoning and it is unchanged.
--
-- `and d.max_shift_hours is not null` is a NO-OP added for consistency: today a
-- null cap makes the WHERE comparison null and the row is never swept. Without
-- it the fenced branch would fall back to 36 and start sweeping rows the live
-- body leaves alone — a behaviour change smuggled in under a bug fix.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_close_stale_shifts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer;
begin
  update public.station_presence sp
     set checked_out_at = sp.checked_in_at + make_interval(hours =>
           case when sp.source = 'gps_geofence'
                then greatest(coalesce(d.geofence_backstop_hours, 36), d.max_shift_hours)
                else d.max_shift_hours
           end),
         auto_closed    = true
    from public.departments d
   where d.id = sp.department_id
     and sp.checked_out_at is null
     and d.max_shift_hours is not null
     and now() - sp.checked_in_at > make_interval(hours =>
           case when sp.source = 'gps_geofence'
                then greatest(coalesce(d.geofence_backstop_hours, 36), d.max_shift_hours)
                else d.max_shift_hours
           end);
  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$function$;

-- Not a user-facing RPC; unchanged from slice 5. pg_cron runs jobs as their
-- owner and needs no grant. Restated because CREATE OR REPLACE preserves the
-- ACL and this documents what that ACL is.
REVOKE ALL ON FUNCTION public.auto_close_stale_shifts() FROM public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. geofence_depart() — preserve the phone's real exit.
--
-- SAME SIGNATURE, so CREATE OR REPLACE is valid and there is no grant churn.
--
-- EVERYTHING THAT DECIDES A CREDITED NUMBER IS UNCHANGED: the daemon-only
-- source filter, the `checked_out_at is null` guard, the kind filter, the cap
-- to v_limit, the out-of-order guard, and the auto_closed flag. Diff the two
-- bodies and the only additions are v_raw and the two fence_exit_at writes.
--
-- v_raw IS THE PHONE'S READING, captured before the cap clamp. The DRIFT clamp
-- (future -> now()) is still applied to it, deliberately: a timestamp in the
-- future is not a reading, it is a broken clock, and storing it as provenance
-- would put a departure after the review in front of the officer. The cap
-- clamp — the one that actually loses information — is what v_raw is captured
-- ahead of. Say the word if you want the unclamped value instead.
--
-- THREE PATHS:
--
--   open row, exit within the cap   -> exactly as today. fence_exit_at stays
--                                      null, because the recorded checkout IS
--                                      what the phone said; provenance would be
--                                      a duplicate of a column already there.
--
--   open row, capped or reordered   -> checked_out_at and auto_closed exactly as
--                                      today, PLUS fence_exit_at = v_raw. The
--                                      reviewer sees "system stopped it at
--                                      18:00, the phone reported 22:00".
--
--   NO open row (the data-loss bug) -> the sweeper got here first. Annotate that
--                                      row's fence_exit_at and NOTHING else.
--                                      checked_out_at and auto_closed are not
--                                      touched, so no credited number moves and
--                                      the human still decides.
--
-- THE ANNOTATE BRANCH IS TIGHTLY BOUNDED, and each bound earns its place:
--   auto_closed              — only a machine-guessed row is a candidate
--   fence_exit_at is null    — a replayed EXIT is a no-op, never an overwrite
--   checked_out_at not null  — it really is closed
--   v_raw > checked_in_at    — a departure before its own arrival is not evidence
--   checked_in_at > now() - 2 days — do not retro-annotate an ancient shift with
--                                    a reading from a queue that sat for weeks
--   source / kind            — same filters as the open-row query above it
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.geofence_depart(
  p_at timestamptz DEFAULT NULL
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

  select * into v_row from public.station_presence
   where member_id = v_member
     and checked_out_at is null                     -- never re-close an auto_closed row
     and source = 'gps_geofence'                    -- ONLY what the daemon opened
     and kind in ('standby','offsite')
   order by checked_in_at desc limit 1;

  if not found then
    /* THE SWEEPER GOT HERE FIRST. Before this, the phone's real departure was
       simply dropped on the floor. Now it is recorded as provenance so the
       review screen can show the officer what the fence actually saw — while
       the credited number stays exactly where the machine put it, and the
       decision stays with the human. */
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

  select max_shift_hours into v_cap
    from public.departments where id = v_row.department_id;
  v_limit := v_row.checked_in_at + make_interval(hours => coalesce(v_cap, 10));

  if v_at <= v_row.checked_in_at then
    -- a departure that predates its own arrival tells us nothing trustworthy
    v_at   := v_row.checked_in_at;
    v_auto := true;
  elsif v_at > v_limit then
    -- longer than the department allows: cap it and hand it to a human
    v_at   := v_limit;
    v_auto := true;
  end if;

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

REVOKE ALL ON FUNCTION public.geofence_depart(timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_depart(timestamptz) TO authenticated;


-- ---------------------------------------------------------------------
-- 4. dept_shifts_needing_review() — surface the phone's reading.
--
-- DROP + CREATE, because the RETURNS TABLE shape widens by one column and
-- Postgres will not replace a function whose return type differs. DROP discards
-- the ACL, so the grants are restated below — the B3b / Phase C lesson.
--
-- REPRODUCED FROM THE slice7b4 SHAPE, not slice6's. The repo's slice6 copy is
-- stale: slice7b4 added reason / offsite_label / location_confirmed and the
-- off-site branch of the WHERE, and the review screen reads all of them
-- (App.jsx:10428, :10436, :10443, :10446). Everything below is byte-identical to
-- that body except the appended column.
--
-- fence_exit_at is APPENDED LAST so nothing positional shifts.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.dept_shifts_needing_review();

CREATE FUNCTION public.dept_shifts_needing_review()
 RETURNS TABLE(
   shift_id       uuid,
   member_id      uuid,
   member_name    text,
   kind           text,
   reason         text,          -- 'auto_closed' | 'offsite_pending' | 'both'
   offsite_label  text,
   location_confirmed boolean,
   checked_in_at  timestamp with time zone,
   checked_out_at timestamp with time zone,
   capped_hours   numeric,
   fence_exit_at  timestamp with time zone   -- D1: what the phone actually reported, if anything
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  return query
    select sp.id, m.id, m.name, sp.kind,
           case
             when sp.auto_closed and sp.kind = 'offsite' and sp.approved_at is null then 'both'
             when sp.auto_closed                                                    then 'auto_closed'
             else                                                                        'offsite_pending'
           end,
           sp.offsite_label, sp.location_confirmed,
           sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2),
           sp.fence_exit_at
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    where sp.department_id = v_dept
      and (
        sp.auto_closed
        or (sp.kind = 'offsite' and sp.approved_at is null and sp.checked_out_at is not null)
      )
    order by sp.checked_in_at asc;   -- oldest first: this is a work list
end;
$function$;

-- DROP discarded the ACL, so it is re-established here — and it is restated from
-- the LIVE capture, not from slice7b4's header comment:
--
--   {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--
-- Three entries: the owner, authenticated, and SERVICE_ROLE. No anon, no PUBLIC.
--
-- THE service_role GRANT IS EXPLICIT HERE, AND DELIBERATELY SO. Supabase's
-- default privileges grant EXECUTE on a new public function to anon,
-- authenticated AND service_role — which is why slice7b4 could land on the ACL
-- above while only ever writing a REVOKE and one GRANT (see
-- apparatus_service_5b.sql:148, which expects service_role=t having granted it
-- nowhere). So this GRANT is very probably redundant.
--
-- "Very probably redundant" is not the standard for a privilege. If that default
-- were ever changed at the project level, the DROP below would silently strip
-- service_role from a function the server-side caller needs, and nothing in the
-- app would fail in a way anyone would trace back to this file. Granting it
-- explicitly is idempotent when the default holds and correct when it does not.
REVOKE ALL ON FUNCTION public.dept_shifts_needing_review() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.dept_shifts_needing_review() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.dept_shifts_needing_review() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — checks 1-4 write, and every one of them ROLLS BACK.
-- =====================================================================
--
-- -- 0. BEFORE/AFTER BASELINE. Run these BEFORE applying, keep the numbers, run
-- --    them again after. They must be IDENTICAL — D1 moves no credited hour.
-- --    (Run signed in as leadership; both read auth context.)
-- --   SELECT * FROM public.dept_iso_hours(date_trunc('year', now()), now());
-- --   SELECT count(*), sum(hours) FROM public.dept_station_shifts(date_trunc('year', now()), now());
-- --   SELECT count(*) AS open_geofence_shifts FROM public.station_presence
-- --    WHERE source='gps_geofence' AND checked_out_at IS NULL;     -- expect 0
--
-- -- 1. Shapes and grants. Expect definer=t, anon=f, auth=t on the two RPCs,
-- --    auto_close_stale_shifts anon=f AND auth=f, and exactly one of each.
-- --
-- --    THE COLUMN THAT MATTERS MOST IS svc_exec ON dept_shifts_needing_review.
-- --    It was DROPped, and the pre-apply ACL was
-- --      {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
-- --    so svc_exec MUST come back true. Compare the whole acl column against that
-- --    string — it is the only proof the DROP did not quietly narrow the grants.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        count(*) OVER (PARTITION BY proname) AS copies,
--        prosecdef AS definer,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  oid, 'EXECUTE') AS svc_exec,
--        proacl::text                                            AS acl
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('auto_close_stale_shifts','geofence_depart','dept_shifts_needing_review')
--  ORDER BY proname;
--
-- -- 2. The bodies really changed, and the guard really survived.
-- --    Expect: sweeper backstop=t; depart keeps_null_guard=t AND writes_provenance=t;
-- --            review returns fence_exit_at.
-- SELECT proname,
--        (prosrc ILIKE '%geofence_backstop_hours%')      AS backstop,
--        (prosrc ILIKE '%checked_out_at is null%')       AS keeps_null_guard,
--        (prosrc ILIKE '%fence_exit_at%')                AS writes_provenance
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('auto_close_stale_shifts','geofence_depart')
--  ORDER BY proname;
--
-- SELECT pg_get_function_result('public.dept_shifts_needing_review'::regproc) ILIKE '%fence_exit_at%'
--        AS review_exposes_it;
--
-- -- ---- CHECK 1: the sweeper. A FENCED row is spared at the cap; a MANUAL row
-- --      is still closed at it. Insert both 12h old with a 10h cap.
-- --      EXPECT: manual row closed at exactly cap hours, auto_closed=true;
-- --              fenced row STILL OPEN (checked_out_at null).
-- --   BEGIN;
-- --     UPDATE public.departments SET max_shift_hours = 10
-- --      WHERE id = (SELECT department_id FROM public.members WHERE email IS NOT NULL ORDER BY id LIMIT 1);
-- --     INSERT INTO public.station_presence (department_id, member_id, kind, verified, source, checked_in_at)
-- --     SELECT m.department_id, m.id, 'standby', false, 'gps_geofence', now() - interval '12 hours'
-- --       FROM public.members m WHERE m.email IS NOT NULL ORDER BY m.id LIMIT 1;
-- --     INSERT INTO public.station_presence (department_id, member_id, kind, verified, source, checked_in_at)
-- --     SELECT m.department_id, m.id, 'standby', false, 'geo', now() - interval '12 hours'
-- --       FROM public.members m WHERE m.email IS NOT NULL ORDER BY m.id LIMIT 1;
-- --     SELECT public.auto_close_stale_shifts();
-- --     SELECT source, checked_out_at IS NULL AS still_open, auto_closed,
-- --            round(extract(epoch from (checked_out_at - checked_in_at))/3600.0, 2) AS hours
-- --       FROM public.station_presence
-- --      WHERE checked_in_at > now() - interval '13 hours' ORDER BY source;
-- --   ROLLBACK;
--
-- -- ---- CHECK 2: the data-loss fix. A late EXIT on an ALREADY auto-closed
-- --      fenced row records fence_exit_at and touches nothing else.
-- --      EXPECT: checked_out_at and auto_closed UNCHANGED, fence_exit_at set.
-- --      Run as a real member (my_member_id() must resolve).
-- --   BEGIN;
-- --     INSERT INTO public.station_presence
-- --       (department_id, member_id, kind, verified, source, checked_in_at, checked_out_at, auto_closed)
-- --     VALUES (public.my_department_id(), public.my_member_id(), 'standby', false, 'gps_geofence',
-- --             now() - interval '14 hours', now() - interval '4 hours', true);
-- --     SELECT public.geofence_depart(now() - interval '1 hour');
-- --     SELECT checked_out_at, auto_closed, fence_exit_at
-- --       FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source='gps_geofence'
-- --      ORDER BY checked_in_at DESC LIMIT 1;
-- --     -- replay must be a no-op: fence_exit_at unchanged
-- --     SELECT public.geofence_depart(now() - interval '30 minutes');
-- --     SELECT fence_exit_at FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source='gps_geofence'
-- --      ORDER BY checked_in_at DESC LIMIT 1;
-- --   ROLLBACK;
--
-- -- ---- CHECK 3: an OPEN row whose exit exceeds the cap still caps exactly as
-- --      today, AND now records the raw reading.
-- --      EXPECT: hours = max_shift_hours, auto_closed=true, fence_exit_at = the
-- --              raw time passed in (later than checked_out_at).
-- --   BEGIN;
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '30 hours');
-- --     SELECT public.geofence_depart(now());
-- --     SELECT auto_closed, checked_out_at, fence_exit_at,
-- --            fence_exit_at > checked_out_at AS provenance_is_later,
-- --            round(extract(epoch from (checked_out_at - checked_in_at))/3600.0, 2) AS hours
-- --       FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source='gps_geofence'
-- --      ORDER BY checked_in_at DESC LIMIT 1;
-- --   ROLLBACK;
--
-- -- ---- CHECK 4: the ordinary in-cap shift is untouched. EXPECT ~3.0 hours,
-- --      auto_closed=false, fence_exit_at NULL.
-- --   BEGIN;
-- --     SELECT public.geofence_arrive(34.0, -84.0, 12, now() - interval '5 hours');
-- --     SELECT public.geofence_depart(now() - interval '2 hours');
-- --     SELECT auto_closed, fence_exit_at IS NULL AS no_provenance,
-- --            round(extract(epoch from (checked_out_at - checked_in_at))/3600.0, 2) AS hours
-- --       FROM public.station_presence
-- --      WHERE member_id = public.my_member_id() AND source='gps_geofence'
-- --      ORDER BY checked_in_at DESC LIMIT 1;
-- --   ROLLBACK;
--
-- -- -- 5. UNTOUCHED PROOF — this file creates none of these. Diff each against
-- -- --    its pre-apply capture.
-- SELECT pg_get_functiondef('public.dept_iso_hours'::regproc);
-- SELECT pg_get_functiondef('public.dept_station_shifts'::regproc);
-- SELECT pg_get_functiondef('public.my_station_shifts'::regproc);
-- SELECT pg_get_functiondef('public.station_check_in'::regproc);
-- SELECT pg_get_functiondef('public.geofence_arrive'::regproc);
-- SELECT pg_get_functiondef('public.is_at_station'::regproc);
-- SELECT pg_get_functiondef('public.resolve_auto_closed_shift'::regproc);
-- SELECT pg_get_functiondef('public.approve_offsite'::regproc);
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
--
-- ---------- SIGNED IN, on the deployed app ----------
-- -- 6. The needs-review queue renders exactly as before for every existing row
-- --    (fence_exit_at is null on all of them, so no new line appears).
-- -- 7. Off-site rows still show their label, location line, and Approve/Reject
-- --    buttons — proof the slice7b4 columns survived the DROP + CREATE.
-- -- 8. Confirm and Void still work on an auto-closed row.
