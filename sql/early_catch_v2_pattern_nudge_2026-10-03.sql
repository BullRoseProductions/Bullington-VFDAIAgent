-- =====================================================================
-- EARLY CATCH V2 — PER-MEMBER PATTERN LEARNING + SELF-REVIEW NUDGE.
--
-- NOT APPLIED. Review, then run by hand.
--
-- WHAT V1 LEFT ON THE TABLE. V1 flags an open fenced shift once it passes ONE
-- number for the whole department (departments.expected_shift_hours, default
-- 28) and shows it to a Department Admin. That is the right safety net and it
-- is untouched here. But 28 hours is a long time to carry a phantom, and it is
-- the same 28 hours for the member whose shifts are always four and the member
-- who genuinely sleeps at the station. For the first member, a shift that is
-- already six hours past anything they have ever worked is obviously wrong
-- twenty-two hours before anyone is told.
--
-- WHAT V2 ADDS. Two things, both additive:
--   1. A per-member baseline learned from that member's own closed fenced
--      shifts, so "unusually long" means unusual FOR THEM.
--   2. A nudge to the MEMBER, early, routed through the pulse engine.
--
-- THIS FILE CLOSES NOTHING. It creates two read-only functions and widens one
-- enum check. No UPDATE statement appears below. The backstop, the review
-- queue, dept_open_long_shifts() and close_open_shift() are all untouched, and
-- close_open_shift() remains the only way a stuck shift gets an out-time —
-- which keeps every correction admin-reviewed, exactly as V1 designed it.
--
-- VERIFIED IS NEVER WRITTEN. It is not in any update here because there is no
-- update here. It is not even read into the baseline: whether a member was
-- confirmed on station when a shift BEGAN says nothing about how long they
-- normally stay, and conflating the two would let a run of unverified arrivals
-- quietly reshape someone's expected shift length.
--
-- ---------------------------------------------------------------------
-- WHY THE DETECTION FUNCTION IS NOT dept_open_long_shifts().
--
-- The brief says reuse V1's reads, and the ADMIN PANEL does — unchanged. The
-- server cannot. dept_open_long_shifts() opens with
--
--     v_dept uuid := public.my_department_id();
--     if not public.is_dept_admin() then raise exception 'Not authorized';
--
-- Both read the caller's JWT. api/pulse.js runs from Vercel Cron on the SERVICE
-- ROLE: there is no JWT, my_department_id() is null, is_dept_admin() is false,
-- and the call would raise 'Not authorized' on every run. Section 2 is the
-- cross-department equivalent the cron can actually call, and it is granted to
-- service_role ONLY — never to authenticated, because a function that returns
-- every department's open shifts is precisely what dept-scoping exists to
-- prevent.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume. Same discipline as V1.
-- ---------------------------------------------------------------------
do $pre$
begin
  if not exists (select 1 from pg_proc
                  where pronamespace = 'public'::regnamespace and proname = 'dept_open_long_shifts') then
    raise exception 'Precondition failed: V1 (dept_open_long_shifts) is not installed. V2 is an addition to V1, not a replacement — install V1 first.';
  end if;

  if not exists (select 1 from pg_proc
                  where pronamespace = 'public'::regnamespace and proname = 'close_open_shift') then
    raise exception 'Precondition failed: close_open_shift() missing. It is the only route a nudged member''s correction can take; without it the nudge leads nowhere.';
  end if;

  -- auto_closed is load-bearing for the baseline: a sweeper-closed row was
  -- closed AT THE CAP, so including those would teach the model that this
  -- member routinely works 36 hours and raise their threshold toward the very
  -- number V2 exists to beat. If the column is missing, the baseline would be
  -- computed from exactly the wrong rows.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'station_presence' and column_name = 'auto_closed') then
    raise exception 'Precondition failed: station_presence.auto_closed missing. The baseline MUST exclude sweeper-closed shifts; without this column it cannot.';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'departments' and column_name = 'expected_shift_hours') then
    raise exception 'Precondition failed: departments.expected_shift_hours missing (added by V1). It is the fallback and the cap.';
  end if;

  if not exists (select 1 from pg_proc
                  where pronamespace = 'public'::regnamespace and proname = 'is_muted') then
    raise exception 'Precondition failed: is_muted() missing. Section 3 widens it; it cannot widen what is not there.';
  end if;
end
$pre$;


-- ---------------------------------------------------------------------
-- 1. member_shift_baselines() — what "normal" means, per member.
--
-- MEDIAN AND IQR, NOT MEAN AND STANDARD DEVIATION. The thing being measured is
-- contaminated by the exact failure this feature exists to catch: a member with
-- three phantom 30-hour shifts in their history has a mean and a standard
-- deviation dragged so far right that they would never be nudged again. The
-- median and the interquartile range both ignore the tails by construction, so
-- a handful of past phantoms cannot raise the bar that catches the next one.
--
-- WHAT COUNTS AS A SAMPLE. Closed, fenced, standby/offsite, and NOT
-- auto-closed. The auto_closed exclusion is the important one and is explained
-- in section 0. Shorter than 15 minutes is dropped as a mis-fire rather than a
-- shift. The 180-day window keeps the baseline current — a member who moved
-- from weekend standbys to weeknight cover should not be measured against last
-- winter.
--
-- STABLE, not IMMUTABLE: reads now() and the table.
-- ---------------------------------------------------------------------
create or replace function public.member_shift_baselines()
 returns table(
   member_id      uuid,
   department_id  uuid,
   sample_count   integer,
   median_hours   numeric,
   iqr_hours      numeric
 )
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with closed as (
    select sp.member_id,
           sp.department_id,
           extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0 as hours
      from public.station_presence sp
     where sp.checked_out_at is not null
       and sp.source   = 'gps_geofence'                    -- fenced only, matching V1's read
       and sp.kind in ('standby', 'offsite')               -- training closes at finalize, not at a boundary
       and sp.auto_closed is not true                      -- NEVER learn from a sweeper-closed row
       and sp.checked_in_at >= now() - interval '180 days'
       and sp.checked_out_at > sp.checked_in_at
       and extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0 >= 0.25
  )
  select member_id,
         department_id,
         count(*)::integer,
         round(percentile_cont(0.5)  within group (order by hours)::numeric, 3),
         round((percentile_cont(0.75) within group (order by hours)
              - percentile_cont(0.25) within group (order by hours))::numeric, 3)
    from closed
   group by member_id, department_id;
$function$;

-- Readable by the server only. A member's shift pattern is not something one
-- member should be able to read about another, and nothing in the client needs
-- this: the client reads its own open shift and is told the threshold, not the
-- distribution.
revoke all    on function public.member_shift_baselines() from anon, public, authenticated;
grant execute on function public.member_shift_baselines() to service_role;


-- ---------------------------------------------------------------------
-- 2. open_shift_nudge_candidates(p_k, p_min_sample, p_floor_hours)
--    — the cross-department read the cron calls.
--
-- THE THRESHOLD, and why each clamp is there:
--
--   raw   = median + k * GREATEST(LEAST(iqr, median), 0.5)
--           The 0.5h minimum spread protects the metronomic member. Someone
--           whose last twenty shifts were all 4.00 hours has an IQR of zero,
--           and median + k*0 would nudge them four hours and one minute in,
--           every single shift.
--
--           THE IQR IS CAPPED AT THE MEMBER'S OWN MEDIAN, and that clamp was
--           added after the first live dry run, which found the opposite of
--           what it was looking for. The median resists contamination from past
--           phantom shifts — that is why it was chosen. THE IQR DOES NOT. A
--           member with a history of stuck shifts has an upper quartile dragged
--           up by them, so their learned threshold drifts toward the flat
--           default and they stop being catchable. On live data one member sat
--           25 hours into an open shift with a median of 4.1h and an IQR of
--           7.9h, giving a threshold of 27.8h — he would not have been nudged
--           before the backstop, which is precisely the member this feature
--           exists for. Capping the spread at the median says: however erratic
--           the history looks, "unusual" can never mean more than one typical
--           shift's worth of slack per k.
--
--   floor = p_floor_hours (default 3h)
--           Nobody is told their hours look wrong three hours into a shift.
--           Below this the nudge stops being a safety net and becomes a tic.
--
--   cap   = coalesce(d.expected_shift_hours, 28) — V1's flat threshold.
--           SO V2 CAN ONLY EVER FIRE EARLIER THAN V1, NEVER LATER. This is the
--           property that makes the feature safe to ship: whatever the learned
--           baseline says, the admin flag still lands when it always did, and
--           V2 can only move the member-facing nudge forward of it. A member
--           with genuinely long shifts gets the old behaviour, not a worse one.
--
-- TOO LITTLE HISTORY FALLS BACK TO THE FLAT THRESHOLD, which — given the cap
-- above — means a new member is nudged at the same moment the admin is flagged.
-- Not earlier, not never. That is the honest answer when we know nothing about
-- them yet, and it is why p_min_sample can be raised without creating a silent
-- hole.
--
-- RETURNS CANDIDATES ONLY. No write, no close, no stamp. Everything about
-- whether a nudge is actually SENT — mute, dedup, drain window, send window —
-- is decided by the pulse engine downstream, because that is where those rules
-- already live and a second copy of them here is how they drift.
-- ---------------------------------------------------------------------
create or replace function public.open_shift_nudge_candidates(
  p_k            numeric default 3.0,
  p_min_sample   integer default 5,
  p_floor_hours  numeric default 3.0
)
 returns table(
   shift_id         uuid,
   member_id        uuid,
   member_name      text,
   department_id    uuid,
   checked_in_at    timestamptz,
   hours_open       numeric,
   threshold_hours  numeric,
   baseline_median  numeric,
   baseline_iqr     numeric,
   sample_count     integer,
   basis            text
 )
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with b as (select * from public.member_shift_baselines())
  select sp.id,
         m.id,
         m.name,
         sp.department_id,
         sp.checked_in_at,
         round((extract(epoch from (now() - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours_open,
         t.threshold_hours,
         b.median_hours,
         b.iqr_hours,
         coalesce(b.sample_count, 0),
         case when b.sample_count >= p_min_sample then 'learned' else 'dept_default' end
    from public.station_presence sp
    join public.members m      on m.id = sp.member_id
    join public.departments d  on d.id = sp.department_id
    left join b                on b.member_id = sp.member_id
   cross join lateral (
     select case
              when b.sample_count >= p_min_sample
              then least(
                     greatest(b.median_hours + p_k * greatest(least(b.iqr_hours, b.median_hours), 0.5), p_floor_hours),
                     coalesce(d.expected_shift_hours, 28)::numeric)
              else coalesce(d.expected_shift_hours, 28)::numeric
            end as threshold_hours
   ) t
   where sp.checked_out_at is null                 -- still open: nobody has stopped this clock
     and sp.source = 'gps_geofence'                -- fenced only, matching V1
     and sp.kind in ('standby', 'offsite')
     and now() - sp.checked_in_at > t.threshold_hours * interval '1 hour'
   order by sp.checked_in_at asc;
$function$;

revoke all    on function public.open_shift_nudge_candidates(numeric, integer, numeric) from anon, public, authenticated;
grant execute on function public.open_shift_nudge_candidates(numeric, integer, numeric) to service_role;


-- ---------------------------------------------------------------------
-- 3. is_muted(): add the 'shifts' family.
--
-- A NEW FAMILY RATHER THAN REUSING 'tasks'. The duty summary reused tasks and
-- that was right — a duty IS a task. This is not. Muting "Tasks & assignments"
-- must not also switch off the only message that tells a member their recorded
-- hours are wrong, because those hours feed ISO and LOSAP and the member is the
-- only person who knows when they actually left.
--
-- The body is reproduced verbatim from sql/notification_prefs.sql with ONE
-- string added to the IN list. Read the diff as exactly that.
--
-- AFTER RUNNING THIS, two client-side changes are needed for the opt-out to be
-- real, and both ship with the app, not here:
--   • api/pulse.js   FAMILIES must include 'shifts' (done in this change).
--   • Notifications.jsx MUTABLE_FAMILIES needs a 'shifts' row, or the family is
--     mutable in the database and invisible in the UI — a control that exists
--     and cannot be reached, which that file's own comment calls out as worse
--     than no control at all.
-- ---------------------------------------------------------------------
create or replace function public.is_muted(p_member uuid, p_family text)
 returns boolean
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_enabled boolean;
begin
  IF p_family IS NULL OR p_family NOT IN ('certs','gear','maint','events','tasks','shifts') THEN
    RAISE EXCEPTION 'is_muted: unknown notification family %. A typo here would silently ignore a member''s opt-out.', coalesce(p_family, '<null>');
  END IF;

  select enabled into v_enabled
    from public.notification_prefs
   where member_id = p_member and family = p_family;

  -- ABSENCE MEANS ON, matching the client: a member who has never opened the
  -- preferences screen has no row, and no row is not an opt-out.
  return v_enabled is not null and v_enabled = false;
end;
$function$;


-- ---------------------------------------------------------------------
-- 4. VERIFICATION — run after committing, and read the output.
-- ---------------------------------------------------------------------
do $post$
begin
  -- Neither new function may be reachable by a logged-in member.
  if has_function_privilege('authenticated', 'public.member_shift_baselines()', 'execute')
     or has_function_privilege('anon', 'public.member_shift_baselines()', 'execute') then
    raise exception 'Post-condition failed: member_shift_baselines() is reachable by a client role. It returns every member''s pattern.';
  end if;

  if has_function_privilege('authenticated', 'public.open_shift_nudge_candidates(numeric, integer, numeric)', 'execute')
     or has_function_privilege('anon', 'public.open_shift_nudge_candidates(numeric, integer, numeric)', 'execute') then
    raise exception 'Post-condition failed: open_shift_nudge_candidates() is reachable by a client role. It crosses department boundaries by design and must stay server-only.';
  end if;

  -- The widened family must actually be accepted, and an unknown one must still raise.
  perform public.is_muted('00000000-0000-0000-0000-000000000000'::uuid, 'shifts');
  begin
    perform public.is_muted('00000000-0000-0000-0000-000000000000'::uuid, 'nonsense');
    raise exception 'Post-condition failed: is_muted accepted an unknown family. The raise-on-typo guard is gone.';
  exception when others then
    null;   -- expected
  end;

  -- V1 must still be exactly where it was.
  if not exists (select 1 from pg_proc where pronamespace='public'::regnamespace and proname='dept_open_long_shifts')
     or not exists (select 1 from pg_proc where pronamespace='public'::regnamespace and proname='close_open_shift') then
    raise exception 'Post-condition failed: a V1 function is missing after this run. V2 must be purely additive.';
  end if;
end
$post$;

-- PostgREST caches the schema; without this the first call 404s against a
-- function that exists. Same reason V1 ends this way.
notify pgrst, 'reload schema';

commit;
