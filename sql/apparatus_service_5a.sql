-- =====================================================================
-- APPARATUS IN-SERVICE / OUT-OF-SERVICE - Slice 5a (schema only)
-- Adds the availability dimension (in_service) separate from the existing
-- readiness dimension (status = Pass / Needs attention), plus a history
-- table of out-of-service PERIODS. No RPCs, no app code here (5b/5c/5d).
--
-- Writes to apparatus_service_periods go ONLY through the 5b SECURITY DEFINER
-- RPCs (take_apparatus_out_of_service / return_apparatus_to_service). RLS here
-- is SELECT-only for dept members; there are deliberately NO client
-- INSERT/UPDATE/DELETE policies, so direct client writes are denied.
-- Idempotent: safe to re-run. Run VERIFICATION (bottom) after.
-- =====================================================================

-- 1. Availability dimension on apparatus. Every existing rig defaults in service.
ALTER TABLE public.apparatus
  ADD COLUMN IF NOT EXISTS in_service boolean NOT NULL DEFAULT true;

-- 2. Out-of-service history. One row per stint; back_at IS NULL = the OPEN
--    period (currently out of service). out_reason required (audit trail).
CREATE TABLE IF NOT EXISTS public.apparatus_service_periods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id  uuid NOT NULL,
  apparatus_id   uuid NOT NULL REFERENCES public.apparatus(id) ON DELETE CASCADE,
  out_at         timestamptz NOT NULL DEFAULT now(),
  out_by         uuid,            -- members(id)
  out_by_name    text,            -- snapshot (survives rename)
  out_reason     text NOT NULL,   -- why it went out of service (required)
  back_at        timestamptz,     -- NULL = still out of service
  back_by        uuid,
  back_by_name   text
);

-- At most ONE open (still-out) period per apparatus.
CREATE UNIQUE INDEX IF NOT EXISTS apparatus_service_periods_one_open
  ON public.apparatus_service_periods (apparatus_id) WHERE back_at IS NULL;

-- History lookups by rig, newest first.
CREATE INDEX IF NOT EXISTS apparatus_service_periods_by_apparatus
  ON public.apparatus_service_periods (apparatus_id, out_at DESC);

-- 3. RLS: dept members READ history; NO client writes (RPC-only in 5b).
ALTER TABLE public.apparatus_service_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read service periods" ON public.apparatus_service_periods;
CREATE POLICY "members read service periods" ON public.apparatus_service_periods
  FOR SELECT TO authenticated
  USING (department_id = my_department_id());

-- =====================================================================
-- VERIFICATION (run separately after; the editor shows the LAST grid)
-- =====================================================================

-- 1. in_service column exists on apparatus, NOT NULL, default true:
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'apparatus' and column_name = 'in_service';
--   expect: in_service | boolean | NO | true

-- 2. apparatus_service_periods columns (expect 10 rows):
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'apparatus_service_periods'
order by ordinal_position;

-- 3. RLS actually took: row security ON + exactly the SELECT policy, no writes.
select
  (select relrowsecurity from pg_class where relname = 'apparatus_service_periods') as rls_enabled,
  p.policyname, p.cmd, p.roles, p.qual
from pg_policies p
where p.tablename = 'apparatus_service_periods'
order by p.policyname;
--   expect: rls_enabled = t ; ONE row: "members read service periods" | SELECT
--           | {authenticated} | (department_id = my_department_id())
--           and NO INSERT/UPDATE/DELETE rows.
