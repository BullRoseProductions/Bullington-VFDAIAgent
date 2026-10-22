-- =====================================================================
-- RETEST for cert_catalog_sliceB (applied 2026-10-21) — run AFTER the migration, separately.
-- First live run (2026-10-21, 137c4b4): S0 + R1–R6 PASS in Indian Harbor / Lipan / North Hood; R7 aborted in all three —
-- a RETEST bug, not the migration: the member_active_department fixture was written while still role 'authenticated'
-- (RLS refused it). Fixed: the fixture is written as the owner, then the other-department DA's call runs as authenticated.
-- RAN on live 2026-10-21 (ba753a7): 22 passed, 0 failed, 2 skipped — S0; Indian Harbor + Lipan + North Hood R1–R7;
-- Demo + Granbury skip all (no plain member). Slice B fully proven on live.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on
-- FIXTURES it creates itself: two cert types (one never-expires, one that expires) and certs for a plain member,
-- all named 'RETEST …'. The final RAISE is the report — the "ERROR" IS the report. readiness_items / readiness_verdict
-- are internal, so they're read as the owner; set_readiness_requirement / dept_readiness_requirements run with the
-- caller's JWT claims (the RPC itself as the role 'authenticated').
--   S0 (once) the kind CHECK allows cert_type; ref_chk + readiness_requirements_uq unchanged
-- Per department (needs a DA, a plain member and a DA of ANOTHER department, unique emails):
--   R1 the DA: requires both types (set_readiness_requirement 'cert_type'); a NULL ref, and another department's type,
--      are refused ("not set up in your department"); a second set of the same type upserts (one row)
--   R2 configurator: dept_readiness_requirements() labels them with the types' names — never "Fit test"
--   R3 the never-expires type, member holds a blank-exp cert of it: satisfied, status current, expires_on NULL
--   R4 the expiring type, the member's cert of it walked through: none → missing · expired → expired (unsatisfied) ·
--      +1 month → expiring (satisfied) · +12 months → current (satisfied, dated) · blank → no_date (unsatisfied)
--   R5 readiness_verdict: the missing type is in 'outstanding' by name; an expiring one is in 'renewals_due'
--   R6 the type deleted: the requirement reads 'Cert type (removed)', not_configured, unsatisfied (honest)
--   R7 a plain member can't set a requirement; a DA of another department can't require this department's type
-- =====================================================================
DO $retest$
DECLARE
  rec record; it record; v_ok boolean; v_n int;
  v_da text; v_mem text; v_mem_id uuid; v_ada text; v_ada_home uuid;
  v_tn uuid; v_te uuid; v_tf uuid; v_cn uuid; v_ce uuid; v_rq_n uuid; v_rq_e uuid; e1 text; e2 text; e3 text; v_lbl text; v_steps text; v_v jsonb;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT (SELECT pg_get_constraintdef(oid) LIKE '%''cert_type''::text%' FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname = 'readiness_requirements_kind_check')
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.readiness_requirements'::regclass AND conname = 'readiness_requirements_ref_chk') = 'CHECK (((kind ~~ ''credential\_%''::text) = (ref_id IS NULL)))'
     AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'readiness_requirements_uq' AND indexdef LIKE '%NULLS NOT DISTINCT')
    INTO v_ok;
  IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 kind CHECK allows cert_type; ref_chk and readiness_requirements_uq unchanged%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 kind / ref_chk / uq not as expected%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_mem := NULL; v_mem_id := NULL; v_ada := NULL; v_ada_home := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_mem, v_mem_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.department_id INTO v_ada, v_ada_home FROM public.members m WHERE m.department_id <> rec.dept_id
       AND m.access && array['Department Admin']::text[] AND NOT m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary')
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_mem IS NULL OR v_ada IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA here, a plain member here and a DA of another department, unique emails (DA %s, member %s, other-dept DA %s)%s',
        coalesce(v_da, 'none'), coalesce(v_mem, 'none'), coalesce(v_ada, 'none'), chr(10));
      CONTINUE;
    END IF;
    BEGIN
      -- fixtures (owner): two types here, one in the other department; a blank-exp cert of the never-expires type
      INSERT INTO public.cert_types (department_id, name, never_expires) VALUES (rec.dept_id, 'RETEST NoExpiry Type', true) RETURNING id INTO v_tn;
      INSERT INTO public.cert_types (department_id, name, never_expires) VALUES (rec.dept_id, 'RETEST Expiring Type', false) RETURNING id INTO v_te;
      INSERT INTO public.cert_types (department_id, name, never_expires) VALUES (v_ada_home, 'RETEST Foreign Type', true) RETURNING id INTO v_tf;
      INSERT INTO public.certs (department_id, member_id, name, exp, cert_type_id) VALUES (rec.dept_id, v_mem_id, 'RETEST no-expiry cert', NULL, v_tn) RETURNING id INTO v_cn;

      -- R1 the DA requires both types
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok'; e2 := 'ok'; e3 := 'ok';
      BEGIN
        SELECT (public.set_readiness_requirement('cert_type', v_tn, true)).id INTO v_rq_n;
        SELECT (public.set_readiness_requirement('cert_type', v_te, true)).id INTO v_rq_e;
        PERFORM public.set_readiness_requirement('cert_type', v_te, true);   -- upsert, not a second row
      EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      BEGIN PERFORM public.set_readiness_requirement('cert_type', NULL, true); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      BEGIN PERFORM public.set_readiness_requirement('cert_type', v_tf, true); EXCEPTION WHEN OTHERS THEN e3 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM public.readiness_requirements WHERE department_id = rec.dept_id AND kind = 'cert_type' AND ref_id IN (v_tn, v_te) AND required;
      IF e1 = 'ok' AND v_n = 2 AND e2 = 'That cert type is not set up in your department.' AND e3 = 'That cert type is not set up in your department.'
         AND NOT EXISTS (SELECT 1 FROM public.readiness_requirements WHERE kind = 'cert_type' AND ref_id = v_tf) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 DA requires both types (a repeat upserts — 2 rows); a NULL ref and another department''s type are refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 set: %s · rows %s · null ref: %s · foreign type: %s%s', e1, v_n, e2, e3, chr(10)); END IF;

      -- R2 configurator labels (DA claims, as owner)
      SELECT string_agg(x.label, ' | ' ORDER BY x.label) INTO v_lbl FROM public.dept_readiness_requirements() x WHERE x.kind = 'cert_type' AND x.ref_id IN (v_tn, v_te);
      IF v_lbl = 'RETEST Expiring Type | RETEST NoExpiry Type' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R2 dept_readiness_requirements labels both by the type''s name (never "Fit test")%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R2 labels: %s%s', v_lbl, chr(10)); END IF;

      -- R3 the never-expires type
      SELECT * INTO it FROM public.readiness_items(rec.dept_id, v_mem_id) x WHERE x.requirement_id = v_rq_n;
      IF it.satisfied IS TRUE AND it.status = 'current' AND it.expires_on IS NULL AND it.label = 'RETEST NoExpiry Type' AND it.kind = 'cert_type' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R3 never-expires type + a blank-exp cert of it: satisfied, current, no date%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R3 satisfied %s · status %s · expires %s · label %s%s', it.satisfied, it.status, it.expires_on, it.label, chr(10)); END IF;

      -- R4 the expiring type, walked through
      v_steps := '';
      SELECT * INTO it FROM public.readiness_items(rec.dept_id, v_mem_id) x WHERE x.requirement_id = v_rq_e;
      v_steps := v_steps || format('none:%s/%s ', it.satisfied, it.status);
      v_ok := it.satisfied IS FALSE AND it.status = 'missing';
      INSERT INTO public.certs (department_id, member_id, name, exp, cert_type_id) VALUES (rec.dept_id, v_mem_id, 'RETEST expiring cert', '2020-01', v_te) RETURNING id INTO v_ce;
      SELECT * INTO it FROM public.readiness_items(rec.dept_id, v_mem_id) x WHERE x.requirement_id = v_rq_e;
      v_steps := v_steps || format('expired:%s/%s ', it.satisfied, it.status); v_ok := v_ok AND it.satisfied IS FALSE AND it.status = 'expired';
      UPDATE public.certs SET exp = to_char((now() at time zone 'America/Chicago') + interval '1 month', 'YYYY-MM') WHERE id = v_ce;
      SELECT * INTO it FROM public.readiness_items(rec.dept_id, v_mem_id) x WHERE x.requirement_id = v_rq_e;
      v_steps := v_steps || format('+1mo:%s/%s ', it.satisfied, it.status); v_ok := v_ok AND it.satisfied IS TRUE AND it.status = 'expiring' AND it.expires_on IS NOT NULL;
      v_v := public.readiness_verdict(rec.dept_id, v_mem_id);
      v_ok := v_ok AND (v_v -> 'renewals_due') @> jsonb_build_array(jsonb_build_object('label', 'RETEST Expiring Type'));
      UPDATE public.certs SET exp = to_char((now() at time zone 'America/Chicago') + interval '12 months', 'YYYY-MM') WHERE id = v_ce;
      SELECT * INTO it FROM public.readiness_items(rec.dept_id, v_mem_id) x WHERE x.requirement_id = v_rq_e;
      v_steps := v_steps || format('+12mo:%s/%s ', it.satisfied, it.status); v_ok := v_ok AND it.satisfied IS TRUE AND it.status = 'current' AND it.expires_on IS NOT NULL;
      UPDATE public.certs SET exp = NULL WHERE id = v_ce;
      SELECT * INTO it FROM public.readiness_items(rec.dept_id, v_mem_id) x WHERE x.requirement_id = v_rq_e;
      v_steps := v_steps || format('blank:%s/%s', it.satisfied, it.status); v_ok := v_ok AND it.satisfied IS FALSE AND it.status = 'no_date';
      IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  R4 expiring type: missing → expired (unsatisfied) → expiring (satisfied, in renewals_due) → current → no_date (unsatisfied)%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R4 %s%s', v_steps, chr(10)); END IF;

      -- R5 the verdict names an outstanding type
      DELETE FROM public.certs WHERE id = v_ce;
      v_v := public.readiness_verdict(rec.dept_id, v_mem_id);
      IF (v_v -> 'outstanding') @> to_jsonb(array['RETEST Expiring Type — missing']) AND v_v ->> 'state' = 'not_ready'
         AND (v_v -> 'items') @> jsonb_build_array(jsonb_build_object('requirement_id', v_rq_n, 'kind', 'cert_type', 'satisfied', true)) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R5 verdict: not_ready, "RETEST Expiring Type — missing" outstanding; the never-expires item satisfied%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R5 state %s · outstanding %s%s', v_v ->> 'state', v_v -> 'outstanding', chr(10)); END IF;

      -- R6 the type deleted — honest, never satisfied
      DELETE FROM public.cert_types WHERE id = v_tn;
      SELECT * INTO it FROM public.readiness_items(rec.dept_id, v_mem_id) x WHERE x.requirement_id = v_rq_n;
      SELECT x.label INTO v_lbl FROM public.dept_readiness_requirements() x WHERE x.id = v_rq_n;
      IF it.satisfied IS FALSE AND it.status = 'not_configured' AND it.label = 'Cert type (removed)' AND v_lbl = 'Cert type (removed)' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R6 a deleted type''s requirement reads "Cert type (removed)", not_configured, unsatisfied%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R6 satisfied %s · status %s · label %s · configurator %s%s', it.satisfied, it.status, it.label, v_lbl, chr(10)); END IF;

      -- R7 a plain member, and a DA of another department
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e1 := 'ok';
      BEGIN PERFORM public.set_readiness_requirement('cert_type', v_te, false); EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);   -- the fixture write is the owner's, never the member's (RLS on member_active_department)
      INSERT INTO public.member_active_department (email, department_id) VALUES (v_ada, v_ada_home) ON CONFLICT (email) DO UPDATE SET department_id = excluded.department_id;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_ada, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      e2 := 'ok';
      BEGIN PERFORM public.set_readiness_requirement('cert_type', v_te, true); EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF e1 = 'Only a Department Admin can set the readiness standard.' AND e2 = 'That cert type is not set up in your department.'
         AND (SELECT required FROM public.readiness_requirements WHERE id = v_rq_e)
         AND NOT EXISTS (SELECT 1 FROM public.readiness_requirements WHERE department_id = v_ada_home AND kind = 'cert_type' AND ref_id = v_te) THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R7 plain member refused; a DA of another department can''t require this department''s type%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R7 member: %s · other-dept DA: %s%s', e1, e2, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
