-- =====================================================================
-- cert_submissions — DEPARTMENT SCOPING FIX. APPLIED 2026-10-13 by hand (post-conditions passed;
-- state check: 4 policies — admin read = is_dept_admin() AND department_id = my_department_id(),
-- leader insert scoped to own dept + own members). RETEST: sql/cert_submissions_dept_scope_RETEST.sql.
--
-- LEAK (confirmed 2026-10-13 by an impersonation test, all 5 departments): every ordinary
-- Dept Admin could READ every department's cert submissions (151–193 rows from other depts),
-- and approve_cert_submission / reject_cert_submission let any department's admin decide
-- another department's submissions (approve CREATES certs in that department).
--
-- ROOT CAUSE: is_department_admin() only checks "Dept Admin or Project Admin somewhere" — no
-- department. The read policy and both functions gated on it alone.
--
-- FIX (this table + these two functions only; is_department_admin() itself is NOT changed,
-- other tables may rely on it — see the AUDIT query at the bottom):
--   1. READ   — admins read only their OWN department's submissions: is_dept_admin() (already
--               dept-scoped via my_department_id()) AND department_id = my_department_id().
--               Members still read their own (unchanged policy).
--   2. INSERT — "Leaders propose": also require the row's department and member to be the
--               leader's own department. (is_leader() is dept-scoped, the ROW was not.)
--               "members propose own" is already correct — unchanged.
--   3. approve_cert_submission / reject_cert_submission — gate on is_dept_admin(), and refuse
--      unless the submission's department = my_department_id() ('Not in your department').
--      Bodies otherwise IDENTICAL to the live definitions captured 2026-10-13.
-- Project Admins: scoped like everyone else — they act on their own department's queue only
-- (platform-admin rule: PA fixes access/logins, never compliance records).
-- Never touches certs rows, verified, or any submission data. Signatures unchanged, so
-- CREATE OR REPLACE keeps the existing grants; post-conditions re-check anon anyway.
-- =====================================================================
begin;

do $pre$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'is_dept_admin') then
    raise exception 'Precondition failed: is_dept_admin() missing.';
  end if;
end
$pre$;

-- 1. READ ------------------------------------------------------------
drop policy if exists "Dept admins read cert submissions" on public.cert_submissions;
drop policy if exists "Dept admins read own dept cert submissions" on public.cert_submissions;
create policy "Dept admins read own dept cert submissions" on public.cert_submissions
  for select to authenticated
  using (public.is_dept_admin() and department_id = public.my_department_id());

-- 2. INSERT (leaders) --------------------------------------------------
drop policy if exists "Leaders propose cert submissions" on public.cert_submissions;
create policy "Leaders propose cert submissions" on public.cert_submissions
  for insert to authenticated
  with check (
        public.is_leader()
    and department_id = public.my_department_id()
    and member_id in (select m.id from public.members m where m.department_id = public.my_department_id())
    and status = 'pending'
    and proposed_by = auth.uid()
  );

-- 3a. APPROVE ----------------------------------------------------------
create or replace function public.approve_cert_submission(submission_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  sub public.cert_submissions;
  new_cert_id uuid;
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized to approve cert submissions';
  end if;
  select * into sub from public.cert_submissions where id = submission_id;
  if not found then
    raise exception 'Submission not found';
  end if;
  if sub.department_id is distinct from public.my_department_id() then
    raise exception 'Not in your department';
  end if;
  if sub.status <> 'pending' then
    raise exception 'Submission is not pending (current status: %)', sub.status;
  end if;
  insert into public.certs (id, department_id, member_id, name, exp, proof_path, created_at)
  values (gen_random_uuid(), sub.department_id, sub.member_id, sub.name, sub.exp, sub.proof_path, now())
  returning id into new_cert_id;
  update public.cert_submissions
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = submission_id;
  return new_cert_id;
end;
$function$;

-- 3b. REJECT -----------------------------------------------------------
create or replace function public.reject_cert_submission(submission_id uuid, reason text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  sub public.cert_submissions;
begin
  -- same authority gate as approve
  if not public.is_dept_admin() then
    raise exception 'Not authorized to reject cert submissions';
  end if;

  select * into sub from public.cert_submissions where id = submission_id;

  if not found then
    raise exception 'Submission not found';
  end if;

  if sub.department_id is distinct from public.my_department_id() then
    raise exception 'Not in your department';
  end if;

  if sub.status <> 'pending' then
    raise exception 'Submission is not pending (current status: %)', sub.status;
  end if;

  update public.cert_submissions
  set status = 'rejected',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      note = coalesce(reason, note)
  where id = submission_id;
end;
$function$;

revoke all    on function public.approve_cert_submission(uuid)      from anon, public;
revoke all    on function public.reject_cert_submission(uuid, text) from anon, public;
grant execute on function public.approve_cert_submission(uuid)      to authenticated;
grant execute on function public.reject_cert_submission(uuid, text) to authenticated;

-- POST-CONDITIONS — any failure rolls the whole thing back ---------------
do $post$
begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cert_submissions'
              and policyname = 'Dept admins read cert submissions') then
    raise exception 'Post-condition failed: the unscoped read policy still exists. Rolling back.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cert_submissions'
                  and policyname = 'Dept admins read own dept cert submissions' and qual like '%my_department_id()%') then
    raise exception 'Post-condition failed: scoped read policy missing. Rolling back.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cert_submissions'
                  and policyname = 'Leaders propose cert submissions' and with_check like '%my_department_id()%') then
    raise exception 'Post-condition failed: leader insert policy not scoped. Rolling back.';
  end if;
  if position('Not in your department' in pg_get_functiondef('public.approve_cert_submission(uuid)'::regprocedure)) = 0
  or position('Not in your department' in pg_get_functiondef('public.reject_cert_submission(uuid, text)'::regprocedure)) = 0 then
    raise exception 'Post-condition failed: approve/reject not department-scoped. Rolling back.';
  end if;
  if has_function_privilege('anon', 'public.approve_cert_submission(uuid)', 'EXECUTE')
  or has_function_privilege('anon', 'public.reject_cert_submission(uuid, text)', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE approve/reject. Rolling back.';
  end if;
end
$post$;

notify pgrst, 'reload schema';
commit;

-- state check (read-only)
select policyname, cmd, coalesce(qual, with_check) as condition
  from pg_policies where schemaname = 'public' and tablename = 'cert_submissions' order by cmd, policyname;

-- =====================================================================
-- AUDIT (read-only, run separately) — every OTHER policy that gates on the unscoped
-- is_department_admin() without a department condition. Same leak shape, other tables:
--
-- select tablename, policyname, cmd, coalesce(qual, with_check) as condition
--   from pg_policies
--  where schemaname = 'public'
--    and coalesce(qual, '') || coalesce(with_check, '') like '%is_department_admin()%'
--    and coalesce(qual, '') || coalesce(with_check, '') not like '%department_id%'
--  order by tablename, policyname;
-- =====================================================================
