-- =====================================================================
-- open_signin — a sign-in may only be opened around the session it belongs to.
--
-- WHAT WENT WRONG. On 2026-09-03 a live drill was run against a training session
-- scheduled for 2026-09-24. The QR opened without complaint, everyone scanned,
-- and every attendance row landed on the 24th — credit for a training that had
-- not happened yet, and no record of the one that had. open_signin checked the
-- caller's access, the department, `done`, and (for off-site) that a location
-- was pinned. It never looked at WHEN the session was scheduled.
--
-- THE WINDOW: from 24 hours before the scheduled start, to 24 hours after the
-- scheduled end.
--
-- ASYMMETRY IS NOT AN OVERSIGHT — the two directions are different problems.
-- Opening EARLY is never legitimate: nobody needs a QR for a drill three weeks
-- out, and an early open is always a mis-tap or a stale screen. Opening LATE
-- often is legitimate: a session runs over, or an officer opens the code once
-- the drill has already started. Hence a bound on both sides, but for different
-- reasons, and the late one is the one to relax first if it ever bites.
--
-- THE LATE BOUND COSTS NOTHING, because after-the-fact attendance already has a
-- better path: an officer marks the roster directly (the client's toggleAttend
-- writes session_attendance with no token involved). A QR is for people
-- physically present now. A drill from last week should be recorded by the
-- officer who ran it, not by re-opening a code — and that is what the error
-- message says.
--
-- WHY THE LATE BOUND IS NEEDED AT ALL, given `done` already blocks a finalised
-- session: a session nobody finalised stays openable forever. Past sessions
-- accumulate in the list while future ones are few, so the stale-past mis-tap is
-- the MORE likely of the two, and it does identical damage in the other
-- direction.
--
-- COVERS ROTATION TOO. The client's "rotate code" is this same RPC
-- (rotateSI = openSI in App.jsx), so the window applies to rotating an existing
-- code as well as opening a new one. That is correct: a code rotated for a
-- session weeks away is the same mistake as opening one.
--
-- TIMEZONE IS HARDCODED CENTRAL, matching api/pulse.js and the SQL that already
-- assumes it (dept_station_shifts, attested_training). Every department today is
-- in Texas. When a non-Central department is onboarded this constant and those
-- sites become one per-department column — a single decision, not five.
--
-- WRITTEN AGAINST THE LIVE BODY captured 2026-09-03 via pg_get_functiondef,
-- which on this occasion matched sql/slice7c3_offsite_flag_guards.sql exactly.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname='open_signin') <> 1 THEN
    RAISE EXCEPTION 'Precondition failed: expected exactly one open_signin.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='open_signin'
                    AND pronargs = 1) THEN
    RAISE EXCEPTION 'Precondition failed: open_signin is not the 1-argument form. Re-capture.';
  END IF;

  /* The captured body, by three markers that between them cover every part this
     file must carry through unchanged: the access gate, the C3 off-site guard,
     and the token generator. */
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='open_signin'
                    AND prosrc LIKE '%You are not allowed to open a sign-in for this session.%'
                    AND prosrc LIKE '%NEW IN C3%'
                    AND prosrc LIKE '%upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6))%') THEN
    RAISE EXCEPTION 'Precondition failed: open_signin body is not the one captured 2026-09-03. Re-capture before applying.';
  END IF;

  -- Refuse a second apply rather than adding the guard twice.
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace='public'::regnamespace AND proname='open_signin'
                AND prosrc LIKE '%THE SIGN-IN WINDOW%') THEN
    RAISE EXCEPTION 'Precondition failed: open_signin already carries the date window. Nothing to do.';
  END IF;

  /* THE GATE THIS FILE MUST NOT BREAK. sql/signin_token_getter.sql copied
     open_signin's access check character-for-character, on the argument that
     "who may DISPLAY the code" must be the same set as "who may OPEN it", and
     that the only way to guarantee two functions agree is for the text to be
     identical. If they have already drifted, that is a finding in its own right
     and this file is not the place to discover it silently. */
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='current_signin_token'
                    AND prosrc LIKE '%access && array[''Department Admin'',''Officer'',''Project Admin'']%') THEN
    RAISE EXCEPTION 'Precondition failed: current_signin_token no longer carries open_signin''s access gate. Reconcile the two before changing either.';
  END IF;

  RAISE NOTICE 'Pre-flight OK — open_signin matches the 2026-09-03 capture, window not yet present, token getter still in step.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. open_signin — verbatim except the window guard, which sits after the
--    `done` check and before the C3 off-site check.
--
--    ORDER MATTERS FOR THE MESSAGE THE OFFICER SEES. `done` first, because
--    "this session is complete" is a better explanation than a date range for a
--    finalised session. The window next, because a session scheduled weeks away
--    should be refused on that ground rather than on a missing location it was
--    never going to need yet.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_signin(p_session_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session public.training_sessions%rowtype;
  v_token   text;
  v_start   timestamptz;
  v_end     timestamptz;
begin
  if not exists (
    select 1 from public.members
    where lower(email) = lower(auth.email())
      and access && array['Department Admin','Officer','Project Admin']::text[]
  ) then
    raise exception 'You are not allowed to open a sign-in for this session.';
  end if;

  select * into v_session from public.training_sessions where id = p_session_id;
  if not found or v_session.department_id is distinct from public.my_department_id() then
    raise exception 'That training session was not found in your department.';
  end if;
  if v_session.done then
    raise exception 'This session is complete — you cannot open a sign-in.';
  end if;

  /* THE SIGN-IN WINDOW — see the file header for why both bounds exist and why
     they are asymmetric in intent.

     start_time is nullable: an all-day session with no time reads as midnight,
     so its window opens at midnight the day before. duration_min is nullable
     too: a null duration treats the session as instantaneous, so the window
     still closes 24 hours after its start rather than never.

     Central is hardcoded — see the header. */
  v_start := (v_session.date + coalesce(v_session.start_time, time '00:00'))
               at time zone 'America/Chicago';
  v_end   := v_start + make_interval(mins => coalesce(v_session.duration_min, 0));

  if now() < v_start - interval '24 hours' then
    raise exception 'This training is scheduled for %. Its sign-in can be opened from 24 hours before it starts.',
      to_char(v_start at time zone 'America/Chicago', 'FMMon FMDD, YYYY');
  end if;

  if now() > v_end + interval '24 hours' then
    raise exception 'This training was scheduled for % and its sign-in window has closed. To record who attended, mark them present on the session''s roster instead.',
      to_char(v_start at time zone 'America/Chicago', 'FMMon FMDD, YYYY');
  end if;

  -- ---- NEW IN C3 ----
  if v_session.is_offsite
     and (v_session.location_lat is null or v_session.location_lng is null) then
    raise exception 'Set this drill''s location first — you have to be on site, then tap "Use my location".';
  end if;
  -- ---- END NEW ----

  v_token := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  update public.training_sessions
    set signin_token = v_token, signin_open = true
  where id = p_session_id;
  return v_token;
end;
$function$;


-- ---------------------------------------------------------------------
-- 2. GRANTS — restated, and deliberately UNCHANGED in scope.
--
-- CREATE OR REPLACE preserves the ACL, so these are a no-op today. They restate
-- exactly what sql/revoke_anon_execute_sweep.sql established: anon and PUBLIC
-- out, authenticated in.
--
-- service_role IS NOT NAMED HERE, and the reason is narrower than it first
-- looks. It ALREADY holds EXECUTE — the ACL reads
-- {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres},
-- confirmed after applying. CREATE OR REPLACE preserves that, and the REVOKE
-- above deliberately names only public and anon, so nothing was added and
-- nothing was lost.
--
-- (An earlier draft of this comment asserted service_role did NOT hold it and
-- that granting would widen access. That was wrong, and the VERIFY below is what
-- caught it. Behaviour was unaffected either way; the claim was not.)
--
-- Whether service_role SHOULD hold EXECUTE on this function is a separate
-- question — nothing server-side opens a sign-in: no cron, no API route, no
-- other function calls it. Removing it would be a deliberate narrowing and
-- belongs in its own change, not smuggled into a date-guard migration.
-- ---------------------------------------------------------------------
REVOKE ALL    ON FUNCTION public.open_signin(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.open_signin(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after, separately)
-- =====================================================================
--
-- -- 1. Shape, grants and the guard. EXPECT copies 1 · pronargs 1 · definer t ·
-- --    anon_exec f · auth_exec t · public_absent t · window_guard t ·
-- --    c3_guard t · token_line t
-- SELECT count(*) OVER ()                                            AS copies,
--        p.pronargs, p.prosecdef                                     AS definer,
--        has_function_privilege('anon',          p.oid,'EXECUTE')    AS anon_exec,
--        has_function_privilege('authenticated', p.oid,'EXECUTE')    AS auth_exec,
--        has_function_privilege('service_role',  p.oid,'EXECUTE')    AS svc_exec,
--        NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_absent,
--        p.prosrc LIKE '%THE SIGN-IN WINDOW%'                        AS window_guard,
--        p.prosrc LIKE '%NEW IN C3%'                                 AS c3_guard,
--        p.prosrc LIKE '%clock_timestamp()::text), 1, 6)%'           AS token_line,
--        p.proacl::text                                              AS raw_acl
--   FROM pg_proc p
--  WHERE p.pronamespace='public'::regnamespace AND p.proname='open_signin';
--
-- -- 2. WHAT THE WINDOW WOULD DO TO EVERY SESSION THAT CURRENTLY EXISTS.
-- --    Read this before telling anyone the guard is in: a session showing
-- --    'blocked — too early' or 'blocked — too late' can no longer have its QR
-- --    opened, and if an officer needs one of those, the answer is to fix the
-- --    session's date, not to widen the window.
-- SELECT d.name AS department, ts.title, ts.date, ts.start_time, ts.done, ts.signin_open,
--        CASE
--          WHEN ts.done THEN 'blocked — session complete'
--          WHEN now() < ((ts.date + coalesce(ts.start_time, time '00:00')) at time zone 'America/Chicago')
--                       - interval '24 hours'                       THEN 'blocked — too early'
--          WHEN now() > ((ts.date + coalesce(ts.start_time, time '00:00')) at time zone 'America/Chicago')
--                       + make_interval(mins => coalesce(ts.duration_min, 0))
--                       + interval '24 hours'                       THEN 'blocked — too late'
--          ELSE 'CAN OPEN'
--        END AS window_now
--   FROM public.training_sessions ts
--   JOIN public.departments d ON d.id = ts.department_id
--  ORDER BY ts.date DESC
--  LIMIT 60;
--
-- ---------- SIGNED IN ----------
-- -- 3. As an officer, on a session scheduled for TODAY: open_signin returns a
-- --    6-character code. This is the normal case and must be unaffected.
-- -- 4. On a session weeks out: EXPECT 'This training is scheduled for … Its
-- --    sign-in can be opened from 24 hours before it starts.'
-- -- 5. On a past, unfinalised session: EXPECT '… its sign-in window has closed.
-- --    To record who attended, mark them present on the session's roster instead.'
-- -- 6. ROTATION obeys the same window: on an in-window session with a sign-in
-- --    already open, calling again returns a NEW code; on an out-of-window one it
-- --    raises rather than rotating.
