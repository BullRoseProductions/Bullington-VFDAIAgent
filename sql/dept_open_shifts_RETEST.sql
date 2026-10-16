-- =====================================================================
-- RETEST for dept_open_shifts_DRAFT.sql. READ-ONLY — run AFTER the migration, separately. NOTHING CHANGES (the function
-- only reads; the whole block ends in a RAISE that is the report). The "ERROR" IS the report.
-- Once: anon can't execute.
-- For each department:
--   A. a Department Admin gets exactly the department's open standby/off-site shifts (count = owner's count), every
--      row has a shift_id, and every shift_id belongs to this department
--   B. an Officer (no DA/PA) is refused ("Not authorized") — same gate as close_open_shift
--   C. a plain member is refused
-- DRY RUN 2026-10-16 — PGlite mock (2 departments, Supabase-style default grants, RLS on station_presence): migration
-- OK + idempotent; this RETEST 5 passed / 0 failed / 2 skipped. Mutations: gate removed -> B+C FAIL; department filter
-- removed -> A FAIL (foreign rows); anon left executable -> migration rolls back.
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_da text; v_off text; v_mem text; v_err text;
  v_owner int; v_got int; v_foreign int; v_noid int; v_ids uuid[];
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  IF NOT has_function_privilege('anon', 'public.dept_open_shifts()', 'EXECUTE') THEN
    v_pass := v_pass + 1; rpt := rpt || format('PASS  anon can''t execute%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  anon can execute%s', chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_mem := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m
     WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[] AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_mem FROM public.members m
     WHERE m.department_id = rec.dept_id AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;

    BEGIN
      IF v_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  A — no DA with a unique email%s', chr(10));
      ELSE
        SELECT count(*) INTO v_owner FROM public.station_presence
         WHERE department_id = rec.dept_id AND checked_out_at IS NULL AND kind IN ('standby', 'offsite');
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        SELECT count(*), count(*) FILTER (WHERE s.shift_id IS NULL), coalesce(array_agg(s.shift_id), '{}')
          INTO v_got, v_noid, v_ids FROM public.dept_open_shifts() s;
        PERFORM set_config('role', 'postgres', true);
        SELECT count(*) INTO v_foreign FROM public.station_presence sp WHERE sp.id = ANY (v_ids) AND sp.department_id <> rec.dept_id;
        IF v_got = v_owner AND v_noid = 0 AND v_foreign = 0 THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  A DA sees all %s open standby/off-site shift(s), each with its id, none foreign%s', v_got, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A DA got %s (owner %s), %s without id, %s foreign%s', v_got, v_owner, v_noid, v_foreign, chr(10)); END IF;
      END IF;
      IF v_off IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  B — no officer with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_off, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM * FROM public.dept_open_shifts(); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'Not authorized' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  B officer refused%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  B officer -> "%s"%s', v_err, chr(10)); END IF;
      END IF;
      IF v_mem IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  C — no plain member with a unique email%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM * FROM public.dept_open_shifts(); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err = 'Not authorized' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  C member refused%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C member -> "%s"%s', v_err, chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
