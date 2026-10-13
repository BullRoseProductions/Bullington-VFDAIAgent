-- =====================================================================
-- B2. Check scheduling — apparatus.check_interval_days + a setter.
-- APPLIED 2026-10-13 by hand (state check: column, range check, trigger, setter present;
-- anon cannot EXECUTE). RETEST sql/apparatus_check_interval_RETEST.sql: 10/10 passed.
-- (Filename keeps _DRAFT for history; the DB is the source of truth — check pg_proc/pg_trigger.)
-- (Brief B4C_Apparatus_CheckScheduling_Brief not found in the repo — built from the spec text.)
--
-- check_interval_days: NULL = no schedule (today's behaviour, unchanged).
-- Next due  = last_check_at + interval  (computed in the client — no stored due date to drift).
-- Overdue   = now() past next due. Interval set but never checked = due now.
--
-- GATE = is_canmanage_ops() (Dept Admin | Officer), from the live discovery 2026-10-13:
--   apparatus              INSERT  dept AND is_canmanage_ops()
--   apparatus_maintenance  INSERT  dept AND is_canmanage_ops()   DELETE dept AND is_canmanage_ops()
--   apparatus_maintenance_log INSERT dept AND is_canmanage_ops()
-- is_canmanage() (Board | DA | Officer) would have been LOOSER — not used.
--
-- WHY THE GUARD TRIGGER. The live apparatus UPDATE policy ("members update apparatus") is
-- department-only — any member can update any column (truck checks write status through it).
-- A new column would inherit that, so any member could PATCH check_interval_days directly and
-- skip the gate. The trigger blocks app-role writes to this ONE column unless they come through
-- the setter; every other column and the existing policy are untouched.
-- (The broad UPDATE policy itself is pre-existing and out of scope — flagged, not changed.)
--
-- The setter touches nothing but check_interval_days — never last_check_at / checked_by /
-- status, never `verified`.
-- =====================================================================
begin;

do $pre$
begin
  if not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'is_canmanage_ops') then
    raise exception 'Precondition failed: is_canmanage_ops() is missing.';
  end if;
end
$pre$;

alter table public.apparatus add column if not exists check_interval_days integer;
alter table public.apparatus drop constraint if exists apparatus_check_interval_days_range;
alter table public.apparatus add constraint apparatus_check_interval_days_range
  check (check_interval_days is null or check_interval_days between 1 and 365);

-- Guard: app roles (authenticated / anon) may not change check_interval_days directly.
-- Inside the SECURITY DEFINER setter current_user is the function owner, so the setter passes;
-- the setter's own is_canmanage_ops() check is the gate. SQL-editor (postgres) writes unaffected.
create or replace function public.apparatus_check_interval_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.check_interval_days is distinct from old.check_interval_days
     and current_user in ('authenticated', 'anon') then
    raise exception 'Use set_apparatus_check_interval to change a check schedule.';
  end if;
  return new;
end;
$function$;

drop trigger if exists apparatus_check_interval_guard on public.apparatus;
create trigger apparatus_check_interval_guard
  before update on public.apparatus
  for each row execute function public.apparatus_check_interval_guard();

create or replace function public.set_apparatus_check_interval(p_apparatus_id uuid, p_days integer)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if not is_canmanage_ops() then raise exception 'Not authorized'; end if;
  if p_days is not null and (p_days < 1 or p_days > 365) then
    raise exception 'Interval must be 1–365 days, or empty for no schedule.';
  end if;
  update public.apparatus
     set check_interval_days = p_days
   where id = p_apparatus_id
     and department_id = my_department_id()
     and deleted_at is null
  returning id into v_id;
  if v_id is null then raise exception 'Apparatus not found.'; end if;   -- other dept / deleted / bad id: same answer
  return p_days;
end;
$function$;

revoke all    on function public.set_apparatus_check_interval(uuid, integer) from anon, public;
grant execute on function public.set_apparatus_check_interval(uuid, integer) to authenticated;
revoke all    on function public.apparatus_check_interval_guard() from anon, public, authenticated;

do $post$
begin
  if has_function_privilege('anon', 'public.set_apparatus_check_interval(uuid, integer)', 'EXECUTE') then
    raise exception 'Post-condition failed: anon can EXECUTE set_apparatus_check_interval. Rolling back.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='apparatus' and column_name='check_interval_days') then
    raise exception 'Post-condition failed: check_interval_days missing. Rolling back.';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.apparatus'::regclass
                  and conname = 'apparatus_check_interval_days_range') then
    raise exception 'Post-condition failed: 1–365 range check missing. Rolling back.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.apparatus'::regclass
                  and tgname = 'apparatus_check_interval_guard' and not tgisinternal) then
    raise exception 'Post-condition failed: guard trigger missing. Rolling back.';
  end if;
  if position('is_canmanage_ops()' in pg_get_functiondef('public.set_apparatus_check_interval(uuid, integer)'::regprocedure)) = 0 then
    raise exception 'Post-condition failed: setter is not gated by is_canmanage_ops(). Rolling back.';
  end if;
end
$post$;

notify pgrst, 'reload schema';
commit;

-- =====================================================================
-- VERIFY (run separately, after applying). Each block impersonates a member; fill the emails
-- and a rig id from your department. Everything rolls back.
--
-- 1) Plain member PATCHing the column directly → expect ERROR 'Use set_apparatus_check_interval…'
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('email','<plain member email>','role','authenticated')::text, true);
--   update public.apparatus set check_interval_days = 7 where id = '<rig uuid>';
-- rollback;
--
-- 2) Plain member via the setter → expect ERROR 'Not authorized'
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('email','<plain member email>','role','authenticated')::text, true);
--   select public.set_apparatus_check_interval('<rig uuid>', 7);
-- rollback;
--
-- 3) Officer / DA via the setter → expect 7
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('email','<officer or DA email>','role','authenticated')::text, true);
--   select public.set_apparatus_check_interval('<rig uuid>', 7);
-- rollback;
--
-- 4) A truck check (status write) by a plain member still works → expect 1 row
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('email','<plain member email>','role','authenticated')::text, true);
--   update public.apparatus set note = note where id = '<rig uuid>' returning id;
-- rollback;
-- =====================================================================
