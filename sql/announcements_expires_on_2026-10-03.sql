-- =====================================================================
-- ANNOUNCEMENT RUN-TIME — END-DATE MODEL.
--
-- NOT APPLIED. Review, then run by hand.
--
-- An admin sets an optional end date; after end-of-day in the department's
-- local zone the announcement stops showing for members. No date = runs
-- forever, which is today's behaviour and stays the default for every
-- existing row.
--
-- PURELY ADDITIVE. One nullable column, one policy predicate widened. No
-- permission is created or changed: delete stays author-or-dept-admin, insert
-- stays is_announcer(), and nothing here grants anyone a capability they did
-- not already have.
--
-- ---------------------------------------------------------------------
-- READ THIS BEFORE RUNNING: THE TIMEZONE IS HARDCODED, AND THAT IS A CHOICE.
--
-- The brief asked for end-of-day "in the department's timezone", from the
-- timezone/time-format settings work. THERE IS NO SUCH COLUMN. A search of
-- every column in `public` for a timezone returns nothing, and America/Chicago
-- is instead hardcoded in at least seven places across the client, the API and
-- shared/ — plus, per the header of shared/zoned-time.js, "at four SQL sites".
-- One repo comment (training_hours_a_attendance_union.sql) names
-- departments.timezone as a thing that must exist once there is more than one
-- department's worth of geography, which is a plan, not a column.
--
-- So this file uses the SAME literal as those four SQL sites. It is correct for
-- every department currently on the system and wrong the day one joins from
-- another zone — identically wrong to everything else already shipped, which is
-- the point: a fifth hardcoded site is a known, consistent debt, whereas
-- inventing departments.timezone HERE would make this file the only thing in
-- the system that respects it and would leave the duty periods, the digest and
-- the pulse engine disagreeing with the announcement feed about when "today"
-- ends.
--
-- If the reviewer prefers the column now, that is a separate migration that has
-- to convert all five sites together, and this one should wait for it.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- is_department_admin AND is_dept_admin BOTH EXIST in this database. They are
-- near-identical (one qualifies public.members, the other does not), and that
-- duplication is a trap: the announcements policies use is_department_admin(),
-- so this file uses is_department_admin() too. Matching the table it is editing
-- matters more than picking the name used elsewhere — a SELECT policy gated on
-- a different admin predicate than the UPDATE policy beside it would mean an
-- admin who can edit a row but cannot see it.
-- ---------------------------------------------------------------------
do $pre$
begin
  if not exists (select 1 from pg_proc where pronamespace='public'::regnamespace and proname='is_department_admin') then
    raise exception 'Precondition failed: is_department_admin() missing. It is the gate the announcements UPDATE/DELETE policies already use; do not substitute is_dept_admin() without checking both bodies.';
  end if;
  if not exists (select 1 from pg_proc where pronamespace='public'::regnamespace and proname='my_member_id') then
    raise exception 'Precondition failed: my_member_id() missing. Without it an author cannot be allowed to see their own expired announcement.';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='announcements'
                   and cmd='SELECT' and policyname='read announcements for my audience') then
    raise exception 'Precondition failed: the SELECT policy "read announcements for my audience" was not found. ALTER POLICY below would error, but check the name rather than guessing — a renamed policy means the feed is governed by something this file has not read.';
  end if;
end
$pre$;


-- ---------------------------------------------------------------------
-- 1. THE COLUMN. Nullable, no default, NO BACKFILL.
--
-- NULL means "runs forever" and every existing row keeps it, so applying this
-- file changes what precisely nobody sees. A default of any date would silently
-- expire the entire existing feed.
-- ---------------------------------------------------------------------
alter table public.announcements
  add column if not exists expires_on date;

comment on column public.announcements.expires_on is
  'Optional last day this announcement shows to members, inclusive. NULL = runs forever (the default '
  'and the behaviour of every row written before this column existed). Compared against the current '
  'date in America/Chicago, not UTC, so an announcement set to end on the 5th is still visible at '
  '11pm local on the 5th. Admins and the author still see expired rows so they can extend or clear '
  'the date; members do not.';


-- ---------------------------------------------------------------------
-- 2. THE FILTER, SERVER-SIDE.
--
-- ALTER POLICY, not DROP + CREATE. Dropping a policy leaves the table briefly
-- governed by whatever remains — and on a table whose SELECT policy IS the
-- audience wall, that window is a department reading another department's feed.
-- ALTER swaps the predicate atomically and keeps the policy's identity, name and
-- role list intact.
--
-- THE EXISTING PREDICATE IS REPRODUCED VERBATIM and ANDed with the new clause:
--     (department_id = my_department_id()) AND ((audience = 'everyone') OR is_leader())
-- Read the diff as one added conjunct, nothing else. The department scope and
-- the audience wall are untouched.
--
-- WHO STILL SEES AN EXPIRED ROW:
--   • is_department_admin() — so they can extend or clear the date.
--   • the author — because the UPDATE policy already lets an author edit their
--     own announcement, and a row you may edit but cannot see is a dead end.
--     is_announcer() includes Officers, so this is the common case, not an edge.
-- Everyone else loses it the moment the day ends locally. Members need no app
-- update for this: the filter is in the policy, so an old build asking for the
-- same rows simply receives fewer.
-- ---------------------------------------------------------------------
alter policy "read announcements for my audience"
  on public.announcements
  using (
    (department_id = public.my_department_id())
    and ((audience = 'everyone'::text) or public.is_leader())
    and (
      expires_on is null
      or expires_on >= (now() at time zone 'America/Chicago')::date
      or public.is_department_admin()
      or author_id = public.my_member_id()
    )
  );


-- ---------------------------------------------------------------------
-- 3. VERIFICATION.
--
-- RUN AS PLAIN DDL — there is deliberately no BEGIN/COMMIT in this file. A
-- left-open transaction has silently rolled this project's work back before, so
-- each statement auto-commits on its own.
--
-- THE PRICE, STATED PLAINLY: this block can no longer UNDO anything. Inside a
-- transaction a failed post-condition would have rolled the column and the
-- policy back together. Here the DDL above has already committed by the time
-- this runs, so a raise is an ALARM, not a repair — it tells you to go and look,
-- and section 4 below is the hand-rollback if you need it.
--
-- The preconditions in section 0 still do their job: they run before any DDL, so
-- a failed assert there aborts the batch with nothing changed. The protection
-- moved to the front of the file, which is where it was doing most of the work
-- anyway.
-- ---------------------------------------------------------------------
do $post$
declare
  v_qual text;
begin
  select qual into v_qual from pg_policies
   where schemaname='public' and tablename='announcements' and cmd='SELECT';

  -- The audience wall and the department scope must both have survived.
  if v_qual not like '%my_department_id()%' then
    raise exception 'Post-condition failed: the SELECT policy no longer scopes by department.';
  end if;
  if v_qual not like '%is_leader()%' then
    raise exception 'Post-condition failed: the SELECT policy no longer contains the audience wall.';
  end if;
  if v_qual not like '%expires_on%' then
    raise exception 'Post-condition failed: the expiry clause is not in the live policy.';
  end if;

  -- The other three policies must be exactly as they were.
  if (select count(*) from pg_policies where schemaname='public' and tablename='announcements') <> 4 then
    raise exception 'Post-condition failed: announcements no longer has exactly 4 policies. Something was dropped.';
  end if;

  -- No row may have been expired by this migration.
  if exists (select 1 from public.announcements where expires_on is not null) then
    raise exception 'Post-condition failed: a row has a non-null expires_on immediately after the column was added. This file performs no backfill; investigate before trusting the feed.';
  end if;
end
$post$;

-- ---------------------------------------------------------------------
-- 4. HAND-ROLLBACK, if section 3 raises. NOT run as part of this file —
--    copy it out deliberately. Restores the policy to the predicate recorded
--    verbatim from prod on 2026-10-03 before this change, and drops the column.
--
--    alter policy "read announcements for my audience"
--      on public.announcements
--      using (
--        (department_id = public.my_department_id())
--        and ((audience = 'everyone'::text) or public.is_leader())
--      );
--    alter table public.announcements drop column if exists expires_on;
--    notify pgrst, 'reload schema';
-- ---------------------------------------------------------------------

notify pgrst, 'reload schema';

