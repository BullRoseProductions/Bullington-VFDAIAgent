-- =====================================================================
-- EARLY CATCH FOR STUCK-OPEN STATION SHIFTS — V1.
--
-- NOT APPLIED. Review, then run by hand.
--
-- THE PROBLEM. A missed geofence EXIT leaves a fenced shift OPEN. Nothing closes
-- it until the 36/40h backstop fires, and the backstop closes it AT THE CAP —
-- so a member who left after two hours can end up with a 34-hour phantom that
-- an officer then has to unpick from the review queue after the fact.
--
-- THE SHAPE OF THE FIX. Surface the shift while it is still open, so a human
-- closes it at the time the member actually left instead of correcting a
-- fiction later. PURELY ADDITIVE: this file closes nothing on its own, lowers
-- no backstop, and leaves auto_close_stale_shifts() and
-- dept_shifts_needing_review() untouched. It adds a flag, a read, and one
-- deliberate human action.
--
-- WHY A SEPARATE READ AND NOT AN EXTRA COLUMN ON THE REVIEW QUEUE. The queue
-- answers "the machine guessed a stop time — what was the real one?". This
-- answers "nobody has stopped this clock at all — is that person still there?".
-- Different question, different urgency, and one is about a CLOSED row while
-- the other is about an OPEN one. Folding them would have meant changing the
-- queue's return shape, which is explicitly out of scope.
--
-- ---------------------------------------------------------------------
-- THE GATE, AND THE ONE THING TO CHECK BEFORE RUNNING THIS.
--
-- Hour editing is ADMIN-ONLY here, not leadership. is_leadership() includes
-- Officers, and an Officer editing the hours that feed ISO/LOSAP is a wider
-- boundary than this department wants. Section 4 tightens the two EXISTING hour
-- edits to match; that is the only change this file makes to existing
-- functions.
--
-- THE HELPER IS NAMED is_dept_admin(), not is_department_admin(). The repo
-- contains 34 uses of the former and 4 mentions of the latter, one of which is
-- a REVOKE line that may have been written speculatively. Section 0 asserts the
-- name rather than trusting it: if the gate this file references does not
-- exist, NOTHING is created, because a SECURITY DEFINER function referencing a
-- missing gate would still CREATE successfully — plpgsql resolves function
-- calls at run time — and would then raise 'function does not exist' at the
-- first officer who clicked the button, on production, having already granted
-- EXECUTE. A migration that installs a broken authorization boundary is worse
-- than one that refuses to install.
--
-- PROJECT ADMIN IS ALREADY INSIDE is_dept_admin(), so no widening is needed and
-- the support account keeps access. That is stated in the apparatus-delete
-- hardening file in as many words — "The second is what stops a Project Admin,
-- who is inside is_dept_admin(), reaching another department's fleet" — and it
-- matches the client, where DEPT_ADMIN_ROLES is ["Department Admin",
-- "Project Admin"]. Section 0 asserts it behaviourally as well, because a
-- comment in another file is evidence, not proof.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
do $pre$
begin
  if not exists (select 1 from pg_proc
                  where pronamespace = 'public'::regnamespace
                    and proname = 'is_dept_admin') then
    raise exception 'Precondition failed: public.is_dept_admin() does not exist. It is the entire authorization boundary for every function below — find the real name before going further, and do not substitute is_leadership().';
  end if;

  if not exists (select 1 from pg_proc
                  where pronamespace = 'public'::regnamespace
                    and proname = 'my_department_id') then
    raise exception 'Precondition failed: public.my_department_id() does not exist. Without it nothing below is department-scoped.';
  end if;

  -- The two functions section 4 rewrites must already be there. CREATE OR
  -- REPLACE on a missing function would silently INSTALL a new one instead of
  -- tightening an existing one, and the difference matters: if the real
  -- resolve_auto_closed_shift lives under another signature, this file would
  -- leave the loose one in place beside a tightened impostor nothing calls.
  if not exists (select 1 from pg_proc p
                  where p.pronamespace = 'public'::regnamespace
                    and p.proname = 'resolve_auto_closed_shift'
                    and pg_get_function_identity_arguments(p.oid) = 'p_shift_id uuid, p_checked_out_at timestamp with time zone') then
    raise exception 'Precondition failed: resolve_auto_closed_shift(uuid, timestamptz) not found with that exact signature. Section 4 would create a second function rather than tighten the live one.';
  end if;

  if not exists (select 1 from pg_proc p
                  where p.pronamespace = 'public'::regnamespace
                    and p.proname = 'void_auto_closed_shift'
                    and pg_get_function_identity_arguments(p.oid) = 'p_shift_id uuid') then
    raise exception 'Precondition failed: void_auto_closed_shift(uuid) not found with that exact signature.';
  end if;
end
$pre$;


-- ---------------------------------------------------------------------
-- 1. THE THRESHOLD. Per department, nullable.
--
-- NULL is not "no threshold" — it is "use the built-in 28". Storing the default
-- in every row instead would mean a future change to the default silently
-- skipping every department that had already been written.
-- ---------------------------------------------------------------------
alter table public.departments
  add column if not exists expected_shift_hours integer;

comment on column public.departments.expected_shift_hours is
  'Hours after which an OPEN fenced shift is FLAGGED for a Department Admin to look at. '
  'NULL means use the built-in default of 28. '
  'THIS IS NOT A CAP. It closes nothing, credits nothing and changes no hours. It only '
  'decides when a still-open shift appears in the "may have missed a checkout" list. The '
  'hard stop is still the geofence backstop (departments.geofence_backstop_hours), which is '
  'a different setting with different consequences and is deliberately left alone.';


-- ---------------------------------------------------------------------
-- 2. dept_open_long_shifts() — the read.
--
-- FENCED SHIFTS ONLY (source = 'gps_geofence'). A manual check-in that is still
-- open is a member who forgot to tap out, which is a different conversation and
-- has never been auto-closed by fence logic. Training rows are excluded for the
-- same reason: a drill's clock is closed by finalizing the session, not by
-- walking out of a polygon.
--
-- STABLE, not IMMUTABLE: it reads now() and the table.
-- ---------------------------------------------------------------------
create or replace function public.dept_open_long_shifts()
 returns table(
   shift_id      uuid,
   member_id     uuid,
   member_name   text,
   kind          text,
   source        text,
   checked_in_at timestamptz,
   hours_open    numeric,
   verified      boolean
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_dept uuid := public.my_department_id();
begin
  -- ADMIN ONLY. Deliberately not is_leadership(): see the header.
  if not public.is_dept_admin() then
    raise exception 'Not authorized';
  end if;

  return query
    select sp.id,
           m.id,
           m.name,
           sp.kind,
           sp.source,
           sp.checked_in_at,
           round((extract(epoch from (now() - sp.checked_in_at)) / 3600.0)::numeric, 2),
           sp.verified
      from public.station_presence sp
      join public.members m     on m.id = sp.member_id
      join public.departments d on d.id = sp.department_id
     where sp.department_id   = v_dept
       and sp.checked_out_at is null                 -- still open: nobody has stopped this clock
       and sp.source          = 'gps_geofence'       -- fenced only; a forgotten manual tap-out is a different problem
       and sp.kind in ('standby', 'offsite')         -- training closes at finalize, not at a boundary
       and now() - sp.checked_in_at
             > coalesce(d.expected_shift_hours, 28) * interval '1 hour'
     order by sp.checked_in_at asc;                  -- oldest first: this is a work list, like the review queue
end;
$function$;

-- anon IS NAMED EXPLICITLY. Supabase re-grants it on CREATE, and the ACL
-- capture/replay pattern does not restore revokes — so this line is what makes
-- the function authenticated-only, not the SECURITY DEFINER declaration.
revoke all    on function public.dept_open_long_shifts() from anon, public;
grant execute on function public.dept_open_long_shifts() to authenticated;


-- ---------------------------------------------------------------------
-- 3. close_open_shift(p_shift_id, p_checked_out_at) — the human answer.
--
-- There is no path today for an admin to close ANOTHER member's open shift.
-- geofence_depart closes your own; resolve_auto_closed_shift corrects a row the
-- sweeper already closed. This is the missing third case, and it is the reason
-- the read above is worth having.
--
-- FOR UPDATE BEFORE VALIDATING, matching resolve_auto_closed_shift. Two admins
-- acting on the same shift cannot interleave: the second waits, then finds
-- checked_out_at already set and is told so rather than overwriting the first
-- one's answer with a different time.
--
-- EVERY REJECTION RAISES. A guardrail that quietly no-ops when handed a bad id
-- is worse than one that refuses loudly — the UI would report success and the
-- shift would still be open.
--
-- auto_closed = false is set EXPLICITLY rather than left alone. The row was
-- never auto-closed, so it is already false; writing it states that a human
-- decided this out-time, and makes the row indistinguishable from any other
-- human-confirmed close for everything downstream that keys on that flag.
--
-- WHAT THIS DOES NOT WRITE. The update sets two columns. The arrival verdict is
-- decided at check-in and latched; how a shift ENDS cannot retroactively change
-- whether the member was confirmed on station when it BEGAN. The column is
-- returned to the caller — the officer needs to see it — but it is absent from
-- the update by construction, and the test file asserts the update's column
-- list structurally rather than by grepping for a name.
-- ---------------------------------------------------------------------
create or replace function public.close_open_shift(
  p_shift_id       uuid,
  p_checked_out_at timestamptz
)
 returns table(
   shift_id       uuid,
   checked_in_at  timestamptz,
   checked_out_at timestamptz,
   auto_closed    boolean,
   verified       boolean,
   hours          numeric
 )
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_dept uuid := public.my_department_id();
  v_row  public.station_presence;
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized';
  end if;
  if p_checked_out_at is null then
    raise exception 'Enter the time the member actually left.';
  end if;

  select * into v_row
    from public.station_presence
   where id = p_shift_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That shift was not found in your department.';
  end if;
  -- Already closed: never overwrite. Whoever set it — the sweeper, a departure
  -- event, another admin — recorded something, and silently replacing it would
  -- destroy the only record that it happened.
  if v_row.checked_out_at is not null then
    raise exception 'That shift is already closed.';
  end if;
  if p_checked_out_at <= v_row.checked_in_at then
    raise exception 'The out-time must be after the member checked in.';
  end if;
  if p_checked_out_at > now() then
    raise exception 'The out-time cannot be in the future.';
  end if;

  update public.station_presence
     set checked_out_at = p_checked_out_at,
         auto_closed    = false
   where id = p_shift_id
  returning * into v_row;

  return query
    select v_row.id,
           v_row.checked_in_at,
           v_row.checked_out_at,
           v_row.auto_closed,
           v_row.verified,
           round((extract(epoch from (v_row.checked_out_at - v_row.checked_in_at)) / 3600.0)::numeric, 2);
end;
$function$;

revoke all    on function public.close_open_shift(uuid, timestamptz) from anon, public;
grant execute on function public.close_open_shift(uuid, timestamptz) to authenticated;


-- ---------------------------------------------------------------------
-- 4. TIGHTEN THE EXISTING HOUR EDITS to the same gate.
--
-- Bodies are otherwise UNCHANGED — reproduced verbatim from
-- sql/slice6_autoclose_review.sql with one line different in each. Read the
-- diff as exactly that: is_leadership() -> is_dept_admin(), nothing else.
--
-- WHY NOW rather than as a separate file: a new admin-only close action beside
-- two leadership-wide corrections of the same numbers is not a boundary, it is
-- a detour. An Officer who cannot close an open shift but can void a closed one
-- has the same reach by a slower route.
--
-- DELIBERATELY NOT TOUCHED: approve_offsite (officers keep offsite approval —
-- that is a judgement about whether work counted, not an edit to a clock),
-- auto_close_stale_shifts (the backstop), and dept_shifts_needing_review (a
-- read; its return shape is out of scope).
--
-- GRANTS ARE RE-STATED even though CREATE OR REPLACE preserves an existing ACL.
-- Stating them costs nothing and makes the file correct if it is ever run
-- against a database where these were dropped and recreated.
-- ---------------------------------------------------------------------
create or replace function public.resolve_auto_closed_shift(
  p_shift_id       uuid,
  p_checked_out_at timestamptz
) returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_dept uuid := public.my_department_id();
  v_row  public.station_presence;
begin
  if not public.is_dept_admin() then          -- was is_leadership()
    raise exception 'Not authorized';
  end if;
  if p_checked_out_at is null then
    raise exception 'Enter the time the member actually left.';
  end if;

  select * into v_row
    from public.station_presence
   where id = p_shift_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That shift was not found in your department.';
  end if;
  if not v_row.auto_closed then
    raise exception 'That shift has already been reviewed.';
  end if;
  if p_checked_out_at <= v_row.checked_in_at then
    raise exception 'The out-time must be after the member checked in.';
  end if;
  if p_checked_out_at > now() then
    raise exception 'The out-time cannot be in the future.';
  end if;

  update public.station_presence
     set checked_out_at = p_checked_out_at,
         auto_closed    = false
   where id = p_shift_id;
end;
$function$;

revoke all    on function public.resolve_auto_closed_shift(uuid, timestamptz) from anon, public;
grant execute on function public.resolve_auto_closed_shift(uuid, timestamptz) to authenticated;


create or replace function public.void_auto_closed_shift(p_shift_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_dept uuid := public.my_department_id();
  v_row  public.station_presence;
begin
  if not public.is_dept_admin() then          -- was is_leadership()
    raise exception 'Not authorized';
  end if;

  select * into v_row
    from public.station_presence
   where id = p_shift_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That shift was not found in your department.';
  end if;
  if not v_row.auto_closed then
    raise exception 'That shift has already been reviewed.';
  end if;

  update public.station_presence
     set checked_out_at = v_row.checked_in_at,   -- zero duration: kept, credits nothing
         auto_closed    = false
   where id = p_shift_id;
end;
$function$;

revoke all    on function public.void_auto_closed_shift(uuid) from anon, public;
grant execute on function public.void_auto_closed_shift(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 5. POST-CONDITIONS — the grants actually took, and the update is narrow.
--
-- Checked HERE, inside the same transaction, so a file that installs a
-- publicly-executable hour-editing function rolls itself back instead of
-- shipping. The anon check is the one that has bitten this codebase before.
-- ---------------------------------------------------------------------
do $post$
declare
  v_bad text;
begin
  select string_agg(f, ', ') into v_bad from (
    select 'dept_open_long_shifts' as f
     where has_function_privilege('anon', 'public.dept_open_long_shifts()', 'execute')
    union all
    select 'close_open_shift'
     where has_function_privilege('anon', 'public.close_open_shift(uuid, timestamptz)', 'execute')
    union all
    select 'resolve_auto_closed_shift'
     where has_function_privilege('anon', 'public.resolve_auto_closed_shift(uuid, timestamptz)', 'execute')
    union all
    select 'void_auto_closed_shift'
     where has_function_privilege('anon', 'public.void_auto_closed_shift(uuid)', 'execute')
  ) s;
  if v_bad is not null then
    raise exception 'Post-condition failed: anon can execute %. Rolling back.', v_bad;
  end if;

  -- STRUCTURAL, NOT A NAME GREP. prosrc includes comments, so asking whether the
  -- body MENTIONS the arrival-verdict column would be answered "yes" by this
  -- function's own RETURNS TABLE list — which is a read, not a write. What
  -- matters is whether any SET assigns it.
  --
  -- `set[^;]*verified\s*=` scans from a SET keyword to the next statement
  -- terminator, so it sees assignments inside the UPDATE and nothing outside it.
  -- This is the form verified_latch.sql documents for exactly this question;
  -- an earlier draft here matched the two expected lines by layout instead, which
  -- would have failed on a reindent and rolled back a correct migration.
  if exists (select 1 from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname in ('close_open_shift', 'resolve_auto_closed_shift', 'void_auto_closed_shift')
                and prosrc ~* 'set[^;]*verified\s*=') then
    raise exception 'Post-condition failed: an hour-editing function ASSIGNS the arrival verdict. That column is latched at check-in and must never be rewritten by a close or a correction.';
  end if;

  -- And the two columns it should write are in fact written.
  if not (select prosrc ~* 'set\s+checked_out_at\s*=\s*p_checked_out_at'
              and prosrc ~* 'auto_closed\s*=\s*false'
            from pg_proc
           where pronamespace = 'public'::regnamespace and proname = 'close_open_shift') then
    raise exception 'Post-condition failed: close_open_shift does not set both checked_out_at and auto_closed. Read the body before trusting what it writes.';
  end if;
end
$post$;

commit;

-- After commit, on the live database:
--   notify pgrst, 'reload schema';
-- Without it the client's first dept_open_long_shifts() call 404s against a
-- schema cache that predates the function.
