-- =====================================================================
-- STATION FUNDRAISER — share a fundraiser's countdown + planning progress with the whole department.
-- Record: applied by hand 2026-10-15. Idempotent. State check on live: both flags boolean NOT NULL default false · 0 shared ·
-- 0 ticked · anon false x3 · read returns only {id, name, target_date, tasks_done, tasks_total, next_steps} · 157 policies
-- (unchanged). RETEST on live: 47 passed, 0 failed, 2 skipped; multi-department emails = 0 (the flagged role-anywhere
-- fundraiser policy has no one to mis-scope today — the follow-up fix still stands).
-- Review status at apply time: confirm with the reviewing Claude (send this file + the RETEST if not yet reviewed).
-- Test script: sql/station_fundraiser_RETEST.sql (run AFTER this, separately).
--
-- WHAT IT IS. A leader marks a fundraiser "share with the station" and ticks which planning steps the station
-- may see. Every member of that department then sees a card: a countdown to target_date, planning progress
-- (tasks done / tasks counted — COUNTS ONLY), and "Up next" (the ticked open steps: text + due date).
-- DONOR / MONEY DATA STAYS EXACTLY AS LOCKED AS TODAY: no RLS policy anywhere is created, altered or dropped,
-- so members still have NO read on fundraisers, fundraiser_sponsors, donations or anything funding. The station
-- reads ONLY through get_station_fundraisers(), which returns {id, name, target_date, tasks_done, tasks_total,
-- next_steps} and nothing else — never goal_amount, proceeds, campaign, sponsors, donors, or un-ticked task text.
--
-- WHAT CHANGES — ADDITIVE ONLY:
--   1. fundraisers.shared_with_station boolean NOT NULL DEFAULT false   (the "share with the station" flag)
--   2. action_items.station_visible   boolean NOT NULL DEFAULT false   (the per-step "show the station" tick;
--      false everywhere, so every existing and non-fundraiser item is unaffected)
--   3. set_fundraiser_shared(p_fundraiser_id, p_shared)        — SECURITY DEFINER write, leaders only
--   4. set_fundraiser_step_visible(p_item_id, p_visible)       — SECURITY DEFINER write, leaders only; the item
--      must be tagged to a fundraiser in the caller's department. (action_items has NO UPDATE policy — every
--      write is an RPC — so this is the only way the tick can be written; no client update path is added.)
--   5. get_station_fundraisers()                               — SECURITY DEFINER read, any member of the dept
--
-- WHO CAN WRITE THE FLAGS (decision #2) — DEPARTMENT-SCOPED, NOT is_canmanage():
--   a members row for auth.email() with department_id = my_department_id() and access && {Board Member,
--   Department Admin, Officer} — is_canmanage()'s role set, i.e. "the people who manage fundraisers today", but
--   checked INSIDE the caller's own department (the same standard as session_reg_is_leader()).
--
-- ⚠ FLAG FOR REVIEW — the EXISTING fundraiser write RLS is role-anywhere. sql/fundraiser_hq_slice1_schema.sql
--   creates  fundraisers_leadership  FOR ALL  USING/WITH CHECK (department_id = my_department_id() AND
--   is_canmanage()). The ROW is department-scoped, but is_canmanage() asks "is there ANY members row for this
--   email with a leader role" — not "a leader in THIS department". A person with member rows in two departments
--   (leader in one, plain member in the other, and my_department_id() resolving to the second) passes. Same shape
--   as the 2026-10-13 cert leak. This migration does NOT inherit it (its two writes use the scoped test above) and
--   does NOT change it (no policy touched — out of scope, and it would need its own reviewed fix). Recommend a
--   follow-up: replace is_canmanage() in fundraisers_leadership / fundraiser_sponsors_leadership with a
--   department-scoped test. The RETEST prints how many such multi-department emails exist, so the exposure is sized.
--
-- PROGRESS COUNT (decision #3) — mirrors the leader view (App.jsx Fundraiser HQ: counted / doneCount):
--   tasks_total = that fundraiser's action_items whose status is not 'cancelled' (NULL status counts, as 'open')
--   tasks_done  = of those, status = 'done'.
-- UP NEXT (decision #4): open (not done, not cancelled) AND station_visible items → {text, due_date}, ordered by
--   due_date (nulls last) then created_at, at most 3. No owner, no assignee.
-- LIFECYCLE (decision #5): shared_with_station AND status not in ('done','archived') AND target_date is set AND
--   target_date >= today. "Today" is America/Chicago (departments have no timezone column yet; this follows the
--   dept_station_shifts precedent) so the card stays up through the whole event day instead of vanishing at 7pm
--   Central when UTC rolls over. A fundraiser with no target_date has nothing to count down to and is not shown.
-- TIME / LOCATION: fundraisers has neither column, so the card shows the date only.
--
-- READ SCOPE — UNCHANGED, PROVEN. Post-condition captures EVERY policy on EVERY public table before the change and
-- proves the set identical after; also proves anon can't run any of the three functions, the two columns exist
-- NOT NULL DEFAULT false, and the read function's result type carries no money/donor column.
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor. Safe to re-run (idempotent).
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_result text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'$q$;
BEGIN
  -- 0. preconditions
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fundraisers' AND column_name = 'target_date')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fundraisers' AND column_name = 'status')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'action_items' AND column_name = 'fundraiser_id') THEN
    RAISE EXCEPTION 'Precondition failed: fundraisers.target_date/status or action_items.fundraiser_id missing.';
  END IF;
  IF to_regprocedure('public.my_department_id()') IS NULL OR to_regprocedure('public.my_member_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_department_id() / my_member_id() missing.';
  END IF;
  -- never overwrite a same-named function that isn't this file's (nested IFs — SQL AND doesn't short-circuit)
  IF to_regprocedure('public.get_station_fundraisers()') IS NOT NULL THEN
    IF position('B4C:station_fundraiser' in pg_get_functiondef(to_regprocedure('public.get_station_fundraisers()'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different get_station_fundraisers() exists — not overwriting it.';
    END IF;
  END IF;
  IF to_regprocedure('public.set_fundraiser_shared(uuid, boolean)') IS NOT NULL THEN
    IF position('B4C:station_fundraiser' in pg_get_functiondef(to_regprocedure('public.set_fundraiser_shared(uuid, boolean)'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different set_fundraiser_shared() exists — not overwriting it.';
    END IF;
  END IF;
  IF to_regprocedure('public.set_fundraiser_step_visible(uuid, boolean)') IS NOT NULL THEN
    IF position('B4C:station_fundraiser' in pg_get_functiondef(to_regprocedure('public.set_fundraiser_step_visible(uuid, boolean)'))) = 0 THEN
      RAISE EXCEPTION 'Precondition failed: a different set_fundraiser_step_visible() exists — not overwriting it.';
    END IF;
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1-2. the two flags
  ALTER TABLE public.fundraisers  ADD COLUMN IF NOT EXISTS shared_with_station boolean NOT NULL DEFAULT false;
  ALTER TABLE public.action_items ADD COLUMN IF NOT EXISTS station_visible     boolean NOT NULL DEFAULT false;

  -- 3. share / unshare a fundraiser — leaders of THIS department only
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_fundraiser_shared(p_fundraiser_id uuid, p_shared boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:station_fundraiser — department-scoped leader write of fundraisers.shared_with_station ONLY.
declare
  v_my_dept uuid := public.my_department_id();
begin
  if p_shared is null then raise exception 'Choose shared or not shared'; end if;
  if v_my_dept is null or not exists (
       select 1 from public.members m
        where lower(m.email) = lower(auth.email()) and m.department_id = v_my_dept
          and m.access && array['Board Member', 'Department Admin', 'Officer']::text[]) then
    raise exception 'Only leaders can share a fundraiser with the station';
  end if;
  update public.fundraisers set shared_with_station = p_shared
   where id = p_fundraiser_id and department_id = v_my_dept;
  if not found then raise exception 'Not in your department'; end if;
  return p_shared;
end;
$function$
$ddl$;

  -- 4. tick / untick one planning step — leaders of THIS department only; the step must belong to one of
  --    THIS department's fundraisers
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_fundraiser_step_visible(p_item_id uuid, p_visible boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:station_fundraiser — department-scoped leader write of action_items.station_visible ONLY.
declare
  v_my_dept uuid := public.my_department_id();
begin
  if p_visible is null then raise exception 'Choose shown or hidden'; end if;
  if v_my_dept is null or not exists (
       select 1 from public.members m
        where lower(m.email) = lower(auth.email()) and m.department_id = v_my_dept
          and m.access && array['Board Member', 'Department Admin', 'Officer']::text[]) then
    raise exception 'Only leaders can choose what the station sees';
  end if;
  update public.action_items ai set station_visible = p_visible
   where ai.id = p_item_id and ai.department_id = v_my_dept
     and ai.fundraiser_id is not null
     and exists (select 1 from public.fundraisers f where f.id = ai.fundraiser_id and f.department_id = v_my_dept);
  if not found then raise exception 'Not a planning step of your department''s fundraiser'; end if;
  return p_visible;
end;
$function$
$ddl$;

  -- 5. the station's ONE read — narrow by construction (an explicit column list; nothing else can cross)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.get_station_fundraisers()
 RETURNS TABLE(id uuid, name text, target_date date, tasks_done integer, tasks_total integer, next_steps jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- B4C:station_fundraiser — counts + ticked open steps only; never money, donors, sponsors, or un-ticked text.
  select f.id, f.name, f.target_date,
         (select count(*) from public.action_items ai
           where ai.fundraiser_id = f.id and coalesce(ai.status, 'open') = 'done')::integer as tasks_done,
         (select count(*) from public.action_items ai
           where ai.fundraiser_id = f.id and coalesce(ai.status, 'open') <> 'cancelled')::integer as tasks_total,
         coalesce((select jsonb_agg(jsonb_build_object('text', s.text, 'due_date', s.due_date) order by s.due_date nulls last, s.created_at)
                     from (select ai.text, ai.due_date, ai.created_at from public.action_items ai
                            where ai.fundraiser_id = f.id and ai.station_visible
                              and coalesce(ai.status, 'open') not in ('done', 'cancelled')
                            order by ai.due_date nulls last, ai.created_at
                            limit 3) s), '[]'::jsonb) as next_steps
    from public.fundraisers f
   where public.my_member_id() is not null
     and f.department_id = public.my_department_id()
     and f.shared_with_station
     and f.status not in ('done', 'archived')
     and f.target_date is not null
     and f.target_date >= (now() at time zone 'America/Chicago')::date
   order by f.target_date, f.name;
$function$
$ddl$;

  REVOKE EXECUTE ON FUNCTION public.set_fundraiser_shared(uuid, boolean)       FROM anon, public;
  REVOKE EXECUTE ON FUNCTION public.set_fundraiser_step_visible(uuid, boolean) FROM anon, public;
  REVOKE EXECUTE ON FUNCTION public.get_station_fundraisers()                  FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.set_fundraiser_shared(uuid, boolean)       TO authenticated;
  GRANT  EXECUTE ON FUNCTION public.set_fundraiser_step_visible(uuid, boolean) TO authenticated;
  GRANT  EXECUTE ON FUNCTION public.get_station_fundraisers()                  TO authenticated;

  -- 6. post-conditions — any failure undoes the whole block
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fundraisers'
                  AND column_name = 'shared_with_station' AND is_nullable = 'NO' AND column_default = 'false')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'action_items'
                  AND column_name = 'station_visible' AND is_nullable = 'NO' AND column_default = 'false') THEN
    RAISE EXCEPTION 'Post-condition failed: a flag column is missing or not NOT NULL DEFAULT false. Rolling back.';
  END IF;
  IF has_function_privilege('anon', 'public.get_station_fundraisers()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_fundraiser_shared(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_fundraiser_step_visible(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: anon can EXECUTE a station-fundraiser function. Rolling back.';
  END IF;
  v_result := pg_get_function_result('public.get_station_fundraisers()'::regprocedure);
  IF v_result ~* '(goal|proceeds|amount|donor|donation|sponsor|campaign|owner|assign)' THEN
    RAISE EXCEPTION 'Post-condition failed: get_station_fundraisers returns a money/donor/owner column (%). Rolling back.', v_result;
  END IF;
  -- NO POLICY ON ANY TABLE CHANGED (fundraisers, action_items, every funding table — all of them)
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN
    RAISE EXCEPTION 'Post-condition failed: an RLS policy changed. Rolling back.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: both columns boolean NOT NULL default false · 0 shared · 0 ticked on a first
-- run · anon false ×3 · the read's result columns (no money) · policy count = what you had before (155 + Register's 2)
SELECT (SELECT data_type || ' nullable=' || is_nullable || ' default=' || column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'fundraisers' AND column_name = 'shared_with_station') AS fundraisers_shared_col,
       (SELECT data_type || ' nullable=' || is_nullable || ' default=' || column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'action_items' AND column_name = 'station_visible') AS action_items_visible_col,
       (SELECT count(*) FROM public.fundraisers WHERE shared_with_station) AS shared_now,
       (SELECT count(*) FROM public.action_items WHERE station_visible) AS ticked_now,
       has_function_privilege('anon', 'public.get_station_fundraisers()', 'EXECUTE') AS anon_read,
       has_function_privilege('anon', 'public.set_fundraiser_shared(uuid, boolean)', 'EXECUTE') AS anon_share,
       has_function_privilege('anon', 'public.set_fundraiser_step_visible(uuid, boolean)', 'EXECUTE') AS anon_tick,
       pg_get_function_result('public.get_station_fundraisers()'::regprocedure) AS read_returns,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies_total;

-- =====================================================================
-- ROLLBACK (only if needed, separately). Drops the read/writes and the two flags; touches nothing else.
-- =====================================================================
-- DO $rb$
-- BEGIN
--   DROP FUNCTION IF EXISTS public.get_station_fundraisers();
--   DROP FUNCTION IF EXISTS public.set_fundraiser_step_visible(uuid, boolean);
--   DROP FUNCTION IF EXISTS public.set_fundraiser_shared(uuid, boolean);
--   ALTER TABLE public.action_items DROP COLUMN IF EXISTS station_visible;
--   ALTER TABLE public.fundraisers  DROP COLUMN IF EXISTS shared_with_station;
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
