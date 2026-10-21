-- =====================================================================
-- RETEST for cert_rollup_regex_fix (G2; applied 2026-10-21) — run AFTER the migration, separately.
-- RAN on live 2026-10-21: 11 passed, 0 failed, 0 skipped — S0; M1 + L1 in all five departments. Indian Harbor L1 read
-- expiring 9 · expired 22 = 21 '0000-00' placeholders + the 1 fixture (G1 not yet applied — G1 takes it to 1).
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on
-- FIXTURES it creates itself — a fixture member (a fresh email, Active, plain Member) with four certs: one current
-- (expiry month +8), one expiring (+1), one expired (−2), one blank. Months are computed from now() exactly as the
-- function does (extract(year/month from now())). The final RAISE is the report — the "ERROR" IS the report.
--   S0 (once) all five cert regexes are single-backslash; none doubled
-- Per department:
--   M1 the fixture member: my_certs_current / my_certs_expiring / my_certs_expired = 1 / 1 / 1 (the blank uncounted);
--      can_manage false and the leadership counts NULL (still gated) — before the fix this read 0 / 0 / 0
--   L1 a real Department Admin there (unique email, not a Project Admin): can_manage true; expiring_certs_count and
--      expired_certs_count equal the department's dated certs counted directly with the sibling rule
--      (pa_department_radar's), each ≥ 1 (the fixtures alone guarantee it)
-- =====================================================================
DO $retest$
DECLARE
  rec record; r record; v_n int; v_ok boolean;
  v_email text; v_mid uuid; v_da text; v_exp_e bigint; v_exp_x bigint;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT (length(prosrc) - length(replace(prosrc, $re$'^\d{4}-\d{2}$'$re$, ''))) / length($re$'^\d{4}-\d{2}$'$re$)
    INTO v_n FROM pg_proc WHERE oid = 'public.my_department_rollup()'::regprocedure;
  SELECT position($re$'^\\d{4}-\\d{2}$'$re$ in prosrc) = 0 INTO v_ok FROM pg_proc WHERE oid = 'public.my_department_rollup()'::regprocedure;
  IF v_n = 5 AND v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 all 5 cert regexes in my_department_rollup() are single-backslash; none doubled%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 single-backslash %s/5 · none doubled %s%s', v_n, v_ok, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    BEGIN
      -- fixtures (owner)
      v_email := 'retest.rollup.' || replace(rec.dept_id::text, '-', '') || '@b4c.invalid';
      INSERT INTO public.members (department_id, email, name, access, status)
        VALUES (rec.dept_id, v_email, 'RETEST rollup fixture', array['Member']::text[], 'Active') RETURNING id INTO v_mid;
      INSERT INTO public.certs (department_id, member_id, name, exp) VALUES
        (rec.dept_id, v_mid, 'RETEST current',  to_char(now() + interval '8 months', 'YYYY-MM')),
        (rec.dept_id, v_mid, 'RETEST expiring', to_char(now() + interval '1 month',  'YYYY-MM')),
        (rec.dept_id, v_mid, 'RETEST expired',  to_char(now() - interval '2 months', 'YYYY-MM')),
        (rec.dept_id, v_mid, 'RETEST blank',    NULL);

      -- M1 the fixture member
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT * INTO r FROM public.my_department_rollup() x WHERE x.department_id = rec.dept_id;
      PERFORM set_config('role', 'postgres', true);
      IF r.my_certs_current = 1 AND r.my_certs_expiring = 1 AND r.my_certs_expired = 1 AND r.can_manage IS FALSE
         AND r.expiring_certs_count IS NULL AND r.expired_certs_count IS NULL THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  M1 member card counts current 1 · expiring 1 · expired 1 (blank uncounted); leadership counts still NULL%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M1 current %s · expiring %s · expired %s · can_manage %s · dept expiring %s · dept expired %s%s',
        r.my_certs_current, r.my_certs_expiring, r.my_certs_expired, r.can_manage, r.expiring_certs_count, r.expired_certs_count, chr(10)); END IF;

      -- L1 a real Department Admin
      v_da := NULL;
      SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
         AND NOT m.access && array['Project Admin']::text[] AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      IF v_da IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  L1 no Department Admin with a unique email here%s', chr(10));
      ELSE
        SELECT count(*) FILTER (WHERE (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
                                      - (extract(year from now())::int*12 + extract(month from now())::int) BETWEEN 0 AND 3),
               count(*) FILTER (WHERE (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
                                      - (extract(year from now())::int*12 + extract(month from now())::int) < 0)
          INTO v_exp_e, v_exp_x FROM public.certs c WHERE c.department_id = rec.dept_id AND c.exp ~ '^\d{4}-\d{2}$';
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        SELECT * INTO r FROM public.my_department_rollup() x WHERE x.department_id = rec.dept_id;
        PERFORM set_config('role', 'postgres', true);
        IF r.can_manage IS TRUE AND r.expiring_certs_count = v_exp_e AND r.expired_certs_count = v_exp_x AND v_exp_e >= 1 AND v_exp_x >= 1 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  L1 Department Admin: expiring %s · expired %s = the department''s dated certs counted directly%s', v_exp_e, v_exp_x, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  L1 can_manage %s · expiring %s (expected %s) · expired %s (expected %s)%s',
          r.can_manage, r.expiring_certs_count, v_exp_e, r.expired_certs_count, v_exp_x, chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
