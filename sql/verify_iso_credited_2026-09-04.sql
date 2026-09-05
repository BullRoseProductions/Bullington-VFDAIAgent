-- =====================================================================
-- VERIFICATION ONLY — READ-ONLY, CHANGES NOTHING. Run before the client
-- change that makes Credited = the de-overlapped dept_iso_hours figure.
--
-- WHY THIS FILE EXISTS. The whole change rests on one assumption I cannot
-- check from a laptop with no database access: that the C2 migration
-- (training_hours_c2_officer_attested_credit.sql) is LIVE. Its own header in
-- git still says "NOT YET APPLIED", and git says nothing about what is live —
-- so the header is evidence of nothing either way, and only pg_proc decides.
--
-- WHAT TURNS ON IT. Before C2, dept_iso_hours reads station_presence alone,
-- filtered `and sp.verified`, with no auto_closed exclusion. Officer-attested
-- drill attendance is DERIVED AT READ TIME by dept_station_shifts and is not a
-- station_presence row at all — training_hours_a says so in as many words:
-- "dept_iso_hours already filters `and sp.verified`, so ISO cannot absorb them".
--
-- So if C2 is NOT live, pointing Credited at dept_iso_hours would silently
-- DELETE every officer-attested drill hour from the department's reportable
-- total, and would let auto-closed shifts back into it. That is the same class
-- of error as the double-count, in the other direction, on the same number.
--
-- Chase Thomas's expected figures are themselves the tell. 1.5 h is exactly the
-- flat 90-minute attested cap, and 35.42 + 1.50 = 36.92 — his standby total
-- unchanged, with the drill carved OUT of it rather than added ON to it. That
-- arithmetic only happens if attested spans reach dept_iso_hours, i.e. only if
-- C2 is live. Expected, not proven. Prove it below.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. IS C2 LIVE? Read the body — do not grep it.
--
-- prosrc INCLUDES COMMENTS, so `prosrc ilike '%attested_training%'` can match a
-- comment in a pre-C2 body and report success on a function that does nothing
-- of the kind. This codebase has already been bitten by exactly that. Print the
-- definition and read the `from` clauses with your eyes.
-- ---------------------------------------------------------------------
select pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'dept_iso_hours';

-- LOOK FOR, in the body of the function above:
--   • a `union all` whose second branch selects `from public.attested_training(...)`
--   • `and not sp.auto_closed` on the station_presence branch
-- BOTH present            -> C2 is live. The client change is correct as written.
-- EITHER missing          -> STOP. Do not ship the client change; it would drop
--                            attested hours and/or re-credit auto-closed ones.

-- Supporting check: C1's helper must exist for C2's body to run at all.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef                               as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'attested_training';
-- Expected if C2 is live: one row, args (uuid, timestamptz, timestamptz),
-- security_definer = FALSE (C1 is deliberately INVOKER — p_dept is a parameter,
-- so definer rights would let any caller read another department's attendance).
-- Zero rows = C2 cannot be live.


-- ---------------------------------------------------------------------
-- 2. THE NUMBERS, through the real RPCs.
--
-- Impersonates a North Hood leader rather than computing a second opinion by
-- hand: the point is to see what the SCREEN will see, and a hand-rolled query
-- would only prove that I can write the same SQL twice.
--
-- Fill in :leader_uid from the lookup, then run the block. set_config(..., true)
-- is transaction-local, and the whole thing is wrapped so nothing persists.
-- ---------------------------------------------------------------------

-- 2a. Find a leadership auth uid for North Hood.
select m.id as member_id, m.name, m.access, m.auth_user_id
from public.members m
join public.departments d on d.id = m.department_id
where d.name ilike '%north hood%'
  and m.access in ('leadership', 'admin')     -- adjust to this schema's actual values
  and m.auth_user_id is not null
order by m.name
limit 5;

-- 2b. Old vs new, side by side, for the month Chase's 38.42 came from.
--     Replace BOTH placeholders before running.
begin;

select set_config('request.jwt.claims',
                  json_build_object('sub', 'PASTE-LEADER-AUTH-UID-HERE',
                                    'role', 'authenticated')::text,
                  true);
set local role authenticated;

with
-- What the screen shows TODAY: dept_station_shifts rolled up the broken way,
-- standby and training added together as if they were disjoint.
old as (
  select s.member_id,
         sum(case when     s.auto_closed then 0
                  when not (s.verified or coalesce(s.officer_attested,false)) then 0
                  when s.kind = 'training' then s.hours else 0 end) as old_training,
         sum(case when     s.auto_closed then 0
                  when not (s.verified or coalesce(s.officer_attested,false)) then 0
                  when s.kind = 'training' then 0 else s.hours end) as old_standby
  from public.dept_station_shifts(
         timestamptz 'PASTE-FROM', timestamptz 'PASTE-TO') s
  group by s.member_id
),
-- What the screen will show AFTER the change.
new as (
  select i.member_id, i.member_name, i.training_hours, i.standby_hours, i.iso_total_hours
  from public.dept_iso_hours(
         timestamptz 'PASTE-FROM', timestamptz 'PASTE-TO') i
)
select coalesce(n.member_name, '(no ISO row)')          as member,
       round(o.old_standby, 2)                          as old_standby,
       round(o.old_training, 2)                         as old_training,
       round(o.old_standby + o.old_training, 2)         as old_credited,   -- the double-counted figure
       round(n.standby_hours, 2)                        as new_standby,
       round(n.training_hours, 2)                       as new_training,
       round(n.iso_total_hours, 2)                      as new_credited,   -- de-overlapped
       round((o.old_standby + o.old_training) - n.iso_total_hours, 2) as over_credit
from new n
full join old o on o.member_id = n.member_id
order by over_credit desc nulls last, member;

rollback;   -- nothing above writes, but the impersonation must not outlive the check

-- EXPECTED, and these are the three acceptance tests:
--   • Chase Thomas       old 36.92 / 1.50 / 38.42   ->   new 35.42 / 1.50 / 36.92
--                        over_credit 1.50 — the drill he was already on standby for.
--   • A member who attended a drill with NO overlapping standby: training unchanged
--     at 1.50 and over_credit 0.00. The attested-only case must not move.
--   • over_credit is NEVER NEGATIVE for a member whose shifts sat entirely inside
--     the period. A negative value means clipping, not overlap — a shift straddling
--     the period start, which dept_station_shifts drops whole and dept_iso_hours
--     counts in part. That is expected at boundaries and is not a fault; it is the
--     reason the merged row keeps unverified on shift-windowing and credited on
--     ISO-windowing, and the reason a member can appear with ISO hours and no
--     shift row at all.
