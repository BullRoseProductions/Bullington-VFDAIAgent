-- =====================================================================
-- SECURITY PROBE — members INSERT / DELETE gated by is_leader() with no department condition (cross-tenant?).
-- READ-ONLY IN EFFECT: every write is inside a sub-block that ends in RAISE 'SENTINEL' (rolled back). The final RAISE is
-- the report. The "ERROR" IS the report — nothing is changed, no member is deleted or created.
--
-- Prints: the live is_leader() body and every members policy. Then, for each department A that has a leader (a member
-- for whom is_leader() is true, not a Project Admin) with a unique email, signed in as that leader (JWT email claim +
-- role authenticated, exactly as the app does), against ANOTHER department B:
--   X1  DELETE a member of B           -> rows actually deleted (0 = blocked; >0 = CROSS-TENANT DELETE)
--   X2  INSERT a member into B         -> allowed? (allowed = CROSS-TENANT INSERT)
--   B1  INSERT a member into A (own)   -> baseline: what a leader can do in their own department today
--   X3  DELETE a member of B by a predicate that doesn't read a column (WHERE true AND id = …) — same as X1 in practice;
--       listed so the result isn't an artefact of one WHERE shape
-- =====================================================================
DO $probe$
DECLARE
  rec record; v_n int; v_err text; v_leader text; v_victim uuid; v_bdept uuid; v_bname text;
  rpt text := chr(10);
BEGIN
  rpt := rpt || 'is_leader():' || chr(10) || regexp_replace(pg_get_functiondef('public.is_leader()'::regprocedure), '\s+', ' ', 'g') || chr(10) || chr(10);
  FOR rec IN SELECT policyname, cmd, roles::text AS roles, coalesce(qual, '') AS qual, coalesce(with_check, '') AS wc
               FROM pg_policies WHERE schemaname = 'public' AND tablename = 'members' ORDER BY cmd, policyname LOOP
    rpt := rpt || format('policy %s [%s] %s USING (%s) CHECK (%s)%s', rec.policyname, rec.cmd, rec.roles, rec.qual, rec.wc, chr(10));
  END LOOP;
  rpt := rpt || chr(10);

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    v_leader := NULL; v_victim := NULL; v_bdept := NULL;
    -- a leader of A by the LIVE is_leader() (evaluated as them), not a Project Admin
    SELECT lower(m.email) INTO v_leader FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.email IS NOT NULL AND NOT coalesce(m.access && array['Project Admin']::text[], false)
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
       AND m.access && array['Department Admin','Board Member','Officer','Training Officer']::text[]
     ORDER BY m.id LIMIT 1;
    SELECT m.id, m.department_id, d2.name INTO v_victim, v_bdept, v_bname FROM public.members m JOIN public.departments d2 ON d2.id = m.department_id
     WHERE m.department_id <> rec.dept_id ORDER BY m.id LIMIT 1;
    rpt := rpt || format('— leader of %s (%s) vs %s%s', rec.dept, coalesce(v_leader, 'none'), coalesce(v_bname, 'none'), chr(10));
    IF v_leader IS NULL OR v_victim IS NULL THEN rpt := rpt || '   SKIP  no leader with a unique email, or no other department' || chr(10); CONTINUE; END IF;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_leader, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      rpt := rpt || format('   is_leader() as them = %s%s', public.is_leader(), chr(10));
      -- X1
      BEGIN DELETE FROM public.members WHERE id = v_victim; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
      rpt := rpt || format('   X1 DELETE a %s member      -> %s%s%s', v_bname, CASE WHEN v_n > 0 THEN 'CROSS-TENANT DELETE (' || v_n || ' row)' WHEN v_n = 0 THEN 'blocked (0 rows)' ELSE 'error' END, CASE WHEN v_err <> 'OK' THEN ': ' || v_err ELSE '' END, chr(10));
      -- X3
      BEGIN DELETE FROM public.members WHERE true AND id = v_victim; GET DIAGNOSTICS v_n = ROW_COUNT; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_n := NULL; END;
      rpt := rpt || format('   X3 DELETE (other WHERE)    -> %s%s%s', CASE WHEN v_n > 0 THEN 'CROSS-TENANT DELETE' WHEN v_n = 0 THEN 'blocked (0 rows)' ELSE 'error' END, CASE WHEN v_err <> 'OK' THEN ': ' || v_err ELSE '' END, chr(10));
      -- X2
      BEGIN INSERT INTO public.members (department_id, name, email, access, status)
            VALUES (v_bdept, 'PROBE cross-dept', 'probe-' || gen_random_uuid() || '@probe.invalid', array['Member'], 'Active'); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      rpt := rpt || format('   X2 INSERT into %s         -> %s%s', v_bname, CASE WHEN v_err = 'OK' THEN 'CROSS-TENANT INSERT allowed' ELSE 'refused: ' || v_err END, chr(10));
      -- B1 baseline
      BEGIN INSERT INTO public.members (department_id, name, email, access, status)
            VALUES (rec.dept_id, 'PROBE own-dept', 'probe-' || gen_random_uuid() || '@probe.invalid', array['Member'], 'Active'); v_err := 'OK';
      EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      rpt := rpt || format('   B1 INSERT into own dept    -> %s%s', CASE WHEN v_err = 'OK' THEN 'allowed (baseline)' ELSE 'refused: ' || v_err END, chr(10));
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN rpt := rpt || '   probe aborted: ' || SQLERRM || chr(10); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION E'%\n(this exception IS the rollback — nothing was changed)', rpt;
END
$probe$;
