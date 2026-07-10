-- =====================================================================
-- APPARATUS TRUCK CHECK - Slice 4a
-- Draft/finalize lifecycle + per-item stamping + resolution columns,
-- and the start_or_resume_check RPC. Readiness only.
--
-- Model: ONE in-progress draft per truck; all active members contribute;
-- per-item marks stamped (marked_by/name/at); different-outcome-only
-- overwrite (enforced in the 4b mark RPC); finalize -> immutable record;
-- failures escalate to leadership (4d) and can be resolved (resolution
-- columns here, resolve RPC in 4d).
--
-- Idempotent: safe to re-run. Run the VERIFICATION block at the bottom
-- separately after.
-- =====================================================================

-- ---------- 1. apparatus_checks: lifecycle state + relax finalize-only fields ----------

-- 1a. status -> outcome (the pass/fail OUTCOME, distinct from lifecycle state).
--     Guarded so a re-run after the rename is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'apparatus_checks' AND column_name = 'status') THEN
    ALTER TABLE public.apparatus_checks RENAME COLUMN status TO outcome;
  END IF;
END $$;

-- 1b. lifecycle state. DEFAULT 'finalized' backfills existing (one-shot) rows;
--     new drafts insert 'in_progress' explicitly via the RPC.
ALTER TABLE public.apparatus_checks
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'finalized'
  CHECK (state IN ('in_progress','finalized'));

-- 1c. finalize-only fields become nullable (null while in_progress).
ALTER TABLE public.apparatus_checks ALTER COLUMN outcome           DROP NOT NULL;
ALTER TABLE public.apparatus_checks ALTER COLUMN performed_by_name DROP NOT NULL;
ALTER TABLE public.apparatus_checks ALTER COLUMN performed_at      DROP NOT NULL;
ALTER TABLE public.apparatus_checks ALTER COLUMN performed_at      DROP DEFAULT;
ALTER TABLE public.apparatus_checks ALTER COLUMN pass_count        DROP NOT NULL;
ALTER TABLE public.apparatus_checks ALTER COLUMN pass_count        DROP DEFAULT;
ALTER TABLE public.apparatus_checks ALTER COLUMN fail_count        DROP NOT NULL;
ALTER TABLE public.apparatus_checks ALTER COLUMN fail_count        DROP DEFAULT;

-- 1d. who STARTED the draft (snapshot). performed_by/_name stay the FINALIZER.
ALTER TABLE public.apparatus_checks ADD COLUMN IF NOT EXISTS created_by      uuid;
ALTER TABLE public.apparatus_checks ADD COLUMN IF NOT EXISTS created_by_name text;

-- 1e. ONE in-progress draft per truck.
CREATE UNIQUE INDEX IF NOT EXISTS apparatus_checks_one_draft
  ON public.apparatus_checks (apparatus_id) WHERE state = 'in_progress';

-- ---------- 2. apparatus_check_results: per-item stamping + resolution ----------

ALTER TABLE public.apparatus_check_results ADD COLUMN IF NOT EXISTS marked_by       uuid;
ALTER TABLE public.apparatus_check_results ADD COLUMN IF NOT EXISTS marked_by_name  text;
ALTER TABLE public.apparatus_check_results ADD COLUMN IF NOT EXISTS marked_at       timestamptz;
ALTER TABLE public.apparatus_check_results ADD COLUMN IF NOT EXISTS resolved_at     timestamptz;
ALTER TABLE public.apparatus_check_results ADD COLUMN IF NOT EXISTS resolved_by     uuid;
ALTER TABLE public.apparatus_check_results ADD COLUMN IF NOT EXISTS resolved_by_name text;
ALTER TABLE public.apparatus_check_results ADD COLUMN IF NOT EXISTS resolution_note text;

-- One result per item per check -> marks upsert/overwrite (ON CONFLICT target in 4b).
CREATE UNIQUE INDEX IF NOT EXISTS apparatus_check_results_check_item_uniq
  ON public.apparatus_check_results (check_id, item_id);

-- ---------- 3. Drop the obsolete one-shot RPC (replaced by start->mark->finalize) ----------
DROP FUNCTION IF EXISTS public.perform_apparatus_check(uuid, text, jsonb);

-- ---------- 4. Drop Slice-1 client UPDATE policies (all writes are RPC-only now) ----------
DROP POLICY IF EXISTS "leadership correct checks"  ON public.apparatus_checks;
DROP POLICY IF EXISTS "leadership correct results" ON public.apparatus_check_results;

-- ---------- 5. RPC: start_or_resume_check ----------
-- Get-or-create the truck's in_progress draft; returns its id.
-- Enforces: active member (not Inactive), dept ownership, >=1 active checklist item.
-- Race-safe via the partial unique index (catch unique_violation -> re-select).
CREATE OR REPLACE FUNCTION public.start_or_resume_check(p_apparatus_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_member       public.members;
  v_app          public.apparatus;
  v_active_count int;
  v_check_id     uuid;
begin
  -- identity: an active member for the signed-in user
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if v_member.status = 'Inactive' then
    raise exception 'Inactive members cannot perform apparatus checks';
  end if;

  -- apparatus must exist and belong to the caller's department
  select * into v_app from public.apparatus where id = p_apparatus_id;
  if v_app.id is null then
    raise exception 'Apparatus not found';
  end if;
  if v_app.department_id <> v_member.department_id then
    raise exception 'Not authorized: apparatus belongs to another department';
  end if;

  -- must have at least one ACTIVE checklist item to check against
  select count(*) into v_active_count
  from public.apparatus_check_items
  where apparatus_id = v_app.id and active = true;
  if v_active_count = 0 then
    raise exception 'This truck has no checklist items yet';
  end if;

  -- resume an existing draft if present
  select id into v_check_id
  from public.apparatus_checks
  where apparatus_id = v_app.id and state = 'in_progress'
  limit 1;
  if v_check_id is not null then
    return v_check_id;
  end if;

  -- otherwise create it (race-safe against the partial unique index)
  begin
    insert into public.apparatus_checks
      (department_id, apparatus_id, apparatus_name, state, created_by, created_by_name)
    values
      (v_member.department_id, v_app.id, v_app.name, 'in_progress', v_member.id, v_member.name)
    returning id into v_check_id;
  exception when unique_violation then
    select id into v_check_id
    from public.apparatus_checks
    where apparatus_id = v_app.id and state = 'in_progress'
    limit 1;
  end;

  return v_check_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.start_or_resume_check(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.start_or_resume_check(uuid) TO authenticated;

-- =====================================================================
-- VERIFICATION (run separately after the migration; not part of it)
-- =====================================================================
-- -- 1. apparatus_checks new/changed columns (state NOT NULL; outcome/performed_* nullable):
-- select column_name, is_nullable, column_default
-- from information_schema.columns
-- where table_name = 'apparatus_checks'
--   and column_name in ('state','outcome','performed_by_name','performed_at','pass_count','fail_count','created_by','created_by_name')
-- order by column_name;
--
-- -- 2. apparatus_check_results new columns:
-- select column_name from information_schema.columns
-- where table_name = 'apparatus_check_results'
--   and column_name in ('marked_by','marked_by_name','marked_at','resolved_at','resolved_by','resolved_by_name','resolution_note')
-- order by column_name;    -- expect 7 rows
--
-- -- 3. indexes present (one-draft + check_item uniq):
-- select indexname from pg_indexes
-- where tablename in ('apparatus_checks','apparatus_check_results')
--   and indexname in ('apparatus_checks_one_draft','apparatus_check_results_check_item_uniq');
--
-- -- 4. old RPC gone, new RPC present + SECURITY DEFINER:
-- select proname, prosecdef from pg_proc where proname in ('perform_apparatus_check','start_or_resume_check');
--   -- expect only start_or_resume_check, prosecdef = true
--
-- -- 5. Slice-1 client UPDATE policies dropped (should return 0 rows):
-- select policyname from pg_policies
-- where tablename in ('apparatus_checks','apparatus_check_results') and cmd = 'UPDATE';
--
-- -- 6. one-draft index actually bites (should ERROR on the 2nd insert). Run in a tx you roll back:
-- -- begin;
-- --   insert into public.apparatus_checks (department_id, apparatus_id, apparatus_name, state)
-- --   select department_id, id, name, 'in_progress' from public.apparatus limit 1;
-- --   insert into public.apparatus_checks (department_id, apparatus_id, apparatus_name, state)
-- --   select department_id, id, name, 'in_progress' from public.apparatus limit 1;  -- expect: duplicate key
-- -- rollback;
