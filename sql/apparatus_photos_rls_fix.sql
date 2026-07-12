-- =====================================================================
-- FIX: apparatus photo management rejected with "new row violates row-level
-- security policy" for leaders who aren't specifically DA/Officer.
--
-- CAUSE (not a code bug): the write policy "ops manage photos" gated on
-- is_canmanage_ops() = Department Admin | Officer only (Board + Project Admin
-- excluded). A leader whose access is Board / owner passes is_canmanage()
-- (Board|DA|Officer) - which is why apparatus resolve / out-of-service worked
-- for them - but FAILS is_canmanage_ops(), so the photo INSERT is rejected.
-- department_id is set correctly (same my_department_id() path as Documents),
-- so that is NOT the cause.
--
-- FIX: widen the photo write gate to is_canmanage() (Board | DA | Officer) -
-- the same leadership gate as apparatus resolve / out-of-service. Read stays
-- dept-scoped for all members. Idempotent.
-- =====================================================================

DROP POLICY IF EXISTS "ops manage photos"        ON public.apparatus_photos;
DROP POLICY IF EXISTS "leadership manage photos" ON public.apparatus_photos;
CREATE POLICY "leadership manage photos" ON public.apparatus_photos
  FOR ALL TO authenticated
  USING      (public.is_canmanage() AND department_id = my_department_id())
  WITH CHECK (public.is_canmanage() AND department_id = my_department_id());

-- =====================================================================
-- DIAGNOSIS (optional, read-only) - confirm the cause:
-- =====================================================================
-- select id, name, access, department_id, status
-- from public.members where lower(email) = lower('ashlea@bullroseproductions.com');
--   -- If access lacks 'Department Admin'/'Officer' (e.g. only 'Board Member'
--   -- and/or 'Project Admin'), that is exactly why is_canmanage_ops() rejected
--   -- the insert while is_canmanage() passes.

-- =====================================================================
-- VERIFICATION (run separately; the editor shows the LAST grid)
-- =====================================================================
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'apparatus_photos'
order by policyname;
--   expect:
--     "leadership manage photos" | ALL    | (is_canmanage() AND (department_id = my_department_id())) | (same)
--     "members read photos"      | SELECT | (department_id = my_department_id())                      | (null)
--   and NO "ops manage photos" row (it was replaced).
