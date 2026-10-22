-- =====================================================================
-- RETEST addendum for cert_catalog_sliceA — T3b only (probation_item_states honours never_expires). Run separately.
-- The main RETEST skipped T3b on live: onboarding_items.category is NOT NULL, so a minimal fixture item failed. This
-- one CLONES an existing onboarding item of the department (every required column carried over), overriding only id,
-- label, kind = 'cert', cert_name and the manual-only config, so whatever live requires is already filled in.
-- NOTHING CHANGES: each department's check runs in a sub-block that ends in RAISE 'SENTINEL' (rolled back).
-- Per department (needs a DA and a plain member, unique emails, and at least one existing onboarding item):
--   P0 control: with the fixture cert UNTYPED and blank-exp, the cloned cert item reads NOT satisfied / 'missing'
--   P1 after a DA assigns a never-expires type: the same item reads satisfied / 'current'
-- =====================================================================
DO $retest$
DECLARE
  rec record; r0 record; r1 record; v_da text; v_mem_id uuid; v_c uuid; v_type uuid; v_item uuid; e1 text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_mem_id := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT m.id INTO v_mem_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_mem_id IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  needs a DA and a plain member here, unique emails%s', chr(10)); CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.onboarding_items WHERE department_id = rec.dept_id) THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  no onboarding item here to clone%s', chr(10)); CONTINUE;
    END IF;
    BEGIN
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES (rec.dept_id, v_mem_id, 'RETEST cert-catalog probation', NULL) RETURNING id INTO v_c;
      INSERT INTO public.onboarding_items
        SELECT (jsonb_populate_record(NULL::public.onboarding_items,
                  to_jsonb(i) || jsonb_build_object('id', gen_random_uuid(), 'label', 'RETEST cert-catalog item', 'kind', 'cert',
                                                    'cert_name', 'RETEST cert-catalog probation', 'is_mentor', false, 'requires_doc', false,
                                                    'approver_kind', null, 'approver_member_id', null, 'approver_role', null,
                                                    'hours_target', null, 'hours_source', null, 'ack_series_id', null))).*
          FROM public.onboarding_items i WHERE i.department_id = rec.dept_id ORDER BY i.id LIMIT 1
        RETURNING id INTO v_item;
      -- P0 control: untyped, blank exp -> not current
      SELECT p.satisfied, p.state INTO r0 FROM public.probation_item_states(v_mem_id, rec.dept_id) p WHERE p.item_id = v_item;
      -- the DA makes a never-expires type and assigns it
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok';
      BEGIN
        SELECT (public.set_cert_type(NULL, 'RETEST probation type', true, 'certification')).id INTO v_type;
        PERFORM public.assign_cert_type(v_c, v_type);
      EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT p.satisfied, p.state INTO r1 FROM public.probation_item_states(v_mem_id, rec.dept_id) p WHERE p.item_id = v_item;
      IF e1 = 'ok' AND r0.satisfied IS FALSE AND r0.state = 'missing' AND r1.satisfied IS TRUE AND r1.state = 'current' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  P0/P1 cloned cert item: untyped blank-exp cert reads missing; once a never-expires type is assigned it reads satisfied / current%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P0 %s/%s · assign: %s · P1 %s/%s%s', r0.satisfied, r0.state, e1, r1.satisfied, r1.state, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;
  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
