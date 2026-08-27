-- =====================================================================
-- APPARATUS DELETE HARDENING — DA-only, recoverable, audited.
--
-- THE INCIDENT. Station 20's "Brush 25" was hard-deleted, a battalion chief
-- asked who did it, and the app had recorded nothing. There was nothing to
-- answer with: the row was gone and no trace of the removal existed anywhere.
--
-- THREE CHANGES:
--   1. Removing a rig becomes DEPARTMENT-ADMIN-ONLY. Officers keep add, edit and
--      every checklist path exactly as they are; they lose only removal.
--   2. Removal becomes a RECOVERABLE SOFT-DELETE — the row survives, hidden.
--   3. Every removal is STAMPED with who and when.
--
-- WHAT PART 0 TURNED UP, AND WHY IT CHANGED THE BUILD.
--
-- The live policies are:
--   DELETE  department_id = my_department_id() AND is_canmanage_ops()
--   INSERT  department_id = my_department_id() AND is_canmanage_ops()
--   SELECT  department_id = my_department_id()
--   UPDATE  department_id = my_department_id()          <-- NO ROLE GATE
--
-- A SOFT-DELETE IS AN UPDATE. So tightening the DELETE policy alone would have
-- left this open to any authenticated member of the department:
--
--     PATCH /apparatus?id=eq.<uuid>   {"deleted_at": "now()"}
--
-- The rig vanishes from every list exactly as a hard delete looked, with
-- deleted_by_name null — a removal recording nobody, in the very build meant to
-- answer "who removed this". Section 3 is what closes it.
--
-- WHY A TRIGGER AND NOT COLUMN PRIVILEGES. `authenticated` holds TABLE-WIDE
-- UPDATE on apparatus, so the column-privilege route means revoking that and
-- re-granting every remaining column by name — after which any column added in
-- any future phase is silently unwritable by the app until someone remembers to
-- extend the grant. This repo adds columns in nearly every phase. The trigger is
-- robust to that, is one readable body, and fails closed.
--
-- THE UPDATE POLICY IS NOT TOUCHED, so member edits and checklist writes are
-- byte-identical. The trigger constrains three columns, not the table.
--
-- DEPLOY GATE: apply BEFORE the client deploys. The client stops calling DELETE
-- and starts calling retire_apparatus by name.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.apparatus'::regclass) THEN
    RAISE EXCEPTION 'Precondition failed: public.apparatus does not exist.';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.apparatus'::regclass) THEN
    RAISE EXCEPTION 'Precondition failed: RLS is not enabled on apparatus. Every gate in this file assumes it is.';
  END IF;

  -- Both helpers are READ here and never edited.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='is_dept_admin') THEN
    RAISE EXCEPTION 'Precondition failed: is_dept_admin() is missing. It is the whole authorization boundary for removal.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='is_canmanage_ops') THEN
    RAISE EXCEPTION 'Precondition failed: is_canmanage_ops() is missing.';
  END IF;

  -- The DELETE policy must be the one Part 0 captured, or section 5 is
  -- retightening something other than what was reviewed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.apparatus'::regclass
       AND polname  = 'leaders delete apparatus'
       AND polcmd   = 'd'
       AND pg_get_expr(polqual, polrelid) ILIKE '%is_canmanage_ops()%'
  ) THEN
    RAISE EXCEPTION 'Precondition failed: the DELETE policy "leaders delete apparatus" gated on is_canmanage_ops() was not found. Re-capture pg_policy before proceeding.';
  END IF;

  -- Nothing named deleted_* already exists (Part 0 block 5 returned 0).
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='apparatus'
                AND column_name IN ('deleted_at','deleted_by','deleted_by_name')) THEN
    RAISE EXCEPTION 'Precondition failed: apparatus already has a deleted_* column. This file expects to add them.';
  END IF;

  RAISE NOTICE 'Pre-flight OK — RLS on, helpers present, DELETE policy is the captured one, no deleted_* columns yet.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. The three audit columns.
--
-- ALL NULLABLE, null = live. That is what makes this a pure addition: no
-- existing row is altered, and every rig in the fleet stays exactly as it is.
--
-- deleted_by HAS NO FOREIGN KEY TO members, deliberately. A FK would either
-- block removing a member who had once retired a rig, or cascade the audit away
-- with them. An audit record has to outlive the person it names.
--
-- deleted_by_name IS A DENORMALISED COPY, and that is also deliberate — the same
-- reasoning apparatus_checks already uses for created_by_name / performed_by_name
-- (apparatus_checks_slice4a.sql:45-46). It records what the roster said AT THE
-- MOMENT OF REMOVAL, so a later rename, or the member leaving entirely, cannot
-- rewrite or erase who did it. Do not "fix" this into a join.
-- ---------------------------------------------------------------------
ALTER TABLE public.apparatus
  ADD COLUMN IF NOT EXISTS deleted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by      uuid,
  ADD COLUMN IF NOT EXISTS deleted_by_name text;

COMMENT ON COLUMN public.apparatus.deleted_at IS
  'Soft-delete marker and removal audit. NULL = the rig is live. Set only by retire_apparatus(); cleared only by restore_apparatus(). A direct UPDATE of this column by a non-Department-Admin is refused by trg_apparatus_removal_guard.';
COMMENT ON COLUMN public.apparatus.deleted_by IS
  'The member who removed the rig. No FK to members on purpose — the audit must outlive the person it names.';
COMMENT ON COLUMN public.apparatus.deleted_by_name IS
  'The remover''s name AS IT STOOD AT REMOVAL. Denormalised on purpose, like apparatus_checks.performed_by_name: a later rename, or the member leaving, must not rewrite who did it.';


-- ---------------------------------------------------------------------
-- 2. Keep the fleet reads fast.
--
-- Every apparatus list now carries `deleted_at is null`, and the two that matter
-- most also filter department and station. A partial index matching exactly that
-- shape keeps the common query on an index rather than a filtered scan, and
-- costs nothing to add now — this is the kind of thing that is cheap today and
-- awkward to retrofit once someone notices the fleet screen got slower.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS apparatus_live_by_station_idx
  ON public.apparatus (department_id, station_id)
  WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------
-- 3. THE GUARD — the piece Part 0 made necessary.
--
-- The UPDATE policy has no role gate, so without this any member of the
-- department could set deleted_at directly through PostgREST and remove a rig
-- with no name attached to it.
--
-- FIRES ONLY WHEN ONE OF THE THREE COLUMNS ACTUALLY CHANGES. `IS DISTINCT FROM`
-- rather than `<>` because these are nullable and the null-to-null case must
-- read as "unchanged", not as unknown. An ordinary edit — name, status,
-- checklist stamp — touches none of them and passes straight through, which is
-- what keeps Officer and member behaviour byte-identical.
--
-- SECURITY DEFINER, so it can be trusted regardless of who is updating, and it
-- reads is_dept_admin() rather than a role array: the same helper the RPCs and
-- the policy use, so there is one definition of "may remove a rig".
--
-- THE RPCs PASS THROUGH IT, they are not exempted from it. Both gate on
-- is_dept_admin() before they write, so by the time this fires the answer is
-- already true. That is deliberate: an exemption would be a second path to
-- trust, and this way there is exactly one rule.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apparatus_removal_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (new.deleted_at      is distinct from old.deleted_at)
  or (new.deleted_by      is distinct from old.deleted_by)
  or (new.deleted_by_name is distinct from old.deleted_by_name) then
    if not public.is_dept_admin() then
      raise exception 'Only a Department Admin can remove or restore a rig.';
    end if;
  end if;
  return new;
end;
$function$;

REVOKE ALL ON FUNCTION public.apparatus_removal_guard() FROM anon, public, authenticated;

DROP TRIGGER IF EXISTS trg_apparatus_removal_guard ON public.apparatus;
CREATE TRIGGER trg_apparatus_removal_guard
  BEFORE UPDATE ON public.apparatus
  FOR EACH ROW EXECUTE FUNCTION public.apparatus_removal_guard();


-- ---------------------------------------------------------------------
-- 4. retire_apparatus / restore_apparatus — the only intended paths.
--
-- BOTH GATES MATTER AND NEITHER IS REDUNDANT:
--   is_dept_admin()                     — WHO may remove a rig
--   department_id = my_department_id()  — WHOSE rig they may remove
-- The second is what stops a Project Admin, who is inside is_dept_admin(),
-- reaching another department's fleet. SECURITY DEFINER bypasses RLS, so this
-- check IS the department boundary here rather than a belt on top of one.
--
-- THEY RAISE RATHER THAN NO-OP. A guardrail that quietly does nothing when
-- handed a bad id is worse than one that refuses loudly: the UI would report
-- success and the rig would still be there. Same reasoning as
-- resolve_auto_closed_shift.
--
-- FOR UPDATE on the read, so two admins acting at once cannot interleave: the
-- second waits, then finds the row already removed and is told so.
--
-- RESTORE DOES NOT REFUSE ON A NAME COLLISION. If "Brush 25" was removed and a
-- new "Brush 25" added since, restoring produces two rigs with one name. That is
-- untidy, not wrong — the old rig genuinely existed — and refusing would leave a
-- DA no in-app way to recover it. The Recently-removed view shows the name and
-- date so the choice is made with eyes open. Flagged rather than hidden.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retire_apparatus(p_id uuid)
 RETURNS apparatus
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_row  public.apparatus;
begin
  if not public.is_dept_admin() then
    raise exception 'Only a Department Admin can remove a rig.';
  end if;

  select * into v_row from public.apparatus
   where id = p_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That rig was not found in your department.';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'That rig has already been removed.';
  end if;

  update public.apparatus
     set deleted_at      = now(),
         deleted_by      = v_me,
         -- The name as the roster has it RIGHT NOW. See the column comment.
         deleted_by_name = (select m.name from public.members m where m.id = v_me)
   where id = p_id
  returning * into v_row;

  return v_row;
end;
$function$;

REVOKE ALL    ON FUNCTION public.retire_apparatus(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.retire_apparatus(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retire_apparatus(uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.restore_apparatus(p_id uuid)
 RETURNS apparatus
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_row  public.apparatus;
begin
  if not public.is_dept_admin() then
    raise exception 'Only a Department Admin can restore a rig.';
  end if;

  select * into v_row from public.apparatus
   where id = p_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That rig was not found in your department.';
  end if;
  if v_row.deleted_at is null then
    raise exception 'That rig is already in the fleet.';
  end if;

  -- All three cleared together. Leaving deleted_by behind would leave a restored
  -- rig carrying a remover, which reads as still-removed to anything that checks.
  update public.apparatus
     set deleted_at      = null,
         deleted_by      = null,
         deleted_by_name = null
   where id = p_id
  returning * into v_row;

  return v_row;
end;
$function$;

REVOKE ALL    ON FUNCTION public.restore_apparatus(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restore_apparatus(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_apparatus(uuid) TO service_role;


-- ---------------------------------------------------------------------
-- 5. Tighten the raw DELETE policy — the backstop.
--
-- The client no longer issues a DELETE at all, so this is defence in depth: even
-- a direct API call cannot let an Officer hard-delete a rig, which would destroy
-- the row the audit lives on and put us back where the incident started.
--
-- SAME NAME, SAME ROLE, SAME SHAPE — only the helper changes, from
-- is_canmanage_ops() to is_dept_admin(). The department term and its order are
-- reproduced from the Part 0 capture verbatim.
--
-- INSERT, UPDATE AND SELECT ARE NOT TOUCHED. Officers add and edit exactly as
-- before; every member still reads the fleet.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "leaders delete apparatus" ON public.apparatus;
CREATE POLICY "leaders delete apparatus" ON public.apparatus
  FOR DELETE TO authenticated
  USING ((department_id = my_department_id()) AND is_dept_admin());

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after). Checks 4-6 write and every one of them ROLLS BACK.
-- =====================================================================
--
-- -- 1. Columns, index, trigger. EXPECT 3 columns all nullable; the partial
-- --    index present; one BEFORE UPDATE trigger.
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='apparatus'
--    AND column_name IN ('deleted_at','deleted_by','deleted_by_name') ORDER BY column_name;
--
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname='public' AND tablename='apparatus' AND indexname='apparatus_live_by_station_idx';
--
-- SELECT tgname, tgenabled FROM pg_trigger
--  WHERE tgrelid='public.apparatus'::regclass AND NOT tgisinternal ORDER BY tgname;
--
-- -- 2. THE POLICIES. EXPECT DELETE now is_dept_admin(); INSERT still
-- --    is_canmanage_ops(); SELECT and UPDATE character-for-character as Part 0
-- --    captured them.
-- SELECT polname,
--        CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
--                    WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END AS cmd,
--        pg_get_expr(polqual, polrelid) AS using_expr,
--        pg_get_expr(polwithcheck, polrelid) AS with_check
--   FROM pg_policy WHERE polrelid='public.apparatus'::regclass ORDER BY cmd;
--
-- -- 3. Grants on the two RPCs. EXPECT anon=f, auth=t, svc=t on both.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        prosecdef AS definer,
--        has_function_privilege('anon',          oid,'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid,'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  oid,'EXECUTE') AS svc_exec
--   FROM pg_proc WHERE pronamespace='public'::regnamespace
--    AND proname IN ('retire_apparatus','restore_apparatus') ORDER BY proname;
--
-- -- 4. NOT ONE RIG WAS TOUCHED. EXPECT removed = 0 and total = the pre-apply count.
-- SELECT count(*) AS total, count(*) FILTER (WHERE deleted_at IS NOT NULL) AS removed
--   FROM public.apparatus;
--
-- -- 5. THE GUARD BITES. Run as a NON-DA member signed in. The direct PATCH the
-- --    build exists to close must be refused.
-- --    EXPECT: 'Only a Department Admin can remove or restore a rig.'
-- --   BEGIN;
-- --     UPDATE public.apparatus SET deleted_at = now()
-- --      WHERE id = (SELECT id FROM public.apparatus
-- --                   WHERE department_id = public.my_department_id() LIMIT 1);
-- --   ROLLBACK;
--
-- -- 5b. AN ORDINARY EDIT STILL PASSES for the same non-DA member — this is the
-- --     byte-identical invariant. EXPECT success.
-- --   BEGIN;
-- --     UPDATE public.apparatus SET note = note
-- --      WHERE id = (SELECT id FROM public.apparatus
-- --                   WHERE department_id = public.my_department_id() LIMIT 1);
-- --   ROLLBACK;
--
-- -- 6. THE ROUND TRIP, as a Department Admin. EXPECT the rig removed with your
-- --    name and a timestamp, then restored with all three cleared.
-- --   BEGIN;
-- --     SELECT id, name, deleted_at, deleted_by_name FROM public.retire_apparatus(
-- --       (SELECT id FROM public.apparatus
-- --         WHERE department_id = public.my_department_id() AND deleted_at IS NULL LIMIT 1));
-- --     SELECT id, name, deleted_at, deleted_by_name FROM public.restore_apparatus(
-- --       (SELECT id FROM public.apparatus
-- --         WHERE department_id = public.my_department_id() AND deleted_at IS NOT NULL LIMIT 1));
-- --   ROLLBACK;
--
-- -- 7. A CROSS-DEPARTMENT ID IS REFUSED. EXPECT 'That rig was not found in your
-- --    department.' — the department term doing its job.
-- --   BEGIN;
-- --     SELECT public.retire_apparatus(
-- --       (SELECT id FROM public.apparatus
-- --         WHERE department_id <> public.my_department_id() LIMIT 1));
-- --   ROLLBACK;
--
-- -- 8. UNTOUCHED PROOF — this file edits none of these.
-- SELECT pg_get_functiondef('public.is_dept_admin()'::regprocedure);
-- SELECT pg_get_functiondef('public.is_canmanage_ops()'::regprocedure);
-- SELECT pg_get_functiondef('public.my_department_id'::regproc);
-- SELECT pg_get_functiondef('public.my_member_id'::regproc);
--
-- ---------- SIGNED IN, on the deployed app ----------
-- -- 9.  Officer: no remove affordance on any rig; add-rig, edit and checklists
-- --     all work exactly as before.
-- -- 10. Department Admin: remove a rig -> it leaves every list; Recently removed
-- --     shows it with your name and the time; Restore returns it to the fleet.
-- -- 11. A removed rig is absent from the fleet list, the checklist rig picker,
-- --     the capital projection and the report read.
