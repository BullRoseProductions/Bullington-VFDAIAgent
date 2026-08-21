-- =====================================================================
-- OFFICER-ATTESTED TRAINING, C1 — the shared derivation. INERT.
--
-- NOT YET APPLIED. Nothing calls this until C2 rewrites dept_station_shifts
-- and dept_iso_hours to select from it, so applying it changes no screen and
-- no number.
--
-- WHY A FUNCTION AND NOT TWO COPIES. Both callers need the same answer to the
-- same question — "which members did an officer attest to, over what interval"
-- — and they need it to agree exactly, because one produces the credited total
-- and the other produces the ISO figure printed beside it. Written twice, the
-- cap, the timezone, the gates and the dedup would each be a place to drift,
-- and the symptom would be two numbers on one screen disagreeing for reasons no
-- reader could diagnose. This codebase has already paid that bill three times:
-- the digest's missing auto_closed rule, two hand-copied column lists, and a
-- hand-copied ORDER BY. One definition, two readers.
--
-- THE CAP IS THE POLICY. An officer marking a roster attests that someone was
-- there, not for how long. A flat 90 minutes is deliberately conservative: less
-- than most drills run, so the department is never credited more than it can
-- defend, and capped again at the drill's own length so a 45-minute session
-- cannot yield 90 minutes. Where a member actually checked in on location, the
-- observed row wins and this produces nothing for them at all.
--
-- SECURITY: DELIBERATELY *NOT* SECURITY DEFINER.
-- p_dept is a parameter, so a definer-rights version would let any authenticated
-- caller read another department's attendance by passing its id. As an invoker
-- function it runs with the caller's rights: called from inside the two
-- SECURITY DEFINER RPCs it inherits their context as before, and called
-- directly by a member it is filtered by the same RLS that governs
-- session_attendance and training_sessions — so a foreign p_dept returns
-- nothing rather than someone else's roster.
--
-- TIMEZONE: hardcoded Central, matching the attendance-hours migration. A
-- drill's date + start_time is a wall clock with no zone; read in the server's
-- zone (Supabase runs UTC) every interval lands five hours off, which both
-- misprints the times and de-overlaps against the wrong window. When a
-- non-Central department is onboarded this becomes a per-department IANA
-- column, here and everywhere else that turns a wall clock into an instant.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.attested_training(
  p_dept uuid,
  p_from timestamptz,
  p_to   timestamptz
)
 RETURNS TABLE(
   member_id  uuid,
   session_id uuid,
   start_at   timestamptz,
   end_at     timestamptz,
   optional   boolean
 )
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with drill as (
    select
      ts.id,
      ts.department_id,
      -- wall clock -> instant, in the department's zone. See the header.
      (ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago' as start_at,
      -- flat 90 minutes, never more than the drill itself ran
      least(interval '90 minutes', make_interval(mins => ts.duration_min))               as credited_len,
      (coalesce(ts.counts_toward_attendance, true) = false)                              as optional
    from public.training_sessions ts
    where ts.department_id = p_dept
      and ts.done                                     -- a drill that has not happened has no hours
      and ts.duration_min is not null                 -- no recorded length, no estimate
      and coalesce(ts.audience, 'everyone') <> 'board' -- a board meeting is not training
      and coalesce(ts.is_offsite, false) = false      -- off-site stays out of station hours
  )
  select
    sa.member_id,
    d.id                       as session_id,
    d.start_at,
    d.start_at + d.credited_len as end_at,
    d.optional
  from drill d
  join public.session_attendance sa on sa.session_id = d.id
  -- LOOSE PREFILTER, on purpose. This is an OVERLAP test, not a containment test:
  -- dept_station_shifts wants drills that START inside the window, while dept_iso_hours
  -- wants any interval that TOUCHES it so a straddling drill can be clipped rather than
  -- dropped. Narrowing this to start_at >= p_from would silently rob the ISO caller of
  -- exactly those rows, so the wider test lives here and each caller narrows its own way.
  and d.start_at < p_to
  and d.start_at + d.credited_len > p_from
  -- OBSERVED WINS. A member who actually checked in has a real interval; the attestation
  -- is not emitted for them at all, which is what stops the same drill being counted twice.
  and not exists (
    select 1 from public.station_presence sp
     where sp.kind = 'training'
       and sp.session_id = sa.session_id
       and sp.member_id  = sa.member_id
  );
$function$;

/* NOBODY CALLS THIS DIRECTLY — not even a signed-in member.

   Invoker rights alone would have left the foreign-p_dept question resting on RLS being tight on
   session_attendance and training_sessions. That is an argument, and an argument is a weaker thing
   to protect a roster with than a permission. Revoking EXECUTE from everyone closes the path
   outright: the only callers left are the two SECURITY DEFINER RPCs, which run as the function's
   owner and are unaffected, and both already gate on is_leadership() before they read anything.

   Belt and braces on purpose. Invoker rights mean a direct call could not escalate; the revoke means
   there is no direct call to reason about.

   NOTE FOR WHOEVER APPLIES THIS: it assumes dept_station_shifts, dept_iso_hours and this function
   share an owner. They do if all were created by the same Supabase role, which is the normal case.
   If ownership ever diverges, the DEFINER functions lose the ability to call this and both RPCs
   start erroring — a loud failure, not a silent one, but worth knowing where to look. Confirm with:
     SELECT proname, pg_get_userbyid(proowner) FROM pg_proc
      WHERE proname IN ('attested_training','dept_station_shifts','dept_iso_hours'); */
REVOKE EXECUTE ON FUNCTION public.attested_training(uuid, timestamptz, timestamptz)
  FROM PUBLIC, authenticated, anon;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only, and all safe: nothing calls this yet.
-- =====================================================================
--
-- HOW TO RUN THESE. Queries 3-5 call the function, and EXECUTE is revoked from
-- everyone, so they only work as the OWNER — which is what the Supabase SQL editor
-- gives you. They will fail from the app, by design.
--
-- SUBSTITUTE A REAL DEPARTMENT ID. my_department_id() reads the JWT, and the SQL
-- editor has no JWT, so it returns NULL and every query below returns zero rows —
-- which looks like a failure and is not one. Get an id first and paste it in:
--     SELECT id, name FROM public.departments ORDER BY name;
--
-- -- 1. Signature and rights. Expect definer=f (invoker), and BOTH anon=f and
-- --    auth=f — the revoke means nobody but the owner can call it.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        format('definer=%s anon=%s auth=%s', prosecdef,
--               has_function_privilege('anon', oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE')) AS rights
--   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='attested_training';
--
-- -- 2. INERT PROOF — nothing references it yet. Expect 0 rows.
-- SELECT proname FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname <> 'attested_training'
--    AND prosrc ILIKE '%attested_training%';
--
-- -- 3. What it would credit for the current year. Every end_at MUST be at most
-- --    90 minutes after its start_at, and no row may belong to a member who has
-- --    an observed training row for that same session.
-- SELECT count(*)                                   AS attested_rows,
--        count(DISTINCT member_id)                  AS members,
--        round(sum(extract(epoch FROM (end_at - start_at)))/3600.0, 2) AS hours,
--        max(extract(epoch FROM (end_at - start_at))/60.0)             AS longest_minutes  -- expect <= 90
--   FROM public.attested_training('<paste-dept-id>'::uuid,
--                                 date_trunc('year', now()), now());
--
-- -- 4. The times must read as local wall-clock, NOT shifted five hours. A 19:00
-- --    drill must show 19:00 here.
-- SELECT session_id, start_at AT TIME ZONE 'America/Chicago' AS local_start,
--        end_at   AT TIME ZONE 'America/Chicago' AS local_end
--   FROM public.attested_training('<paste-dept-id>'::uuid,
--                                 date_trunc('year', now()), now())
--  ORDER BY start_at DESC LIMIT 5;
--
-- -- 4b. OWNERSHIP MUST MATCH across all three, or the DEFINER functions cannot call
-- --     this one and both RPCs error at runtime. Run this AFTER C2.
-- SELECT proname, pg_get_userbyid(proowner) AS owner FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('attested_training','dept_station_shifts','dept_iso_hours');
--
-- -- 5. Optional sessions are FLAGGED, not excluded, here — dept_iso_hours filters
-- --    them out itself. Expect this to show the split.
-- SELECT optional, count(*) FROM public.attested_training('<paste-dept-id>'::uuid,
--                                 date_trunc('year', now()), now()) GROUP BY 1;
