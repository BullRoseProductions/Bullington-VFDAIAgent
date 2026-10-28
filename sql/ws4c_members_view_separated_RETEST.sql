-- =====================================================================
-- RETEST for ws4c_members_view_separated (WS-4c, B-4). READ-ONLY IN EFFECT — run AFTER the migration, separately.
-- Every fixture lives in a per-department sub-block ending in RAISE 'SENTINEL' (rolled back); the whole block ends in a
-- RAISE that IS the report. NOTHING CHANGES. The "ERROR" is the report.
--
-- Once:
--   O1 members_view: separated is the LAST column, boolean; security_invoker=false, owner postgres; grants as live —
--      anon / authenticated / service_role each hold SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER (arwdDxt[m])
--   O2 strip the separated column → the pinned pre-change definition (nothing else changed); no view exposes terminated_on;
--      member_separation still sealed (RLS on, 0 policies, no anon / authenticated SELECT)
--   O3 is_leader() / my_department_id() byte-identical (md5)
-- Per department (a REAL Department Admin where one exists; fixture Officer, plain Member, a SEPARATED Active member
-- (terminated yesterday), a FUTURE-separated Active member (terminated in 30 days — the server counts any row, so must
-- the view), a normal Active member):
--   T1 as the DA: separated = true for both separated fixtures, false for the normal member and for the DA
--   T2 as an Officer (a leader): the same answers
--   T3 as a plain Member: separated is NULL on every row (masked exactly like status)
--   T4 as anon (no claims): members_view returns nothing
--   T5 B-4 headcount: over the view, as the DA, the counted rule (Active/Probationary ∧ not Project Admin ∧ not separated)
--      leaves out both separated fixtures, keeps the normal member — and equals the server's own
--      dept_readiness_packet()->readiness->counted (the server rule this column exposes)
--   T6 station_presence byte-identical for the department; verified count unchanged
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0; v_ok boolean; v_err text;
  rec record; d uuid; dn text; tag text; real_da boolean;
  e_da text; e_off text; e_mem text; e_sep text; e_fut text; e_norm text;
  m_da uuid; m_off uuid; m_mem uuid; m_sep uuid; m_fut uuid; m_norm uuid;
  c_view_md5 constant text := '5c78c518a924963a3f0acf61e8184e19';
  v_sp_before text; v_sp_after text; v_ver_before bigint; v_ver_after bigint;
  a_sep boolean; a_fut boolean; a_norm boolean; a_da boolean; n_rows bigint; n_nonnull bigint; v_count bigint; v_has_sep boolean; v_has_norm boolean; v_packet bigint;
BEGIN
  -- ---------------------------------------------------------------- once
  IF (SELECT column_name || ':' || data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members_view'
        ORDER BY ordinal_position DESC LIMIT 1) = 'separated:boolean'
     AND (SELECT coalesce(array_to_string(reloptions, ','), '') || '|' || pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.members_view'::regclass) = 'security_invoker=false|postgres'
     -- grants unchanged: live = arwdDxt(m) for anon, authenticated, service_role — checked privilege by privilege
     -- (portable; the migration itself proves the ACL string identical before/after)
     AND (SELECT bool_and(has_table_privilege(r, 'public.members_view', p))
            FROM unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p) THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O1 members_view: separated (boolean) is the last column; security_invoker=false, owner postgres; grants as live (anon / authenticated / service_role)' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O1 members_view column / options / ACL not as intended' || chr(10); END IF;

  IF md5(regexp_replace(pg_get_viewdef('public.members_view'::regclass, true),
           E',\\s+CASE\\s+WHEN is_leader\\(\\) THEN \\(EXISTS \\( SELECT 1\\s+FROM member_separation s\\s+WHERE s\\.member_id = members\\.id\\)\\)\\s+ELSE NULL::boolean\\s+END AS separated', '')) = c_view_md5
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns c JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
                      WHERE c.table_schema = 'public' AND c.column_name = 'terminated_on')
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.member_separation'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_separation')
     AND NOT has_table_privilege('anon', 'public.member_separation', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.member_separation', 'SELECT') THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O2 only separated was added (the rest = the pinned definition); terminated_on in no view; member_separation sealed' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O2 the view changed beyond separated, or terminated_on leaked, or member_separation unsealed' || chr(10); END IF;

  IF md5(pg_get_functiondef('public.is_leader()'::regprocedure)) = '3f462af26a46909309f856f769226baa'
     AND md5(pg_get_functiondef('public.my_department_id()'::regprocedure)) = '87f546659c3804a943b48e419e017f18' THEN
    v_pass := v_pass + 1; rpt := rpt || 'PASS  O3 is_leader() / my_department_id() byte-identical' || chr(10);
  ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  O3 is_leader() or my_department_id() changed' || chr(10); END IF;

  -- ---------------------------------------------------------------- per department
  FOR rec IN SELECT dep.id, dep.name FROM public.departments dep ORDER BY dep.name LOOP
    d := rec.id; dn := rec.name; tag := 'ws4crt-' || left(replace(d::text, '-', ''), 8);
    rpt := rpt || '— ' || dn || chr(10);
    BEGIN
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_before FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
      e_da := null; m_da := null;
      SELECT lower(m.email), m.id INTO e_da, m_da FROM public.members m WHERE m.department_id = d AND m.status IN ('Active', 'Probationary')
         AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
         AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
         AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id) ORDER BY m.id LIMIT 1;
      real_da := e_da IS NOT NULL;
      IF NOT real_da THEN
        e_da := tag || '-da@retest.invalid';
        INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST DA', e_da, '{Department Admin}', 'Active') RETURNING id INTO m_da;
      END IF;
      e_off := tag || '-off@retest.invalid'; e_mem := tag || '-mem@retest.invalid'; e_sep := tag || '-sep@retest.invalid';
      e_fut := tag || '-fut@retest.invalid'; e_norm := tag || '-norm@retest.invalid';
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Officer', e_off, '{Officer}', 'Active') RETURNING id INTO m_off;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Member', e_mem, '{Member}', 'Active') RETURNING id INTO m_mem;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Separated', e_sep, '{Member}', 'Active') RETURNING id INTO m_sep;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Future-separated', e_fut, '{Member}', 'Active') RETURNING id INTO m_fut;
      INSERT INTO public.members (department_id, name, email, access, status) VALUES (d, 'RETEST Normal', e_norm, '{Member}', 'Active') RETURNING id INTO m_norm;
      INSERT INTO public.member_separation (member_id, department_id, terminated_on, set_by_member, set_at) VALUES
        (m_sep, d, current_date - 1, m_da, now()), (m_fut, d, current_date + 30, m_da, now());
      rpt := rpt || format('   (leader = a %s Department Admin)%s', CASE WHEN real_da THEN 'REAL' ELSE 'fixture' END, chr(10));

      -- ---- T1 / T2 as a leader (DA, then Officer)
      FOR k IN 1..2 LOOP
        v_ok := true; v_err := '';
        PERFORM set_config('request.jwt.claims', json_build_object('email', CASE k WHEN 1 THEN e_da ELSE e_off END)::text, true);
        BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
          SELECT separated INTO a_sep FROM public.members_view WHERE id = m_sep;
          SELECT separated INTO a_fut FROM public.members_view WHERE id = m_fut;
          SELECT separated INTO a_norm FROM public.members_view WHERE id = m_norm;
          SELECT separated INTO a_da FROM public.members_view WHERE id = m_da;
          EXECUTE 'RESET ROLE';
        EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
        IF v_ok AND a_sep IS TRUE AND a_fut IS TRUE AND a_norm IS FALSE AND a_da IS FALSE THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  T%s as the %s: separated true (yesterday + future-dated), false (normal member, the DA)%s', k, CASE k WHEN 1 THEN 'DA' ELSE 'Officer' END, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T%s as the %s: sep=%s fut=%s norm=%s da=%s %s%s', k, CASE k WHEN 1 THEN 'DA' ELSE 'Officer' END, a_sep, a_fut, a_norm, a_da, v_err, chr(10)); END IF;
      END LOOP;

      -- ---- T3 as a plain Member: masked
      v_ok := true; v_err := '';
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_mem)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*), count(separated) INTO n_rows, n_nonnull FROM public.members_view;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND n_rows >= 6 AND n_nonnull = 0 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T3 as a plain Member: %s rows, separated NULL on every one (masked like status)%s', n_rows, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T3 plain Member sees separated on %s of %s rows %s%s', n_nonnull, n_rows, v_err, chr(10)); END IF;

      -- ---- T4 as anon: nothing. Live, anon has no EXECUTE on my_department_id() / is_leader() (the anon-revoke pattern),
      -- so the view is DENIED outright — stronger than an empty set, and untouched by this view-only migration. Either
      -- outcome passes; anything that returns a row fails. (Fixed after the first live run, 2026-10-27: T4 expected an
      -- empty set because the PGlite mock granted anon default EXECUTE; it also printed a stale row count.)
      v_ok := true; v_err := ''; n_rows := null;
      PERFORM set_config('request.jwt.claims', '', true);
      BEGIN EXECUTE 'SET LOCAL ROLE anon';
        SELECT count(*) INTO n_rows FROM public.members_view;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND n_rows = 0 THEN v_pass := v_pass + 1; rpt := rpt || '   PASS  T4 as anon: members_view returns nothing' || chr(10);
      ELSIF NOT v_ok AND v_err LIKE 'permission denied%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  T4 as anon: members_view denied outright (%s)%s', v_err, chr(10));
      ELSIF v_ok THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 anon got %s rows from members_view%s', n_rows, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T4 anon read failed for another reason: %s%s', v_err, chr(10)); END IF;

      -- ---- T5 B-4 headcount over the view = the server's packet headcount
      v_ok := true; v_err := ''; v_packet := null;
      PERFORM set_config('request.jwt.claims', json_build_object('email', e_da)::text, true);
      BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        SELECT count(*), bool_or(id = m_sep OR id = m_fut), bool_or(id = m_norm) INTO v_count, v_has_sep, v_has_norm
          FROM public.members_view
         WHERE status IN ('Active', 'Probationary') AND NOT coalesce(access && array['Project Admin']::text[], false) AND separated IS NOT TRUE;
        IF to_regprocedure('public.dept_readiness_packet()') IS NOT NULL THEN
          BEGIN v_packet := (public.dept_readiness_packet()->'readiness'->>'counted')::bigint;
          EXCEPTION WHEN OTHERS THEN v_err := 'packet: ' || SQLERRM; END;
        END IF;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; v_ok := false; v_err := SQLERRM; END;
      IF v_ok AND v_has_sep IS NOT TRUE AND v_has_norm IS TRUE AND v_packet IS NOT NULL AND v_count = v_packet THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T5 B-4 headcount over the view = %s = the server''s readiness packet; both separated fixtures out, the normal member in%s', v_count, chr(10));
      ELSIF v_ok AND v_has_sep IS NOT TRUE AND v_has_norm IS TRUE AND v_packet IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  T5 headcount %s excludes both separated fixtures; packet not comparable here (%s)%s', v_count, coalesce(nullif(v_err, ''), 'no dept_readiness_packet'), chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T5 headcount %s vs packet %s; separated in=%s normal in=%s %s%s', v_count, v_packet, v_has_sep, v_has_norm, v_err, chr(10)); END IF;

      -- ---- T6 station_presence untouched; verified unchanged
      SELECT md5(coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id), '')) INTO v_sp_after FROM public.station_presence p WHERE p.department_id = d;
      SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
      IF v_sp_after = v_sp_before AND v_ver_after = v_ver_before THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  T6 station_presence byte-identical; verified count %s unchanged%s', v_ver_before, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  T6 station_presence changed (verified %s -> %s)%s', v_ver_before, v_ver_after, chr(10)); END IF;

      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  department block aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
