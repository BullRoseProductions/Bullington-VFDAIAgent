-- =====================================================================
-- TRAINING HOURS, PART A — drill attendance produces hours.
--
-- NOT YET APPLIED. Review, then run by hand. Part B (the dept_iso_hours
-- auto_closed fix) is a SEPARATE file so it can be reviewed or reverted
-- on its own.
--
-- THE PROBLEM. A member only earned training hours by self-checking in with
-- location. member_check_in only writes a station_presence row when
-- `v_verified OR NOT v_pinned`, so at a pinned department a member who was
-- present but not geo-verified — and anyone an officer simply marked present —
-- got attendance and ZERO hours. A three-hour drill with twenty attendees
-- reported about five hours.
--
-- THE SHAPE OF THE FIX. Attendance-derived hours are computed at READ time and
-- unioned into dept_station_shifts. They are never written to station_presence.
--
-- WHY NOT SYNTHESISE ROWS. member_check_in inserts with
--   ON CONFLICT (member_id, session_id) WHERE kind='training' DO NOTHING
-- so a derived row sitting in that slot would make a REAL geo check-in silently
-- do nothing: the member stays unverified despite having checked in properly,
-- and an estimate outranks observed evidence in the ledger that feeds ISO/LOSAP.
-- Deriving at read time inverts that — the observed row always wins, by
-- construction, via the NOT EXISTS below.
--
-- WHY IN THIS FUNCTION rather than in the client. Every reader already calls
-- dept_station_shifts: the Station Hours screen, the standalone PDF, the Chief's
-- Report and the Agenda. Merging here means all four agree with no client change
-- and no fourth copy of the rule to drift.
--
-- CREDIT POLICY IS UNCHANGED. Derived rows carry verified = false, so:
--   • the shared rollup buckets them as recorded-not-credited automatically;
--   • dept_iso_hours already filters `and sp.verified`, so ISO cannot absorb
--     them — no change to that function is needed for this part.
--
-- WHAT DOES NOT PRODUCE HOURS, and why:
--   • audience = 'board'      — a board meeting is not training. Attending one
--                               must never read as drill time.
--   • is_offsite = true       — off-site is excluded from station hours
--                               everywhere; attendance must not leak it back in.
--   • done = false            — a drill that has not happened has no hours.
--   • duration_min IS NULL    — length not recorded. No length, no estimate:
--                               inventing one would be worse than showing none.
--   • a member with a real training presence row for that session — observed wins.
-- audience = 'leadership' DOES produce hours: the app labels it "Leadership
-- training", and it is training.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The drill's length. NULLABLE ON PURPOSE.
--
-- NULL means "length not recorded", which is a different fact from zero. The
-- officer may not know the length until the drill closes, and the finalize
-- prompt is skippable — so NULL has to remain a valid, permanent state that
-- simply produces no attendance hours.
-- ---------------------------------------------------------------------
ALTER TABLE public.training_sessions
  ADD COLUMN IF NOT EXISTS duration_min smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'training_sessions_duration_range'
                    AND conrelid = 'public.training_sessions'::regclass) THEN
    ALTER TABLE public.training_sessions
      ADD CONSTRAINT training_sessions_duration_range
      CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 1440);
    RAISE NOTICE 'duration_min range CHECK added (1..1440 minutes, or NULL).';
  ELSE
    RAISE NOTICE 'duration_min range CHECK already present.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. dept_station_shifts — observed rows UNION attendance-derived rows.
--
-- DROP + CREATE, not CREATE OR REPLACE: the RETURNS TABLE signature gains
-- `source` and `optional`, and Postgres will not replace a function whose
-- output columns change.
--
-- `source` lets the UI say WHERE a row came from — "Clocked" for an observed
-- punch, "From attendance" for a derived one. Without it every derived row would
-- display as though someone had stood at a clock, which is precisely the
-- misreading this whole change is trying to avoid.
--
-- `optional` carries counts_toward_attendance so an off-hours or one-off session
-- can be shown as such. Those DO produce recorded hours — the member still
-- trained — but they are not mandatory-drill time and should not be read as it.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.dept_station_shifts(timestamptz, timestamptz);

CREATE FUNCTION public.dept_station_shifts(
  p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()),
  p_to   timestamp with time zone DEFAULT now()
)
 RETURNS TABLE(member_id uuid, member_name text, checked_in_at timestamp with time zone,
               checked_out_at timestamp with time zone, hours numeric, kind text,
               verified boolean, auto_closed boolean, source text, optional boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  return query
    -- A. OBSERVED — unchanged from the original body, plus the two new columns.
    select m.id, m.name, sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours,
           sp.kind, sp.verified, sp.auto_closed,
           coalesce(sp.source, 'geo')::text as source,
           false as optional
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    where sp.department_id = v_dept
      and sp.checked_out_at is not null
      and sp.kind in ('standby','training')          -- NEVER incident (Before the Call)
      and sp.checked_in_at >= p_from
      and sp.checked_in_at <  p_to

    union all

    -- B. ATTENDANCE-DERIVED — everyone marked present at a finished drill that has
    -- a recorded length and no observed training row of their own.
    --
    -- TIMEZONE — HARDCODED TO CENTRAL, DELIBERATELY, AND THIS IS A KNOWN LIMIT.
    -- training_sessions.date + start_time is a WALL-CLOCK time with no zone: a drill at
    -- "19:00" means seven in the evening where the department is. Interpreting it with
    -- current_setting('TimeZone') would read it in the SERVER's zone — Supabase runs UTC —
    -- so a 7pm drill would render as 2pm and a drill near midnight on the 1st or the 31st
    -- could fall into the wrong reporting period entirely. The HOURS are unaffected either
    -- way (duration_min is a length, not a difference of two instants); what breaks is the
    -- displayed in/out times and the window placement at month boundaries.
    -- Every department is Central Texas today, so the zone is stated outright rather than
    -- inherited from wherever the database happens to run. WHEN A NON-CENTRAL DEPARTMENT IS
    -- ONBOARDED this must become a per-department timezone column (departments.timezone,
    -- IANA name) read here instead of the literal — at which point every other place that
    -- turns a wall-clock into an instant needs the same treatment.
    --
    -- The window is applied to the drill's start instant, the same way the observed
    -- half windows on checked_in_at, so a report period means the same thing for both.
    select m.id, m.name,
           (ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago' as checked_in_at,
           ((ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago')
             + make_interval(mins => ts.duration_min)                                                  as checked_out_at,
           round((ts.duration_min / 60.0)::numeric, 2)   as hours,
           'training'::text                              as kind,
           false                                         as verified,   -- recorded, never credited
           false                                         as auto_closed,
           'attendance'::text                            as source,
           (coalesce(ts.counts_toward_attendance, true) = false) as optional
    from public.session_attendance sa
    join public.training_sessions ts on ts.id = sa.session_id
    join public.members m           on m.id = sa.member_id
    where ts.department_id = v_dept
      and ts.done
      and ts.duration_min is not null
      and coalesce(ts.audience, 'everyone') <> 'board'     -- a board meeting is not training
      and coalesce(ts.is_offsite, false) = false           -- off-site stays out of station hours
      and ((ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago') >= p_from
      and ((ts.date + coalesce(ts.start_time, '00:00'::time)) at time zone 'America/Chicago') <  p_to
      -- OBSERVED WINS. One source per (member, session), enforced here rather than
      -- hoped for: if the member has a real training presence row for this drill,
      -- their clocked duration is the truth and the estimate is not emitted at all.
      and not exists (
        select 1 from public.station_presence sp2
         where sp2.kind = 'training'
           and sp2.session_id = sa.session_id
           and sp2.member_id  = sa.member_id
      )
    order by 3 desc;
end;
$function$;

-- DROP discards the ACL, so these must be restated. Values match what was live
-- before this migration: anon=false, authenticated=true, public=false.
REVOKE ALL ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
