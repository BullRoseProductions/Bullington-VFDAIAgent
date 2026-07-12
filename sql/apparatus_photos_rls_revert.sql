-- =====================================================================
-- REVERT: apparatus_photos write gate back to is_canmanage_ops() (DA/Officer).
--
-- The earlier widen to is_canmanage() (Board/DA/Officer) fixed a NON-bug: the
-- real cause of the upload failure was the storage.objects path prefix
-- (apparatus/... instead of {deptId}/...), not this table policy. Restore the
-- deliberate decision that apparatus photos are an OPS action (DA/Officer);
-- Board is governance-only. Read stays dept-scoped for all members. Idempotent.
-- =====================================================================

DROP POLICY IF EXISTS "leadership manage photos" ON public.apparatus_photos;
DROP POLICY IF EXISTS "ops manage photos"        ON public.apparatus_photos;
CREATE POLICY "ops manage photos" ON public.apparatus_photos
  FOR ALL TO authenticated
  USING      (public.is_canmanage_ops() AND department_id = my_department_id())
  WITH CHECK (public.is_canmanage_ops() AND department_id = my_department_id());

-- =====================================================================
-- VERIFICATION (run separately; the editor shows the LAST grid)
-- =====================================================================
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'apparatus_photos'
order by policyname;
--   expect:
--     "members read photos" | SELECT | (department_id = my_department_id())                          | (null)
--     "ops manage photos"   | ALL    | (is_canmanage_ops() AND (department_id = my_department_id())) | (same)
--   and NO "leadership manage photos" row (it was replaced).
