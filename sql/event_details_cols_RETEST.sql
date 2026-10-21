-- =====================================================================
-- RETEST for event_details_cols (DRAFT, not applied) — run AFTER the migration, separately.
-- NOTHING CHANGES: each department's checks run inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on
-- FIXTURE events it creates itself (one date-only funding_event and one date-only recruitment_event, inserted as the
-- owner — "an existing event"). The final RAISE is the report — the "ERROR" IS the report. Reads-back are done as the
-- owner. A refused INSERT raises (RLS WITH CHECK); a refused UPDATE is 0 rows (measured by ROW_COUNT).
--   S0 (once) both tables carry start_time time, end_time time, location_label text, all nullable; 8 policies
-- Per department, for each leader kind present — L-DA (a Department Admin) and L-OF (an Officer who is not a DA / PA),
-- unique emails:
--   INSERT a fundraiser event and a community event WITH start_time / end_time / location_label → 1 row each, persisted
--   UPDATE the two fixture (date-only) events to set a time range + location → 1 row each, persisted
--   M1 a plain member: the same INSERTs refused (row-level security), the same UPDATEs 0 rows, fixtures unchanged
-- =====================================================================
DO $retest$
DECLARE
  rec record; ldr record; v_n int; v_ok boolean;
  v_mem text; v_f uuid; v_r uuid; v_fi uuid; v_ri uuid; u1 int; u2 int; e1 text; e2 text;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  -- S0
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('funding_events', 'recruitment_events') AND is_nullable = 'YES'
     AND ((column_name IN ('start_time', 'end_time') AND data_type = 'time without time zone') OR (column_name = 'location_label' AND data_type = 'text'));
  SELECT count(*) = 8 INTO v_ok FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('funding_events', 'recruitment_events');
  IF v_n = 6 AND v_ok THEN v_pass := v_pass + 1; rpt := rpt || format('PASS  S0 both tables carry start_time / end_time (time) + location_label (text), nullable; 8 policies unchanged in count%s', chr(10));
  ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 new columns %s/6 · 8 policies %s%s', v_n, v_ok, chr(10)); END IF;

  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    BEGIN
      -- fixtures (owner): the "existing" date-only events
      INSERT INTO public.funding_events (department_id, title, date) VALUES (rec.dept_id, 'RETEST existing fundraiser', current_date + 30) RETURNING id INTO v_f;
      INSERT INTO public.recruitment_events (department_id, title, date) VALUES (rec.dept_id, 'RETEST existing community', current_date + 30) RETURNING id INTO v_r;

      v_n := 0;
      FOR ldr IN
        SELECT 'L-DA' AS k, (SELECT lower(m.email) FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
                  AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
                  ORDER BY m.id LIMIT 1) AS email
        UNION ALL
        SELECT 'L-OF', (SELECT lower(m.email) FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
                  AND NOT m.access && array['Department Admin', 'Project Admin']::text[]
                  AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
                  ORDER BY m.id LIMIT 1)
      LOOP
        IF ldr.email IS NULL THEN
          v_skip := v_skip + 1; rpt := rpt || format('   SKIP  %s none here (unique email)%s', ldr.k, chr(10)); CONTINUE;
        END IF;
        v_n := v_n + 1; e1 := 'ok'; e2 := 'ok'; v_fi := NULL; v_ri := NULL;
        PERFORM set_config('request.jwt.claims', json_build_object('email', ldr.email, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN
          INSERT INTO public.funding_events (department_id, title, date, start_time, end_time, location_label)
            VALUES (public.my_department_id(), 'RETEST ' || ldr.k || ' fundraiser', current_date + 31, '18:00', '21:00', 'Station 20 bay') RETURNING id INTO v_fi;
        EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
        BEGIN
          INSERT INTO public.recruitment_events (department_id, title, date, start_time, end_time, location_label)
            VALUES (public.my_department_id(), 'RETEST ' || ldr.k || ' community', current_date + 32, '09:30', '12:00', 'Farmers market') RETURNING id INTO v_ri;
        EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
        UPDATE public.funding_events SET start_time = '17:00', end_time = '20:00', location_label = 'Fire hall' WHERE id = v_f; GET DIAGNOSTICS u1 = ROW_COUNT;
        UPDATE public.recruitment_events SET start_time = '10:00', end_time = '14:00', location_label = 'High school gym' WHERE id = v_r; GET DIAGNOSTICS u2 = ROW_COUNT;
        PERFORM set_config('role', 'postgres', true);
        IF e1 = 'ok' AND e2 = 'ok' AND u1 = 1 AND u2 = 1
           AND EXISTS (SELECT 1 FROM public.funding_events WHERE id = v_fi AND department_id = rec.dept_id AND start_time = '18:00' AND end_time = '21:00' AND location_label = 'Station 20 bay')
           AND EXISTS (SELECT 1 FROM public.recruitment_events WHERE id = v_ri AND department_id = rec.dept_id AND start_time = '09:30' AND end_time = '12:00' AND location_label = 'Farmers market')
           AND EXISTS (SELECT 1 FROM public.funding_events WHERE id = v_f AND start_time = '17:00' AND end_time = '20:00' AND location_label = 'Fire hall')
           AND EXISTS (SELECT 1 FROM public.recruitment_events WHERE id = v_r AND start_time = '10:00' AND end_time = '14:00' AND location_label = 'High school gym') THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  %s inserts a fundraiser + a community event with time range + location, and updates the two existing ones — all persisted%s', ldr.k, chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  %s insert funding: %s · insert community: %s · update funding %s · update community %s%s', ldr.k, e1, e2, u1, u2, chr(10)); END IF;
        -- put the fixtures back to date-only for the next leader / the member check
        UPDATE public.funding_events SET start_time = NULL, end_time = NULL, location_label = NULL WHERE id = v_f;
        UPDATE public.recruitment_events SET start_time = NULL, end_time = NULL, location_label = NULL WHERE id = v_r;
      END LOOP;

      -- M1 a plain member
      v_mem := NULL;
      SELECT lower(m.email) INTO v_mem FROM public.members m WHERE m.department_id = rec.dept_id
         AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
         AND m.status IN ('Active', 'Probationary') AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
      IF v_mem IS NULL THEN
        v_skip := v_skip + 1; rpt := rpt || format('   SKIP  M1 no plain member here (unique email)%s', chr(10));
      ELSE
        e1 := 'ok'; e2 := 'ok';
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_mem, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN
          INSERT INTO public.funding_events (department_id, title, date, start_time, end_time, location_label)
            VALUES (public.my_department_id(), 'RETEST member fundraiser', current_date + 31, '18:00', '21:00', 'X');
        EXCEPTION WHEN OTHERS THEN e1 := SQLERRM; END;
        BEGIN
          INSERT INTO public.recruitment_events (department_id, title, date, start_time, end_time, location_label)
            VALUES (public.my_department_id(), 'RETEST member community', current_date + 32, '09:30', '12:00', 'X');
        EXCEPTION WHEN OTHERS THEN e2 := SQLERRM; END;
        UPDATE public.funding_events SET start_time = '17:00', location_label = 'X' WHERE id = v_f; GET DIAGNOSTICS u1 = ROW_COUNT;
        UPDATE public.recruitment_events SET start_time = '10:00', location_label = 'X' WHERE id = v_r; GET DIAGNOSTICS u2 = ROW_COUNT;
        PERFORM set_config('role', 'postgres', true);
        IF e1 ILIKE '%row-level security%' AND e2 ILIKE '%row-level security%' AND u1 = 0 AND u2 = 0
           AND EXISTS (SELECT 1 FROM public.funding_events WHERE id = v_f AND start_time IS NULL AND location_label IS NULL)
           AND EXISTS (SELECT 1 FROM public.recruitment_events WHERE id = v_r AND start_time IS NULL AND location_label IS NULL)
           AND NOT EXISTS (SELECT 1 FROM public.funding_events WHERE title = 'RETEST member fundraiser')
           AND NOT EXISTS (SELECT 1 FROM public.recruitment_events WHERE title = 'RETEST member community') THEN
          v_pass := v_pass + 1; rpt := rpt || format('   PASS  M1 plain member: both INSERTs refused by row-level security; both UPDATEs 0 rows; fixtures unchanged%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  M1 insert funding: %s · insert community: %s · update funding %s · update community %s%s', e1, e2, u1, u2, chr(10)); END IF;
      END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
